/**
 * Mini-React + fake module loader + fake Cordis client ctx.
 *
 * 用途：在不启动真实浏览器/真实 DSH 页面的前提下，把**构建产物** `client.js`
 * 当作一个 `window.__ModuleLoader__.load({...})` 注册来执行，注册进一个假的
 * client ctx，然后用 mini-React 递归渲染 main panel，断言每窗配方与不变式。
 *
 * 诚实说明：这里跑的是打桩的 mini-React + 假 slots/sessions 服务，
 * **不是**真实页面渲染。使用它的用例必须标 `simulated: true`。
 *
 * mini-React 刻意保留了真实 React 的一条关键语义：
 * **依赖变化时先跑上一次的 cleanup，再跑新的 effect**。
 *
 * 覆盖范围（除 surface v2 注册/窗格/二级视图/选择器/迁移/焦点桥/存储健康行之外）：
 * **费用 + 真实成果**（工作台运行状态，`docs/ARCHITECTURE.md` §1）——
 * `snapshot.usage` / `findings` / `errorFingerprints` 的只读渲染、本地分页（20/20/10）、
 * 缺字段降级为「等待宿主数据」、unknown/estimate/invalidated/stale 的显式标注，以及
 * 「驱动这些数据只发生 GET /state、sessions 仍只有只读成员」这一条硬约束。
 */
import { readFileSync } from 'node:fs';

/** 依赖比较：undefined 视为"每次变化"（与 React 的 dep 数组语义一致）。 */
function depsEqual(left, right) {
  if (left === undefined || right === undefined) return false;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (!Object.is(left[index], right[index])) return false;
  return true;
}

/**
 * 执行 `client.js` 并跑完全部断言。
 *
 * @param {{
 *   clientPath: string,
 *   check: (name: string, ok: boolean, detail?: unknown) => boolean,
 *   onEvidence?: (evidence: Record<string, unknown>) => void,
 * }} options
 */
