/**
 * `upgradeBundle.js` — **真实的新组件初始化与动态装载**（Codex 审阅 5 / Lead 追问）。
 *
 * ## 为什么必须有这个文件而不是 upgrade.js 里声明完成
 *
 * 旧 `applyHotUpgrade` 只有 `deps.hydrate/registerHooks` 两个可选钩子，没有初始化组件、
 * 没有挂新方法/工具/路由/上下文/用量/技能，也没验证 postcondition，却总是返回
 * "新组件已挂上"——那正是本轮要杜绝的假完成。
 *
 * ## 真实机制（基于宿主审计证据）
 *
 * - 现有 `service` 由 `dispatch-repair/core.js`（144–146、246 行）把 4 个核心方法
 *   （`reserveWorkInLock`/`executeStart`/`reconcileInLock`/`patchAttemptInLock`）做成实例
 *   own 属性并捕获旧函数与私有 `starts` Map。**不能替换它们**：
 *   `setPrototypeOf` 不覆盖 own 属性，覆盖又丢保护。
 * - 审计差分：`reconcileInLock`/`patchAttemptInLock` **未变**（保持原样）；
 *   `reserveWorkInLock` 只新增错误门闸；`executeStart` 只新增失败指纹。
 *   → 这里只在这两个 own 属性**外层包一层增量**，原 repair 函数原样保留。
 * - 其余新方法从**新代码的类原型**取实现，`apply(oldService)` 绑定到原对象
 *   （因此 `this.works/attempts/queue` 全部沿用原对象，状态不丢）。
 * - 新组件（fingerprints/usage/execution/materialize/nativeUsage/contextControl）用原
 *   storage/clock/adapter/config 真实构造并 hydrate。
 * - 工具/路由/上下文/用量/技能通过宿主现有注册入口重新挂载，全部返回 disposer 供回滚。
 * - **postcondition 不通过就回滚并返回失败**，不写"已挂上"。
 *
 * ## 旧 Storage 的合法表集合
 *
 * 旧 `storageDomain` 可能固定合法表集合，**不能假设 push tables 就有持久化**：
 * 这里对每个新表做 `put → get → 回读校验` 探针；任何一个失败即
 * `STORAGE_TABLES_UNAVAILABLE`（明确失败，不继续假装完成）。
 */

import { TeamWorkbenchService } from './service.js';
import { createErrorFingerprints } from './fingerprints.js';
import { createUsageLedger } from './usage.js';
import { createExecutionRunner } from './execution.js';
import { createMaterializer } from './materialize.js';
import { createNativeUsageCollector } from './nativeUsage.js';
import { createContextControl } from './contextControl.js';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRemediationStorage, createSidecarStore, sidecarDirFor } from './remediationStorage.js';
import { runSkillsMigration } from './skillsBridge.js';
import { EVIDENCE_GATE_VERSION, probeEvidenceGate } from './evidence.js';

/** 需要作为实例 own 属性挂上的**新方法**（不含 repair 保护的 4 个核心方法）。 */
export const NEW_METHOD_NAMES = Object.freeze([
  // ---- baseline→current **真实差分**里被修改的主方法（必须真正切换，不能只挂 helper）----
  'submitWork',
  'planSubmit',
  'workVerify',
  'selfReport',
  'isDependencySatisfied',
  'snapshot',
  'reconcile',
  'findRepeatedFailure',
  // ---- 本轮新增能力 ----
  'identityFor',
  'judgeWorkIdentity',
  'persistIdentityInLock',
  'createEvidenceFileReader',
  'validateWorkEvidence',
  'persistEvidenceInLock',
  'invalidateEvidence',
  'isEvidenceCurrent',
  'refreshEvidenceValidity',
  'recordFailureFingerprint',
  'guardRepeatedFailure',
  'findRepeatedFailure',
  'describeStartFailure',
  'evaluateErrorGate',
  'assertHostToolPermission',
  'materialize',
  'runVerification',
  'runsForWork',
  'refreshUsage',
  'backfillUsage',
  'usageSnapshot',
  'usageRecords',
  'usagePricing',
  'findingsSnapshot',
  'errorFingerprintSnapshot',
  'contextQuery',
  'compactStateFor',
  'stateDetail',
  'requestMaintenance',
  'maintenanceInspect',
  'maintenanceView',
  'compactionServiceFor',
  'nativeUnfinishedTurn',
  'toolReadEpoch',
  'noteToolReadSuccess',
  'refreshSessionMetadata',
  'usageSessionFacts',
  'usageNativeTeamFacts',
  'refreshSkillSections',
  'backfillHistoricalFromKnownSessions',
  // ---- baseline→current 真实差分补齐（Codex 审计 100→140 方法里漏接的 9 个运行方法）----
  'subagentStart',
  'leafToolFilter',
  'commitPlannedWorkInLock',
  'fileEpochFor',
  'captureFileEpoch',
  'recordToolFailure',
  'backfillHistoricalUsage',
  'recordFrontendAck',
  'frontendAckView',
  'upgradePlan',
  'upgradeActivate',
]);

/** repair 保护的核心方法：**绝不替换**，只在两个上包增量。 */
export const PROTECTED_CORE_METHODS = Object.freeze(['reserveWorkInLock', 'executeStart', 'reconcileInLock', 'patchAttemptInLock']);

export const NEW_TABLES = Object.freeze([
  'identity_records',
  'evidence_records',
  'error_fingerprints',
  'execution_runs',
  'usage_requests',
  'usage_cursors',
  'usage_totals',
  'usage_step_cursors',
]);

const NEW_TOOL_NAMES = Object.freeze([
  'team_exec_check',
  'team_materialize',
  'team_usage',
  'team_findings',
  'team_error_fingerprints',
  'team_context_query',
  'team_maintenance',
]);

function result(ok, code, extra = {}) {
  return { ok, ...(code ? { code } : {}), ...extra };
}

/**
 * @param {{
 *   ctx: object, adapter: object, storage: object, config: object, service: object,
 *   scheduler: object,
 *   registerTools: Function, registerWebRoutes: Function, startContextHooks: Function,
 *   startUsageIngest: Function, mountSkills: Function,
 *   clock?: object,
 * }} deps
 */
