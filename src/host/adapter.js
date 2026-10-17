/**
 * `adapter.js` — 唯一接触 DSH 原生 API 的窄适配层。
 *
 * 规则：
 *  - 只用 `ctx.get(name)` 取可选服务并做 undefined 检查，因此本插件在没有
 *    agentTeams / subagents / storageDomain 的组合里仍能加载并给出准确诊断。
 *  - 每个原生调用都归一化成 `{ ok: true, value }` / `{ ok: false, code, message }`，
 *    不把原生异常直接抛进业务层。
 *  - 传进原生服务的 Agent 必须是**真实存活**的 Agent；`agentFor()` 只从
 *    `ctx.agents.get(id)` 取，绝不从 sessionId 伪造身份。
 *  - 每次原生调用都写入环形诊断缓冲，供 `team_snapshot` 与验收脚本读取。
 *
 * 2026-10-17 整改新增（契约 v1）：`readFileInfo` / `readFileRange` 两个**只读**文件接口。
 * 它们是"证据必须映射到真实文件读取"与"费用归账增量读取"的唯一底层通道，
 * 仍归一化成 ok/code 形状，不把 fs 异常抛进业务层。
 */
import { createHash } from 'node:crypto';
import { promises as nodeFs } from 'node:fs';
import { createDiagnostics, safeClone } from './util.js';

/** 原生服务键 → ctx.get 名称。 */
export const NATIVE_SERVICES = Object.freeze([
  'agents',
  'agentLoop',
  'agentTeams',
  'subagents',
  'storageDomain',
  'sessionProjections',
  'tools',
  'systemPrompt',
  'skills',
  'commands',
  'webServer',
  'sessionProjection',
]);

function ok(value) {
  return { ok: true, value };
}

function fail(code, message, detail) {
  return { ok: false, code, message, detail: detail === undefined ? null : safeClone(detail) };
}

function errorCode(error, fallback) {
  if (error && typeof error === 'object') {
    if (typeof error.code === 'string' && error.code) return error.code;
    if (typeof error.name === 'string' && error.name && error.name !== 'Error') return error.name;
  }
  return fallback;
}

/**
 * @param {object} ctx Cordis Context (or a test double exposing `get`).
 * @param {{ diagnosticsLimit?: number }} [options]
 */