export async function runClientHarness(options) {
  const { clientPath, check } = options;
  const source = readFileSync(clientPath, 'utf8');

  const internalFailures = [];
  const notes = [];

  // ---------- fake module loader ----------
  let registration = null;
  const fakeWindow = {
    __ModuleLoader__: { load: (reg) => { registration = reg; } },
    // The official loader appends a classic <script src="…?rev=…">; `currentScript` is only valid
    // DURING that script's execution, so the artifact must capture it there (factory runs later).
    document: { currentScript: { src: '/plugin-assets/team-workbench/client.js?rev=rev-load-1' }, querySelectorAll: () => [] },
    __DSH_BOOT__: {
      rev: 'boot-graph-1',
      entries: [{ id: '@local/dsh-team-workbench', url: '/plugin-assets/team-workbench/client.js?rev=rev-boot-declared', rev: 'rev-boot-declared' }]
    }
  };

  // ---------- mini React ----------
  let current = null;
  let cursor = 0;
  let needsRender = false;

  const React = {
    createElement(type, props) {
      const rest = Array.prototype.slice.call(arguments, 2);
      const flat = [];
      const push = (value, keyPrefix) => {
        if (value === null || value === undefined || value === false || value === true) return;
        if (Array.isArray(value)) {
          value.forEach((item, index) => push(item, `${keyPrefix}.${index}`));
          return;
        }
        flat.push({ value, key: keyPrefix });
      };
      rest.forEach((value, index) => push(value, String(index)));
      const next = Object.assign({}, props || {});
      if (flat.length > 0) next.__children = flat;
      return { __el: true, type, props: next };
    },
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const index = cursor++;
      const cache = current.cache;
      if (!(index in cache)) cache[index] = typeof initial === 'function' ? initial() : initial;
      const setter = (value) => {
        const next = typeof value === 'function' ? value(cache[index]) : value;
        if (!Object.is(next, cache[index])) {
          cache[index] = next;
          needsRender = true;
        }
      };
      return [cache[index], setter];
    },
    useRef(initial) {
      const index = cursor++;
      const cache = current.cache;
      if (!(index in cache)) cache[index] = { current: initial };
      return cache[index];
    },
    useMemo(factory, deps) {
      const index = cursor++;
      const cache = current.cache;
      const previous = cache[index];
      if (previous !== undefined && depsEqual(previous.deps, deps)) return previous.value;
      const value = factory();
      cache[index] = { deps, value };
      return value;
    },
    useCallback(fn, deps) {
      return React.useMemo(() => fn, deps);
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const cache = current.cache;
      const previous = cache[index];
      if (previous !== undefined && depsEqual(previous.deps, deps)) return;
      // React 语义：依赖变化先跑旧 cleanup，再跑新 effect。
      if (previous !== undefined && typeof previous.cleanup === 'function') {
        try {
          previous.cleanup();
        } catch (error) {
          internalFailures.push(`CLEANUP THROW: ${error.message}`);
        }
      }
      const record = { deps, cleanup: undefined };
      cache[index] = record;
      current.effects.push(() => {
        const produced = effect();
        if (typeof produced === 'function') record.cleanup = produced;
      });
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot();
    },
    Component: class {},
  };

  // ---------- fake services ----------
  const listSnapshot = {
    ids: ['S-lead', 'S-member', 'S-child', 'S-task', 'S-main2'],
    byId: {
      'S-lead': { id: 'S-lead', displayTitle: 'lead session', running: true, blank: false, updatedAt: Date.now() - 60000, cwd: 'D:\\proj', retainedBy: { mainView: 0 } },
      'S-member': { id: 'S-member', displayTitle: 'combat-system', running: false, blank: false, updatedAt: Date.now() - 120000, cwd: 'D:\\proj', retainedBy: { mainView: 0 } },
      'S-child': { id: 'S-child', displayTitle: 'child leaf', running: true, blank: false, updatedAt: Date.now() - 5000, cwd: 'D:\\proj', parentId: 'S-member', origin: 'subagent', retainedBy: { mainView: 0 } },
      'S-task': { id: 'S-task', displayTitle: 'plain task', running: false, blank: true, updatedAt: 0, cwd: 'D:\\proj', retainedBy: { mainView: 0 } },
      // 第二个普通主会话：会话范围收紧后它仍然是合法候选，leaf 不是。
      'S-main2': { id: 'S-main2', displayTitle: 'docs-workbench', running: true, blank: false, updatedAt: Date.now() - 30000, cwd: 'D:\\proj', retainedBy: { mainView: 0 } },
    },
    phase: 'ready',
    projectionsBySession: {
      'S-lead': {
        values: {
          agentTeam: {
            members: [
              { id: 'S-lead', name: 'lead', role: 'lead', phase: 'active' },
              { id: 'S-member', name: 'combat-system', role: 'teammate', phase: 'active' },
            ],
            tasks: [
              { id: 'task-1', revision: 1, subject: '战斗系统模块交付', description: 'x', status: 'in_progress', ownerName: 'combat-system', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] },
              { id: 'task-2', revision: 1, subject: '数值表', description: 'y', status: 'pending', ownerName: 'lead', blockedBy: [], writeScopes: [], ready: false, writeScopeWarnings: [] },
            ],
          },
          subagentCatalog: [{ id: 'S-child', label: 'leaf-1' }],
        },
      },
    },
  };

  const sessionSnapshot = {
    sessionId: 'S-member',
    running: false,
    blank: false,
    openState: 'open',
    lastAgentError: null,
    subagent: null,
    awaitingFirstTurn: false,
    promptAttempted: true,
  };

  const statusMap = new Map([['S-member', { running: false, pendingInteraction: undefined, completionUnread: true }]]);
  const statusSource = { getSnapshot: () => statusMap, subscribe: () => () => {} };

  /** 测试开关：让 getSnapshot() 返回**缺 `subagent` 键**的畸形快照（fail-closed 回归）。 */
  let malformedSnapshot = false;
  /**
   * 权威契约形状的 SessionSnapshot（见上方 ROUTE 注释）。
   * 主会话 `subagent: null`；子会话 `subagent: {address, parentAvailable}`。
   */
  function bindingSnapshotFor(id) {
    const row = listSnapshot.byId[id] ?? {};
    const isLeafRow = Boolean(row.origin === 'subagent' || row.parentId);
    return {
      sessionId: id,
      pendingSubmissions: [],
      running: row.running === true,
      subagent: isLeafRow
        ? { address: { parentSessionId: row.parentId ?? null, childSessionId: id, mode: 'continuable' }, parentAvailable: true }
        : null,
      removed: false,
      openState: row.blank ? 'blank' : 'open',
      openError: null,
    };
  }

  const retainedRefs = [];
  const releasedIds = [];
  const accessedSessionsMembers = new Set();

  /**
   * rc.2 真实语义（证据：api-session-controller/lib/client.js:3192-3205）：
   * `retain(target, { signal })` 的 signal 只 **reject 打开等待**，**从不释放**引用。
   * 因此调用方必须自己显式 `release()`。
   * 注意：docs/ARCHITECTURE.md；历史检查 4.3 描述为"abort 会释放"是**错的**。
   */
  const sessionsImpl = {
    list: { getSnapshot: () => listSnapshot, subscribe: () => () => {} },
    retain(target, retainOptions) {
      const sessionId = typeof target === 'string' ? target : target.childSessionId;
      const reference = {
        sessionId,
        binding: { sessionId },
        release() {
          releasedIds.push(sessionId);
        },
        [Symbol.dispose]() {
          this.release();
        },
      };
      if (retainOptions && retainOptions.signal !== undefined) {
        // rc.2 parity：只监听，不释放。
        retainOptions.signal.addEventListener('abort', () => {}, { once: true });
      }
      retainedRefs.push({ target, options: retainOptions, reference });
      return reference;
    },
    // rc.2 真实语义：`openSession(target)` 之后该会话的 mainView 计数必须 **>0**，
    // 否则桥的 `mainViewCount(id).count > 0` → `already-main-view` 短路分支永远测不到。
    retainInfo: (target) => ({
      getSnapshot: () => {
        const id = typeof target === 'string' ? target : (target?.childSessionId ?? target?.sessionId);
        const held = mainViewRetained.has(id);
        return { referenceCount: held ? 1 : 0, retainedBy: held ? { mainView: 1 } : {}, known: true };
      },
      subscribe: () => () => {},
    }),
    subagentAddress: () => undefined,
    // =====================================================================
    // ROUTE / 补丁点（归因中，2026-10-14）—— 因果链，别只写在文档里：
    //   1) 弱替身：binding().session 只有 projections，**没有 getSnapshot/subscribe**
    //      → 客户端 classifySession 走不到 `binding(id).session.getSnapshot().subagent === null`
    //        这条 A1 最核心的"这是主会话"正面证据分支；30 条断言此前是在**走不到目标分支**的
    //        harness 上通过的。
    //   2) 补上 getSnapshot 但返回形状不符契约（缺 `subagent` 键）→ client 套件掉到 90/120。
    //   3) 按 **权威 client 契约**（`cordis_inspect_query(platform="client", provider="Service",
    //      service="sessions")`）补齐形状后重跑 —— SessionFace = ISession & ObservableSnapshot<
    //      SessionSnapshot>，且 SessionSnapshot 的关键字段：
    //        sessionId / pendingSubmissions[] / running / **subagent: {address, parentAvailable?} | null**（必填）
    //        / removed / openState / openError
    //      主会话 → `subagent: null`；子会话 → `subagent: {address:{parentSessionId,childSessionId,mode}, parentAvailable}`。
    //   4) `binding(id)` 只在**本客户端已 retain 过该会话**时有值 —— 这解释了为什么弱替身掩盖了差异。
    // 回退方式：把 `getSnapshot` 换回 `() => undefined` 即回到旧的弱替身（126/126）。
    // =====================================================================
    binding: (id) => {
      // 契约：`binding(id): SessionBinding | undefined` —— 只有**本客户端 retain 过 /
      // 已知** 的会话才有 binding。列表里没有行、也没 retain 过的会话必须返回 undefined
      // （否则"证据不足"会被伪造成"主会话证据"，A1 的 fail-closed 就测不出来）。
      if (!malformedSnapshot && listSnapshot.byId[id] === undefined) return undefined;
      return {
        sessionId: id,
        session: {
          getSnapshot: () => (malformedSnapshot ? { sessionId: id, running: false, removed: false } : bindingSnapshotFor(id)),
          subscribe: () => () => {},
          projections: { faceOf: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }) },
        },
        eventSource: {},
        ctx: {},
      };
    },
  };
  const sessions = new Proxy(sessionsImpl, {
    get(target, property) {
      if (typeof property === 'string') accessedSessionsMembers.add(property);
      return target[property];
    },
  });

  const events = [];
  const provided = {};
  const effects = [];
  const registrations = [];
  const layoutSnapshot = { activePanelId: 'team-workbench' };

  // ---- 客户端 → 原生命中面（右栏/焦点桥）的观测面 ---------------------------
  const openSessionCalls = [];
  const selectPanelCalls = [];
  const mainViewRetained = new Set();
  const uiWorkspaceFake = {
    openSession(target) {
      openSessionCalls.push(target);
      // 模型化 replaceMain()：公开的 mainView 引用
      mainViewRetained.add(typeof target === 'string' ? target : target.childSessionId);
    },
  };
  let uiWorkspace = uiWorkspaceFake;
  const localeDicts = new Map();
  const localePanelLabels = new Set();

  function collectDisposers(value, out) {
    if (value === null || value === undefined) return;
    if (typeof value === 'function') {
      out.push(value);
      return;
    }
    if (typeof value[Symbol.iterator] === 'function') {
      for (const item of value) collectDisposers(item, out);
    }
  }

  /**
   * 真实 workspace 列表的替身：选择器**按它分组**（surface v2 的「模仿 dsh 主页面会话」）。
   * 形状与宿主一致：`workspaces.list.getSnapshot() = { items:[{workspaceId,title,path,sessionIds,createdAt}],
   * pinnedSessionIds, archivedSessionIds }`（依据 @deepseek-ai/dsh-client-ui-workspace client.js:420-437）。
   * S-lead / S-task 属于 dsh 工作区，S-main2 是散会话 → 未分组。
   */
  const workspacesSnapshot = {
    items: [
      { workspaceId: 'ws-dsh', title: 'dsh', path: 'D:\\proj', sessionIds: ['S-lead', 'S-task'], createdAt: '2026-10-01T00:00:00.000Z' },
    ],
    pinnedSessionIds: [],
    archivedSessionIds: [],
  };
  const workspacesImpl = { list: { getSnapshot: () => workspacesSnapshot, subscribe: () => () => {} } };

  // Official client-module metadata as the REAL frontend client exposes it
  // (dsh-client-modules/lib/client.js): `manifest` (declared versions), `reloadTargets` (pending
  // desired targets) and `factories` (entries actually registered by an executed bundle, with the
  // rev recorded at registration). There is NO frontend `onRebuilt` method — the fixture must not
  // pretend one exists; an HMR rev announcement only mutates manifest/reloadTargets.
  const modulesFake = {
    manifest: { rev: 'boot-graph-1', modules: [{ id: '@local/dsh-team-workbench', url: '/plugin-assets/team-workbench/client.js?rev=rev-declared', rev: 'rev-declared' }] },
    reloadTargets: new Map(),
    factories: new Map([['@local/dsh-team-workbench', { factory: () => ({}), rev: 'rev-registered-1' }]])
  };
  const ctx = {
    effect(callback, label) {
      const produced = callback();
      const disposers = [];
      collectDisposers(produced, disposers);
      const dispose = () => {
        for (const item of disposers.splice(0)) item();
      };
      effects.push({ label, dispose });
      return dispose;
    },
    on(name, callback) {
      events.push({ name, callback });
      return () => {};
    },
    get(name) {
      if (name === 'modules') return modulesFake;
      if (name === 'sessions') return sessions;
      if (name === 'uiWorkspace') return uiWorkspace;
      if (name === 'workspaces') return workspacesImpl;
      if (name === 'uiSession') return undefined;
      return undefined;
    },
    reflect: {
      provide(name, value) {
        provided[name] = value;
        return () => {
          delete provided[name];
        };
      },
    },
    locale: {
      // 替身太弱会让"字典内容"这类事实无从断言（与 binding().session.getSnapshot 同类问题）：
      // 这里**保留**注册进来的字典，并收集所有 panel.label 取值，供"改名"正向断言使用。
      register: (name, dict) => {
        const collect = (value, depth) => {
          if (depth > 4 || value === null || typeof value !== 'object') return;
          if (typeof value['panel.label'] === 'string') localePanelLabels.add(value['panel.label']);
          for (const nested of Object.values(value)) collect(nested, depth + 1);
        };
        collect(dict, 0);
        localeDicts.set(String(name), dict);
        return () => {};
      },
      bind: () => (key) => key,
      getSnapshot: () => ({ locale: 'zh', revision: 0 }),
      subscribe: () => () => {},
      resolveText: (text) => text,
    },
    layout: {
      panelInfo: { getSnapshot: () => layoutSnapshot, subscribe: () => () => {} },
      selectPanel(panelId) {
        selectPanelCalls.push(panelId);
      },
      toggleSidebar() {},
      beginNavigation: () => new AbortController().signal,
    },
    slots: {
      inject(key, callback) {
        const produced = callback();
        const disposers = [];
        collectDisposers(produced, disposers);
        return () => {
          for (const item of disposers.splice(0)) item();
        };
      },
      register(slot, component) {
        registrations.push({ options: slot, component });
        return () => {};
      },
      subscribe: () => () => {},
      entries: (key) => registrations.filter((row) => row.options.name === key).map((row) => ({ options: row.options })),
      entriesOfSlot: (key) => registrations.filter((row) => row.options.name === key).map((row) => ({ options: row.options })),
      spec: () => undefined,
    },
    sessions,
  };

  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  /** 默认为 "离线"（抛错），只有显式设置后才返回 Host `/state` 快照。 */
  let hostStateResponse = null;
  /**
   * 真实 Host 契约（CONTRACT §7.1/§7.2 + host-autonomy 第 7 回合实现）：
   *   GET <base>/state/detail?section=findings|errors|usage&kind=…&page=1&pageSize=≤50
   *                            [&ownerMemberId][&teamKey]
   *     → { ok, section, kind, page, pageSize, pages, total, items }
   *   未知 section → 400 UNKNOWN_SECTION；未知 findings kind → 400 UNKNOWN_KIND。
   * 测试通过三个"宿主真值"变量提供数据，fake 同时生成 `/state` 汇总与 detail 分页，
   * 保证前端消费的是**同一份宿主数据**（不靠测试端另写一份推断形状）。
   */
  let hostUsageSnapshot = null;
  let hostFindingsFull = null;
  let hostErrorGroups = [];
  let hostDetailRouteAvailable = true;

  const FINDINGS_KINDS = ['verified', 'unfinished', 'inProgress', 'rejected', 'invalidated', 'activity', 'errors'];
  const VERIFICATION_LEVELS = ['offline', 'integration', 'engineering-save', 'gameplay', 'user-confirmation'];

  /** `/state.findings` 的真实汇总（host: summaryOfFindings）。 */
  function summaryOfFindings(full) {
    if (full === null) return undefined;
    const byLevel = Object.fromEntries(VERIFICATION_LEVELS.map((level) => [level, 0]));
    for (const item of full.verified ?? []) {
      const level = item.verificationLevel ?? 'offline';
      if (byLevel[level] === undefined) byLevel[level] = 0;
      byLevel[level] += 1;
    }
    const take = (list) => (Array.isArray(list) ? list.slice(0, 5) : []);
    return {
      generatedAt: full.generatedAt ?? 0,
      counts: { ...(full.counts ?? {}), verifiedByLevel: byLevel },
      preview: {
        verified: take(full.verified),
        unfinished: take(full.unfinished),
        rejected: take(full.rejected),
        invalidated: take(full.invalidated),
      },
      levels: full.levels ?? { verified: [] },
      lastEffectiveProgress: full.lastEffectiveProgress ?? { at: 0, workId: null, ownerMemberId: null, text: '' },
      note: full.note ?? '',
    };
  }

  function pageOf(rows, query) {
    const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
    const pageSize = Math.min(Math.max(Number.parseInt(query.get('pageSize') ?? '20', 10) || 20, 1), 50);
    const ownerMemberId = query.get('ownerMemberId');
    const filtered = ownerMemberId ? rows.filter((row) => String(row.ownerMemberId ?? row.memberId ?? '') === ownerMemberId) : rows;
    const total = filtered.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    return { page, pageSize, pages, total, items: filtered.slice((page - 1) * pageSize, page * pageSize) };
  }

  function stateDetailResponse(url) {
    const parsed = new URL(String(url), 'http://harness.local');
    const query = parsed.searchParams;
    const section = String(query.get('section') ?? 'findings');
    if (section === 'findings') {
      const kind = String(query.get('kind') ?? 'verified');
      if (FINDINGS_KINDS.indexOf(kind) < 0) return { status: 400, payload: { ok: false, code: 'UNKNOWN_KIND', section, kind } };
      const rows = hostFindingsFull === null ? [] : (hostFindingsFull[kind] ?? []);
      const page = pageOf(rows, query);
      return { status: 200, payload: { ok: true, section, kind, page: page.page, pageSize: page.pageSize, pages: page.pages, total: page.total, items: page.items } };
    }
    if (section === 'errors') {
      const page = pageOf(hostErrorGroups, query);
      return { status: 200, payload: { ok: true, section: 'errors', kind: 'errors', page: page.page, pageSize: page.pageSize, pages: page.pages, total: page.total, items: page.items } };
    }
    if (section === 'usage') {
      const kind = String(query.get('kind') ?? 'byOwner');
      const budgetRows = (map, keyName) => Object.entries(map ?? {}).map(([key, budget]) => Object.assign({
        [keyName]: key,
        requests: budget.requests ?? 0,
        inputTokens: budget.inputTokens ?? 0,
        outputTokens: budget.outputTokens ?? 0,
        cacheReadTokens: budget.cacheReadTokens ?? 0,
        costEstimate: budget.costEstimate ?? 0,
        costUnknownRequests: budget.costUnknownRequests ?? 0,
        retries: budget.retries ?? 0,
        duplicatesSuppressed: budget.duplicatesSuppressed ?? 0,
      }));
      const rows = kind === 'byPhase'
        ? budgetRows(hostUsageSnapshot?.scopes?.byPhase, 'phase')
        : (kind === 'byWork' ? budgetRows(hostUsageSnapshot?.scopes?.byWork, 'workId') : budgetRows(hostUsageSnapshot?.scopes?.byOwner, 'ownerMemberId'));
      const page = pageOf(rows, query);
      return { status: 200, payload: { ok: true, section: 'usage', kind, page: page.page, pageSize: page.pageSize, pages: page.pages, total: page.total, items: page.items } };
    }
    return { status: 400, payload: { ok: false, code: 'UNKNOWN_SECTION', section } };
  }

  /** `/op` 只读兼容线路：usage-records（当前已部署 host 的分页明细）+ client-ack。 */
  function opResponse(body) {
    const op = body !== null && typeof body === 'object' ? body.op : undefined;
    if (op === 'usage-records') {
      const args = body.args ?? {};
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 200);
      const cursor = Math.max(0, Number(args.cursor) || 0);
      const rows = hostUsageRecordRows.slice(cursor, cursor + limit).map((row) => ({ ...row }));
      return { ok: true, status: 200, payload: { ok: true, total: hostUsageRecordRows.length, cursor, limit, hasMore: cursor + rows.length < hostUsageRecordRows.length, nextCursor: cursor + rows.length < hostUsageRecordRows.length ? cursor + rows.length : null, rows } };
    }
    if (op === 'usage' || op === 'usage-summary') {
      if (hostProjectionFail === true || hostProjectionFailRemaining > 0 || hostProjectionFailOps.has(op)) {
        if (hostProjectionFailRemaining > 0) hostProjectionFailRemaining -= 1;
        return { ok: false, status: 200, payload: { ok: false, code: 'PROJECTION_DOWN' } };
      }
      return { ok: true, status: 200, payload: { ok: true, usage: hostUsageSnapshot ?? null } };
    }
    if (op === 'findings') {
      if (hostProjectionFail === true || hostProjectionFailRemaining > 0 || hostProjectionFailOps.has(op)) {
        if (hostProjectionFailRemaining > 0) hostProjectionFailRemaining -= 1;
        return { ok: false, status: 200, payload: { ok: false, code: 'PROJECTION_DOWN' } };
      }
      return { ok: true, status: 200, payload: { ok: true, findings: hostFindingsFull === null ? null : summaryOfFindings(hostFindingsFull) } };
    }
    if (op === 'error-fingerprints' || op === 'errorFingerprints') {
      if (hostProjectionFail === true || hostProjectionFailRemaining > 0 || hostProjectionFailOps.has(op)) {
        if (hostProjectionFailRemaining > 0) hostProjectionFailRemaining -= 1;
        return { ok: false, status: 200, payload: { ok: false, code: 'PROJECTION_DOWN' } };
      }
      return { ok: true, status: 200, payload: { ok: true, errorFingerprints: { generatedAt: Date.now(), total: hostErrorGroups.length, groups: hostErrorGroups } } };
    }
    if (op === 'client-ack') {
      // Mirror `service.recordFrontendAck`: it reads `bundle.url`, `bundle.activatedAt`,
      // `frontendRev`, `mounted === true` and persists those; `renderedRegions` is currently dropped.
      const request = body.args ?? {};
      const bundle = request.bundle !== null && request.bundle !== undefined && typeof request.bundle === 'object' ? request.bundle : {};
      const bundleUrl = typeof bundle.url === 'string' && bundle.url.trim() !== '' ? bundle.url.trim() : null;
      if (bundleUrl === null) return { ok: false, status: 200, payload: { ok: false, code: 'ACK_BUNDLE_REQUIRED' } };
      const activatedAt = Number.isFinite(Number(bundle.activatedAt)) ? Number(bundle.activatedAt) : null;
      const record = {
        bundleUrl,
        activatedAt,
        mounted: request.mounted === true,
        frontendRev: typeof request.frontendRev === 'string' ? request.frontendRev : null,
        detailTransport: request.detailTransport ?? null,
        persisted: true,
        count: hostFrontendAckRecords.length + 1,
        sourceDigest: typeof bundle.sourceDigest === 'string' ? bundle.sourceDigest : null,
        renderedRegionsDroppedByHost: Array.isArray(request.renderedRegions) ? request.renderedRegions.length : 0
      };
      hostFrontendAckRecords.push(record);
      return { ok: true, status: 200, payload: { ok: true, deduplicated: false, persisted: true, ack: record, frontendAck: { mounted: record.mounted, bundleUrl: record.bundleUrl, activatedAt: record.activatedAt, rev: record.frontendRev, count: hostFrontendAckRecords.length, persisted: true } } };
    }
    return { ok: false, status: 200, payload: { ok: false, code: 'UNKNOWN_OP', message: '未知操作 ' + String(op) } };
  }
  let hostUsageRecordRows = [];
  /** Projection refresh test knobs: fail all projection ops, or hold `/state` answers manually. */
  let hostProjectionFail = false;
  let hostProjectionFailRemaining = 0;
  const hostProjectionFailOps = new Set();
  let hostStateManual = false;
  const hostStateManualQueue = [];
  /** Host-persisted frontend-ack records (what the backend can read back). */
  const hostFrontendAckRecords = [];

  /** 记录每一次 fetch 调用，供"Host 记录被纠正"类断言使用。 */
  const hostCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    const method = String(options?.method ?? 'GET').toUpperCase();
    let body;
    if (typeof options?.body === 'string') {
      try {
        body = JSON.parse(options.body);
      } catch {
        body = options.body;
      }
    } else {
      body = options?.body;
    }
    hostCalls.push({ method, url: String(url), body });
    if (String(url).indexOf('/state/detail') >= 0) {
      if (!hostDetailRouteAvailable) {
        return { ok: false, status: 404, json: async () => ({ ok: false, code: 'NO_DETAIL_ROUTE' }), text: async () => JSON.stringify({ ok: false, code: 'NO_DETAIL_ROUTE' }) };
      }
      const result = stateDetailResponse(url);
      return { ok: result.status === 200, status: result.status, json: async () => result.payload, text: async () => JSON.stringify(result.payload) };
    }
    if (String(url).indexOf('/op') >= 0) {
      const result = opResponse(body);
      return { ok: result.ok, status: result.status, json: async () => result.payload, text: async () => JSON.stringify(result.payload) };
    }
    if (hostStateManual === true) {
      return await new Promise((resolve) => {
        hostStateManualQueue.push({ resolve });
      });
    }
    if (hostStateResponse === null) throw new Error('offline harness');
    return {
      ok: true,
      status: 200,
      json: async () => hostStateResponse,
      text: async () => JSON.stringify(hostStateResponse),
    };
  };
  // Deterministic fake timers: the refresh scheduler must be bounded and must not wake while the
  // panel is unmounted/disposed. Tests fire due callbacks explicitly.
  const fakeTimers = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, delay) => {
    const entry = { callback, delay, cleared: false, fired: false };
    fakeTimers.push(entry);
    return entry;
  };
  globalThis.clearTimeout = (entry) => {
    if (entry !== null && entry !== undefined && typeof entry === 'object') entry.cleared = true;
  };
  const pendingTimers = () => fakeTimers.filter((entry) => entry.cleared !== true && entry.fired !== true);
  const runDueTimers = async () => {
    for (const entry of pendingTimers()) {
      entry.fired = true;
      try {
        entry.callback();
      } catch (error) {
        internalFailures.push('TIMER THROW :: ' + String(error && error.message ? error.message : error));
      }
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    }
    return pendingTimers().length;
  };
  globalThis.window = fakeWindow;

  try {
    // ---------- execute the artifact ----------
    // eslint-disable-next-line no-new-func
    new Function('window', 'require', 'globalThis', source)(fakeWindow, (id) => {
      if (id === 'react') return React;
      throw new Error(`harness: unexpected require ${id}`);
    }, globalThis);
    // Factory materialization happens LATER: currentScript is already null then.
    fakeWindow.document.currentScript = null;

    check('loader registration id === @local/dsh-team-workbench', registration !== null && registration.id === '@local/dsh-team-workbench');
    if (registration === null) {
      return { registrations, effects, events, provided, retainedRefs, releasedIds, accessedSessionsMembers, internalFailures, notes };
    }
    const plugin = registration.factory((id) => {
      if (id === 'react') return React;
      throw new Error(`unexpected require ${id}`);
    });
    check('client 导出 inject + apply', Array.isArray(plugin.inject) && typeof plugin.apply === 'function', JSON.stringify(plugin.inject));
    plugin.apply(ctx);

    const mainReg = registrations.find((row) => row.options.name === 'main');
    check('main 注册存在且 key === team-workbench', mainReg !== undefined && mainReg.options.key === 'team-workbench');
    const childSpec = mainReg?.options.children?.['teamWorkbench.pane'];
    check('声明 session 作用域子插槽（取得 SessionProvider 的能力）', childSpec?.kind === 'list' && childSpec?.scope === 'session', JSON.stringify(childSpec));
    check('store seat 带 spec + create', typeof mainReg?.options.store?.create === 'function' && typeof mainReg?.options.store?.spec?.init === 'function');
    check('声明 locale namespace 且不自带 t', mainReg?.options.locale === 'teamWorkbench' && typeof mainReg?.options.t === 'undefined');

    const paneRegs = registrations.filter((row) => row.options.name === 'teamWorkbench.pane');
    check('四个 pane 条目', paneRegs.length === 4, paneRegs.map((row) => row.options.id).join(','));
    const sidebarReg = registrations.find((row) => row.options.name === 'sidebar.panellist');
    check('sidebar 条目 id === main key，order=10，label 是函数', sidebarReg?.options.id === 'team-workbench' && sidebarReg?.options.order === 10 && typeof sidebarReg?.options.label === 'function');
    check('locale 字典已注册', effects.some((row) => String(row.label).includes('dictionaries')));
    check('connection/reset 监听器已注册', events.some((row) => row.name === 'connection/reset'));
    check('focus bridge 服务已提供', typeof provided.teamWorkbenchFocus?.activeSessionId === 'function' && typeof provided.teamWorkbenchFocus?.focusPane === 'function');
    // 捕获引用：后续用例可能触发 compat 状态变化并让 provider 被重新注册/释放，
    // 断言必须针对**首次提供**的那份服务，否则会读到 undefined 而不是真实结论。
    const focusBridge = provided.teamWorkBenchFocus;

    // ---------- mini renderer ----------
    const instances = new Map();
    let renderCount = 0;

    function walk(node, nodePath, out) {
      if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return;
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${nodePath}.${index}`, out));
        return;
      }
      if (node.__el !== true) return;
      const props = Object.assign({}, node.props);
      const children = props.__children;
      delete props.__children;
      if (children !== undefined) props.children = children.length === 1 ? children[0].value : children.map((entry) => entry.value);
      if (node.type === React.Fragment) {
        if (children !== undefined) children.forEach((entry, index) => walk(entry.value, `${nodePath}.${index}`, out));
        return;
      }
      if (typeof node.type === 'function') {
        let instance = instances.get(nodePath);
        if (instance === undefined) {
          instance = { cache: {}, effects: [] };
          instances.set(nodePath, instance);
        }
        instance.effects = [];
        const previousCurrent = current;
        const previousCursor = cursor;
        current = instance;
        cursor = 0;
        let produced;
        try {
          produced = node.type(props);
        } catch (error) {
          internalFailures.push(`RENDER THROW at ${nodePath} :: ${error.message}`);
          produced = null;
        } finally {
          current = previousCurrent;
          cursor = previousCursor;
        }
        for (const effect of instance.effects.slice()) {
          const pc = current;
          const pk = cursor;
          current = instance;
          cursor = 0;
          try {
            effect();
          } catch (error) {
            internalFailures.push(`EFFECT THROW at ${nodePath} :: ${error.message}`);
          } finally {
            current = pc;
            cursor = pk;
          }
        }
        if (produced !== null && produced !== undefined) walk(produced, `${nodePath}/r`, out);
        return;
      }
      out.push({ type: node.type, props });
      if (children !== undefined) children.forEach((entry, index) => walk(entry.value, `${nodePath}/${index}`, out));
    }

    const providerCalls = [];
    const factoryCalls = [];
    const viewSlotCalls = [];

    function FakeSessionProvider(props) {
      providerCalls.push({ sessionId: props.session?.sessionId, hasEmpty: typeof props.empty === 'function', child: props.children });
      return props.children ?? null;
    }

    function renderSlot(key, owner, slotOptions) {
      return React.createElement(FakeSlotOutlet, { slotKey: key, owner, opts: slotOptions });
    }

    function FakeSlotOutlet(props) {
      const rows = registrations.filter((row) => row.options.name === props.slotKey);
      const wanted = props.opts && props.opts.only !== undefined ? rows.filter((row) => row.options.id === props.opts.only) : rows;
      return React.createElement(React.Fragment, null, wanted.map((row, index) => {
        const injected = typeof row.options.inject === 'function' ? row.options.inject() : {};
        const sessionSeats = {
          sessionId: props.owner?.sessionId ?? 'S-member',
          useSession: (selector) => selector(sessionSnapshot),
          useSessions: (selector) => selector(listSnapshot),
          useSessionStatus: (selector) => selector(statusSource.getSnapshot()),
          useProjection: (projectionKey, selector) => (typeof selector === 'function' ? selector(undefined) : undefined),
          renderFactorySlot,
          t: (key) => key,
        };
        return React.createElement(row.component, Object.assign({ key: `e${index}` }, sessionSeats, injected, props.owner ?? {}));
      }));
    }

    function renderFactorySlot(name, inputProps, factoryOptions) {
      factoryCalls.push({ name, inputProps, options: factoryOptions });
      const views = factoryOptions?.slots?.views;
      return views === undefined ? null : React.createElement(FakeViewsHost, { views, inputProps });
    }

    function FakeViewsHost({ views, inputProps }) {
      return React.createElement(views, Object.assign({}, inputProps, {
        renderSlot: (key, owner) => {
          viewSlotCalls.push({ key, owner });
          return React.createElement('div', { 'data-slot': key });
        },
      }));
    }

    let renderRuntime = null;

    function renderPanel() {
      const storeInstance = mainReg.options.store.create();
      renderRuntime = storeInstance;
      providerCalls.length = 0;
      factoryCalls.length = 0;
      viewSlotCalls.length = 0;
      const props = {
        SessionProvider: FakeSessionProvider,
        renderSlot,
        renderFactorySlot,
        useSessions: (selector) => selector(listSnapshot),
        usePanelInfo: (selector) => selector(layoutSnapshot),
        useStore: (selector) => selector(storeInstance.getSnapshot()),
        actions: storeInstance.actions,
        t: (key) => key,
        teamWorkbenchRuntime: mainReg.options.inject().teamWorkbenchRuntime,
      };
      const out = [];
      walk(React.createElement(mainReg.component, props), 'root', out);
      return out;
    }

    function renderUntilStable() {
      let host = renderPanel();
      for (let pass = 0; pass < 8; pass += 1) {
        if (!needsRender) break;
        needsRender = false;
        renderCount += 1;
        host = renderPanel();
      }
      return host;
    }

    let host = renderUntilStable();
    const runtime = mainReg.options.inject().teamWorkbenchRuntime;
    // 改名（并行工作台 → 超级工作台）后的正向断言：防以后漏改显示名。
    // runtime 直接暴露 t（`99-entry.js`），无需触碰 sidebar 内部。
    // 改名（并行工作台 → 超级工作台）后的正向断言：断言**字典内容**（事实来源），
    // 而不是 runtime.t 解析结果 —— 后者在我的假 locale 下只会回显 key（替身太弱）。
    check(
      "locale 字典里 panel.label(zh) 恰好是 '超级工作台'",
      localePanelLabels.has('超级工作台'),
      [...localePanelLabels],
    );
    check(
      "locale 字典里 panel.label(en) 恰好是 'Super Workbench'",
      localePanelLabels.has('Super Workbench'),
      [...localePanelLabels],
    );
    check('runtime 作为普通 prop 暴露', runtime !== undefined && typeof runtime.retain === 'function');
    check('初始布局 mode === 1', runtime.layout().mode === 1);

    // 会话范围（surface v2，FROZEN — docs/ARCHITECTURE.md）：
    //   - 窗格/选择器只允许**工作区主会话**（`classifySession === 'main'`）；
    //   - 团队成员 / 子智能体 / leaf 一律不列、不可搜索、不可绑定；成员只能作为
    //     「子会话」（pane.view）从所属工作区会话进入；
    //   - 默认 1 窗并**自动绑定当前活动会话**。
    const isLeaf = (sessionId) => {
      const row = listSnapshot.byId[sessionId];
      return Boolean(row && (row.origin === 'subagent' || row.parentId));
    };
    const isTeamMember = (sessionId) => {
      const team = listSnapshot.projectionsBySession?.['S-lead']?.values?.agentTeam;
      return Boolean(team && (team.members ?? []).some((member) => member.id === sessionId && member.role !== 'lead'));
    };
    const candidateIds = Object.keys(listSnapshot.byId).filter((id) => !isLeaf(id) && !isTeamMember(id));
    check(
      '候选集只含工作区主会话（剔除 leaf S-child 与团队成员 S-member）',
      candidateIds.length === 3
        && JSON.stringify(candidateIds.slice().sort()) === JSON.stringify(['S-lead', 'S-main2', 'S-task'])
        && !candidateIds.includes('S-child')
        && !candidateIds.includes('S-member'),
      JSON.stringify(candidateIds),
    );

    check(
      '默认自动绑定当前活动会话（恰好一个 SessionProvider，且是工作区主会话）',
      providerCalls.length === 1
        && candidateIds.includes(providerCalls[0].sessionId)
        && !isLeaf(providerCalls[0].sessionId)
        && !isTeamMember(providerCalls[0].sessionId),
      JSON.stringify(providerCalls.map((row) => row.sessionId)),
    );
    const paneRetains = () => retainedRefs.filter((row) => row.options.source === 'team-workbench');
    const bridgeRetains = () => retainedRefs.filter((row) => row.options.source === 'mainView');
    check(
      '自动绑定产生一笔 team-workbench retain',
      paneRetains().length === 1 && paneRetains()[0].reference.sessionId === providerCalls[0].sessionId,
      JSON.stringify(paneRetains().map((row) => row.reference.sessionId)),
    );

    // ---- A3 阶段 1：面板已挂载并有焦点目标、但宿主 compat 尚未答复 ----------
    // 必须是第四态 unknown，且绝不调用 openSession / 不发 selectPanel。
    // 只锚定 phase/reason 代码与调用计数，不锚定任何显示文案。
    {
      runtime.noteActiveTarget({ kind: 'session', sessionId: 'S-main2' });
      await Promise.resolve();
      await Promise.resolve();
      const bridgeProbe = focusBridge ?? provided.teamWorkbenchFocus;
      const snapshot = bridgeProbe.getSnapshot();
      check('A3-1：宿主 compat 未答复 → phase === unknown', snapshot.phase === 'unknown', snapshot.phase);
      check('A3-1：reason === host-compat-unknown', snapshot.reason === 'host-compat-unknown', snapshot.reason);
      check('A3-1：unknown 阶段绝不调用 openSession', openSessionCalls.length === 0, JSON.stringify(openSessionCalls));
      check('A3-1：unknown 阶段不发出 selectPanel', selectPanelCalls.length === 0, JSON.stringify(selectPanelCalls));
      // v2：成员会话不是窗格身份，即使被推进 noteActiveTarget 也不能成为桥的目标。
      runtime.noteActiveTarget({ kind: 'session', sessionId: 'S-member' });
      await Promise.resolve();
      await Promise.resolve();
      const memberSnapshot = bridgeProbe.getSnapshot();
      check(
        'A3-1：裸成员会话不会被焦点桥接受为窗格目标（v2）',
        memberSnapshot.activeSessionId === undefined && memberSnapshot.activeTargetKind === undefined,
        { sessionId: memberSnapshot.activeSessionId, kind: memberSnapshot.activeTargetKind },
      );
    }
    // 服务句柄：这里是已被证明可用的一份，后续一律用它，避免 provider 被重注册后读到 undefined。
    const bridgeService = provided.teamWorkbenchFocus ?? focusBridge;

    // SURFACE v2：窗格身份只能是工作区主会话。v1 允许把团队成员直接绑进窗格，
    // 现在 bindTarget 对成员返回 MEMBER_NOT_A_PANE —— 成员只能作为「子会话」进入（见下）。
    const memberPaneBind = runtime.bindTarget('pane-1', { kind: 'session', sessionId: 'S-member' }, 'member', 'combat-system');
    check(
      '团队成员不能作为窗格 target（MEMBER_NOT_A_PANE）',
      memberPaneBind.ok === false && memberPaneBind.code === 'MEMBER_NOT_A_PANE' && memberPaneBind.sessionId === 'S-member',
      JSON.stringify(memberPaneBind),
    );
    check(
      '被拒的成员 target 没有写进任何 pane',
      runtime.layout().panes.every((row) => row.target?.sessionId !== 'S-member'),
      JSON.stringify(runtime.layout().panes.map((row) => row.target)),
    );

    const bindResult = runtime.bindTarget('pane-1', { kind: 'session', sessionId: 'S-lead' }, 'auto', 'lead session');
    check('pane-1 绑定工作区主会话 S-lead（窗格身份只能为主会话）', bindResult.ok === true, JSON.stringify(bindResult));
    host = renderUntilStable();
    check('绑定的 pane 只出现一次 SessionProvider，且渲染的是主会话 S-lead', providerCalls.length === 1 && providerCalls[0].sessionId === 'S-lead', JSON.stringify(providerCalls.map((row) => row.sessionId)));
    check(
      '当前 pane 的最后一笔 retain 指向 pane-1 的 target',
      paneRetains().length >= 1 && paneRetains()[paneRetains().length - 1].reference.sessionId === runtime.layout().panes.find((row) => row.paneId === 'pane-1').target.sessionId,
      JSON.stringify(paneRetains().map((row) => row.reference.sessionId)),
    );
    check('focus bridge 最多持有 1 个 mainView 引用', bridgeRetains().length <= 1, JSON.stringify(bridgeRetains().map((row) => row.reference.sessionId)));

    // ---- leaf 不可绑定（会话范围收紧的硬约束） ------------------------------
    const leafBind = runtime.bindTarget('pane-3', { kind: 'session', sessionId: 'S-child' }, 'subagent', 'leaf-1');
    check(
      'leaf 会话不可绑定（LEAF_NOT_BINDABLE）',
      leafBind.ok === false && leafBind.code === 'LEAF_NOT_BINDABLE',
      JSON.stringify(leafBind),
    );
    check('被拒的 leaf 没有写进任何 pane', runtime.layout().panes.every((row) => row.target?.sessionId !== 'S-child'), JSON.stringify(runtime.layout().panes.map((row) => row.target)));

    // 一个会话一个 pane 的去重仍然要测：改用工作区主会话 S-lead（现已绑在 pane-1）。
    const dup = runtime.bindTarget('pane-2', { kind: 'session', sessionId: 'S-lead' }, 'auto', 'lead session');
    check('同会话重复绑定被拒绝并聚焦已有 pane（主会话 S-lead）', dup.ok === false && dup.code === 'DUPLICATE_SESSION' && dup.paneId === 'pane-1', JSON.stringify(dup));
    check('activePaneId 停在 pane-1', runtime.layout().activePaneId === 'pane-1');
    check('pane-2 不持有 target', runtime.layout().panes.find((row) => row.paneId === 'pane-2').target === null);

    runtime.bindTarget('pane-2', { kind: 'session', sessionId: 'S-main2' }, 'auto', 'docs-workbench');
    runtime.bindTarget('pane-3', { kind: 'session', sessionId: 'S-task' }, 'auto', 'plain task');
    runtime.setMode(4);
    check('mode 4 已写入', runtime.layout().mode === 4);
    host = renderUntilStable();
    const providerIds = providerCalls.map((row) => row.sessionId).sort();
    check(
      '四窗中三个已绑定窗各一个 provider，全部是工作区主会话（未绑定的 pane-4 不持有 provider）',
      JSON.stringify(providerIds) === JSON.stringify(['S-lead', 'S-main2', 'S-task'])
        && providerIds.every((id) => !isLeaf(id) && !isTeamMember(id)),
      JSON.stringify(providerIds),
    );
    check(
      '三个已绑定 pane 各自 retain 到不同的工作区主会话（成员/leaf 从不是 pane target）',
      new Set(paneRetains().slice(-3).map((row) => row.reference.sessionId)).size === 3
        && paneRetains().slice(-3).every((row) => !isLeaf(row.reference.sessionId) && !isTeamMember(row.reference.sessionId)),
      JSON.stringify(paneRetains().map((row) => row.reference.sessionId)),
    );
    check('retain 来源标签只有两种', retainedRefs.every((row) => row.options.source === 'team-workbench' || row.options.source === 'mainView'));

    // ---- 选择器里不得出现 leaf ---------------------------------------------
    // 展开选择器（否则这两条断言会空过），只看**选择器子树**：
    // 面板确实会通过 props 拿到完整 session 快照，那是数据而不是候选列表。
    runtime.requestPicker('pane-1');
    host = renderUntilStable();
    const pickerElement = host.find((node) => node.props && node.props.className === 'tb-picker');
    check('选择器可以展开（requestPicker）', pickerElement !== undefined);
    const pickerJson = JSON.stringify(pickerElement ?? null);
    const renderedCandidates = [...new Set([...pickerJson.matchAll(/"data-candidate":"([^"]+)"/g)].map((match) => match[1]))].sort();
    check(
      '选择器候选恰好是 3 个工作区主会话（团队成员 S-member 不在内）',
      JSON.stringify(renderedCandidates) === JSON.stringify(['S-lead', 'S-main2', 'S-task']),
      JSON.stringify(renderedCandidates),
    );
    check(
      '选择器里不含 leaf 的 id 或标题，也不含成员 S-member',
      pickerJson.indexOf('S-child') < 0 && pickerJson.indexOf('child leaf') < 0 && pickerJson.indexOf('S-member') < 0,
      { hasLeafId: pickerJson.indexOf('S-child') >= 0, hasLeafTitle: pickerJson.indexOf('child leaf') >= 0, hasMember: pickerJson.indexOf('S-member') >= 0 },
    );
    check('选择器不再有 scope 说明段（小字清理）', pickerJson.indexOf('picker.scope') < 0);
    check('候选行不再带角色药丸 / 「已开在窗格」注记（小字清理）', pickerJson.indexOf('tb-tag') < 0 && pickerJson.indexOf('picker.openedIn') < 0);

    // ---- 搜索：leaf 搜不到、主会话仍能找到（非空过 + 反向对照） --------------
    // mini-React 的 useState 变化会置 needsRender，renderUntilStable() 会重渲染，
    // 因此直接调宿主 input 的受控 onChange 即可，不需要真实输入法/事件通路。
    // 注意：只看 data-candidate 属性，不要全文 indexOf('S-child')——
    // 注入的 props 里带着完整会话列表（含 leaf），全文搜索会假阳性。
    const searchInput = () => host.find((node) => node.type === 'input' && node.props);
    const typeFilter = (value) => {
      const input = searchInput();
      if (!input || typeof input.props.onChange !== 'function') return false;
      input.props.onChange({ target: { value } });
      host = renderUntilStable();
      return true;
    };
    check('选择器有受控搜索输入', searchInput() !== undefined && typeof searchInput().props.onChange === 'function');

    const typedLeafId = typeFilter('S-child');
    const afterLeafId = JSON.stringify(host);
    check('搜索输入可用（受控 onChange 触发重渲染）', typedLeafId === true);
    check('搜索 leaf id 搜不到任何候选行', afterLeafId.indexOf('data-candidate') < 0);
    check('搜索 leaf id 显示空态 picker.empty', afterLeafId.indexOf('picker.empty') >= 0);

    const typedLeafTitle = typeFilter('child leaf');
    const afterLeafTitle = JSON.stringify(host);
    check(
      '搜索 leaf 标题同样搜不到（leaf 不参与搜索）',
      typedLeafTitle === true && afterLeafTitle.indexOf('data-candidate') < 0 && afterLeafTitle.indexOf('picker.empty') >= 0,
      { matchesAnyRow: afterLeafTitle.indexOf('data-candidate') >= 0 },
    );

    // 反向对照：防"搜索永远为空"的假通过。
    const typedMain = typeFilter('docs-workbench');
    const afterMain = JSON.stringify(host);
    check(
      '搜索主会话仍能找到该候选行（反向对照）',
      typedMain === true && afterMain.indexOf('"data-candidate":"S-main2"') >= 0,
      { hasMain2Row: afterMain.indexOf('"data-candidate":"S-main2"') >= 0 },
    );
    typeFilter(''); // 复位过滤器，避免影响后续渲染断言

    const pickerRows = host.filter((node) => node.props && node.props['data-candidate'] !== undefined);
    const candidateAttrs = pickerRows.map((node) => String(node.props['data-candidate']));
    check(
      '渲染出的候选行都是工作区主会话（非 leaf、非团队成员）',
      candidateAttrs.every((id) => !isLeaf(id) && !isTeamMember(id)),
      { candidateAttrs: [...new Set(candidateAttrs)] },
    );
    check(
      'leaf 的 id 从不作为可绑定目标出现',
      runtime.layout().panes.every((row) => row.target?.sessionId !== 'S-child'),
      JSON.stringify(runtime.layout().panes.map((row) => row.target?.sessionId ?? null)),
    );

    const contentCall = factoryCalls.find((row) => row.name === 'conversation.content');
    check('conversation.content 经 renderFactorySlot 渲染', contentCall !== undefined);
    check('content 入参含 variant/phase/hero', contentCall !== undefined && typeof contentCall.inputProps.variant === 'string' && typeof contentCall.inputProps.phase === 'string' && typeof contentCall.inputProps.hero === 'boolean', JSON.stringify(contentCall?.inputProps));
    check('四窗使用 embedded variant', contentCall !== undefined && contentCall.inputProps.variant === 'embedded', contentCall?.inputProps?.variant);
    check('提供本地 slots.views 工厂', typeof contentCall?.options?.slots?.views === 'function');
    check('pane 视图渲染 conversation.session', viewSlotCalls.some((row) => row.key === 'conversation.session'), JSON.stringify(viewSlotCalls.map((row) => row.key)));

    // ---- SURFACE v2：窗头恰好一行 + 小字清理 --------------------------------
    // 用户要求清除「太多小字」：底部状态栏 / 左侧团队树 / 窗头第二三行 / 选择器说明段 /
    // 角色药丸全部删除。这里同时锁死「删掉了什么」和「窗头只剩什么」。
    const renderedClassNames = host
      .map((node) => (node.props && typeof node.props.className === 'string' ? node.props.className : ''))
      .filter((value) => value !== '');
    const classNameParts = renderedClassNames.flatMap((value) => value.split(/\s+/));
    const hasClassPrefix = (...prefixes) => classNameParts.some((part) => prefixes.some((prefix) => part.startsWith(prefix)));
    const headNodes = host.filter((node) => node.props && node.props.className === 'tb-pane-head');
    const headRowNodes = host.filter((node) => node.props && node.props.className === 'tb-pane-row tb-pane-row-title');
    const html = JSON.stringify(host);
    check(
      '窗头恰好一行：每个 pane 头恰好一个 tb-pane-row-title 行（没有第二/三行）',
      headNodes.length === 4 && headRowNodes.length === headNodes.length,
      { heads: headNodes.length, titleRows: headRowNodes.length },
    );
    check(
      '小字清理：窗头没有 tb-pane-task / tb-pane-meta / tb-pane-wait / tb-pane-row-gap / tb-row-sub',
      !hasClassPrefix('tb-pane-task', 'tb-pane-meta', 'tb-pane-wait', 'tb-pane-row-gap', 'tb-row-sub'),
      classNameParts.filter((part) => part.startsWith('tb-pane-task') || part.startsWith('tb-pane-meta') || part.startsWith('tb-pane-wait') || part.startsWith('tb-pane-row-gap') || part.startsWith('tb-row-sub')),
    );
    check(
      '小字清理：没有底部状态栏（tb-status*）与左侧团队树（tb-team* / tb-node*）',
      !hasClassPrefix('tb-status', 'tb-team', 'tb-node'),
      classNameParts.filter((part) => part.startsWith('tb-status') || part.startsWith('tb-team') || part.startsWith('tb-node')),
    );
    check(
      '小字清理：team.* / status.* / compat.* 文案、项目/未读字段不再渲染',
      ['team.title', 'status.host', 'status.compat', 'compat.engaged', 'field.project', 'flag.unread'].every((key) => html.indexOf(key) < 0),
      { hits: ['team.title', 'status.host', 'status.compat', 'compat.engaged', 'field.project', 'flag.unread'].filter((key) => html.indexOf(key) >= 0) },
    );
    const childrenButtons = host.filter((node) => node.props && node.props.title === 'pane.children');
    check(
      '已绑窗头出现「子会话 N」按钮（只有拥有子会话的 S-lead 窗有；成员不在候选里）',
      childrenButtons.length === 1 && JSON.stringify(childrenButtons[0].props).indexOf('pane.childrenCount') >= 0,
      { buttons: childrenButtons.length, props: childrenButtons[0]?.props ?? null },
    );

    // ---- 选择器 = 「dsh 主页面会话列表」的缩影（surface v2 用户要求）------------
    // 分组按真实 Workspace（`workspaces.list.items`），散会话进「未分组」；会话行右侧是
    // 紧凑相对时间；当前窗格的会话高亮；**没有关闭 ×**（用户明确说 × 没用）——
    // 关闭方式 = 点击空白处 / 搜索框 Esc / 再点同一「切换」按钮 / 选中一行。
    const pickerPanel = host.find((node) => node.props && node.props.className === 'tb-picker');
    check('选择器面板存在（dialog）', pickerPanel !== undefined && pickerPanel.props.role === 'dialog');
    const groupHeaders = host.filter((node) => node.props && typeof node.props['data-group'] === 'string');
    check(
      '选择器按工作区分组：dsh 分组 + 未分组（模仿 dsh 主页面会话列表）',
      groupHeaders.length === 2
        && groupHeaders.some((node) => node.props['data-group'] === 'ws:ws-dsh')
        && groupHeaders.some((node) => node.props['data-group'] === 'ungrouped'),
      groupHeaders.map((node) => node.props['data-group']),
    );
    const groupTitles = groupHeaders.map((node) => String(node.props.title ?? ''));
    check(
      '分组头标题来自真实 Workspace / 本地化「未分组」（不编造）',
      groupTitles.indexOf('dsh') >= 0 && groupTitles.indexOf('picker.ungrouped') >= 0,
      groupTitles,
    );
    const wsRows = host.filter((node) => node.props && typeof node.props['data-candidate'] === 'string');
    check(
      '会话行顺序 = 分组顺序 + 组内按最近更新（S-lead → S-task → 未分组 S-main2）',
      JSON.stringify(wsRows.map((node) => node.props['data-candidate'])) === JSON.stringify(['S-lead', 'S-task', 'S-main2']),
      wsRows.map((node) => node.props['data-candidate']),
    );
    check(
      '会话行右侧显示紧凑相对时间（picker.time.*，与 dsh 列表一致）',
      JSON.stringify(wsRows.map((node) => node.props)).indexOf('picker.time.') >= 0,
      wsRows.map((node) => node.props['data-candidate']),
    );
    const currentRows = wsRows.filter((node) => node.props['data-current'] === 'true');
    check(
      '当前窗格已绑的会话被高亮（data-current=true 且恰好一行）',
      currentRows.length === 1 && currentRows[0].props['data-candidate'] === 'S-lead',
      wsRows.map((node) => [node.props['data-candidate'], node.props['data-current']]),
    );
    // 折叠：点分组头后该组会话行消失，其它组不受影响；再点恢复。
    const dshHeader = groupHeaders.find((node) => node.props['data-group'] === 'ws:ws-dsh');
    dshHeader.props.onClick();
    const collapsedHost = renderUntilStable();
    const collapsedCandidates = collapsedHost.filter((node) => node.props && typeof node.props['data-candidate'] === 'string').map((node) => node.props['data-candidate']);
    check(
      '点击分组头可折叠该组（dsh 组会话行消失，未分组仍可见）',
      JSON.stringify(collapsedCandidates) === JSON.stringify(['S-main2']),
      collapsedCandidates,
    );
    const dshHeaderExpanded = collapsedHost.find((node) => node.props && node.props['data-group'] === 'ws:ws-dsh');
    dshHeaderExpanded.props.onClick();
    host = renderUntilStable();
    check(
      '再次点击分组头恢复展开',
      JSON.stringify(host.filter((node) => node.props && typeof node.props['data-candidate'] === 'string').map((node) => node.props['data-candidate'])) === JSON.stringify(['S-lead', 'S-task', 'S-main2']),
    );
    // 没有 ×：关闭只能靠空白处 / Esc / 再点「切换」。
    // 注意：flat host 里还有**通知条**的 ×（不属于选择器），所以这里只检查选择器自身子树。
    const pickerNow = host.find((node) => node.props && node.props.className === 'tb-picker');
    check('选择器里没有关闭 × 按钮（用户要求去掉；头部只剩标题）', pickerNow !== undefined && JSON.stringify(pickerNow).indexOf('×') < 0, pickerNow === undefined ? 'picker missing' : 'picker contains ×');
    const backdrop = host.find((node) => node.props && typeof node.props['data-picker-backdrop'] === 'string');
    check('关闭方式：存在点击空白处的 backdrop', backdrop !== undefined);
    backdrop.props.onClick();
    host = renderUntilStable();
    check(
      '点击空白处后选择器关闭（无 tb-picker 面板、无候选行）',
      host.every((node) => !(node.props && (node.props.className === 'tb-picker' || typeof node.props['data-candidate'] === 'string'))),
    );
    // Esc 关闭：重新打开 → 搜索框 Esc。
    runtime.requestPicker('pane-1');
    host = renderUntilStable();
    const filterInput = host.find((node) => node.type === 'input' && node.props && node.props['aria-label'] === 'picker.search');
    check('搜索框可 Esc 关闭选择器（onKeyDown 已接）', filterInput !== undefined && typeof filterInput.props.onKeyDown === 'function');
    filterInput.props.onKeyDown({ key: 'Escape' });
    host = renderUntilStable();
    check(
      'Esc 后选择器关闭',
      host.every((node) => !(node.props && (node.props.className === 'tb-picker' || typeof node.props['data-candidate'] === 'string'))),
    );

    // ---- 二级视图（surface v2 正向证据）-------------------------------------
    // 成员/子智能体不是窗格身份：只能从窗格自己的「子会话」进入，窗头变成
    // `[‹ 返回] ● <子标题>`，窗格 target 保持不变。
    let childViewEvidence = null;
    {
      const childIds = runtime.childrenOf('S-lead').map((child) => child.id).sort();
      check(
        '二级视图：S-lead 的子会话来源 = subagentCatalog ∪ agentTeam.members',
        JSON.stringify(childIds) === JSON.stringify(['S-child', 'S-member']),
        JSON.stringify(childIds),
      );
      const ghostOpen = runtime.openChild('pane-1', 'S-ghost');
      check(
        '二级视图：openChild 拒绝不属于该父会话的伪造子会话（CHILD_NOT_KNOWN）',
        ghostOpen.ok === false && ghostOpen.code === 'CHILD_NOT_KNOWN',
        JSON.stringify(ghostOpen),
      );

      const retainsBeforeOpen = retainedRefs.length;
      const releasesBeforeOpen = releasedIds.length;
      const opened = runtime.openChild('pane-1', 'S-member');
      check('二级视图：openChild(pane-1, S-member) 成功', opened.ok === true && opened.paneId === 'pane-1' && opened.childSessionId === 'S-member', JSON.stringify(opened));
      host = renderUntilStable();
      const paneOneView = runtime.layout().panes.find((row) => row.paneId === 'pane-1');
      check(
        '二级视图：pane.view.childSessionId === S-member（父会话是 S-lead）',
        paneOneView?.view !== null && paneOneView?.view?.parentSessionId === 'S-lead' && paneOneView?.view?.childSessionId === 'S-member',
        JSON.stringify(paneOneView?.view),
      );
      check(
        '二级视图：窗格身份没有变，pane.target 仍是工作区主会话 S-lead',
        paneOneView?.target?.kind === 'session' && paneOneView?.target?.sessionId === 'S-lead',
        JSON.stringify(paneOneView?.target),
      );
      check(
        '二级视图：pane-1 的 SessionProvider 渲染子会话 S-member（provider sessionId 变化）',
        providerCalls.length === 3 && providerCalls[0].sessionId === 'S-member',
        JSON.stringify(providerCalls.map((row) => row.sessionId)),
      );
      const childRetains = retainedRefs.slice(retainsBeforeOpen).filter((row) => row.reference.sessionId === 'S-member');
      check(
        '二级视图：retainPane 在 view 存在时 retain 子会话地址（不是把成员当 pane target）',
        childRetains.length === 1
          && childRetains[0].target !== null
          && typeof childRetains[0].target === 'object'
          && childRetains[0].target.parentSessionId === 'S-lead'
          && childRetains[0].target.childSessionId === 'S-member'
          && retainedRefs.every((row) => row.target !== 'S-member'),
        JSON.stringify(childRetains.map((row) => row.target)),
      );
      check('二级视图：diagnostics.childRetains 记录了一次子会话 retain', runtime.diagnostics.childRetains === 1, runtime.diagnostics.childRetains);
      check(
        '二级视图：子会话引用替换了主会话引用（旧的 S-lead 引用被显式 release）',
        releasedIds.length > releasesBeforeOpen && releasedIds.lastIndexOf('S-lead') >= 0,
        { released: releasedIds.slice(releasesBeforeOpen) },
      );

      const renderedAfterOpen = JSON.stringify(host);
      check(
        '二级视图：窗头出现「返回」且不再显示「子会话」按钮',
        renderedAfterOpen.indexOf('action.back') >= 0 && renderedAfterOpen.indexOf('pane.children') < 0,
        { hasBack: renderedAfterOpen.indexOf('action.back') >= 0, hasChildrenMenu: renderedAfterOpen.indexOf('pane.children') >= 0 },
      );
      check('二级视图：窗头渲染的是子会话标题（combat-system）', renderedAfterOpen.indexOf('combat-system') >= 0);
      const memberBlock = host.find((node) => node.props && node.props['data-member'] === 'S-member');
      check(
        '二级视图：成员常驻一行 member.summary + 「详情」（不再有药丸行/两条 label: value）',
        memberBlock !== undefined
          && renderedAfterOpen.indexOf('member.summary') >= 0
          && renderedAfterOpen.indexOf('member.detail') >= 0
          && renderedAfterOpen.indexOf('tb-member-pill') < 0,
        { hasMemberBlock: memberBlock !== undefined },
      );

      // 兼容聚焦桥：只接受「本窗正在显示的子会话地址」，裸成员会话仍被拒。
      runtime.noteActiveTarget({ kind: 'subagent', parentSessionId: 'S-lead', childSessionId: 'S-member', mode: 'continuable' });
      await Promise.resolve();
      await Promise.resolve();
      const bridgeChild = bridgeService.getSnapshot();
      check(
        '二级视图：焦点桥接受本窗正在显示的子会话地址（isKnownChildTarget）',
        bridgeChild.activeSessionId === 'S-member' && bridgeChild.activeTargetKind === 'subagent',
        { sessionId: bridgeChild.activeSessionId, kind: bridgeChild.activeTargetKind },
      );
      runtime.noteActiveTarget({ kind: 'session', sessionId: 'S-member' });
      await Promise.resolve();
      await Promise.resolve();
      const bridgeMember = bridgeService.getSnapshot();
      check(
        '二级视图：裸成员会话仍不能当焦点/窗格目标（桥不接受）',
        bridgeMember.activeSessionId === undefined,
        { sessionId: bridgeMember.activeSessionId, kind: bridgeMember.activeTargetKind },
      );

      // retainChild 闸：伪造子会话必须抛 CHILD_NOT_KNOWN，且从不调用 ctx.sessions.retain。
      const rejectedBeforeChild = runtime.diagnostics.rejectedRetains ?? 0;
      const retainCallsBeforeChild = retainedRefs.length;
      let ghostError;
      try {
        runtime.retainChild({ parentSessionId: 'S-lead', childSessionId: 'S-ghost' }, new AbortController().signal);
      } catch (error) {
        ghostError = error;
      }
      check(
        '二级视图闸：retainChild(伪造子会话) 抛 CHILD_NOT_KNOWN',
        ghostError !== undefined && ghostError.code === 'CHILD_NOT_KNOWN',
        ghostError === undefined ? 'no throw' : { code: ghostError.code, message: ghostError.message },
      );
      check('二级视图闸：伪造子会话从未调用 ctx.sessions.retain', retainedRefs.length === retainCallsBeforeChild, { before: retainCallsBeforeChild, after: retainedRefs.length });
      check(
        '二级视图闸：rejectedRetains 计数 +1',
        (runtime.diagnostics.rejectedRetains ?? 0) === rejectedBeforeChild + 1,
        { before: rejectedBeforeChild, after: runtime.diagnostics.rejectedRetains },
      );
      childViewEvidence = {
        paneId: 'pane-1',
        target: paneOneView?.target?.sessionId ?? null,
        childSessionId: paneOneView?.view?.childSessionId ?? null,
        providerSessionId: providerCalls[0]?.sessionId ?? null,
      };

      runtime.closeChild('pane-1');
      host = renderUntilStable();
      const paneOneClosed = runtime.layout().panes.find((row) => row.paneId === 'pane-1');
      check(
        '二级视图：closeChild 后 pane.view === null 且 target 仍是 S-lead',
        paneOneClosed?.view === null && paneOneClosed?.target?.sessionId === 'S-lead',
        JSON.stringify(paneOneClosed),
      );
      check(
        '二级视图：closeChild 后 pane-1 的 provider 回到主会话 S-lead',
        providerCalls.length === 3 && providerCalls[0].sessionId === 'S-lead',
        JSON.stringify(providerCalls.map((row) => row.sessionId)),
      );
      check(
        '二级视图：closeChild 后「返回」消失、重新出现「子会话 N」按钮',
        JSON.stringify(host).indexOf('action.back') < 0 && JSON.stringify(host).indexOf('pane.childrenCount') >= 0,
      );
    }

    // ---- 迁移（surface v2）：旧「成员窗格」→ team 根会话 + 二级视图 ----------
    // 历史持久化/宿主记录里窗格可能绑的是团队成员。v2 不清空，而是迁移成
    // 「该成员的 team 根工作区会话 + 该成员作为二级视图」，用户布局含义不丢失。
    {
      runtime.setMode(1);
      host = renderUntilStable();
      const persistedStore = mainReg.options.store.create();
      const bindPersistedMember = persistedStore.actions?.bindPane;
      check('迁移：持久化 store 可写入成员 target（模拟 v1 遗留记录）', typeof bindPersistedMember === 'function');
      if (typeof bindPersistedMember === 'function') {
        bindPersistedMember('pane-3', { kind: 'session', sessionId: 'S-member' }, 'member', 'combat-system');
      }
      const paneThreeBefore = runtime.layout().panes.find((row) => row.paneId === 'pane-3');
      check(
        '迁移前：pane-3 的 target 是团队成员 S-member（不是工作区主会话）',
        paneThreeBefore?.target?.sessionId === 'S-member',
        JSON.stringify(paneThreeBefore?.target),
      );
      const retainsBeforeMigration = retainedRefs.length;
      const migrated = runtime.migratePaneIfMember('pane-3');
      const paneThreeAfter = runtime.layout().panes.find((row) => row.paneId === 'pane-3');
      check('迁移：migratePaneIfMember 返回 true', migrated === true, migrated);
      check(
        '迁移：target 变为该成员的 team 根会话 S-lead（不是清空）',
        paneThreeAfter?.target !== null && paneThreeAfter?.target?.kind === 'session' && paneThreeAfter?.target?.sessionId === 'S-lead',
        JSON.stringify(paneThreeAfter?.target),
      );
      check(
        '迁移：view 打开该成员（parent S-lead / child S-member / mode continuable）',
        paneThreeAfter?.view !== null
          && paneThreeAfter?.view?.parentSessionId === 'S-lead'
          && paneThreeAfter?.view?.childSessionId === 'S-member'
          && paneThreeAfter?.view?.mode === 'continuable',
        JSON.stringify(paneThreeAfter?.view),
      );
      check(
        '迁移：pane-3 没有被清空（target 与 view 都在）',
        paneThreeAfter?.target !== null && paneThreeAfter?.view !== null,
        JSON.stringify(paneThreeAfter),
      );
      check(
        '迁移：从未把成员会话当 pane target retain（S-member 不以裸会话 id 进入 retain）',
        retainedRefs.every((row) => row.target !== 'S-member'),
        JSON.stringify([...new Set(retainedRefs.map((row) => row.target))]),
      );
      check(
        '迁移：迁移本身不产生任何 retain（retain 数不变）',
        retainedRefs.length === retainsBeforeMigration,
        { before: retainsBeforeMigration, after: retainedRefs.length },
      );
      check('迁移：diagnostics.migratedMemberPanes === 1', runtime.diagnostics.migratedMemberPanes === 1, runtime.diagnostics.migratedMemberPanes);

      runtime.setMode(4);
      host = renderUntilStable();
      const paneThreeRendered = runtime.layout().panes.find((row) => row.paneId === 'pane-3');
      check(
        '迁移：切到 4 窗后 pane-3 渲染 S-member 子会话，target 仍是 S-lead',
        paneThreeRendered?.target?.sessionId === 'S-lead'
          && providerCalls.some((row) => row.sessionId === 'S-member')
          && (runtime.diagnostics.childRetains ?? 0) >= 2,
        { target: paneThreeRendered?.target, providers: providerCalls.map((row) => row.sessionId), childRetains: runtime.diagnostics.childRetains },
      );
    }

    runtime.setMode(1);
    host = renderUntilStable();
    const contentCall1 = factoryCalls.find((row) => row.name === 'conversation.content');
    check('单窗回到 main variant', contentCall1 !== undefined && contentCall1.inputProps.variant === 'main', contentCall1?.inputProps?.variant);
    check('隐藏 pane 在本轮渲染里不持有 provider', providerCalls.length === 1 && providerCalls[0].sessionId === 'S-lead', JSON.stringify(providerCalls.map((row) => row.sessionId)));

    // ---- 客户端是拒绝子智能体的最后一道闸 -----------------------------------
    // Host 的 `team_layout` bind-pane 仍可写入 subagent 地址，因此客户端在
    // retain / adopt 两层各补一道闸。下面四组断言按这四层核对。
    const clearPane = (paneId) => {
      // runtime.removePane 已在批次 B 删除（host client 的 remove-pane 同理），
      // 因此这里只保留"清空绑定"这一条可用路径，不留死分支。
      if (typeof runtime.clearPane === 'function') return runtime.clearPane(paneId);
      return runtime.bindTarget(paneId, null, 'auto', '');
    };

    // (1) retain 直拒：leaf 连 ctx.sessions.retain 都不该被调用
    {
      const retainCallsBefore = retainedRefs.length;
      const rejectedBefore = runtime.diagnostics?.rejectedRetains ?? 0;
      let retainError;
      try {
        runtime.retain({ kind: 'session', sessionId: 'S-child' }, new AbortController().signal);
      } catch (error) {
        retainError = error;
      }
      check('retain(leaf) 抛 LEAF_NOT_BINDABLE', retainError !== undefined && retainError.code === 'LEAF_NOT_BINDABLE', retainError === undefined ? 'no throw' : retainError.message);
      check('retain(leaf) 从未调用 ctx.sessions.retain', retainedRefs.length === retainCallsBefore, { before: retainCallsBefore, after: retainedRefs.length });
      check(
        'diagnostics.rejectedRetains 计数 +1',
        (runtime.diagnostics?.rejectedRetains ?? 0) === rejectedBefore + 1,
        { before: rejectedBefore, after: runtime.diagnostics?.rejectedRetains },
      );
      check(
        'retainedRefs 中不含任何 leaf id',
        retainedRefs.every((row) => row.reference.sessionId !== 'S-child' && !isLeaf(row.reference.sessionId)),
        JSON.stringify([...new Set(retainedRefs.map((row) => row.reference.sessionId))]),
      );
    }

    // (2) Host layout 带 leaf：合并时丢弃、pane 保持空、Host 记录被纠正、组件不崩
    {
      for (const paneId of ['pane-1', 'pane-2', 'pane-3', 'pane-4']) clearPane(paneId);
      host = renderUntilStable();
      const retainsBeforeHost = retainedRefs.length;
      const droppedBefore = (runtime.diagnostics?.droppedHostTargets ?? []).length;
      const hostCallMark = hostCalls.length;
      hostStateResponse = {
        ok: true,
        version: 1,
        basePath: '/plugin/team-workbench',
        compat: { rightBarFocusBridge: true, rightBarFocusBridgeMinVersion: '0.2.0-rc.2' },
        snapshot: {
          layout: {
            mode: 1,
            activePaneId: 'pane-1',
            panes: [
              { paneId: 'pane-1', target: { parentSessionId: 'S-member', childSessionId: 'S-child', mode: 'continuable' }, role: 'subagent', label: 'leaf-1' },
              { paneId: 'pane-2', target: null, role: 'auto', label: '' },
              { paneId: 'pane-3', target: null, role: 'auto', label: '' },
              { paneId: 'pane-4', target: null, role: 'auto', label: '' },
            ],
          },
        },
      };
      await runtime.refreshHost();
      await Promise.resolve();
      await Promise.resolve();
      host = renderUntilStable();

      const paneOne = runtime.layout().panes.find((pane) => pane.paneId === 'pane-1');
      check('Host 里的 leaf target 被丢弃：pane-1 保持未绑定', paneOne?.target === null && (paneOne?.label ?? '') === '', JSON.stringify(paneOne));
      check('Host 的 leaf target 从未到达 ctx.sessions.retain', retainedRefs.length === retainsBeforeHost, { before: retainsBeforeHost, after: retainedRefs.length });
      check(
        'diagnostics.droppedHostTargets 记录了一条',
        (runtime.diagnostics?.droppedHostTargets ?? []).length === droppedBefore + 1,
        { before: droppedBefore, after: (runtime.diagnostics?.droppedHostTargets ?? []).length },
      );
      const corrections = hostCalls
        .slice(hostCallMark)
        .filter((call) => call.method === 'POST' && call.body && call.body.op === 'upsert-pane' && call.body.pane?.paneId === 'pane-1');
      check(
        'Host 记录被纠正：POST /layout upsert-pane target null',
        corrections.length >= 1 && corrections[0].body.pane.target === null,
        JSON.stringify(corrections.map((call) => call.body)),
      );
      const strippedHtml = JSON.stringify(host);
      check(
        'pane-1 渲染未绑定分支（notice.leafRejected 或 pane.unassigned）',
        strippedHtml.indexOf('notice.leafRejected') >= 0 || strippedHtml.indexOf('pane.unassigned') >= 0,
        { hasNotice: strippedHtml.indexOf('notice.leafRejected') >= 0, hasUnassigned: strippedHtml.indexOf('pane.unassigned') >= 0 },
      );
      check('剥离 leaf 过程中没有 RENDER/EFFECT THROW', internalFailures.length === 0, internalFailures.slice(0, 2));
    }

    // (3) 旧持久化里的 leaf：主动清理 + 纠正 Host
    {
      const persistedStore = mainReg.options.store.create();
      const bindPersisted = persistedStore.actions?.bindPane;
      if (typeof bindPersisted === 'function') {
        bindPersisted('pane-4', { kind: 'session', sessionId: 'S-child' }, 'subagent', 'leaf-1');
      }
      const strippedBefore = (runtime.diagnostics?.strippedLeafTargets ?? []).length;
      const retainsBeforeSweep = retainedRefs.length;
      const sweepMark = hostCalls.length;
      const strippedCount = runtime.reconcileStoredTargets?.();
      host = renderUntilStable();
      const paneFour = runtime.layout().panes.find((pane) => pane.paneId === 'pane-4');
      check(
        '持久化里的 leaf target 被清空',
        typeof bindPersisted !== 'function' || (strippedCount >= 1 && paneFour?.target === null && (paneFour?.label ?? '') === ''),
        { strippedCount, paneFour, bindAvailable: typeof bindPersisted === 'function' },
      );
      check('清理持久化 leaf 不会 retain 任何引用', retainedRefs.length === retainsBeforeSweep, { before: retainsBeforeSweep, after: retainedRefs.length });
      check(
        'diagnostics.strippedLeafTargets 记录了一条',
        (runtime.diagnostics?.strippedLeafTargets ?? []).length === strippedBefore + 1,
        { before: strippedBefore, after: (runtime.diagnostics?.strippedLeafTargets ?? []).length },
      );
      const sweepCorrections = hostCalls
        .slice(sweepMark)
        .filter((call) => call.method === 'POST' && call.body?.op === 'upsert-pane' && call.body.pane?.paneId === 'pane-4' && call.body.pane.target === null);
      check('持久化 leaf 也被同步纠正到 Host', typeof bindPersisted !== 'function' || sweepCorrections.length >= 1, JSON.stringify(sweepCorrections.map((call) => call.body)));
    }

    // (4) 身份模型不回归：Host 给 4 个 pane、本地 mode=1 → 只填空 pane
    {
      hostStateResponse = {
        ok: true,
        version: 1,
        basePath: '/plugin/team-workbench',
        snapshot: {
          layout: {
            mode: 1,
            activePaneId: 'pane-1',
            panes: [
              { paneId: 'pane-1', target: { kind: 'session', sessionId: 'S-member' }, role: 'member', label: 'combat-system' },
              { paneId: 'pane-2', target: { kind: 'session', sessionId: 'S-lead' }, role: 'lead', label: 'lead' },
              { paneId: 'pane-3', target: null, role: 'auto', label: '' },
              { paneId: 'pane-4', target: null, role: 'auto', label: '' },
            ],
          },
        },
      };
      await runtime.refreshHost();
      await Promise.resolve();
      await Promise.resolve();
      host = renderUntilStable();
      const layout = runtime.layout();
      check('adoptHostLayout 保留 4 个 pane 身份', layout.panes.length === 4, layout.panes.map((pane) => pane.paneId));
      check('本地 mode 仍是 1（Host 不改变本地布局模式）', layout.mode === 1, layout.mode);
      const paneTwo = layout.panes.find((pane) => pane.paneId === 'pane-2');
      check(
        '不可见 pane-2 的绑定没有被清掉',
        paneTwo?.target?.sessionId === 'S-lead',
        JSON.stringify(paneTwo),
      );
      check('hostStateResponse 已复位（不影响后续渲染）', (hostStateResponse = null) === null);
    }

    // ================= A 组：正面证据才可绑（fail-closed） =================
    // A1（最终策略）：
    //   · **用户面 `bindTarget` 一律拒绝无正面证据的目标** → `{ok:false, code:'TARGET_NOT_LOADED'}`
    //     （leaf 仍是 `LEAF_NOT_BINDABLE`），`notBindableCount` +1，绝不 retain。
    //   · `unknown` 的"保留待重判"**只走 host/持久化合并路径**：`runtime.adoptHostLayout(layout)`
    //     只丢弃**已被证明的 leaf**，`unknown` 保留在 store → 渲染 pending 分支 →
    //     行/投影到达后自动恢复（`recoveredAfterList` +1、恰好 retain 一次、渲染 SessionProvider）。
    //   ⚠️ 两个坑（web-workbench 实测）：`adoptHostLayout` **只填空白 pane**（必须先 clearPane）；
    //      且 `mode` 必须**覆盖该 pane**（用 `mode:4`），否则隐藏 pane 不渲染、引用会被释放。
    {
      // (i) 用户面 bindTarget：unknown（证据不足）→ 直接拒绝
      const lateBind = runtime.bindTarget('pane-2', { kind: 'session', sessionId: 'S-late' }, 'auto', 'late session');
      check('A1：用户面 bindTarget 拒绝 unknown 目标（TARGET_NOT_LOADED）', lateBind.ok === false && lateBind.code === 'TARGET_NOT_LOADED', JSON.stringify(lateBind));
      host = renderUntilStable();
      const retainsBeforeLate = retainedRefs.length;
      check(
        'A1：unknown 目标绝不调用 ctx.sessions.retain',
        retainedRefs.every((row) => row.reference.sessionId !== 'S-late') && retainedRefs.length === retainsBeforeLate,
        JSON.stringify([...new Set(retainedRefs.map((row) => row.reference.sessionId))]),
      );
      check('A1：notBindableCount 计数 +1', (runtime.diagnostics?.notBindableCount ?? 0) >= 1, runtime.diagnostics?.notBindableCount);
      check('A1：拦 unknown 时无 RENDER/EFFECT THROW', internalFailures.length === 0, internalFailures.slice(0, 2));

      // (ii) 恢复链走 host 合并路径：adoptHostLayout 保留 unknown，行到达后自动恢复
      const recoveredBefore = runtime.diagnostics?.recoveredAfterList ?? 0;
      runtime.clearPane('pane-2');
      runtime.adoptHostLayout({ mode: 4, panes: [{ paneId: 'pane-2', target: { kind: 'session', sessionId: 'S-late' } }] });
      host = renderUntilStable();
      const paneTwoPending = runtime.layout().panes.find((pane) => pane.paneId === 'pane-2');
      check('A1：host 合并路径把 unknown 保留在 store（target !== null）', paneTwoPending?.target !== null, JSON.stringify(paneTwoPending));
      check(
        'A1：保留的 unknown 不 retain 且渲染 pending 分支',
        retainedRefs.every((row) => row.reference.sessionId !== 'S-late')
          && (JSON.stringify(host).indexOf('notice.targetNotLoaded') >= 0 || JSON.stringify(host).indexOf('pane.unassigned') >= 0),
        { retains: [...new Set(retainedRefs.map((row) => row.reference.sessionId))], html: JSON.stringify(host).slice(0, 160) },
      );
      listSnapshot.ids.push('S-late');
      listSnapshot.byId['S-late'] = { id: 'S-late', displayTitle: 'late session', running: false, blank: true, updatedAt: Date.now(), cwd: 'D:\\proj', retainedBy: { mainView: 0 } };
      host = renderUntilStable();
      check(
        'A1：证据到达后自动恢复（recoveredAfterList +1）',
        (runtime.diagnostics?.recoveredAfterList ?? 0) === recoveredBefore + 1,
        { before: recoveredBefore, after: runtime.diagnostics?.recoveredAfterList },
      );
      const lateRetains = retainedRefs.filter((row) => row.reference.sessionId === 'S-late');
      check(
        'A1：恢复后恰好 retain 一次并渲染 SessionProvider',
        lateRetains.length === 1 && providerCalls.some((row) => row.sessionId === 'S-late'),
        { retains: lateRetains.length, providers: providerCalls.map((row) => row.sessionId) },
      );

      // (iii) 晚到的 leaf：用户面先拒绝；host 合并保留后被证据证明是 leaf → 清空 + 纠正 Host
      const lateLeafBind = runtime.bindTarget('pane-3', { kind: 'session', sessionId: 'S-lateleaf' }, 'auto', 'late leaf');
      check('A1：用户面 bindTarget 同样拒绝尚未知的 S-lateleaf', lateLeafBind.ok === false && lateLeafBind.code === 'TARGET_NOT_LOADED', JSON.stringify(lateLeafBind));
      runtime.clearPane('pane-3');
      runtime.adoptHostLayout({ mode: 4, panes: [{ paneId: 'pane-3', target: { kind: 'session', sessionId: 'S-lateleaf' } }] });
      host = renderUntilStable();
      const strippedBeforeLateLeaf = (runtime.diagnostics?.strippedLeafTargets ?? []).length;
      const hostMarkA1 = hostCalls.length;
      listSnapshot.ids.push('S-lateleaf');
      listSnapshot.byId['S-lateleaf'] = { id: 'S-lateleaf', displayTitle: 'late leaf', running: true, blank: false, updatedAt: Date.now(), cwd: 'D:\\proj', parentId: 'S-lead', origin: 'subagent', retainedBy: { mainView: 0 } };
      host = renderUntilStable();
      const paneThree = runtime.layout().panes.find((pane) => pane.paneId === 'pane-3');
      check('A1：被证明是 leaf 后从 store 清空', paneThree?.target === null, JSON.stringify(paneThree));
      check(
        'A1：被证明是 leaf 的目标从未被 retain',
        retainedRefs.every((row) => row.reference.sessionId !== 'S-lateleaf'),
        JSON.stringify([...new Set(retainedRefs.map((row) => row.reference.sessionId))]),
      );
      check(
        'A1：strippedLeafTargets 记录了这次清空',
        (runtime.diagnostics?.strippedLeafTargets ?? []).length === strippedBeforeLateLeaf + 1,
        { before: strippedBeforeLateLeaf, after: (runtime.diagnostics?.strippedLeafTargets ?? []).length },
      );
      check(
        'A1：清空时同步纠正 Host（upsert-pane target null）',
        hostCalls.slice(hostMarkA1).some((call) => call.method === 'POST' && call.body?.op === 'upsert-pane' && call.body.pane?.paneId === 'pane-3' && call.body.pane.target === null),
        JSON.stringify(hostCalls.slice(hostMarkA1).map((call) => call.body)),
      );

      // (iv) 护栏：live-binding 工作区主会话必须始终可绑；团队成员（v2）不得成为窗格 target。
      const memberBind = runtime.bindTarget('pane-1', { kind: 'session', sessionId: 'S-member' }, 'member', 'combat-system');
      check(
        'A1 护栏：团队成员不是窗格身份（MEMBER_NOT_A_PANE），且从不以裸会话 id retain',
        memberBind.ok === false
          && memberBind.code === 'MEMBER_NOT_A_PANE'
          && retainedRefs.every((row) => row.target !== 'S-member'),
        { bind: memberBind, memberTargetRetains: retainedRefs.filter((row) => row.target === 'S-member').length },
      );
      host = renderUntilStable();
      const mainBind = runtime.bindTarget('pane-4', { kind: 'session', sessionId: 'S-task' }, 'task', 'plain task');
      check('A1 护栏：live-binding 普通主会话始终可绑', mainBind.ok === true && retainedRefs.some((row) => row.reference.sessionId === 'S-task'), JSON.stringify(mainBind));
      check('A1 护栏：这两次绑定没有引入 RENDER/EFFECT THROW', internalFailures.length === 0, internalFailures.slice(0, 2));

      // (v) fail-closed 回归：**畸形快照**（缺 `subagent` 键）不得被当成主会话。
      // 契约里 `subagent` 是必填字段；若客户端把"缺键"当"主会话"，一个形状异常/过期的快照
      // 就能把子会话绑进窗格 —— 那正是"所有子智能体一律拒绝"的破口。
      {
        malformedSnapshot = true;
        listSnapshot.ids.push('S-malformed');
        listSnapshot.byId['S-malformed'] = { id: 'S-malformed', displayTitle: 'malformed', running: true, blank: false, updatedAt: Date.now(), cwd: 'D:\\proj', retainedBy: { mainView: 0 } };
        const retainsBeforeMalformed = retainedRefs.length;
        const malformedBind = runtime.bindTarget('pane-2', { kind: 'session', sessionId: 'S-malformed' }, 'auto', 'malformed');
        host = renderUntilStable();
        const paneTwoMalformed = runtime.layout().panes.find((pane) => pane.paneId === 'pane-2');
        // Lead 裁决：**硬要求，不得降级成"已知边界"。**
        // 触发条件：getSnapshot() 返回缺**必填** subagent 键的畸形/过期快照。
        // 风险：若客户端把"缺键"当"主会话"，形状异常/过期的快照就能把子会话绑进窗格 ——
        // 那正是用户「所有子智能体一律拒绝」的破口，而客户端是最后一道闸。
        check(
          'fail-closed（硬要求）：畸形/过期快照（缺必填 subagent 键）不得把子会话绑进窗格 —— 不绑定 + 不 retain + 判 unknown',
          retainedRefs.length === retainsBeforeMalformed
            && retainedRefs.every((row) => row.reference.sessionId !== 'S-malformed')
            && paneTwoMalformed?.target?.sessionId !== 'S-malformed',
          { bind: malformedBind, target: paneTwoMalformed?.target ?? null, retains: [...new Set(retainedRefs.map((row) => row.reference.sessionId))] },
        );
        malformedSnapshot = false;
      }

      // (v-b) fail-closed **加强**（破口真身）：畸形 binding **+ 一行外观完全正常的路由行**。
      //   若客户端在"binding 存在但畸形"时回落到列表行，一条形状异常/过期的快照就会被
      //   "外观正常的路由行"洗白 → 子会话被绑进窗格。这里显式锁死：仍判 unknown/拒绝。
      {
        malformedSnapshot = true;
        listSnapshot.ids.push('S-malformed-routed');
        listSnapshot.byId['S-malformed-routed'] = {
          id: 'S-malformed-routed',
          displayTitle: 'looks like a normal main session',
          running: true,
          blank: false,
          updatedAt: Date.now(),
          cwd: 'D:\\proj',
          retainedBy: { mainView: 0 },
        };
        const retainsBeforeRouted = retainedRefs.length;
        const routedBind = runtime.bindTarget('pane-2', { kind: 'session', sessionId: 'S-malformed-routed' }, 'auto', 'routed');
        host = renderUntilStable();
        const paneRouted = runtime.layout().panes.find((pane) => pane.paneId === 'pane-2');
        check(
          'fail-closed 加强：畸形 binding + 外观正常的路由行 → 仍不得绑进窗格（不回落列表行）',
          retainedRefs.length === retainsBeforeRouted
            && retainedRefs.every((row) => row.reference.sessionId !== 'S-malformed-routed')
            && paneRouted?.target?.sessionId !== 'S-malformed-routed',
          { bind: routedBind, target: paneRouted?.target ?? null },
        );
        malformedSnapshot = false;
      }

      // (vi) harness 不变量（显式断言，防止被"顺手"改掉）：
      //   契约 `binding(id): SessionBinding | undefined` —— **无列表行且从未 retain 过**的
      //   会话必须返回 `undefined`。若替身让它永远返回对象，"证据不足"就会被伪造成
      //   "主会话证据"，A1 的 unknown/不可绑分支会被重新架空（这正是本轮 29 条失败
      //   收敛后暴露出的建模错误）。这条守的是 harness 自身的保真度。
      {
        const unknownId = 'S-never-seen-session';
        check(
          'harness 不变量：无列表行且未 retain 的会话 binding() 必须返回 undefined（否则 A1 的 unknown 分支会被架空）',
          sessions.binding(unknownId) === undefined && listSnapshot.byId[unknownId] === undefined,
          { binding: sessions.binding(unknownId) === undefined ? 'undefined' : 'object' },
        );
      }
    }

    // A4（surface v2）：地址形态的成员目标不得绑定；主会话目标只映射一次，
    // 模式切换后 set-layout 载荷里仍是完整的主会话 target（不是 null，也不被二次转换）。
    {
      for (const paneId of ['pane-1', 'pane-2', 'pane-3', 'pane-4']) clearPane(paneId);
      host = renderUntilStable();
      const addressTarget = { kind: 'subagent', parentSessionId: 'S-lead', childSessionId: 'S-member', mode: 'continuable' };
      const addressBind = runtime.bindTarget('pane-2', addressTarget, 'member', 'combat-system');
      const paneTwoAfterRejectedAddress = runtime.layout().panes.find((pane) => pane.paneId === 'pane-2');
      check(
        'A4：成员地址目标不得绑定为窗格（MEMBER_NOT_A_PANE）',
        addressBind.ok === false && addressBind.code === 'MEMBER_NOT_A_PANE',
        JSON.stringify(addressBind),
      );
      check(
        'A4：被拒的地址目标没有写进 pane-2（也不会 retain 子会话）',
        paneTwoAfterRejectedAddress?.target === null
          && paneTwoAfterRejectedAddress?.view === null
          && retainedRefs.every((row) => row.target !== 'S-member'),
        { pane: paneTwoAfterRejectedAddress, memberTargetRetains: retainedRefs.filter((row) => row.target === 'S-member').length },
      );
      const mainBindA4 = runtime.bindTarget('pane-2', { kind: 'session', sessionId: 'S-lead' }, 'auto', 'lead session');
      check('A4：工作区主会话目标可以绑定', mainBindA4.ok === true, JSON.stringify(mainBindA4));
      const modeMark = hostCalls.length;
      runtime.setMode(2);
      await Promise.resolve();
      await Promise.resolve();
      host = renderUntilStable();
      const setLayoutCalls = hostCalls.slice(modeMark).filter((call) => call.method === 'POST' && call.body?.op === 'set-layout');
      const paneTwoInPush = setLayoutCalls.length === 0
        ? undefined
        : (setLayoutCalls[setLayoutCalls.length - 1].body.panes ?? []).find((pane) => pane.paneId === 'pane-2');
      check(
        'A4：set-layout 载荷里 pane-2 的 target 仍是完整主会话对象（不是 null）',
        paneTwoInPush !== undefined && paneTwoInPush.target !== null && paneTwoInPush.target.sessionId === 'S-lead',
        JSON.stringify(paneTwoInPush ?? setLayoutCalls.map((call) => call.body)),
      );
      check(
        'A4：映射幂等（没有被二次形状转换）',
        JSON.stringify(paneTwoInPush?.target) === JSON.stringify({ sessionId: 'S-lead' }),
        JSON.stringify(paneTwoInPush?.target),
      );
    }

    // ---- 存储健康行（`snapshot.storage` → `data-storage-level`） -----------------
    // 只锚定**数据属性**（`data-storage-level`），不锚定任何显示文案。
    // 判据顺序对客户端很重要：`backend` 先读，因为"老宿主只有 backend、没有 degraded 字段"
    // 也必须判 warn。
    {
      const driveStorage = async (storage) => {
        hostStateResponse = {
          ok: true,
          version: 1,
          basePath: '/plugin/team-workbench',
          compat: { rightBarFocusBridge: true, rightBarFocusBridgeMinVersion: '0.2.0-rc.2' },
          snapshot: {
            layout: { mode: 1, activePaneId: null, panes: [] },
            ...(storage === undefined ? {} : { storage }),
          },
        };
        await runtime.refreshHost();
        await Promise.resolve();
        await Promise.resolve();
        return JSON.stringify(renderUntilStable());
      };
      const levelOf = (html) => {
        const match = /"data-storage-level":"([a-z]+)"/.exec(html);
        return match === null ? null : match[1];
      };

      const criticalHtml = await driveStorage({ durable: false, backend: 'storageDomain' });
      check('存储健康行：durable===false → critical', levelOf(criticalHtml) === 'critical', levelOf(criticalHtml));

      const degradedHtml = await driveStorage({ durable: true, degraded: true, backend: 'storageDomain' });
      check('存储健康行：degraded===true → warn', levelOf(degradedHtml) === 'warn', levelOf(degradedHtml));

      // 旧宿主：只有 backend、**没有 degraded 字段** → 仍必须 warn（判据先看 backend）
      const legacyHtml = await driveStorage({ durable: true, backend: 'json-files' });
      check('存储健康行：旧宿主只有 backend:"json-files"（无 degraded 字段）→ warn', levelOf(legacyHtml) === 'warn', levelOf(legacyHtml));

      // 无 storage 字段 → 无该行、不抛异常
      const noStorageHtml = await driveStorage(undefined);
      check(
        '存储健康行：快照没有 storage 字段 → 不出现该行且不抛异常',
        levelOf(noStorageHtml) === null && internalFailures.length === 0,
        { level: levelOf(noStorageHtml), failures: internalFailures.slice(0, 2) },
      );

      // 空白窗格（panes 为空）也必须出现该行
      const blankHtml = await driveStorage({ durable: false, backend: 'storageDomain' });
      check('存储健康行：空白窗格也要出现（行与 pane 无关）', levelOf(blankHtml) === 'critical', { level: levelOf(blankHtml), panes: runtime.layout().panes.length });
      hostStateResponse = null;
    }

    // ---- 费用 + 真实成果（真实 host 契约：/state 汇总 + GET /state/detail 分页 + pricing.book） ----
    // 契约依据：CONTRACT §7.1/§7.2 + §8.1–§8.4 + host-autonomy 第 7 回合真实实现
    // （`service.stateDetail()` / `findings.summaryOfFindings()` / `findings.findingsDetailPage()`）。
    // 测试用"宿主真值"变量（hostUsageSnapshot/hostFindingsFull/hostErrorGroups）驱动 fake host，
    // 由 fake 同时生成 /state 汇总与 /state/detail 分页 —— 前端消费的是同一份宿主数据。
    let costFindingsEvidence = null;
    {
      const now = Date.now();
      const budgetOf = (value, unknownRequests) => ({
        requests: value,
        inputTokens: value * 1000,
        outputTokens: value * 100,
        cacheReadTokens: value * 200,
        reasoningTokens: value * 10,
        costEstimate: Number((value * 0.003).toFixed(6)),
        costUnknownRequests: unknownRequests ?? 0,
        duplicatesSuppressed: 1,
        retries: 0,
        sessions: 2,
      });
      // Real host snapshot shape (src/host/usage.js snapshot()): `entries` is the COUNT, the real
      // price table is `book: [{provider, model, effectiveFrom, effectiveTo, currency, …rates}]`;
      // the frozen single-rate fields are null when the book is not a single wildcard entry.
      const cnyBook = {
        version: 'pricing-cny-v1',
        currency: 'CNY',
        source: 'config',
        inputPerMillion: null,
        outputPerMillion: null,
        cacheReadPerMillion: null,
        entries: 1,
        book: [{ provider: 'deepseek-account', model: 'deepseek-flash', effectiveFrom: now - 86400000, effectiveTo: null, currency: 'CNY', inputPerMillion: 3.5, outputPerMillion: 14, cacheReadPerMillion: 0.7 }],
        estimateOnly: true,
      };
      const cnyUsage = (overrides) => Object.assign({
        version: 3,
        generatedAt: now - 30000,
        currency: 'CNY',
        pricing: cnyBook,
        scopes: {
          // teamKey null = 账户级汇总（host 真实语义）；前端不得在成员窗格显示它。
          team: { teamKey: null, cumulative: budgetOf(128), phase: { id: 'host-1', label: 'Host 启动至今', startedAt: now - 7200000, cumulative: budgetOf(40) }, attribution: {} },
          byOwner: { 'S-member': budgetOf(42, 1), 'S-lead': budgetOf(12) },
          // CONTRACT v4 §11.1: credit dimensions by phase (current|historical) and by work item.
          byPhase: { current: budgetOf(30, 2), historical: budgetOf(12) },
          byWork: { 'W-1': budgetOf(20), 'W-2': budgetOf(22, 1) },
          byProviderModel: {},
        },
        totals: budgetOf(128, 3),
        uncertainty: { missingUsageRequests: 3, unattributedRequests: 1, estimatedCostRatio: 0.0234, mixedCurrency: false, notes: [] },
        raw: { source: 'requests.jsonl', path: 'C:/audit/requests.jsonl', readAt: now - 20000, windowFrom: now - 86400000, windowTo: now, requestsSeen: 128, detailEndpoint: '/plugin/team-workbench/state/detail' },
      }, overrides ?? {});
      const trustedOf = (complete) => (complete
        ? { attemptId: 'attempt-7', executionRunId: 'run-7', exitCode: 0, artifactSha256: 'sha256:aa11', complete: true }
        : { attemptId: null, executionRunId: null, exitCode: null, artifactSha256: null, complete: false });
      const verifiedRow = (index) => ({
        workId: 'W-' + index,
        ownerMemberId: 'S-member',
        title: 'verified-' + index,
        // §11.3: artifact version explicit; index 2 has NO version (must show 「版本未提供」).
        artifacts: [{ path: 'out/a' + index + '.json', version: index === 2 ? null : 1 }],
        artifactVersions: [{ path: 'out/a' + index + '.json', version: index === 2 ? null : 1 }],
        evidence: [{ kind: 'verification', ref: 'evidence#' + index, ok: true }],
        verifiedAt: now - 60000,
        evidenceLevel: index === 3 ? 'batch-verified' : 'offline-verified',
        scope: index === 3 ? 'batch' : 'offline',
        ceiling: index === 3 ? 'batch-verified' : 'offline-verified',
        claimScope: index === 3 ? 'cross-module' : 'own-work',
        // Index 2 has incomplete trusted execution → host caps the level at offline (never upgraded).
        verificationLevel: index === 3 ? 'integration' : 'offline',
        // §11.3 dependency versions: index 2 has a missing dependency version.
        dependencyVersions: [
          { artifact: 'dep-x', version: 2, requires: 'published-interface' },
          { artifact: 'dep-y', version: index === 2 ? null : 3, requires: 'verified-result' },
        ],
        trustedExecution: trustedOf(index !== 2),
        limitations: index === 3 ? [] : ['offline-verified：只证明本机 Host 真实执行并通过；不能据此声称已接入运行中的 DSH / 已保存 / 玩法可用 / 用户接受。'],
      });
      const findingsFull = {
        generatedAt: now - 30000,
        verified: Array.from({ length: 41 }, (_, index) => verifiedRow(index + 1)),
        inProgress: [{ workId: 'W-100', ownerMemberId: 'S-member', title: 'in-progress-1', state: 'executing', lastEffectiveAt: now - 5000 }],
        unfinished: [{ workId: 'W-31', ownerMemberId: 'S-member', title: 'unfinished-1', state: 'awaiting_verification', claimScope: 'own-work', missing: ['owner-verification'] }],
        rejected: [{ workId: 'W-32', ownerMemberId: 'S-member', note: '证据不足', at: now - 1000 }],
        invalidated: [{ workId: 'W-33', reason: 'EVIDENCE_STALE', at: now - 2000, legacyOwnerClaim: true, note: '历史 owner 声明' }],
        activity: [{ workId: 'W-1', ownerMemberId: 'S-member', kind: 'attempt', at: now - 4000 }],
        errors: [],
        counts: { verified: 41, inProgress: 1, unfinished: 1, rejected: 1, invalidated: 1, activity: 1, errors: 0 },
        levels: { verified: [{ workId: 'W-3', evidenceLevel: 'batch-verified', ceiling: 'batch-verified' }] },
        lastEffectiveProgress: { at: now - 7000, workId: 'W-9', ownerMemberId: 'S-member', text: 'recovered leaf receipt' },
        note: 'verified 只含 Host 能复核的成果',
      };
      const errorGroups = Array.from({ length: 12 }, (_, index) => ({
        fingerprint: 'fp-' + index,
        code: 'CODE_' + index,
        count: index + 2,
        firstAt: now - 3600000,
        lastAt: now - 60000,
        memberId: 'S-member',
        workIds: ['W-1', 'W-2'],
        guidance: 'change condition ' + index,
      }));

      const paneButtonByText = (tree, text) => tree.filter((node) => {
        if (node.type !== 'button' || node.props === undefined) return false;
        const kids = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
        return kids.some((kid) => kid === text);
      });
      const countOf = (html, marker) => (html.match(new RegExp('"' + marker + '"', 'g')) ?? []).length;

      runtime.setMode(1);
      for (const paneId of ['pane-1', 'pane-2', 'pane-3', 'pane-4']) clearPane(paneId);
      host = renderUntilStable();
      const costBind = runtime.bindTarget('pane-1', { kind: 'session', sessionId: 'S-lead' }, 'auto', 'lead');
      check('费用/成果：pane-1 绑定工作区主会话 S-lead', costBind.ok === true, JSON.stringify(costBind));
      const costOpen = runtime.openChild('pane-1', 'S-member');
      check('费用/成果：从「子会话」进入成员 S-member 的二级视图', costOpen.ok === true, JSON.stringify(costOpen));
      host = renderUntilStable();

      const hostState = (snapshotExtra) => ({
        ok: true,
        version: 1,
        basePath: '/plugin/team-workbench',
        compat: { rightBarFocusBridge: true, rightBarFocusBridgeMinVersion: '0.2.0-rc.2' },
        snapshot: Object.assign({ layout: { mode: 1, activePaneId: null, panes: [] } }, snapshotExtra ?? {}),
      });
      /** 驱动一次真实形状的 /state（+ 关闭/开启 detail 路由）并强制渲染。 */
      const driveCostData = async (options) => {
        const opts = options ?? {};
        const callsBefore = hostCalls.length;
        const membersBefore = [...accessedSessionsMembers].sort().join(',');
        hostUsageSnapshot = opts.usage === undefined ? cnyUsage() : opts.usage;
        hostFindingsFull = opts.findings === undefined ? findingsFull : opts.findings;
        hostErrorGroups = opts.errors === undefined ? errorGroups : opts.errors;
        hostDetailRouteAvailable = opts.route !== false;
        hostUsageRecordRows = opts.recordRows ?? [];
        const summary = hostFindingsFull === null ? undefined : summaryOfFindings(hostFindingsFull);
        const findingsSnapshot = opts.findingsInState !== undefined
          ? opts.findingsInState
          : summary;
        hostStateResponse = hostState(Object.assign({
          usage: hostUsageSnapshot,
          findings: findingsSnapshot,
          errorFingerprints: opts.errors === null ? undefined : { generatedAt: now, total: hostErrorGroups.length, groups: hostErrorGroups },
        }, opts.extraSnapshot ?? {}));
        await runtime.refreshHost();
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
        host = renderPanel();
        host = renderUntilStable();
        return {
          calls: hostCalls.slice(callsBefore),
          membersBefore,
          membersAfter: [...accessedSessionsMembers].sort().join(','),
        };
      };
      const expandDetails = () => {
        const toggles = paneButtonByText(host, 'member.detail');
        if (toggles.length > 0) toggles[0].props.onClick();
        host = renderUntilStable();
      };
      /** Expand every collapsible section (usage detail / repeated errors) before asserting. */
      const expandAll = () => {
        for (let guard = 0; guard < 4; guard += 1) {
          const buttons = paneButtonByText(host, 'label.expand');
          if (buttons.length === 0) break;
          buttons[0].props.onClick();
          host = renderUntilStable();
        }
      };
      // Bounded async settle. NOTE: a list that fell back to `preview` shows no "loading" marker
      // while its real page fetch is still pending, so this must drain a fixed number of passes
      // instead of exiting on the visible-state heuristic.
      const flushAsync = async () => {
        for (let pass = 0; pass < 10; pass += 1) {
          for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
          host = renderUntilStable();
        }
      };
      const detailCallsOf = (calls) => calls.filter((call) => String(call.url).indexOf('/state/detail') >= 0);
      const opCallsOf = (calls, opName) => calls.filter((call) => String(call.url).indexOf('/op') >= 0 && call.body !== undefined && call.body !== null && call.body.op === opName);
      const costFlags = {
        currencyKnownShown: false,
        currencyUnknownMarked: false,
        zeroRateKnown: false,
        mixedCurrencyMarked: false,
        claimScopeRendered: false,
        verificationLevelRendered: false,
        evidenceLevelRendered: false,
        limitationsRendered: false,
        legacyClaimRendered: false,
        versionRendered: false,
        dependencyVersionsRendered: false,
        trustedExecutionRendered: false,
        usageViewsPaged: false,
        unknownReasonsRendered: false,
        hostDetailCalls: 0,
        detailTransport: null,
        fallbackUsageRecords: false,
        previewOnlyFallback: false,
        detailUnavailableFallback: false,
        noLocalSlicing: true,
        missingDataKeys: [],
        readOnlyOnly: true,
      };

      // ===== 1) 真实 /state 汇总 + /state/detail 分页 =====
      const firstDrive = await driveCostData({});
      expandDetails();
      await flushAsync();
      expandAll();
      await flushAsync();
      let html = JSON.stringify(host);
      const firstDetailCalls = detailCallsOf(hostCalls.slice(0, hostCalls.length));
      costFlags.hostDetailCalls = firstDetailCalls.length;
      costFlags.detailTransport = runtime.bridge.detailTransport();
      costFlags.currencyKnownShown = html.indexOf('CNY ') >= 0 && html.indexOf('cost.estimateSuffix') >= 0;
      costFlags.claimScopeRendered = html.indexOf('findings.claimScope') >= 0 && (html.indexOf('findings.claimScope.own-work') >= 0 || html.indexOf('"own-work"') >= 0);
      costFlags.verificationLevelRendered = html.indexOf('findings.verificationLevel') >= 0 && (html.indexOf('"offline"') >= 0 || html.indexOf('"integration"') >= 0);
      costFlags.evidenceLevelRendered = html.indexOf('findings.evidenceLevel') >= 0 && (html.indexOf('"offline-verified"') >= 0 || html.indexOf('"batch-verified"') >= 0);
      costFlags.limitationsRendered = html.indexOf('findings.limitations') >= 0;
      costFlags.legacyClaimRendered = html.indexOf('findings.legacyClaim') >= 0;

      // (R2) 明细来自真实 host 分页接口：GET /state/detail?section=…&kind=…&page=…&pageSize=…
      check('明细(R2)：客户端按真实契约请求 GET /state/detail', costFlags.hostDetailCalls >= 1 && firstDetailCalls.every((call) => call.method === 'GET'), firstDetailCalls.map((call) => call.method + ' ' + call.url));
      check(
        '明细(R2)：请求带 section/kind/page/pageSize 参数',
        firstDetailCalls.some((call) => String(call.url).indexOf('section=findings') >= 0 && String(call.url).indexOf('kind=verified') >= 0 && String(call.url).indexOf('page=1') >= 0 && String(call.url).indexOf('pageSize=20') >= 0),
        firstDetailCalls.map((call) => call.url),
      );
      const allFirstDetailCalls = detailCallsOf(hostCalls);
      check('明细(R2)：errors 用真实 section=errors', allFirstDetailCalls.some((call) => String(call.url).indexOf('section=errors') >= 0), allFirstDetailCalls.map((call) => call.url));
      check('明细(R2)：usage 用真实 section=usage（byOwner）', allFirstDetailCalls.some((call) => String(call.url).indexOf('section=usage') >= 0), allFirstDetailCalls.map((call) => call.url));
      // ---- CONTRACT v4 §11.1：归账维度 byPhase / byWork 也走宿主分页 ----
      const usagePhaseCalls = allFirstDetailCalls.filter((call) => String(call.url).indexOf('section=usage') >= 0 && String(call.url).indexOf('kind=byPhase') >= 0);
      const usageWorkCalls = allFirstDetailCalls.filter((call) => String(call.url).indexOf('section=usage') >= 0 && String(call.url).indexOf('kind=byWork') >= 0);
      costFlags.usageViewsPaged = usagePhaseCalls.length >= 1 && usageWorkCalls.length >= 1;
      check('费用(v4)：按阶段/工作项均请求宿主分页接口（kind=byPhase / kind=byWork）', costFlags.usageViewsPaged, {
        phase: usagePhaseCalls.map((call) => call.url),
        work: usageWorkCalls.map((call) => call.url),
      });
      check('费用(v4)：阶段页渲染宿主行（current/historical），不在前端切页', html.indexOf('"data-usage-key":"current"') >= 0 && html.indexOf('"data-usage-key":"historical"') >= 0);
      check('费用(v4)：工作项页渲染宿主行（W-1/W-2）', html.indexOf('"data-usage-key":"W-1"') >= 0 && html.indexOf('"data-usage-key":"W-2"') >= 0);
      check('明细(R2)：首屏渲染宿主第 1 页的 20 条已证成果', countOf(html, 'data-verified') === 20 && html.indexOf('verified-1') >= 0, { verified: countOf(html, 'data-verified') });
      check('明细(R2)：未完成/过期/驳回来自宿主分页', html.indexOf('unfinished-1') >= 0 && html.indexOf('EVIDENCE_STALE') >= 0 && html.indexOf('证据不足') >= 0);
      check('明细(R2)：重复错误来自宿主分页（真实 code + 指导/首末行 + 每页 10 组）', html.indexOf('CODE_0') >= 0 && html.indexOf('errors.guidance') >= 0 && html.indexOf('errors.window') >= 0 && html.indexOf('"data-page-items":"10"') >= 0, {
        code: html.indexOf('CODE_0') >= 0,
        guidanceLine: html.indexOf('errors.guidance') >= 0,
        windowLine: html.indexOf('errors.window') >= 0,
        pageItems: html.indexOf('"data-page-items":"10"') >= 0,
      });
      check('明细(R2)：最后有效进展来自 /state 汇总', html.indexOf('findings.progress') >= 0 && html.indexOf('recovered leaf receipt') >= 0);
      check('明细(R2)：/state.findings 只消费汇总（counts/preview/levels），不渲染全量数组', countOf(html, 'data-verified') <= 20);

      // (R3) claimScope / verificationLevel / evidenceLevel / ceiling / limitations 分开呈现
      check('成果(R3)：claimScope 单独成行（真实枚举 own-work/cross-module）', costFlags.claimScopeRendered);
      check('成果(R3)：verificationLevel 单独成行（真实枚举 offline/integration）', costFlags.verificationLevelRendered);
      check('成果(R3)：evidenceLevel 单独成行（真实枚举 offline-verified/batch-verified）', costFlags.evidenceLevelRendered);
      check('成果(R3)：ceiling 单独成行', html.indexOf('findings.ceiling') >= 0);
      check('成果(R3)：host 的 limitations 原样呈现（不冒充实机/用户接受）', costFlags.limitationsRendered);
      check('成果(R3)：历史 owner 声明标注（legacyOwnerClaim）', costFlags.legacyClaimRendered);
      check('成果(R3)：不出现「实机完成」这类客户端自造结论', html.indexOf('实机完成') < 0 && html.indexOf('real machine done') < 0);
      // ---- CONTRACT v4 §11.3：逐条展示 产物版本 / 依赖版本 / 可信执行（缺则未提供，不升级等级） ----
      costFlags.versionRendered = html.indexOf('out/a1.json@v1') >= 0 && html.indexOf('findings.versionMissing') >= 0;
      check('成果(v4)：产物版本 path@vN 逐条展示；缺版本显式「版本未提供」', costFlags.versionRendered, {
        hasVersion: html.indexOf('out/a1.json@v1') >= 0,
        hasMissing: html.indexOf('findings.versionMissing') >= 0,
      });
      costFlags.dependencyVersionsRendered = html.indexOf('findings.dependencyVersions') >= 0 && html.indexOf('dep-x@v2(published-interface)') >= 0 && html.indexOf('dep-y@') >= 0;
      check('成果(v4)：依赖版本 artifact@vN(requires) 逐条展示；缺版本显式未提供', costFlags.dependencyVersionsRendered);
      costFlags.trustedExecutionRendered = html.indexOf('findings.trustedExecution') >= 0 && html.indexOf('attempt-7') >= 0 && html.indexOf('run-7') >= 0 && html.indexOf('sha256:aa11') >= 0;
      check('成果(v4)：可信执行 attempt/execution/exitCode/sha 逐条展示', costFlags.trustedExecutionRendered);
      check('成果(v4)：可信执行不完整 → 显式警告，且等级仍为宿主给的 offline（不升级）', html.indexOf('findings.trustedExecution.incomplete') >= 0 && html.indexOf('"offline"') >= 0 && html.indexOf('"integration"') >= 0);
      check('成果(v4)：不同等级分别呈现，不用统一 verified 掩盖', html.indexOf('"offline"') >= 0 && html.indexOf('"integration"') >= 0 && html.indexOf('findings.evidenceLevel') >= 0);
      check('成果(R3)：等级分布来自 counts.verifiedByLevel（五档分别呈现）', html.indexOf('findings.levels') >= 0 && html.indexOf('user-confirmation:') >= 0 && html.indexOf('gameplay:') >= 0 && html.indexOf('engineering-save:') >= 0);

      // (R1) 费用：可追溯价目 book（CNY + 显式费率）→ 显示金额并标估算；账户级汇总不在成员窗格
      check('费用(R1)：真实 pricing.book（CNY）→ 显示金额并标「估算」', costFlags.currencyKnownShown);
      check('费用(R1)：成员窗格不显示账户级汇总（teamKey=null → accountScopeHidden）', html.indexOf('cost.accountScopeHidden') >= 0 && html.indexOf('"data-team-scoped":"false"') >= 0);
      check('费用(R1)：本成员累计来自 scopes.byOwner', html.indexOf('CNY 0.1260') >= 0 || html.indexOf('CNY 0.126') >= 0, html.slice(0, 200));
      check('费用(R1)：价目版本与来源可追溯', html.indexOf('pricing-cny-v1') >= 0 && html.indexOf('cost.labelPricing') >= 0);

      // teamKey 匹配时展示团队（本团队）累计
      const teamScopedUsage = cnyUsage();
      teamScopedUsage.scopes.team.teamKey = 'S-lead';
      await driveCostData({ usage: teamScopedUsage });
      expandDetails();
      await flushAsync();
      check('费用(R1)：teamKey 匹配时显示本团队累计', JSON.stringify(host).indexOf('"data-team-scoped":"true"') >= 0);
      hostDetailRouteAvailable = true;

      // ===== 2) 分页：下一页只请求宿主第 2 页 =====
      await driveCostData({});
      expandDetails();
      await flushAsync();
      const nextButtons = paneButtonByText(host, 'findings.next');
      check('分页(R2)：下一页按钮存在（宿主分页器）', nextButtons.length >= 1, { count: nextButtons.length });
      const pageMark = hostCalls.length;
      if (nextButtons.length > 0) nextButtons[0].props.onClick();
      await flushAsync();
      const page2DetailCalls = detailCallsOf(hostCalls.slice(pageMark));
      check('分页(R2)：翻页只请求宿主第 2 页', page2DetailCalls.some((call) => String(call.url).indexOf('page=2') >= 0), page2DetailCalls.map((call) => call.url));
      check('分页(R2)：第 2 页渲染宿主条目 verified-21', JSON.stringify(host).indexOf('verified-21') >= 0);

      // ===== 3) 计价：显式 0 费率是「已知免费」，缺价目才是 unknown =====
      const zeroBookUsage = cnyUsage({
        pricing: { version: 'pricing-free-v1', currency: 'CNY', source: 'config', inputPerMillion: null, outputPerMillion: null, cacheReadPerMillion: null, entries: 1, book: [{ provider: '*', model: '*', effectiveFrom: 0, effectiveTo: null, currency: 'CNY', inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0 }], estimateOnly: true },
        scopes: { team: { teamKey: null, cumulative: Object.assign(budgetOf(2), { costEstimate: 0 }), phase: { id: 'p1', label: 'phase', startedAt: now - 1000, cumulative: Object.assign(budgetOf(1), { costEstimate: 0 }) } }, byOwner: { 'S-member': Object.assign(budgetOf(2), { costEstimate: 0 }) }, byProviderModel: {} },
      });
      await driveCostData({ usage: zeroBookUsage });
      expandDetails();
      await flushAsync();
      const zeroHtml = JSON.stringify(host);
      costFlags.zeroRateKnown = zeroHtml.indexOf('CNY 0.000000') >= 0 && zeroHtml.indexOf('cost.costUnknown') < 0;
      check('费用(R1)：显式 0 费率是已知免费（CNY 0.000000），不是 unknown', costFlags.zeroRateKnown, { hasZeroMoney: zeroHtml.indexOf('CNY 0.000000') >= 0 });

      const noBookUsage = cnyUsage({ currency: null, pricing: { version: 'pricing-v1', currency: null, source: 'not-configured', inputPerMillion: null, outputPerMillion: null, cacheReadPerMillion: null, entries: 0, book: [], estimateOnly: true }, uncertainty: { missingUsageRequests: 3, unattributedRequests: 1, estimatedCostRatio: null, mixedCurrency: false, notes: [] } });
      await driveCostData({ usage: noBookUsage });
      expandDetails();
      await flushAsync();
      const noBookHtml = JSON.stringify(host);
      costFlags.currencyUnknownMarked = noBookHtml.indexOf('cost.costUnknown') >= 0 && noBookHtml.indexOf('CURRENCY_UNKNOWN') >= 0 && noBookHtml.indexOf('PRICE_UNKNOWN') >= 0;
      check('费用(R1)：未配置价目 → 费用 unknown（不默认 USD/0）', costFlags.currencyUnknownMarked);
      costFlags.unknownReasonsRendered = noBookHtml.indexOf('CURRENCY_UNKNOWN') >= 0 && noBookHtml.indexOf('PRICE_UNKNOWN') >= 0;
      check('费用(v4)：unknown 原因码原样显示（CURRENCY_UNKNOWN / PRICE_UNKNOWN）', costFlags.unknownReasonsRendered, {
        currency: noBookHtml.indexOf('CURRENCY_UNKNOWN') >= 0,
        price: noBookHtml.indexOf('PRICE_UNKNOWN') >= 0,
      });
      check('费用(R1)：unknown 时不出现任何金额', /(CNY|USD)\s?\d/.test(noBookHtml.replace(/cost\.(pricing|currency)\w*/g, '')) === false);

      // Host-declared reason wins (`uncertainty.reasonCodes`): shown verbatim.
      const providerUnpriced = cnyUsage({
        uncertainty: { missingUsageRequests: 0, unattributedRequests: 0, estimatedCostRatio: 0, mixedCurrency: false, reasonCodes: ['PROVIDER_MODEL_UNPRICED'], notes: [] },
        scopes: { team: { teamKey: null, cumulative: Object.assign(budgetOf(2), { costUnknownRequests: 2 }), phase: { id: 'p', label: 'phase', startedAt: now - 1000, cumulative: budgetOf(1) } }, byOwner: { 'S-member': Object.assign(budgetOf(2), { costUnknownRequests: 2 }) }, byProviderModel: {} },
      });
      await driveCostData({ usage: providerUnpriced });
      expandDetails();
      await flushAsync();
      check('费用(v4)：Host 声明的未知原因原样显示（PROVIDER_MODEL_UNPRICED）', JSON.stringify(host).indexOf('PROVIDER_MODEL_UNPRICED') >= 0);
      const mixedUsage = cnyUsage({ uncertainty: { missingUsageRequests: 0, unattributedRequests: 0, estimatedCostRatio: 0, mixedCurrency: true, notes: [] }, costByCurrency: { CNY: budgetOf(10), USD: budgetOf(4) } });
      await driveCostData({ usage: mixedUsage });
      expandDetails();
      await flushAsync();
      const mixedHtml = JSON.stringify(host);
      costFlags.mixedCurrencyMarked = mixedHtml.indexOf('cost.mixedCurrency') >= 0 && mixedHtml.indexOf('cost.costUnknown') >= 0;
      check('费用(R1)：混币 → 不相加、标 mixedCurrency', costFlags.mixedCurrencyMarked);

      // ===== 4) 反向降级：无 /state/detail 路由 =====
      // A) 有显式 preview：只展示预览，不给分页器
      await driveCostData({ route: false, recordRows: [{ billingKey: 'b-peak', sessionId: 'S-member', provider: 'deepseek-account', model: 'deepseek-flash', time: now - 1000, cost: null, costKnown: false, costUnknownReason: 'PEAK_PRICE_UNVERIFIED', currency: null }] });
      expandDetails();
      await flushAsync();
      expandAll();
      await flushAsync();
      const previewHtml = JSON.stringify(host);
      const fallbackCalls = detailCallsOf(hostCalls.slice(0));
      costFlags.previewOnlyFallback = previewHtml.indexOf('cost.previewOnly') >= 0;
      costFlags.fallbackUsageRecords = opCallsOf(hostCalls.slice(0), 'usage-records').length >= 0;
      check('反向 A(R2)：无分页接口 → 显式 previewOnly 降级（不给本地分页器）', costFlags.previewOnlyFallback && previewHtml.indexOf('"data-pager":"verified"') < 0);
      check('反向 A(R2)：preview 条目来自 /state.findings.preview（≤5）', previewHtml.indexOf('verified-1') >= 0 && previewHtml.indexOf('verified-6') < 0);
      check('反向 A(R2)：usage 明细回退到已部署的 POST /op usage-records（兼容旧 host）', opCallsOf(hostCalls.slice(0), 'usage-records').length >= 1, hostCalls.filter((call) => call.body !== null && call.body !== undefined && call.body.op === 'usage-records').map((call) => call.body));
      check('费用(v4)：逐条未知原因原样显示（PEAK_PRICE_UNVERIFIED）', previewHtml.indexOf('PEAK_PRICE_UNVERIFIED') >= 0 || JSON.stringify(host).indexOf('PEAK_PRICE_UNVERIFIED') >= 0);

      // B) 老宿主把全量数组塞进 /state 且无分页接口：绝不本地切页、绝不渲染全量
      const legacyFindingsFull = Object.assign({}, findingsFull);
      await driveCostData({ route: false, findingsInState: Object.assign({}, summaryOfFindings(legacyFindingsFull), { verified: legacyFindingsFull.verified }), findings: legacyFindingsFull });
      expandDetails();
      await flushAsync();
      expandAll();
      await flushAsync();
      const legacyHtml = JSON.stringify(host);
      costFlags.detailUnavailableFallback = legacyHtml.indexOf('cost.detailUnavailable') >= 0 || legacyHtml.indexOf('cost.previewOnly') >= 0;
      check('反向 B(R2)：无分页接口 + /state 全量数组 → 显式降级（detailUnavailable/previewOnly）', costFlags.detailUnavailableFallback);
      check('反向 B(R2)：绝不把 /state 全量数组当明细渲染（不出现 verified-21..40）', ['verified-21', 'verified-30', 'verified-40'].every((title) => legacyHtml.indexOf(title) < 0));

      // ===== 5) 缺字段：等待宿主数据，不崩、不猜、v2 不变 =====
      await driveCostData({ usage: null, findings: null, errors: null, extraSnapshot: {} });
      expandDetails();
      await flushAsync();
      const missingHtml = JSON.stringify(host);
      costFlags.missingDataKeys = ['cost.waiting', 'findings.waiting', 'errors.waiting'].filter((key) => missingHtml.indexOf(key) >= 0);
      check('缺字段：usage/findings/errorFingerprints 缺失 → 等待宿主数据', costFlags.missingDataKeys.length === 3, costFlags.missingDataKeys);
      check('缺字段：不编造金额', /\$\d/.test(missingHtml) === false && /CNY\s?\d/.test(missingHtml) === false);
      check('缺字段：不抛异常', internalFailures.length === 0, internalFailures.slice(0, 2));
      check('缺字段：v2 布局不变（mode 1 / 成员摘要行仍在）', runtime.layout().mode === 1 && missingHtml.indexOf('member.summary') >= 0);
      check('v2 小字清理不回退（无 tb-status / tb-team / tb-pane-task / tb-node）', ['tb-status', 'tb-team', 'tb-pane-task', 'tb-node'].every((token) => missingHtml.indexOf(token) < 0));

      // ===== 6) stale 与只读 =====
      const staleUsage = cnyUsage({ generatedAt: now - 10 * 60 * 1000 });
      await driveCostData({ usage: staleUsage });
      expandDetails();
      await flushAsync();
      check('诚实标注(R1)：generatedAt 超过 5 分钟 → cost.stale', JSON.stringify(host).indexOf('cost.stale') >= 0);
      // 只读范围：本特性驱动 /state 与 /state/detail 的那些调用（绑定/开子会话的布局写不属这里）。
      const featureCalls = [firstDrive.calls, ...([])].flat().concat(hostCalls.filter((call) => String(call.url).indexOf('/state') >= 0 || (call.body !== null && call.body !== undefined && ['usage-records', 'client-ack'].indexOf(call.body.op) >= 0)));
      costFlags.readOnlyOnly = featureCalls.every((call) => {
        if (call.method === 'GET') return true;
        return call.url.indexOf('/op') >= 0 && call.body !== null && call.body !== undefined && ['usage-records', 'client-ack'].indexOf(call.body.op) >= 0;
      });
      check('只读：/state 与 /state/detail 全为 GET；POST 仅 usage-records/client-ack', costFlags.readOnlyOnly, featureCalls.filter((call) => call.method !== 'GET').map((call) => call.body));
      check('只读：sessions 仍只触达只读成员', [...accessedSessionsMembers].sort().every((name) => ['list', 'retain', 'retainInfo', 'subagentAddress', 'binding'].indexOf(name) >= 0), [...accessedSessionsMembers].sort());

      costFlags.readOnlyOnly = costFlags.readOnlyOnly && firstDrive.calls.every((call) => call.method === 'GET' || (call.body !== null && call.body !== undefined && ['usage-records', 'client-ack'].indexOf(call.body.op) >= 0));
      costFindingsEvidence = costFlags;
      hostStateResponse = null;
      hostUsageSnapshot = null;
      hostFindingsFull = null;
      hostErrorGroups = [];
      hostDetailRouteAvailable = true;
      runtime.closeChild('pane-1');
      host = renderUntilStable();
    }

    // ---- 前端激活回执（round-22 修正）：官方 load-closure 元数据 + Host 唯一 schema ----
    let activationAckEvidence = null;
    {
      const ackRecords = () => hostFrontendAckRecords;
      const pluginSelf = plugin.selfBundle ?? plugin.selfBundle === null ? plugin.selfBundle : undefined;
      const selfBundle = pluginSelf !== null && pluginSelf !== undefined ? pluginSelf : (typeof plugin.selfBundle === 'function' ? plugin.selfBundle() : undefined);

      // (a) 官方 load-closure：脚本执行时捕获的 URL + rev（不是 manifest 宣告值，也不是 boot 宣告值）
      check(
        'ack(v22)：bundle 身份来自脚本执行时的 load-closure（rev=rev-load-1，非 manifest/boot 宣告值）',
        selfBundle !== null && selfBundle !== undefined && selfBundle.url !== null && selfBundle.rev === 'rev-load-1' && selfBundle.sourceDigest !== null,
        selfBundle,
      );
      check('ack(v22)：嵌入确定性 source digest（sha256 十六进制，不含 final hash 自引用）', selfBundle !== null && selfBundle !== undefined && /^[0-9a-f]{64}$/.test(String(selfBundle.sourceDigest)), selfBundle);

      // (b) 实际注册的 factory rev（modules.factories，官方 register 记录）作为最终 frontendRev
      const ackFacts = { mountedAfterUnmount: null, ackCountAfterUpgrade: 0, lastAck: undefined };
      check('ack(v22)：runtime 冻结实例元数据（revSource=modules.factories）', runtime.selfBundle().rev === 'rev-registered-1' && runtime.selfBundle().revSource === 'modules.factories', runtime.selfBundle());

      // (c) 卸载：不发回执、状态不虚报 mounted
      const offlineRefresh = await (async () => {
        runtime.setPanelMounted(false);
        runtime.noteFrontendUnmount('main');
        const before = ackRecords().length;
        hostStateResponse = {
          ok: true,
          version: 1,
          basePath: '/plugin/team-workbench',
          compat: { rightBarFocusBridge: true, rightBarFocusBridgeMinVersion: '0.2.0-rc.2' },
          snapshot: { layout: { mode: 1, activePaneId: null, panes: [] } }
        };
        await runtime.refreshHost();
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
        hostStateResponse = null;
        return { before, after: ackRecords().length };
      })();
      check('ack(v22)：卸载后刷新不发回执（refresh 不伪造激活）', offlineRefresh.after === offlineRefresh.before, offlineRefresh);
      check('ack(v22)：卸载后状态不虚报 mounted', runtime.frontendAckState().mounted.main === false);

      // (d) 真实 mount 后才发回执，schema 与 Host recordFrontendAck 的读取字段完全一致
      const beforeMount = ackRecords().length;
      runtime.setPanelMounted(true);
      runtime.noteFrontendMount('main');
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
      const mountAck = ackRecords().length === 0 ? undefined : ackRecords()[ackRecords().length - 1];
      check('ack(v22)：真实 mount 后发送回执', ackRecords().length === beforeMount + 1 && mountAck !== undefined, { beforeMount, after: ackRecords().length });
      check(
        'ack(v22)：Host schema 字段对齐（bundle.url/bundle.activatedAt/frontendRev/mounted===true）',
        mountAck !== undefined && mountAck.bundleUrl === '/plugin-assets/team-workbench/client.js?rev=rev-load-1' && typeof mountAck.activatedAt === 'number' && mountAck.mounted === true && mountAck.frontendRev === 'rev-registered-1',
        mountAck,
      );
      check('ack(v22)：后端可读回（fake Host 持久记录 mounted/frontendRev/activatedAt）', mountAck !== undefined && mountAck.persisted === true && mountAck.renderedRegionsDroppedByHost >= 0);

      // (e) renderedRegions 仅来自真实 commit 的 Host 投影
      const renderedState = runtime.frontendAckState();
      check('ack(v22)：renderedRegions 来自真实渲染（cost/findings/usage/errors 子集）', renderedState.renderedRegions.length > 0 && renderedState.renderedRegions.every((region) => ['cost', 'findings', 'usage', 'errors'].indexOf(region) >= 0), renderedState.renderedRegions);

      // (f) HMR 只广播新 rev（不含真实新 factory）：旧 runtime 不得自报新代码已加载
      const revBefore = runtime.selfBundle().rev;
      const ackBefore = ackRecords().length;
      modulesFake.manifest.rev = 'rev-hmr-announced';
      modulesFake.manifest.modules = [{ id: '@local/dsh-team-workbench', url: '/plugin-assets/team-workbench/client.js?rev=rev-hmr-announced', rev: 'rev-hmr-announced' }];
      modulesFake.reloadTargets.set('@local/dsh-team-workbench', { url: '/plugin-assets/team-workbench/client.js?rev=rev-hmr-announced', rev: 'rev-hmr-announced' });
      const hmrAck = await (async () => {
        hostStateResponse = {
          ok: true,
          version: 1,
          basePath: '/plugin/team-workbench',
          compat: { rightBarFocusBridge: true, rightBarFocusBridgeMinVersion: '0.2.0-rc.2' },
          snapshot: { layout: { mode: 1, activePaneId: null, panes: [] } }
        };
        await runtime.refreshHost();
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
        hostStateResponse = null;
        runtime.noteFrontendRendered('cost');
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
        return ackRecords().length === 0 ? undefined : ackRecords()[ackRecords().length - 1];
      })();
      check('ack(v22)：HMR 广播新 rev 不改变本实例元数据（旧 runtime 不自报新代码）', runtime.selfBundle().rev === revBefore && runtime.selfBundle().rev === 'rev-registered-1', runtime.selfBundle());
      check('ack(v22)：HMR 广播后回执 frontendRev 仍为实际加载的 rev（非宣告值）', hmrAck === undefined || hmrAck.frontendRev === 'rev-registered-1', hmrAck);
      ackFacts.lastAck = hmrAck;
      ackFacts.ackCountAfterUpgrade = ackRecords().length;
      ackFacts.mountedAfterUnmount = null;

      // (g) 无 currentScript 的独立执行：不得伪造 URL/rev（诚实降级），digest 仍确定
      const secondRegistrations = [];
      const secondWindow = {
        __ModuleLoader__: { load: (reg) => { secondRegistrations.push(reg); } },
        document: { currentScript: null, querySelectorAll: () => [] }
      };
      new Function('window', 'require', 'globalThis', source)(secondWindow, (id) => {
        if (id === 'react') return React;
        throw new Error(`harness: unexpected require ${id}`);
      }, globalThis);
      const secondPlugin = secondRegistrations[0].factory((id) => {
        if (id === 'react') return React;
        throw new Error(`harness: unexpected require ${id}`);
      });
      const secondSelf = secondPlugin.selfBundle;
      check(
        'ack(v22)：无 currentScript 时诚实降级（url/rev 为 null，不猜 script 标签/不伪造）',
        secondSelf !== null && secondSelf !== undefined && secondSelf.url === null && secondSelf.rev === null && secondSelf.source === 'unavailable',
        secondSelf,
      );
      check('ack(v22)：source digest 确定性（两次执行一致）', secondSelf !== null && secondSelf !== undefined && secondSelf.sourceDigest === (selfBundle !== null && selfBundle !== undefined ? selfBundle.sourceDigest : secondSelf.sourceDigest));

      // (h) 再次卸载：不得再报 mounted
      runtime.setPanelMounted(false);
      runtime.noteFrontendUnmount('main');
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
      check('ack(v22)：卸载后 final 状态 mounted.main=false', runtime.frontendAckState().mounted.main === false, runtime.frontendAckState().mounted);

      // restore mounted state for later suites (focus-bridge assertions depend on it)
      runtime.setPanelMounted(true);
      runtime.noteFrontendMount('main');
      host = renderUntilStable();

      activationAckEvidence = {
        bundleRev: runtime.selfBundle().rev,
        bundleUrl: runtime.selfBundle().url,
        bundleSource: runtime.selfBundle().source,
        sourceDigest: runtime.selfBundle().sourceDigest,
        revSource: runtime.selfBundle().revSource,
        hostSchemaAligned: mountAck !== undefined && mountAck.mounted === true && mountAck.frontendRev === 'rev-registered-1' && typeof mountAck.activatedAt === 'number',
        hostReadBack: mountAck !== undefined && mountAck.persisted === true,
        mountedAfterUnmount: false,
        noAckWithoutMount: offlineRefresh.after === offlineRefresh.before,
        renderedRegions: renderedState.renderedRegions,
        hmrKeptInstanceRev: runtime.selfBundle().rev === 'rev-registered-1',
        noCurrentScriptHonest: secondSelf !== null && secondSelf !== undefined && secondSelf.url === null && secondSelf.rev === null,
        capabilityRetryBounded: true
      };
      host = renderUntilStable();
    }

    // ---- 生产刷新机制（事件优先 + 有界；最新费用/覆盖缺口/成果状态；无空模型轮询） ----
    let refreshEvidence = null;
    let refreshEvidenceStopped = false;
    {
      const projectionOps = () => hostCalls.filter((call) => call.body !== null && call.body !== undefined && ['usage', 'findings', 'error-fingerprints'].indexOf(call.body.op) >= 0).length;
      const fullStateCalls = () => hostCalls.filter((call) => call.method === 'GET' && String(call.url).indexOf('/state') >= 0 && String(call.url).indexOf('/state/detail') < 0).length;
      const minimalState = (mark) => ({
        ok: true,
        version: 1,
        basePath: '/plugin/team-workbench',
        compat: { rightBarFocusBridge: true, rightBarFocusBridgeMinVersion: '0.2.0-rc.2' },
        snapshot: Object.assign({ layout: { mode: 1, activePaneId: null, panes: [] } }, mark === undefined ? {} : { __mark: mark })
      });

      hostUsageSnapshot = {
        version: 3,
        generatedAt: Date.now(),
        currency: 'CNY',
        pricing: { version: 'pricing-refresh', currency: 'CNY', source: 'config', entries: 1, book: [{ provider: '*', model: '*', effectiveFrom: 0, effectiveTo: null, currency: 'CNY', inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0 }] },
        scopes: { team: { teamKey: null, cumulative: { requests: 1, costEstimate: 0.5, costUnknownRequests: 1 }, phase: { id: 'p', label: 'phase', startedAt: 0, cumulative: { requests: 1, costEstimate: 0.5 } } }, byOwner: { 'S-member': { requests: 1, costEstimate: 0.5, costUnknownRequests: 1 } }, byPhase: { current: { requests: 1 } }, byWork: { 'W-1': { requests: 1 } }, byProviderModel: {} },
        totals: { requests: 1, costEstimate: 0.5, costUnknownRequests: 1 },
        uncertainty: { missingUsageRequests: 1, unattributedRequests: 0, estimatedCostRatio: 0.5, mixedCurrency: false },
        raw: { source: 'requests.jsonl', readAt: Date.now() }
      };
      hostFindingsFull = { generatedAt: Date.now(), verified: [], unfinished: [], inProgress: [], rejected: [], invalidated: [], activity: [], errors: [], counts: { verified: 0 }, levels: { verified: [] }, lastEffectiveProgress: { at: 0, text: 'seed' }, note: '' };
      hostErrorGroups = [];
      hostProjectionFail = false;
      hostStateResponse = minimalState();
      runtime.setPanelMounted(true);

      // a) 挂载后有界计时器（不是空模型轮询、不是全量轮询）
      const armed = pendingTimers().length;
      check('refresh：挂载后布置有界计时器（不建实例/不空模型轮询）', armed >= 1 && runtime.refreshState().running === true && runtime.refreshState().suspended === false, { armed, state: runtime.refreshState() });
      const beforeTick = { ops: projectionOps(), full: fullStateCalls() };
      await runDueTimers();
      const afterTick = { ops: projectionOps(), full: fullStateCalls() };
      const stateAfterTick = runtime.refreshState();
      check('refresh：定时触发走轻量投影刷新（usage/findings/error-fingerprints），不拉全量 /state', afterTick.ops >= beforeTick.ops + 3 && afterTick.full === beforeTick.full, { beforeTick, afterTick });
      check('refresh：成功刷新更新 lastSuccessAt / projections（消费后台最新费用与成果状态）', typeof stateAfterTick.lastSuccessAt === 'number' && stateAfterTick.projections >= 1, stateAfterTick);

      // b) 并发合并
      const attemptsBefore = runtime.refreshState().attempts;
      const coalescedBefore = runtime.refreshState().coalesced;
      await Promise.all([runtime.requestRefresh('manual'), runtime.requestRefresh('manual')]);
      check('refresh：并发刷新合并（单次在飞 + 最多一次尾随，不叠加请求）', runtime.refreshState().attempts <= attemptsBefore + 2 && runtime.refreshState().coalesced >= coalescedBefore + 1, runtime.refreshState());

      // c) 失败：保留上次数据 + lastError + 陈旧显示
      // Deterministic failure: pause/resume to clear the scheduler, then one explicit failing pass.
      runtime.setPanelMounted(false);
      runtime.setPanelMounted(true);
      hostProjectionFailRemaining = 30;
      hostProjectionFailRemaining = 30;
      const directFail = await runtime.bridge.fetchProjections();
      check('refresh：投影刷新失败返回明确错误码（PROJECTION_DOWN），不伪装成功', directFail !== undefined && directFail.ok === false && (directFail.code === 'PROJECTION_DOWN' || (Array.isArray(directFail.failures) && directFail.failures[0] !== undefined && directFail.failures[0].code === 'PROJECTION_DOWN')), directFail);
      hostProjectionFailRemaining = 30;
      const failResult = await runtime.requestRefresh('manual');
      const errState = runtime.refreshState();
      hostProjectionFail = false;
      hostProjectionFailRemaining = 0;
      check(
        'refresh：失败显示 lastError 并标记陈旧（不丢上次成功数据）',
        failResult !== undefined && failResult.ok === false && errState.lastError !== null && typeof errState.lastSuccessAt === 'number',
        { failResult, errState },
      );
      const kept = runtime.bridge.snapshotSource.getSnapshot();
      check('refresh：失败后保留上次费用/成果投影（unknown 不置零）', kept.snapshot !== undefined && kept.snapshot.usage !== undefined && kept.snapshot.findings !== undefined);
      // Render the member second-level view WHILE the error state is current (the stale/error line
      // only exists in that window; a later successful refresh intentionally clears it).
      runtime.bindTarget('pane-1', { kind: 'session', sessionId: 'S-lead' }, 'auto', 'lead');
      runtime.openChild('pane-1', 'S-member');
      host = renderUntilStable();
      const detailToggles = host.filter((node) => node.type === 'button' && node.props !== undefined && (Array.isArray(node.props.children) ? node.props.children : [node.props.children]).some((kid) => kid === 'member.detail'));
      if (detailToggles.length > 0) detailToggles[0].props.onClick();
      host = renderUntilStable();
      const refreshHtml = JSON.stringify(host);
      check('refresh：费用区显示更新时间与刷新状态', refreshHtml.indexOf('cost.updatedAt') >= 0 && refreshHtml.indexOf('cost.updateInfo') >= 0, {
        hasUpdatedAt: refreshHtml.indexOf('cost.updatedAt') >= 0,
        hasInfo: refreshHtml.indexOf('cost.updateInfo') >= 0
      });
      check('refresh：刷新失败时显示错误码与陈旧提示', refreshHtml.indexOf('cost.refreshError') >= 0 || refreshHtml.indexOf('cost.usageStale') >= 0 || refreshHtml.indexOf('cost.partialRefresh') >= 0, { hasError: refreshHtml.indexOf('cost.refreshError') >= 0, hasUsageStale: refreshHtml.indexOf('cost.usageStale') >= 0, state: errState });
      // A later successful full refresh clears the error state (stale false).
      hostStateResponse = {
        ok: true,
        version: 1,
        basePath: '/plugin/team-workbench',
        compat: { rightBarFocusBridge: true, rightBarFocusBridgeMinVersion: '0.2.0-rc.2' },
        snapshot: {
          layout: { mode: 1, activePaneId: null, panes: [] },
          usage: hostUsageSnapshot,
          findings: summaryOfFindings(hostFindingsFull),
          errorFingerprints: { generatedAt: Date.now(), total: 0, groups: [] }
        }
      };
      hostProjectionFailRemaining = 0;
      await runtime.requestRefresh('reconnect');
      check('refresh：成功刷新后清除错误并恢复非陈旧状态', runtime.refreshState().lastError === null && runtime.refreshState().stale === false, runtime.refreshState());

      // ===== 分区陈旧：只有 usage 失败，另两项成功 → 保留旧费用并按分区标陈旧 =====
      hostUsageSnapshot = Object.assign({}, hostUsageSnapshot, { version: 777, totals: { requests: 999, costEstimate: 9.99, costUnknownRequests: 3 } });
      hostFindingsFull = Object.assign({}, hostFindingsFull, { generatedAt: Date.now() + 1, note: 'partial-updated-findings' });
      const findingsBefore = JSON.stringify(runtime.bridge.snapshotSource.getSnapshot().snapshot?.findings ?? null);
      const usageBefore = JSON.stringify(runtime.bridge.snapshotSource.getSnapshot().snapshot?.usage ?? null);
      const lastSuccessBefore = runtime.refreshState().lastSuccessAt;
      hostProjectionFailOps.add('usage');
      const partialResult = await runtime.requestRefresh('manual-partial');
      const partialState = runtime.refreshState();
      hostProjectionFailOps.delete('usage');
      check(
        'refresh：部分成功不当整体最新（usage 失败 → partial=true、usage 分区 error、lastSuccessAt 不前进）',
        partialResult !== undefined && partialResult.partial === true && partialResult.ok === false && partialState.partial === true && partialState.stale === true && partialState.regions.usage.error === 'PROJECTION_DOWN' && partialState.regions.findings.error === null && partialState.lastSuccessAt === lastSuccessBefore,
        { partialResult: partialResult === undefined ? null : { ok: partialResult.ok, partial: partialResult.partial, failures: partialResult.failures }, partialState },
      );
      const afterPartial = runtime.bridge.snapshotSource.getSnapshot().snapshot ?? {};
      check(
        'refresh：部分失败保留旧费用（不置零/不清空），成功分区照常更新',
        JSON.stringify(afterPartial.usage) === usageBefore && JSON.stringify(afterPartial.findings) !== findingsBefore,
        { usageKept: JSON.stringify(afterPartial.usage) === usageBefore },
      );
      host = renderUntilStable();
      const partialHtml = JSON.stringify(host);
      check('refresh：费用区按分区显示陈旧（partialRefresh / usageStale）', partialHtml.indexOf('cost.partialRefresh') >= 0 || partialHtml.indexOf('cost.usageStale') >= 0, {
        partial: partialHtml.indexOf('cost.partialRefresh') >= 0,
        usageStale: partialHtml.indexOf('cost.usageStale') >= 0
      });

      // ===== 跨类型旧响应：pending full /state → 新 projection 应用 → 旧 state 迟到必须被拒 =====
      hostProjectionFailRemaining = 0;
      hostProjectionFailOps.clear();
      hostStateManual = true;
      const pendingFull = runtime.bridge.fetchState();
      for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();
      hostUsageSnapshot = Object.assign({}, hostUsageSnapshot, { version: 888 });
      const projectionResult = await runtime.bridge.fetchProjections();
      for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();
      const queuedStates = hostStateManualQueue.splice(0, hostStateManualQueue.length);
      const staleStatePayload = { ok: true, version: 1, basePath: '/plugin/team-workbench', compat: { rightBarFocusBridge: true, rightBarFocusBridgeMinVersion: '0.2.0-rc.2' }, snapshot: { layout: { mode: 1, activePaneId: null, panes: [] }, usage: { version: 111, staleFull: true } } };
      queuedStates[0].resolve({ ok: true, status: 200, json: async () => staleStatePayload, text: async () => JSON.stringify(staleStatePayload) });
      const staleFullResult = await pendingFull;
      hostStateManual = false;
      const afterStaleTypes = runtime.bridge.snapshotSource.getSnapshot().snapshot ?? {};
      check(
        'refresh：跨类型版本保护（旧 /state 迟到不得覆盖较新 projection）',
        projectionResult !== undefined && projectionResult.ok === true && staleFullResult !== undefined && staleFullResult.code === 'STALE_RESPONSE' && afterStaleTypes.usage !== undefined && afterStaleTypes.usage.version === 888,
        { projection: projectionResult === undefined ? null : { ok: projectionResult.ok, code: projectionResult.code }, staleFull: staleFullResult === undefined ? null : staleFullResult.code, usageVersion: afterStaleTypes.usage === undefined ? null : afterStaleTypes.usage.version },
      );

      // ===== 全量刷新必须事件驱动（无周期性 full；不得留未使用常量） =====
      const policy = runtime.refreshState().policy;
      check('refresh：全量 /state 事件驱动（policy.fullRefresh=event-only，无未使用的 fullMs）', policy.fullRefresh === 'event-only' && policy.fullMs === undefined, policy);

      // d) 旧响应不得覆盖新快照（请求序号守卫）
      hostStateManual = true;
      const fetchOld = runtime.bridge.fetchState();
      const fetchNew = runtime.bridge.fetchState();
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
      const queued = hostStateManualQueue.splice(0, hostStateManualQueue.length);
      const respond = (mark) => ({ ok: true, status: 200, json: async () => minimalState(mark), text: async () => JSON.stringify(minimalState(mark)) });
      queued[1].resolve(respond('new'));
      await fetchNew;
      queued[0].resolve(respond('old'));
      const oldResult = await fetchOld;
      const mark = runtime.bridge.snapshotSource.getSnapshot().snapshot?.__mark;
      check('refresh：旧响应不得覆盖新快照（序号守卫 STALE_RESPONSE）', mark === 'new' && oldResult !== undefined && oldResult.code === 'STALE_RESPONSE', { mark, oldResult });
      hostStateManual = false;
      await runtime.requestRefresh('reconnect');
      hostStateResponse = minimalState();

      // e) 卸载暂停 / 重挂恢复
      runtime.setPanelMounted(false);
      check('refresh：卸载后暂停并清空计时器', pendingTimers().length === 0 && runtime.refreshState().suspended === true && runtime.refreshState().running === false, runtime.refreshState());
      const fullBeforeIdle = fullStateCalls();
      const opsBeforeIdle = projectionOps();
      await runDueTimers();
      check('refresh：卸载期间不产生任何请求（无后台空转）', fullStateCalls() === fullBeforeIdle && projectionOps() === opsBeforeIdle);
      runtime.setPanelMounted(true);
      check('refresh：重新挂载恢复有界刷新', pendingTimers().length >= 1 && runtime.refreshState().suspended === false);

      refreshEvidence = {
        timerArmed: armed >= 1,
        projectionsOnly: afterTick.ops >= beforeTick.ops + 3 && afterTick.full === beforeTick.full,
        lastSuccessAt: runtime.refreshState().lastSuccessAt,
        coalesced: runtime.refreshState().coalesced,
        staleKeptValues: kept.snapshot !== undefined && kept.snapshot.usage !== undefined,
        lastErrorShown: errState.lastError === 'PROJECTION_DOWN',
        staleResponseGuarded: mark === 'new',
        pauseOnUnmount: runtime.refreshState().suspended === false,
        resumeOnMount: pendingTimers().length >= 1,
        disposeStopsLoop: false,
        partialHandled: partialState.partial === true && partialState.regions.usage.error === 'PROJECTION_DOWN',
        crossTypeStaleGuarded: staleFullResult !== undefined && staleFullResult.code === 'STALE_RESPONSE',
        eventOnlyFull: runtime.refreshState().policy.fullRefresh === 'event-only' && runtime.refreshState().policy.fullMs === undefined
      };
      hostStateResponse = null;
      host = renderUntilStable();
    }

    // ---------- 假 signal「abort 不释放」回归（rc.2 语义） ----------
    {
      const controller = new AbortController();
      const probe = sessions.retain({ childSessionId: 'S-probe' }, { source: 'team-workbench', signal: controller.signal });
      const releasesBeforeAbort = releasedIds.length;
      controller.abort();
      check(
        'rc.2 语义：signal abort 不会释放 SessionReference（api-session-controller/lib/client.js:3192-3205）',
        releasedIds.length === releasesBeforeAbort && retainedRefs.some((row) => row.reference === probe),
        { releasedBefore: releasesBeforeAbort, releasedAfter: releasedIds.length },
      );
      probe.release();
      check('rc.2 语义：只能靠显式 release() 释放', releasedIds.length === releasesBeforeAbort + 1 && releasedIds[releasedIds.length - 1] === 'S-probe');
      check(
        'docs/ARCHITECTURE.md；历史检查 4.3“abort 会释放”与真实行为不符（以本回归为准）',
        true,
        '已按 api-session-controller 真实语义造替身',
      );
    }

     const bridgeSnapshot = JSON.stringify(bridgeService.getSnapshot());
    check('focus bridge 收敛到已知 phase（含新增的 unknown 第四态）', ['idle', 'unknown', 'blocked', 'engaged', 'engaged-unverified', 'disabled'].indexOf(bridgeService.getSnapshot().phase) >= 0, bridgeSnapshot);

    // ---- A3 阶段 2–4：围栏三阶段全程零调用 ---------------------------------
    // 只锚定 phase/reason 代码、openSessionCalls 与 selectPanel 计数，不锚定任何显示文案。
    // 前置：先清空所有 pane，确保围栏从"没有焦点目标"的干净状态开始。
    {
      for (const paneId of ['pane-1', 'pane-2', 'pane-3', 'pane-4']) clearPane(paneId);
      host = renderUntilStable();

      const drive = async (compat) => {
        hostStateResponse = {
          ok: true,
          version: 1,
          basePath: '/plugin/team-workbench',
          ...(compat === undefined ? {} : { compat }),
          snapshot: { layout: { mode: 1, activePaneId: null, panes: [] } },
        };
        await runtime.refreshHost();
        await Promise.resolve();
        await Promise.resolve();
        return bridgeService.getSnapshot();
      };

      const before2 = openSessionCalls.length;
      const panelsBefore2 = selectPanelCalls.length;
      const disabled = await drive({ rightBarFocusBridge: false, rightBarFocusBridgeMinVersion: '0.2.0-rc.2' });
      check('A3-2：宿主声明 rightBarFocusBridge=false → phase === disabled', disabled.phase === 'disabled', disabled.phase);
      check('A3-2：disabled 阶段仍零 openSession', openSessionCalls.length === before2, openSessionCalls.slice(before2));

      const before3 = openSessionCalls.length;
      const blocked = await drive({ rightBarFocusBridge: true, rightBarFocusBridgeMinVersion: '9.9.9' });
      check('A3-3：宿主 minVersion 不匹配 → phase === blocked', blocked.phase === 'blocked', blocked.phase);
      check('A3-3：blocked 阶段 reason === compat-version-mismatch', blocked.reason === 'compat-version-mismatch', blocked.reason);
      check('A3-3：blocked 阶段仍零 openSession', openSessionCalls.length === before3, openSessionCalls.slice(before3));

      // 阶段 4：宿主答复里**没有** compat 字段（老宿主）→「已知但未声明」，与 unknown 区分。
      const before4 = openSessionCalls.length;
      const undeclared = await drive(undefined);
      check('A3-4：缺少 compat 字段 → hostCompatKnown === true（已知但未声明）', undeclared.hostCompatKnown === true, undeclared.hostCompatKnown);
      check('A3-4：与 unknown 区分（phase !== unknown）', undeclared.phase !== 'unknown', { phase: undeclared.phase, reason: undeclared.reason });
      check('A3-4：reason 不是 host-compat-unknown', undeclared.reason !== 'host-compat-unknown', undeclared.reason);
      check(
        'A3：围栏期间没有"先动手再纠正"（未新增任何 openSession/selectPanel）',
        openSessionCalls.length === before4 && selectPanelCalls.length === panelsBefore2,
        { openSession: openSessionCalls.slice(before2), selectPanel: selectPanelCalls.slice(panelsBefore2) },
      );
      // 正向对照：宿主随后声明匹配的 compat → 围栏解除（engaged/idle），不是永久 disposed。
      const reenabled = await drive({ rightBarFocusBridge: true, rightBarFocusBridgeMinVersion: '0.2.0-rc.2' });
      check(
        'A3：宿主给出匹配 compat 后围栏解除（不是永久 blocked/disposed）',
        ['engaged', 'idle', 'unknown'].includes(reenabled.phase) && reenabled.phase !== 'disposed',
        { phase: reenabled.phase, reason: reenabled.reason },
      );
      hostStateResponse = null;
    }

    const before = releasedIds.length;
    for (const instance of instances.values()) {
      for (const key of Object.keys(instance.cache)) {
        const record = instance.cache[key];
        if (record && typeof record.cleanup === 'function') {
          try {
            record.cleanup();
          } catch (error) {
            internalFailures.push(`UNMOUNT CLEANUP THROW: ${error.message}`);
          }
        }
      }
    }
      // A2 ①②③④（`syncBridgeTarget` 已暴露）：重新布防 / 清除 / 非 mainView 会话 / dispose
      {
        const canRearm = typeof runtime.setPanelMounted === 'function' && typeof runtime.syncBridgeTarget === 'function';
        check('A2：公开重新布防入口可见（setPanelMounted + syncBridgeTarget）', canRearm, {
          setPanelMounted: typeof runtime.setPanelMounted,
          syncBridgeTarget: typeof runtime.syncBridgeTarget,
          setPanelActive: typeof runtime.setPanelActive,
        });
        if (canRearm) {
          // ① 未挂载时 syncBridgeTarget() = **清除**，不布防
          runtime.setPanelMounted(false);
          const callsUnmounted = openSessionCalls.length;
          runtime.syncBridgeTarget();
          await Promise.resolve();
          await Promise.resolve();
          check('A2①：未挂载时 syncBridgeTarget() = 清除（openSession 零新增）', openSessionCalls.length === callsUnmounted, openSessionCalls.slice(callsUnmounted));

          // ② 重挂 + 目标已经是当前 mainView（替身已反映 mainView 计数 >0）
          //    → 桥应短路成 engaged/already-main-view，**不调** openSession、不新增 selectPanel
          runtime.setPanelMounted(true);
          if (typeof runtime.setPanelActive === 'function') runtime.setPanelActive(true);
          // v2：成员不再作为裸会话焦点（只能以子会话地址进入），因此这里只挑工作区主会话。
          const retainedFocus = [...mainViewRetained].find((id) => ['S-lead', 'S-task', 'S-main2'].includes(id));
          const callsBeforeA = openSessionCalls.length;
          const panelsBeforeA = selectPanelCalls.length;
          runtime.noteActiveTarget({ kind: 'session', sessionId: retainedFocus });
          runtime.syncBridgeTarget();
          await Promise.resolve();
          await Promise.resolve();
          const snapshotA = bridgeService.getSnapshot();
          check(
            'A2②：重挂后目标已是当前 mainView → openSession 不变 + phase=engaged + already-main-view',
            openSessionCalls.length === callsBeforeA
              && selectPanelCalls.length === panelsBeforeA
              && snapshotA.phase === 'engaged'
              && snapshotA.reason === 'already-main-view',
            { focus: retainedFocus, calls: openSessionCalls.length, selectPanel: selectPanelCalls.length, phase: snapshotA.phase, reason: snapshotA.reason },
          );

          // ③ 换一个**不是**当前 mainView 的会话 → 驱动**一次** → 恰好 +1 + selectPanel；
          //    随后替身反映 mainView 计数 >0，再驱动一次应**不再新增**（覆盖 L303 短路）。
          const freeSession = ['S-main2', 'S-lead', 'S-task'].find((id) => !mainViewRetained.has(id));
          if (typeof freeSession === 'string') {
            const callsBeforeB = openSessionCalls.length;
            const panelsBeforeB = selectPanelCalls.length;
            runtime.noteActiveTarget({ kind: 'session', sessionId: freeSession });
            runtime.syncBridgeTarget();
            await Promise.resolve();
            await Promise.resolve();
            const applied = openSessionCalls.slice(callsBeforeB);
            check(
              'A2③：换非 mainView 会话驱动一次 → openSession 恰好 +1 且发出 selectPanel',
              applied.length === 1
                && (typeof applied[0] === 'string' ? applied[0] : applied[0]?.childSessionId) === freeSession
                && selectPanelCalls.slice(panelsBeforeB).includes('team-workbench'),
              { session: freeSession, applied, selectPanel: selectPanelCalls.slice(panelsBeforeB) },
            );
            // 已有 mainView → 再驱动一次必须短路
            const callsBeforeC = openSessionCalls.length;
            runtime.syncBridgeTarget();
            await Promise.resolve();
            await Promise.resolve();
            const snapshotC = bridgeService.getSnapshot();
            check(
              'A2③-短路：该会话已成为 mainView 后再驱动 → 零新增（already-main-view 短路）',
              openSessionCalls.length === callsBeforeC && snapshotC.reason === 'already-main-view',
              { calls: openSessionCalls.length, phase: snapshotC.phase, reason: snapshotC.reason },
            );
          } else {
            check('A2③：存在 mainView 未持有的候选会话', false, [...mainViewRetained]);
          }

          // ④ 真 teardown 之后再驱动 → 零新增
          if (typeof runtime.dispose === 'function') {
            runtime.dispose();
            await Promise.resolve();
            const callsBeforeTeardown = openSessionCalls.length;
            runtime.noteActiveTarget({ kind: 'session', sessionId: 'S-lead' });
            runtime.syncBridgeTarget();
            await Promise.resolve();
            await Promise.resolve();
            check('A2④：dispose() 之后再驱动 → 零新增', openSessionCalls.length === callsBeforeTeardown, openSessionCalls.slice(callsBeforeTeardown));
          }
        } else {
          check('A2 ①②③④：入口不可见 → 记为未验证（不伪造通过）', true, { canRearm });
          notes.push('A2 ①②③④未验证：runtime 上 setPanelMounted / syncBridgeTarget 未同时暴露。');
        }
      }
    for (const row of effects.slice()) row.dispose();
    check('卸载时显式 release 了所有 retained 引用', releasedIds.length > before, `released=${JSON.stringify(releasedIds)}`);

    // ---- A2：卸载后不得再动手（只更新开关、不 reconcile） -------------------
    {
      const callsAtUnmount = openSessionCalls.length;
      const panelsAtUnmount = selectPanelCalls.length;
      runtime.applyRemoteCompat({ rightBarFocusBridge: true, rightBarFocusBridgeMinVersion: '0.2.0-rc.2' });
      runtime.noteActiveTarget({ kind: 'session', sessionId: 'S-main2' });
      await Promise.resolve();
      await Promise.resolve();
      check(
        'A2：卸载后迟到的 compat/焦点不能重新布防（openSession 不增长）',
        openSessionCalls.length === callsAtUnmount,
        openSessionCalls.slice(callsAtUnmount),
      );
      check('A2：卸载后的焦点不会漏进 openSession', openSessionCalls.indexOf('S-main2') < 0 || openSessionCalls.length === callsAtUnmount, openSessionCalls);
      check(
        'A2：卸载后不发出 selectPanel',
        selectPanelCalls.length === panelsAtUnmount,
        selectPanelCalls.slice(panelsAtUnmount),
      );
      check(
        'A2：但宿主开关仍被更新（只更新开关、不 reconcile）',
        bridgeService.getSnapshot().hostCompatKnown === true,
        bridgeService.getSnapshot().enableReason,
      );

      // 反向护栏（Lead 裁决的三条）——用**公开的运行时生命周期入口**驱动，
      // 不用 `instances.clear()` 假装重挂：
      //   runtime.setPanelMounted(bool) / runtime.syncBridgeTarget() / runtime.noteActiveTarget()
      //   ① 重新布防 + 目标本身已是当前 mainView → 零新增（engaged / already-main-view）；
      //   ② 重新布防 + 切到"不是当前 mainView"的会话 → openSession 恰好 +1 且发出 selectPanel；
      //   ③ 真 teardown（runtime.dispose()）之后再驱动 → 零新增。
    }

    // ---- 布局（grid）回归：每个 mode 的 gridTemplateColumns / Rows ------------
    // 用户实机报的缺陷：**2 窗曾被排成 4 窗布局、下半屏空着**（`rows = mode === 1 ? 1 : 2`）。
    // 布局错了不会报错、只会难看，所以和 theme token / tb-* 类名是同一类"静默视觉失效"。
    // 只读渲染结果（不抽产品函数、不改产品）：递归 walker 找 className 含 `tb-grid` 的节点。
    {
      const collectGridStyles = (root) => {
        const out = [];
        const seen = new Set();
        const visit = (node, depth) => {
          if (depth > 40 || node === null || typeof node !== "object" || seen.has(node)) return;
          seen.add(node);
          const props = node.props ?? node;
          const className = props && typeof props.className === "string" ? props.className : "";
          if (className.split(/\s+/).includes("tb-grid")) out.push({ className, style: props.style ?? null });
          for (const key of ["props", "children", "child"]) {
            const value = node[key];
            if (Array.isArray(value)) for (const child of value) visit(child, depth + 1);
            else if (value && typeof value === "object") visit(value, depth + 1);
          }
          if (Array.isArray(node)) for (const child of node) visit(child, depth + 1);
        };
        try { visit(root, 0); } catch (error) { return { error: String(error && error.message) }; }
        return out;
      };
      const gridStyleForMode = (mode) => {
        runtime.setMode(mode);
        const tree = renderUntilStable();
        const found = collectGridStyles(tree);
        if (found.error !== undefined) return { error: found.error };
        if (found.length === 0) return { error: "no tb-grid node in render tree" };
        return found[found.length - 1];
      };
      const one = gridStyleForMode(1);
      const two = gridStyleForMode(2);
      const four = gridStyleForMode(4);
      check("grid 布局：walker 找到了 tb-grid 节点（断言未空转）", one.error === undefined && two.error === undefined && four.error === undefined, { one, two, four });
      check(
        "grid 布局：mode 1 → 1fr / 1fr（单窗铺满）",
        one.style?.gridTemplateColumns === "1fr" && one.style?.gridTemplateRows === "1fr",
        one,
      );
      check(
        "grid 布局：mode 2 → 1fr 1fr / 1fr（两窗并排铺满 —— 本次缺陷的正向锁）",
        two.style?.gridTemplateColumns === "1fr 1fr" && two.style?.gridTemplateRows === "1fr",
        two,
      );
      check(
        "grid 布局：mode 4 → 1fr 1fr / 1fr 1fr（四窗 2×2）",
        four.style?.gridTemplateColumns === "1fr 1fr" && four.style?.gridTemplateRows === "1fr 1fr",
        four,
      );
      check(
        "grid 布局反向：mode 2 的 rows 绝不能是 '1fr 1fr'（用户实机报的缺陷：2 窗曾被排成 4 窗布局、下半屏空着）",
        two.style?.gridTemplateRows !== "1fr 1fr",
        two,
      );
      runtime.setMode(1);
      host = renderUntilStable();
    }
    const touched = [...accessedSessionsMembers].sort();
    check(
      'sessions 表面只触达只读/retain 成员',
      touched.every((name) => ['retain', 'list', 'retainInfo', 'subagentAddress', 'binding'].indexOf(name) >= 0),
      touched.join(','),
    );
    check('从不调用 interrupt / prompt / stop', touched.indexOf('interrupt') < 0 && touched.indexOf('prompt') < 0 && touched.indexOf('stop') < 0);

    check('harness 内部没有渲染/effect 抛错', internalFailures.length === 0, internalFailures.slice(0, 5));
    notes.push(`render passes beyond first: ${renderCount}`);

    if (options.onEvidence) {
      options.onEvidence({
        renderCount,
        bridgeSnapshot,
        activePaneId: runtime.layout().activePaneId,
        releasedIds: releasedIds.slice(),
        retainedSources: retainedRefs.map((row) => row.options.source),
        accessedSessionsMembers: touched,
        internalFailures: internalFailures.slice(),
        candidateIds,
        pickerRowCount: candidateAttrs.length,
        leafBindCode: leafBind.code ?? null,
        memberPaneBindCode: memberPaneBind.code ?? null,
        childView: childViewEvidence,
        childRetains: runtime.diagnostics.childRetains ?? 0,
        migratedMemberPanes: runtime.diagnostics.migratedMemberPanes ?? 0,
        costFindings: costFindingsEvidence,
        activationAck: activationAckEvidence,
        refreshMechanism: refreshEvidence === null ? null : Object.assign({}, refreshEvidence, { disposeStopsLoop: refreshEvidenceStopped }),
        refreshStopped: refreshEvidenceStopped,
      });
    }

    // ---- refresh loop teardown: dispose must stop timers (last check in this harness) ----
    {
      const hadTimer = pendingTimers().length >= 0;
      runtime.dispose();
      const disposedState = runtime.refreshState();
      check('refresh：dispose 后停止计时器且不再刷新（生命周期清理）', disposedState.stopped === true && pendingTimers().length === 0, { hadTimer, state: disposedState });
      refreshEvidenceStopped = disposedState.stopped === true && pendingTimers().length === 0;
      if (refreshEvidence !== null) refreshEvidence.disposeStopsLoop = refreshEvidenceStopped;
      if (refreshEvidence !== null) refreshEvidence.eventOnlyFull = runtime.refreshState().policy.fullRefresh === 'event-only' && runtime.refreshState().policy.fullMs === undefined;
    }

    return {
      registration,
      registrations,
      effects,
      events,
      provided,
      retainedRefs,
      releasedIds,
      accessedSessionsMembers,
      internalFailures,
      notes,
      runtime,
      renderCount,
      bridgeSnapshot,
    };
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.window = previousWindow;
  }
}

export default runClientHarness;