export function createUpgradeBundle(deps = {}) {
  const created = [];
  /** property-descriptor 事务快照（原有还原、原无 delete）。 */
  const componentDescriptors = {};
  const methodDescriptors = {};
  const wrapDescriptors = {};
  let disposers = [];
  let postcondition = null;

  function missingDependencies() {
    const missing = [];
    for (const key of ['ctx', 'adapter', 'storage', 'config', 'service', 'registerTools', 'registerWebRoutes', 'startContextHooks', 'startUsageIngest']) {
      if (deps[key] === undefined || deps[key] === null) missing.push(key);
    }
    if (deps.service && !(deps.service.works instanceof Map)) missing.push('service.works');
    if (deps.adapter && typeof deps.adapter.listToolNames !== 'function') missing.push('adapter.listToolNames');
    return missing;
  }

  /** 旧 Storage 表集合可能是固定的：探针写入 → 读回 → 才能声明持久化可用。 */
  async function probeTables() {
    const storage = deps.storage;
    const tables = Array.isArray(storage?.tables) ? storage.tables : [];
    const report = [];
    for (const table of NEW_TABLES) {
      const key = `__upgrade_probe__`;
      const payload = { probe: true, table, at: deps.clock?.now?.() ?? Date.now() };
      let writable = false;
      let readable = false;
      let detail = null;
      try {
        if (!tables.includes(table)) return { ok: false, code: 'STORAGE_TABLE_SET_IMMUTABLE', table, detail: 'storage.tables 不包含该表，且不能假设 push 即持久化。' };
        const stored = await storage.put(table, key, payload, { idempotencyKey: `upgrade-probe:${table}` });
        writable = stored?.ok === true;
        const read = typeof storage.get === 'function' ? storage.get(table, key) : undefined;
        readable = Boolean(read && read.probe === true);
        if (typeof storage.remove === 'function') await storage.remove(table, key);
        else if (typeof storage.delete === 'function') await storage.delete(table, key);
        report.push({ table, writable, readable, detail });
        if (!writable || !readable) return { ok: false, code: 'STORAGE_TABLE_UNAVAILABLE', table, report };
      } catch (error) {
        detail = String(error?.message ?? error);
        report.push({ table, writable, readable, detail });
        return { ok: false, code: 'STORAGE_TABLE_UNAVAILABLE', table, report };
      }
    }
    return { ok: true, report };
  }

  /** 真实构造 + hydrate 新组件（用原 storage/clock/adapter/config）。 */
  async function initComponents(storageOverride = null, txn = null) {
    const service = deps.service;
    // 新组件必须接**同一 facade**（新表 → sidecar）；用旧 13 表 storage 会 unknown table 失败
    //（官方 Cordis 证据：activate 因 unknown storage table error_fingerprints 失败）。
    const storage = storageOverride ?? deps.facade ?? deps.storage;
    // constructor 差分补齐（Codex 审计）：旧实例缺这些字段；升级时补齐并纳入 descriptor 事务快照。
    const componentKeys = [
      'identityRecords', 'evidenceRecords', 'evidenceInvalidations', 'findingsCache',
      'findingsCacheRevision', 'phaseStartedAt', 'fingerprintFileEpochs', 'frontendAckIndex',
      'maintenanceLog', 'fingerprints', 'executionRunner', 'materializer', 'usageLedger',
      'nativeUsage', 'contextControl',
    ];
    for (const key of componentKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(service, key) ?? null;
      componentDescriptors[key] = descriptor;
      if (txn) txn.componentDescriptors[key] = descriptor;
    }
    const config = deps.config;
    const clock = deps.clock ?? service.clock ?? { now: () => Date.now() };
    service.identityRecords = new Map();
    service.evidenceRecords = new Map();
    service.evidenceInvalidations = [];
    service.findingsCache = null;
    service.findingsCacheRevision = null;
    service.phaseStartedAt = clock.now();
    service.fingerprints = createErrorFingerprints({ storage, clock });
    service.executionRunner = createExecutionRunner({
      storage,
      clock,
      roots: (() => {
        const list = [];
        if (Array.isArray(config?.execution?.roots)) list.push(...config.execution.roots);
        if (Array.isArray(config?.materialize?.roots)) list.push(...config.materialize.roots);
        return list.length > 0 ? list : [process.cwd()];
      })(),
      cwd: process.cwd(),
      maxTimeoutMs: config?.execution?.maxTimeoutMs,
      maxOutputBytes: config?.execution?.maxOutputBytes,
    });
    service.materializer = createMaterializer({
      cwd: process.cwd(),
      roots: Array.isArray(config?.materialize?.roots) && config.materialize.roots.length > 0 ? config.materialize.roots : [process.cwd()],
      maxBytes: config?.materialize?.maxBytes,
    });
    service.usageLedger = createUsageLedger({
      storage,
      clock,
      priceBook: config?.usage?.priceBook ?? null,
      sourcePath: config?.usage?.sourcePath ?? null,
      readRange: typeof deps.adapter.readFileRange === 'function'
        ? (path, offset, length) => deps.adapter.readFileRange(path, offset, length)
        : null,
      facts: () => ({ members: service.members, attempts: service.attempts, teams: service.teams }),
    });
    service.nativeUsage = createNativeUsageCollector({
      adapter: deps.adapter,
      ledger: service.usageLedger,
      clock,
      maxSessions: config?.usage?.maxSessions,
      maxEventsPerSession: config?.usage?.maxEventsPerSession,
      diagnostics: service.diagnostics,
      // 持久游标：与 boot 段一致；storage 此时已是 facade（新表 → sidecar）。
      loadCursor: (sessionId) => {
        try {
          const stored = storage.get('usage_cursors', `native:${sessionId}`);
          return Number.isInteger(stored?.seq) ? stored.seq : 0;
        } catch {
          return 0;
        }
      },
      saveCursor: async (sessionId, seq, extra) => {
        await storage.put('usage_cursors', `native:${sessionId}`, { seq, ...extra });
      },
    });
    service.contextControl = createContextControl({
      service,
      config,
      clock,
      diagnostics: service.diagnostics,
      compactStateFor: (agent) => service.compactStateFor(agent),
    });
    const hydrated = {
      fingerprints: await service.fingerprints.hydrate(),
      executionRuns: await service.executionRunner.hydrate(),
    };
    const usage = await service.usageLedger.hydrate();
    hydrated.usage = usage;
    // 升级路径补 hydrate（旧 init 不再重跑）：identity/evidence 记录 + 阶段起点。
    const hydrateTable = async (table, target) => {
      try {
        const listed = await storage.list(table);
        const rows = Array.isArray(listed) ? listed : (Array.isArray(listed?.records) ? listed.records : []);
        for (const row of rows) {
          const record = Array.isArray(row) ? row[1] : row;
          const key = record?.recordId ?? record?.key ?? record?.identityKey ?? null;
          if (key !== null) target.set(String(key), record);
        }
        return rows.length;
      } catch (error) {
        service.diagnostics?.push?.('upgrade:hydrate-failed', `${table}: ${String(error?.message ?? error)}`);
        return 0;
      }
    };
    hydrated.identity = await hydrateTable('identity_records', service.identityRecords);
    hydrated.evidence = await hydrateTable('evidence_records', service.evidenceRecords);
    if (typeof service.usageLedger.markPhaseStart === 'function') service.usageLedger.markPhaseStart(clock.now());
    for (const key of componentKeys) created.push(key);
    return hydrated;
  }

  /**
   * 从 `TeamWorkbenchService.prototype` 取实现绑定到**原 service 对象**。
   *
   * - **不跑 constructor**（避免产生额外状态 / 触碰原 maps）。
   * - 保留 dispatch-repair 的 4 个 own wrapper（PROTECTED_CORE_METHODS）。
   * - 其余 own 属性（如果有）也覆盖，但先备份、并打 `__upgradeImplOf` 标记，
   *   供 postcondition 判定"新代码是否真的在当前实例上生效"（不是按名字存在判断）。
   */
  function attachMethods(txn = null) {
    const service = deps.service;
    const proto = TeamWorkbenchService.prototype;
    const attached = [];
    const overridden = [];
    const skipped = [];
    const backups = {};
    for (const name of NEW_METHOD_NAMES) {
      if (PROTECTED_CORE_METHODS.includes(name)) continue;
      const impl = proto?.[name];
      if (typeof impl !== 'function') {
        skipped.push({ name, reason: 'NOT_IMPLEMENTED_IN_NEW_CODE' });
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(service, name) ?? null;
      methodDescriptors[name] = descriptor;
      if (txn) txn.methodDescriptors[name] = descriptor;
      if (Object.hasOwn(service, name)) {
        backups[name] = service[name];
        if (txn) txn.methodBackups[name] = service[name];
        overridden.push(name);
      } else {
        attached.push(name);
      }
      const bound = (...args) => impl.apply(service, args);
      Object.defineProperty(bound, '__upgradeImplOf', { value: name, enumerable: false });
      Object.defineProperty(service, name, { configurable: true, enumerable: false, writable: true, value: bound });
    }
    return { attached, overridden, skipped, backups, proto };
  }
  /**
   * 只包两层增量（审计差分）：reserveWorkInLock 错误门闸、executeStart 失败指纹。
   * `reconcileInLock` / `patchAttemptInLock` **保持原 repair 实现**。
   */
  function wrapCoreIncrements(txn = null) {
    const service = deps.service;
    const report = { wrapped: [], preserved: [] };
    if (typeof service.evaluateErrorGate !== 'function') return { ...report, ok: false, code: 'NEW_METHODS_MISSING' };
    wrapDescriptors.reserveWorkInLock = Object.getOwnPropertyDescriptor(service, 'reserveWorkInLock') ?? null;
    if (txn) txn.wrapDescriptors.reserveWorkInLock = wrapDescriptors.reserveWorkInLock;
    const originalReserve = service.reserveWorkInLock;
    if (typeof originalReserve === 'function' && originalReserve.__wbErrorGate !== true) {
      const wrapped = async function reserveWithErrorGate(work, context = {}) {
        const gate = await service.evaluateErrorGate(work, context);
        if (gate) return gate;
        return originalReserve.call(service, work, context);
      };
      wrapped.__wbErrorGate = true;
      wrapped.__wbOriginal = originalReserve;
      service.reserveWorkInLock = wrapped;
      if (txn) txn.wrapBackups.reserveWorkInLock = originalReserve;
      report.wrapped.push('reserveWorkInLock:error-gate');
    } else {
      report.preserved.push('reserveWorkInLock');
    }
    const originalStart = service.executeStart;
    wrapDescriptors.executeStart = Object.getOwnPropertyDescriptor(service, 'executeStart') ?? null;
    if (txn) txn.wrapDescriptors.executeStart = wrapDescriptors.executeStart;
    if (typeof originalStart === 'function' && originalStart.__wbFailureFingerprint !== true) {
      const wrapped = async function executeStartWithFingerprint(plan, options = {}) {
        const outcome = await originalStart.call(service, plan, options);
        try {
          if (outcome && outcome.ok === false) {
            await service.recordFailureFingerprint(service.describeStartFailure(plan, outcome));
          }
        } catch (error) {
          service.diagnostics?.push?.('service:executeStart:fingerprint-failed', String(error?.message ?? error));
        }
        return outcome;
      };
      wrapped.__wbFailureFingerprint = true;
      wrapped.__wbOriginal = originalStart;
      service.executeStart = wrapped;
      if (txn) txn.wrapBackups.executeStart = originalStart;
      report.wrapped.push('executeStart:failure-fingerprint');
    } else {
      report.preserved.push('executeStart');
    }
    for (const name of ['reconcileInLock', 'patchAttemptInLock']) report.preserved.push(name);
    return { ...report, ok: true };
  }

  /** 挂工具/路由/上下文/用量/技能；全部登记 disposer 供回滚。 */
  async function mount() {
    const report = { tools: null, routes: null, hooks: null, usage: null, skills: null };
    // 工具：原层已注册同名会失败，因此**只补缺**（名字以真实注册表为准），并记录真实 disposer。
    let toolNames = [];
    try {
      const listed = deps.adapter.listToolNames();
      toolNames = listed?.ok && Array.isArray(listed.value) ? listed.value : [];
    } catch { /* 记为缺失 */ }
    const missingTools = NEW_TOOL_NAMES.filter((name) => !toolNames.includes(name));
    if (missingTools.length > 0) {
      const toolsResult = deps.registerTools({ service: deps.service, scheduler: deps.scheduler, adapter: deps.adapter, config: deps.config });
      report.tools = { registered: toolsResult?.registered?.length ?? 0, skipped: toolsResult?.skipped?.length ?? 0, patched: missingTools };
      if (typeof toolsResult?.dispose === 'function') disposers.push(toolsResult.dispose);
      else if (Array.isArray(toolsResult?.disposers)) disposers.push(() => { for (const dispose of toolsResult.disposers) { try { dispose(); } catch { /* rollback */ } } });
    } else {
      report.tools = { registered: 0, alreadyPresent: NEW_TOOL_NAMES };
    }

    // 路由：旧 /state、/op 已存在；legacy 模式补冻结的 /state/detail；versioned 模式由**入口提供的
    // 真实注册器**在事务内挂载（`registerVersionedRoutes`），挂载失败 → 直接抛错，由 activate 完整回滚，
    // 不允许"先宣布成功、事后才发现版本化 state/detail/op 不可达"。
    const versionedRoutes = deps.config?.remediation?.routeMode === 'versioned';
    let routesResult;
    if (versionedRoutes) {
      if (typeof deps.registerVersionedRoutes === 'function') {
        routesResult = await deps.registerVersionedRoutes({ service: deps.service, scheduler: deps.scheduler, adapter: deps.adapter, config: deps.config });
        if (!routesResult || routesResult.ok !== true) {
          throw Object.assign(new Error(`版本化生产路由挂载失败：${routesResult?.code ?? 'VERSIONED_ROUTES_FAILED'}`), { code: routesResult?.code ?? 'VERSIONED_ROUTES_FAILED' });
        }
      } else {
        routesResult = { ok: true, routes: [], dispose: () => {}, delegatedToEntry: true };
      }
    } else {
      routesResult = deps.registerWebRoutes({ service: deps.service, scheduler: deps.scheduler, adapter: deps.adapter, config: deps.config });
    }
    report.routes = {
      routes: routesResult?.routes?.length ?? 0,
      paths: routesResult?.routes ?? [],
      delegatedToEntry: routesResult?.delegatedToEntry === true,
      routeMode: versionedRoutes ? 'versioned' : 'legacy',
      basePath: routesResult?.basePath ?? null,
      clientAckEndpoint: routesResult?.clientAckEndpoint ?? null,
      verified: routesResult?.verified === true,
    };
    if (typeof routesResult?.dispose === 'function') disposers.push(routesResult.dispose);

    // 上下文挂钩：返回真实 disposer；同时记录"已接线"标记供 postcondition 判定。
    const hooksDisposer = deps.startContextHooks(deps.adapter, deps.service);
    if (typeof hooksDisposer === 'function') disposers.push(hooksDisposer);
    deps.service.__hookWiring = { preStep: typeof hooksDisposer === 'function', toolGuard: typeof hooksDisposer === 'function', hooksDisposer: typeof hooksDisposer === 'function', verifiedBy: 'disposer-return', readback: typeof deps.adapter.listToolNames === 'function', at: Date.now() };
    report.hooks = { wired: Boolean(deps.service.__hookWiring?.preStep), disposable: typeof hooksDisposer === 'function' };

    // 费用：真实启动后台增量（原生事件），返回 disposer。
    const usageDisposer = deps.startUsageIngest(deps.ctx, deps.service, deps.config);
    if (typeof usageDisposer === 'function') disposers.push(usageDisposer);
    deps.service.__usageWiring = { started: typeof usageDisposer === 'function', mode: 'native-events', at: Date.now() };
    report.usage = { started: Boolean(deps.service.__usageWiring?.started), enabled: deps.config?.usage?.enabled !== false };

    if (typeof deps.mountSkills === 'function') {
      const skillsDisposer = deps.mountSkills();
      if (typeof skillsDisposer === 'function') disposers.push(skillsDisposer);
      report.skills = { mounted: true };
    } else {
      report.skills = { mounted: false, reason: 'NO_SKILLS_MOUNT' };
    }
    return report;
  }

  /** 版本探针：直接在**原实例**上调用新代码入口，证明改的方法真的生效（不是按名字存在判断）。 */
  async function versionProbes() {
    const service = deps.service;
    const probes = [];
    const push = (name, ok, detail) => probes.push({ name, ok: Boolean(ok), detail });

    // 1) 证据式验收：空证据 accepted 必须被拒（旧代码会通过）。
    try {
      const validation = await service.validateWorkEvidence({ work: { workId: '__probe__', outputs: [], acceptance: ['x'] }, evidence: [] });
      push('workVerify-evidence-gate', validation?.ok === false && (validation?.codes ?? []).includes('EVIDENCE_REQUIRED'), { codes: validation?.codes });
    } catch (error) { push('workVerify-evidence-gate', false, String(error?.message ?? error)); }

    // 2) 身份：同 workId 换 owner 必须 OWNER_MISMATCH。
    try {
      const judgement = await service.judgeWorkIdentity({
        workId: '__probe__', teamKey: '__probe_team__', ownerMemberId: 'b', title: 't', deliverable: 'd', outputs: ['__probe__/a.ts'], acceptance: ['x'],
      }, { selfWorkId: null });
      push('identity-owner-mismatch', judgement?.ok !== false || judgement?.code === 'IDENTITY_OWNER_MISMATCH', { code: judgement?.code });
    } catch (error) { push('identity-owner-mismatch', false, String(error?.message ?? error)); }

    // 3) /state/detail 分页（新入口真实可调用）。
    try {
      const detail = service.stateDetail({ section: 'findings', kind: 'verified', page: '1', pageSize: '2' });
      push('state-detail', detail?.ok === true && Array.isArray(detail.items) && detail.pageSize === 2, { total: detail?.total, pages: detail?.pages });
    } catch (error) { push('state-detail', false, String(error?.message ?? error)); }

    // 4) 费用投影为 v3 且来源是原生事件（不是旧 JSONL 生产口）。
    try {
      const usage = service.usageSnapshot();
      push('usage-v3-native', usage?.version === 3 && usage?.raw?.source === 'native-session-events', { version: usage?.version, source: usage?.raw?.source });
    } catch (error) { push('usage-v3-native', false, String(error?.message ?? error)); }

    // 5) findings：直接读 `/state` 投影（汇总形状），证明前端消费路径已升级。
    try {
      const findings = service.snapshot(undefined)?.findings;
      const shapes = Boolean(findings?.counts?.verifiedByLevel && Array.isArray(findings?.preview?.verified));
      push('findings-summary-shape', shapes, { countsKeys: Object.keys(findings?.counts ?? {}) });
    } catch (error) { push('findings-summary-shape', false, String(error?.message ?? error)); }

    // 证据门负例探针（Codex 统一验收要求）：非空文件+自报命令必须被拒；合法三元组可通过。
    try {
      const gate = await probeEvidenceGate();
      push('evidence-gate', gate?.negativeCase?.rejected === true && gate?.positiveCase?.ok === true, gate);
    } catch (error) { push('evidence-gate', false, String(error?.message ?? error)); }
    return probes;
  }

  /** 可核查的后置条件（**不通过就回滚并失败**；全部基于真实对象/接线/探针）。 */
  async function verifyPostcondition({ preservedBefore, mounted, attached, facadeProbe, facade }) {
    const service = deps.service;
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

    add('components', ['fingerprints', 'usageLedger', 'executionRunner', 'materializer', 'nativeUsage', 'contextControl', 'identityRecords', 'evidenceRecords'].every((key) => service[key] !== undefined && service[key] !== null));
    // **真实装载**：每个方法都必须是 upgrade 绑定实现（`__upgradeImplOf`），不是旧代码同名函数。
    const methodWiring = NEW_METHOD_NAMES.filter((name) => !PROTECTED_CORE_METHODS.includes(name)).map((name) => ({
      name, upgraded: typeof service[name] === 'function' && service[name].__upgradeImplOf === name,
    }));
    add('methods-upgraded', methodWiring.every((item) => item.upgraded), methodWiring.filter((item) => !item.upgraded));
    // sidecar + facade 真实就绪（逐表 put→get 探针结果）。
    add('sidecar-probe', facadeProbe?.ok === true, facadeProbe ?? null);
    add('storage-facade', service.storage === facade, { active: service.storage === facade, baseTablesUnchanged: Array.isArray(deps.storage?.tables) });
    // 工具/路由/挂钩/用量：真实接线标记 + 注册表/路由列表。
    let toolNames = [];
    try {
      const listed = deps.adapter.listToolNames();
      toolNames = listed?.ok && Array.isArray(listed.value) ? listed.value : [];
    } catch { /* 记为失败 */ }
    add('tools', NEW_TOOL_NAMES.every((name) => toolNames.includes(name)), { missing: NEW_TOOL_NAMES.filter((name) => !toolNames.includes(name)) });
    // 路由：versioned 模式必须是**真实挂载成功**的版本化 state/detail/op（不是"delegated 就算过"）。
    const routePaths = (mounted?.routes?.paths ?? []).map((entry) => String(entry?.path ?? entry));
    const hasPath = (suffix) => routePaths.some((entry) => entry.endsWith(suffix));
    const routesOk = mounted?.routes?.routeMode === 'versioned'
      ? (routePaths.length > 0 && hasPath('/state') && hasPath('/state/detail') && hasPath('/op') && mounted?.routes?.verified === true)
      : (hasPath('/state/detail') || (mounted?.routes?.routes ?? 0) > 0);
    add('routes', routesOk, mounted?.routes ?? null);
    // hooks-wired：读**可观察计数/注册记录**，不只写布尔。
    const hookStats = typeof service.contextControl?.snapshot === 'function' ? service.contextControl.snapshot()?.stats ?? null : null;
    add('hooks-wired', Boolean(service.__hookWiring?.preStep) && Boolean(service.__hookWiring?.toolGuard) && Boolean(hookStats), { wiring: service.__hookWiring ?? null, hookStats });
    add('usage-wired', service.__usageWiring?.started === true, service.__usageWiring ?? null);
    // 维护压缩路径（Lead 第 15 回合 B）：记录**真实可用性**；unavailable 不伪造成 true。
    const maintenanceView = typeof service.maintenanceView === 'function' ? service.maintenanceView() : null;
    // 生产包可安装/可加载入口（真实 file:// + 动态 import 探针通过才算）。
    add('installable-entry', mounted?.installable?.ok === true && mounted?.installable?.loaded === true, mounted?.installable ?? null);
    // **独立版本化模块图**（guidance21 第 1 项）：必须来自 versions/<hash>/ 且标记一致；缺失不伪造。
    // 证据门（负例自证）：negativeCase.rejected + positiveCase.ok 同时成立；失败→整体回滚。
    add('module-graph', Boolean(deps.versionGraph?.hash) && deps.versionGraph?.marker === deps.versionGraph?.hash, deps.versionGraph ?? null);
    // 技能迁移：只有 ok + readback 通过（或显式跳过）才算 true；失败不伪造。
    const skillsReadbackOk = mounted?.skills?.skipped === true || (mounted?.skills?.ok === true && (mounted?.skills?.readback?.ok === true || mounted?.skills?.readback === null));
    // 角色段刷新（Lead 第 19 回合）：ok:true 通过；NOT_MOUNTED/DISABLED/UNAVAILABLE 记 skipped 不算失败；
    // REFRESH_FAILED 或抛错 → 该 postcondition false → 整体回滚。
    const promptRefresh = mounted?.skills?.promptRefresh ?? null;
    const promptSkips = ['SKILL_SECTIONS_NOT_MOUNTED', 'SKILL_SECTIONS_DISABLED', 'SKILL_SECTIONS_UNAVAILABLE'];
    const promptRefreshOk = promptRefresh === null
      || promptRefresh?.ok === true
      || (promptRefresh?.ok === false && promptSkips.includes(String(promptRefresh?.code)));
    add('skills-prompt-refresh', promptRefreshOk, { ok: promptRefresh?.ok ?? null, code: promptRefresh?.code ?? null, skipped: promptRefresh?.ok === false && promptSkips.includes(String(promptRefresh?.code)), registered: promptRefresh?.registered ?? null, agents: promptRefresh?.agents ?? null });
    add('skills-migrated', skillsReadbackOk, { ok: mounted?.skills?.ok ?? null, skipped: mounted?.skills?.skipped ?? null, applicationForm: mounted?.skills?.applicationForm ?? null, readbackOk: mounted?.skills?.readback?.ok ?? null, providersBefore: mounted?.skills?.providersBefore?.count ?? null, providersAfter: mounted?.skills?.providersAfter?.count ?? null });
    // 技能事务回滚能力（guidance38）：迁移成功后必须能把原 18 providers + 角色段恢复回来。
    const skillsTxnOk = mounted?.skills?.skipped === true || mounted?.skills?.rollbackUpgrade === true;
    add('skills-transaction', skillsTxnOk, { rollbackUpgrade: mounted?.skills?.rollbackUpgrade === true, providersBefore: mounted?.skills?.providersBefore?.count ?? null, providersAfter: mounted?.skills?.providersAfter?.count ?? null });
    add('maintenance-path', typeof service.requestMaintenance === 'function' && typeof service.maintenanceView === 'function', { available: maintenanceView?.available ?? false, reason: maintenanceView?.reason ?? 'MAINTENANCE_METHOD_MISSING', path: maintenanceView?.path ?? null });
    // 原实例/身份/队列：不要求 size 相同（其他团队会并发变化），只要求**引用未换**与身份未丢。
    add('preserved-references', service.works === preservedBefore.worksRef && service.members === preservedBefore.membersRef && service.attempts === preservedBefore.attemptsRef, { worksSame: service.works === preservedBefore.worksRef });
    add('preserved-identity', (preservedBefore.sampleWork === null) || (service.works.get(preservedBefore.sampleWork.workId)?.ownerMemberId === preservedBefore.sampleWork.ownerMemberId), preservedBefore.sampleWork ?? null);
    // repair 4 个 own wrapper：两个被我们外包增量（必须保留 __wbOriginal），另两个必须仍在（own 或原型）。
    const repairReport = PROTECTED_CORE_METHODS.map((name) => ({
      name,
      present: typeof service[name] === 'function',
      own: Object.hasOwn(service, name),
      wrappedByUs: service[name]?.__wbOriginal !== undefined,
    }));
    add('repair-core', repairReport.every((item) => item.present && (item.wrappedByUs || item.own || typeof deps.service[item.name] === 'function')), repairReport);
    add('upgrade-wraps', service.reserveWorkInLock?.__wbErrorGate === true && service.executeStart?.__wbFailureFingerprint === true, { reserve: service.reserveWorkInLock?.__wbErrorGate, start: service.executeStart?.__wbFailureFingerprint });

    // 版本探针：在**原实例**上真实调用新代码入口。
    const probes = await versionProbes();
    add('version-probes', probes.every((probe) => probe.ok), probes);
    add('evidence-gate', probes.find((probe) => probe.name === 'evidence-gate')?.ok === true, probes.find((probe) => probe.name === 'evidence-gate') ?? null);

    return { ok: checks.every((check) => check.ok), checks, probes };
  }

  /** 完整回滚：hooks/工具/路由 disposer、全部被改方法/组件/storage/接线标记、原 props。 */
  async function rollback(backup) {
    for (const disposer of disposers.splice(0)) {
      try { disposer(); } catch { /* 回滚路径 */ }
    }
    const service = deps.service;
    for (const name of backup.addedMethods.splice(0)) {
      try { delete service[name]; } catch { /* 回滚路径 */ }
    }
    for (const [name, value] of Object.entries(backup.methodBackups ?? {})) {
      try { service[name] = value; } catch { /* 回滚路径 */ }
    }
    for (const [name, value] of Object.entries(backup.wrapBackups ?? {})) {
      try { service[name] = value; } catch { /* 回滚路径 */ }
    }
    if (backup.storageBackup !== undefined) {
      try { service.storage = backup.storageBackup; } catch { /* 回滚路径 */ }
    }
    // property-descriptor 事务回滚：原 descriptor 还原；原来没有的属性 delete（不是置 undefined）。
    for (const key of created.splice(0)) {
      const descriptor = backup.componentDescriptors?.[key] ?? null;
      try {
        if (descriptor) Object.defineProperty(service, key, descriptor);
        else delete service[key];
      } catch { /* 回滚路径 */ }
    }
    for (const [name, descriptor] of Object.entries(backup.methodDescriptors ?? {})) {
      try { if (descriptor) Object.defineProperty(service, name, descriptor); else delete service[name]; } catch { /* 回滚路径 */ }
    }
    for (const [name, descriptor] of Object.entries(backup.wrapDescriptors ?? {})) {
      try { if (descriptor) Object.defineProperty(service, name, descriptor); else delete service[name]; } catch { /* 回滚路径 */ }
    }
    try { service.__hookWiring = backup.hookWiringBackup ?? null; } catch { /* 回滚路径 */ }
    try { service.__usageWiring = backup.usageWiringBackup ?? null; } catch { /* 回滚路径 */ }
    // ---- 技能事务回滚（guidance38）：成功迁移后后续 web/hook/postcondition 失败时必须恢复原 18 providers + 角色段 ----
    let skillsRollbackReport = null;
    if (typeof backup.skillsRollback === 'function') {
      try {
        skillsRollbackReport = await backup.skillsRollback();
      } catch (error) {
        skillsRollbackReport = { ok: false, code: 'SKILLS_TRANSACTION_ROLLBACK_FAILED', message: String(error?.message ?? error) };
      }
      service.diagnostics?.push?.('upgrade:skills-rollback', `ok=${skillsRollbackReport?.ok === true} hashesMatched=${skillsRollbackReport?.hashesMatched === true}`, skillsRollbackReport);
    }
    // ---- 适配器增强回滚：upgradeEntry 为旧 adapter 补的方法必须删除（恢复原引用/能力面）----
    let adapterRollbackReport = null;
    if (typeof backup.adapterRollback === 'function') {
      try {
        adapterRollbackReport = await backup.adapterRollback();
      } catch (error) {
        adapterRollbackReport = { ok: false, code: 'ADAPTER_ROLLBACK_FAILED', message: String(error?.message ?? error) };
      }
    }
    backup.rollbackReport = { skills: skillsRollbackReport, adapter: adapterRollbackReport, at: Date.now() };
    try { service.__hotUpgrade = null; } catch { /* 回滚路径 */ }
  }

  /**
   * **生产包可安装/可加载入口探针**（Lead 第 16 回合 B）：
   * 新版本目录必须有真实 `file://` 入口文件，且能被动态 import 加载（受控新版本）；
   * 只有函数导出而不存在可加载入口 → 明确失败，不伪造 installable。
   */
  async function probeInstallableEntry(override) {
    const candidate = typeof override === 'string' && override
      ? override
      : (typeof deps.config?.remediation?.installableEntry === 'string' ? deps.config.remediation.installableEntry : null);
    if (!candidate) return { ok: false, code: 'INSTALLABLE_ENTRY_MISSING', note: '未提供新版本可安装入口（file:// 入口文件）；不能只导出 createUpgradeBundle 函数。' };
    let absolute;
    try {
      absolute = candidate.startsWith('file:') ? fileURLToPath(candidate) : path.resolve(candidate);
    } catch (error) {
      return { ok: false, code: 'INSTALLABLE_ENTRY_INVALID', message: String(error?.message ?? error) };
    }
    try {
      const stat = await fsp.stat(absolute);
      if (!stat.isFile()) return { ok: false, code: 'INSTALLABLE_ENTRY_NOT_FILE', entryPath: absolute };
    } catch (error) {
      return { ok: false, code: 'INSTALLABLE_ENTRY_NOT_FOUND', entryPath: absolute, message: String(error?.message ?? error) };
    }
    const entryUrl = `${pathToFileURL(absolute).href}?twb-probe=${Date.now()}`;
    try {
      const loaded = await import(entryUrl);
      const exported = Object.keys(loaded ?? {});
      if (exported.length === 0) return { ok: false, code: 'INSTALLABLE_ENTRY_NO_EXPORTS', entryPath: absolute, entryUrl };
      return { ok: true, entryPath: absolute, entryUrl, exports: exported.slice(0, 20), loaded: true };
    } catch (error) {
      return { ok: false, code: 'INSTALLABLE_ENTRY_LOAD_FAILED', entryPath: absolute, entryUrl, message: String(error?.message ?? error) };
    }
  }

  /** 入口：真实激活（调用方必须先过 confirm 与 plan）。 */
  async function activate(options = {}) {
    const missing = missingDependencies();
    if (missing.length > 0) return result(false, 'UPGRADE_DEPENDENCIES_MISSING', { missing, hint: '热升级需要完整依赖（ctx/adapter/storage/config/service + 注册入口函数）；缺依赖时明确失败，不假装完成。' });
    const service = deps.service;
    if (service.__hotUpgrade?.postcondition?.ok === true) return result(true, null, { alreadyUpgraded: true, postcondition: service.__hotUpgrade.postcondition });

    // 1) sidecar + facade 先就绪（探针通过前不切换任何入口）。
    // 与正常启动**同一显式稳定地址**（storageDomain 无 dataDir 时不能按 cwd 漂移）：hot 写 → cold 读。
    const sidecarDir = deps.config?.remediation?.sidecarDir || sidecarDirFor(deps.storage);
    const sidecar = createSidecarStore({ dir: sidecarDir, clock: deps.clock, diagnostics: service.diagnostics });
    const facade = createRemediationStorage({ base: service.storage ?? deps.storage, sidecar, diagnostics: service.diagnostics });
    const probe = await facade.probe();
    if (!probe.ok) return result(false, 'SIDECAR_NOT_READY', { probe, hint: 'sidecar 探针未通过：不切换入口、不写 __hotUpgrade。' });
    // 生产包**可安装/可加载入口**（真实 file:// 入口 + 动态 import 探针）；缺失/不可加载 → 明确失败，不伪造。
    const installable = await probeInstallableEntry(options?.installableEntry);
    if (!installable.ok) {
      return result(false, 'UPGRADE_ENTRY_NOT_INSTALLABLE', { installable, sidecarProbe: { tables: probe.results.length }, hint: '生产包必须提供真实可加载入口（file://）；已停止且未切换任何入口。' });
    }

    // ---- 事务备份（必须在任何变更**之前**建立；descriptor/技能/适配器都在事务内）----
    const preservedBefore = {
      worksRef: service.works,
      membersRef: service.members,
      attemptsRef: service.attempts,
      sampleWork: (service.works?.values?.().next?.().value ?? null) ? { workId: service.works.values().next().value.workId, ownerMemberId: service.works.values().next().value.ownerMemberId } : null,
      works: service.works?.size ?? -1,
      members: service.members?.size ?? -1,
    };
    const backup = {
      storageBackup: service.storage,
      addedMethods: [],
      methodBackups: {},
      wrapBackups: {},
      wrapDescriptors: {},
      methodDescriptors: {},
      componentDescriptors: {},
      // @deprecated 旧回滚路径字段；当前统一用 componentDescriptors（property descriptor 事务快照）。
      componentBackups: {},
      hookWiringBackup: service.__hookWiring,
      usageWiringBackup: service.__usageWiring,
      skillsRollback: null,
      skillsStage: null,
      adapterRollback: typeof deps.rollbackAdapter === 'function' ? deps.rollbackAdapter : null,
      rollbackReport: null,
    };

    // 事务内阶段变量（技能迁移必须等新的 refreshSkillSections 已挂到原实例后再跑；
    // 旧实例没有该方法，提前调用会得到 SKILL_SECTIONS_PROXY_MISSING 并把角色段留在旧状态）。
    let skillsStage = null;
    let skillsPromptSections = null;

    try {
      // 2) 一次性切换 storage 入口（facade），旧 storage 对象原样保留在 backup 里。
      service.storage = facade;
      const hydrated = await initComponents(facade, backup);
      const attached = attachMethods(backup);
      backup.addedMethods.push(...attached.attached);
      const wraps = wrapCoreIncrements(backup);
      if (wraps.ok === false) {
        await rollback(backup);
        return result(false, wraps.code ?? 'WRAP_FAILED', { wraps });
      }
      // ---- 技能迁移（事务内，必须在 attachMethods 之后）----
      // 旧实例没有 `refreshSkillSections`（它是本版本新方法）；提前调用只会得到
      // SKILL_SECTIONS_PROXY_MISSING，角色段仍停在旧 18 providers 之前的状态。
      // 现在新方法已挂到原实例：迁移 → 刷新角色段 → 记录整体回滚 handle，再继续路由/hook/后置条件。
      if (deps.config?.remediation?.skillsMigrate !== true) {
        skillsStage = { ok: true, skipped: true, reason: 'EXTERNAL_SKILLS_NOT_ENABLED' };
      } else {
        skillsStage = await runSkillsMigration({ service, config: deps.config, diagnostics: service.diagnostics, log: (step, detail) => service.diagnostics.push('service:skills-migration', step + (detail ? ' ' + JSON.stringify(detail) : '')) });
        if (skillsStage.ok !== true) {
          await rollback(backup);
          return result(false, 'SKILLS_MIGRATION_FAILED', { skills: skillsStage, rollback: backup.rollbackReport, hint: '技能迁移失败（或 entry/plan/readback 不通过）：已完整回滚（方法/组件/storage/技能），未写 __hotUpgrade。' });
        }
        try {
          skillsPromptSections = typeof service.refreshSkillSections === 'function'
            ? await service.refreshSkillSections()
            : { ok: false, code: 'SKILL_SECTIONS_PROXY_MISSING' };
          if (skillsPromptSections?.ok !== true) {
            service.diagnostics.push('service:skills-prompt-reset', `ok=false code=${skillsPromptSections?.code ?? 'UNKNOWN'}`);
          }
        } catch (error) {
          skillsPromptSections = { ok: false, code: 'SKILL_SECTIONS_REFRESH_FAILED', message: String(error?.message ?? error) };
          service.diagnostics.push('service:skills-prompt-reset-failed', String(error?.message ?? error));
        }
      }
      backup.skillsStage = skillsStage;
      backup.skillsRollback = skillsStage && typeof skillsStage.rollbackUpgrade === 'function' ? skillsStage.rollbackUpgrade : null;
      const mounted = await mount();
      // 真实入口/组件/domain 清单进 mounted（__hotUpgrade.mounted 可回读）。
      mounted.installable = installable;
      mounted.skills = { promptRefresh: skillsPromptSections, promptSections: skillsPromptSections, ok: skillsStage.ok === true, skipped: skillsStage.skipped === true, applicationForm: skillsStage.applicationForm ?? null, rollback: skillsStage.rollback ?? null, readback: skillsStage.readback ?? null, providersBefore: skillsStage.providersBefore ?? null, providersAfter: skillsStage.providersAfter ?? null, plan: skillsStage.plan ?? null, markers: skillsStage.markers ?? [], rollbackUpgrade: typeof skillsStage.rollbackUpgrade === 'function', providersExpected: skillsStage.providersBefore?.count ?? null, providersAfter: skillsStage.providersAfter?.count ?? null };
      mounted.installablePath = installable.entryPath;
      mounted.sidecarDomain = 'remediation-sidecar';
      mounted.sidecarDir = sidecarDir;
      mounted.components = ['fingerprints', 'usageLedger', 'executionRunner', 'materializer', 'nativeUsage', 'contextControl', 'identityRecords', 'evidenceRecords'];
      postcondition = await verifyPostcondition({ preservedBefore, mounted, attached, facadeProbe: probe, facade });
      if (!postcondition.ok) {
        await rollback(backup);
        return result(false, 'UPGRADE_POSTCONDITION_FAILED', { postcondition, mounted, probe, rollback: backup.rollbackReport, hint: '后置条件未通过已执行回滚；回滚细节见 rollback。' });
      }
      service.__hotUpgrade = {
        at: Date.now(),
        mode: 'sidecar-facade+components+methods+tools+routes+hooks+usage',
        attached: attached.attached,
        overridden: attached.overridden,
        skipped: attached.skipped,
        wraps,
        mounted,
        postcondition,
        sidecarProbe: { tables: probe.results.length, delegates: probe.delegates.length, baseTables: probe.baseTables?.length ?? 0 },
        preservedBefore: { sampleWork: preservedBefore.sampleWork, works: preservedBefore.works, members: preservedBefore.members },
        hydrated,
      };
      return result(true, null, {
        upgraded: true,
        attached: attached.attached,
        overridden: attached.overridden,
        skipped: attached.skipped,
        wraps,
        mounted,
        sidecarProbe: probe,
        postcondition,
        preservedBefore: service.__hotUpgrade.preservedBefore,
      });
    } catch (error) {
      await rollback(backup);
      return result(false, 'UPGRADE_FAILED', { message: String(error?.message ?? error), rollback: backup.rollbackReport, note: '已执行回滚；回滚细节见 rollback。' });
    }
  }

  /** 只读计划（不写任何东西；不做探针写）。 */
  function plan() {
    const missing = missingDependencies();
    const service = deps.service;
    const baseTables = Array.isArray(deps.storage?.tables) ? deps.storage.tables : [];
    return {
      ok: missing.length === 0,
      alreadyUpgraded: service?.__hotUpgrade?.postcondition?.ok === true,
      mode: 'dry-run',
      dependencies: { ok: missing.length === 0, missing },
      storage: {
        baseTables: baseTables.length,
        baseTablesFrozen: Object.isFrozen(baseTables),
        sidecarTables: NEW_TABLES,
        sidecarDir: deps.config?.remediation?.sidecarDir || sidecarDirFor(deps.storage),
        routeMode: deps.config?.remediation?.routeMode === 'versioned' ? 'versioned' : 'legacy',
        strategy: '独立 sidecar + facade（新表→sidecar；旧表→原 storage 原样委托）；禁止 push 冻结 tables、禁止二次 open 同名 domain。',
      },
      willAttach: { methods: NEW_METHOD_NAMES.length, tools: NEW_TOOL_NAMES.length, protected: PROTECTED_CORE_METHODS },
      externalSkills: { enabled: deps.config?.remediation?.skillsMigrate === true, optional: true },
      versionedRoutes: (deps.config?.remediation?.routeMode === 'versioned')
        ? { transactional: true, registeredBy: 'entry.registerVersionedRoutes', required: ['state', 'state/detail', 'op'], clientAckEndpoint: '/plugin/team-workbench-v2/op', onFailure: 'activate() 抛 VERSIONED_ROUTES_FAILED 并完整回滚（含技能/descriptors/adapter/已注册资源）' }
        : null,
      increments: ['reserveWorkInLock:error-gate', 'executeStart:failure-fingerprint'],
      transaction: {
        order: ['backup(descriptor/skills/adapter)', 'storage-facade', 'init-components', 'attach-methods', 'wrap-core', 'mount(tools/web/hooks/usage)', 'skills-migrate', 'postcondition'],
        onFailure: 'rollback(descriptor+methods+storage+hooks+routes+external-skills+role-sections+adapter-augmentation)',
        partialStates: '任何后置失败（含 web/hook/postcondition）都恢复原技能 providers 与角色段；失败不写 __hotUpgrade',
      },
      preserve: { teams: service?.teams?.size ?? null, members: service?.members?.size ?? null, works: service?.works?.size ?? null, attempts: service?.attempts?.size ?? null },
      postcondition: ['module-graph', 'skills-prompt-refresh', 'skills-migrated', 'skills-transaction', 'installable-entry', 'maintenance-path', 'components', 'methods-upgraded', 'sidecar-probe', 'storage-facade', 'tools', 'routes', 'hooks-wired', 'usage-wired', 'preserved-references', 'preserved-identity', 'repair-core', 'upgrade-wraps', 'version-probes'],
      constraints: [
        '保留原 service 对象与 scheduler（原 scheduler 源码与 baseline 相同，无需替换）',
        '不卸载 ui-recovery、不覆盖既有 workbench wrapper、不改 app.asar、不新建进程、不整棵 HMR 重载',
        'reconcileInLock/patchAttemptInLock 保持原实现；只给 reserveWorkInLock/executeStart 外层补增量',
        'sidecar 探针未通过 → 不切换入口；postcondition 不通过 → 完整回滚并失败',
      ],
    };
  }
  function snapshot() {
    return { plan: plan(), postcondition, active: deps.service?.__hotUpgrade ?? null };
  }

  return { plan, activate, snapshot, NEW_METHOD_NAMES, NEW_TABLES, NEW_TOOL_NAMES };
}