export function createAdapter(ctx, options = {}) {
  const diagnostics = createDiagnostics(options.diagnosticsLimit ?? 240);
  const counts = { calls: 0, failures: 0, byService: Object.create(null) };

  const read = (name) => {
    if (!ctx || typeof ctx.get !== 'function') return undefined;
    try {
      return ctx.get(name);
    } catch (error) {
      diagnostics.push('ctx.get:failed', `ctx.get('${name}') threw`, { code: errorCode(error, 'CTX_GET_FAILED') });
      return undefined;
    }
  };

  const availability = () => {
    const flags = Object.create(null);
    for (const name of NATIVE_SERVICES) flags[name] = read(name) !== undefined;
    return flags;
  };

  /**
   * 归一化包装：`call('agentTeams','spawnTeammate', ...)`。
   * 服务缺失时返回 `{ ok:false, code:'SERVICE_UNAVAILABLE' }`。
   */
  async function call(serviceName, method, args = [], fallbackCode = 'NATIVE_CALL_FAILED') {
    const service = read(serviceName);
    if (service === undefined) {
      diagnostics.push(`${serviceName}:unavailable`, `${serviceName}.${method} skipped: service unavailable`);
      return fail('SERVICE_UNAVAILABLE', `${serviceName} 服务不可用`, { service: serviceName, method });
    }
    if (typeof service[method] !== 'function') {
      diagnostics.push(`${serviceName}:missing-method`, `${serviceName}.${method} is not a function`);
      return fail('NATIVE_METHOD_MISSING', `${serviceName}.${method} 不是可调用方法`, { service: serviceName, method });
    }
    counts.calls += 1;
    counts.byService[serviceName] = (counts.byService[serviceName] ?? 0) + 1;
    try {
      const value = await service[method](...args);
      diagnostics.push(`${serviceName}.${method}`, 'ok');
      return ok(value);
    } catch (error) {
      counts.failures += 1;
      const code = errorCode(error, fallbackCode);
      const message = error && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error);
      diagnostics.push(`${serviceName}.${method}:error`, `${code}: ${message}`);
      return fail(code, message, { service: serviceName, method });
    }
  }

  function callSync(serviceName, method, args = [], fallbackCode = 'NATIVE_CALL_FAILED') {
    const service = read(serviceName);
    if (service === undefined) return fail('SERVICE_UNAVAILABLE', `${serviceName} 服务不可用`, { service: serviceName, method });
    if (typeof service[method] !== 'function') return fail('NATIVE_METHOD_MISSING', `${serviceName}.${method} 不是可调用方法`, { service: serviceName, method });
    counts.calls += 1;
    counts.byService[serviceName] = (counts.byService[serviceName] ?? 0) + 1;
    try {
      return ok(service[method](...args));
    } catch (error) {
      counts.failures += 1;
      const code = errorCode(error, fallbackCode);
      const message = error && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error);
      diagnostics.push(`${serviceName}.${method}:error`, `${code}: ${message}`);
      return fail(code, message, { service: serviceName, method });
    }
  }

  const api = {
    availability,
    diagnostics: () => diagnostics.list(),
    counts: () => ({ ...counts, byService: { ...counts.byService } }),

    /** 真实存活 Agent；缺失返回 undefined。**不要**从 sessionId 构造身份。 */
    agentFor(sessionId) {
      const agents = read('agents');
      if (!agents || typeof agents.get !== 'function' || typeof sessionId !== 'string') return undefined;
      try {
        return agents.get(sessionId);
      } catch (error) {
        diagnostics.push('agents.get:error', String(error?.message ?? error));
        return undefined;
      }
    },

    listAgents() {
      const agents = read('agents');
      if (!agents || typeof agents.list !== 'function') return [];
      try {
        return agents.list() ?? [];
      } catch {
        return [];
      }
    },

    rootAgents() {
      const agents = read('agents');
      if (!agents || typeof agents.roots !== 'function') return [];
      try {
        return agents.roots() ?? [];
      } catch {
        return [];
      }
    },

    /**
     * 确保某个 session 有一个**真实的 live Agent**，必要时冷唤醒它。
     *
     * 为什么必须有这一步：原生 `subagents.startContinuable` 的 `request.parent` 必须是
     * 真实 live Agent（"调用原生服务传精确 live Agent，禁止从任意 sessionId 构造身份"）。
     * 而 Team member 在两次回合之间可能没有注册中的 Agent——真实桌面验收里
     * `PARENT_AGENT_UNAVAILABLE` 就是这么来的。原生提供 `agents.resume` /
     * `agentLoop.resume`，因此这里按「先恢复 parent，再恢复 child」的顺序补齐，
     * 而不是伪造一个 `{id}` 对象。
     *
     * @returns `{ ok: true, value: { agent, resumed, handle? } }` 或失败原因
     */
    async ensureLiveAgent(sessionId) {
      if (typeof sessionId !== 'string' || !sessionId) return fail('AGENT_REQUIRED', '缺少 sessionId，无法确认 live Agent');
      const existing = api.agentFor(sessionId);
      if (existing !== undefined) return ok({ agent: existing, resumed: false });

      const attempt = await call('agents', 'resume', [{ resumeSessionId: sessionId }], 'AGENT_RESUME_FAILED');
      if (attempt.ok && attempt.value?.agent) return ok({ agent: attempt.value.agent, resumed: true, handle: attempt.value });

      const loopAttempt = await call('agentLoop', 'resume', [ctx, { resumeSessionId: sessionId }], 'AGENT_RESUME_FAILED');
      if (loopAttempt.ok && loopAttempt.value?.agent) return ok({ agent: loopAttempt.value.agent, resumed: true, handle: loopAttempt.value });

      diagnostics.push('adapter:resume-failed', `无法为 ${sessionId} 取得 live Agent`, {
        agentsResume: attempt.ok ? null : `${attempt.code}: ${attempt.message}`,
        agentLoopResume: loopAttempt.ok ? null : `${loopAttempt.code}: ${loopAttempt.message}`,
      });
      return fail('PARENT_AGENT_UNAVAILABLE', `无法为 ${sessionId} 取得 live Agent（resume 也失败）`, {
        agentsResume: attempt.ok ? null : attempt.code,
        agentLoopResume: loopAttempt.ok ? null : loopAttempt.code,
      });
    },

    /** 释放 `ensureLiveAgent` 冷唤醒得到的 handle（不 dispose 会让恢复出来的 Agent 一直挂着）。 */
    async releaseAgentHandle(handle) {
      if (!handle || typeof handle.dispose !== 'function') return ok(undefined);
      try {
        await handle.dispose();
        return ok(undefined);
      } catch (error) {
        return fail(errorCode(error, 'AGENT_DISPOSE_FAILED'), String(error?.message ?? error));
      }
    },

    /** Team 身份。非 Team 成员返回 `{ ok:true, value: undefined }`。 */
    membership(agent) {
      const teams = read('agentTeams');
      if (!teams) return fail('SERVICE_UNAVAILABLE', 'agentTeams 服务不可用');
      if (!agent) return fail('AGENT_REQUIRED', '缺少真实 Agent 身份');
      if (typeof teams.tryMembership === 'function') {
        const result = callSync('agentTeams', 'tryMembership', [agent]);
        return result.ok ? ok(result.value) : result;
      }
      return callSync('agentTeams', 'membership', [agent]);
    },

    listMembers(agent) {
      return call('agentTeams', 'listMembers', [agent]);
    },

    listTasks(agent) {
      return call('agentTeams', 'listTasks', [agent]);
    },

    getTask(agent, taskId) {
      return call('agentTeams', 'getTask', [agent, taskId]);
    },

    createTask(agent, request) {
      return call('agentTeams', 'createTask', [agent, request]);
    },

    updateTask(agent, request) {
      return call('agentTeams', 'updateTask', [agent, request]);
    },

    sendTeamMessage(agent, request) {
      return call('agentTeams', 'sendMessage', [agent, request]);
    },

    /**
     * 成员唤醒：把一个真实 Team 消息投递到目标成员的 inbox。
     *
     * 原生契约（`agentTeams.sendMessage`）："Queue one durable peer message, then attempt
     * immediate delivery"。也就是**消息持久入队 + 立即投递**，由目标成员自己的模型回合消费，
     * 这就是"唤醒真实模型回合"的原生路径（不是只写状态、也不是空回合轮询）。
     */
    wakeMember(sender, target, text, signal) {
      return api.sendTeamMessage(sender, {
        target: String(target),
        content: [{ type: 'text', text: String(text) }],
        signal: signal ?? new AbortController().signal,
      });
    },

    /** 原生 Team roster（用于保守的历史数据映射与"成员是真实的"核对）。 */
    listTeamMembers(agent) {
      return api.listMembers(agent);
    },

    waitForChange(agent, timeoutMs, signal) {
      return call('agentTeams', 'waitForChange', [agent, timeoutMs, signal]);
    },

    spawnTeammate(agent, request) {
      return call('agentTeams', 'spawnTeammate', [agent, request]);
    },

    interruptMember(caller, targetName) {
      return call('agentTeams', 'interrupt', [caller, targetName]);
    },

    // ---- continuable subagents -------------------------------------------------
    startContinuable(spec) {
      return call('subagents', 'startContinuable', [spec], 'SUBAGENT_START_FAILED');
    },

    listChildren(parentSessionId, signal) {
      return call('subagents', 'listChildren', [parentSessionId, signal]);
    },

    listDescendants(rootSessionId, signal) {
      return call('subagents', 'listDescendants', [rootSessionId, signal]);
    },

    sendChildMessage(sender, targetId, content, messageOptions) {
      return call('subagents', 'sendMessage', [sender, targetId, content, messageOptions]);
    },

    interruptChildByParent(childSessionId, parentSessionId) {
      return call('subagents', 'interruptByParent', [childSessionId, parentSessionId, 'continuable']);
    },

    drainChildren(parent, childIds) {
      return call('subagents', 'drainContinuableChildren', [parent, childIds]);
    },

    resolveMaxDepth(configured) {
      return call('subagents', 'resolveMaxDepth', [configured]);
    },

    /** 可用 provider 名列表；用于给 member 选 continuable 提供者。 */
    listSubagentProviders() {
      return call('subagents', 'list', []);
    },

    // ---- storage ---------------------------------------------------------------
    openDomain(spec) {
      return call('storageDomain', 'open', [spec], 'DOMAIN_OPEN_FAILED');
    },

    getDomain(name) {
      const facility = read('storageDomain');
      if (!facility || typeof facility.get !== 'function') return undefined;
      try {
        return facility.get(name);
      } catch {
        return undefined;
      }
    },

    async closeDomain(domain) {
      if (!domain || typeof domain.close !== 'function') return ok(undefined);
      try {
        await domain.close();
        return ok(undefined);
      } catch (error) {
        return fail(errorCode(error, 'DOMAIN_CLOSE_FAILED'), String(error?.message ?? error));
      }
    },

    // ---- registrations ---------------------------------------------------------
    registerProjection(definition) {
      return callSync('sessionProjections', 'register', [definition]);
    },

    registerTool(definition) {
      return callSync('tools', 'register', [definition]);
    },

    restrictTools(filter) {
      return callSync('tools', 'restrict', [filter]);
    },

    /**
     * 全局工具注册表的名字集合（`tools.schemas()`）。
     *
     * 用途：`toolFilter.deny` **必须先与真实注册表求交**——`tools.restrict()` 对未注册的名字
     * 直接抛（`names unknown global tools: …`），会把 leaf 的创建整个打挂（真实回归，2026-10-16）。
     */
    listToolNames() {
      const tools = read('tools');
      if (tools === undefined) return fail('SERVICE_UNAVAILABLE', 'tools 服务不可用');
      if (typeof tools.schemas !== 'function') return fail('NATIVE_METHOD_MISSING', 'tools.schemas 不是可调用方法');
      counts.calls += 1;
      counts.byService.tools = (counts.byService.tools ?? 0) + 1;
      try {
        const schemas = tools.schemas();
        const names = (Array.isArray(schemas) ? schemas : []).map((schema) => String(schema?.name ?? '')).filter(Boolean);
        return ok(names);
      } catch (error) {
        counts.failures += 1;
        return fail(errorCode(error, 'TOOL_SCHEMAS_FAILED'), String(error?.message ?? error));
      }
    },

    registerToolGuard(guard) {
      return callSync('tools', 'guard', [guard]);
    },

    /**
     * 通过**原生 `tools.execute`** 执行一次工具调用（Lead 第 13 回合 A）。
     *
     * 官方入口：`dsh-tools/lib/index.js:3116 execute(exec)`；`createExecution`（`:3131`）
     * 由 Host 生成 token —— **不要自造 token**。`exec` 实际被读取的字段：
     * `name`、`arguments`、真实 `agent`、**唯一 callId**、可选 `rootCallId`、必有 `signal`；
     * `parent` 仅 PTC 子派发用（普通调用不传）。调用会经过原生 policy/approval。
     *
     * @param {object} agent 真实 live Agent（policy/visibility 需要）
     * @param {string} name 工具名（含在调用者可见工具面内）
     * @param {object} args 该工具真实 schema 字段
     * @param {{callId:string, signal:AbortSignal, rootCallId?:string, parent?:object}} extra
     */
    /** 原生 `tools.execute` 是否真实可用（存在性探测；用于 native/降级分支决定，不伪造）。 */
    nativeExecuteAvailable() {
      const tools = read('tools');
      return Boolean(tools && typeof tools.execute === 'function');
    },
    executeTool(agent, name, args, extra = {}) {
      const callId = typeof extra.callId === 'string' && extra.callId
        ? extra.callId
        : `twb-exec-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const signal = extra.signal ?? new AbortController().signal;
      const exec = {
        callId,
        name: String(name),
        arguments: args && typeof args === 'object' ? args : {},
        ...(agent ? { agent } : {}),
        ...(typeof extra.rootCallId === 'string' && extra.rootCallId ? { rootCallId: extra.rootCallId } : {}),
        ...(extra.parent && typeof extra.parent === 'object' ? { parent: extra.parent } : {}),
        signal,
      };
      return call('tools', 'execute', [exec], 'TOOL_EXECUTE_FAILED');
    },

    /**
     * 某个 agent 视角下**是否可见**某个工具（`tools.get(name, agent)`）。
     *
     * 用途（Codex 审阅 E）：`team_exec_check`/`team_materialize` 不能绕开原 Host 工具权限——
     * 如果这个 agent 连 `pwsh`/`write` 都被 profile/用户限制掉了，本插件的执行/物化也必须拒绝，
     * 而不是用它自己的 spawn/fs 另开一条无鉴权通路。
     */
    hasTool(agent, name) {
      const tools = read('tools');
      if (tools === undefined) return fail('SERVICE_UNAVAILABLE', 'tools 服务不可用');
      if (typeof tools.get !== 'function') return fail('NATIVE_METHOD_MISSING', 'tools.get 不是可调用方法');
      counts.calls += 1;
      counts.byService.tools = (counts.byService.tools ?? 0) + 1;
      try {
        const found = tools.get(String(name), agent);
        return ok(Boolean(found));
      } catch (error) {
        counts.failures += 1;
        return fail(errorCode(error, 'TOOL_LOOKUP_FAILED'), String(error?.message ?? error));
      }
    },

    registerPromptSection(section) {
      return callSync('systemPrompt', 'section', [section]);
    },

    registerSkillProvider(create) {
      return callSync('skills', 'registerProvider', [create]);
    },

    registerCommand(definition) {
      return callSync('commands', 'register', [definition]);
    },

    registerWebRoute(route) {
      return callSync('webServer', 'register', [route]);
    },

    /** 订阅原生事件；返回 disposer（服务缺失时返回 no-op）。 */
    on(event, listener) {
      if (!ctx || typeof ctx.on !== 'function') return () => {};
      try {
        const disposer = ctx.on(event, listener);
        return typeof disposer === 'function' ? disposer : () => {};
      } catch (error) {
        diagnostics.push('ctx.on:error', `subscribe ${event} failed: ${String(error?.message ?? error)}`);
        return () => {};
      }
    },

    /** 注册一个随插件卸载自动释放的 effect。 */
    effect(factory, label) {
      if (!ctx || typeof ctx.effect !== 'function') return () => {};
      try {
        const disposer = ctx.effect(factory, label);
        return typeof disposer === 'function' ? disposer : () => {};
      } catch (error) {
        diagnostics.push('ctx.effect:error', `${label ?? 'effect'}: ${String(error?.message ?? error)}`);
        return () => {};
      }
    },

    now() {
      return Date.now();
    },

    // ---- 只读文件接口（契约 v1：证据核对 / 费用增量归账） ----------------------
    /**
     * 读取一个文件的**元数据 + sha256**（不返回内容，避免把大文件读进上下文）。
     *
     * 证据式完成判定用它核对"产物真实存在 + 内容没变"；返回值归一化成 ok/code，
     * 权限错误原样保留 `systemCode`（不重试、不绕过）。
     *
     * @param {string} target 绝对路径
     * @param {{maxBytes?:number}} [options]
     */
    async readFileInfo(target, options = {}) {
      const maxBytes = Number.isFinite(options.maxBytes) ? Number(options.maxBytes) : 256 * 1024 * 1024;
      counts.calls += 1;
      counts.byService.fs = (counts.byService.fs ?? 0) + 1;
      try {
        const info = await nodeFs.stat(String(target));
        if (!info.isFile()) return fail('NOT_A_FILE', `${target} 不是普通文件`);
        if (info.size > maxBytes) {
          return ok({ exists: true, bytes: info.size, sha256: null, mtimeMs: info.mtimeMs, oversized: true });
        }
        const hash = createHash('sha256');
        const handle = await nodeFs.open(String(target), 'r');
        try {
          const buffer = Buffer.alloc(1024 * 1024);
          for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            hash.update(buffer.subarray(0, bytesRead));
          }
        } finally {
          await handle.close();
        }
        return ok({ exists: true, bytes: info.size, sha256: hash.digest('hex').toUpperCase(), mtimeMs: info.mtimeMs });
      } catch (error) {
        const code = String(error?.code ?? '');
        if (code === 'ENOENT') return ok({ exists: false, bytes: 0, sha256: null, mtimeMs: null });
        counts.failures += 1;
        diagnostics.push('fs.readFileInfo:error', `${code}: ${String(error?.message ?? error)}`);
        return fail(code || 'FILE_READ_FAILED', String(error?.message ?? error), { path: String(target), systemCode: code || null });
      }
    },

    /**
     * 从 `offset` 起读取至多 `length` 字节的**文本**（费用账本增量归账用）。
     * 返回 `{ text, size }`：`size` 是文件当前大小，用于判断截断/轮转。
     */
    async readFileRange(target, offset = 0, length = 1024 * 1024) {
      counts.calls += 1;
      counts.byService.fs = (counts.byService.fs ?? 0) + 1;
      try {
        const info = await nodeFs.stat(String(target));
        const start = Math.max(0, Math.trunc(Number(offset) || 0));
        const size = info.size;
        if (start >= size) return ok({ text: '', size });
        const span = Math.min(Math.max(1, Math.trunc(Number(length) || 1)), size - start);
        const handle = await nodeFs.open(String(target), 'r');
        try {
          const buffer = Buffer.alloc(span);
          const { bytesRead } = await handle.read(buffer, 0, span, start);
          return ok({ text: buffer.subarray(0, bytesRead).toString('utf8'), size, start, bytes: bytesRead });
        } finally {
          await handle.close();
        }
      } catch (error) {
        const code = String(error?.code ?? '');
        counts.failures += 1;
        diagnostics.push('fs.readFileRange:error', `${code}: ${String(error?.message ?? error)}`);
        return fail(code || 'FILE_RANGE_READ_FAILED', String(error?.message ?? error), { path: String(target), systemCode: code || null });
      }
    },

    /**
     * 原生 session 元数据（只读）：`sessionPersistence.list()` → `SessionPersistenceSnapshot[]`，
     * 每项至少含 `header.id` / `header.parentSession`。用于历史补账的角色发现 + 祖先链，
     * **不读取事件正文、不喂模型**。服务/方法缺失返回 `{ ok:false }`（调用方保持 unknown，不伪造）。
     */
    async listSessions() {
      const persistence = read('sessionPersistence') ?? read('sessionQuery');
      if (!persistence) return fail('SERVICE_UNAVAILABLE', 'sessionPersistence 服务不可用');
      if (typeof persistence.list !== 'function') return fail('NATIVE_METHOD_MISSING', 'sessionPersistence.list 不是可调用方法');
      counts.calls += 1;
      counts.byService.sessionPersistence = (counts.byService.sessionPersistence ?? 0) + 1;
      try {
        const snapshots = await persistence.list();
        const list = (Array.isArray(snapshots) ? snapshots : []).map((snapshot) => ({
          id: String(snapshot?.header?.id ?? snapshot?.id ?? ''),
          parentSession: snapshot?.header?.parentSession ?? snapshot?.parentSession ?? null,
          createdAt: snapshot?.header?.createdAt ?? snapshot?.createdAt ?? null,
          cwd: snapshot?.header?.cwd ?? snapshot?.cwd ?? null,
          revision: snapshot?.revision ?? null,
          sizeBytes: snapshot?.sizeBytes ?? null,
          header: snapshot?.header ?? null,
        })).filter((entry) => entry.id);
        return ok(list);
      } catch (error) {
        counts.failures += 1;
        return fail(errorCode(error, 'SESSION_LIST_FAILED'), String(error?.message ?? error));
      }
    },

    /**
     * 原生 team registry（只读）：用于给未在本插件登记的维护团队一个**协调归属**（不丢账）。
     * 只做只读列举；缺服务返回空数组（调用方不伪造）。
     */
    listNativeTeams() {
      const teams = read('agentTeams');
      if (!teams) return [];
      try {
        const listed = typeof teams.list === 'function' ? teams.list() : (typeof teams.teams === 'function' ? teams.teams() : []);
        const list = Array.isArray(listed) ? listed : (Array.isArray(listed?.teams) ? listed.teams : []);
        return list.map((entry) => ({
          id: String(entry?.id ?? entry?.teamId ?? entry?.sessionId ?? ''),
          teamKey: entry?.teamKey ?? entry?.id ?? entry?.teamId ?? null,
          rootSessionId: entry?.rootSessionId ?? entry?.root ?? entry?.sessionId ?? null,
          sessionId: entry?.sessionId ?? entry?.id ?? null,
        })).filter((entry) => entry.id || entry.sessionId);
      } catch {
        return [];
      }
    },

    /**
     * 目标 agent 的**精确服务**（官方 `agentPresets.serviceFor(agent, name)`）：
     * 被隔离到 preset 组的服务（如 compaction）只能从这里取，根 `ctx.get` 不是同一实例。
     * 缺 agentPresets 返回 undefined（调用方回退根服务，不伪造）。
     */
    serviceFor(agent, name) {
      const presets = read('agentPresets');
      if (!presets || typeof presets.serviceFor !== 'function' || !agent) return undefined;
      try {
        return presets.serviceFor(agent, String(name));
      } catch (error) {
        diagnostics.push('agentPresets.serviceFor:error', `${name}: ${String(error?.message ?? error)}`);
        return undefined;
      }
    },

    rawCtx: () => ctx,
  };

  diagnostics.push('adapter:created', 'adapter created', availability());
  return api;
}
