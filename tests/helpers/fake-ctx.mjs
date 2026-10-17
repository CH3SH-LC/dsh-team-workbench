/**
 * Minimal Cordis-shaped fake context.
 *
 * Two jobs:
 *  1. let the *real* `createAdapter(ctx)` find live-looking native services
 *     (delegating to the same fake-adapter state, with native throwing
 *     semantics instead of result envelopes);
 *  2. let `apply(ctx, config)` / dispose / re-apply be driven so W07 can prove
 *     that a second HMR generation does not leave duplicate tools, prompt
 *     sections, web routes, skill providers, projections, listeners or
 *     schedulers behind.
 *
 * Registries here are strict in the same way the live Host is strict:
 * duplicate `tools.register` / `systemPrompt.section` in one layer throw.
 */

/** Native calls throw; adapter calls return envelopes. */
export function unwrap(result, fallbackCode = 'NATIVE_CALL_FAILED') {
  if (result && typeof result === 'object' && 'ok' in result) {
    if (result.ok) return result.value === undefined ? result : result.value;
    const error = new Error(result.message ?? result.code ?? fallbackCode);
    error.code = result.code ?? fallbackCode;
    error.detail = result;
    throw error;
  }
  return result;
}

export function createFakeContext(options = {}) {
  const adapter = options.adapter;
  if (!adapter) throw new Error('createFakeContext requires { adapter }');
  const clock = options.clock ?? adapter.clock;

  // 真实 Host 默认具备的原生工具（权限/执行/物化链路据此判断可见性）。
  // 仅在 fake registry 里预置，不改变插件注册计数（registrationCalls.tools 独立）。
  const DEFAULT_NATIVE_TOOLS = ['pwsh', 'bash', 'run_code', 'write', 'edit', 'read', 'glob', 'grep', 'apply_patch', 'spawn_agent'];
  const registries = {
    // 不预置进注册表：Only lookup fallback (see tools.get), so W07 registration counts stay exact.
    tools: new Map(),
    sections: new Map(),
    contexts: new Map(),
    promptVariables: new Map(),
    promptTools: [],
    toolRestrictions: [],
    toolGuards: [],
    webRoutes: new Map(),
    webUpgrades: new Map(),
    webFallbacks: [],
    skillProviders: new Map(),
    skills: new Map(),
    projections: new Map(),
    listeners: new Map(),
    services: new Map(),
    effects: [],
    commands: new Map(),
  };

  const registrationCalls = {
    tools: 0,
    sections: 0,
    contexts: 0,
    webRoutes: 0,
    webUpgrades: 0,
    skillProviders: 0,
    skills: 0,
    projections: 0,
    listeners: 0,
    effects: 0,
    commands: 0,
    services: 0,
    injected: 0,
  };

  const disposers = [];
  let disposed = false;
  const log = [];
  /** @type {{ names:string[], callback:Function }[]} */
  const pendingInjectors = [];

  /** Run every pending injector whose dependencies are now mounted. */
  function flushPendingInjectors() {
    let fired = 0;
    for (const pending of [...pendingInjectors]) {
      if (!pending.names.every((name) => services.has(name))) continue;
      const index = pendingInjectors.indexOf(pending);
      if (index >= 0) pendingInjectors.splice(index, 1);
      registrationCalls.injected += 1;
      try {
        const value = pending.callback(ctx);
        if (typeof value === 'function') track(value);
        fired += 1;
      } catch (error) {
        log.push({ level: 'error', inject: pending.names.join('+'), message: error?.message });
      }
    }
    return fired;
  }

  function track(dispose) {
    const wrapper = () => {
      try {
        return dispose?.();
      } catch {
        return undefined;
      }
    };
    disposers.push(wrapper);
    return wrapper;
  }

  /**
   * Cordis-registry style: the callback receives a dispose handle, and may also
   * return a disposer (sync or promise) that must run at teardown.
   */
  function effect(callback) {
    registrationCalls.effects += 1;
    const handle = () => {
      const index = registries.effects.indexOf(handle);
      if (index >= 0) registries.effects.splice(index, 1);
    };
    registries.effects.push(handle);
    let returned;
    try {
      returned = callback(handle);
    } catch (error) {
      handle();
      throw error;
    }
    if (returned && typeof returned.then === 'function') {
      const promise = Promise.resolve(returned).then((value) => {
        if (typeof value === 'function') track(value);
        return value;
      });
      return promise;
    }
    if (typeof returned === 'function') track(returned);
    return handle;
  }

  function on(event, listener) {
    registrationCalls.listeners += 1;
    if (!registries.listeners.has(event)) registries.listeners.set(event, new Set());
    registries.listeners.get(event).add(listener);
    return track(() => registries.listeners.get(event)?.delete(listener));
  }

  function emit(event, payload) {
    const set = registries.listeners.get(event);
    if (!set) return 0;
    let count = 0;
    for (const listener of [...set]) {
      try {
        listener(payload);
        count += 1;
      } catch (error) {
        log.push({ level: 'error', event, message: error?.message });
      }
    }
    return count;
  }

  const logger = {
    info: (...args) => log.push({ level: 'info', args: args.map(String) }),
    warn: (...args) => log.push({ level: 'warn', args: args.map(String) }),
    error: (...args) => log.push({ level: 'error', args: args.map(String) }),
    debug: (...args) => log.push({ level: 'debug', args: args.map(String) }),
  };

  const tools = {
    register(definition) {
      registrationCalls.tools += 1;
      const name = String(definition?.name ?? '');
      if (!name) throw new Error('tool registration requires a name');
      if (registries.tools.has(name)) {
        const error = new Error(`tool ${name} is already registered in this layer`);
        error.code = 'TOOL_DUPLICATE';
        throw error;
      }
      registries.tools.set(name, definition);
      return track(() => registries.tools.delete(name));
    },
    // 默认原生工具只在**查找**时兜底可见（不进入注册表，避免影响 W07 的注册计数断言）。
    get: (name) => registries.tools.get(String(name)) ?? (DEFAULT_NATIVE_TOOLS.includes(String(name)) ? { name: String(name) } : undefined),
    schemas: () => [...registries.tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters })),
    async execute(exec) {
      // 可测性补齐（不放宽 fail-closed）：模拟真实原生执行的"宿主 exit 文件"语义。
      // execution.runNative 用 pwsh 包装命令把退出码写进 `twb-exec-<runId>.exit`，随后由
      // Host 回读；fake adapter 没有真实进程，这里按命令里的 Set-Content 路径写 0。
      const nativeName = String(exec?.name ?? '');
      if (['pwsh', 'bash', 'run_code'].includes(nativeName) && !registries.tools.get(nativeName)?.execute) {
        const command = String(exec?.arguments?.command ?? exec?.arguments?.code ?? '');
        const match = command.match(/-LiteralPath\s+['"]([^'"]+\.exit)['"]/);
        if (match) {
          const fsp = await import('node:fs/promises');
          await fsp.writeFile(match[1], '0', 'utf8');
        }
        return { isError: false, value: { exitCode: 0, stdout: '', stderr: '' }, content: [] };
      }
      const definition = registries.tools.get(String(exec?.name));
      if (!definition) return { isError: true, error: { message: 'unknown tool', info: { name: 'ToolError', code: 'UNKNOWN_TOOL' } }, content: [] };
      try {
        const value = await definition.execute(exec?.arguments, exec);
        return { isError: false, value, content: [] };
      } catch (error) {
        return { isError: true, error: { message: error?.message ?? String(error), info: { name: 'ToolError', code: error?.code ?? 'TOOL_ERROR' } }, content: [] };
      }
    },
    restrict(filter) {
      registries.toolRestrictions.push(filter);
      return track(() => {
        const index = registries.toolRestrictions.indexOf(filter);
        if (index >= 0) registries.toolRestrictions.splice(index, 1);
      });
    },
    guard(guard) {
      registries.toolGuards.push(guard);
      return track(() => {
        const index = registries.toolGuards.indexOf(guard);
        if (index >= 0) registries.toolGuards.splice(index, 1);
      });
    },
    executionMode: () => ({ kind: 'exclusive' }),
    presentAs: () => track(() => {}),
  };

  const systemPrompt = {
    section(section) {
      registrationCalls.sections += 1;
      const name = String(section?.name ?? '');
      if (!name) throw new Error('prompt section requires a name');
      if (registries.sections.has(name)) {
        const error = new Error(`prompt section ${name} already registered`);
        error.code = 'PROMPT_SECTION_DUPLICATE';
        throw error;
      }
      registries.sections.set(name, section);
      return track(() => registries.sections.delete(name));
    },
    context(context) {
      registrationCalls.contexts += 1;
      const name = String(context?.name ?? '');
      if (registries.contexts.has(name)) {
        const error = new Error(`prompt context ${name} already registered`);
        error.code = 'PROMPT_CONTEXT_DUPLICATE';
        throw error;
      }
      registries.contexts.set(name, context);
      return track(() => registries.contexts.delete(name));
    },
    variable(name, provider) {
      registries.promptVariables.set(String(name), provider);
      return track(() => registries.promptVariables.delete(String(name)));
    },
    tools(provider) {
      registries.promptTools.push(provider);
      return track(() => {
        const index = registries.promptTools.indexOf(provider);
        if (index >= 0) registries.promptTools.splice(index, 1);
      });
    },
    suppressRuntimeContext: () => track(() => {}),
    getSectionOrder: () => 600,
    getContextOrder: () => 120,
    async assemble() {
      return {
        sections: [...registries.sections.values()].map((section) => ({ name: section.name, text: typeof section.text === 'function' ? section.text({}) : section.text })),
        contexts: [...registries.contexts.values()].map((context) => ({ name: context.name, text: typeof context.text === 'function' ? context.text({}) : context.text })),
        tools: tools.schemas(),
        variables: {},
      };
    },
  };

  const webServer = {
    register(route) {
      registrationCalls.webRoutes += 1;
      const path = String(route?.path ?? route?.route ?? `route-${registrationCalls.webRoutes}`);
      if (registries.webRoutes.has(path)) {
        const error = new Error(`web route ${path} already registered`);
        error.code = 'WEB_ROUTE_DUPLICATE';
        throw error;
      }
      registries.webRoutes.set(path, route);
      return track(() => registries.webRoutes.delete(path));
    },
    registerUpgrade(route) {
      registrationCalls.webUpgrades += 1;
      const path = String(route?.path ?? `upgrade-${registrationCalls.webUpgrades}`);
      registries.webUpgrades.set(path, route);
      return track(() => registries.webUpgrades.delete(path));
    },
    registerFallback(handler) {
      registries.webFallbacks.push(handler);
      return track(() => {
        const index = registries.webFallbacks.indexOf(handler);
        if (index >= 0) registries.webFallbacks.splice(index, 1);
      });
    },
    tapIndex: () => track(() => {}),
  };

  const skills = {
    registerProvider(create) {
      registrationCalls.skillProviders += 1;
      const name = String(create?.name ?? `provider-${registrationCalls.skillProviders}`);
      registries.skillProviders.set(name, create);
      return track(() => registries.skillProviders.delete(name));
    },
    register(skill) {
      registrationCalls.skills += 1;
      const name = String(skill?.name ?? '');
      if (!name) throw new Error('skill registration requires a name');
      if (registries.skills.has(name)) {
        const error = new Error(`skill ${name} already registered`);
        error.code = 'SKILL_DUPLICATE';
        throw error;
      }
      registries.skills.set(name, skill);
      return track(() => registries.skills.delete(name));
    },
    async list() {
      return [...registries.skills.values()].map(({ name, description, whenToUse, invocation, source }) => ({
        name,
        description: description ?? '',
        whenToUse,
        invocation: invocation ?? { modelInvocable: true, userInvocable: true },
        source: source ?? 'custom',
        provider: 'team-workbench',
      }));
    },
    async get(name) {
      return registries.skills.get(String(name));
    },
    async snapshot() {
      return { skills: await skills.list(), complete: true };
    },
  };

  const sessionProjections = {
    register(definition) {
      registrationCalls.projections += 1;
      const key = String(definition?.key ?? '');
      if (!key) throw new Error('projection requires a key');
      const entry = registries.projections.get(key) ?? { definition, count: 0 };
      entry.count += 1;
      entry.definition = definition;
      registries.projections.set(key, entry);
      return track(() => {
        const current = registries.projections.get(key);
        if (!current) return;
        current.count -= 1;
        if (current.count <= 0) registries.projections.delete(key);
      });
    },
    onChanged: () => track(() => {}),
    stateOf: () => undefined,
    snapshot: () => ({ asOfSeq: -1, values: {} }),
    cachedSnapshot: () => undefined,
  };

  const commands = {
    register(definition) {
      registrationCalls.commands += 1;
      const name = String(definition?.name ?? '');
      if (registries.commands.has(name)) {
        const error = new Error(`command ${name} already registered`);
        error.code = 'COMMAND_DUPLICATE';
        throw error;
      }
      registries.commands.set(name, definition);
      return track(() => registries.commands.delete(name));
    },
    list: () => [...registries.commands.values()],
    find: (agent, name) => registries.commands.get(String(name)),
    execute: async () => undefined,
  };

  // ---- native services delegate to the shared fake-adapter state ------------
  const agents = {
    get: (id) => adapter.agentFor(id),
    list: () => adapter.roster,
    roots: () => adapter.roster,
    isOwnedBy: () => false,
    register: () => () => {},
    currentInitiator: () => undefined,
    requireInitiator: () => undefined,
  };

  const agentTeams = {
    tryMembership: (agent) => adapter.membership(agent),
    membership(agent) {
      const membership = adapter.membership(agent);
      if (!membership) {
        const error = new Error('caller is not a team member');
        error.code = 'TEAM_NOT_MEMBER';
        throw error;
      }
      return membership;
    },
    listMembers: (agent) => unwrap(adapter.listMembers(agent)),
    listTasks: (agent) => unwrap(adapter.listTasks(agent)),
    getTask: (agent, id) => unwrap(adapter.getTask(agent, id)),
    createTask: async (agent, request) => unwrap(adapter.createTask(agent, request)),
    updateTask: async (agent, request) => unwrap(adapter.updateTask(agent, request)),
    sendMessage: async (agent, request) => unwrap(adapter.sendTeamMessage(agent, request)),
    waitForChange: async (agent, timeoutMs, signal) => unwrap(await adapter.waitForChange(agent, timeoutMs, signal)),
    spawnTeammate: async (agent, request) => unwrap(adapter.spawnTeammate(agent, request)),
    interrupt: (caller, name) => unwrap(adapter.interrupt(caller, name)),
  };

  const subagents = {
    startContinuable: async (spec) => unwrap(adapter.startContinuable(spec)),
    listChildren: async (parentSessionId) => unwrap(adapter.listChildren(parentSessionId)),
    listDescendants: async (rootSessionId) => unwrap(adapter.listDescendants(rootSessionId)),
    interrupt: (targetSessionId, authority) => {
      const parentSessionId = authority?.parentSessionId ?? authority?.agent?.id ?? '';
      return unwrap(adapter.interruptChild(targetSessionId, parentSessionId, 'continuable'));
    },
    interruptByParent: (childSessionId, parentSessionId, mode) => unwrap(adapter.interruptChild(childSessionId, parentSessionId, mode)),
    registerProvider: () => () => {},
    getProvider: () => undefined,
    list: () => ['spawn', 'fork', 'subagent'],
    start: async () => {
      throw new Error('one-shot start is not simulated');
    },
    resolveMaxDepth: (configured) => (typeof configured === 'number' ? configured : 1),
  };

  const storageDomain = {
    open: async (spec) => unwrap(await adapter.openDomain(spec)),
    get: (name) => adapter.domainFacility.get(name),
    closeAll: async () => adapter.domainFacility.closeAll(),
  };

  const services = new Map([
    ['agentTeams', agentTeams],
    ['subagents', subagents],
    ['agents', agents],
    ['storageDomain', storageDomain],
    ['tools', tools],
    ['systemPrompt', systemPrompt],
    ['skills', skills],
    ['sessionProjections', sessionProjections],
    ['webServer', webServer],
    ['commands', commands],
    ['timer', { timeout: () => () => {}, interval: () => () => {}, throttle: (fn) => fn, debounce: (fn) => fn }],
  ]);

  const ctx = {
    clock,
    logger,
    log,
    registries,
    registrationCalls,
    adapter,
    get(key) {
      return services.get(String(key));
    },
    set(key, value) {
      registrationCalls.services += 1;
      services.set(String(key), value);
      // A late-mounted service (storageDomain) wakes every waiting injector.
      flushPendingInjectors();
      return track(() => services.delete(String(key)));
    },
    /** Test hook: unmount a native service to simulate late mounting. */
    removeService(key) {
      const existed = services.delete(String(key));
      return existed;
    },
    provide(key, value) {
      return ctx.set(key, value);
    },
    effect,
    on,
    emit,
    /**
     * Cordis dependency-injection shape, faithful enough for the startup gate:
     * `ctx.inject([...names], cb)` runs the callback **immediately only when every
     * dependency is already mounted**; otherwise it stays pending and fires when
     * `ctx.set`/`ctx.provide` mounts the missing service. That is exactly the
     * behaviour `createServiceGate` relies on (storageDomain mounts later).
     */
    inject(deps, callback) {
      if (typeof deps === 'function' && callback === undefined) {
        const value = deps(ctx);
        return typeof value === 'function' ? track(value) : track(() => {});
      }
      const names = Array.isArray(deps) ? deps.map(String) : [];
      const ready = () => names.every((name) => services.has(name));
      if (typeof callback !== 'function') return track(() => {});
      if (ready()) {
        registrationCalls.injected += 1;
        const value = callback(ctx);
        return typeof value === 'function' ? track(value) : track(() => {});
      }
      const pending = { names, callback };
      pendingInjectors.push(pending);
      return track(() => {
        const index = pendingInjectors.indexOf(pending);
        if (index >= 0) pendingInjectors.splice(index, 1);
      });
    },
    once(event, listener) {
      const off = on(event, (payload) => {
        off();
        listener(payload);
      });
      return off;
    },
    parallel: (name, ...args) => emit(name, args),
    bail: (name, ...args) => emit(name, args),
    tools,
    systemPrompt,
    webServer,
    skills,
    sessionProjections,
    commands,
    agentTeams,
    subagents,
    agents,
    storageDomain,
    scope: { key: {} },
    /** live registration counts after every disposer has run */
    liveCounts() {
      return {
        tools: registries.tools.size,
        sections: registries.sections.size,
        contexts: registries.contexts.size,
        webRoutes: registries.webRoutes.size,
        webUpgrades: registries.webUpgrades.size,
        skillProviders: registries.skillProviders.size,
        skills: registries.skills.size,
        projections: registries.projections.size,
        listeners: [...registries.listeners.values()].reduce((sum, set) => sum + set.size, 0),
        effects: registries.effects.length,
        commands: registries.commands.size,
        services: services.size,
        promptTools: registries.promptTools.length,
        toolGuards: registries.toolGuards.length,
        toolRestrictions: registries.toolRestrictions.length,
      };
    },
    async dispose() {
      disposed = true;
      // Cordis teardown order: newest registration first. Registries are NOT
      // force-cleared: a registration whose disposer never runs must stay
      // visible so a leak (e.g. a second HMR generation) fails the suite.
      for (const dispose of [...disposers].reverse()) {
        try {
          await dispose();
        } catch {
          /* teardown must not throw */
        }
      }
      disposers.length = 0;
      registries.effects.length = 0;
      return undefined;
    },
    get disposed() {
      return disposed;
    },
    get names() {
      return { tools: [...registries.tools.keys()], sections: [...registries.sections.keys()] };
    },
  };

  // Bridge durable-domain notifications into the Cordis event bus so the real
  // storage/scheduler listeners observe `domain/changed` exactly as in the Host.
  if (adapter.domainFacility?.onChange) {
    adapter.domainFacility.onChange((change) => ctx.emit('domain/changed', change));
  }

  return ctx;
}

export default createFakeContext;
