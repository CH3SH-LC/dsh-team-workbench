/**
 * `service.js` — `TeamWorkbenchService`，本插件唯一的业务操作入口。
 *
 * UI（web 线路 / 命令）与模型工具调用的是**同一批方法**：操作只实现一次，
 * 两个调用方共用，失败原因原样返回（见 `references/user-actions.md`）。
 *
 * 角色分离：
 *   - 原生 Team task 的 owner 是 **member**（`ownerMemberId`）。
 *   - 真正执行的是 continuable 子智能体（`AttemptRecord.executorChildId`）。
 *   - member 派出子智能体后仍对模块负责；子智能体说“完成”不等于任务完成。
 *
 * 硬不变式（本文件是唯一写者，全部变更走 `this.mutex`）：
 *   1. 单 Host 写者（storage.claimWriter）。
 *   2. 每个实体带 `rev`，认领/回执带 `expectedRevision` / `leaseEpoch` 做 CAS。
 *   3. 幂等键：重复事件与重复提交不产生第二份 attempt / 第二份交付。
 *   4. 启动意图（attemptId + 预分配 childId + 容量记账）先落盘，再在锁外启动；
 *      启动回执丢失时由 `reconcile()` 对账，不重复创建。
 *   5. 过期 lease 的迟到结果只进 `lateResults`，不覆盖新版本。
 *   6. 不向 `Session.append` 写未知 event type；扩展事实只进 storageDomain。
 */
import { completionGate, detectMechanicalTranscription, validateWorkGraph, validateWorkSpec } from './policy.js';
// 2026-10-17 整改新增（契约 v1）：稳定身份 / 证据式完成 / 错误指纹 / 费用归账 / 成果投影 / 机械物化。
import { identityRecordFor, judgeIdentity } from './identity.js';
import { completionFromValidation, evidenceRecordFor, isEvidenceStale, validateEvidence } from './evidence.js';
import { buildOperationDescriptor, createErrorFingerprints, fileEpochOf } from './fingerprints.js';
import { createUsageLedger } from './usage.js';
import { buildContextPage, buildFindings, CONTEXT_LIMITS, findingsDetailPage, summaryOfFindings } from './findings.js';
import { createMaterializer } from './materialize.js';
import { createExecutionRunner } from './execution.js';
import { createNativeUsageCollector, nativeSourceSummary } from './nativeUsage.js';
import { createContextControl } from './contextControl.js';
import { applyHotUpgrade, planHotUpgrade } from './upgrade.js';
import { refreshSkillSections } from './skills.js';
import {
  AUTONOMOUS_WORK_STATES,
  EXECUTION_MODES,
  MISSION_STATES,
  appendProvenance,
  decisionAfter,
  eventDedupeKey,
  isAutonomousWork,
  isMemberEventType,
  provenance,
  requiresAuthorizedIntent,
  requiresSchedulerStart,
  stripSpoofedIdentity,
  summarizeEvent,
  waitReasonOf,
  wakeReasonOf,
} from './autonomy.js';
import { LATE_RESULTS_TABLE } from './storage.js';
import { createDiagnostics, createMutex, conflictsWithHolders, newId, safeClone, sha256Hex, stableStringify, toStringArray } from './util.js';

export const WORK_STATES = Object.freeze(['draft', 'ready', 'claimed', 'executing', 'produced', 'verifying', 'failed', 'blocked', 'cancelled']);
export const ATTEMPT_STATES = Object.freeze(['reserved', 'starting', 'executing', 'waiting', 'produced', 'verifying', 'failed', 'cancelled']);

const TERMINAL_ATTEMPT_STATES = new Set(['produced', 'failed', 'cancelled']);
/**
 * 原生容量码：这些不是"任务失败"，而是"现在没名额"。
 * 原生池（`maxActiveSubagents`，默认 8）满了会直接抛 `ACTIVATION_LIMIT_REACHED` 而**不排队**，
 * 所以调度器必须**拒绝并保持 ready**、退避后再试，绝不能计成失败——
 * 真实 11 怪物验收里，把容量码当失败会让 4 个工作项被 `REPEATED_IDENTICAL_FAILURE` 误判为阻塞。
 */
const CAPACITY_CODES = new Set([
  'ACTIVATION_LIMIT_REACHED',
  'CAPACITY_FULL',
  'RESIDENT_CAPACITY_FULL',
  'WORKER_CAPACITY_FULL',
  'MEMBER_FAIR_SHARE_FULL',
  'PROVIDER_CAPACITY_FULL',
  'SUBAGENT_DELIVERY_UNAVAILABLE',
]);
const RESIDENT_ATTEMPT_STATES = new Set(['reserved', 'starting', 'executing', 'waiting', 'verifying']);
const LEAF_ATTEMPT_STATES = new Set(['executing', 'waiting']);
const LEASE_TTL_MS = 30 * 60 * 1000;

/**
 * **leaf 的工具面策略**（契约 §15）。
 *
 * 事实（真实 T02 实测 + `cordis_inspect_query(provider=Service, service=subagents)`）：
 * `subagents.startContinuable` 的 `request.toolFilter` 是 `ToolRestriction {allow?, deny?}`
 * （`ContinuableSubagentDescriptorData.toolFilter?: ToolRestriction`）。
 *
 * 曾经的实现在这里用 `allow: ['team_ask_owner','team_work_report']`，结果是 leaf 只拿到
 * `subagent` / `team_ask_owner` / `team_work_report` —— **没有读写文件与执行命令的能力**，
 * 叶子只能产出回执、产不出产物，任务 §六/§十要求的"leaf 端到端完成一份交付"不可能成立。
 *
 * 因此改成 **deny 形态**：leaf 继承父（member）的完整工具面（含 read/write/edit/glob/grep/pwsh），
 * 只显式**剥夺**"成员级/团队管理/旁路受管队列"的能力。这样以后平台新增文件或检索类工具时，
 * leaf 不会静默失去它们（allow 形态会）。
 *
 * 注意：真正的权限判定仍在 Host 侧（`assertTeamOf` / `assertModuleScope`）——
 * leaf 解析出的角色是 `root`，任何成员级入口都会被 `TEAM_MEMBER_REQUIRED` / `TEAM_LEAD_REQUIRED` 拒绝。
 * 这里剥夺的只是**工具可见性**（防误用与防误导），不是唯一防线，也不允许被当成唯一防线。
 */
export const LEAF_DENIED_TOOLS = Object.freeze([
  // 成员级自治入口：leaf 不规划、不派发、不验收、不取消
  'team_define',
  'team_member_create',
  'team_mission_assign',
  'team_plan_submit',
  'team_dispatch_authorize',
  'team_plan_cancel',
  'team_work_submit',
  'team_work_claim',
  'team_work_verify',
  'team_member_inbox',
  'team_subagent_start',
  'team_interrupt',
  'team_recover',
  'team_layout',
  // 2026-10-17 整改新增：leaf 不得直接触发可信执行/物化/费用与成果查询（成员级入口）。
  'team_exec_check',
  'team_materialize',
  'team_usage',
  'team_findings',
  'team_error_fingerprints',
  'team_context_query',
  // 官方 team / 子智能体旁路：leaf 不得自建同级或绕开受管队列
  'spawn_teammate',
  'send_message',
  'interrupt_agent',
  'wait_agent',
  'list_agents',
  'team_task_create',
  'team_task_get',
  'team_task_list',
  'team_task_update',
  'subagent',
  'subagent_fork',
  // 直接打扰用户会绕过 owner 协调链（leaf 的求助入口是 team_ask_owner）
  'ask_user_question',
]);

/** leaf **必须**具备的能力（回归断言用；它们绝不能被放进 deny 列表）。 */
export const LEAF_REQUIRED_TOOLS = Object.freeze(['read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'team_ask_owner', 'team_work_report']);

/** 受管 team 工具名集合：这些是本插件自己注册的，一定在注册表里（漏剥夺会红）。 */
export const MEMBER_LEVEL_TOOLS = Object.freeze([
  'team_define',
  'team_member_create',
  'team_mission_assign',
  'team_plan_submit',
  'team_dispatch_authorize',
  'team_plan_cancel',
  'team_work_submit',
  'team_work_claim',
  'team_work_verify',
  'team_member_inbox',
  'team_subagent_start',
  'team_interrupt',
  'team_recover',
  'team_layout',
  // 2026-10-17 整改新增的成员级能力（leaf 不得直接用：执行/物化/费用/成果/指纹/上下文查询）。
  'team_exec_check',
  'team_materialize',
  'team_usage',
  'team_findings',
  'team_error_fingerprints',
  'team_context_query',
]);

/**
 * leaf 的 deny 列表**必须先与真实注册表求交**。
 *
 * 真因（真实桌面实测 2026-10-16）：`LEAF_DENIED_TOOLS` 里写了本 profile **未注册为 global tool**
 * 的名字（官方 agent-team 那套 `spawn_teammate` / `wait_agent` / `team_task_*` …）。
 * `subagents.startContinuable` 内部把 `toolFilter` 交给 `tools.restrict()`，而 `restrict`
 * 对未知名字**直接抛**：`tools.restrict() names unknown global tools: "spawn_teammate", …`。
 * 后果比原缺陷更糟——**叶子完全起不来**（连续 6 次 attempt 全是 `START_RECEIPT_FAILED`，
 * work 白停在 `executing`）。
 *
 * 因此：**只把注册表里真实存在的名字传下去**；注册表读不到时**不传 toolFilter**
 * （宁可多给可见性——Host 侧 `assertTeamOf`/`assertModuleScope` 仍是权限真门；
 * 而传未知名字会让 leaf 根本创建不了）。
 *
 * @param {string[]|undefined} registeredNames `ctx.tools.schemas()` 的名字集合；undefined/空 = 读不到
 * @returns {{ deny: string[]|null, dropped: string[], reason: string|null }}
 */
export function filterLeafDeniedTools(registeredNames) {
  if (!Array.isArray(registeredNames) || registeredNames.length === 0) {
    return { deny: null, dropped: [], reason: 'REGISTRY_UNAVAILABLE' };
  }
  const registered = new Set(registeredNames.map(String));
  const neverDeny = new Set(LEAF_REQUIRED_TOOLS);
  // 双重保险：即使 deny 清单里误入了文件/命令工具，也在过滤阶段剥掉——
  // §15 的全部意义就是"叶子必须能产出产物"，这条不变式不能只靠人工清单的正确性。
  const deny = LEAF_DENIED_TOOLS.filter((name) => registered.has(name) && !neverDeny.has(name));
  const dropped = LEAF_DENIED_TOOLS.filter((name) => !registered.has(name));
  return { deny, dropped, reason: null };
}



/**
 * **原生 session 元数据发现**（模块级，供真实类实例与历史 reader 契约共用）。
 *
 * 审计固定契约：`backfillHistoricalFromKnownSessions` 可被独立调用（包括只带
 * teams/members/attempts/ctx 的实例），所以这里不依赖实例上的新方法是否挂好：
 * 依次尝试 `service.adapter.listSessions()` → `service.ctx.get('sessionPersistence'|'sessionQuery').list()`。
 * 只读、不读正文、结果缓存在 `service.sessionMetadataCache`（归属 facts 是同步的）。
 *
 * @returns {Promise<{sessions:Array<{id:string,parentSession:string|null}>, source:string|null, count:number}>}
 */
async function discoverSessionMetadata(service) {
  let rows = [];
  let source = null;
  const listed = service?.adapter && typeof service.adapter.listSessions === 'function'
    ? await service.adapter.listSessions()
    : null;
  if (Array.isArray(listed)) rows = listed;
  else if (listed?.ok === true && Array.isArray(listed.value)) { rows = listed.value; source = 'adapter.listSessions'; }
  else if (listed && listed.ok === false) source = 'adapter.listSessions:failed';
  if (rows.length === 0 && typeof service?.ctx?.get === 'function') {
    const persistence = service.ctx.get('sessionPersistence') ?? service.ctx.get('sessionQuery');
    if (persistence && typeof persistence.list === 'function') {
      try {
        const raw = await persistence.list();
        rows = (Array.isArray(raw) ? raw : []).map((snapshot) => ({
          id: String(snapshot?.header?.id ?? snapshot?.id ?? ''),
          parentSession: snapshot?.header?.parentSession ?? snapshot?.parentSession ?? null,
        })).filter((entry) => entry.id);
        source = 'sessionPersistence.list';
      } catch (error) {
        service?.diagnostics?.push?.('service:session-metadata:failed', String(error?.message ?? error));
        source = 'sessionPersistence.list:failed';
      }
    }
  }
  const normalized = rows
    .map((entry) => ({
      id: String(entry?.id ?? entry?.header?.id ?? entry?.sessionId ?? ''),
      parentSession: entry?.parentSession ?? entry?.header?.parentSession ?? null,
      header: { id: String(entry?.id ?? entry?.header?.id ?? entry?.sessionId ?? ''), parentSession: entry?.parentSession ?? entry?.header?.parentSession ?? null },
    }))
    .filter((entry) => entry.id);
  if (service && typeof service === 'object') {
    try { service.sessionMetadataCache = normalized; } catch { /* 只读实例 */ }
  }
  return { sessions: normalized, source, count: normalized.length };
}

function denied(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

/**
 * @param {object} ctx
 * @param {object} adapter createAdapter(ctx)
 * @param {object} storage createStorage(ctx, adapter)
 * @param {object} config normalizeConfig(raw)
 * @param {{ clock?: {now:()=>number}, mutex?: object, leaseTtlMs?: number, diagnosticsLimit?: number }} [options]
 */
export class TeamWorkbenchService {
  constructor(ctx, adapter, storage, config, options = {}) {
    this.ctx = ctx;
    this.adapter = adapter;
    this.storage = storage;
    this.config = config;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.mutex = options.mutex ?? createMutex('workbench');
    this.leaseTtlMs = Number.isFinite(options.leaseTtlMs) ? options.leaseTtlMs : LEASE_TTL_MS;
    /**
     * 成员回合看门狗：只在平台没有把 `agent/status=idle` 送达时兜底解除在飞标记。
     * 它**不生成空回合**，只允许下一个真实事件再次唤醒（避免队列被永久挡住）。
     */
    this.memberTurnWatchdogMs = Number.isFinite(options.memberTurnWatchdogMs) ? options.memberTurnWatchdogMs : 5 * 60 * 1000;
    this.diagnostics = createDiagnostics(options.diagnosticsLimit ?? 400);

    this.teams = new Map();
    this.members = new Map();
    this.works = new Map();
    this.attempts = new Map();
    this.lateResults = [];
    /** 成员自治（契约 §1/§4）：模块委托、派发意图、成员事件队列与消费游标。 */
    this.missions = new Map();
    this.dispatchIntents = new Map();
    this.memberEvents = new Map();
    this.memberCursors = new Map();
    /** 每个成员"同时只允许一个在飞回合"的簿记（契约 §6）。 */
    this.memberTurns = new Map();
    // ---- 2026-10-17 整改新增（契约 v1）--------------------------------------
    /** 稳定交付物身份记录（workId → 身份绑定；不改标题/kind 也不变）。 */
    this.identityRecords = new Map();
    /** 证据记录（workId → 最近一次校验记录；用于过期判定与 findings）。 */
    this.evidenceRecords = new Map();
    /** 证据过期/历史声明（findings.invalidated 的来源之一）。 */
    this.evidenceInvalidations = [];
    /**
     * 前端激活回执（`POST /op client-ack`，纯元数据）。
     * key = `${bundle.url}|${activatedAt}`，幂等去重；只证明"前端已挂载并报告该 bundle"，
     * **不等于**视觉验收，也**不等于** Host 已加载新代码。
     */
    this.frontendAckIndex = new Map();
    /** workId → 真实文件 epoch（sha/bytes/mtime；ENOENT→创建、内容变化都会改变它，用于避免版本未知时永久误拦）。 */
    this.fingerprintFileEpochs = new Map();
    /** workId → 成功 read/grep/glob 的次数（读取基准 epoch；重启后从冷恢复重新计数）。 */
    this.toolReadSeq = new Map();
    /** 原生 session 元数据缓存（祖先归属用；由 refreshSessionMetadata 刷新）。 */
    this.sessionMetadataCache = [];
    /** 维护压缩串行链（同进程内维护请求互斥；持久 CAS/once 见 requestMaintenance）。 */
    this.maintenanceChain = Promise.resolve();
    /** 维护压缩记录（compactNow 维护路径；最多保留 50 条，供 /state.maintenance）。 */
    this.maintenanceLog = [];
    /** 错误指纹（重复执行拦截 + 前端展开）。 */
    this.fingerprints = createErrorFingerprints({ storage, clock: this.clock });
    /** 费用归账（增量 sidecar；只读投影进 /state）。 */
    this.usageLedger = createUsageLedger({
      storage,
      clock: this.clock,
      // 契约 §1 修订：按 provider/model/生效时段价目表；**默认空表**（unknown ≠ 0）。
      priceBook: config?.usage?.priceBook ?? null,
      sourcePath: config?.usage?.sourcePath ?? null,
      readRange: typeof adapter.readFileRange === 'function'
        ? async (target, offset, length) => {
          const result = await adapter.readFileRange(target, offset, length);
          return result.ok ? { ok: true, text: result.value?.text ?? '', size: result.value?.size ?? 0 } : { ok: false, error: result.message };
        }
        : null,
      // 祖先归属需要真实 sessions/nativeTeams（不能只给 members/attempts/teams）；缺接口返回 []，不伪造。
      facts: () => ({
        members: this.members,
        attempts: this.attempts,
        teams: this.teams,
        sessions: this.usageSessionFacts(),
        nativeTeams: this.usageNativeTeamFacts(),
      }),
    });
    /** 机械物化器（契约 §3）：允许根 = 配置 roots ∪ 进程 cwd。 */
    this.materializer = createMaterializer({
      cwd: process.cwd(),
      roots: Array.isArray(config?.materialize?.roots) && config.materialize.roots.length > 0 ? config.materialize.roots : [process.cwd()],
      maxBytes: config?.materialize?.maxBytes,
    });
    /**
     * 可信执行器（契约 §3 修订 / Codex 审阅）：证据只能引用这里记录的真实 run。
     * 命令由 Host 以 `spawn(argv, {shell:false})` 执行，记录 exitCode 与产物 sha256。
     */
    this.executionRunner = createExecutionRunner({
      storage,
      clock: this.clock,
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
    /**
     * 契约 §1（Codex 修订）：**当前宿主的增量计费**——从 live Agent 的原生 session 事件
     * （`Session.snapshotEvents`）按游标折账；审计 JSONL 只做验收重放，不作生产归账。
     */
    this.nativeUsage = createNativeUsageCollector({
      adapter,
      ledger: this.usageLedger,
      clock: this.clock,
      maxSessions: config?.usage?.maxSessions,
      maxEventsPerSession: config?.usage?.maxEventsPerSession,
      diagnostics: this.diagnostics,
      // 持久游标：重启/分批补录可续读（新表经 facade 落 sidecar；每次都从 this.storage 取，
      // 因此热升级切换 facade 后依然生效）。
      loadCursor: (sessionId) => {
        try {
          const stored = this.storage.get('usage_cursors', `native:${sessionId}`);
          if (!stored || typeof stored !== 'object') return 0;
          // provider/model 与 seq 一起持久化：跨页/重启后事件路由不丢（费用审计 14:27 失败项 06/07）。
          return { seq: Number.isInteger(stored.seq) ? stored.seq : 0, provider: stored.provider ?? null, model: stored.model ?? null };
        } catch {
          return 0;
        }
      },
      saveCursor: async (sessionId, seq, extra) => {
        await this.storage.put('usage_cursors', `native:${sessionId}`, { seq, ...extra });
      },
    });
    /**
     * 契约 §2/§6（Codex 要求 2）：`agent/pre-step` 请求前紧凑状态注入 + 原生工具守卫。
     * 只覆盖受管团队；不吞队列、不换 owner、不做全局压缩。
     */
    this.contextControl = createContextControl({
      service: this,
      config,
      clock: this.clock,
      diagnostics: this.diagnostics,
      compactStateFor: (agent) => this.compactStateFor(agent),
    });
    /** findings 缓存（按 revision 失效；不触发模型调用也不重扫日志）。 */
    this.findingsCache = null;
    this.findingsCacheRevision = -1;
    this.phaseStartedAt = this.clock.now();
    this.layoutRecord = defaultLayout();
    this.revision = 0;
    this.readOnly = false;
    this.readOnlyReason = null;
    this.listeners = new Set();
    this.startedAt = this.clock.now();
    this.stats = { ticks: 0, startsAttempted: 0, startsSucceeded: 0, startsRejected: 0, settlements: 0, lateResults: 0, duplicatesSuppressed: 0 };
  }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------
  /**
   * 启动 hydration + 写者认领。**必须在插件 apply 的同步段之外启动**：
   * Cordis 的 effect/inject 只能在插件 fiber 处于 active 时创建，而第一个
   * `await` 之后就可能在非 active 窗口里，因此 apply 先同步注册，再异步初始化。
   */
  beginInit() {
    if (!this.initPromise) {
      this.initPromise = this.init().catch((error) => {
        this.diagnostics.push('service:init-failed', String(error?.message ?? error));
        this.initError = error;
        throw error;
      });
    }
    return this.initPromise;
  }

  /** 工具与线路在调用任何业务方法前先等这一次初始化。 */
  whenReady() {
    return this.initPromise ?? Promise.resolve();
  }

  async init() {
    const ready = await this.storage.ready();
    if (this.config.singleWriter && !ready.writerHeld) {
      this.readOnly = true;
      this.readOnlyReason = ready.secondWriter ? 'SECOND_WRITER' : 'WRITER_UNAVAILABLE';
      this.diagnostics.push('service:read-only', `进入只读诊断态：${this.readOnlyReason}`, ready.secondWriter ?? null);
    }
    const snapshot = this.storage.loadAll();
    this.revision = Math.max(this.revision, Number.isInteger(snapshot.revision) ? snapshot.revision : 0);
    for (const [key, value] of this.storage.list('teams')) this.teams.set(key, value);
    for (const [key, value] of this.storage.list('members')) this.members.set(key, value);
    for (const [key, value] of this.storage.list('works')) this.works.set(key, value);
    for (const [key, value] of this.storage.list('attempts')) this.attempts.set(key, value);
    for (const [key, value] of this.storage.list('missions')) this.missions.set(key, value);
    for (const [key, value] of this.storage.list('dispatch_intents')) this.dispatchIntents.set(key, value);
    for (const [key, value] of this.storage.list('member_events')) this.memberEvents.set(key, value);
    for (const [key, value] of this.storage.list('member_cursors')) this.memberCursors.set(key, value);
    for (const [key, value] of this.storage.list(LATE_RESULTS_TABLE)) this.lateResults.push(value);
    // 2026-10-17 整改新增（全部为新增表；旧表一行不动）。
    for (const [key, value] of this.storage.list('identity_records')) this.identityRecords.set(key, value);
    for (const [key, value] of this.storage.list('evidence_records')) this.evidenceRecords.set(key, value);
    // 正常启动恢复 client-ack 索引（sidecar meta_records）：hot 写 → 下次正常启动必须可见。
    // 旧 base storage 没有该表（例如测试/未升级实例）→ 静默跳过，不把启动打死。
    try {
      for (const [key, value] of this.storage.list('meta_records')) {
        if (String(key).startsWith('frontend_ack:')) this.frontendAckIndex.set(String(key).slice('frontend_ack:'.length), value);
      }
    } catch { /* 旧 storage 无 meta_records：升级后用 facade 才会出现 */ }
    this.fingerprints.hydrate();
    this.usageLedger.hydrate();
    this.usageLedger.markPhaseStart();
    this.executionRunner.hydrate();
    const layout = this.storage.get('layout', 'current');
    if (layout) this.layoutRecord = normalizeLayout(layout);
    this.diagnostics.push('service:init', 'state hydrated', {
      teams: this.teams.size,
      members: this.members.size,
      works: this.works.size,
      attempts: this.attempts.size,
      missions: this.missions.size,
      dispatchIntents: this.dispatchIntents.size,
      memberEvents: this.memberEvents.size,
      identityRecords: this.identityRecords.size,
      evidenceRecords: this.evidenceRecords.size,
      executionRuns: this.executionRunner.size(),
      frontendAcks: this.frontendAckIndex.size,
      errorFingerprints: this.fingerprints.size(),
      durable: this.storage.durable,
    });
    return {
      readOnly: this.readOnly,
      readOnlyReason: this.readOnlyReason,
      durable: this.storage.durable,
      backend: this.storage.backend,
      backendError: this.storage.backendError,
      fallbackDir: this.storage.fallbackDir,
      migrationRequired: this.storage.migrationRequired,
    };
  }

  /** 订阅状态变化（调度器用它做合并唤醒）。 */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(reason, detail) {
    for (const listener of [...this.listeners]) {
      try {
        listener(reason, detail);
      } catch (error) {
        this.diagnostics.push('service:listener-failed', String(error?.message ?? error), { reason });
      }
    }
  }

  async dispose() {
    // 成员回合簿记与唤醒队列的定时器必须显式清掉：unref 的定时器不该跨插件世代存活。
    for (const state of this.memberTurns?.values() ?? []) {
      if (state.watchdog) clearTimeout(state.watchdog);
      state.watchdog = null;
    }
    this.memberTurns?.clear();
    for (const attempt of this.attempts.values()) {
      if (!TERMINAL_ATTEMPT_STATES.has(attempt.state)) {
        attempt.state = 'cancelled';
        attempt.endedAt = this.clock.now();
        attempt.endReason = 'plugin-dispose';
      }
    }
    // 释放为启动 leaf 而冷唤醒的 parent Agent，避免它们一直挂在注册表里。
    for (const [sessionId, handle] of this.resumedAgentHandles ?? []) {
      const released = await this.adapter.releaseAgentHandle(handle);
      if (!released.ok) this.diagnostics.push('service:cold-resume-release-failed', `${sessionId}: ${released.code} ${released.message}`);
    }
    this.resumedAgentHandles?.clear();
    await this.storage.close();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------------
  // 身份与授权
  // ---------------------------------------------------------------------------
  /**
   * 解析调用者身份。**禁止**从 sessionId 构造假身份：先取真实 live Agent，
   * 再由 `agentTeams.tryMembership` 决定它是不是 Team 成员。
   */
  actor(caller) {
    if (!caller || typeof caller.id !== 'string' || !caller.id) {
      return denied('AGENT_REQUIRED', '该操作必须由真实 Agent 调用：缺少 Agent 身份。');
    }
    const live = this.adapter.agentFor(caller.id);
    const agent = live ?? caller;
    const membership = this.adapter.membership(agent);
    if (membership.ok && membership.value) {
      const value = membership.value;
      return {
        ok: true,
        agent,
        live: live !== undefined,
        role: value.role === 'lead' ? 'lead' : 'member',
        teamKey: String(value.id),
        memberId: value.role === 'lead' ? 'lead' : String(value.name),
        rootId: value.root && typeof value.root.id === 'string' ? value.root.id : String(value.id),
        membershipCode: membership.code ?? null,
      };
    }
    return {
      ok: true,
      agent,
      live: live !== undefined,
      role: 'root',
      teamKey: null,
      memberId: null,
      rootId: String(caller.id),
      membershipCode: membership.code ?? null,
      membershipMessage: membership.message ?? null,
    };
  }

  teamOf(actor, teamKey) {
    const key = teamKey ?? actor.teamKey;
    if (!key) return undefined;
    return this.teams.get(key);
  }

  /**
   * 原生 Team id ↔ sidecar teamKey 的对照。
   *
   * 原生 Team 的 identity 是 **root session id**（`membership.id`），而 sidecar 的
   * `teamKey` 是用户可读的名字（例如 `wb-member-verify`）。两者**不是同一个字符串**，
   * 因此任何角色判定都必须同时接受这两个形式——真实桌面/独立 profile 验收里，
   * lead 因为只比自己那一个字符串而被误判成"不在该团队"，导致合法的回执被
   * `DELEGATION_SCOPE` 拒绝。
   */
  teamKeyForNative(nativeTeamId) {
    for (const team of this.teams.values()) {
      if (team.nativeTeamId === nativeTeamId) return team.teamKey;
    }
    return undefined;
  }

  /** 调用者是否属于给定 sidecar teamKey（原生 id 与 sidecar key 都接受）。 */
  isSameTeam(actor, teamKey) {
    if (!actor || !teamKey) return false;
    const team = this.teams.get(teamKey);
    return actor.teamKey === teamKey || (team !== undefined && actor.teamKey === team.nativeTeamId);
  }

  /** 解析团队 key：显式优先；否则用调用者原生 id 反查 sidecar teamKey。 */
  resolveTeamKey(actor, requested) {
    if (typeof requested === 'string' && requested.trim()) return requested.trim();
    if (!actor?.teamKey) return null;
    const mapped = this.teamKeyForNative(actor.teamKey);
    return mapped ?? actor.teamKey;
  }

  /** 写权限：单 Host 写者 + 只读诊断态。 */
  assertWritable() {
    if (this.readOnly) return denied(this.readOnlyReason ?? 'READ_ONLY', `调度器处于只读诊断态（${this.readOnlyReason}）：不抢写、不产生第二次执行。`);
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // 布局
  // ---------------------------------------------------------------------------
  layout() {
    return safeClone(this.layoutRecord);
  }

  /**
   * 复核确认：`assertBindableTarget` 在「缺父地址 / 父 Agent 不存活 / roster 读不到」时是
   * **故意 fail-open** 的——把一条合法成员会话误判成 leaf 的代价更高（成员 Agent 闲置时
   * 用户就绑不上它）。但 fail-open **不能静默**：每一次无法核实都记诊断 + 计数，
   * 并由客户端侧做 fail-closed 兜底（`isTargetBindable` 要求正面证据）。
   * 结论：**这个残余缺口是被公开记录的，不是被隐藏的**。
   */
  noteUnverifiedSubagentTarget(target, reason) {
    this.unverifiedSubagentTargets = (this.unverifiedSubagentTargets ?? 0) + 1;
    if (this.unverifiedSubagentTargets <= 20) {
      this.diagnostics.push(
        'service:subagent-target-unverified',
        `无法核实子会话 ${target.childSessionId} 是否为 agent team 成员（${reason}）：Host 侧按 fail-open 放行，由客户端 fail-closed 兜底。`,
        { parentSessionId: target.parentSessionId ?? null, reason },
      );
    }
  }

  /**
   * 用户明确要求「所有子智能体一律拒绝」：窗格只允许绑**工作区主会话**或**agent team 成员会话**。
   * 客户端在读取层已经过滤（权威判定来自 `agentTeam` 投影），这里是 Host 侧的第二道闸，
   * 因为本插件自己的 `team_layout` 工具可以提交任意 targets。
   *
   * 判定顺序（**避免误伤官方 `spawn_teammate` 建出的成员**）：
   *   1. 顶层会话目标 → 允许；
   *   2. sidecar `members` 里有这个 sessionId → 允许（本插件建的成员）；
   *   3. 地址里有 `parentSessionId` 且父 Agent 存活 → 查**原生 roster**：命中则允许；
   *   4. 无法核实（缺父地址 / 父不存活 / roster 读不到）→ **fail-open 放行 + 记诊断**
   *      （`noteUnverifiedSubagentTarget`），由客户端 fail-closed 兜底；
   *   5. 父 Agent 存活且 roster **明确不含**该 child → 判定为 leaf，拒绝。
   */
  async assertBindableTarget(target) {
    if (!target) return { ok: true };
    const childId = typeof target.childSessionId === 'string' ? target.childSessionId : null;
    if (!childId) return { ok: true }; // 顶层会话目标：允许
    if ([...this.members.values()].some((member) => member.sessionId === childId)) return { ok: true };

    const parentId = typeof target.parentSessionId === 'string' ? target.parentSessionId : null;
    if (!parentId) {
      this.noteUnverifiedSubagentTarget(target, 'PARENT_ADDRESS_MISSING');
      return { ok: true };
    }
    const parent = this.adapter.agentFor(parentId);
    if (!parent) {
      this.noteUnverifiedSubagentTarget(target, 'PARENT_AGENT_NOT_LIVE');
      return { ok: true };
    }
    const roster = await this.adapter.listMembers(parent);
    if (!roster.ok) {
      this.noteUnverifiedSubagentTarget(target, 'ROSTER_UNAVAILABLE');
      return { ok: true };
    }
    const rosterIds = (Array.isArray(roster.value) ? roster.value : []).map((member) => String(member?.id ?? ''));
    if (rosterIds.includes(childId)) return { ok: true };

    this.leafTargetsRejected = (this.leafTargetsRejected ?? 0) + 1;
    return {
      ok: false,
      code: 'LEAF_NOT_BINDABLE',
      message: `子智能体会话 ${childId} 不在 ${parentId} 的原生 Team roster 里：窗格只允许绑工作区主会话或团队成员（用户要求所有子智能体一律拒绝）。`,
    };
  }

  async setLayout(mode, patch = {}) {
    const writable = this.assertWritable();
    if (!writable.ok) return writable;
    return this.mutex.run(async () => {
      const allowed = [1, 2, 4];
      const nextMode = allowed.includes(Number(mode)) ? Number(mode) : this.layoutRecord.mode;
      const supplied = Array.isArray(patch.panes) ? patch.panes.slice(0, 4).map(normalizePane) : this.layoutRecord.panes;
      // 过滤掉不可绑的目标：整批布局也不能成为绕过入口。
      const rejectedTargets = [];
      const panes = [];
      for (const pane of supplied) {
        const allowedTarget = await this.assertBindableTarget(pane.target);
        if (allowedTarget.ok) {
          panes.push(pane);
          continue;
        }
        rejectedTargets.push({ paneId: pane.paneId, code: allowedTarget.code });
        panes.push({ ...pane, target: null, label: '', role: 'auto' });
      }
      if (rejectedTargets.length > 0) {
        this.diagnostics.push('service:setLayout:leaf-target-stripped', `批量布局里 ${rejectedTargets.length} 个窗格的子智能体目标被拒绝并清空。`, rejectedTargets);
      }
      const activePaneId = panes.some((pane) => pane.paneId === patch.activePaneId)
        ? patch.activePaneId
        : (panes[0]?.paneId ?? null);
      const next = {
        ...this.layoutRecord,
        mode: nextMode,
        panes,
        activePaneId,
        ratios: patch.ratios && typeof patch.ratios === 'object' ? patch.ratios : this.layoutRecord.ratios,
        teamView: patch.teamView && typeof patch.teamView === 'object' ? patch.teamView : this.layoutRecord.teamView,
      };
      const committed = await this.commitLayout(next, 'setLayout');
      return rejectedTargets.length > 0 ? { ...committed, rejectedTargets } : committed;
    });
  }

  async upsertPane(pane) {
    const writable = this.assertWritable();
    if (!writable.ok) return writable;
    return this.mutex.run(async () => {
      const normalized = normalizePane(pane);
      if (!normalized.paneId) return denied('PANE_ID_REQUIRED', 'pane 必须带 paneId。');
      // Host 侧第二道闸：leaf 目标一律拒绝（用户要求所有子智能体一律拒绝）。
      const bindable = await this.assertBindableTarget(normalized.target);
      if (!bindable.ok) {
        this.diagnostics.push('service:upsertPane:leaf-target-rejected', bindable.message, { paneId: normalized.paneId, target: normalized.target });
        return denied(bindable.code, bindable.message, { paneId: normalized.paneId, hint: '窗格只允许绑工作区主会话或 agent team 成员会话。' });
      }
      const targetSessionId = sessionIdOf(normalized.target);
      const panes = this.layoutRecord.panes.slice();
      if (targetSessionId) {
        const existing = panes.find((candidate) => candidate.paneId !== normalized.paneId && sessionIdOf(candidate.target) === targetSessionId);
        if (existing) {
          // 同一 Session 不能同时挂两个原生编辑器：改为聚焦已有 pane。
          const next = { ...this.layoutRecord, panes, activePaneId: existing.paneId };
          const committed = await this.commitLayout(next, 'upsertPane:focus-existing');
          return { ...committed, focusedExisting: existing.paneId, reason: '同一 Session 已在另一个 pane 打开，已改为聚焦该 pane（不会创建第二个可编辑根）。' };
        }
      }
      const index = panes.findIndex((candidate) => candidate.paneId === normalized.paneId);
      if (index >= 0) panes[index] = { ...panes[index], ...normalized };
      else panes.push(normalized);
      const next = { ...this.layoutRecord, panes: panes.slice(0, 4), activePaneId: normalized.paneId };
      return this.commitLayout(next, 'upsertPane');
    });
  }

  async removePane(paneId) {
    const writable = this.assertWritable();
    if (!writable.ok) return writable;
    return this.mutex.run(async () => {
      // 关闭窗格 = 释放绑定，**不删除窗格身份**（客户端把打开/关闭建模为"有/无 target"，
      // 四个 paneId 是固定身份）。同时**不停止任何 Agent**。
      const panes = this.layoutRecord.panes.map((pane) =>
        pane.paneId === paneId ? { ...pane, target: null, label: '', role: 'auto' } : pane,
      );
      const activePaneId =
        this.layoutRecord.activePaneId === paneId
          ? (panes.find((pane) => pane.paneId !== paneId && pane.target !== null)?.paneId ?? panes[0].paneId)
          : this.layoutRecord.activePaneId;
      return this.commitLayout({ ...this.layoutRecord, panes, activePaneId }, 'removePane:agent-untouched');
    });
  }

  async focusPane(paneId) {
    const writable = this.assertWritable();
    if (!writable.ok) return writable;
    return this.mutex.run(async () => {
      if (!this.layoutRecord.panes.some((pane) => pane.paneId === paneId)) return denied('PANE_NOT_FOUND', `没有 pane ${paneId}`);
      return this.commitLayout({ ...this.layoutRecord, activePaneId: paneId }, 'focusPane');
    });
  }

  async commitLayout(next, reason) {
    const record = { ...normalizeLayout(next), updatedAt: this.clock.now() };
    // 只存一份记录，不要把 record 再嵌进自己的 value 字段（早期版本会写两遍）。
    const result = await this.storage.put('layout', 'current', record, { expectRev: this.layoutRecord.rev, touchGlobalRevision: false });
    if (!result.ok) {
      if (result.code === 'CAS_MISMATCH') {
        // 布局是低风险状态：整体替换即可，不做部分合并。
        const retry = await this.storage.put('layout', 'current', record, { touchGlobalRevision: false });
        if (!retry.ok) return denied(retry.code ?? 'PERSIST_FAILED', '布局写入失败', { detail: retry.message });
        this.layoutRecord = { ...record, rev: retry.rev };
      } else {
        return denied(result.code ?? 'PERSIST_FAILED', '布局写入失败', { detail: result.message });
      }
    } else {
      this.layoutRecord = { ...record, rev: result.rev };
    }
    this.diagnostics.push('service:layout', reason, { mode: this.layoutRecord.mode, activePaneId: this.layoutRecord.activePaneId });
    this.notify('layout', { reason, layout: this.layout() });
    return { ok: true, layout: this.layout() };
  }

  // ---------------------------------------------------------------------------
  // 团队与成员
  // ---------------------------------------------------------------------------
  /**
   * 团队记录的解析：原生 Team 对每个 live root 会话都已经给出 lead 身份，
   * sidecar 的 TeamRecord 只是本插件的扩展事实。因此当 lead 直接提交工作项或
   * 成员而还没显式登记团队时，**自动补登记**并留诊断，而不是让调用者卡在
   * TEAM_NOT_REGISTERED 上（显式 `team_define` 仍然可用且优先）。
   */
  async ensureTeamRecord(actor, teamKey, spec = {}) {
    const existing = this.teams.get(teamKey);
    if (existing) return existing;
    if (actor.role !== 'lead' || !this.isSameTeam(actor, teamKey)) return undefined;
    const created = await this.defineTeam(actor.agent, { teamKey, layout: spec.layout, goal: spec.goal });
    if (!created.ok) return undefined;
    this.diagnostics.push('service:team-autoregistered', `lead ${actor.teamKey} 自动登记为团队 ${teamKey}`);
    this.notify('team-defined', { teamKey, auto: true });
    return this.teams.get(teamKey);
  }

  async defineTeam(caller, spec = {}) {
    const writable = this.assertWritable();
    if (!writable.ok) return writable;
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    if (actor.role !== 'lead') return denied('TEAM_LEAD_REQUIRED', '只有 Team lead 能把当前会话登记为一个受管团队。');

    return this.mutex.run(async () => {
      const teamKey = this.resolveTeamKey(actor, spec.teamKey);
      const existing = this.teams.get(teamKey);
      const record = {
        teamKey,
        nativeTeamId: actor.teamKey,
        rootSessionId: actor.rootId,
        layout: spec.layout === 'domains' ? 'domains' : 'systems',
        goal: typeof spec.goal === 'string' ? spec.goal : '',
        splitBy: 'independent-deliverable',
        status: 'active',
        createdAt: existing?.createdAt ?? this.clock.now(),
      };
      const result = await this.storage.put('teams', teamKey, record, {
        expectRev: existing?.rev,
        idempotencyKey: `defineTeam:${teamKey}:${sha256Hex(stableStringify({ layout: record.layout, goal: record.goal }))}`,
      });
      if (!result.ok && result.code !== 'IDEMPOTENCY_CONFLICT') return denied(result.code, '团队登记失败', { detail: result.message });
      this.teams.set(teamKey, result.record ?? record);
      this.diagnostics.push('service:defineTeam', `team ${teamKey} (${record.layout})`);
      this.notify('team-defined', { teamKey });
      return { ok: true, team: safeClone(this.teams.get(teamKey)), deduplicated: Boolean(result.deduplicated) };
    });
  }

  async createMember(caller, spec = {}) {
    const writable = this.assertWritable();
    if (!writable.ok) return writable;
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    if (actor.role !== 'lead') return denied('TEAM_LEAD_REQUIRED', '原生 Team 只有 lead 能创建 teammate；member 与 leaf 不得创建同级成员。');

    const name = typeof spec.name === 'string' && spec.name.trim() ? spec.name.trim() : null;
    const description = typeof spec.description === 'string' && spec.description.trim() ? spec.description.trim() : null;
    if (!name) return denied('MEMBER_NAME_REQUIRED', 'member 必须有 kebab-case 名字。');
    if (!description) return denied('MEMBER_DESCRIPTION_REQUIRED', 'member 必须声明模块责任（description）。');

    const teamKey = this.resolveTeamKey(actor, spec.teamKey);
    let team = this.teamOf(actor, teamKey);
    if (!team) team = await this.ensureTeamRecord(actor, teamKey, spec);
    if (!team) return denied('TEAM_NOT_REGISTERED', `团队 ${teamKey} 尚未登记：先 defineTeam。`);
    if (this.members.has(`${teamKey}/${name}`)) {
      return denied('MEMBER_EXISTS', `团队 ${teamKey} 已有 member ${name}。`);
    }
    if (this.memberCount(teamKey) >= this.config.capacity.teamsMaxConcurrent * 8) {
      return denied('MEMBER_LIMIT', '累计 member 上限已到；需要新建团队或显式迁移，不删除历史规避。');
    }

    const context = spec.context === 'fork' ? 'fork' : 'fresh';
    const provider = typeof spec.provider === 'string' && spec.provider ? spec.provider : this.pickSubagentProvider(context);
    const prompt = normalizePrompt(spec.prompt, `你是团队 ${teamKey} 的模块负责人「${name}」。职责：${description}。`);

    // 先记录创建意图，spawn 回执丢失时用 intent 对账，不重复创建。
    const intentKey = `${teamKey}/${name}`;
    const intentStored = await this.storage.put('members', intentKey, {
      memberId: name,
      teamKey,
      role: 'teammate',
      phase: 'provisioning',
      responsibility: description,
      writeScopes: toStringArray(spec.writeScopes),
      context,
      provider,
      createdAt: this.clock.now(),
    });
    if (!intentStored.ok) {
      // 意图没落盘 = 回执丢失后无法对账，会有重复创建风险。**不静默**。
      this.diagnostics.push('service:createMember:intent-not-persisted', `${name}: ${intentStored.code} ${intentStored.message}`);
    }

    const controller = new AbortController();
    const result = await this.adapter.spawnTeammate(actor.agent, {
      name,
      description,
      prompt,
      context,
      provider,
      signal: controller.signal,
    });

    if (!result.ok) {
      const failedMark = await this.storage.put('members', intentKey, { ...(this.storage.get('members', intentKey) ?? {}), phase: 'failed', error: `${result.code}: ${result.message}` });
      if (!failedMark.ok) this.diagnostics.push('service:createMember:failed-mark-not-persisted', `${name}: ${failedMark.code} ${failedMark.message}`);
      this.diagnostics.push('service:createMember:failed', `${name}: ${result.code} ${result.message}`);
      return denied(result.code, `teammate 创建失败：${result.message}`, { memberId: name });
    }

    const member = result.value?.member ?? {};
    const record = {
      memberId: name,
      teamKey,
      role: 'teammate',
      phase: 'active',
      sessionId: member.id ?? null,
      responsibility: description,
      writeScopes: toStringArray(spec.writeScopes),
      context,
      provider,
      model: member.model ?? null,
      createdAt: this.clock.now(),
    };
    const stored = await this.storage.put('members', intentKey, record, { idempotencyKey: `member-created:${teamKey}/${name}` });
    // 记录没落盘时**绝不静默**：原生 teammate 已经建出来了，若只留在内存里，
    // 重启后成员消失而 work 仍指向它 → 孤儿工作项 + 空团队树（真实缺陷，见 storage.js 的 encodeKey 说明）。
    // 这里保持本次会话可用（内存态继续工作），但把"未持久化"明确回报给调用方并留诊断。
    const persisted = stored.ok === true;
    if (!persisted) {
      this.diagnostics.push('service:createMember:not-persisted', `${name}: 成员记录未落盘（${stored.code}: ${stored.message}）；本次会话仍可用，但**重启后会丢失**。`);
    } else if (this.diagnostics.list().some((entry) => entry.code === 'service:createMember:intent-not-persisted')) {
      this.diagnostics.push('service:createMember:intent-recovered', `${name}: 创建意图起初未落盘，最终记录已落盘。`);
    }
    this.members.set(intentKey, stored.record ?? record);
    this.diagnostics.push('service:createMember', `${name} → session ${record.sessionId}`);
    this.notify('member-created', { teamKey, memberId: name, sessionId: record.sessionId });
    return {
      ok: true,
      member: safeClone(this.members.get(intentKey)),
      persisted,
      ...(persisted ? {} : { warning: `成员记录未能持久化（${stored.code ?? 'PERSIST_FAILED'}: ${stored.message ?? 'no message'}）：本次会话可用，但重启后会丢失；work 会指向不存在的 owner。` }),
    };
  }

  memberCount(teamKey) {
    let count = 0;
    for (const member of this.members.values()) if (!teamKey || member.teamKey === teamKey) count += 1;
    return count;
  }

  pickSubagentProvider(context) {
    const listResult = this.adapter.listSubagentProviders();
    const providers = listResult.ok && Array.isArray(listResult.value) ? listResult.value : [];
    if (providers.length === 0) return context === 'fork' ? 'fork' : 'spawn';
    const preferred = providers.find((name) => String(name).includes(context === 'fork' ? 'fork' : 'spawn'));
    return preferred ?? providers[0];
  }

  // ---------------------------------------------------------------------------
  // 工作项
  // ---------------------------------------------------------------------------
  async submitWork(caller, spec = {}) {
    const writable = this.assertWritable();
    if (!writable.ok) return writable;
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    if (actor.role === 'root') {
      return denied('TEAM_LEAD_REQUIRED', '普通根会话不是受管团队；请用 lead 会话提交工作项，或先 defineTeam。');
    }

    const teamKey = this.resolveTeamKey(actor, spec.teamKey);
    let team = this.teamOf(actor, teamKey);
    if (!team) team = await this.ensureTeamRecord(actor, teamKey, spec);
    if (!team) return denied('TEAM_NOT_REGISTERED', `团队 ${teamKey} 尚未登记：先 defineTeam。`);
    if (actor.role === 'member' && !this.isSameTeam(actor, teamKey)) {
      return denied('DELEGATION_SCOPE', 'member 只能在自己所属团队内提交工作项。');
    }

    const candidate = { ...spec, teamKey };
    const existingWorks = [...this.works.values()];
    const validation = validateWorkSpec(candidate, {
      requireArtifactVersion: this.config.policy.requireArtifactVersion,
      phaseRelay: this.config.policy.phaseRelay,
      existingWorks,
    });
    if (!validation.ok) {
      this.diagnostics.push('service:submitWork:rejected', `${validation.code}: ${validation.message}`, validation.hint ?? null);
      return denied(validation.code, validation.message, { hint: validation.hint, stageRoles: validation.stageRoles });
    }

    const normalized = validation.normalized;
    // P1-7：纯模型转抄不能进入 LLM 派发；给出确定性 materialize 路由（或要求真正的新设计验收）。
    const mechanical = detectMechanicalTranscription(normalized);
    if (mechanical.mechanical) {
      this.diagnostics.push('service:submitWork:mechanical-transcription', `${normalized.title ?? ''}: 拒绝 LLM 逐字转抄`, mechanical.hint);
      return denied(mechanical.code, mechanical.reason, mechanical.hint);
    }
    if (!this.members.has(`${teamKey}/${normalized.ownerMemberId}`) && normalized.ownerMemberId !== 'lead') {
      return denied('OWNER_NOT_MEMBER', `owner 必须是本团队的 member：${normalized.ownerMemberId} 不存在。owner 是责任人，执行者是子智能体，两者不能混为一谈。`);
    }

    return this.mutex.run(async () => {
      const workId = typeof spec.workId === 'string' && spec.workId.trim() ? spec.workId.trim() : newId('work');
      const existing = this.works.get(workId);
      if (existing && existing.teamKey !== teamKey) return denied('WORK_ID_CONFLICT', `workId ${workId} 已属于团队 ${existing.teamKey}。`);

      // 契约 §2：稳定交付物身份 + 反改名接力。
      // 身份 = 原 workId + 原 ownerMemberId；改标题/kind/subject 不能开新流程。
      // P1-5：`continuationOf` **不是**"新 workId 在修订自己"——它声明的是"我在续作另一个 work"，
      // 续作只能沿用原 workId 修订计划；把它当 selfWorkId 会让新 id 直接合法化。
      const identity = this.judgeWorkIdentity({ ...normalized, workId, teamKey }, { selfWorkId: existing ? workId : null });
      if (!identity.ok) {
        this.diagnostics.push('service:submitWork:identity-rejected', `${workId}: ${identity.code}`, identity.violations);
        return denied(identity.code, identity.message, {
          hint: identity.hint,
          matchedWorkId: identity.matchedWorkId,
          violations: identity.violations,
          identityKey: identity.identityKey,
          note: '同一交付物身份 = 原 workId + 原 ownerMemberId；返工/续作请修订原 workId 的计划（planRevision+1），不要改标题开新流程。',
        });
      }

      const dependencyResolution = this.resolveBlockedBy(teamKey, normalized.blockedBy, workId);
      if (dependencyResolution.unresolved.length > 0) {
        this.diagnostics.push('service:submitWork:dependency-unresolved', `${workId}: ${dependencyResolution.unresolved.join(', ')}`, dependencyResolution.unresolved);
        return this.dependencyUnresolvedDenial(dependencyResolution.unresolved, { workId });
      }
      const blockedBy = dependencyResolution.resolved;
      const satisfied = blockedBy.every((id) => this.isDependencySatisfied(id, normalized.artifactDependencies));
      // 原生 Team journal 才是任务主体的权威，它的 blockedBy 用的是**原生 task id**。
      // sidecar 的 workId 不能直接塞进去，必须映射；映射不到的（依赖还没建出原生 task）
      // 只记诊断——原生 board 会显示 ready，而本插件调度器仍按 sidecar 依赖拦住它，
      // 这个分叉必须显式说出来，不能假装一致。
      const nativeBlockedBy = [];
      const unmappedBlockedBy = [];
      for (const dependencyId of blockedBy) {
        const dependency = this.works.get(dependencyId);
        if (dependency?.nativeTaskId) nativeBlockedBy.push(dependency.nativeTaskId);
        else unmappedBlockedBy.push(dependencyId);
      }
      if (unmappedBlockedBy.length > 0) {
        this.diagnostics.push(
          'service:submitWork:native-dependency-unmapped',
          `依赖 ${unmappedBlockedBy.join(', ')} 没有原生 task id：原生 board 会显示 ready，但本插件调度器仍按 sidecar 依赖拦截。`,
          { workId, unmappedBlockedBy },
        );
      }
      // 重新提交同一个 workId = owner 改变方法/证据后的显式重试入口：
      // 它重置失败计数，让被 REPEATED_IDENTICAL_FAILURE / 预算耗尽阻塞的工作项回到 ready。
      const resetFailure =
        Boolean(existing) &&
        (existing.blockedReason === 'REPEATED_IDENTICAL_FAILURE' || existing.blockedReason === 'ATTEMPT_BUDGET_EXHAUSTED');
      if (resetFailure) {
        this.diagnostics.push('service:submitWork:unblock', `${workId} 由重新提交解除 ${existing.blockedReason}，失败计数归零`);
      }
      const work = {
        workId,
        teamKey,
        title: normalized.title,
        deliverable: normalized.deliverable,
        subject: normalized.subject,
        partOf: normalized.partOf,
        ownerMemberId: normalized.ownerMemberId,
        kind: normalized.kind,
        splitKind: normalized.splitKind,
        inputs: normalized.inputs,
        outputs: normalized.outputs,
        acceptance: normalized.acceptance,
        artifactDependencies: normalized.artifactDependencies,
        // Codex 审阅 E：可执行验收项在计划期声明；team_exec_check 只允许跑匹配命令。
        verificationCommands: normalized.verificationCommands ?? [],
        writeScopes: normalized.writeScopes,
        contextPolicy: normalized.contextPolicy,
        delegationBudget: normalized.delegationBudget,
        priority: normalized.priority,
        blockedBy,
        blockedReason: satisfied ? null : 'DEPENDENCIES_UNSATISFIED',
        nativeTaskId: existing?.nativeTaskId ?? null,
        // 契约 §11：只有 **owner 自己** 提交时才在下面记授权；否则初始 `needs_plan`。
        state: satisfied ? 'ready' : 'blocked',
        activeAttemptId: null,
        attempts: resetFailure ? [] : (existing?.attempts ?? []),
        failureStreak: resetFailure ? 0 : (existing?.failureStreak ?? 0),
        lastFailureCode: resetFailure ? null : (existing?.lastFailureCode ?? null),
        lastFailureMessage: resetFailure ? null : (existing?.lastFailureMessage ?? null),
        artifactRefs: existing?.artifactRefs ?? [],
        evidenceRefs: existing?.evidenceRefs ?? [],
        completion: existing?.completion ?? { level: 'none', pendingUserAcceptance: true },
        createdAt: existing?.createdAt ?? this.clock.now(),
        warnings: validation.warnings,
      };

      // 图级校验在**入库前**执行：同一 subject 的阶段接力必须被拒绝并重排，
      // 而不是先入库再由调度器慢慢暴露。
      const graph = validateWorkGraph(
        [...[...this.works.values()].filter((candidate) => candidate.workId !== workId), work],
        { phaseRelay: this.config.policy.phaseRelay },
      );
      const ownViolations = graph.violations.filter((violation) => violation.workId === workId || (violation.workIds ?? []).includes(workId));
      if (ownViolations.length > 0 && this.config.policy.phaseRelay === 'reject') {
        this.diagnostics.push('service:submitWork:graph-rejected', ownViolations[0].message, ownViolations);
        return denied('PHASE_RELAY_GRAPH', ownViolations[0].message, { hint: ownViolations[0].hint, violations: ownViolations });
      }

      // 原生 Team journal 保存任务主体；失败时保留 sidecar 权威并记诊断。
      if (!work.nativeTaskId) {
        const taskResult = await this.adapter.createTask(actor.agent, {
          subject: work.title,
          description: `${work.deliverable}\n\n产物：${work.outputs.join(', ')}\n验收：${work.acceptance.join('；')}`,
          writeScopes: work.writeScopes,
          ...(nativeBlockedBy.length > 0 ? { blockedBy: nativeBlockedBy } : {}),
        });
        if (taskResult.ok && taskResult.value?.id !== undefined) {
          work.nativeTaskId = String(taskResult.value.id);
        } else if (taskResult.ok) {
          this.diagnostics.push('service:submitWork:native-task-unidentified', 'createTask 成功但没有返回 id');
        } else {
          this.diagnostics.push('service:submitWork:native-task-unavailable', `${taskResult.code}: ${taskResult.message}`);
        }
      }

      const stored = await this.storage.put('works', workId, work, { idempotencyKey: `submitWork:${teamKey}:${workId}:${sha256Hex(stableStringify({ d: work.deliverable, o: work.outputs }))}` });
      if (!stored.ok && stored.code !== 'IDEMPOTENCY_CONFLICT') return denied(stored.code, '工作项写入失败', { detail: stored.message });
      this.works.set(workId, stored.record ?? work);
      // 契约 §2：创建时绑定稳定身份（之后改标题/kind 也不变）。
      const identityRecord = await this.persistIdentityInLock(this.works.get(workId));

      // ---- 契约 §11：授权只能来自 owner 自己 --------------------------------------
      const callerIsOwner = actor.role === 'lead' ? work.ownerMemberId === 'lead' : work.ownerMemberId === actor.memberId;
      let authorization = null;
      let ownerEvent = null;
      const currentWork = this.works.get(workId);
      if (work.state !== 'cancelled' && work.state !== 'accepted' && !this.authorizedIntentFor(currentWork)) {
        if (callerIsOwner) {
          authorization = await this.autoAuthorizeForOwnerInLock({ actor, work: currentWork, at: this.clock.now(), via: 'submitWork' });
        } else {
          // 别人替 owner 建 work：**不产生授权**，初始 needs_plan，向 owner 入队事件。
          const next = {
            ...this.works.get(workId),
            state: currentWork.blockedReason ? currentWork.state : 'needs_plan',
            plannedBy: null,
          };
          const storedDirective = await this.storage.put('works', workId, next, { expectRev: currentWork.rev });
          if (storedDirective.ok) this.works.set(workId, storedDirective.record);
          ownerEvent = this.enqueueOwnerDirectiveInLock({ work: this.works.get(workId), at: this.clock.now() });
          this.diagnostics.push(
            'service:submitWork:owner-directive',
            `${workId} 由 ${actor.memberId ?? actor.role} 提交但 owner 是 ${work.ownerMemberId}：初始 needs_plan，**不产生授权**（§11）；等待 owner 自己 plan/authorize。`,
          );
        }
      }

      if (!stored.deduplicated) {
        this.diagnostics.push('service:submitWork', `${workId} (${this.works.get(workId).state}) owner=${work.ownerMemberId}`);
        this.notify('work-submitted', { workId, teamKey, state: this.works.get(workId).state });
      } else {
        this.stats.duplicatesSuppressed += 1;
      }

      const committedGraph = validateWorkGraph([...this.works.values()], { phaseRelay: this.config.policy.phaseRelay });
      return {
        ok: true,
        work: safeClone(this.works.get(workId)),
        deduplicated: Boolean(stored.deduplicated),
        graphViolations: committedGraph.ok ? [] : committedGraph.violations,
        authorizedByOwner: callerIsOwner && Boolean(authorization?.ok),
        dispatchIntentId: this.works.get(workId).dispatchIntentId ?? null,
        identity: identityRecord ? { identityKey: identityRecord.identityKey, fingerprint: identityRecord.fingerprint } : null,
        ownerEvent: ownerEvent?.event ? { eventId: ownerEvent.event.eventId, type: ownerEvent.event.type } : null,
        note: callerIsOwner
          ? '提交者就是 owner：Host 记了一条来自 owner 的授权（§11）。'
          : '提交者不是 owner：没有产生授权，初始 needs_plan；owner 自己 team_dispatch_authorize 后才允许派发。',
      };
    }).then(async (result) => {
      if (result.ok && result.ownerEvent) {
        await this.persistMemberEvent(this.memberEvents.get(result.ownerEvent.eventId), this.cursorOf(this.works.get(result.work.workId).teamKey, result.work.ownerMemberId));
      }
      return result;
    });
  }

  /**
   * 依赖解析：把声明里的引用解析成 sidecar workId。
   *
   * 解析顺序（契约 §13.2）：`workId` → `nativeTaskId` → `title` → **其它 work 的产物路径（outputs）**。
   *
   * **解析不到绝不静默降级**：把一个真实依赖悄悄变成"没有依赖"是最危险的失败模式
   * （work 会立刻变成可启动）。这里返回 `unresolved`，由调用方**整批拒绝**并给出
   * `DEPENDENCY_UNRESOLVED` + hint。
   *
   * @returns {{ resolved: string[], unresolved: string[] }}
   */
  resolveBlockedBy(teamKey, ids, selfId) {
    const resolved = [];
    const unresolved = [];
    for (const raw of ids) {
      if (raw === selfId) continue;
      if (this.works.has(raw)) {
        resolved.push(raw);
        continue;
      }
      const byName = [...this.works.values()].find((work) => work.teamKey === teamKey && work.title === raw);
      if (byName) {
        resolved.push(byName.workId);
        continue;
      }
      const byNative = [...this.works.values()].find((work) => work.nativeTaskId === raw);
      if (byNative) {
        resolved.push(byNative.workId);
        continue;
      }
      // `dependencies` 允许直接声明产物路径：按 outputs 反查生产者。
      const normalised = String(raw).replace(/\\/g, '/');
      const byOutput = [...this.works.values()].find((work) =>
        (work.outputs ?? []).some((output) => String(output).replace(/\\/g, '/') === normalised),
      );
      if (byOutput) {
        resolved.push(byOutput.workId);
        continue;
      }
      unresolved.push(raw);
    }
    return { resolved: [...new Set(resolved)], unresolved: [...new Set(unresolved)] };
  }

  /** 依赖无法解析时的统一拒绝（整批原子失败，不静默降级为"无依赖"）。 */
  dependencyUnresolvedDenial(unresolved, context = {}) {
    return denied('DEPENDENCY_UNRESOLVED', `依赖无法解析：${unresolved.join(', ')}。`, {
      hint: '依赖必须指向已存在的 workId、原生 taskId、work 标题或产物路径；先提交被依赖的交付项（或用它的 outputs 路径声明依赖），不要留下解析不了的引用——Host 不会把无法解析的依赖降级成"没有依赖"。',
      unresolved,
      ...context,
    });
  }

  /**
   * 依赖是否真的可用。语义与 `docs/ARCHITECTURE.md` §2.5 严格一致：
   *   ready(task) = ... AND 所需交付物可用 ...
   * 「所需交付物可用」= 依赖项已经 **produced/verifying**（或完成层级 ≥ verified）。
   * 依赖项存在但没有产出**不算**可用——这正是"依赖未好就启动空等"要禁止的情形。
   */
  isDependencySatisfied(workId, artifactDependencies = []) {
    const dependency = this.works.get(workId);
    if (!dependency) return false;
    const level = dependency.completion?.level ?? 'none';
    const ownerVerified = dependency.verification?.outcome === 'accepted' || dependency.state === 'accepted';
    const delivered =
      dependency.state === 'produced' ||
      dependency.state === 'verifying' ||
      dependency.state === 'awaiting_verification' ||
      dependency.state === 'accepted' ||
      level === 'verified' ||
      level === 'accepted' ||
      level === 'user-confirmed';
    if (!delivered) return false;
    for (const requirement of artifactDependencies) {
      if (!requirement) continue;
      // Codex 审阅 D：**版本/依赖变化使证据过期后，任何 requires 的下游都不得放行**
      // （不只是 verified-result）——否则下游会拿过期产物继续做，等于用失效证据解锁。
      if (this.works.get(workId)?.evidenceInvalidatedAt || this.works.get(workId)?.evidenceValid === false) return false;
      if (requirement.requires === 'verified-result') {
        // `produced ≠ accepted`：申请 verified-result 的下游必须等 **owner 实际核验**。
        // 叶子自己交回的证据（completion.level='verified'）**不够**。
        if (!ownerVerified) return false;
        // 契约 §3：源版本变化会让证据过期 → **不得**错误解锁依赖。
        if (!this.isEvidenceCurrent(dependency)) return false;
      }
    }
    return true;
  }

  /**
   * ready(task) = 已批准范围内 AND 尚未被认领（或已认领但无活跃 attempt）
   *               AND 所需交付物可用 AND 无写入冲突 AND 预算可用。
   * 注意：**不**包含“同批其他任务已完成”，也**不**为维持并发放宽依赖。
   */
  computeReady() {
    const ready = [];
    for (const work of this.works.values()) {
      if (work.teamKey && this.teams.get(work.teamKey)?.status === 'archived') continue;
      if (work.state === 'cancelled' || work.state === 'produced' || work.state === 'verifying' || work.state === 'failed' || work.state === 'accepted' || work.state === 'awaiting_verification') continue;
      // 成员自己执行的自治 work 由成员自己的回合完成，调度器不碰它。
      // **但它也必须能被"依赖放行"**，否则会卡在 `blocked`（§14 补丁）——
      // 放行后回到 `self_running`，仍不进 ready 候选。
      if (!requiresSchedulerStart(work)) {
        if (work.state === 'blocked' && (work.blockedReason === 'DEPENDENCIES_UNSATISFIED' || work.blockedReason == null)) {
          const depsOk = (work.blockedBy ?? []).every((id) => this.isDependencySatisfied(id, work.artifactDependencies));
          if (depsOk) {
            this.patchWorkInMemory(work.workId, { state: this.restoredStateForDependencyRelease(work), blockedReason: null });
          }
        }
        continue;
      }
      // 成员还没规划/还没授权：不是"可调度项"（契约 §11）。
      if (work.state === 'needs_plan' || work.state === 'planned') continue;
      // 用户显式暂停的成员：其 work 不进入候选（暂停标记不会被自动恢复抵消）。
      if (work.pausedBy === 'user') {
        work.blockedReason = 'PAUSED_BY_USER';
        continue;
      }
      // 只有"依赖未满足"造成的 blocked 可以自动复活。失败/重复失败/预算耗尽造成的 blocked
      // 必须由 owner 改变方法或证据后重新提交（submitWork 会重置 failureStreak）。
      if (work.state === 'blocked' && work.blockedReason !== 'DEPENDENCIES_UNSATISFIED') continue;
      if (work.activeAttemptId) {
        const attempt = this.attempts.get(work.activeAttemptId);
        if (attempt && !TERMINAL_ATTEMPT_STATES.has(attempt.state)) continue;
        // 活跃 attempt 已经终结但 work 还停在 executing：先归位，避免"没有活跃 attempt
        // 却显示 executing"的不一致状态（真实模型验收暴露过这个形状）。
        this.patchWorkInMemory(work.workId, { state: 'ready', activeAttemptId: null });
      }
      const depsSatisfied = work.blockedBy.every((id) => this.isDependencySatisfied(id, work.artifactDependencies));
      const blocked = work.blockedBy.length > 0 && !depsSatisfied;
      if (blocked) {
        if (work.state === 'blocked' || work.state === 'ready') this.patchWorkInMemory(work.workId, { state: 'blocked', blockedReason: 'DEPENDENCIES_UNSATISFIED' });
        continue;
      }
      if (work.state === 'blocked' && work.blockedReason === 'DEPENDENCIES_UNSATISFIED') {
        // 回到它自己的语义状态（self → self_running；有授权 → ready；无授权 → planned），
        // 而不是一律 ready —— 见 `restoredStateForDependencyRelease`。
        this.patchWorkInMemory(work.workId, { state: this.restoredStateForDependencyRelease(work), blockedReason: null });
      }
      const current = this.works.get(work.workId);
      const owner = this.members.get(`${current.teamKey}/${current.ownerMemberId}`);
      if (current.ownerMemberId !== 'lead' && (!owner || owner.phase === 'failed')) {
        current.blockedReason = 'OWNER_UNAVAILABLE';
        continue;
      }
      // 用户显式暂停的成员：不进入可调度队列（暂停标记不会被任何自动恢复抵消）。
      if (owner?.pausedBy === 'user') {
        current.blockedReason = 'PAUSED_BY_USER';
        continue;
      }
      const attemptsUsed = current.attempts.length;
      if (attemptsUsed >= (current.delegationBudget?.maxAttempts ?? 6)) {
        current.blockedReason = 'ATTEMPT_BUDGET_EXHAUSTED';
        current.state = 'blocked';
        continue;
      }
      ready.push(current);
    }
    // 「等 owner 验收」必须早于一切补位判断：produced 的自治 work 已不再占用执行名额，
    // 但它的下游依赖（requires: verified-result）仍被拦住（见 isDependencySatisfied）。
    ready.sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.createdAt - right.createdAt);
    return ready;
  }

  /**
   * 依赖放行后该 work 回到哪个状态（契约 §14 补丁）。
   *
   * `blocked(DEPENDENCIES_UNSATISFIED)` 被放行时**不能一律回 `ready`**：
   *   - `execution:'self'` → **`self_running`**（成员自己做；它永远不会有 attempt，
   *     落到 `ready` 就是"既不能 selfReport、也不该被调度器启动"的死结 —— 实测 equip-verify-package）；
   *   - delegate 且有 authorized 意图 → `ready`（可调度）；
   *   - delegate 但**没有**授权意图（别人替成员建的）→ `planned`（等 owner 自己授权）。
   */
  restoredStateForDependencyRelease(work) {
    if ((work.execution ?? 'delegate') === 'self') return 'self_running';
    if (this.authorizedIntentFor(work)) return 'ready';
    return isAutonomousWork(work) ? 'planned' : 'ready';
  }

  patchWorkInMemory(workId, patch) {
    const work = this.works.get(workId);
    if (!work) return;
    this.works.set(workId, { ...work, ...patch });
  }

  async claimWork(caller, request = {}) {
    const writable = this.assertWritable();
    if (!writable.ok) return writable;
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    const workId = String(request.workId ?? '');
    const work = this.works.get(workId);
    if (!work) return denied('WORK_NOT_FOUND', `没有工作项 ${workId}`);
    if (actor.role === 'root') return denied('TEAM_LEAD_REQUIRED', '普通根会话不能认领受管工作项。');
    if (actor.role === 'member' && work.ownerMemberId !== actor.memberId) {
      return denied('DELEGATION_SCOPE', `member ${actor.memberId} 不能认领属于 ${work.ownerMemberId} 的工作项。`);
    }
    if (work.state === 'produced' || work.state === 'cancelled') return denied('WORK_TERMINAL', `工作项已是 ${work.state}。`);
    if (work.state === 'blocked') return denied('WORK_BLOCKED', `工作项 ${workId} 的依赖尚未满足（${work.blockedReason ?? 'unknown'}）；不认领未满足依赖的工作。`);

    return this.mutex.run(async () => {
      const current = this.works.get(workId);
      const expectedRevision = Number.isInteger(request.expectedRevision) ? request.expectedRevision : current.rev;
      if (expectedRevision !== current.rev) {
        return denied('CAS_MISMATCH', `工作项 ${workId} 的 revision 已从 ${expectedRevision} 变为 ${current.rev}；过期认领被拒绝。`, { current: safeClone(current) });
      }
      if (current.activeAttemptId) {
        const active = this.attempts.get(current.activeAttemptId);
        if (active && !TERMINAL_ATTEMPT_STATES.has(active.state)) return denied('WORK_ALREADY_ACTIVE', `工作项 ${workId} 已有活跃 attempt ${active.attemptId}。`);
      }
      const next = { ...current, state: 'claimed', claimedBy: actor.memberId, claimedAt: this.clock.now() };
      const stored = await this.storage.put('works', workId, next, { expectRev: current.rev, idempotencyKey: `claimWork:${workId}:${expectedRevision}:${actor.memberId}` });
      if (!stored.ok) {
        if (stored.code === 'IDEMPOTENCY_CONFLICT') this.stats.duplicatesSuppressed += 1;
        return denied(stored.code, stored.code === 'CAS_MISMATCH' ? 'CAS 失败：并发认领只允许一个成功。' : '认领写入失败', { current: safeClone(stored.current ?? current) });
      }
      this.works.set(workId, stored.record);
      await this.syncNativeTask(actor, stored.record, 'claim');
      this.diagnostics.push('service:claimWork', `${workId} by ${actor.memberId}`);
      this.notify('work-claimed', { workId });
      return { ok: true, work: safeClone(this.works.get(workId)) };
    });
  }

  /**
   * 同步原生 Team task。
   *
   * 原生状态机只允许 `pending → in_progress(claim) → completed`，直接对 pending 任务
   * complete 会得到 `TEAM_TASK_INVALID_TRANSITION: only an in-progress task can complete`
   * （真实模型验收实测）。因此 claim 与 complete 分开：
   *   - `claim` 在 attempt 真正启动、且拿得到 owner 的 live Agent 时做，owner 记成该 member；
   *   - `complete` 前先确认已是 in_progress，否则先补一次 claim。
   */
  async syncNativeTask(actor, work, action) {
    if (!work.nativeTaskId) return { ok: false, code: 'NO_NATIVE_TASK' };
    const view = await this.adapter.getTask(actor.agent, work.nativeTaskId);
    if (!view.ok) return view;
    let revision = view.value?.revision;
    const status = view.value?.status;

    if (status === 'completed') return { ok: true, alreadyCompleted: true };
    if (status === 'deleted') return { ok: false, code: 'NATIVE_TASK_DELETED' };

    if (status !== 'in_progress') {
      const claim = await this.adapter.updateTask(actor.agent, {
        taskId: work.nativeTaskId,
        expectedRevision: revision,
        action: 'claim',
      });
      if (!claim.ok) {
        this.diagnostics.push('service:syncNativeTask:claim-failed', `${work.nativeTaskId}: ${claim.code} ${claim.message}`);
        return claim;
      }
      revision = claim.value?.revision ?? revision;
      if (action === 'claim') return { ok: true, value: claim.value };
    } else if (action === 'claim') {
      return { ok: true, alreadyInProgress: true };
    }

    const update = await this.adapter.updateTask(actor.agent, {
      taskId: work.nativeTaskId,
      expectedRevision: revision,
      action,
    });
    if (!update.ok) this.diagnostics.push('service:syncNativeTask:failed', `${action} ${work.nativeTaskId}: ${update.code} ${update.message}`);
    return update;
  }

  // ---------------------------------------------------------------------------
  // 执行：预留 → 锁外启动
  // ---------------------------------------------------------------------------
  /**
   * 每成员的**实际准入上限**：基础 fair-share 保证多成员竞争时人人有份，
   * 但其它成员空闲时不该让空槽浪费。
   */
  memberAdmissionLimit() {
    let activeMembers = 1; // lead 也可作为执行者
    for (const member of this.members.values()) {
      if (member.phase === 'active' || member.phase === 'provisioning' || member.phase === 'stopped') activeMembers += 1;
    }
    const perMember = this.config.capacity.perMemberLeaves;
    const reserveForOthers = perMember * (activeMembers - 1);
    return Math.max(perMember, this.config.capacity.globalLeafLimit - reserveForOthers);
  }

  /**
   * 当前被活跃 attempt 持有的写入范围。
   *
   * 原生 Team 的 `writeScopes` 只是提醒，从不拦截写入，所以**本插件自己**把它当作
   * 调度互斥条件：同一时间只派发一个覆盖该范围的工作项。范围随 attempt 进入终态释放；
   * `interruptWork(scope='turn')` 只把 attempt 置为 `waiting`，因此仍持有范围，
   * 直到旧执行者确实停止（cancelled/reconcile 收敛）才释放。
   *
   * 诚实的边界：这只保证**本插件调度出的执行者**不并发写同一范围，
   * 它不是操作系统级文件锁，也无法阻止一个仍在运行的旧进程用 shell 直接写文件。
   */
  writeScopeHolders() {
    const holders = [];
    for (const attempt of this.attempts.values()) {
      if (!RESIDENT_ATTEMPT_STATES.has(attempt.state)) continue;
      const work = this.works.get(attempt.workId);
      if (!work) continue;
      holders.push({
        workId: work.workId,
        attemptId: attempt.attemptId,
        teamKey: work.teamKey,
        ownerMemberId: work.ownerMemberId,
        state: attempt.state,
        scopes: [...new Set([...(work.writeScopes ?? []), ...(work.outputs ?? [])])],
      });
    }
    return holders;
  }

  capacity() {
    let activeAttempts = 0;
    let activeLeaves = 0;
    const memberInUse = new Map();
    const waitingParents = new Set();
    for (const attempt of this.attempts.values()) {
      if (!RESIDENT_ATTEMPT_STATES.has(attempt.state)) continue;
      activeAttempts += 1;
      if (LEAF_ATTEMPT_STATES.has(attempt.state)) activeLeaves += 1;
      const ownerKey = `${attempt.teamKey}/${attempt.ownerMemberId}`;
      memberInUse.set(ownerKey, (memberInUse.get(ownerKey) ?? 0) + 1);
      if (attempt.state === 'executing' || attempt.state === 'waiting') waitingParents.add(ownerKey);
    }
    // 等待 children 的父成员也占 Continuable Activation 名额。
    const residentInUse = activeAttempts + waitingParents.size;
    const capacity = this.config.capacity;
    const residentCapacity = Math.max(0, capacity.hostActivationLimit - capacity.recoveryReserve - capacity.interactiveReserve);
    const teamInUse = new Map();
    for (const attempt of this.attempts.values()) {
      if (!RESIDENT_ATTEMPT_STATES.has(attempt.state)) continue;
      teamInUse.set(attempt.teamKey, (teamInUse.get(attempt.teamKey) ?? 0) + 1);
    }
    const activeTeams = [...this.teams.values()].filter((team) => team.status === 'active');
    const fairShareTeam = Math.max(1, Math.floor(capacity.globalLeafLimit / Math.max(1, Math.min(activeTeams.length, capacity.teamsMaxConcurrent))));
    return {
      hostActivationLimit: capacity.hostActivationLimit,
      residentCapacity,
      workerCapacity: capacity.globalLeafLimit,
      providerCapacity: capacity.providerRequestLimit,
      residentInUse,
      activeLeaves,
      providerInUse: activeLeaves,
      interactiveReserve: capacity.interactiveReserve,
      recoveryReserve: capacity.recoveryReserve,
      perMemberLeaves: capacity.perMemberLeaves,
      memberLimit: this.memberAdmissionLimit(),
      nativeCapacityBlockedUntil: this.nativeCapacityBlockedUntil ?? 0,
      capacityDeferrals: this.capacityDeferrals ?? 0,
      // 窗格绑定闸门的两个计数：被明确拒绝的 leaf 目标，以及**无法核实**而 fail-open 放行的目标。
      // 后者必须可见——它就是我们公开承认的残余缺口（由客户端 fail-closed 兜底）。
      guards: {
        leafTargetsRejected: this.leafTargetsRejected ?? 0,
        unverifiedSubagentTargets: this.unverifiedSubagentTargets ?? 0,
      },
      fullExpansionExample: capacity.fullExpansionExample(),
      teams: Object.fromEntries(
        (activeTeams.length > 0 ? activeTeams.map((team) => team.teamKey) : [...teamInUse.keys()]).map((teamKey) => [
          teamKey,
          { inUse: teamInUse.get(teamKey) ?? 0, fairShare: fairShareTeam },
        ]),
      ),
      members: Object.fromEntries([...memberInUse.entries()].map(([memberKey, inUse]) => [memberKey, { inUse, fairShare: capacity.perMemberLeaves, limit: this.memberAdmissionLimit() }])),
    };
  }

  /**
   * 锁内：为 ready 项原子预留 attempt / lease / 容量。
   * 返回的 plan 在锁外启动，绝不在这里等待模型或子任务。
   *
   * **只预留有 authorized 派发意图的 work**（契约 §5/§11）：没有 owner 授权的 work
   * 永远不会被后台补位启动，一律列进 `unauthorized`（可观测），保持 needs_plan/planned。
   */
  async reserveStarts(prefetch, limit) {
    const plans = [];
    const rejections = [];
    if (this.readOnly) return { plans, rejections: [{ code: this.readOnlyReason ?? 'READ_ONLY' }] };

    // 原生 Continuable 池刚拒绝过：退避窗口内不再预留，全部保持 ready（拒绝而非空等）。
    if (this.nativeCapacityBlockedUntil && this.clock.now() < this.nativeCapacityBlockedUntil) {
      const deferred = this.computeReady();
      return {
        plans,
        rejections: deferred.map((work) => ({ workId: work.workId, code: 'NATIVE_CAPACITY_COOLDOWN' })),
        readyBefore: deferred.map((work) => work.workId),
      };
    }

    const readyAll = this.computeReady();
    // 授权门闸（契约 §11）：只有"有 authorized 派发意图"的 work 才是可调度项。
    // 别人替 owner 建的 work 永远停在 needs_plan，直到 owner 自己授权。
    const ready = readyAll.filter((work) => this.authorizedIntentFor(work) !== undefined);
    const unauthorized = readyAll.filter((work) => this.authorizedIntentFor(work) === undefined);
    for (const work of unauthorized) {
      rejections.push({ workId: work.workId, code: 'DISPATCH_NOT_AUTHORIZED', note: '没有成员授权的派发意图：永不自动启动（等待 team_dispatch_authorize）。' });
    }
    const cap = this.capacity();
    let resident = cap.residentInUse;
    let leaves = cap.activeLeaves;
    let started = 0;
    const fairCursor = this.fairCursor ?? 0;

    const candidates = ready.filter((work) => {
      const attemptCount = work.attempts.length;
      return attemptCount < (work.delegationBudget?.maxAttempts ?? 6);
    });

    // 公平轮转：按 (teamKey, ownerMemberId) 排序，避免单一成员垄断名额。
    const rotated = rotateFairly(candidates, fairCursor);

    // 写入范围互斥：本插件自己串行化重叠范围（原生 writeScopes 只是提醒）。
    const heldScopes = this.writeScopeHolders();

    for (const work of rotated) {
      if (started >= limit) break;
      const reservation = await this.reserveWorkInLock(work, { heldScopes, resident, leaves, cap });
      if (!reservation.ok) {
        rejections.push(reservation.rejection);
        continue;
      }
      heldScopes.push(reservation.holder);
      resident += 1;
      leaves += 1;
      started += 1;
      plans.push(reservation.plan);
    }

    this.fairCursor = (fairCursor + Math.max(1, started)) % Math.max(1, candidates.length);
    return { plans, rejections, readyBefore: readyAll.map((work) => work.workId), unauthorized: unauthorized.map((work) => work.workId) };
  }

  /**
   * 锁内：为一个**明确的** work 原子预留 attempt/lease/容量。
   *
   * 这是定向启动与后台补位**共用的唯一预留实现**：它只碰传入的这一个 work。
   * 拒绝时返回结构化原因，**不改动任何工作项**（尤其不碰无关 work 的 rev / attempts / 容量 / 失败计数）。
   */
  async reserveWorkInLock(work, context = {}) {
    const heldScopes = context.heldScopes ?? this.writeScopeHolders();
    const cap = context.cap ?? this.capacity();
    const resident = Number.isFinite(context.resident) ? context.resident : cap.residentInUse;
    const leaves = Number.isFinite(context.leaves) ? context.leaves : cap.activeLeaves;
    const rejection = (code, extra = {}) => ({ ok: false, rejection: { workId: work.workId, code, ...extra } });

    // 0) 用户显式暂停的成员：其 work 不被调度器消费（暂停标记不会被自动恢复抵消）。
    const ownerMember = this.members.get(`${work.teamKey}/${work.ownerMemberId}`);
    if (ownerMember?.pausedBy === 'user') return rejection('WORK_PAUSED_BY_USER');

    // 0b) 授权门闸（自治 work 必须由成员授权）。
    const intent = this.authorizedIntentFor(work);
    if (!intent) return rejection('DISPATCH_NOT_AUTHORIZED');

    // 0c) 契约 §5：同一确定性失败（同输入/同版本/同读取 epoch）**不重复执行**。
    //     条件一变（planRevision / 产物版本 / 错误分类变化，或 owner 显式 force）即可恢复。
    {
      // P1-4：与 executeStart 失败记录 / evaluateErrorGate 共用同一个 descriptor（同一 builder）。
      const descriptor = this.describeStartFailure(
        { workId: work.workId, ownerMemberId: work.ownerMemberId, attemptId: null },
        { code: work.lastFailureCode ?? 'UNKNOWN' },
      );
      const guard = this.guardRepeatedFailure({
        tool: descriptor.tool,
        input: descriptor.input,
        versions: descriptor.versions,
        readEpoch: descriptor.readEpoch,
        force: context.force === true,
      });
      if (guard.skip) {
        return rejection('REPEATED_DETERMINISTIC_FAILURE', {
          guidance: guard.guidance,
          fingerprint: guard.fingerprint,
          errorClass: guard.errorClass,
          count: guard.count,
          note: '同一输入 + 同版本 + 同读取 epoch 的确定性失败不会被重复执行（不烧 attempt 预算）。',
        });
      }
    }

    // 1) 幂等：已有活跃 attempt 时不重复创建。
    if (work.activeAttemptId) {
      const active = this.attempts.get(work.activeAttemptId);
      if (active && !TERMINAL_ATTEMPT_STATES.has(active.state)) {
        return { ok: true, reused: true, plan: planOfAttempt(active), holder: holderOf(work, active) };
      }
    }

    // 2) 写入范围互斥。
    const ownScopes = [...(work.writeScopes ?? []), ...(work.outputs ?? [])];
    const conflicts = conflictsWithHolders(ownScopes, heldScopes);
    if (conflicts.length > 0) {
      return rejection('WRITE_SCOPE_CONFLICT', { conflicts, note: '写入范围重叠：本插件按 writeScopes 串行化，前一项产出/停止后才启动本项。' });
    }

    // 3) 容量与预算（拒绝即保持 ready，不排队空等）。
    if (resident + 1 > cap.residentCapacity) return rejection('RESIDENT_CAPACITY_FULL');
    if (leaves + 1 > cap.workerCapacity) return rejection('WORKER_CAPACITY_FULL');
    const memberKey = `${work.teamKey}/${work.ownerMemberId}`;
    const memberUsage = cap.members?.[memberKey]?.inUse ?? 0;
    if (memberUsage >= this.memberAdmissionLimit()) return rejection('MEMBER_FAIR_SHARE_FULL');
    if (cap.providerCapacity !== null && cap.providerInUse + 1 > cap.providerCapacity) return rejection('PROVIDER_CAPACITY_FULL');
    const attemptCount = work.attempts.length;
    if (attemptCount >= (work.delegationBudget?.maxAttempts ?? 6)) return rejection('ATTEMPT_BUDGET_EXHAUSTED');

    // 4) 原子写入：attempt 先落盘，再 CAS 推进 work（失败即回滚 attempt，不留半态）。
    const attemptId = newId('attempt');
    const childId = newId('child');
    const leaseEpoch = 1;
    const attempt = {
      attemptId,
      workId: work.workId,
      teamKey: work.teamKey,
      ownerMemberId: work.ownerMemberId,
      executorChildId: childId,
      parentSessionId: resolveParentSessionId(this, work),
      leaseEpoch,
      state: 'reserved',
      intent: 'start-pending',
      brief: work.brief ?? work.deliverable,
      missionId: work.missionId ?? null,
      planRevision: work.planRevision ?? null,
      dispatchIntentId: intent.intentId ?? null,
      contextPolicy: work.contextPolicy,
      outputSchema: null,
      artifacts: [],
      artifactRefs: [],
      evidenceRefs: [],
      signals: {},
      reservedAt: this.clock.now(),
      startedAt: null,
      endedAt: null,
      lateResults: [],
    };
    const stored = await this.storage.put('attempts', attemptId, attempt, { idempotencyKey: `reserve:${work.workId}:${attemptId}` });
    if (!stored.ok) return rejection(stored.code ?? 'RESERVE_FAILED');
    this.attempts.set(attemptId, stored.record);
    const workNext = {
      ...this.works.get(work.workId),
      attempts: [...work.attempts, attemptId],
      activeAttemptId: attemptId,
      state: 'executing',
      lastAttemptId: attemptId,
      acceptedIntentId: intent.intentId ?? null,
    };
    const workStored = await this.storage.put('works', work.workId, workNext, { expectRev: work.rev });
    if (!workStored.ok) {
      await this.storage.remove('attempts', attemptId);
      this.attempts.delete(attemptId);
      return rejection(workStored.code ?? 'WORK_UPDATE_FAILED');
    }
    this.works.set(work.workId, workStored.record);
    // **消费意图**：预留成功即代表这条授权被这次 attempt 用掉（幂等：终态不再改）。
    // 否则同一意图会在重启后仍显示 authorized，对账时可能被再次消费（"每份授权只有一个活动 child"）。
    await this.consumeIntentInLock(stored.record, workStored.record);
    return {
      ok: true,
      reused: false,
      plan: planOfAttempt(stored.record),
      holder: holderOf(work, stored.record),
    };
  }

  /**
   * **定向原子预留**（修缺陷 B）。
   *
   * 顺序：先校验 team + actor + owner + workId + planRevision + 派发授权 + readiness，
   * 再在同一个受控状态变更里**只预留目标 work**。
   * 绝不先全局 `reserveStarts(prefetch, 1)` 再 `find(workId)`。
   */
  async reserveTargeted(actor, workId, options = {}) {
    const work = this.works.get(String(workId));
    if (!work) return denied('WORK_NOT_FOUND', `没有工作项 ${workId}。`);
    // 与 `planSubmit` / `dispatchAuthorize` **同一判据**（`assertTeamOf`）：
    // 不再额外叠加"resolveTeamKey(...) !== work.teamKey"这种严格字符串比较。
    const team = this.assertTeamOf(actor, work.teamKey);
    if (!team.ok) return team;
    if (actor?.role === 'member' && work.ownerMemberId !== actor.memberId) {
      return denied('DELEGATION_SCOPE', `member ${actor.memberId} 不能为 ${work.ownerMemberId} 的工作项启动执行者。`);
    }
    const expectedPlanRevision = Number.isInteger(options.planRevision) ? options.planRevision : null;
    if (expectedPlanRevision !== null && (work.planRevision ?? null) !== expectedPlanRevision) {
      return denied('PLAN_REVISION_STALE', `${workId} 的 planRevision=${work.planRevision ?? 'n/a'}，请求 ${expectedPlanRevision}：旧调用不得启动已换版的 work。`);
    }
    if (requiresSchedulerStart(work) === false) {
      return denied('EXECUTION_SELF', `${workId} 是 execution=self：由成员自己的回合完成，没有可派发的叶子执行者。`);
    }
    if (work.activeAttemptId && !TERMINAL_ATTEMPT_STATES.has(this.attempts.get(work.activeAttemptId)?.state)) {
      // **幂等优先**：已经启动过就返回**既有** attempt/child，不双重创建（契约 §10）。
      const active = this.attempts.get(work.activeAttemptId);
      return { ok: true, reused: true, workId: work.workId, attemptId: active.attemptId, childSessionId: active.executorChildId, state: active.state, plan: planOfAttempt(active) };
    }
    if (this.readOnly) return denied(this.readOnlyReason ?? 'READ_ONLY', '调度器处于只读诊断态：不抢写。');
    // readiness 早于授权判定：依赖未满足的 work 无论有没有授权都必须给 **WORK_BLOCKED**
    // （契约 §13.3：`claimWork` / `subagentStart` 对未满足依赖的 work 必须拒绝并给 WORK_BLOCKED）。
    const readyReason = this.readinessReason(work);
    if (readyReason) return denied(readyReason.code, readyReason.message, { workId: work.workId });
    if (requiresAuthorizedIntent(work) && !this.authorizedIntentFor(work)) {
      return denied('DISPATCH_NOT_AUTHORIZED', `${workId} 没有匹配当前 planRevision 的 authorized 派发意图：成员未授权，永不启动。`);
    }

    return this.mutex.run(async () => {
      const current = this.works.get(work.workId);
      // 二次幂等（锁内）：并发/后台同时启动时只允许一个 attempt 创建成功。
      if (current.activeAttemptId) {
        const active = this.attempts.get(current.activeAttemptId);
        if (active && !TERMINAL_ATTEMPT_STATES.has(active.state)) {
          return { ok: true, reused: true, workId: current.workId, attemptId: active.attemptId, childSessionId: active.executorChildId, state: active.state, plan: planOfAttempt(active) };
        }
      }
      const reservation = await this.reserveWorkInLock(current);
      if (!reservation.ok) {
        return denied(reservation.rejection.code, rejectionMessage(reservation.rejection), { rejections: [reservation.rejection], workId: current.workId });
      }
      return {
        ok: true,
        reused: reservation.reused === true,
        workId: current.workId,
        attemptId: reservation.plan.attemptId,
        childSessionId: reservation.plan.childId,
        plan: reservation.plan,
        leaseEpoch: reservation.plan.leaseEpoch,
      };
    });
  }

  /** work 现在是否可启动（不改变任何状态）。 */
  readinessReason(work) {
    if (!work) return { code: 'WORK_NOT_FOUND', message: '没有该工作项。' };
    if (work.state === 'cancelled') return { code: 'WORK_TERMINAL', message: `${work.workId} 已取消。` };
    if (work.state === 'accepted') return { code: 'WORK_TERMINAL', message: `${work.workId} 已验收。` };
    if (work.state === 'executing' || work.state === 'self_running') return { code: 'WORK_ALREADY_ACTIVE', message: `${work.workId} 正在执行。` };
    if (work.pausedBy === 'user') return { code: 'WORK_PAUSED_BY_USER', message: `${work.workId} 被用户显式暂停。` };
    const blocked = (work.blockedBy ?? []).length > 0 && !(work.blockedBy ?? []).every((id) => this.isDependencySatisfied(id, work.artifactDependencies));
    if (blocked) return { code: 'WORK_BLOCKED', message: `${work.workId} 的依赖尚未满足（不预启动占槽）。` };
    if (work.state === 'blocked' && work.blockedReason && work.blockedReason !== 'DEPENDENCIES_UNSATISFIED') {
      return { code: 'WORK_BLOCKED', message: `${work.workId} 被阻塞：${work.blockedReason}。` };
    }
    return null;
  }

  /**
   * **手动定向与后台补位共用的幂等启动入口**（契约 §10）。
   *
   * `reused === true` 表示复用了既有 attempt（重复调用 / 与后台补位竞争），
   * 这时不创建第二个 child、不消耗第二次 attempts 计数。
   *
   * `caller` 接受**任何**能通过 `actor()` 解析的真实 Agent 形态（raw agent / `{id}`），
   * 与 `planSubmit`/`dispatchAuthorize` 用同一条身份解析：`adapter.agentFor(caller.id)`
   * → `agentTeams.tryMembership`。**不要求 caller 是注册表里的同一对象引用**。
   */
  async subagentStart(caller, request = {}) {
    const actor = caller && caller.ok === true && caller.agent ? caller : this.actor(caller);
    if (!actor.ok) return actor;
    const workId = String(request.workId ?? '');
    const reserved = await this.reserveTargeted(actor, workId, { planRevision: request.planRevision, force: request.force === true });
    if (!reserved.ok) return reserved;
    // 契约 §5：确定性失败不重复执行——拒绝时把"改什么条件"原样回给 owner。
    if (reserved.code === 'REPEATED_DETERMINISTIC_FAILURE') return reserved;

    // brief 公开参数必须真的到达执行者（消除"schema 有字段但实现丢弃"）。
    // 复用既有 attempt 时同样要落到该 attempt 上，否则调用方会以为说明被吞了。
    if (typeof request.brief === 'string' && request.brief.trim()) {
      const currentAttempt = this.attempts.get(reserved.attemptId);
      await this.patchAttempt(reserved.attemptId, { brief: composeBrief(currentAttempt?.brief ?? reserved.plan.brief, request.brief) });
    }

    if (reserved.reused) {
      this.stats.startsReused = (this.stats.startsReused ?? 0) + 1;
      return {
        ok: true,
        reused: true,
        workId: reserved.workId,
        attemptId: reserved.attemptId,
        childSessionId: reserved.childSessionId,
        state: reserved.state ?? null,
        brief: this.attempts.get(reserved.attemptId)?.brief ?? null,
        note: '已有活跃 attempt：复用同一个 attempt/child，不双重创建。',
      };
    }
    const started = await this.executeStart(reserved.plan);
    // 与后台补位**同一条**语义：原生容量拒绝不是失败——保持 ready、不消耗 attempt 预算、不计失败。
    if (!started.ok && started.deferred) {
      await this.deferForCapacity(reserved.plan, started);
      this.notify('attempt-capacity-deferred', { ...reserved.plan, code: started.code });
      const work = this.works.get(reserved.workId);
      return {
        ok: false,
        code: started.code,
        message: started.message,
        deferred: true,
        workId: reserved.workId,
        attemptId: reserved.attemptId,
        childSessionId: reserved.childSessionId,
        reused: false,
        brief: this.attempts.get(reserved.attemptId)?.brief ?? null,
        rejections: [{ workId: reserved.workId, code: started.code }],
        note: `定向启动因容量被拒：${reserved.workId} 保持 ${work?.state ?? 'ready'}，不消耗 attempt 预算、不计失败；退避后由后台补位重试。`,
      };
    }
    return {
      ...started,
      workId: reserved.workId,
      attemptId: reserved.attemptId,
      childSessionId: started.childId ?? reserved.childSessionId,
      reused: false,
      brief: this.attempts.get(reserved.attemptId)?.brief ?? null,
    };
  }


  /**
   * 计算 leaf 启动真正要传的 `toolFilter`。
   *
   * 读不到注册表 → 返回 `null`（**不传 toolFilter**），并留诊断。
   * 这样最坏情况是"叶子多看到几个成员级工具名"，而不是"叶子创建不了"。
   */
  leafToolFilter(plan) {
    const listed = this.adapter.listToolNames();
    const unavailable = !listed || listed.ok !== true || !Array.isArray(listed.value) || listed.value.length === 0;
    if (unavailable) {
      // 读不到注册表：只剥夺**本插件自己注册**的成员级入口（由 `ctx.tools.register` 注册，
      // 因此一定是合法的全局工具名，restrict 不会抛）；绝不猜官方工具名。
      this.diagnostics.push(
        'service:leaf-tool-filter:registry-unavailable',
        `${plan?.workId ?? '?'}: 读不到全局工具注册表（${listed?.code ?? 'UNKNOWN'}）：只传本插件自注册的成员级 deny 名单（不猜官方工具名）。`,
      );
      this.lastLeafToolFilter = { deny: MEMBER_LEVEL_TOOLS.slice(), dropped: [], registrySize: 0, reason: 'REGISTRY_UNAVAILABLE', at: this.clock.now() };
      return { deny: MEMBER_LEVEL_TOOLS.slice() };
    }
    const filtered = filterLeafDeniedTools(listed.value);
    if (!Array.isArray(filtered.deny)) {
      this.lastLeafToolFilter = { deny: MEMBER_LEVEL_TOOLS.slice(), dropped: [], registrySize: listed.value.length, reason: 'REGISTRY_EMPTY', at: this.clock.now() };
      return { deny: MEMBER_LEVEL_TOOLS.slice() };
    }
    // 注册表读到了、但**连本插件自己注册的成员级工具都不在里面** → 这次读取不可信
    // （例如 scope 受限）。回退到"只剥夺自注册成员级入口"，保证该剥夺的不漏，同时绝不传未知名字。
    const registered = new Set(listed.value.map(String));
    const missingOwn = MEMBER_LEVEL_TOOLS.filter((name) => !registered.has(name));
    if (missingOwn.length > 0) {
      this.diagnostics.push(
        'service:leaf-tool-filter:registry-partial',
        `${plan?.workId ?? '?'}: 注册表里缺少本插件自注册的 ${missingOwn.length} 个成员级工具（${missingOwn.join(', ')}）：回退为只传自注册成员级 deny 名单（绝不传未知名字）。`,
        { missingOwn, registrySize: listed.value.length },
      );
      // 注册表不完整时：`filtered.deny` 是注册表里真实存在的名字（restrict 不会抛），
      // 再补上**本插件自己注册**的成员级工具（它们由 registerTools 全局注册，名字一定合法；
      // 注册表读不全只是读取侧问题）。两者并集既保证"该剥夺的不漏"，也不会传未知官方名字。
      const partialDeny = [...new Set([...filtered.deny, ...missingOwn])];
      this.lastLeafToolFilter = { deny: partialDeny, dropped: filtered.dropped, registrySize: listed.value.length, reason: 'REGISTRY_PARTIAL', at: this.clock.now() };
      return { deny: partialDeny };
    }
    this.diagnostics.push(
      'service:leaf-tool-filter',
      `${plan?.workId ?? '?'}: deny ${filtered.deny.length} 个已注册名字${filtered.dropped.length > 0 ? `，丢弃 ${filtered.dropped.length} 个未注册名字（否则 restrict() 会抛）：${filtered.dropped.join(', ')}` : ''}`,
      { deny: filtered.deny, dropped: filtered.dropped, registrySize: listed.value.length },
    );
    this.lastLeafToolFilter = { deny: filtered.deny, dropped: filtered.dropped, registrySize: listed.value.length, reason: null, at: this.clock.now() };
    return { deny: filtered.deny };
  }

  /** 锁外启动一个已预留的 attempt。 */
  async executeStart(plan) {
    const attempt = this.attempts.get(plan.attemptId);
    if (!attempt) return { ok: false, code: 'ATTEMPT_NOT_FOUND' };
    const member = this.members.get(`${plan.teamKey}/${plan.ownerMemberId}`);
    const parentSessionId = attempt.parentSessionId;

    // 先确保 owner member 有真实 live Agent：member 在两次回合之间可能已经不在注册表里，
    // 这时按原生路径冷唤醒它（"先恢复 parent 再恢复 child"），**不伪造** `{id}` 对象。
    const parentResult = parentSessionId
      ? await this.adapter.ensureLiveAgent(parentSessionId)
      : { ok: false, code: 'PARENT_SESSION_UNKNOWN', message: '工作项没有可用的 owner member 会话' };
    if (!parentResult.ok) {
      await this.failAttempt(plan.attemptId, parentResult.code ?? 'PARENT_AGENT_UNAVAILABLE', `${parentResult.message}（session ${parentSessionId ?? 'n/a'}）`);
      return { ok: false, code: parentResult.code ?? 'PARENT_AGENT_UNAVAILABLE' };
    }
    const parent = parentResult.value.agent;
    if (parentResult.value.resumed) {
      // 冷唤醒得到的 handle 必须留着（dispose 会让 parent 再次消失），退出时统一释放。
      this.resumedAgentHandles = this.resumedAgentHandles ?? new Map();
      this.resumedAgentHandles.set(String(parent.id), parentResult.value.handle);
      this.diagnostics.push('service:parent-cold-resumed', `为 ${plan.workId} 冷唤醒 parent ${parent.id}`);
    }

    const provider = member?.provider ?? this.pickSubagentProvider('fresh');
    const controller = new AbortController();
    this.pendingControllers = this.pendingControllers ?? new Map();
    this.pendingControllers.set(plan.attemptId, controller);
    await this.patchAttempt(plan.attemptId, { state: 'starting', intent: 'start-in-flight', startedAt: this.clock.now(), provider });
    this.stats.startsAttempted += 1;

    const brief = buildLeafBrief(this, plan);
    // leaf 工具面：**先与真实注册表求交**再传（契约 §15 + 2026-10-16 回归修复）。
    // `tools.restrict()` 对未注册的名字直接抛，所以绝不能把静态清单原样传下去。
    const toolFilter = this.leafToolFilter(plan);
    const result = await this.adapter.startContinuable({
      provider,
      label: `${plan.workId}@${plan.ownerMemberId}`,
      childId: plan.childId,
      request: {
        prompt: [{ type: 'text', text: brief }],
        parent,
        // 刻意**不传 maxDepth**：`subagents` 的深度校验是 `depth(1) > maxDepth`，
        // 传 0 会让每一次 leaf 启动都抛 SubagentDepthError。省略即采用组合里
        // 配置的 maxDepth（本机默认 1），也正是"member 下面一层 leaf"需要的深度。
        //
        // leaf 的工具面（契约 §15）：**deny 形态**——继承父的完整工具面（含文件读写与命令执行），
        // 只剥夺成员级/团队管理/旁路能力。名字集合已与注册表求交，未知名字一律不传。
        ...(toolFilter ? { toolFilter } : {}),
      },
      signal: controller.signal,
    });

    this.pendingControllers.delete(plan.attemptId);

    if (!result.ok) {
      this.stats.startsRejected += 1;
      this.diagnostics.push('service:executeStart:failed', `${plan.workId}: ${result.code} ${result.message}`, { childId: plan.childId });
      // 契约 §5（2026-10-17 整改）：记录错误指纹。**容量拒绝不算失败**，因此不进指纹表；
      // 其余失败会在下一次同输入启动时被 `guardRepeatedFailure` 拦下并给出"改什么条件"。
      if (!CAPACITY_CODES.has(result.code)) {
        // P1-4：真实生产启动入口必须与 guard/evaluateErrorGate 用**同一个 descriptor**。
        // （旧缺陷：这里手写 input.owner + 字符串 readEpoch，和预留/错误门用的 ownerMemberId/对象 epoch 永远对不上。）
        await this.recordFailureFingerprint(this.describeStartFailure(plan, result));
      }
      if (CAPACITY_CODES.has(result.code)) {
        // 容量满：拒绝并保持 ready（原生池不排队，我们也不空等），退避后再试。
        await this.deferForCapacity(plan, result);
        this.notify('attempt-capacity-deferred', { ...plan, code: result.code });
        return denied(result.code, result.message, { attemptId: plan.attemptId, childId: plan.childId, deferred: true });
      }
      // 启动回执丢失：保留 intent，交给 reconcile() 用原生 catalog 对账。
      const uncertain = result.code === 'NATIVE_CALL_FAILED' || result.code === 'SUBAGENT_START_FAILED' || result.code === 'UNKNOWN';
      if (uncertain) {
        await this.patchAttempt(plan.attemptId, {
          state: 'starting',
          intent: 'start-receipt-lost',
          error: `${result.code}: ${result.message}`,
        });
      } else {
        // 明确失败（例如深度/容量/参数不合法）：attempt 终结，**并且**把 work 从
        // 'executing' 放回 ready/blocked，否则 work 会停在 executing 却没有活跃 attempt。
        await this.mutex.run(async () => {
          const attempt = this.attempts.get(plan.attemptId);
          if (attempt && !TERMINAL_ATTEMPT_STATES.has(attempt.state)) {
            await this.patchAttemptInLock(plan.attemptId, {
              state: 'failed',
              intent: 'start-rejected',
              error: `${result.code}: ${result.message}`,
              endedAt: this.clock.now(),
            });
          }
          await this.releaseWorkAfterAttempt(plan.attemptId, result.code, result.message);
        });
      }
      this.notify('attempt-start-failed', { ...plan, code: result.code });
      return denied(result.code, result.message, { attemptId: plan.attemptId, childId: plan.childId });
    }

    const actualChildId = result.value?.childId ?? plan.childId;
    if (String(actualChildId) !== String(plan.childId)) {
      this.diagnostics.push('service:executeStart:child-id-mismatch', `预分配 ${plan.childId}，原生返回 ${actualChildId}`, null);
    }
    await this.patchAttempt(plan.attemptId, {
      state: 'executing',
      intent: 'started',
      executorChildId: String(actualChildId),
      messageId: result.value?.messageId ?? null,
      startedAt: this.clock.now(),
    });
    this.stats.startsSucceeded += 1;
    this.diagnostics.push('service:executeStart', `${plan.workId} → child ${actualChildId}`);
    // 让原生 Team journal 的 owner/状态跟上：用 owner 自己的 live Agent 认领，
    // 而不是让 lead 代领（否则原生 owner 会变成 lead，与 sidecar 的 owner 分叉）。
    const startedWork = this.works.get(plan.workId);
    if (startedWork?.nativeTaskId) {
      const ownerActor = {
        ok: true,
        agent: parent,
        live: true,
        role: startedWork.ownerMemberId === 'lead' ? 'lead' : 'member',
        teamKey: startedWork.teamKey,
        memberId: startedWork.ownerMemberId,
        rootId: startedWork.teamKey,
        membershipCode: null,
      };
      const syncResult = await this.syncNativeTask(ownerActor, startedWork, 'claim');
      if (!syncResult.ok) this.diagnostics.push('service:executeStart:native-claim-failed', `${plan.workId}: ${syncResult.code ?? ''} ${syncResult.message ?? ''}`);
    }
    this.notify('attempt-started', { ...plan, childId: String(actualChildId) });
    return { ok: true, attemptId: plan.attemptId, childId: String(actualChildId) };
  }

  /**
   * 写 attempt 的**锁内**版本。`patchAttempt` 只是它的加锁包装。
   * mutex 不可重入，所以已经在 `this.mutex.run` 里的代码必须调用这个而不是 `patchAttempt`。
   */
  async patchAttemptInLock(attemptId, patch) {
    const current = this.attempts.get(attemptId);
    if (!current) return denied('ATTEMPT_NOT_FOUND', `没有 attempt ${attemptId}`);
    const next = { ...current, ...patch, updatedAt: this.clock.now() };
    const stored = await this.storage.put('attempts', attemptId, next, { expectRev: current.rev });
    if (!stored.ok) return denied(stored.code, 'attempt 写入失败', { detail: stored.message });
    this.attempts.set(attemptId, stored.record);
    return { ok: true, attempt: safeClone(stored.record) };
  }

  async patchAttempt(attemptId, patch) {
    return this.mutex.run(() => this.patchAttemptInLock(attemptId, patch));
  }

  /**
   * 失败后的工作项状态推进。核心规则（对应"不能无预算无限重试同一失败"）：
   *   - 第一次失败：放回 ready，允许一次重试（可能是瞬时故障）；
   *   - **连续两次相同错误码**：转 `blocked(REPEATED_IDENTICAL_FAILURE)`，要求改变方法/
   *     证据（换接口、换输入、补适配器），而不是继续盲目重试；
   *   - 预算耗尽：`blocked(ATTEMPT_BUDGET_EXHAUSTED)`。
   * 真实模型验收里正是"启动持续抛同一个 SubagentDepthError"导致 6 次盲重试打穿预算，
   * 这条规则把那次风暴限制在 2 次。
   */
  failureTransition(work, code, message) {
    const sameCode = Boolean(code) && work.lastFailureCode === code;
    const failureStreak = sameCode ? (work.failureStreak ?? 1) + 1 : 1;
    const attemptsLeft = (work.delegationBudget?.maxAttempts ?? 6) - (work.attempts?.length ?? 0);
    const base = { lastFailureCode: code ?? null, lastFailureMessage: message ?? null, failureStreak, activeAttemptId: null };
    if (sameCode && failureStreak >= 2) {
      return {
        ...base,
        state: 'blocked',
        blockedReason: 'REPEATED_IDENTICAL_FAILURE',
        failureHint: '连续两次相同的失败：停止盲目重试，先改变方法或证据（换接口/换输入/补适配器/缩小范围），再解除阻塞。',
      };
    }
    if (attemptsLeft <= 0) {
      return { ...base, state: 'blocked', blockedReason: 'ATTEMPT_BUDGET_EXHAUSTED' };
    }
    return { ...base, state: 'ready', blockedReason: code ? `ATTEMPT_FAILED: ${code}` : null };
  }

  /** 在锁内把一个 attempt 的失败落到 work 上（调用方必须已持有 this.mutex）。 */
  async releaseWorkAfterAttempt(attemptId, code, message) {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return denied('ATTEMPT_NOT_FOUND', `没有 attempt ${attemptId}`);
    const work = this.works.get(attempt.workId);
    if (!work) return denied('WORK_NOT_FOUND', `attempt 指向的工作项不存在：${attempt.workId}`);
    const patch = this.failureTransition(work, code, message);
    const stored = await this.storage.put('works', work.workId, { ...work, ...patch }, { expectRev: work.rev });
    if (!stored.ok) return denied(stored.code, '失败状态写入失败', { detail: stored.message });
    this.works.set(work.workId, stored.record);
    if (patch.blockedReason === 'REPEATED_IDENTICAL_FAILURE') {
      this.diagnostics.push('service:repeated-failure', `${work.workId} 连续 ${patch.failureStreak} 次相同失败 ${code}：转 blocked，要求改变方法。`, { code, message });
    }
    this.notify('work-released', { workId: work.workId, code, failureStreak: patch.failureStreak });
    return { ok: true, work: safeClone(this.works.get(work.workId)) };
  }

  /**
   * 原生容量拒绝：attempt 记 `cancelled(capacity-deferred)`，work 回 `ready` 且
   * **不消耗 attempt 预算、不计失败**，并把调度器退避到 `capacityCooldownMs` 之后。
   * 这与"拒绝并保持 ready、不排队空等"一致；预算只应被真正跑过的 attempt 消耗。
   */
  async deferForCapacity(plan, result) {
    const now = this.clock.now();
    this.nativeCapacityBlockedUntil = now + this.config.scheduler.capacityCooldownMs;
    this.capacityDeferrals = (this.capacityDeferrals ?? 0) + 1;
    return this.mutex.run(async () => {
      const attempt = this.attempts.get(plan.attemptId);
      if (attempt && !TERMINAL_ATTEMPT_STATES.has(attempt.state)) {
        await this.patchAttemptInLock(plan.attemptId, {
          state: 'cancelled',
          intent: 'capacity-deferred',
          error: `${result.code}: ${result.message}`,
          endedAt: now,
        });
      }
      const work = this.works.get(plan.workId);
      if (work) {
        const remaining = (work.attempts ?? []).filter((id) => id !== plan.attemptId);
        const stored = await this.storage.put(
          'works',
          work.workId,
          {
            ...work,
            attempts: remaining,
            activeAttemptId: null,
            state: 'ready',
            blockedReason: null,
            deferReason: result.code,
            deferredAt: now,
          },
          { expectRev: work.rev },
        );
        if (stored.ok) this.works.set(work.workId, stored.record);
      }
      this.diagnostics.push(
        'service:capacity-deferred',
        `${plan.workId} 因原生容量拒绝（${result.code}）保持 ready，退避 ${this.config.scheduler.capacityCooldownMs}ms；不消耗 attempt 预算、不计失败。`,
        { childId: plan.childId, blockedUntil: this.nativeCapacityBlockedUntil },
      );
      this.notify('work-released', { workId: plan.workId, code: result.code, deferred: true });
      return { ok: true, deferred: true, blockedUntil: this.nativeCapacityBlockedUntil };
    });
  }

  /**
   * 把 attempt 标失败并推进 work 状态。**必须在同一次锁持有内完成**：
   * 分两次加锁会给调度器留出"work 已经 ready 但失败计数还没落盘"的窗口，
   * 真实桌面验收里正是这个窗口让 `REPEATED_IDENTICAL_FAILURE` 没能及时生效（streak 冲到 5）。
   */
  async failAttempt(attemptId, code, message) {
    return this.mutex.run(async () => {
      const attempt = this.attempts.get(attemptId);
      if (!attempt) return denied('ATTEMPT_NOT_FOUND', `没有 attempt ${attemptId}`);
      await this.patchAttemptInLock(attemptId, { state: 'failed', error: `${code}: ${message}`, endedAt: this.clock.now() });
      return this.releaseWorkAfterAttempt(attemptId, code, message);
    });
  }

  // ---------------------------------------------------------------------------
  // 回执（self 形态：契约 §14）
  // ---------------------------------------------------------------------------
  /**
   * `execution:'self'` 的完成通路：**不依赖 attempt**。
   *
   * 为什么必须有：self 项由成员**自己的回合**完成，永远不会有 leaf attempt，
   * 于是 `reportWork`（要 attemptId）用不上、`workVerify` 又在 `self_running` 直接拒 →
   * 一个真的把活干完的成员，账本永远停在 `self_running`。这与 T12"owner 基于真实产物
   * 与验收条件确认完成"直接冲突。
   *
   * 硬约束（不放松）：
   *   - **只有该 work 的 owner 成员**能提交（lead 只能对自己 owner 的 work；否则 `DELEGATION_SCOPE`）；
   *   - 必须给**真实产物路径**与**验收证据**——不得仅凭"文件存在"结算；
   *   - 之后仍走 `produced → awaiting_verification → accepted`：**`produced ≠ accepted`**，
   *     必须由 owner `team_work_verify` 才能真正 accepted；
   *   - provenance 由 Host 从真实调用上下文写（`via:'self-report'`）。
   */
  async selfReport(caller, request = {}) {
    const writable = this.assertWritable();
    if (!writable.ok) return writable;
    // 与 `subagentStart` 同一约定：接受 raw agent / `{id}` / 已解析的 actor（`actor()` 结果）。
    const actor = caller && caller.ok === true && caller.agent ? caller : this.actor(caller);
    if (!actor.ok) return actor;
    const workId = String(request.workId ?? '');
    const work = this.works.get(workId);
    if (!work) return denied('WORK_NOT_FOUND', `没有工作项 ${workId}。`);
    const team = this.assertTeamOf(actor, work.teamKey);
    if (!team.ok) return team;
    if (actor.role !== 'member' && actor.role !== 'lead') {
      return denied('TEAM_MEMBER_REQUIRED', 'self 回执只能由该 work 的 owner 成员（或 lead 对自己 owner 的 work）提交。');
    }
    if (work.ownerMemberId !== actor.memberId) {
      return denied('DELEGATION_SCOPE', `${workId} 的 owner 是 ${work.ownerMemberId}：${actor.memberId} 不能替它提交 self 回执。`);
    }
    if ((work.execution ?? 'delegate') !== 'self') {
      return denied('NOT_A_SELF_WORK', `${workId} 是 execution=${work.execution ?? 'delegate'}：请用 team_work_report 带 attemptId 提交执行者回执。`);
    }
    if (work.state === 'accepted') return denied('WORK_TERMINAL', `${workId} 已验收。`);
    if (work.state === 'cancelled') return denied('WORK_TERMINAL', `${workId} 已取消。`);
    if (work.state !== 'self_running' && work.state !== 'blocked') {
      return denied('WORK_NOT_SELF_RUNNING', `${workId} 当前是 ${work.state}：只有 self_running（或依赖未满足的 blocked）的 self 项能提交 self 回执。`);
    }
    if (work.state === 'blocked') {
      return denied('WORK_BLOCKED', `${workId} 的依赖尚未满足（${work.blockedReason ?? 'unknown'}）：不能先交产物。`, { workId });
    }
    if (work.activeAttemptId) {
      return denied('WORK_ALREADY_ACTIVE', `${workId} 有活跃 attempt：self 回执不接受在跑的执行。`);
    }
    const artifacts = normalizeArtifacts(request.artifacts ?? []);
    if (artifacts.length === 0) {
      return denied('SELF_REPORT_WITHOUT_ARTIFACTS', 'self 回执必须给出真实产物路径（artifacts）；"文件存在"或"我做完了"都不算结算。', {
        hint: '给出你真实写盘的产物：`artifacts:[{path, version}]`，并在 evidence 里带上可核对的命令与结果。',
      });
    }
    const evidence = Array.isArray(request.evidence) ? request.evidence : [];
    if (evidence.length === 0) {
      return denied('SELF_REPORT_WITHOUT_EVIDENCE', 'self 回执必须带可核查的验收证据（evidence）；不得仅凭产物路径结算。', {
        hint: '至少给一条 `{kind:"verification", ok:true, command:"…", ref:"…"}` 或 `{kind:"acceptance", ok:true}`。',
      });
    }
    const summary = typeof request.summary === 'string' ? request.summary : '';
    const unresolved = toStringArray(request.unresolved);
    const at = this.clock.now();

    // 契约 §3：self 回执的证据同样必须被 Host 校验（否则"自己做 + 自报价"就能过）。
    // 这里**不**要求 accepted（accepted 仍由 owner 另一次 workVerify 决定），
    // 因此允许 weak 证据（文件存在），但 weak 永远不能让 work 变成 accepted。
    const validation = this.config?.evidence?.requireForAccept !== false
      ? await this.validateWorkEvidence({ work, evidence, requireStrongForAccept: false, requireAcceptance: false })
      : null;
    if (validation && validation.ok !== true) {
      this.diagnostics.push('service:selfReport:evidence-rejected', `${workId}: ${validation.codes.join(',')}`, { codes: validation.codes });
      return denied(
        'EVIDENCE_INSUFFICIENT',
        `self 回执的证据不足，不能交回：${validation.codes.join('、') || '缺少可复核证据'}。`,
        {
          workId,
          codes: validation.codes,
          missing: validation.missing,
          hints: validation.hints,
          hint: validation.hints[0] ?? '每条证据都要映射到真实文件读取（file + command，文件存在且非空）或 Host 的 attempt 记录。',
        },
      );
    }

    return this.mutex.run(async () => {
      const current = this.works.get(workId);
      if (current.state !== 'self_running') {
        return denied('WORK_NOT_SELF_RUNNING', `${workId} 状态已变为 ${current.state}：并发提交已被拒绝。`);
      }
      // **同一道完成门槛**（completionGate），不是 self 专用的第二套判定。
      const gate = completionGate({
        work: current,
        attempt: { state: 'produced', artifactRefs: artifacts, signals: {} },
        evidence,
        userConfirmed: request.userConfirmed === true,
      });
      const prov = provenance({
        actor,
        toolCallId: request.toolCallId ?? null,
        missionId: current.missionId ?? null,
        workId,
        planRevision: current.planRevision ?? null,
        at,
        extra: { via: 'self-report' },
      });
      const nextWork = {
        ...current,
        artifactRefs: mergeArtifactRefs(current.artifactRefs ?? [], artifacts),
        producedBy: current.ownerMemberId,
        producedAt: at,
        selfReported: true,
        producedVia: 'self-report',
        evidenceValid: false, // 自报不等于 Host 验收；workVerify 通过后才置 true
        evidenceRefs: [...new Set([...(current.evidenceRefs ?? []), ...evidence.map((item) => (typeof item?.ref === 'string' ? item.ref : `${item?.kind ?? 'evidence'}`))])],
        evidenceEvidence: [...(current.evidenceEvidence ?? []), ...evidence],
        completion: { level: gate.level, pendingUserAcceptance: gate.pendingUserAcceptance, missing: gate.missing, evidenceDigest: validation?.digest ?? null },
        // `produced ≠ accepted`：静默状态是"等待 owner 核验"，只有 team_work_verify 能 accepted。
        state: gate.level === 'none' ? 'self_running' : 'awaiting_verification',
        blockedReason: gate.level === 'none' ? 'COMPLETION_GATE_NOT_SATISFIED' : null,
        selfReport: { at, artifacts, evidence, summary: summary.slice(0, 2000), unresolved, gate: gate.level, evidenceCodes: validation?.codes ?? [], evidenceDigest: validation?.digest ?? null },
        provenanceLog: appendProvenance(current.provenanceLog, { ...prov, action: 'work-self-report' }),
      };
      const stored = await this.storage.put('works', workId, nextWork, {
        expectRev: current.rev,
        idempotencyKey: `self-report:${workId}:${sha256Hex(stableStringify({ artifacts, summary }))}`,
      });
      if (!stored.ok && stored.code !== 'IDEMPOTENCY_CONFLICT') {
        return denied(stored.code ?? 'PERSIST_FAILED', 'self 回执写入失败', { detail: stored.message });
      }
      this.works.set(workId, stored.record ?? nextWork);
      if (validation) await this.persistEvidenceInLock({ work: this.works.get(workId), validation, attemptId: null, verifiedBy: null });
      this.diagnostics.push('service:selfReport', `${workId} ← self-report（gate ${gate.level}，state ${this.works.get(workId).state}）`);
      this.notify('work-settled', { workId, outcome: 'produced', via: 'self-report', level: gate.level });
      return {
        ok: true,
        accepted: true,
        via: 'self-report',
        work: safeClone(this.works.get(workId)),
        gate,
        artifacts,
        evidence: validation
          ? { ok: validation.ok, codes: validation.codes, missing: validation.missing, verificationCount: validation.verificationCount, acceptanceCount: validation.acceptanceCount, digest: validation.digest }
          : null,
        awaitingVerification: this.works.get(workId).state === 'awaiting_verification',
        deduplicated: Boolean(stored.deduplicated),
        note: 'self 产物已交回，进入 awaiting_verification：owner 用 team_work_verify 核验后才算 accepted（produced ≠ accepted）。',
      };
    }).then(async (result) => {
      if (result.ok) {
        await this.notifyDependents(workId, result.work).catch(() => {});
      }
      return result;
    });
  }

  // ---------------------------------------------------------------------------
  // 回执
  // ---------------------------------------------------------------------------
  async reportWork(caller, request = {}) {
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    // 契约 §14：`execution:'self'` 的 work **永远拿不到 attempt**（调度器跳过 self 项、
    // 启动 self 项被拒），因此它必须有一条**不依赖 attempt** 的完成通路。
    // 形态：`{workId}`（无 attemptId）→ self 回执；由 owner 自己提交真实产物与验收证据。
    if (!request.attemptId && request.workId) {
      return this.selfReport(actor, request);
    }
    const attemptId = String(request.attemptId ?? '');
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return denied('ATTEMPT_NOT_FOUND', `没有 attempt ${attemptId}`);

    // 身份：executor 本人，或该 work 的 owner member，或 lead。
    const isExecutor = actor.agent && String(actor.agent.id) === String(attempt.executorChildId);
    const isOwner = actor.role === 'member' && actor.memberId === attempt.ownerMemberId;
    const isLead = actor.role === 'lead' && this.isSameTeam(actor, attempt.teamKey);
    if (!isExecutor && !isOwner && !isLead) {
      return denied('DELEGATION_SCOPE', '只有该 attempt 的 executor、其 owner member 或 lead 能提交回执。');
    }

    // 迟到结果隔离：lease 过期或 epoch 不匹配 → 只归档。
    if (Number.isInteger(request.leaseEpoch) && request.leaseEpoch !== attempt.leaseEpoch) {
      return this.quarantineLateResult(attempt, request, `LEASE_EPOCH_STALE(expected ${attempt.leaseEpoch}, got ${request.leaseEpoch})`);
    }
    if (attempt.leaseExpiresAt && this.clock.now() > attempt.leaseExpiresAt) {
      return this.quarantineLateResult(attempt, request, 'LEASE_EXPIRED');
    }
    if (TERMINAL_ATTEMPT_STATES.has(attempt.state)) {
      this.stats.duplicatesSuppressed += 1;
      return { ok: true, accepted: false, code: 'ALREADY_SETTLED', work: safeClone(this.works.get(attempt.workId)) };
    }
    const idempotencyKey = typeof request.idempotencyKey === 'string' && request.idempotencyKey ? request.idempotencyKey : `report:${attemptId}:${attempt.leaseEpoch}`;
    if (attempt.settlementKey === idempotencyKey) {
      this.stats.duplicatesSuppressed += 1;
      return { ok: true, accepted: false, code: 'DUPLICATE_RECEIPT', deduplicated: true };
    }

    const outcome = request.outcome === 'failed' || request.outcome === 'cancelled' ? request.outcome : 'produced';
    const artifacts = normalizeArtifacts(request.artifacts ?? attempt.artifacts ?? []);
    const evidence = Array.isArray(request.evidence) ? request.evidence : [];
    const summary = typeof request.summary === 'string' ? request.summary : '';
    const unresolved = toStringArray(request.unresolved);
    const signals = {
      idle: request.signals?.idle === true,
      timedOut: request.signals?.timedOut === true,
      nonEmptyCompletionFile: request.signals?.nonEmptyCompletionFile === true,
      promiseAllBarrierSatisfied: request.signals?.promiseAllBarrierSatisfied === true,
    };

    const nextAttempt = {
      ...attempt,
      state: outcome === 'produced' ? 'produced' : outcome,
      artifacts,
      artifactRefs: artifacts,
      evidenceRefs: evidence.map((item) => (typeof item?.ref === 'string' ? item.ref : `${item?.kind ?? 'evidence'}:${sha256Hex(stableStringify(item)).slice(0, 12)}`)),
      evidence,
      summary,
      unresolved,
      signals,
      settlementKey: idempotencyKey,
      endedAt: this.clock.now(),
    };

    return this.mutex.run(async () => {
      const currentAttempt = this.attempts.get(attemptId);
      const work = this.works.get(currentAttempt.workId);
      if (!work) return denied('WORK_NOT_FOUND', `attempt 指向的工作项不存在：${currentAttempt.workId}`);

      const storedAttempt = await this.storage.put('attempts', attemptId, nextAttempt, { expectRev: currentAttempt.rev, idempotencyKey });
      if (!storedAttempt.ok) {
        if (storedAttempt.code === 'IDEMPOTENCY_CONFLICT') {
          this.stats.duplicatesSuppressed += 1;
          return { ok: true, accepted: false, code: 'DUPLICATE_RECEIPT', deduplicated: true };
        }
        return denied(storedAttempt.code, '回执写入失败', { detail: storedAttempt.message });
      }
      this.attempts.set(attemptId, storedAttempt.record);
      this.stats.settlements += 1;

      const mergedEvidence = [...(work.evidenceRefs ?? [])];
      const gate = completionGate({
        work,
        attempt: storedAttempt.record,
        evidence: [...(work.evidenceEvidence ?? []), ...evidence],
        userConfirmed: request.userConfirmed === true,
      });

      const isActive = work.activeAttemptId === attemptId;
      const nextWork = { ...work };
      const autonomous = isAutonomousWork(work);
      if (outcome === 'produced') {
        nextWork.artifactRefs = [...(work.artifactRefs ?? [])];
        for (const artifact of artifacts) {
          const existing = nextWork.artifactRefs.find((item) => item.path === artifact.path);
          if (existing) existing.version = Math.max(existing.version, artifact.version ?? 1);
          else nextWork.artifactRefs.push({ path: artifact.path, version: artifact.version ?? 1 });
        }
        nextWork.evidenceRefs = [...new Set([...mergedEvidence, ...nextAttempt.evidenceRefs])];
        nextWork.evidenceEvidence = [...(work.evidenceEvidence ?? []), ...evidence];
        nextWork.completion = { level: gate.level, pendingUserAcceptance: gate.pendingUserAcceptance, missing: gate.missing };
        nextWork.producedBy = nextAttempt.executorChildId ?? nextWork.producedBy ?? null;
        nextWork.producedAt = this.clock.now();
        if (gate.level === 'none') {
          nextWork.state = 'claimed';
          nextWork.blockedReason = 'COMPLETION_GATE_NOT_SATISFIED';
        } else if (autonomous) {
          // 契约 §2：`produced ≠ accepted`。自治 work 的静默/自动状态是"等待 owner 核验"，
          // 只有 `team_work_verify` 才会把它变成 accepted。
          nextWork.state = 'awaiting_verification';
          nextWork.blockedReason = null;
        } else {
          nextWork.state = gate.level === 'produced' ? 'produced' : 'verifying';
        }
      } else if (outcome === 'failed') {
        nextWork.state = 'ready';
        nextWork.blockedReason = `ATTEMPT_FAILED: ${summary || 'no summary'}`;
      } else {
        nextWork.state = 'cancelled';
      }
      if (isActive) nextWork.activeAttemptId = null;

      const storedWork = await this.storage.put('works', work.workId, nextWork, { expectRev: work.rev });
      if (!storedWork.ok) return denied(storedWork.code, '工作项状态写入失败', { detail: storedWork.message });
      this.works.set(work.workId, storedWork.record);
      // 派发意图被这次 attempt 消费（幂等：重复回执不会重复消费）。
      const consumedIntent = await this.consumeIntentInLock(attempt, storedWork.record);

      this.diagnostics.push('service:reportWork', `${work.workId} ← ${outcome} (gate ${gate.level}${autonomous ? `, state ${storedWork.record.state}` : ''})`, { attemptId, missing: gate.missing });
      this.notify('work-settled', { workId: work.workId, attemptId, outcome, level: gate.level });
      return {
        ok: true,
        accepted: true,
        work: safeClone(this.works.get(work.workId)),
        attempt: safeClone(this.attempts.get(attemptId)),
        gate,
        nativeTaskSynced: false,
        settledWork: safeClone(this.works.get(work.workId)),
        consumedIntent,
        awaitingVerification: storedWork.record.state === 'awaiting_verification',
        note: autonomous && storedWork.record.state === 'awaiting_verification'
          ? '产物已交回，进入 awaiting_verification：owner 用 team_work_verify 核验后才算 accepted（produced ≠ accepted）。'
          : undefined,
      };
    }).then(async (settled) => {
      if (!settled.ok) return settled;
      // 原生 task 只在验收门槛满足后才 complete；否则保留进行中并显示待验收。
      // 该调用在状态锁**之外**执行：不在锁内等待其它系统。
      const current = settled.settledWork;
      let nativeTaskSynced = false;
      if (current && (current.state === 'verifying' || current.state === 'accepted' || current.completion?.level === 'accepted' || current.completion?.level === 'user-confirmed')) {
        const sync = await this.syncNativeTask(actor, current, 'complete');
        nativeTaskSynced = sync.ok;
      }
      const { settledWork, ...rest } = settled;
      // 回执到达 → 向 **owner** 入队 `leaf_receipt` 并唤醒它去核验/修订（契约 §3/§6）。
      const nextWork = settledWork ?? rest.work;
      if (nextWork && nextWork.teamKey && nextWork.ownerMemberId) {
        const eventType = outcome === 'produced' ? 'leaf_receipt' : 'dependency_changed';
        const queued = await this.enqueueMemberEvent({
          teamKey: nextWork.teamKey,
          memberId: nextWork.ownerMemberId,
          type: eventType,
          payload: {
            workId: nextWork.workId,
            attemptId,
            outcome,
            state: nextWork.state,
            needsVerification: nextWork.state === 'awaiting_verification',
            summary: summary.slice(0, 400),
          },
          origin: provenance({
            actor,
            toolCallId: null,
            missionId: nextWork.missionId ?? null,
            workId: nextWork.workId,
            planRevision: nextWork.planRevision ?? null,
            attemptId,
            leaseEpoch: attempt.leaseEpoch,
            childSessionId: attempt.executorChildId,
            parentSessionId: attempt.parentSessionId,
            at: this.clock.now(),
          }),
        });
        if (queued.ok && !queued.deduplicated) {
          await this.persistMemberEvent(this.memberEvents.get(queued.event.eventId), this.cursorOf(nextWork.teamKey, nextWork.ownerMemberId));
        }
      }
      return { ...rest, nativeTaskSynced };
    });
  }

  /** 锁内：把 attempt 对应的派发意图标记为 consumed。 */
  async consumeIntentInLock(attempt, work) {
    const intentId = attempt?.dispatchIntentId;
    if (!intentId) return null;
    const intent = this.dispatchIntents.get(intentId);
    if (!intent || intent.state !== 'authorized') return null;
    const next = { ...intent, state: 'consumed', consumedByAttemptId: attempt.attemptId, consumedAt: this.clock.now() };
    const stored = await this.storage.put('dispatch_intents', intentId, next, { expectRev: intent.rev });
    if (stored.ok) this.dispatchIntents.set(intentId, stored.record);
    else this.diagnostics.push('service:consumeIntent:not-persisted', `${intentId}: ${stored.code} ${stored.message}`);
    this.diagnostics.push('service:dispatch-intent-consumed', `${intentId} → attempt ${attempt.attemptId}（work ${work?.workId ?? attempt.workId}）`);
    return safeClone(this.dispatchIntents.get(intentId));
  }

  async quarantineLateResult(attempt, request, reason) {
    const entry = {
      lateResultId: newId('late'),
      workId: attempt.workId,
      attemptId: attempt.attemptId,
      leaseEpoch: request.leaseEpoch ?? null,
      expectedLeaseEpoch: attempt.leaseEpoch,
      reason,
      outcome: request.outcome ?? null,
      at: this.clock.now(),
    };
    // 迟到结果的**隔离记录**必须落盘：它是"只归档、不覆盖新版本"这条保证的审计凭据。
    // 写失败时绝不能静默——否则内存里有、重启后没了，隔离就失去凭据。
    const quarantined = await this.storage.put(LATE_RESULTS_TABLE, entry.lateResultId, entry, { idempotencyKey: `late:${attempt.attemptId}:${reason}:${sha256Hex(stableStringify(request.summary ?? ''))}` });
    this.lateResults.push(entry);
    this.stats.lateResults += 1;
    if (!quarantined.ok) {
      this.diagnostics.push(
        'service:late-result:not-persisted',
        `${attempt.workId}: 迟到结果未能落盘（${quarantined.code}: ${quarantined.message}）；本次会话内仍隔离，但重启后会丢失该审计记录。`,
        { lateResultId: entry.lateResultId, attemptId: attempt.attemptId, code: quarantined.code },
      );
    }
    this.diagnostics.push('service:late-result', `${attempt.workId}: ${reason}；只归档，不覆盖新版本。`, entry);
    this.notify('late-result', entry);
    return { ok: true, accepted: false, code: reason, quarantined: true, lateResult: entry };
  }

  // ---------------------------------------------------------------------------
  // 停止
  // ---------------------------------------------------------------------------
  /**
   * `scope`:
   *  - `turn`    只停该 attempt 当前的模型回合（inbox 保留），工作项回到 ready 等待重新派发。
   *  - `attempt` 停止并释放该 attempt 的名额。
   *  - `work`    显式停止整项工作。
   * 注意：**停 leader 当前 turn 不会影响成员**——成员是独立 Session，本方法从不广播到成员。
   */
  async interruptWork(caller, request = {}) {
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    const workId = String(request.workId ?? '');
    const work = this.works.get(workId);
    if (!work) return denied('WORK_NOT_FOUND', `没有工作项 ${workId}`);
    if (actor.role === 'member' && work.ownerMemberId !== actor.memberId) return denied('DELEGATION_SCOPE', 'member 只能停止自己模块的工作项。');
    const scope = request.scope === 'turn' || request.scope === 'work' ? request.scope : 'attempt';
    const attemptId = work.activeAttemptId;
    if (!attemptId) return { ok: true, stopped: false, code: 'NO_ACTIVE_ATTEMPT', reason: '该工作项当前没有活跃 attempt。' };
    const attempt = this.attempts.get(attemptId);

    const interruptResult = await this.adapter.interruptChildByParent(attempt.executorChildId, attempt.parentSessionId);
    if (!interruptResult.ok) {
      this.diagnostics.push('service:interruptWork:native-failed', `${interruptResult.code}: ${interruptResult.message}`);
    }

    if (scope === 'turn') {
      await this.patchAttempt(attemptId, { state: 'waiting', interruptedAt: this.clock.now(), interruptScope: 'turn' });
      await this.mutex.run(async () => {
        const current = this.works.get(workId);
        const stored = await this.storage.put('works', workId, { ...current, activeAttemptId: null, state: 'ready', blockedReason: null }, { expectRev: current.rev });
        if (stored.ok) this.works.set(workId, stored.record);
      });
      this.notify('work-turn-interrupted', { workId, attemptId });
      return { ok: true, stopped: true, scope, note: '只停止了该执行者当前的模型回合；成员会话与团队其他成员继续运行。' };
    }

    await this.patchAttempt(attemptId, { state: 'cancelled', endedAt: this.clock.now(), interruptScope: scope, error: 'INTERRUPTED' });
    await this.mutex.run(async () => {
      const current = this.works.get(workId);
      const next = scope === 'work'
        ? { ...current, activeAttemptId: null, state: 'cancelled' }
        : { ...current, activeAttemptId: null, state: 'ready', blockedReason: 'ATTEMPT_INTERRUPTED' };
      const stored = await this.storage.put('works', workId, next, { expectRev: current.rev });
      if (stored.ok) this.works.set(workId, stored.record);
    });
    this.notify('work-interrupted', { workId, attemptId, scope });
    return { ok: true, stopped: true, scope };
  }

  /**
   * 整队停止。`scope` 必须明确：
   *  - `turn`    仅停止调用者自己的当前回合（对成员零影响）。
   *  - `members` 停止每个成员的当前回合，保留其工作项与队列。
   *  - `team`    停止并取消团队内全部 attempt 与工作项。
   */
  async interruptTeam(caller, request = {}) {
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    if (actor.role !== 'lead' && actor.role !== 'member') return denied('TEAM_LEAD_REQUIRED', '只有团队成员能停止团队范围的工作。');
    const teamKey = this.resolveTeamKey(actor, request.teamKey);
    const scope = request.scope === 'members' || request.scope === 'team' ? request.scope : 'turn';

    if (scope === 'turn') {
      return {
        ok: true,
        scope,
        stoppedAttempts: [],
        note: 'scope=turn 只停止调用者自己当前的模型回合；成员的独立 Session、任务队列与工作项不受影响。',
      };
    }

    const stoppedAttempts = [];
    for (const attempt of [...this.attempts.values()]) {
      if (attempt.teamKey !== teamKey || TERMINAL_ATTEMPT_STATES.has(attempt.state)) continue;
      await this.adapter.interruptChildByParent(attempt.executorChildId, attempt.parentSessionId);
      stoppedAttempts.push(attempt.attemptId);
    }
    await this.mutex.run(async () => {
      for (const attemptId of stoppedAttempts) {
        const attempt = this.attempts.get(attemptId);
        if (!attempt) continue;
        const stored = await this.storage.put('attempts', attemptId, { ...attempt, state: scope === 'team' ? 'cancelled' : 'waiting', endedAt: this.clock.now() }, { expectRev: attempt.rev });
        if (stored.ok) this.attempts.set(attemptId, stored.record);
      }
      for (const work of [...this.works.values()]) {
        if (work.teamKey !== teamKey) continue;
        if (!stoppedAttempts.includes(work.activeAttemptId) && scope !== 'team') continue;
        const next = scope === 'team'
          ? { ...work, state: 'cancelled', activeAttemptId: null }
          : { ...work, state: 'ready', activeAttemptId: null, blockedReason: 'TEAM_TURN_INTERRUPTED' };
        const stored = await this.storage.put('works', work.workId, next, { expectRev: work.rev });
        if (stored.ok) this.works.set(work.workId, stored.record);
      }
      if (scope === 'team') {
        for (const member of this.members.values()) {
          if (member.teamKey !== teamKey) continue;
          const stored = await this.storage.put('members', `${member.teamKey}/${member.memberId}`, { ...member, phase: 'stopped' }, { expectRev: member.rev });
          if (stored.ok) this.members.set(`${member.teamKey}/${member.memberId}`, stored.record);
        }
      }
    });

    const memberNames = [...this.members.values()].filter((member) => member.teamKey === teamKey).map((member) => member.memberId);
    if (scope === 'members') {
      for (const name of memberNames) {
        const result = await this.adapter.interruptMember(actor.agent, name);
        if (!result.ok) this.diagnostics.push('service:interruptTeam:member', `${name}: ${result.code} ${result.message}`);
      }
    }

    this.notify('team-interrupted', { teamKey, scope, count: stoppedAttempts.length });
    return {
      ok: true,
      scope,
      stoppedAttempts,
      membersTouched: scope === 'team' ? memberNames : memberNames,
      note: scope === 'team' ? '整队停止：attempt 取消、工作项取消、成员标记停止。' : '按 scope=members 停止每个成员当前回合，工作项与队列保留。',
    };
  }

  // ---------------------------------------------------------------------------
  // 成员自治：模块委托 / 成员计划 / 派发意图 / 事件队列（契约 §1–§6）
  // ---------------------------------------------------------------------------

  memberKey(teamKey, memberId) {
    return `${teamKey}/${memberId}`;
  }

  missionKey(teamKey, missionId) {
    return `${teamKey}/${missionId}`;
  }

  /**
   * **团队归属的唯一判据**（契约 §3/§7）。
   *
   * 关键事实（本文件 `teamKeyForNative` 的注释里也写过）：原生 Team 的 identity 是
   * **root session id**，而 sidecar 的 `teamKey` 是用户可读的名字，**两者不是同一个字符串**。
   * 因此这里**只**用 `isSameTeam`（它同时接受 `actor.teamKey === teamKey` 与
   * `actor.teamKey === team.nativeTeamId`），**绝不**再叠加一个"严格字符串不等"——
   * 那个额外条件会把合法调用拒掉，正是"同一 caller 在 planSubmit 通过、在 subagentStart 被拒"
   * 的根因（`planSubmit` 用 `assertModuleScope`，`subagentStart` 曾经自己拼了一套更严的判据）。
   */
  assertTeamOf(actor, teamKey) {
    if (!teamKey) return denied('TEAM_KEY_REQUIRED', '缺少 teamKey，无法确认团队归属。');
    if (!actor || actor.ok !== true) return actor ?? denied('AGENT_REQUIRED', '需要真实 Agent 身份。');
    if (actor.role === 'root') {
      return denied('TEAM_LEAD_REQUIRED', '普通根会话（含 leaf）没有 Team 成员身份。');
    }
    if (!this.isSameTeam(actor, teamKey)) {
      return denied('DELEGATION_SCOPE', `调用者不属于团队 ${teamKey}：跨团队操作一律拒绝。`);
    }
    return { ok: true };
  }

  /** 权限与归属：member 只能作用于**自己所属团队、自己拥有**的模块。 */
  assertModuleScope(actor, teamKey, memberId) {
    const team = this.assertTeamOf(actor, teamKey);
    if (!team.ok) return team;
    if (actor.role === 'member' && memberId !== undefined && memberId !== null && memberId !== actor.memberId) {
      return denied('DELEGATION_SCOPE', `member ${actor.memberId} 不能规划/派发属于 ${memberId} 的模块。`);
    }
    return { ok: true, teamKey, memberId: memberId ?? actor.memberId };
  }

  // ---- 事件队列 --------------------------------------------------------------
  memberCursorKey(teamKey, memberId) {
    return this.memberKey(teamKey, memberId);
  }

  /** 消费游标：已消费到的序号 + 下一个可用序号。持久化，重启后继续。 */
  cursorOf(teamKey, memberId) {
    const key = this.memberCursorKey(teamKey, memberId);
    const stored = this.memberCursors.get(key);
    if (stored && Number.isInteger(stored.nextSeq) && Number.isInteger(stored.consumedSeq)) return stored;
    let maxSeq = 0;
    for (const event of this.memberEvents.values()) {
      if (event.teamKey === teamKey && event.memberId === memberId) maxSeq = Math.max(maxSeq, Number(event.seq) || 0);
    }
    return { cursorKey: key, teamKey, memberId, nextSeq: maxSeq + 1, consumedSeq: 0, updatedAt: 0 };
  }

  eventsFor(teamKey, memberId) {
    const out = [];
    for (const event of this.memberEvents.values()) {
      if (event.teamKey === teamKey && event.memberId === memberId) out.push(event);
    }
    return out.sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
  }

  /** 待处理（未消费、未合并）事件。 */
  pendingEvents(teamKey, memberId) {
    const cursor = this.cursorOf(teamKey, memberId);
    return this.eventsFor(teamKey, memberId).filter(
      (event) => event.state === 'pending' && (event.seq ?? 0) > (cursor.consumedSeq ?? 0),
    );
  }

  enqueueMemberEventInLock({ teamKey, memberId, type, payload = {}, origin = null, toolCallId = null, dedupe = null }) {
    if (!isMemberEventType(type)) return denied('MEMBER_EVENT_TYPE_UNKNOWN', `未注册的成员事件类型 ${type}`);
    const key = this.memberCursorKey(teamKey, memberId);
    const cursor = this.cursorOf(teamKey, memberId);
    const dedupeKey = eventDedupeKey(teamKey, memberId, { type, payload, dedupe });
    // 合并重复事件：同一事实重复到达只保留一条 pending，且**不产生额外唤醒**。
    for (const existing of this.memberEvents.values()) {
      if (existing.dedupeKey === dedupeKey && existing.state === 'pending') {
        return { ok: true, deduplicated: true, event: safeClone(existing) };
      }
    }
    const seq = cursor.nextSeq;
    const event = {
      eventId: newId('mevent'),
      seq,
      teamKey,
      memberId,
      type,
      state: 'pending',
      payload,
      origin,
      toolCallId,
      dedupeKey,
      summary: summarizeEvent({ type, payload }),
      at: this.clock.now(),
      consumedAt: null,
    };
    this.memberEvents.set(event.eventId, event);
    const nextCursor = { ...cursor, cursorKey: key, nextSeq: seq + 1, updatedAt: this.clock.now() };
    this.memberCursors.set(key, nextCursor);
    return { ok: true, event, cursor: nextCursor, deduplicated: false };
  }

  /**
   * 入队事件 → 唤醒该成员的真实模型回合。
   *
   * 入队是**持久**的（storageDomain sidecar）；唤醒失败绝不让事件丢失：
   * 事件仍在 pending 里，恢复/下次唤醒时继续消费。诊断记录失败原因，不静默。
   */
  async enqueueMemberEvent(spec) {
    const queued = await this.mutex.run(async () => this.enqueueMemberEventInLock(spec));
    if (!queued.ok) return queued;
    if (!queued.deduplicated) {
      this.diagnostics.push(
        'service:member-event',
        `${spec.teamKey}/${spec.memberId} ← ${spec.type} seq=${queued.event.seq}${queued.event.summary ? ` (${queued.event.summary})` : ''}`,
      );
      this.notify('member-event', { teamKey: spec.teamKey, memberId: spec.memberId, type: spec.type, seq: queued.event.seq });
    }
    const wake = await this.wakeMember({ teamKey: spec.teamKey, memberId: spec.memberId, reason: spec.type });
    return { ...queued, wake };
  }

  /**
   * 持久化并落盘事件游标。事件与游标是两条记录（storageDomain 没有跨表事务），
   * 因此顺序固定为：先写事件（事实）→ 再写游标（进度）。任一步失败都保留内存态并明确诊断，
   * 由 `reconcile` 在下一次对账时补齐。
   */
  async persistMemberEvent(event, cursor) {
    const storedEvent = await this.storage.put('member_events', event.eventId, event, {
      idempotencyKey: `member-event:${event.eventId}`,
    });
    if (!storedEvent.ok) {
      this.diagnostics.push('service:member-event:not-persisted', `${event.eventId}: ${storedEvent.code} ${storedEvent.message}`);
      if (storedEvent.record) this.memberEvents.set(event.eventId, storedEvent.record);
    } else {
      this.memberEvents.set(event.eventId, storedEvent.record ?? event);
    }
    const storedCursor = await this.storage.put('member_cursors', cursor.cursorKey, cursor, { idempotencyKey: `member-cursor:${cursor.cursorKey}:${cursor.nextSeq}` });
    if (!storedCursor.ok) {
      this.diagnostics.push('service:member-cursor:not-persisted', `${cursor.cursorKey}: ${storedCursor.code} ${storedCursor.message}`);
    } else {
      this.memberCursors.set(cursor.cursorKey, storedCursor.record ?? cursor);
    }
    return { event: this.memberEvents.get(event.eventId), cursor: this.memberCursors.get(cursor.cursorKey) };
  }

  memberTurnState(teamKey, memberId) {
    const key = this.memberKey(teamKey, memberId);
    let state = this.memberTurns.get(key);
    if (!state) {
      state = { key, teamKey, memberId, inFlight: false, wakeCount: 0, queuedWake: false, lastWakeAt: null, lastWakeReason: null, lastWakeCode: null, lastTurnEndedAt: null, wakeLog: [], watchdog: null };
      this.memberTurns.set(key, state);
    }
    return state;
  }

  /** 该成员是否正在跑一个模型回合（用于"同一成员同时只允许一个在飞回合"）。 */
  memberTurnInFlight(teamKey, memberId) {
    return this.memberTurnState(teamKey, memberId).inFlight === true;
  }

  /** native `agent/status`：成员回合结束（idle）时必须解除在飞标记，避免队列被永久挡住。 */
  noteMemberStatus(agentId, status) {
    if (!agentId) return;
    for (const state of this.memberTurns.values()) {
      const member = this.members.get(this.memberKey(state.teamKey, state.memberId));
      if (!member || String(member.sessionId) !== String(agentId)) continue;
      if (status === 'idle') this.clearMemberTurn(state.teamKey, state.memberId, 'agent-idle');
    }
  }

  clearMemberTurn(teamKey, memberId, reason) {
    const state = this.memberTurnState(teamKey, memberId);
    if (state.watchdog) {
      clearTimeout(state.watchdog);
      state.watchdog = null;
    }
    if (!state.inFlight) return { ok: true, cleared: false };
    state.inFlight = false;
    state.lastTurnEndedAt = this.clock.now();
    this.diagnostics.push('service:member-turn-end', `${state.key} (${reason})`);
    // 合并期间到达的事件：回合结束后**再唤醒一次**，不丢事件、也不并发两个回合。
    if (state.queuedWake) {
      state.queuedWake = false;
      void this.wakeMember({ teamKey, memberId, reason: 'queued-after-turn' });
    }
    return { ok: true, cleared: true };
  }

  /**
   * 唤醒成员的**真实模型回合**。
   *
   * 链路（全部走原生公开服务，不伪造 Agent 身份）：
   *   1. member 记录 → sessionId；
   *   2. session 已有 live Agent → 直接用；否则走 `ensureLiveAgent`（原生 `agents.resume`
   *      → `agentLoop.resume`）把该 Session 恢复成真实 Agent；
   *   3. `agentTeams.sendMessage(lead, { target: memberName, content })`：
   *      原生契约是"先持久入队 peer message，再尝试立即投递"，即消息进入该成员的 inbox，
   *      由成员自己的回合消费 —— 这正是"真实模型回合消费"，而不是只写状态。
   *
   * 去重：同一成员同时只允许一个在飞回合；期间的唤醒请求合并成一次（`queuedWake`）。
   * 不用轮询生成空回合。
   */
  async wakeMember({ teamKey, memberId, reason = 'event' }) {
    const member = this.members.get(this.memberKey(teamKey, memberId));
    if (!member || member.phase === 'failed') {
      return { ok: false, code: 'MEMBER_UNAVAILABLE', message: `成员 ${teamKey}/${memberId} 不存在或已失败，事件保持 pending。` };
    }
    if (member.pausedBy === 'user') {
      this.diagnostics.push('service:member-wake:paused', `${member.memberId}: 用户显式暂停，事件保持 pending，不自动唤醒。`);
      return { ok: false, code: 'MEMBER_PAUSED_BY_USER', message: '用户显式暂停了该成员：不自动唤醒（暂停标记不会被自动恢复抵消）。' };
    }
    const state = this.memberTurnState(teamKey, memberId);
    if (state.inFlight) {
      state.queuedWake = true;
      this.diagnostics.push('service:member-wake:coalesced', `${state.key}: 已有在飞回合，本次唤醒合并（${reason}）。`);
      return { ok: true, coalesced: true, inFlight: true };
    }

    // 该成员当前待处理事件数：唤醒消息里带一个可核对的计数。
    const pending = this.pendingEvents(teamKey, memberId);
    const wakeText = buildWakePrompt({ member, pending, reason });

    // 1) 先确保该成员 Session 有 live Agent。
    const live = member.sessionId ? this.adapter.agentFor(member.sessionId) : undefined;
    if (!live && member.sessionId) {
      const resumed = await this.adapter.ensureLiveAgent(member.sessionId);
      if (!resumed.ok) {
        state.lastWakeCode = resumed.code;
        this.diagnostics.push('service:member-wake:resume-failed', `${member.memberId} (${member.sessionId}): ${resumed.code} ${resumed.message}；事件保持 pending。`);
        return { ok: false, code: resumed.code ?? 'MEMBER_RESUME_FAILED', message: resumed.message };
      }
      this.resumedAgentHandles = this.resumedAgentHandles ?? new Map();
      this.resumedAgentHandles.set(String(member.sessionId), resumed.value.handle);
      this.diagnostics.push('service:member-cold-resumed', `${member.memberId}: 冷唤醒成员 Session ${member.sessionId}`);
    }

    // 2) 用该团队的 live lead Agent 作为投递者（原生 sendMessage 要求真实 Team 成员身份）。
    const sender = await this.ensureTeamLeadAgent(teamKey);
    if (!sender.ok) {
      state.lastWakeCode = sender.code;
      this.diagnostics.push('service:member-wake:no-lead', `${teamKey}: ${sender.code} ${sender.message}；成员事件保持 pending（不伪造身份）。`);
      return { ok: false, code: sender.code, message: sender.message };
    }

    // 3) 投递：进入该成员 inbox，由成员自己的模型回合消费。
    const controller = new AbortController();
    const delivered = await this.adapter.sendTeamMessage(sender.agent, {
      target: member.memberId,
      content: [{ type: 'text', text: wakeText }],
      signal: controller.signal,
    });
    state.wakeCount += 1;
    state.lastWakeAt = this.clock.now();
    state.lastWakeReason = reason;
    state.wakeLog = [...(state.wakeLog ?? []).slice(-19), { at: state.lastWakeAt, reason, pending: pending.length, code: delivered.ok ? 'delivered' : delivered.code }];
    if (!delivered.ok) {
      state.lastWakeCode = delivered.code;
      this.diagnostics.push('service:member-wake:delivery-failed', `${member.memberId}: ${delivered.code} ${delivered.message}；事件保持 pending，恢复后继续。`, { via: sender.via });
      return { ok: false, code: delivered.code, message: delivered.message, pending: pending.length };
    }

    state.inFlight = true;
    state.lastWakeCode = null;
    // watchdog 只在**平台没有把回合结束告诉我们**时兜底（agent/status=idle 是主路径）。
    // 它不生成空回合：超时只是允许下一个真实事件再次唤醒。
    state.watchdog = setTimeout(() => {
      state.watchdog = null;
      if (state.inFlight) this.clearMemberTurn(teamKey, memberId, 'watchdog-timeout');
    }, this.memberTurnWatchdogMs);
    if (typeof state.watchdog?.unref === 'function') state.watchdog.unref();

    this.diagnostics.push(
      'service:member-wake',
      `${member.memberId} ← ${reason}（pending=${pending.length}，messageId=${delivered.value?.messageId ?? 'n/a'}，via=${sender.via}）`,
    );
    this.notify('member-woken', { teamKey, memberId, reason, messageId: delivered.value?.messageId ?? null });
    return { ok: true, messageId: delivered.value?.messageId ?? null, status: delivered.value?.status ?? 'accepted', pending: pending.length, via: sender.via };
  }

  /**
   * 团队 lead 的 live Agent。
   *
   * **不要求用户再对 leader 说一句话**：lead Agent 不在注册表里时，按团队记录里的
   * `rootSessionId` 走原生恢复路径把它取回来（与 `ensureLiveAgent` 同一条阶梯）。
   * 这只恢复**身份**用于投递，不是让 leader 决策 —— 成员的推进不经过 leader 的模型回合。
   */
  async ensureTeamLeadAgent(teamKey) {
    const team = this.teams.get(teamKey);
    if (!team) return denied('TEAM_NOT_REGISTERED', `团队 ${teamKey} 尚未登记。`);
    const rootSessionId = team.rootSessionId;
    if (!rootSessionId) return denied('TEAM_ROOT_UNKNOWN', `团队 ${teamKey} 没有 rootSessionId，无法取得真实 lead Agent。`);
    const existing = this.adapter.agentFor(rootSessionId);
    if (existing) {
      const membership = this.adapter.membership(existing);
      const role = membership.ok && membership.value ? membership.value.role : null;
      if (role === 'lead') return { ok: true, agent: existing, via: 'live-root' };
    }
    const resumed = await this.adapter.ensureLiveAgent(rootSessionId);
    if (!resumed.ok) return denied(resumed.code ?? 'LEAD_AGENT_UNAVAILABLE', `${resumed.message}（session ${rootSessionId}）`);
    this.resumedAgentHandles = this.resumedAgentHandles ?? new Map();
    this.resumedAgentHandles.set(String(rootSessionId), resumed.value.handle);
    this.diagnostics.push('service:lead-cold-resumed', `为成员唤醒冷唤醒 lead Session ${rootSessionId}（只取投递身份，不代替 leader 决策）`);
    return { ok: true, agent: resumed.value.agent, via: 'cold-resumed-root' };
  }

  // ---- mission（模块委托） ---------------------------------------------------
  /**
   * leader 建立/更新模块委托。**不产生任何可被叶子调度器消费的 ready 项**：
   * mission 只入队 `mission_assigned` 事件，成员自己决定怎么拆。
   */
  async missionAssign(caller, spec = {}) {
    const writable = this.assertWritable();
    if (!writable.ok) return writable;
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    if (actor.role !== 'lead') return denied('TEAM_LEAD_REQUIRED', '只有 Team lead 能建立模块委托（mission）。');

    const teamKey = this.resolveTeamKey(actor, spec.teamKey);
    const team = this.teamOf(actor, teamKey);
    if (!team) return denied('TEAM_NOT_REGISTERED', `团队 ${teamKey} 尚未登记：先 defineTeam。`);
    if (!this.isSameTeam(actor, teamKey)) return denied('DELEGATION_SCOPE', `lead 不能给不属于自己的团队 ${teamKey} 建模块委托。`);
    const memberId = typeof spec.memberId === 'string' && spec.memberId.trim() ? spec.memberId.trim() : null;
    if (!memberId) return denied('MEMBER_ID_REQUIRED', '模块委托必须指定 memberId（责任人）。');
    if (!this.members.has(this.memberKey(teamKey, memberId))) {
      return denied('MEMBER_NOT_FOUND', `团队 ${teamKey} 没有成员 ${memberId}：不能编造成员身份顶替。`);
    }
    const title = typeof spec.title === 'string' && spec.title.trim() ? spec.title.trim() : null;
    if (!title) return denied('MISSION_TITLE_REQUIRED', '模块委托必须有 title。');
    const goal = typeof spec.goal === 'string' ? spec.goal : '';
    if (!goal.trim()) return denied('MISSION_GOAL_REQUIRED', '模块委托必须有 goal（模块目标）。');

    const missionId = typeof spec.missionId === 'string' && spec.missionId.trim()
      ? spec.missionId.trim()
      : `${memberId}-${sha256Hex(`${title}:${goal}`).slice(0, 8)}`;
    const at = this.clock.now();

    return this.mutex.run(async () => {
      const key = this.missionKey(teamKey, missionId);
      const existing = this.missions.get(key);
      if (existing && existing.memberId !== memberId) {
        return denied('MISSION_ID_CONFLICT', `mission ${missionId} 已属于成员 ${existing.memberId}。`);
      }
      const prov = provenance({ actor, toolCallId: spec.toolCallId ?? null, missionId, at });
      const record = {
        missionId,
        teamKey,
        memberId,
        title,
        goal,
        boundaries: toStringArray(spec.boundaries),
        inputs: toStringArray(spec.inputs),
        budget: spec.budget && typeof spec.budget === 'object' ? safeClone(spec.budget) : null,
        acceptance: toStringArray(spec.acceptance),
        state: existing?.state === 'planned' || existing?.state === 'closed' ? existing.state : 'assigned',
        planRevision: existing?.planRevision ?? 0,
        createdAt: existing?.createdAt ?? at,
        assignedAt: existing?.assignedAt ?? at,
        provenance: existing?.provenance ?? prov,
        provenanceLog: appendProvenance(existing?.provenanceLog, { ...prov, action: 'mission-assign' }),
      };
      const stored = await this.storage.put('missions', key, record, {
        expectRev: existing?.rev,
        idempotencyKey: `mission:${key}:${sha256Hex(stableStringify({ title, goal, memberId }))}`,
      });
      if (!stored.ok && stored.code !== 'IDEMPOTENCY_CONFLICT') {
        return denied(stored.code ?? 'PERSIST_FAILED', '模块委托写入失败', { detail: stored.message });
      }
      const committed = stored.record ?? record;
      this.missions.set(key, committed);
      const queued = this.enqueueMemberEventInLock({
        teamKey,
        memberId,
        type: 'mission_assigned',
        payload: { missionId, title, goal, acceptance: record.acceptance, boundaries: record.boundaries, inputs: record.inputs },
        origin: prov,
        toolCallId: prov.toolCallId,
      });
      this.diagnostics.push('service:missionAssign', `${key} → ${memberId}（state=${committed.state}；不产生可调度项）`);
      return { ok: true, mission: safeClone(committed), event: safeClone(queued.event), deduplicated: Boolean(stored.deduplicated), note: '模块委托不可被叶子调度器直接消费；等待该成员自己提交计划。' };
    }).then(async (result) => {
      if (result.ok) {
        this.notify('mission-assigned', { teamKey, missionId, memberId });
        await this.persistMemberEvent(this.memberEvents.get(result.event.eventId), this.cursorOf(teamKey, memberId));
        const wake = await this.wakeMember({ teamKey, memberId, reason: 'mission_assigned' });
        return { ...result, wake };
      }
      return result;
    });
  }

  // ---- 成员计划 --------------------------------------------------------------
  /**
   * 成员**原子**提交/修订自己的模块计划（契约 §3）。
   *
   * - 只能规划自己所属模块、自己拥有的 work；
   * - `expectedPlanRevision` 做 CAS；
   * - `plannedBy` 由 Host 从真实调用上下文写，模型传的字段一律丢弃；
   * - 整批校验先做（阶段接力/产物/验收），任一条不合法则**整批不入库**。
   */
  async planSubmit(caller, spec = {}) {
    const writable = this.assertWritable();
    if (!writable.ok) return writable;
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    if (actor.role !== 'member' && actor.role !== 'lead') {
      return denied('TEAM_MEMBER_REQUIRED', '只有 Team member（或 lead 代自己的模块）能提交模块计划；leaf 不能写他人计划。');
    }
    const { dropped } = stripSpoofedIdentity(spec);
    const teamKey = this.resolveTeamKey(actor, spec.teamKey);
    const scope = this.assertModuleScope(actor, teamKey, actor.memberId);
    if (!scope.ok) return scope;

    const missionId = typeof spec.missionId === 'string' && spec.missionId.trim() ? spec.missionId.trim() : null;
    if (!missionId) return denied('MISSION_ID_REQUIRED', '模块计划必须挂在 missionId 上（leader 先给模块委托）。');
    const deliverables = Array.isArray(spec.deliverables) ? spec.deliverables : [];
    if (deliverables.length === 0) return denied('PLAN_EMPTY', '计划必须包含至少一个独立交付项（deliverables）。');
    if (deliverables.length > 60) return denied('PLAN_TOO_LARGE', '单次计划最多 60 个交付项。');

    return this.mutex.run(async () => {
      const key = this.missionKey(teamKey, missionId);
      const mission = this.missions.get(key);
      if (!mission) return denied('MISSION_NOT_FOUND', `没有模块委托 ${missionId}。leader 必须先 team_mission_assign。`);
      if (mission.memberId !== actor.memberId) {
        // **lead 也不得代成员写模块计划**（契约 §2/§11：leader 不能替成员拆解）。
        // lead 只有在自己就是该 mission 的 owner 时才能提交。
        return denied('DELEGATION_SCOPE', `mission ${missionId} 属于成员 ${mission.memberId}：${actor.memberId ?? actor.role} 不能改别人的模块计划（lead 不能替成员拆解）。`);
      }
      const expected = Number.isInteger(spec.expectedPlanRevision) ? spec.expectedPlanRevision : mission.planRevision ?? 0;
      if (expected !== (mission.planRevision ?? 0)) {
        return denied('PLAN_CAS_MISMATCH', `mission ${missionId} 的计划版本已从 ${expected} 变为 ${mission.planRevision ?? 0}；过期计划被拒绝。`, {
          current: { planRevision: mission.planRevision ?? 0 },
        });
      }

      // 1) 先整批规范化 + 校验（不写任何状态）。
      const prepared = [];
      /** 本批计划里声明的 workId → 产出位置（依赖锚点解析用，此时还没入库）。 */
      const deliverableIds = new Set(
        deliverables.map((item) => (typeof item?.workId === 'string' && item.workId.trim() ? item.workId.trim() : null)).filter(Boolean),
      );
      const deliverableOutputs = new Map();
      for (const item of deliverables) {
        const id = typeof item?.workId === 'string' && item.workId.trim() ? item.workId.trim() : null;
        if (id) deliverableOutputs.set(id, toStringArray(item?.outputs));
      }
      const anchorOf = (reference) => {
        const existing = this.works.get(reference);
        const outputs = existing?.outputs ?? deliverableOutputs.get(reference) ?? [];
        return outputs[0] ?? null;
      };
      for (const item of deliverables) {
        const execution = EXECUTION_MODES.includes(item?.execution) ? item.execution : 'delegate';
        // 契约 §13.3：依赖字段**两种形状都接受**，合并成同一份依赖列表（不是两套判定）。
        //   a) `blockedBy: string[]`            —— 纯 workId，与 submitWork 一致
        //   b) `dependencies: [{workId|artifact, version, requires}]`
        //      `requires:'verified-result'` 必须等 owner **accepted**；`'published-interface'` 只需 produced。
        const declaredBlockedBy = toStringArray(item?.blockedBy);
        const declaredDependencies = Array.isArray(item?.dependencies) ? item.dependencies : [];
        const mergedArtifactDeps = [...(Array.isArray(item?.artifactDependencies) ? item.artifactDependencies : [])];
        for (const dependency of declaredDependencies) {
          if (!dependency || typeof dependency !== 'object') {
            return denied('DEPENDENCY_INVALID', `交付项「${item?.title ?? '?'}」的 dependencies 项必须是对象。`);
          }
          const reference = typeof dependency.workId === 'string' && dependency.workId.trim()
            ? dependency.workId.trim()
            : (typeof dependency.artifact === 'string' ? dependency.artifact.trim() : '');
          if (!reference) return denied('DEPENDENCY_INVALID', '依赖必须给出 workId（或 artifact）。');
          // 引用一律进入 blockedBy 交给 `resolveBlockedBy` 解析（它按
          // workId → nativeTaskId → title → outputs 产物路径 四种方式解析）。
          // **解析不到会被整批拒绝**（DEPENDENCY_UNRESOLVED），绝不在这里静默丢掉——
          // 把一个真实依赖变成"没有依赖"是最危险的失败模式（work 会立刻可启动）。
          if (reference !== item?.workId) declaredBlockedBy.push(reference);
          // 依赖锚点：workId 指向的 work 的真实产物（已在库或本批计划里都算），
          // 否则 `dep.artifact` 是 undefined → 会匹配到**自己**的 outputs，被误判成"同交付物内部依赖"。
          const anchor = typeof dependency.artifact === 'string' && dependency.artifact.trim()
            ? dependency.artifact.trim()
            : anchorOf(reference);
          if (anchor) {
            mergedArtifactDeps.push({
              artifact: anchor,
              version: Number.isInteger(dependency.version) ? dependency.version : 1,
              requires: dependency.requires === 'verified-result' ? 'verified-result' : 'published-interface',
            });
          } else {
            mergedArtifactDeps.push(dependency);
          }
        }
        const candidate = {
          teamKey,
          title: item?.title,
          deliverable: item?.deliverable,
          kind: item?.kind,
          partOf: item?.partOf,
          ownerMemberId: actor.memberId,
          inputs: item?.inputs,
          outputs: item?.outputs,
          acceptance: item?.acceptance,
          artifactDependencies: mergedArtifactDeps,
          writeScopes: item?.writeScopes,
          blockedBy: [...new Set(declaredBlockedBy)],
          priority: item?.priority,
          contextPolicy: item?.contextPolicy,
          delegationBudget: item?.delegationBudget,
          brief: typeof item?.brief === 'string' ? item.brief : null,
          // 契约 v4：计划期声明的可执行验收项必须随交付项入库，否则 runVerification/
          // 验收绑定永远拿不到 declared（VERIFICATION_COMMAND_NOT_DECLARED 的根因）。
          verificationCommands: Array.isArray(item?.verificationCommands) ? item.verificationCommands : [],
        };
        if (typeof candidate.title !== 'string' || !candidate.title.trim()) {
          return denied('WORK_SPEC_INCOMPLETE', `交付项缺少 title（第 ${prepared.length + 1} 项）。`);
        }
        if (typeof candidate.deliverable !== 'string' || !candidate.deliverable.trim()) {
          return denied('WORK_SPEC_INCOMPLETE', `交付项「${candidate.title}」缺少 deliverable。`);
        }
        // 与 `submitWork` **同一道闸**：单条用 `validateWorkSpec`，整批在图级校验里再过一次
        // （`validateWorkGraph`）。这里先做单条，错误码与 `submitWork` 完全一致。
        const single = validateWorkSpec(candidate, {
          requireArtifactVersion: this.config.policy.requireArtifactVersion,
          phaseRelay: this.config.policy.phaseRelay,
          existingWorks: [],
        });
        if (!single.ok) {
          this.diagnostics.push('service:planSubmit:rejected', `${single.code}: ${single.message}`, single.hint ?? null);
          return denied(single.code, single.message, { hint: single.hint, stageRoles: single.stageRoles, droppedIdentityFields: dropped });
        }
        const requestedId = typeof item?.workId === 'string' && item.workId.trim() ? item.workId.trim() : null;
        // 归属检查**在任何写入之前**就做：不能先建出 work 再因为"改的是别人的项"失败。
        if (requestedId) {
          const existing = this.works.get(requestedId);
          if (existing && existing.teamKey !== teamKey) {
            return denied('WORK_ID_CONFLICT', `workId ${requestedId} 已属于团队 ${existing.teamKey}。`);
          }
          if (existing && existing.ownerMemberId !== actor.memberId) {
            return denied('DELEGATION_SCOPE', `${requestedId} 的 owner 是 ${existing.ownerMemberId}：不能改别人的计划。`);
          }
        }
        prepared.push({ candidate, execution, requestedId, brief: candidate.brief });
      }

      const planRevision = (mission.planRevision ?? 0) + 1;
      const at = this.clock.now();
      const prov = provenance({ actor, toolCallId: spec.toolCallId ?? null, missionId, planRevision, at });
      const plan = {
        planRevision,
        submittedAt: at,
        note: typeof spec.note === 'string' ? spec.note : '',
        deliverableIds: [],
        provenance: prov,
      };

      // **图级闸**（与 `submitWork` 同一道 `validateWorkGraph`，不是第二套判定）：
      // 先在内存里预览"这批交付项入库后"的图，命中阶段接力/同交付物内部依赖就**整批拒绝**，
      // 绝不留下半批计划，也绝不让同一交付物被拆成 背景→设计→检查 交给不同执行者。
      const preview = [];
      for (const entry of prepared) {
        preview.push({
          workId: entry.requestedId ?? `preview-${preview.length + 1}`,
          teamKey,
          ownerMemberId: actor.memberId,
          title: entry.candidate.title,
          deliverable: entry.candidate.deliverable,
          subject: entry.candidate.subject,
          partOf: entry.candidate.partOf,
          kind: entry.candidate.kind,
          outputs: toStringArray(entry.candidate.outputs),
          acceptance: toStringArray(entry.candidate.acceptance),
          artifactDependencies: Array.isArray(entry.candidate.artifactDependencies) ? entry.candidate.artifactDependencies : [],
          blockedBy: toStringArray(entry.candidate.blockedBy),
          execution: entry.execution,
        });
      }
      const previewIds = new Set(preview.map((item) => item.workId));
      const graph = validateWorkGraph(
        [...[...this.works.values()].filter((work) => !previewIds.has(work.workId)), ...preview],
        { phaseRelay: this.config.policy.phaseRelay },
      );
      const ownViolations = graph.violations.filter(
        (violation) => previewIds.has(violation.workId) || (violation.workIds ?? []).some((id) => previewIds.has(id)),
      );
      if (ownViolations.length > 0 && this.config.policy.phaseRelay === 'reject') {
        this.diagnostics.push('service:planSubmit:graph-rejected', ownViolations[0].message, ownViolations);
        return denied('PHASE_RELAY_GRAPH', ownViolations[0].message, {
          hint: ownViolations[0].hint,
          violations: ownViolations,
          graphViolations: ownViolations,
          droppedIdentityFields: dropped,
        });
      }

      const createdWorks = [];
      for (const entry of prepared) {
        const committed = await this.commitPlannedWorkInLock({ actor, teamKey, missionId, planRevision, entry, prov, at });
        if (!committed.ok) return committed;
        plan.deliverableIds.push(committed.work.workId);
        createdWorks.push(committed);
      }

      const nextMission = {
        ...mission,
        state: 'planned',
        planRevision,
        plan: safeClone(plan),
        plannedAt: at,
        provenanceLog: appendProvenance(mission.provenanceLog, { ...prov, action: 'plan-submit' }),
      };
      const storedMission = await this.storage.put('missions', key, nextMission, { expectRev: mission.rev });
      if (!storedMission.ok) {
        return denied(storedMission.code ?? 'PERSIST_FAILED', '计划版本写入失败（整批不改状态）', { detail: storedMission.message });
      }
      this.missions.set(key, storedMission.record ?? nextMission);
      this.diagnostics.push('service:planSubmit', `${missionId} planRevision=${planRevision}，交付项 ${prepared.length} 个（dropped identity fields: ${dropped.length > 0 ? dropped.join(',') : 'none'}）`);
      const committedGraph = validateWorkGraph([...this.works.values()], { phaseRelay: this.config.policy.phaseRelay });
      return {
        ok: true,
        mission: safeClone(this.missions.get(key)),
        planRevision,
        works: createdWorks.map((item) => safeClone(item.work)),
        droppedIdentityFields: dropped,
        graphViolations: committedGraph.ok ? [] : committedGraph.violations,
        notes: createdWorks.flatMap((item) => item.work.warnings ?? []),
        note: '计划已原子提交；delegate 项需 team_dispatch_authorize 授权后调度器才会启动，self 项由你本人执行。',
      };
    }).then(async (result) => {
      if (result.ok) {
        for (const work of result.works) {
          await this.emitWorkEvent(work, 'dependency_changed', { reason: 'dependency_changed' }).catch(() => {});
        }
        this.notify('plan-submitted', { teamKey, missionId, planRevision: result.planRevision });
      }
      return result;
    });
  }

  /** 锁内：创建/更新**成员自己拥有**的 work，并写自治语义字段与 provenance。 */
  async commitPlannedWorkInLock({ actor, teamKey, missionId, planRevision, entry, prov, at }) {
    const candidate = { ...entry.candidate, teamKey };
    const existingWorks = [...this.works.values()].filter((work) => work.workId !== entry.requestedId);
    const validation = validateWorkSpec(candidate, {
      requireArtifactVersion: this.config.policy.requireArtifactVersion,
      phaseRelay: this.config.policy.phaseRelay,
      existingWorks,
    });
    if (!validation.ok) {
      this.diagnostics.push('service:planSubmit:rejected', `${validation.code}: ${validation.message}`, validation.hint ?? null);
      return denied(validation.code, validation.message, { hint: validation.hint, stageRoles: validation.stageRoles });
    }
    const normalized = validation.normalized;
    // P1-7：计划入口同样拒绝"已生成内容的 LLM 逐字转抄"（合法开发复制工具/转换算法不受影响）。
    const mechanical = detectMechanicalTranscription(normalized);
    if (mechanical.mechanical) {
      this.diagnostics.push('service:planSubmit:mechanical-transcription', `${normalized.title ?? ''}: 拒绝 LLM 逐字转抄`, mechanical.hint);
      return denied(mechanical.code, mechanical.reason, { ...mechanical.hint, droppedIdentityFields: [] });
    }
    const workId = entry.requestedId ?? newId('work');
    const existing = this.works.get(workId);
    if (existing && existing.teamKey !== teamKey) return denied('WORK_ID_CONFLICT', `workId ${workId} 已属于团队 ${existing.teamKey}。`);
    if (existing && existing.ownerMemberId !== actor.memberId) {
      return denied('DELEGATION_SCOPE', `${workId} 的 owner 是 ${existing.ownerMemberId}：不能改别人的计划。`);
    }
    if (existing && (existing.state === 'executing' || (existing.state === 'self_running' && existing.activeAttemptId))) {
      return denied('WORK_ALREADY_ACTIVE', `${workId} 正在执行；修订计划不得覆盖在跑的 attempt。`);
    }
    // 契约 §14：self 项由成员自己的回合完成，没有 attempt；它必须能**修订自己的计划**
    // （否则成员在自做过程中调整交付项会被自己的旧计划卡死）。delegate 在跑项仍拒绝。
    //
    // 契约 §2：同一交付物身份 = 原 workId + 原 ownerMemberId。
    // 新 workId 但结构上是同一份交付物 → 拒绝（提示沿用原 workId 修订），
    // 覆盖"补传播 / verify / hash 接力换名"这类真实误用。
    const identity = this.judgeWorkIdentity({ ...normalized, workId, teamKey }, { selfWorkId: existing ? workId : null });
    if (!identity.ok) {
      this.diagnostics.push('service:planSubmit:identity-rejected', `${workId}: ${identity.code}`, identity.violations);
      return denied(identity.code, identity.message, {
        hint: identity.hint,
        matchedWorkId: identity.matchedWorkId,
        violations: identity.violations,
        identityKey: identity.identityKey,
        droppedIdentityFields: [],
      });
    }
    const dependencyResolution = this.resolveBlockedBy(teamKey, normalized.blockedBy, workId);
    if (dependencyResolution.unresolved.length > 0) {
      this.diagnostics.push('service:planSubmit:dependency-unresolved', `${workId}: ${dependencyResolution.unresolved.join(', ')}`, dependencyResolution.unresolved);
      return this.dependencyUnresolvedDenial(dependencyResolution.unresolved, { workId, droppedIdentityFields: [] });
    }
    const blockedBy = dependencyResolution.resolved;
    const depsSatisfied = blockedBy.every((id) => this.isDependencySatisfied(id, normalized.artifactDependencies));
    const autonomousState = entry.execution === 'self' ? 'self_running' : 'planned';
    const work = {
      workId,
      teamKey,
      title: normalized.title,
      deliverable: normalized.deliverable,
      subject: normalized.subject,
      partOf: normalized.partOf,
      ownerMemberId: actor.memberId,
      kind: normalized.kind,
      splitKind: normalized.splitKind,
      inputs: normalized.inputs,
      outputs: normalized.outputs,
      acceptance: normalized.acceptance,
      artifactDependencies: normalized.artifactDependencies,
      verificationCommands: normalized.verificationCommands ?? existing?.verificationCommands ?? [],
      writeScopes: normalized.writeScopes,
      contextPolicy: normalized.contextPolicy,
      delegationBudget: normalized.delegationBudget,
      priority: normalized.priority,
      blockedBy,
      blockedReason: depsSatisfied ? null : 'DEPENDENCIES_UNSATISFIED',
      nativeTaskId: existing?.nativeTaskId ?? null,
      state: depsSatisfied ? autonomousState : 'blocked',
      activeAttemptId: existing?.activeAttemptId ?? null,
      attempts: existing?.attempts ?? [],
      failureStreak: existing?.failureStreak ?? 0,
      lastFailureCode: existing?.lastFailureCode ?? null,
      lastFailureMessage: existing?.lastFailureMessage ?? null,
      artifactRefs: existing?.artifactRefs ?? [],
      evidenceRefs: existing?.evidenceRefs ?? [],
      completion: existing?.completion ?? { level: 'none', pendingUserAcceptance: true },
      createdAt: existing?.createdAt ?? at,
      warnings: validation.warnings,
      // ---- 自治语义 ----
      missionId,
      planRevision,
      execution: entry.execution,
      plannedBy: actor.memberId,
      plannedAt: at,
      brief: entry.brief ?? existing?.brief ?? null,
      producedBy: existing?.producedBy ?? null,
      verifiedBy: existing?.verifiedBy ?? null,
      verifiedAt: existing?.verifiedAt ?? null,
      verification: existing?.verification ?? null,
      provenance: prov,
      provenanceLog: appendProvenance(existing?.provenanceLog, { ...prov, action: 'plan-work', workId }),
    };

    if (!work.nativeTaskId) {
      const taskResult = await this.adapter.createTask(actor.agent, {
        subject: work.title,
        description: `${work.deliverable}\n\n产物：${work.outputs.join(', ')}\n验收：${work.acceptance.join('；')}`,
        writeScopes: work.writeScopes,
      });
      if (taskResult.ok && taskResult.value?.id !== undefined) work.nativeTaskId = String(taskResult.value.id);
      else if (!taskResult.ok) this.diagnostics.push('service:planSubmit:native-task-unavailable', `${taskResult.code}: ${taskResult.message}`);
    }

    const stored = await this.storage.put('works', workId, work, {
      expectRev: existing?.rev,
      idempotencyKey: `planWork:${teamKey}:${workId}:r${planRevision}:${sha256Hex(stableStringify({ d: work.deliverable, o: work.outputs, e: work.execution }))}`,
    });
    if (!stored.ok && stored.code !== 'IDEMPOTENCY_CONFLICT') return denied(stored.code ?? 'PERSIST_FAILED', '工作项写入失败', { detail: stored.message });
    const committed = stored.record ?? work;
    this.works.set(workId, committed);
    // 契约 §2：首次创建时绑定身份（修订不换身份）。
    await this.persistIdentityInLock(this.works.get(workId));
    return { ok: true, work: committed, execution: entry.execution, deduplicated: Boolean(stored.deduplicated), identity: safeClone(this.identityFor(workId)) };
  }

  // ---- 派发授权 --------------------------------------------------------------
  /**
   * 成员为自己**当前 planRevision 匹配**的 work 建派发意图。
   * 调度器只启动 `state === 'authorized'` 的意图；没有意图的 work 永不自动启动。
   */
  async dispatchAuthorize(caller, spec = {}) {
    const writable = this.assertWritable();
    if (!writable.ok) return writable;
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    if (actor.role !== 'member' && actor.role !== 'lead') return denied('TEAM_MEMBER_REQUIRED', '只有模块成员能授权派发自己的 work。');
    const teamKey = this.resolveTeamKey(actor, spec.teamKey);
    const scope = this.assertModuleScope(actor, teamKey, actor.memberId);
    if (!scope.ok) return scope;
    const workIds = toStringArray(spec.workIds);
    if (workIds.length === 0) return denied('WORK_IDS_REQUIRED', '授权必须给出至少一个 workIds。');
    const planRevision = Number.isInteger(spec.planRevision) ? spec.planRevision : null;
    if (planRevision === null) return denied('PLAN_REVISION_REQUIRED', '授权必须给出 planRevision（防止旧授权启动已换版的 work）。');
    const at = this.clock.now();

    return this.mutex.run(async () => {
      const created = [];
      for (const workId of workIds) {
        const work = this.works.get(workId);
        if (!work) return denied('WORK_NOT_FOUND', `没有工作项 ${workId}。`);
        if (work.teamKey !== teamKey) return denied('DELEGATION_SCOPE', `${workId} 属于团队 ${work.teamKey}：不能跨团队派发。`);
        if (work.ownerMemberId !== actor.memberId) {
          return denied('DELEGATION_SCOPE', `${workId} 的 owner 是 ${work.ownerMemberId}：不能派发别人的 work。`);
        }
        if ((work.planRevision ?? 0) !== planRevision) {
          return denied('PLAN_REVISION_STALE', `${workId} 的 planRevision=${work.planRevision ?? 0}，授权请求的是 ${planRevision}：旧授权不得启动已换版的 work。`);
        }
        if ((work.execution ?? 'delegate') !== 'delegate') {
          return denied('EXECUTION_SELF', `${workId} 是 execution=self：成员自己执行，没有可授权的叶子派发。`);
        }
        if (work.state === 'cancelled' || work.state === 'accepted') {
          return denied('WORK_TERMINAL', `${workId} 已是 ${work.state}。`);
        }
        const existing = this.findAuthorizedIntent(workId, planRevision);
        if (existing) {
          created.push({ intent: existing, deduplicated: true });
          continue;
        }
        const intentId = typeof spec.intentId === 'string' && spec.intentId.trim() && workIds.length === 1
          ? spec.intentId.trim()
          : newId('intent');
        const prov = provenance({ actor, toolCallId: spec.toolCallId ?? null, missionId: work.missionId ?? null, workId, planRevision, dispatchIntentId: intentId, at });
        const intent = {
          intentId,
          teamKey,
          memberId: actor.memberId,
          workId,
          planRevision,
          missionId: work.missionId ?? null,
          state: 'authorized',
          authorizedAt: at,
          consumedByAttemptId: null,
          consumedAt: null,
          cancelledAt: null,
          note: typeof spec.note === 'string' ? spec.note : '',
          provenance: prov,
          provenanceLog: [ { ...prov, action: 'dispatch-authorize' } ],
        };
        const stored = await this.storage.put('dispatch_intents', intentId, intent, { idempotencyKey: `intent:${teamKey}:${workId}:r${planRevision}:${actor.memberId}` });
        if (!stored.ok && stored.code !== 'IDEMPOTENCY_CONFLICT') return denied(stored.code ?? 'PERSIST_FAILED', '派发意图写入失败', { detail: stored.message });
        const committed = stored.record ?? intent;
        this.dispatchIntents.set(intentId, committed);
        // work 状态推进到 **ready**（§12.4：调度器自行消费授权，调用方不需要 promote）。
        // `dispatch_authorized` 是"已授权"的等价语义标记，记录在字段上而不是停在这个状态里：
        // 依赖未满足的保持 blocked，由对账放行时才回到 ready。
        const nextWork = {
          ...work,
          state: work.blockedReason ? work.state : 'ready',
          dispatchIntentId: committed.intentId,
          dispatchAuthorizedAt: at,
          provenanceLog: appendProvenance(work.provenanceLog, { ...prov, action: 'work-dispatch-authorized' }),
        };
        const storedWork = await this.storage.put('works', workId, nextWork, { expectRev: work.rev });
        if (!storedWork.ok) {
          return denied(storedWork.code ?? 'PERSIST_FAILED', `work ${workId} 状态写入失败`, { detail: storedWork.message });
        }
        this.works.set(workId, storedWork.record);
        created.push({ intent: committed, deduplicated: Boolean(stored.deduplicated) });
      }
      this.diagnostics.push('service:dispatchAuthorize', `${actor.memberId} r${planRevision}：${created.map((item) => item.intent.workId).join(', ')}`);
      return { ok: true, planRevision, intents: created.map((item) => safeClone(item.intent)), note: '调度器只会启动这些 authorized 意图覆盖的 work。' };
    }).then(async (result) => {
      if (result.ok) {
        this.notify('dispatch-authorized', { teamKey, planRevision, workIds: result.intents.map((intent) => intent.workId) });
        for (const intent of result.intents) {
          const work = this.works.get(intent.workId);
          if (work) await this.emitWorkEvent(work, 'dependency_changed', { reason: 'dispatch_authorized' }).catch(() => {});
        }
      }
      return result;
    });
  }

  findAuthorizedIntent(workId, planRevision) {
    for (const intent of this.dispatchIntents.values()) {
      if (intent.workId !== workId) continue;
      if (intent.state !== 'authorized') continue;
      if (Number.isInteger(planRevision) && intent.planRevision !== planRevision) continue;
      return intent;
    }
    return undefined;
  }

  intentsForWork(workId) {
    return [...this.dispatchIntents.values()].filter((intent) => intent.workId === workId);
  }

  /**
   * 取该 work 当前可用的授权（供定向启动与后台补位共用）。
   *
   * 契约 §11：**授权只能来自 owner 自己**。
   *   - owner 自己提交（`submitWork` caller === owner）→ Host 自动记一条授权；
   *   - 别人替 owner 建 work → 没有授权，永远留在 needs_plan，等 owner 自己授权。
   */
  authorizedIntentFor(work) {
    if (!work) return undefined;
    const intent = this.findAuthorizedIntent(work.workId, work.planRevision);
    if (intent) {
      if (intent.missionId && work.missionId && intent.missionId !== work.missionId) return undefined;
      return intent;
    }
    // **已被本次 work 消费的意图仍算"这个 work 有授权"**：否则重复调用
    // `team_subagent_start` / 重启后的对账会得到 `DISPATCH_NOT_AUTHORIZED`，
    // 而不是幂等地返回既有 attempt（契约 §10 要求 reused=true，不是报错）。
    const consumed = this.intentsForWork(work.workId).filter((entry) => entry.state === 'consumed');
    if (consumed.length === 0) return undefined;
    if (Number.isInteger(work.planRevision) && consumed.every((entry) => entry.planRevision !== work.planRevision)) return undefined;
    if (work.missionId && consumed.every((entry) => entry.missionId && entry.missionId !== work.missionId)) return undefined;
    return consumed[consumed.length - 1];
  }

  /** 锁内：为 **owner 自己** 提交的 work 记一条来自 owner 的授权（§11）。 */
  async autoAuthorizeForOwnerInLock({ actor, work, at, via = 'submitWork' }) {
    const intentId = newId('intent');
    const planRevision = Number.isInteger(work.planRevision) ? work.planRevision : 0;
    const prov = provenance({
      actor,
      toolCallId: null,
      missionId: work.missionId ?? null,
      workId: work.workId,
      planRevision,
      dispatchIntentId: intentId,
      at,
      extra: { via, autoAuthorizedByOwner: true },
    });
    const intent = {
      intentId,
      teamKey: work.teamKey,
      memberId: work.ownerMemberId,
      workId: work.workId,
      planRevision,
      missionId: work.missionId ?? null,
      state: 'authorized',
      auto: true,
      authorizedBy: prov.actorSessionId,
      authorizingRole: actor.role,
      via,
      authorizedAt: at,
      consumedByAttemptId: null,
      consumedAt: null,
      cancelledAt: null,
      note: 'owner 自己提交即视为授权（§11）；不是 Host 替成员做的语义决策。',
      provenance: prov,
      provenanceLog: [{ ...prov, action: 'dispatch-authorize:auto-owner' }],
    };
    const storedIntent = await this.storage.put('dispatch_intents', intentId, intent, {
      idempotencyKey: `intent-auto:${work.teamKey}:${work.workId}:r${planRevision}:${work.ownerMemberId}`,
    });
    if (!storedIntent.ok && storedIntent.code !== 'IDEMPOTENCY_CONFLICT') {
      this.diagnostics.push('service:auto-authorize:not-persisted', `${work.workId}: ${storedIntent.code} ${storedIntent.message}`);
      return { ok: false };
    }
    const committed = storedIntent.record ?? intent;
    this.dispatchIntents.set(intentId, committed);
    const current = this.works.get(work.workId);
    const next = {
      ...current,
      dispatchIntentId: committed.intentId,
      autoAuthorized: true,
      state: current.blockedReason ? current.state : 'ready',
      provenanceLog: appendProvenance(current.provenanceLog, { ...prov, action: 'work-auto-authorized-by-owner' }),
    };
    const storedWork = await this.storage.put('works', work.workId, next, { expectRev: current.rev });
    if (storedWork.ok) this.works.set(work.workId, storedWork.record);
    this.diagnostics.push('service:auto-authorize', `${work.workId}：owner ${work.ownerMemberId} 自己提交，已记一条来自 owner 的授权（${via}）。`);
    return { ok: true, intent: committed };
  }

  /** 锁内：work 由**别人**替 owner 建出来 → 入队事件但不授权（§11）。 */
  enqueueOwnerDirectiveInLock({ work, at }) {
    const queued = this.enqueueMemberEventInLock({
      teamKey: work.teamKey,
      memberId: work.ownerMemberId,
      type: 'dependency_changed',
      payload: {
        workId: work.workId,
        missionId: work.missionId ?? null,
        reason: 'work_submitted_by_other',
        title: work.title,
        note: '这条 work 不是你自己提交的：需要你自己决定计划，并用 team_dispatch_authorize 授权后才允许派发。',
      },
      origin: null,
      dedupe: `owner-directive:${work.workId}`,
    });
    return queued;
  }

  /** 取消**未来**派发：已授权的意图作废，正在跑的 attempt 不受影响。 */
  async planCancel(caller, spec = {}) {
    const writable = this.assertWritable();
    if (!writable.ok) return writable;
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    if (actor.role !== 'member' && actor.role !== 'lead') return denied('TEAM_MEMBER_REQUIRED', '只有模块成员能取消自己的未来派发。');
    const teamKey = this.resolveTeamKey(actor, spec.teamKey);
    const scope = this.assertModuleScope(actor, teamKey, actor.memberId);
    if (!scope.ok) return scope;
    const workIds = toStringArray(spec.workIds);
    const intentIds = toStringArray(spec.intentIds);
    if (workIds.length === 0 && intentIds.length === 0) return denied('CANCEL_TARGET_REQUIRED', '取消必须给出 workIds 或 intentIds。');
    const reason = typeof spec.reason === 'string' && spec.reason.trim() ? spec.reason.trim() : 'owner-cancelled';
    const at = this.clock.now();

    return this.mutex.run(async () => {
      const cancelled = [];
      const targets = [];
      for (const intentId of intentIds) {
        const intent = this.dispatchIntents.get(intentId);
        if (!intent) return denied('INTENT_NOT_FOUND', `没有派发意图 ${intentId}。`);
        if (intent.teamKey !== teamKey || intent.memberId !== actor.memberId) {
          return denied('DELEGATION_SCOPE', `${intentId} 不属于 ${actor.memberId}：不能取消别人的派发。`);
        }
        targets.push(intent);
      }
      for (const workId of workIds) {
        const work = this.works.get(workId);
        if (!work) return denied('WORK_NOT_FOUND', `没有工作项 ${workId}。`);
        if (work.teamKey !== teamKey || work.ownerMemberId !== actor.memberId) {
          return denied('DELEGATION_SCOPE', `${workId} 不属于 ${actor.memberId}：不能取消别人的工作项。`);
        }
        for (const intent of this.intentsForWork(workId)) if (intent.state === 'authorized') targets.push(intent);
        work.cancelRequested = true;
      }
      const prov = provenance({ actor, toolCallId: spec.toolCallId ?? null, planRevision: null, at, extra: { reason } });
      for (const intent of targets) {
        const current = this.dispatchIntents.get(intent.intentId);
        if (current.state !== 'authorized') continue;
        const next = {
          ...current,
          state: 'cancelled',
          cancelledAt: at,
          cancelReason: reason,
          provenanceLog: appendProvenance(current.provenanceLog, { ...prov, action: 'dispatch-cancel', dispatchIntentId: current.intentId, workId: current.workId }),
        };
        const stored = await this.storage.put('dispatch_intents', current.intentId, next, { expectRev: current.rev });
        if (stored.ok) {
          this.dispatchIntents.set(current.intentId, stored.record);
          cancelled.push(safeClone(stored.record));
        } else {
          this.diagnostics.push('service:planCancel:not-persisted', `${current.intentId}: ${stored.code} ${stored.message}`);
          return denied(stored.code ?? 'PERSIST_FAILED', '派发意图取消失败', { detail: stored.message });
        }
      }
      // 未启动的 work 回到 cancelled；正在跑的 attempt 不动（不杀在跑的执行）。
      for (const workId of workIds) {
        const work = this.works.get(workId);
        if (!work) continue;
        if (work.activeAttemptId) {
          this.diagnostics.push('service:planCancel:active-untouched', `${workId} 有活跃 attempt：只取消未来派发，不杀在跑的执行。`);
          continue;
        }
        const next = { ...work, state: 'cancelled', cancelReason: reason, cancelledAt: at, cancelledBy: actor.memberId };
        const stored = await this.storage.put('works', workId, next, { expectRev: work.rev });
        if (stored.ok) this.works.set(workId, stored.record);
      }
      this.diagnostics.push('service:planCancel', `${actor.memberId}: 取消 ${cancelled.length} 个意图（${reason}）`);
      return { ok: true, cancelledIntents: cancelled, reason };
    });
  }

  // ---- owner 验收 ------------------------------------------------------------
  /**
   * owner 核验：`produced ≠ accepted`。只有 owner 自己（或 lead）能验收；
   * 模型传来的 `verifiedBy` 一律丢弃，由 Host 从真实调用上下文写。
   */
  async workVerify(caller, request = {}) {
    const writable = this.assertWritable();
    if (!writable.ok) return writable;
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    if (actor.role !== 'member' && actor.role !== 'lead') return denied('TEAM_MEMBER_REQUIRED', '只有 owner member（或 lead）能验收。');
    const workId = String(request.workId ?? '');
    const work = this.works.get(workId);
    if (!work) return denied('WORK_NOT_FOUND', `没有工作项 ${workId}。`);
    if (actor.role === 'member' && work.ownerMemberId !== actor.memberId) {
      return denied('DELEGATION_SCOPE', `${workId} 的 owner 是 ${work.ownerMemberId}：不能验收别人的模块。`);
    }
    if (!this.isSameTeam(actor, work.teamKey)) return denied('DELEGATION_SCOPE', `不属于团队 ${work.teamKey}。`);
    const outcome = request.outcome === 'accepted' ? 'accepted' : request.outcome === 'rejected' ? 'rejected' : null;
    if (!outcome) return denied('VERIFY_OUTCOME_REQUIRED', 'outcome 必须是 accepted 或 rejected。');
    if (work.state === 'executing' || work.state === 'self_running') {
      return denied('WORK_NOT_PRODUCED', `${workId} 仍在执行：没有可核验的产物。`);
    }
    if (work.state !== 'produced' && work.state !== 'awaiting_verification' && work.state !== 'verifying' && work.completion?.level === 'none' && (work.artifactRefs ?? []).length === 0) {
      return denied('WORK_NOT_PRODUCED', `${workId} 还没有产物回执（state=${work.state}）：不能凭空验收。`);
    }
    const evidence = Array.isArray(request.evidence) ? request.evidence : [];
    const at = this.clock.now();
    const requireEvidence = this.config?.evidence?.requireForAccept !== false;

    // 契约 §3 / 验收 §5.6：accepted 必须引用**后台实际执行记录 + 产物/依赖版本**。
    // 空证据、裸 ok:true、命令字符串、路径字符串一律拒绝（在这里就拒，不进锁、不改状态）。
    let validation = null;
    if (requireEvidence) {
      validation = await this.validateWorkEvidence({ work, evidence });
      if (outcome === 'accepted' && validation.ok !== true) {
        this.diagnostics.push('service:workVerify:evidence-rejected', `${workId}: ${validation.codes.join(',')}`, { codes: validation.codes, missing: validation.missing });
        return denied(
          'EVIDENCE_INSUFFICIENT',
          `验收证据不足，不能 accepted：${validation.codes.join('、') || '缺少可复核证据'}。`,
          {
            workId,
            codes: validation.codes,
            missing: validation.missing,
            hints: validation.hints,
            items: validation.items.map((item) => ({ index: item.index, kind: item.kind, valid: item.valid, source: item.source, reason: item.reason })),
            hint: validation.hints[0] ?? '证据必须映射到 Host 执行记录（attemptId）或真实文件读取（file+command，文件存在且非空），并覆盖每一条验收条件。',
            note: '缺少证据不会清空 completion.missing：`accepted` 只在证据通过后才成立（produced ≠ accepted）。',
          },
        );
      }
    }

    return this.mutex.run(async () => {
      const current = this.works.get(workId);
      const prov = provenance({ actor, toolCallId: request.toolCallId ?? null, missionId: current.missionId ?? null, workId, planRevision: current.planRevision ?? null, at });
      const accepted = outcome === 'accepted';
      const verification = {
        outcome,
        note: typeof request.note === 'string' ? request.note : '',
        evidence,
        at,
        verifiedBy: actor.memberId,
        provenance: prov,
        // 契约 §3：accepted 的证据必须是被 Host 校验过的；保留校验摘要便于事后追溯。
        evidenceValidated: accepted ? validation?.ok === true : false,
        evidenceDigest: validation?.digest ?? null,
        evidenceCodes: validation?.codes ?? [],
      };
      const completion = accepted
        ? completionFromValidation({ work: current, validation, accepted: true, at, verifiedBy: actor.memberId })
        : completionFromValidation({ work: current, validation, accepted: false, at, verifiedBy: actor.memberId });
      const next = {
        ...current,
        verification,
        verifiedBy: actor.memberId,
        verifiedAt: at,
        evidenceValid: accepted ? true : current.evidenceValid,
        evidenceInvalidatedAt: accepted ? null : current.evidenceInvalidatedAt,
        state: accepted ? 'accepted' : 'produced',
        rejectionReason: outcome === 'rejected' ? (verification.note || 'owner-rejected') : null,
        completion,
        provenanceLog: appendProvenance(current.provenanceLog, { ...prov, action: `work-verify:${outcome}` }),
      };
      const stored = await this.storage.put('works', workId, next, {
        expectRev: current.rev,
        idempotencyKey: `verify:${workId}:${outcome}:${actor.memberId}:${sha256Hex(stableStringify({ note: verification.note, evidence }))}`,
      });
      if (!stored.ok && stored.code !== 'IDEMPOTENCY_CONFLICT') return denied(stored.code ?? 'PERSIST_FAILED', '验收写入失败', { detail: stored.message });
      this.works.set(workId, stored.record ?? next);
      if (validation) await this.persistEvidenceInLock({ work: this.works.get(workId), validation, attemptId: current.lastAttemptId ?? current.activeAttemptId ?? null, verifiedBy: actor.memberId });
      this.diagnostics.push('service:workVerify', `${workId} → ${outcome} by ${actor.memberId}${accepted ? `（证据 ${validation?.verificationCount ?? 0} 条验证 / ${validation?.acceptanceCount ?? 0} 条验收）` : ''}`);
      this.notify('work-verified', { workId, outcome, verifiedBy: actor.memberId });
      return {
        ok: true,
        work: safeClone(this.works.get(workId)),
        verification: safeClone(verification),
        evidence: validation
          ? { ok: validation.ok, codes: validation.codes, missing: validation.missing, verificationCount: validation.verificationCount, acceptanceCount: validation.acceptanceCount, digest: validation.digest }
          : null,
        deduplicated: Boolean(stored.deduplicated),
      };
    }).then(async (result) => {
      if (result.ok) {
        // 验收变更会放行依赖它的下游（或要求重新规划）。
        await this.notifyDependents(workId, result.work).catch(() => {});
        for (const intent of this.intentsForWork(workId)) {
          if (intent.state === 'consumed') continue;
          const work = this.works.get(workId);
          if (work) await this.emitWorkEvent(work, 'replan_required', { reason: `work ${workId} verified ${result.verification.outcome}` }).catch(() => {});
        }
      }
      return result;
    });
  }

  /** 依赖变化 → 向受影响的 owner 入队 `dependency_changed`，不放行未满足依赖的下游。 */
  async notifyDependents(workId, work) {
    const dependents = [...this.works.values()].filter((candidate) => (candidate.blockedBy ?? []).includes(workId));
    for (const dependent of dependents) {
      const satisfied = (dependent.blockedBy ?? []).every((id) => this.isDependencySatisfied(id, dependent.artifactDependencies));
      if (satisfied) await this.enqueueMemberEvent({
        teamKey: dependent.teamKey,
        memberId: dependent.ownerMemberId,
        type: 'dependency_changed',
        payload: { workId: dependent.workId, dependencyId: workId, state: work?.state ?? null },
        origin: null,
      });
    }
    return dependents.length;
  }

  // ---- 成员收件箱 ------------------------------------------------------------
  /** 成员读取自己的待处理事件；读到的部分推进消费游标（持久化）。 */
  async memberInbox(caller, request = {}) {
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    if (actor.role !== 'member' && actor.role !== 'lead') return denied('TEAM_MEMBER_REQUIRED', '只有 Team member 能读取成员收件箱。');
    const teamKey = this.resolveTeamKey(actor, request.teamKey);
    const scope = this.assertModuleScope(actor, teamKey, actor.memberId);
    if (!scope.ok) return scope;
    const limitRaw = Number(request.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 50) : 20;
    const pending = this.pendingEvents(teamKey, actor.memberId);
    const batch = pending.slice(0, limit);
    const remaining = pending.length - batch.length;
    const at = this.clock.now();

    return this.mutex.run(async () => {
      const cursor = this.cursorOf(teamKey, actor.memberId);
      let consumedSeq = cursor.consumedSeq ?? 0;
      const consumed = [];
      for (const event of batch) {
        const current = this.memberEvents.get(event.eventId);
        if (!current || current.state !== 'pending') continue;
        const next = { ...current, state: 'consumed', consumedAt: at, consumedBy: actor.memberId };
        const stored = await this.storage.put('member_events', current.eventId, next, { expectRev: current.rev });
        if (stored.ok) {
          this.memberEvents.set(current.eventId, stored.record);
          consumed.push(safeClone(stored.record));
          consumedSeq = Math.max(consumedSeq, current.seq ?? 0);
        } else {
          this.diagnostics.push('service:memberInbox:not-persisted', `${current.eventId}: ${stored.code} ${stored.message}`);
        }
      }
      if (consumed.length > 0) {
        const nextCursor = { ...cursor, cursorKey: this.memberCursorKey(teamKey, actor.memberId), consumedSeq, lastConsumedAt: at, updatedAt: at };
        const stored = await this.storage.put('member_cursors', nextCursor.cursorKey, nextCursor, { expectRev: cursor.rev });
        if (stored.ok) this.memberCursors.set(nextCursor.cursorKey, stored.record);
        else this.diagnostics.push('service:memberInbox:cursor-not-persisted', `${nextCursor.cursorKey}: ${stored.code} ${stored.message}`);
      }
      // 成员确实消费了输入 → 在飞回合可以结束（这是"真实消费"的 Host 侧证据）。
      if (consumed.length > 0) this.clearMemberTurn(teamKey, actor.memberId, 'inbox-consumed');
      const pendingAfter = this.pendingEvents(teamKey, actor.memberId).length;
      this.diagnostics.push('service:memberInbox', `${teamKey}/${actor.memberId}: 消费 ${consumed.length} 条，剩余 ${pendingAfter}`);
      return {
        ok: true,
        memberId: actor.memberId,
        sessionId: this.members.get(this.memberKey(teamKey, actor.memberId))?.sessionId ?? null,
        events: consumed,
        consumed: consumed.length,
        pending: pendingAfter,
        hasMore: remaining > 0,
        cursor: consumedSeq,
        note: remaining > 0 ? `还有 ${remaining} 条未读：继续调用 team_member_inbox。` : '收件箱已清空。',
      };
    });
  }

  // ---- leaf 限域求助 ---------------------------------------------------------
  /**
   * leaf → **自己的 owner** 的限域求助/回报（契约 §3 `team_ask_owner`，修缺陷 C）。
   *
   * 身份与范围检查都在 Host 上：
   *   - 调用者必须是该 work 某个 attempt 的 `executorChildId`（leaf 自己的真实身份）；
   *   - leaf **只能**投向该 attempt 的 owner member，不能指向任意成员；
   *   - 事件入队并唤醒 owner；不放开全量 `team_message`。
   */
  async askOwner(caller, request = {}) {
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    const workId = typeof request.workId === 'string' && request.workId.trim() ? request.workId.trim() : null;
    const callerSessionId = actor.agent ? String(actor.agent.id) : null;
    const attempt = this.findExecutorAttempt(callerSessionId, workId);
    if (!attempt) {
      return denied('LEAF_IDENTITY_REQUIRED', 'team_ask_owner 只能由正在执行该 work 的 leaf 调用（按真实 child session 身份匹配 attempt）。', {
        workId,
        callerSessionId,
      });
    }
    const work = this.works.get(attempt.workId);
    if (!work) return denied('WORK_NOT_FOUND', `attempt ${attempt.attemptId} 指向的 work 不存在。`);
    const ownerKey = this.memberKey(work.teamKey, work.ownerMemberId);
    if (!this.members.has(ownerKey)) {
      return denied('OWNER_MEMBER_MISSING', `owner 成员 ${work.ownerMemberId} 不存在：求助无法投递（不编造成员身份）。`);
    }
    const question = typeof request.question === 'string' ? request.question.trim() : '';
    const report = typeof request.report === 'string' ? request.report.trim() : '';
    if (!question && !report) return denied('ASK_PAYLOAD_REQUIRED', '必须给出 question 或 report（要什么、缺什么、建议怎么解）。');
    const needsInput = request.needsInput === true;
    const at = this.clock.now();
    const prov = provenance({
      actor,
      toolCallId: request.toolCallId ?? null,
      missionId: work.missionId ?? null,
      workId: work.workId,
      planRevision: work.planRevision ?? null,
      attemptId: attempt.attemptId,
      leaseEpoch: attempt.leaseEpoch,
      childSessionId: callerSessionId,
      parentSessionId: attempt.parentSessionId,
      at,
    });
    const queued = await this.enqueueMemberEvent({
      teamKey: work.teamKey,
      memberId: work.ownerMemberId,
      type: 'leaf_need',
      payload: {
        workId: work.workId,
        attemptId: attempt.attemptId,
        fromChildSessionId: callerSessionId,
        needsInput,
        question: question || null,
        report: report || null,
      },
      origin: prov,
      toolCallId: prov.toolCallId,
    });
    if (!queued.ok) return queued;
    await this.persistMemberEvent(this.memberEvents.get(queued.event.eventId), this.cursorOf(work.teamKey, work.ownerMemberId));
    this.diagnostics.push('service:askOwner', `${callerSessionId} → owner ${work.ownerMemberId}（${needsInput ? 'needs input' : 'report'}，work ${work.workId}）`);
    return {
      ok: true,
      ownerMemberId: work.ownerMemberId,
      workId: work.workId,
      attemptId: attempt.attemptId,
      eventId: queued.event.eventId,
      queued: true,
      wake: queued.wake,
      note: 'owner 已入队并被唤醒；只有 owner 能处理跨模块输入，leaf 不直接改别人任务。',
    };
  }

  /** 按真实 child session 身份定位 leaf 的 attempt。 */
  findExecutorAttempt(callerSessionId, workId) {
    if (!callerSessionId) return undefined;
    const candidates = [...this.attempts.values()].filter(
      (attempt) => String(attempt.executorChildId) === String(callerSessionId) && (workId === null || attempt.workId === workId),
    );
    if (candidates.length === 0) return undefined;
    candidates.sort((left, right) => (right.startedAt ?? right.reservedAt ?? 0) - (left.startedAt ?? left.reservedAt ?? 0));
    return candidates[0];
  }

  // ---- 用户指令 / 暂停（契约 §6、§8） ----------------------------------------
  /**
   * 用户直接给某个成员下指令：入队 `user_instruction` 并**唤醒该成员自己的回合**。
   * 不转交 leader 串行代办。调用者必须是该成员本人会话、该团队 lead、或普通根会话（用户入口）。
   */
  async userInstruction(caller, request = {}) {
    const writable = this.assertWritable();
    if (!writable.ok) return writable;
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    const text = typeof request.text === 'string' ? request.text.trim() : '';
    if (!text) return denied('EMPTY_TEXT', '用户指令必须给出非空 text。');
    const targetSessionId = typeof request.targetSessionId === 'string' && request.targetSessionId.trim() ? request.targetSessionId.trim() : null;
    let member;
    if (targetSessionId) member = [...this.members.values()].find((entry) => String(entry.sessionId) === targetSessionId);
    if (!member && typeof request.sessionId === 'string' && request.sessionId.trim()) {
      member = [...this.members.values()].find((entry) => String(entry.sessionId) === request.sessionId.trim());
    }
    if (!member && actor.role === 'member') member = this.members.get(this.memberKey(actor.teamKey, actor.memberId));
    if (!member && typeof request.memberId === 'string') member = this.members.get(this.memberKey(this.resolveTeamKey(actor, request.teamKey), request.memberId));
    if (!member) return denied('MEMBER_NOT_FOUND', '找不到目标成员：用户指令必须投给某个真实成员会话（不转交 leader 代办）。', { targetSessionId });
    // 归属检查：成员只能给自己下指令；lead 只能给本团队成员；普通根会话（用户入口）允许。
    if (actor.role === 'member' && member.memberId !== actor.memberId) {
      return denied('DELEGATION_SCOPE', 'member 不能替别的成员下指令。');
    }
    if (actor.role === 'lead' && !this.isSameTeam(actor, member.teamKey)) {
      return denied('DELEGATION_SCOPE', `lead 不能给不属于自己团队 ${member.teamKey} 的成员下指令。`);
    }
    const at = this.clock.now();
    const prov = provenance({ actor, toolCallId: request.toolCallId ?? null, missionId: request.missionId ?? null, at });
    const queued = await this.enqueueMemberEvent({
      teamKey: member.teamKey,
      memberId: member.memberId,
      type: 'user_instruction',
      payload: { text, fromSessionId: prov.actorSessionId, fromRole: actor.role, missionId: request.missionId ?? null },
      origin: prov,
      toolCallId: prov.toolCallId,
      dedupe: `user:${sha256Hex(text).slice(0, 16)}`,
    });
    if (!queued.ok) return queued;
    await this.persistMemberEvent(this.memberEvents.get(queued.event.eventId), this.cursorOf(member.teamKey, member.memberId));
    this.diagnostics.push('service:userInstruction', `→ ${member.teamKey}/${member.memberId}（${text.slice(0, 80)}）`);
    return {
      ok: true,
      eventId: queued.event.eventId,
      memberId: member.memberId,
      sessionId: member.sessionId,
      teamKey: member.teamKey,
      queued: true,
      deduplicated: Boolean(queued.deduplicated),
      wake: queued.wake,
      note: '指令已入队到该成员并尝试唤醒它自己的模型回合；不经过 leader。',
    };
  }

  /**
   * 显式暂停/恢复某个成员或整队的**未来派发**。
   * 用户 `pause` 的标记不会被自动恢复抵消：`wakeMember` 会拒绝自动唤醒被暂停的成员。
   */
  async pauseDispatch(caller, request = {}) {
    const writable = this.assertWritable();
    if (!writable.ok) return writable;
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    const paused = request.paused !== false && request.action !== 'resume';
    const scope = request.scope === 'team' ? 'team' : 'member';
    const by = request.by === 'user' ? 'user' : (actor.role === 'lead' ? 'lead' : 'owner');
    const teamKey = this.resolveTeamKey(actor, request.teamKey);
    if (!teamKey) return denied('TEAM_KEY_REQUIRED', '暂停必须落在某个团队上。');
    if (actor.role === 'member' && !this.isSameTeam(actor, teamKey)) return denied('DELEGATION_SCOPE', '跨团队暂停一律拒绝。');
    const targets = [];
    if (scope === 'team') {
      if (actor.role !== 'lead' && actor.role !== 'root') return denied('TEAM_LEAD_REQUIRED', '只有 lead 或用户入口能暂停整队派发。');
      for (const member of this.members.values()) if (member.teamKey === teamKey) targets.push(member);
    } else {
      const requestedSessionId = typeof request.sessionId === 'string' && request.sessionId.trim() ? request.sessionId.trim() : null;
      const memberId = typeof request.memberId === 'string' && request.memberId.trim()
        ? request.memberId.trim()
        : (requestedSessionId ? [...this.members.values()].find((entry) => String(entry.sessionId) === requestedSessionId)?.memberId : actor.memberId);
      const member = this.members.get(this.memberKey(teamKey, memberId ?? ''));
      if (!member) return denied('MEMBER_NOT_FOUND', `团队 ${teamKey} 没有成员 ${memberId ?? request.sessionId ?? '(unknown)'}。`);
      if (actor.role === 'member' && member.memberId !== actor.memberId) return denied('DELEGATION_SCOPE', 'member 只能暂停自己的派发。');
      targets.push(member);
    }
    const at = this.clock.now();
    return this.mutex.run(async () => {
      const updated = [];
      for (const member of targets) {
        const key = this.memberKey(member.teamKey, member.memberId);
        const current = this.members.get(key);
        const next = {
          ...current,
          pausedBy: paused ? by : null,
          pausedAt: paused ? at : null,
          pauseScope: paused ? scope : null,
        };
        const stored = await this.storage.put('members', key, next, { expectRev: current.rev });
        if (stored.ok) {
          this.members.set(key, stored.record);
          updated.push({ memberId: member.memberId, pausedBy: stored.record.pausedBy ?? null });
        } else {
          this.diagnostics.push('service:pauseDispatch:not-persisted', `${key}: ${stored.code} ${stored.message}`);
        }
      }
      this.diagnostics.push('service:pauseDispatch', `${paused ? '暂停' : '恢复'} ${scope}（by=${by}）：${updated.map((item) => item.memberId).join(', ')}`);
      return { ok: true, paused, scope, by, members: updated, note: paused ? '已标记用户暂停：派发不会启动，也不会被自动唤醒抵消。' : '已解除暂停。' };
    }).then(async (result) => {
      // 解除暂停时**主动补一次唤醒**：暂停期间累积的 pending 事件需要一个真实回合去消费，
      // 否则它们会一直躺在队列里（暂停本身不生成空回合，见 §6）。
      const wakes = [];
      if (result.ok && result.paused === false) {
        for (const entry of result.members) {
          const pending = this.pendingEvents(teamKey, entry.memberId);
          if (pending.length === 0) continue;
          wakes.push({ memberId: entry.memberId, ...(await this.wakeMember({ teamKey, memberId: entry.memberId, reason: 'resume_dispatch' })) });
        }
      }
      return { ...result, wakes };
    });
  }


  /**
   * 只停**该成员当前回合**：不清队列、不取消已授权工作、不影响其它成员。
   * 与 `interruptTeam(scope='turn')` 的区别是它作用于**指定成员**（用户入口）。
   */
  async stopMemberTurn(caller, request = {}) {
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    const teamKey = this.resolveTeamKey(actor, request.teamKey);
    if (!teamKey) return denied('TEAM_KEY_REQUIRED', '停止回合必须落在某个团队上。');
    const requestedSessionId = typeof request.sessionId === 'string' && request.sessionId.trim()
      ? request.sessionId.trim()
      : (typeof request.targetSessionId === 'string' && request.targetSessionId.trim() ? request.targetSessionId.trim() : null);
    const member = requestedSessionId
      ? [...this.members.values()].find((entry) => String(entry.sessionId) === requestedSessionId)
      : this.members.get(this.memberKey(teamKey, typeof request.memberId === 'string' ? request.memberId : actor.memberId));
    if (!member) return denied('MEMBER_NOT_FOUND', `找不到目标成员（${requestedSessionId ?? request.memberId ?? '(unknown)'}）。`);
    if (actor.role === 'member' && member.memberId !== actor.memberId) return denied('DELEGATION_SCOPE', 'member 不能停别的成员的回合。');
    if (actor.role === 'lead' && !this.isSameTeam(actor, member.teamKey)) return denied('DELEGATION_SCOPE', 'lead 不能停其它团队成员。');
    if (actor.role === 'root' && !requestedSessionId) return denied('MEMBER_NOT_FOUND', '用户入口必须给出 sessionId。');

    const leadActor = await this.ensureTeamLeadAgent(member.teamKey);
    let interrupted = false;
    if (leadActor.ok) {
      const result = await this.adapter.interruptMember(leadActor.agent, member.memberId);
      interrupted = result.ok;
      if (!result.ok) this.diagnostics.push('service:stopMemberTurn:native-failed', `${member.memberId}: ${result.code} ${result.message}`);
    } else {
      this.diagnostics.push('service:stopMemberTurn:no-lead', `${member.memberId}: ${leadActor.code} ${leadActor.message}`);
    }
    this.clearMemberTurn(member.teamKey, member.memberId, 'user-stop-turn');
    this.diagnostics.push('service:stopMemberTurn', `${member.memberId}（session ${member.sessionId}）：只停当前回合，队列与已授权工作不受影响。`);
    return {
      ok: true,
      memberId: member.memberId,
      sessionId: member.sessionId,
      interrupted,
      pauseMarkerCleared: false,
      note: '只停止该成员当前模型回合：pending 事件、已授权派发与其它成员继续。',
    };
  }


  // ---- 事件辅助 --------------------------------------------------------------
  /** 给 work 的 owner 入队一条事件（work 级变化 → 成员回合）。 */
  async emitWorkEvent(work, type, payload = {}) {
    if (!work || !work.teamKey || !work.ownerMemberId) return { ok: false, code: 'WORK_OWNER_UNKNOWN' };
    const queued = await this.enqueueMemberEvent({
      teamKey: work.teamKey,
      memberId: work.ownerMemberId,
      type,
      payload: { workId: work.workId, missionId: work.missionId ?? null, ...payload },
      origin: null,
    });
    if (queued.ok && !queued.deduplicated) {
      await this.persistMemberEvent(this.memberEvents.get(queued.event.eventId), this.cursorOf(work.teamKey, work.ownerMemberId));
    }
    return queued;
  }

  memberAutonomyView() {
    const byMember = {};
    for (const member of this.members.values()) {
      const memberKey = this.memberKey(member.teamKey, member.memberId);
      const works = [...this.works.values()].filter((work) => work.teamKey === member.teamKey && work.ownerMemberId === member.memberId);
      const worksById = new Map(works.map((work) => [work.workId, work]));
      const mission = [...this.missions.values()].filter((entry) => entry.teamKey === member.teamKey && entry.memberId === member.memberId).sort((a, b) => (b.assignedAt ?? 0) - (a.assignedAt ?? 0))[0] ?? null;
      const intents = [...this.dispatchIntents.values()].filter((intent) => intent.teamKey === member.teamKey && intent.memberId === member.memberId);
      const attempts = [...this.attempts.values()].filter((attempt) => attempt.teamKey === member.teamKey && attempt.ownerMemberId === member.memberId);
      const pending = this.pendingEvents(member.teamKey, member.memberId);
      const turn = this.memberTurnState(member.teamKey, member.memberId);
      const byType = {};
      for (const event of pending) byType[event.type] = (byType[event.type] ?? 0) + 1;
      const scoped = mission ? works.filter((work) => work.missionId === mission.missionId) : works;
      const primary = [...scoped].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0] ?? null;
      const sessionId = member.sessionId ?? null;
      if (!sessionId) continue;
      byMember[sessionId] = {
        memberId: member.memberId,
        sessionId,
        teamKey: member.teamKey,
        role: member.role,
        responsibility: member.responsibility ?? null,
        pausedBy: member.pausedBy ?? null,
        mission: mission
          ? { missionId: mission.missionId, title: mission.title, goal: mission.goal, state: mission.state, boundaries: mission.boundaries ?? [], acceptance: mission.acceptance ?? [], planRevision: mission.planRevision ?? 0 }
          : null,
        missionIds: [...new Set(works.map((work) => work.missionId).filter(Boolean))],
        plan: mission?.plan
          ? {
            planRevision: mission.planRevision ?? 0,
            submittedAt: mission.plan?.submittedAt ?? null,
            note: mission.plan?.note ?? '',
            deliverables: scoped.map((work) => ({
              workId: work.workId,
              title: work.title,
              kind: work.kind,
              execution: work.execution ?? 'delegate',
              state: work.state,
              outputs: work.outputs ?? [],
              acceptance: work.acceptance ?? [],
              writeScopes: work.writeScopes ?? [],
              dependencies: work.artifactDependencies ?? [],
              brief: work.brief ?? null,
            })),
          }
          : null,
        dispatchIntents: intents.map((intent) => ({
          intentId: intent.intentId,
          workId: intent.workId,
          state: intent.state,
          planRevision: intent.planRevision,
          consumedByAttemptId: intent.consumedByAttemptId ?? null,
          at: intent.authorizedAt ?? null,
        })),
        attempts: attempts.map((attempt) => ({ attemptId: attempt.attemptId, workId: attempt.workId, state: attempt.state, startedAt: attempt.startedAt ?? null, leaseEpoch: attempt.leaseEpoch ?? null, childSessionId: attempt.executorChildId ?? null })),
        receipts: works
          .filter((work) => work.producedBy || work.verification || (work.artifactRefs ?? []).length > 0)
          .map((work) => ({
            workId: work.workId,
            attemptId: work.lastAttemptId ?? work.activeAttemptId ?? null,
            outcome: work.verification?.outcome ?? (work.state === 'accepted' ? 'accepted' : 'produced'),
            at: work.verifiedAt ?? work.updatedAt ?? null,
            verification: work.verification?.outcome === 'accepted' ? 'accepted' : work.verification?.outcome === 'rejected' ? 'rejected' : 'pending',
            verifiedAt: work.verifiedAt ?? null,
          })),
        decision: {
          kind: pending.length > 0 ? decisionAfter(pending[0]) : turn.inFlight ? 'self_running' : 'idle',
          at: pending.length > 0 ? pending[0].at : turn.lastWakeAt ?? null,
          source: pending.length > 0 ? pending[0].type : turn.inFlight ? 'agent-turn-running' : 'no-pending-event',
        },
        waitReason: waitReasonOf(primary, member) ?? (pending.length > 0 ? { kind: 'member_inbox', detail: `还有 ${pending.length} 条待处理事件。`, since: pending[0].at } : null),
        recentProgress: turn.wakeLog.slice(-5).map((entry) => ({ at: entry.at, text: `已唤醒：${wakeReasonOf({ type: entry.reason })}（pending=${entry.pending}，${entry.code}）` })),
        subtasks: works.map((work) => ({ workId: work.workId, title: work.title, state: work.state, attemptId: work.activeAttemptId ?? null, intentId: work.dispatchIntentId ?? null })),
        inbox: { pending: pending.length, oldestAt: pending.length > 0 ? pending[0].at : null, byType },
        turn: { inFlight: Boolean(turn.inFlight), wakeCount: turn.wakeCount ?? 0, lastWakeAt: turn.lastWakeAt ?? null, lastWakeReason: turn.lastWakeReason ?? null, lastWakeCode: turn.lastWakeCode ?? null },
      };
    }
    const unassigned = [...this.members.values()].filter((member) => !byMember[member.sessionId ?? '']).length;
    return {
      byMember,
      note: unassigned > 0 ? `${unassigned} 个成员记录没有 sessionId（provisioning/failed）：面板按"未提供"显示，不编造。` : null,
      counts: {
        missions: this.missions.size,
        dispatchIntents: this.dispatchIntents.size,
        authorizedIntents: [...this.dispatchIntents.values()].filter((intent) => intent.state === 'authorized').length,
        memberEvents: this.memberEvents.size,
        pendingEvents: [...this.memberEvents.values()].filter((event) => event.state === 'pending').length,
        memberTurnsInFlight: [...this.memberTurns.values()].filter((state) => state.inFlight).length,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // 2026-10-17 整改（契约 v1）：稳定身份 / 证据式完成 / 错误指纹 / 费用 / 物化 / 上下文
  // ---------------------------------------------------------------------------

  /** 该 work 的身份记录（没有则按当前 shape 现算，不改状态）。 */
  identityFor(workId) {
    const stored = this.identityRecords.get(String(workId));
    if (stored) return stored;
    const work = this.works.get(String(workId));
    if (!work) return null;
    return identityRecordFor({
      workId: work.workId,
      ownerMemberId: work.ownerMemberId,
      teamKey: work.teamKey,
      outputs: work.outputs,
      inputs: work.inputs,
      acceptance: work.acceptance,
    }, judgeIdentity({
      candidate: work,
      teamKey: work.teamKey,
      existingWorks: [],
      policy: this.config?.identity ?? undefined,
    }));
  }

  /**
   * 契约 §2：同一交付物身份 = 原 workId + 原 ownerMemberId。
   * 判定为同一交付物改名/接力时**拒绝开新流程**（提示沿用原 workId 修订计划）。
   */
  judgeWorkIdentity(candidate, { selfWorkId = null } = {}) {
    const teamKey = candidate?.teamKey ?? null;
    const existingWorks = [...this.works.values()].filter((work) => !teamKey || work.teamKey === teamKey);
    const judgement = judgeIdentity({
      candidate,
      teamKey,
      existingWorks,
      selfWorkId,
      policy: {
        ...(this.config?.identity ?? {}),
        // 配置里的 relayPolicy 就是 `warn`/`reject`；identity.js 的同名字段语义一致。
      },
    });
    return judgement;
  }

  /** 锁内：把身份绑定落盘（创建时调用一次；之后不随标题/kind 变化）。 */
  async persistIdentityInLock(work) {
    if (!work?.workId) return null;
    const key = String(work.workId);
    if (this.identityRecords.has(key)) return this.identityRecords.get(key);
    const judgement = this.judgeWorkIdentity(work, { selfWorkId: null });
    const record = identityRecordFor(work, judgement);
    const stored = await this.storage.put('identity_records', key, record, { idempotencyKey: `identity:${key}:${record.fingerprint}` });
    const committed = stored.ok ? (stored.record ?? record) : record;
    this.identityRecords.set(key, committed);
    if (!stored.ok) this.diagnostics.push('service:identity:not-persisted', `${key}: ${stored.code} ${stored.message}`);
    return committed;
  }

  /** 证据文件读取（带 memo：同一次校验里同一路径只读一次）。 */
  createEvidenceFileReader() {
    const cache = new Map();
    return async (filePath) => {
      const key = String(filePath);
      if (cache.has(key)) return cache.get(key);
      const result = await this.adapter.readFileInfo(filePath, { maxBytes: this.config?.materialize?.maxBytes });
      const value = result.ok
        ? { ok: result.value?.exists !== false, exists: result.value?.exists !== false, bytes: result.value?.bytes ?? 0, sha256: result.value?.sha256 ?? null, mtimeMs: result.value?.mtimeMs ?? null }
        : { ok: false, exists: false, error: `${result.code}: ${result.message}` };
      cache.set(key, value);
      return value;
    };
  }

  /**
   * 用**同一套** evidence.js 规则校验证据（workVerify / selfReport 共用）。
   *
   * @param {{work:object, evidence:object[], requireStrongForAccept?:boolean, requireAcceptance?:boolean}} input
   */
  /** 把执行 run 绑定到计划期冻结检查：按 command + 精确 argv 匹配；带 checkId/acceptanceIndexes/planRevision。 */
  frozenRunsForEvidence(work, runs = []) {
    // P1-1：run 的检查身份**在它被执行的那一刻**就固化了（execution.js 写入
    // planRevision/checkId/acceptanceIndexes/argv）。这里只做只读投影，
    // **绝不**按"当前 work 的 verificationCommands"给旧 run 追认补写身份——
    // 否则计划修订后旧 run 会自动变成新计划的证据（旧 plan 的 run 不能证明新 plan）。
    void work;
    return (Array.isArray(runs) ? runs : []).map((run) => ({
      ...run,
      checkId: typeof run?.checkId === 'string' && run.checkId ? run.checkId : null,
      acceptanceIndexes: Array.isArray(run?.acceptanceIndexes)
        ? run.acceptanceIndexes.filter((value) => Number.isInteger(value))
        : [],
      planRevision: Number.isInteger(run?.planRevision) ? run.planRevision : null,
    }));
  }

  async validateWorkEvidence({ work, evidence, requireStrongForAccept = true, requireAcceptance }) {
    const reader = this.createEvidenceFileReader();
    return validateEvidence({
      evidence,
      work,
      attempts: this.attempts,
      // 契约 §3/P1-1：证据必须引用 Host 记录的真实执行 run；run 的检查身份从**计划期冻结**的
      // verificationCommands 精确匹配（command + 精确 argv）派生，调用者不能重标 checkId。
      runs: this.frozenRunsForEvidence(work, this.executionRunner.listRuns()),
      diagnostics: this.diagnostics,
      readFile: reader,
      options: {
        requireVerification: this.config?.evidence?.requireVerification !== false,
        requireAcceptance: typeof requireAcceptance === 'boolean'
          ? requireAcceptance
          : this.config?.evidence?.requireAcceptanceMapping !== false,
        requireStrongForAccept: this.config?.evidence?.requireStrongForAccept !== false && requireStrongForAccept,
      },
    });
  }

  /**
   * 契约 §3 修订（Codex 审阅）：**可信执行**入口。
   *
   * 命令由 Host 进程真实执行（`spawn`，无 shell），记录 runId/exitCode/产物 sha256；
   * 之后 `team_work_verify` 的 evidence 必须引用这个 runId。
   * `scope:'live'` 一律拒绝（本 Host 不伪造实机证据）。
   */
  async runVerification(caller, request = {}) {
    const writable = this.assertWritable();
    if (!writable.ok) return writable;
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    if (actor.role !== 'member' && actor.role !== 'lead') {
      return denied('TEAM_MEMBER_REQUIRED', '可信执行只允许该模块的 owner 成员/lead 调用。');
    }
    const workId = typeof request.workId === 'string' ? request.workId.trim() : '';
    if (!workId) return denied('RUN_WORK_REQUIRED', '可信执行必须绑定 workId。');
    const work = this.works.get(workId);
    if (!work) return denied('WORK_NOT_FOUND', `没有工作项 ${workId}。`);
    const team = this.assertTeamOf(actor, work.teamKey);
    if (!team.ok) return team;
    if (actor.role === 'member' && work.ownerMemberId !== actor.memberId) {
      return denied('DELEGATION_SCOPE', `${workId} 的 owner 是 ${work.ownerMemberId}：不能替它执行验证。`);
    }
    // Codex 审阅 3：**不允许静默降级 scope**。
    //  - live：本 Host 不伪造实机证据 → 明确报错；
    //  - batch：只有 Lead 在批量验收阶段能产生（成员不能自称 batch）；
    //  - 成员默认只能 offline。
    const requestedScope = request.scope === undefined || request.scope === null ? 'offline' : String(request.scope);
    if (requestedScope === 'live') {
      return denied('LIVE_SCOPE_UNAVAILABLE', '本 Host 不能产生实机（live）证据：live 只能来自真实编辑器/引擎内的外部捕获记录 + 用户确认。', {
        hint: '成员用 scope:"offline"（本机验证）；批量验收由 Lead 用 scope:"batch"。不要把 offline 证据标成 live。',
      });
    }
    if (requestedScope === 'batch' && actor.role !== 'lead') {
      return denied('BATCH_SCOPE_LEAD_ONLY', 'batch（批量验收）证据只能由 Lead 产生：成员请用 scope:"offline"。');
    }
    if (requestedScope !== 'offline' && requestedScope !== 'batch') {
      return denied('EVIDENCE_SCOPE_INVALID', `未知证据范围 "${requestedScope}"：只接受 offline / batch（live 不支持）。`);
    }
    // 受控 force：必须带理由；无理由的 force 直接拒绝（不是无条件绕过）。
    if (request.force === true && (typeof request.forceReason !== 'string' || request.forceReason.trim().length < 8)) {
      return denied('FORCE_REASON_REQUIRED', 'force:true 必须同时给 forceReason（≥8 字符，说明改了什么条件/为什么这次会不同）；无条件 force 不被接受。');
    }
    // Codex 审阅 E：执行必须与该 agent 在 Host 侧的原生执行权限一致（shell:false 不等于安全）。
    const permission = this.assertHostToolPermission(actor, ['pwsh', 'bash', 'run_code']);
    if (!permission.ok) return permission;
    // **可执行验收项身份**：只允许执行计划里预先声明的命令（或 lead 显式执行），
    // 防止成员用 `node -e ""` 之类空跑给任意验收条件"背书"。
    const declared = Array.isArray(work.verificationCommands) ? work.verificationCommands : [];
    const requestedCommand = typeof request.command === 'string' ? request.command.trim() : '';
    const requestedArgv = Array.isArray(request.argv) ? request.argv.map((item) => String(item)) : [];
    // P1-1：计划期冻结的检查身份在执行时确定：
    //  - 有计划精确 argv 的检查必须 **argv 完全相等**（多/少一个参数都不算同一次检查）；
    //  - 只有 argvPrefix 的旧计划：前缀 + 长度相等（不允许借前缀夹带额外参数扩大检查范围）；
    //  - **没有任何参数声明**（argv 缺省/null、argvPrefix 空/缺省）的检查**不是通配**：
    //    只允许 argv=[] 的无参执行；带任意临时参数（如 `node -e ""`）一律不匹配 → 拒绝产生验收身份。
    const matchedCheck = declared.find((check) => {
      if (String(check.command) !== requestedCommand) return false;
      const exact = Array.isArray(check.argv) ? check.argv.map((item) => String(item)) : null;
      if (exact) return exact.length === requestedArgv.length && exact.every((value, index) => requestedArgv[index] === value);
      const prefix = Array.isArray(check.argvPrefix) ? check.argvPrefix.map((item) => String(item)) : [];
      if (prefix.length === 0) {
        // 缺参数声明 = 只允许无参执行；请求带参数时不能冻结/借用这条检查的身份。
        return requestedArgv.length === 0;
      }
      return prefix.length === requestedArgv.length && prefix.every((value, index) => requestedArgv[index] === value);
    });
    const allowedByConfig = (this.config?.execution?.allowedCommands ?? []).some((pattern) => String(pattern) === requestedCommand);
    if (!matchedCheck && declared.length > 0 && actor.role !== 'lead') {
      // 已有声明检查但本次 argv 与任何冻结检查都不精确一致：明确拒绝（不能静默按"命令存在"执行，
      // 否则一条成功 run 会被用来给没执行过的检查背书）。
      return denied(
        'VERIFICATION_ARGV_NOT_DECLARED',
        `本次命令参数与 work ${workId} 计划冻结的检查 argv 不一致：验收只能执行计划期精确声明的检查。`,
        {
          workId,
          requested: { command: requestedCommand, argv: requestedArgv },
          declared: declared.map((check) => ({ checkId: check.checkId ?? null, command: check.command, argv: check.argv ?? null, argvPrefix: check.argvPrefix ?? null, acceptanceIndexes: check.acceptanceIndexes ?? null })),
          hint: '按计划冻结的 argv 原样执行；要加参数必须在 team_plan_submit 里显式修改该检查（planRevision+1）后重新授权。',
        },
      );
    }
    if (!matchedCheck && !allowedByConfig && actor.role !== 'lead') {
      return denied(
        'VERIFICATION_COMMAND_NOT_DECLARED',
        `命令 "${requestedCommand}" 不在该 work 计划声明的可执行验收项里：验收必须绑定**预先声明**的可执行检查，不能临时空跑一条命令给验收背书。`,
        {
          workId,
          declared: declared.map((check) => ({ command: check.command, argvPrefix: check.argvPrefix, acceptanceIndex: check.acceptanceIndex })),
          hint: '在 team_plan_submit 的 deliverables[] 里加 verificationCommands:[{command,argvPrefix,acceptanceIndex}] 后重新授权；或由 lead 执行（lead 的执行的 scope=batch 仍会记录来源）。',
        },
      );
    }
    // P1-1：执行时固化的检查身份。只有精确命中的冻结检查才有 checkId/覆盖范围；
    // lead 临时执行或未声明检查 → 不带身份（不能给任何 acceptance 背书）。
    const frozenIdentity = matchedCheck
      ? {
        planRevision: Number.isInteger(work.planRevision) ? work.planRevision : null,
        checkId: typeof matchedCheck.checkId === 'string' && matchedCheck.checkId ? matchedCheck.checkId : null,
        acceptanceIndexes: Array.isArray(matchedCheck.acceptanceIndexes)
          ? matchedCheck.acceptanceIndexes.filter((value) => Number.isInteger(value))
          : (Number.isInteger(matchedCheck.acceptanceIndex) ? [matchedCheck.acceptanceIndex] : []),
      }
      : { planRevision: null, checkId: null, acceptanceIndexes: [] };
    // 执行前检查同一确定性失败：按「workId+命令+argv」+ **真实环境版本**（work.artifactRefs + rev）查。
    const environmentVersions = (work.artifactRefs ?? []).map((item) => `${item.path}@${item.version ?? 1}`);
    const guard = this.guardRepeatedFailure({
      tool: 'team_exec_check',
      input: { workId, command: request.command ?? '', argv: Array.isArray(request.argv) ? request.argv : [] },
      versions: environmentVersions,
      readEpoch: { planRevision: work.planRevision ?? null, rev: work.rev },
      force: request.force === true,
      forceReason: request.forceReason,
    });
    if (guard.skip) {
      return denied('REPEATED_DETERMINISTIC_FAILURE', `同一命令在同一输入/版本上已经确定性失败过：${guard.guidance}`, {
        guidance: guard.guidance,
        fingerprint: guard.fingerprint,
        errorClass: guard.errorClass,
        count: guard.count,
        forceDenial: guard.forceDenial ?? null,
        hint: '改变产物/依赖版本或命令之一后再试；force 需 forceReason 且同一条件最多 2 次。',
      });
    }
    const artifacts = Array.isArray(request.artifacts) && request.artifacts.length > 0
      ? request.artifacts
      : (work.outputs ?? []);
    /**
     * **native 优先**（Lead 第 13/14 回合 A-3）：只要存在原生 `tools.execute` 入口与真实 live agent，
     * 就走 policy/approval；拒绝/approval 不可用/异常 → **fail-closed**（`nativeAuthorization:false`
     * + 拒绝码，**不降级执行**）。没有 native 缝（测试替身/旧 profile）时才走直接执行，
     * 并显式标 `nativeAuthorization:false`（证据里能看出"未经原生授权"）。
     */
    // 原生 `tools.execute` 是否真实存在（存在性探针）：不存在时**不得**走 native 再 fail-closed，
    // 而是走直接执行并显式标 `nativeAuthorization:false`（证据里能看出"未经原生授权"）。
    const nativeExecuteSupported = typeof this.adapter?.nativeExecuteAvailable === 'function'
      ? this.adapter.nativeExecuteAvailable() === true
      : true;
    const nativeAvailable = this.config?.execution?.nativeExecution !== false
      && nativeExecuteSupported
      && typeof this.adapter?.executeTool === 'function'
      && Boolean(actor.agent);
    const nativeArgs = {
      workId,
      attemptId: typeof request.attemptId === 'string' ? request.attemptId : (work.activeAttemptId ?? work.lastAttemptId ?? null),
      teamKey: work.teamKey,
      ownerMemberId: work.ownerMemberId,
      command: request.command,
      argv: request.argv,
      cwd: request.cwd,
      artifacts,
      scope: requestedScope,
      timeoutMs: request.timeoutMs,
      agent: actor.agent,
      adapter: this.adapter,
      signal: request.signal,
      // P1-1：计划身份在执行时固化进 run 记录（不是验收时补写）。
      planRevision: frozenIdentity.planRevision,
      checkId: frozenIdentity.checkId,
      acceptanceIndexes: frozenIdentity.acceptanceIndexes,
    };
    let result;
    if (nativeAvailable) {
      result = await this.executionRunner.runNative(nativeArgs);
      if (result.ok !== true) {
        // fail-closed：不换成直接 spawn 再试（那会绕过原生 policy/approval）。
        this.diagnostics.push('service:runVerification:native-denied', `${workId}: ${result.code} ${result.message}`);
        await this.recordFailureFingerprint({
          tool: 'team_exec_check',
          input: { workId, command: request.command ?? '', argv: Array.isArray(request.argv) ? request.argv : [] },
          versions: environmentVersions,
          code: result.code ?? 'NATIVE_EXECUTION_REJECTED',
          message: result.message ?? '',
          memberId: actor.memberId,
          workId,
          readEpoch: { planRevision: work.planRevision ?? null, rev: work.rev },
        });
        return denied(result.code ?? 'NATIVE_EXECUTION_REJECTED', result.message ?? '原生执行未放行（fail-closed）。', {
          workId,
          nativeAuthorization: false,
          deniedCode: result.deniedCode ?? result.code ?? null,
          hint: '原生 policy/approval 未放行：不要改沙箱/权限/approval 全局设置；由 lead 核查权限或在授权后重试。',
        });
      }
    } else {
      result = { ...(await this.executionRunner.run({
        workId,
        attemptId: nativeArgs.attemptId,
        teamKey: work.teamKey,
        ownerMemberId: work.ownerMemberId,
        command: request.command,
        argv: request.argv,
        cwd: request.cwd,
        artifacts,
        // 真实环境决定 scope（已校验过），不接受模型随意改写。
        scope: requestedScope,
        timeoutMs: request.timeoutMs,
        // P1-1：计划身份随执行写入 run 记录。
        planRevision: frozenIdentity.planRevision,
        checkId: frozenIdentity.checkId,
        acceptanceIndexes: frozenIdentity.acceptanceIndexes,
      })), nativeAuthorization: false, nativeAuthorizationReason: 'native-tools-execute-unavailable' };
      this.diagnostics.push('service:runVerification:native-unavailable', `${workId}: 无原生执行入口，直接执行并标 nativeAuthorization:false。`);
    }
    if (!result.ok) {
      this.diagnostics.push('service:runVerification:failed', `${workId}: ${result.code} ${result.message}`);
      await this.recordFailureFingerprint({
        tool: 'team_exec_check',
        input: { workId, command: request.command ?? '', argv: request.argv ?? [] },
        versions: (work.artifactRefs ?? []).map((item) => `${item.path}@${item.version ?? 1}`),
        code: result.code,
        message: result.message,
        memberId: actor.memberId,
        workId,
        readEpoch: { planRevision: work.planRevision ?? null },
      });
      return result;
    }
    if (String(result.status) !== 'completed' || Number(result.exitCode) !== 0) {
      // 失败/超时的执行也记录指纹（同一确定性失败不重复跑）。
      await this.recordFailureFingerprint({
        tool: 'team_exec_check',
        input: { workId, command: request.command ?? '', argv: request.argv ?? [] },
        versions: (work.artifactRefs ?? []).map((item) => `${item.path}@${item.version ?? 1}`),
        code: `EXIT_${result.exitCode ?? 'NULL'}`,
        message: `status=${result.status}`,
        memberId: actor.memberId,
        workId,
        readEpoch: { planRevision: work.planRevision ?? null },
      });
    }
    this.findingsCache = null;
    return {
      ...result,
      evidenceHint: String(result.status) === 'completed' && Number(result.exitCode) === 0
        ? { kind: 'verification', scope: result.scope, runId: result.runId }
        : null,
      note: String(result.status) === 'completed' && Number(result.exitCode) === 0
        ? `Host 已真实执行：把 {kind:'verification', runId:'${result.runId}'} 放进 team_work_verify 的 evidence（不要贴命令字符串）。`
        : `执行结果 ${result.status}（exitCode=${result.exitCode}）：失败/超时的执行不能作为验收证据。`,
    };
  }

  /** 某 work 相关的执行记录（只读，供验收/前端核对）。 */
  runsForWork(workId) {
    return this.executionRunner.listRuns().filter((run) => run.workId === String(workId));
  }

  /** 锁内：写证据记录（sidecar `evidence_records`，key=workId，保留历史在 provenance 里）。 */
  async persistEvidenceInLock({ work, validation, attemptId, verifiedBy }) {
    const record = evidenceRecordFor({ work, validation, attemptId, at: this.clock.now(), verifiedBy });
    const stored = await this.storage.put('evidence_records', String(work.workId), record, {
      idempotencyKey: `evidence:${work.workId}:${validation?.digest ?? 'none'}:${validation?.ok === true ? 'ok' : 'pending'}`,
    });
    const committed = stored.ok ? (stored.record ?? record) : record;
    this.evidenceRecords.set(String(work.workId), committed);
    if (!stored.ok) this.diagnostics.push('service:evidence:not-persisted', `${work.workId}: ${stored.code} ${stored.message}`);
    this.findingsCache = null;
    return committed;
  }

  /** 契约 §3：源版本变化 → 证据过期（但**不**错误解锁依赖）。 */
  invalidateEvidence(workId, changed, reason = 'EVIDENCE_STALE') {
    const entry = { workId, reason, changed: Array.isArray(changed) ? changed : [], at: this.clock.now() };
    this.evidenceInvalidations.push(entry);
    if (this.evidenceInvalidations.length > 200) this.evidenceInvalidations.shift();
    const work = this.works.get(String(workId));
    if (work) {
      // 只改内存可知的"证据有效性"标记；历史记录原样保留（不批量改写）。
      this.works.set(work.workId, { ...work, evidenceValid: false, evidenceInvalidatedAt: entry.at });
    }
    this.findingsCache = null;
    this.diagnostics.push('service:evidence:invalidated', `${workId}: ${reason}（${changed.map((item) => item.reason ?? item).join(',')}）`);
    return entry;
  }

  /** 某个 work 的证据是否**当前有效**（依赖满足判定要用）。 */
  isEvidenceCurrent(work) {
    if (!work) return false;
    if (work.evidenceValid === false) return false;
    const record = this.evidenceRecords.get(String(work.workId));
    if (!record) return false;
    return record.valid === true;
  }

  // ---- 受管上下文：请求前紧凑状态（供 contextControl 的 pre-step 注入） ------
  /**
   * 该 agent 的**受管**紧凑状态（只含指针；不读大文件、不触发模型）。
   * 非受管 agent 返回 null（绝不把全局状态注入给无关会话）。
   */
  /** 祖先归属用：真实 session 元数据缓存（由原生元数据发现刷新；接口缺失时为空，不伪造）。 */
  usageSessionFacts() {
    return Array.isArray(this.sessionMetadataCache) ? this.sessionMetadataCache : [];
  }

  /**
   * 刷新原生 session 元数据（只读，不读正文、不喂模型）：
   * 1. adapter.listSessions（真实适配器，内部 `sessionPersistence.list()`）；
   * 2. 回退 `ctx.get('sessionPersistence' | 'sessionQuery').list()`（测试替身/旧 profile）。
   * 结果缓存给归属（facts 是同步的，不能在 ingest 中途 await）。
   */
  async refreshSessionMetadata() {
    // 单一实现：模块级 discoverSessionMetadata（真实 adapter → 官方 sessionPersistence.list 回退）。
    // 保持该公开方法名不变，历史 reader 契约 / 维护入口都读它。
    return discoverSessionMetadata(this);
  }

  /** 祖先归属用：未登记 workbench 的原生 team（接口缺失返回 []）。 */
  usageNativeTeamFacts() {
    const raw = typeof this.adapter?.listNativeTeams === 'function' ? this.adapter.listNativeTeams() : [];
    const list = Array.isArray(raw) ? raw : (raw?.ok && Array.isArray(raw.value) ? raw.value : []);
    return list;
  }

  compactStateFor(agent) {
    if (!agent) return null;
    const actor = this.actor(agent);
    let teamKey = actor.ok ? actor.teamKey : null;
    let memberId = actor.ok ? actor.memberId : null;
    let workId = null;
    if (actor.ok !== true || (actor.role !== 'member' && actor.role !== 'lead')) {
      // leaf：用真实 child session 身份反查 attempt，确认它属于受管团队。
      const attempt = this.findExecutorAttempt(String(agent.id));
      if (!attempt) return null;
      teamKey = attempt.teamKey;
      memberId = attempt.ownerMemberId;
      workId = attempt.workId;
    }
    if (!teamKey || !memberId) return null;
    // 原生 team id → sidecar teamKey（统一映射；leaf 已从 attempt 得到 sidecar key）。
    teamKey = this.resolveTeamKey(actor, teamKey) ?? teamKey;
    const works = [...this.works.values()].filter((work) => this.isSameTeam(actor, work.teamKey) && work.ownerMemberId === memberId);
    const scoped = workId ? works.filter((work) => work.workId === workId) : works;
    const workIds = new Set(works.map((work) => work.workId));
    const pending = this.pendingEvents(teamKey, memberId);
    const byType = {};
    for (const event of pending) byType[event.type] = (byType[event.type] ?? 0) + 1;
    const prints = this.errorFingerprintSnapshot({ teamKey, limit: 20 }).groups
      .filter((group) => (group.workIds ?? []).some((id) => workIds.has(id)))
      .slice(0, 3);
    const findings = this.findingsSnapshot();
    return {
      teamKey,
      memberId,
      works: scoped.map((work) => ({
        workId: work.workId,
        state: work.state,
        planRevision: work.planRevision ?? null,
        blockedReason: work.blockedReason ?? null,
        missing: Array.isArray(work.completion?.missing) ? work.completion.missing : [],
        outputs: (work.outputs ?? []).slice(0, 2),
        // P2-9：关键事实（已知失败/接口版本）必须能进紧凑注入，不能只有长路径指针。
        lastFailureCode: work.lastFailureCode ?? null,
        lastFailureMessage: typeof work.lastFailureMessage === 'string' ? work.lastFailureMessage : null,
        artifactDependencies: (work.artifactDependencies ?? []).slice(0, 3).map((dep) => ({ artifact: dep.artifact, version: dep.version, requires: dep.requires })),
        acceptanceCount: Array.isArray(work.acceptance) ? work.acceptance.length : 0,
      })),
      fingerprints: prints.map((group) => ({ code: group.code, count: group.count, guidance: group.guidance })),
      inbox: { pending: pending.length, byType },
      lastProgress: findings.lastEffectiveProgress,
    };
  }

  /**
   * 原生工具守卫的查询入口（`contextControl` 调用）：
   * 按「操作 + 规范化输入 + 产物/依赖版本」查历史确定性失败。
   */
  /** 该 work 的**真实文件 epoch**（来自最近一次磁盘读取；未知 → null，不猜）。 */
  fileEpochFor(work) {
    if (!work) return null;
    return this.fingerprintFileEpochs.get(String(work.workId))?.epoch ?? null;
  }

  /** 读取 work 相关文件（outputs + artifactRefs）的真实状态并计算 epoch（供指纹环境使用）。 */
  async captureFileEpoch(work) {
    if (!work || typeof this.adapter?.readFileInfo !== 'function') return null;
    const paths = [...new Set([
      ...(Array.isArray(work.outputs) ? work.outputs : []),
      ...(Array.isArray(work.artifactRefs) ? work.artifactRefs.map((item) => item?.path) : []),
    ].filter(Boolean).map(String))];
    const files = [];
    for (const target of paths) {
      // readFileInfo 可能是 async（真实 adapter）或 sync（测试替身）：必须 await，否则 epoch 永远为空。
      const info = await Promise.resolve(this.adapter.readFileInfo(target));
      files.push({
        path: target,
        exists: info?.ok === true && info.value?.exists === true,
        sha256: info?.value?.sha256 ?? null,
        bytes: info?.value?.bytes ?? null,
        mtimeMs: info?.value?.mtimeMs ?? null,
      });
    }
    const epoch = fileEpochOf(files);
    this.fingerprintFileEpochs.set(String(work.workId), { epoch, at: this.clock.now(), files });
    return epoch;
  }

  findRepeatedFailure({ tool, input, environment } = {}) {
    // **与失败记录生产者共用同一个 builder**（guard 预检 / tools/result 记录 / 启动失败记录）。
    // P1-2：readEpoch 固定形状（planRevision/rev/files/readSeq）。调用方可直接给
    // environment.readEpoch（contextControl 用的 work 读取 epoch）；否则按环境字段构造。
    const readEpoch = environment?.readEpoch !== undefined
      ? environment.readEpoch
      : {
        rev: environment?.rev ?? null,
        planRevision: environment?.planRevision ?? null,
        files: environment?.filesEpoch ?? null,
        readSeq: environment?.readSeq ?? null,
      };
    const descriptor = buildOperationDescriptor({
      tool,
      input,
      versions: environment?.versions ?? [],
      readEpoch,
    });
    return this.fingerprints.findByOperation(descriptor);
  }

  /** 该 work 的读取 epoch（失败记录与工具守卫共用同一形状；成功 read 会推 readSeq）。 */
  toolReadEpoch(work) {
    if (!work) return null;
    return {
      planRevision: work.planRevision ?? null,
      rev: work.rev ?? null,
      files: this.fileEpochFor(work),
      readSeq: this.toolReadSeq.get(String(work.workId)) ?? 0,
    };
  }

  /** 真实成功 read/grep/glob：读取基准已重置 → 同输入失败可合理重试（但没重读就重试仍会拦）。 */
  noteToolReadSuccess(work) {
    if (!work?.workId) return 0;
    const key = String(work.workId);
    const next = (this.toolReadSeq.get(key) ?? 0) + 1;
    this.toolReadSeq.set(key, next);
    return next;
  }

  /**
   * `tools/result` 真实失败入库（Lead 第 12 回合 A）：descriptor 来自
   * `contextControl.onToolResult` 的 `buildOperationDescriptor`，与 guard 预检同键。
   */
  async recordToolFailure(descriptor = {}, result = null) {
    return this.recordFailureFingerprint({
      tool: descriptor.tool,
      input: descriptor.input,
      versions: descriptor.versions ?? [],
      code: descriptor.code ?? 'TOOL_RESULT_ERROR',
      message: descriptor.message ?? '',
      memberId: descriptor.memberId ?? null,
      workId: descriptor.workId ?? null,
      attemptId: descriptor.attemptId ?? null,
      readEpoch: descriptor.readEpoch ?? null,
      via: 'tools/result',
      isError: result?.isError === true,
    });
  }

  /**
   * 对账前（锁外）刷新证据有效性：只读**声明过的产物文件**的元数据/hash。
   * 变化 → 记 invalidated；不重跑任务、不改 accepted 历史。
   */
  async refreshEvidenceValidity() {
    // 顺带刷新真实文件 epoch（供重复失败判定；不改变证据判定结果）。
    for (const work of this.works.values()) await this.captureFileEpoch(work);
    const candidates = [...this.evidenceRecords.values()].filter((record) => record && record.valid === true && Array.isArray(record.files) && record.files.length > 0);
    if (candidates.length === 0) return { checked: 0, stale: [] };
    const stale = [];
    for (const record of candidates) {
      const current = new Map();
      for (const file of record.files) {
        const info = await this.adapter.readFileInfo(file.path, { maxBytes: this.config?.materialize?.maxBytes });
        current.set(file.path, info.ok
          ? { exists: info.value?.exists !== false, bytes: info.value?.bytes ?? 0, sha256: info.value?.sha256 ?? null }
          : { exists: false });
      }
      const verdict = isEvidenceStale(record, current);
      if (verdict.stale) {
        stale.push(this.invalidateEvidence(record.workId, verdict.changed, 'EVIDENCE_STALE'));
      }
    }
    return { checked: candidates.length, stale };
  }

  /** 锁内一致性：依赖放行前要求"依赖的证据当前有效"。 */
  /** 契约 §5：记录一次失败指纹（**不重复执行**的判据来源）。 */
  async recordFailureFingerprint(descriptor = {}) {
    // P1-4：从真实 work/owner 归属注入 teamKey（记录与查询同一字段）。
    const ownerWork = descriptor.workId ? this.works.get(String(descriptor.workId)) : null;
    const result = await this.fingerprints.recordFailure({
      tool: descriptor.tool,
      input: descriptor.input,
      versions: descriptor.versions,
      code: descriptor.code,
      message: descriptor.message,
      readEpoch: descriptor.readEpoch,
      memberId: descriptor.memberId ?? null,
      workId: descriptor.workId ?? null,
      attemptId: descriptor.attemptId ?? null,
      teamKey: descriptor.teamKey ?? ownerWork?.teamKey ?? null,
    });
    this.findingsCache = null;
    return result;
  }

  /**
   * 同一确定性失败在**输入/版本都没变**时不再重复执行。
   *
   * 缺陷修正（Codex 审阅 4）：执行**前**还不知道错误码，不能用 `code:null` 算指纹；
   * 这里按「操作 + 规范化输入 + 产物/依赖版本」查历史确定性失败（`findByOperation`）。
   * `force:true` **不是无条件绕过**：必须带 `forceReason`（≥8 字符）、同一条件最多 2 次、且会被记录。
   */
  guardRepeatedFailure(descriptor = {}) {
    const result = this.fingerprints.findByOperation({
      tool: descriptor.tool,
      input: descriptor.input,
      versions: descriptor.versions,
      readEpoch: descriptor.readEpoch,
      force: descriptor.force === true,
      forceReason: descriptor.forceReason,
    });
    if (result.forced === true && result.fingerprint) {
      this.diagnostics.push('service:guard:forced', `${descriptor.tool}: 受控 force（理由：${String(descriptor.forceReason ?? '').slice(0, 80)}）`);
      void this.fingerprints.recordForce(result.fingerprint, descriptor.forceReason);
    }
    return result;
  }

  /**
   * 调度器启动前的**错误门闸**（升级路径用；与 `reserveWorkInLock` 内联逻辑同一判据）。
   * 返回拒绝对象或 null。按「操作 + 规范化输入 + 产物/依赖版本」查历史确定性失败。
   */
  async evaluateErrorGate(work, context = {}) {
    if (!work) return null;
    if (context?.force === true) return null;
    // P1-2 / P1-4：与 executeStart 的失败记录**同一 descriptor**（同一 builder/字段/epoch），
    // 否则记录与预检永远对不上（旧缺陷：record 用 input.owner + 字符串 epoch，query 用 ownerMemberId + 对象 epoch）。
    const descriptor = this.describeStartFailure(
      { workId: work.workId, ownerMemberId: work.ownerMemberId, attemptId: work.activeAttemptId ?? work.lastAttemptId ?? null },
      {},
    );
    const result = this.fingerprints.findByOperation({
      tool: descriptor.tool,
      input: descriptor.input,
      versions: descriptor.versions,
      readEpoch: descriptor.readEpoch,
    });
    if (!result?.skip) return null;
    return {
      ok: false,
      rejection: {
        workId: work.workId,
        code: 'REPEATED_DETERMINISTIC_FAILURE',
        guidance: result.guidance,
        fingerprint: result.fingerprint,
        errorClass: result.errorClass,
        count: result.count,
        note: '同一输入+同版本+同读取 epoch 的确定性失败不会被重复执行（不烧 attempt 预算）。',
      },
    };
  }

  /** 由执行启动失败构造指纹描述符（升级 wrapper 用；字段与 recordFailureFingerprint 对齐）。 */
  describeStartFailure(plan = {}, outcome = {}) {
    const work = this.works.get(String(plan.workId ?? ''));
    // 与 guard / tools/result 共用同一个 builder（键一致，预检才能命中）。
    // P1-2 / P1-4：启动失败的读取 epoch **只含 planRevision + 真实文件 epoch**，
    // 不含 `rev`/`failureStreak`——失败簿记本身会让 rev 递增，若纳入 epoch，
    // 同一确定性失败会在第二次预检时"自动失忆"（这正是旧缺陷 F 的根因之一）。
    return buildOperationDescriptor({
      tool: 'team_subagent_start',
      input: { workId: plan.workId ?? null, ownerMemberId: plan.ownerMemberId ?? work?.ownerMemberId ?? null, outputs: work?.outputs ?? [] },
      versions: (work?.artifactRefs ?? []).map((item) => `${item.path}@${item.version ?? 1}`),
      code: outcome.code ?? 'UNKNOWN',
      message: outcome.message ?? '',
      memberId: plan.ownerMemberId ?? work?.ownerMemberId ?? null,
      workId: plan.workId ?? null,
      attemptId: plan.attemptId ?? null,
      // 与 guard 查询同一 readEpoch 形状：包含真实文件 epoch（read 后修复可解除误拦）。
      readEpoch: work ? { planRevision: work.planRevision ?? null, files: this.fileEpochFor(work) } : null,
    });
  }
  // ---- 机械物化（契约 §3：零 LLM 转抄） -------------------------------------
  /**
   * **原生工具权限闸**（Codex 审阅 E）：本插件的执行/物化不得绕开 Host 的工具权限。
   * 若该 agent 在 Host 视角看不到对应工具（被 profile/用户限制），这里同样拒绝。
   * `hasTool` 不可用（老 profile / 测试替身）时返回 `{ok:true, unchecked:true}` 并记诊断——
   * 不在缺少服务时假装"已授权"，也不因此把整个功能打死。
   */
  assertHostToolPermission(actor, toolNames = []) {
    const names = Array.isArray(toolNames) ? toolNames.filter(Boolean) : [];
    if (names.length === 0) return { ok: true, checked: false };
    if (!this.adapter || typeof this.adapter.hasTool !== 'function') {
      this.diagnostics.push('service:host-tool-permission:unchecked', `adapter.hasTool 不可用：跳过分区检查（${names.join('/')}）`);
      return { ok: true, checked: false, unchecked: true };
    }
    let lastError = null;
    for (const name of names) {
      const result = this.adapter.hasTool(actor?.agent, name);
      if (result.ok && result.value === true) return { ok: true, checked: true, tool: name };
      if (!result.ok) lastError = result;
    }
    if (lastError && ['SERVICE_UNAVAILABLE', 'NATIVE_METHOD_MISSING'].includes(String(lastError.code))) {
      // 原生缝不完整（测试替身/旧 profile）：**不假装已授权**，但也不把功能打死；记 unchecked。
      this.diagnostics.push('service:host-tool-permission:unchecked', `tools.get 不可用（${lastError.code}）：${names.join('/')} 权限未核验。`);
      return { ok: true, checked: false, unchecked: true, reason: lastError.code };
    }
    if (lastError) {
      return denied('HOST_TOOL_PERMISSION_UNAVAILABLE', `无法核验 Host 工具权限（${names.join('/')}）：${lastError.code} ${lastError.message}。为安全起见拒绝自行执行。`, { tools: names });
    }
    return denied(
      'HOST_TOOL_PERMISSION_REQUIRED',
      `该 agent 在 Host 侧没有 ${names.join('/')} 权限：本插件的执行/物化不能绕开原生工具权限。`,
      { tools: names, hint: '让 lead 调整该成员的工具允许集，或由有权限的 lead 执行；不要试图绕过权限。' },
    );
  }

  /**
   * Host 侧的确定性复制/哈希入口。
   *
   * @param {object} caller 真实 Agent
   * @param {{op:'copy'|'hash'|'verify', from:string, to?:string, workId?:string,
   *          overwrite?:boolean, expectSha256?:string, scopes?:string[]}} request
   */
  async materialize(caller, request = {}) {
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    if (actor.role !== 'member' && actor.role !== 'lead') {
      return denied('TEAM_MEMBER_REQUIRED', '机械物化只允许 Team 成员/lead 调用（leaf 用自己的文件工具直接写盘）。');
    }
    // Codex 审阅 E：物化写盘必须与该 agent 在 Host 侧的写权限一致（不能另开无鉴权写通路）。
    const permission = this.assertHostToolPermission(actor, ['write', 'edit']);
    if (!permission.ok) return permission;
    const op = String(request.op ?? 'copy');
    // P1-6：caller 传入的 scopes 只能**缩小**范围，不得扩大/覆盖 work 的授权范围。
    const requestedScopes = Array.isArray(request.scopes) ? request.scopes.map(String) : null;
    let scopes = requestedScopes;
    // 若给了 workId：校验归属并采用该 work 的写范围（防止借物化写别人范围）。
    if (request.workId) {
      const work = this.works.get(String(request.workId));
      if (!work) return denied('WORK_NOT_FOUND', `没有工作项 ${request.workId}。`);
      if (actor.role === 'member' && work.ownerMemberId !== actor.memberId) {
        return denied('DELEGATION_SCOPE', `${request.workId} 的 owner 是 ${work.ownerMemberId}：不能用它作为物化范围的授权。`);
      }
      const allowedScopes = [...new Set([...(work.writeScopes ?? []), ...(work.outputs ?? [])])];
      if (requestedScopes && requestedScopes.length > 0) {
        const narrow = (target) => allowedScopes.some((allowed) => String(target) === allowed || String(target).startsWith(`${allowed}/`));
        const escalation = requestedScopes.filter((target) => !narrow(target));
        if (escalation.length > 0) {
          return denied('MATERIALIZE_SCOPE_ESCALATION', `caller 的物化 scopes 超出 ${request.workId} 的授权范围：${escalation.join(', ')}。`, { allowedScopes, requestedScopes });
        }
        scopes = requestedScopes;
      } else {
        scopes = allowedScopes;
      }
    }
    const result = await this.materializer.run(op, { ...request, scopes: scopes ?? [] });
    if (result.ok) {
      this.diagnostics.push('service:materialize', `${op} ${result.from ?? request.from} → ${result.to ?? '(hash)'} sha256=${String(result.sha256 ?? '').slice(0, 12)}（noModelCalls）`);
    } else {
      this.diagnostics.push('service:materialize:failed', `${op}: ${result.code} ${result.message}`);
      await this.recordFailureFingerprint({
        tool: `team_materialize:${op}`,
        input: { from: request.from, to: request.to ?? null, workId: request.workId ?? null },
        code: result.code,
        message: result.message,
        memberId: actor.memberId,
        workId: request.workId ?? null,
        readEpoch: request.workId ? this.works.get(String(request.workId))?.rev ?? null : null,
      });
    }
    return result;
  }

  // ---- 费用归账（契约 §1 snapshot.usage） -----------------------------------
  /**
   * 增量归账一次（幂等，可重复调用）。
   *
   * **生产入口是原生 session 事件游标**（Codex 审阅 1）：从 live Agent 的
   * `session.snapshotEvents(cursor)` 折账，不依赖审计 JSONL。
   * `mode:'baseline'` 才走审计 JSONL 导入（只用于验收重放）。
   */
  async refreshUsage(options = {}) {
    if (this.config?.usage?.enabled === false) {
      return { ok: false, code: 'USAGE_DISABLED', message: 'config.usage.enabled=false：不做费用归账。' };
    }
    const mode = options.mode === 'baseline' ? 'baseline' : 'native';
    let result;
    if (mode === 'baseline') {
      if (!this.config?.usage?.sourcePath) {
        return { ok: false, code: 'USAGE_BASELINE_NOT_CONFIGURED', message: '未配置 usage.sourcePath：审计基线导入不可用（生产归账走原生事件，不需要它）。' };
      }
      result = await this.usageLedger.ingestAuditBaseline({ maxBytes: options.maxBytes ?? this.config?.usage?.maxBytesPerIngest });
    } else {
      result = await this.nativeUsage.collect(options);
    }
    this.findingsCache = null;
    return { ...result, mode, nativeStats: this.nativeUsage.stats() };
  }

  /** 首次历史补录（程序化折账，不喂模型；只进 cumulative，不计入本阶段）。 */
  async backfillUsage() {
    const result = await this.nativeUsage.backfill();
    this.findingsCache = null;
    return { ...result, mode: 'backfill', nativeStats: this.nativeUsage.stats() };
  }

  /**
   * 历史非 live 会话补账（Lead 第 16 回合 A）：后台分批 + 持久 cursor + 覆盖窗口。
   * 不做全量扫描、不把账本读进模型；gaps 明确列出未能回读的区间/原因。
   */
  async backfillHistoricalUsage(sessions = [], options = {}) {
    const result = await this.nativeUsage.backfillHistorical(sessions, options);
    this.findingsCache = null;
    return { ...result, mode: 'backfill-historical', nativeStats: this.nativeUsage.stats() };
  }

  /**
   * **历史补账的真实生产入口**（Lead 收口项 1 / 费用审计 14:27 补充）：
   *
   * 1. **原生元数据发现**：`sessionPersistence.list()`（官方返回 `SessionPersistenceSnapshot[]`，
   *    含 `header.id` / `header.parentSession`）枚举本机 session；
   * 2. **祖先链归属**：只有祖先链能走到本插件已登记的 team root / member session / attempt child
   *    的 session 才补账（不把所有账户会话直接归进本队；无关 session 排除）；
   * 3. **有界分页读取**：`open(id,'read').read(offset, length)` → `{events}`，用毕 close；
   * 4. 分批（`batchSize`）+ 持久 cursor + coverage/gaps 明确。
   */
  async backfillHistoricalFromKnownSessions(options = {}) {
    const targets = new Map();
    const add = (sessionId, meta = {}) => {
      const id = String(sessionId ?? '');
      if (!id) return;
      targets.set(id, { id, ...(targets.get(id) ?? {}), ...meta });
    };
    const knownSessions = new Set();
    const roots = new Set();
    for (const team of this.teams.values()) {
      add(team.rootSessionId, { kind: 'lead', teamKey: team.teamKey });
      if (team.rootSessionId) { knownSessions.add(String(team.rootSessionId)); roots.add(String(team.rootSessionId)); }
    }
    for (const member of this.members.values()) {
      add(member.sessionId, { kind: 'member', teamKey: member.teamKey, memberId: member.memberId });
      if (member.sessionId) knownSessions.add(String(member.sessionId));
    }
    for (const attempt of this.attempts.values()) {
      add(attempt.executorChildId, { kind: 'leaf', teamKey: attempt.teamKey, workId: attempt.workId, attemptId: attempt.attemptId });
      if (attempt.executorChildId) knownSessions.add(String(attempt.executorChildId));
    }
    const gaps = [];
    // ---- 原生元数据发现（不读正文、不喂模型）----
    let discovered = 0;
    let nativeMetadata = [];
    const metadata = await discoverSessionMetadata(this);
    nativeMetadata = Array.isArray(metadata.sessions) ? metadata.sessions : [];
    if (nativeMetadata.length === 0) gaps.push({ sessionId: null, reason: 'SESSION_METADATA_UNAVAILABLE', source: metadata.source ?? null });
    const parentOf = new Map();
    for (const row of nativeMetadata) {
      if (row?.id) parentOf.set(String(row.id), row.parentSession ? String(row.parentSession) : null);
    }
    for (const row of nativeMetadata) {
      const id = String(row?.id ?? '');
      if (!id) continue;
      // 祖先链：最多 8 跳；自身已登记或链上出现已登记 session/team root 才算本队。
      let cursor = id;
      let hops = 0;
      let attributed = knownSessions.has(cursor);
      while (!attributed && hops < 8) {
        const parent = parentOf.get(cursor);
        if (!parent) break;
        attributed = knownSessions.has(parent) || roots.has(parent);
        cursor = parent;
        hops += 1;
      }
      if (!attributed) continue;
      discovered += 1;
      add(id, { kind: knownSessions.has(id) ? 'known' : 'native-descendant', parentSession: parentOf.get(id) ?? null });
    }
    const persistence = typeof this.ctx?.get === 'function' ? (this.ctx.get('sessionPersistence') ?? this.ctx.get('sessionQuery')) : undefined;
    const sessions = [];
    for (const target of targets.values()) {
      if (!persistence) { gaps.push({ sessionId: target.id, reason: 'SESSION_READER_UNAVAILABLE' }); continue; }
      sessions.push({
        ...target,
        readerSource: "dsh-session-persistence-jsonl:open(id,'read').read(offset,length)",
        readEvents: async (fromSeq = 0) => {
          // 真实 API（源码核实）：`persistence.open(id,'read')` → JsonlSessionHandle
          // `.read(offset, length, {signal})` → `{eventState, events}`；offset 是**逻辑 seq**。
          // 只读、用毕 close；不可用 → READER_API_UNVERIFIED（保持 unknown，不伪造）。
          if (typeof persistence.open === 'function') {
            const handle = await persistence.open(target.id, 'read');
            try {
              if (typeof handle?.read !== 'function') {
                throw Object.assign(new Error('handle.read 不存在（reader API 与源码不符）'), { code: 'READER_API_UNVERIFIED' });
              }
              const length = Math.max(1, Number(options.maxEventsPerSession ?? this.config?.usage?.maxEventsPerSession ?? 1000));
              const result = await handle.read(fromSeq, length);
              const events = Array.isArray(result) ? result : (Array.isArray(result?.events) ? result.events : []);
              return events.filter((event) => Number(event?.seq) >= fromSeq);
            } finally {
              try { await handle?.close?.(); } catch { /* close 失败不阻塞 */ }
            }
          }
          throw Object.assign(new Error('sessionPersistence.open 不可用'), { code: 'READER_API_UNVERIFIED' });
        },
      });
    }
    const result = await this.backfillHistoricalUsage(sessions, { batchSize: options.batchSize ?? this.config?.usage?.historicalBatchSize, ...options });
    return {
      ...result,
      targets: targets.size,
      discovered,
      nativeMetadata: nativeMetadata.length,
      reader: persistence ? 'official' : 'unavailable',
      readerSource: persistence ? "dsh-session-persistence-jsonl:open(id,'read').read(offset,length)" : 'READER_API_UNVERIFIED',
      gaps: [...(result?.gaps ?? []), ...gaps].slice(0, 100),
    };
  }

  /** 只读投影（不触发读取/重扫；契约冻结形状）。 */
  usageSnapshot({ teamKey = null } = {}) {
    const ownerIds = teamKey
      ? [...this.members.values()].filter((member) => member.teamKey === teamKey).map((member) => member.memberId)
      : null;
    const projection = this.usageLedger.snapshot({ teamKey, ownerIds });
    return {
      ...projection,
      nativeSource: nativeSourceSummary(this.nativeUsage.stats()),
      // 历史补账覆盖窗口（from/to/sessions/gaps）；未补录时 sessions=0、gaps 为空数组。
      raw: { ...(projection.raw ?? {}), nativeWindow: this.nativeUsage.coverageSnapshot?.() ?? { from: null, to: null, sessions: 0, gaps: [] } },
    };
  }

  /** 费用**明细**分页（后台读；不进 `/state`、不进模型上下文）。 */
  usageRecords(options = {}) {
    return this.usageLedger.usageRecords(options);
  }

  /** 当前生效的价目表（可追溯；价目来源/版本/生效时段）。 */
  usagePricing() {
    return { ok: true, pricing: this.usageLedger.priceBookView() };
  }

  // ---- 成果投影（契约 §1 snapshot.findings） --------------------------------
  /**
   * 按 revision 缓存：同一状态多次请求 `/state` 不重复计算、不触发 IO。
   * `revision` 在每次接受写操作时由 storage 递增（本 service 也维护 `this.revision`）。
   */
  findingsSnapshot({ teamKey = null, force = false } = {}) {
    const revision = `${this.revision}:${this.works.size}:${this.attempts.size}:${this.evidenceRecords.size}:${this.works.size}`;
    if (!force && this.findingsCache && this.findingsCacheRevision === revision && !teamKey) return this.findingsCache;
    const findings = buildFindings({
      works: [...this.works.values()],
      attempts: [...this.attempts.values()],
      evidenceRecords: [...this.evidenceRecords.values()],
      invalidations: this.evidenceInvalidations,
      now: this.clock.now(),
      teamKey,
    });
    if (!teamKey) {
      this.findingsCache = findings;
      this.findingsCacheRevision = revision;
    }
    return findings;
  }

  /** 错误指纹聚合（只读；不进模型上下文）。 */
  errorFingerprintSnapshot({ teamKey = null, limit = 50 } = {}) {
    // 历史无 teamKey 的指纹：按稳定 work 关联只读回填（不修改历史记录）。
    const resolveTeamKey = (workId) => this.works.get(String(workId))?.teamKey ?? null;
    return this.fingerprints.snapshot({ teamKey, limit, resolveTeamKey });
  }

  /**
   * `POST /op client-ack`：接收前端**已挂载**回执（纯元数据；幂等）。
   *
   * 语义边界（写进返回与 /state，避免被当成验收结论）：
   * - 只证明"前端已挂载并报告该 bundle（url+activatedAt）"；
   * - **不等于视觉验收**，也**不等于 Host 已加载新代码**。
   */
  async recordFrontendAck(caller, request = {}) {
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    const bundle = request?.bundle && typeof request.bundle === 'object' ? request.bundle : {};
    const bundleUrl = typeof bundle.url === 'string' && bundle.url.trim() ? bundle.url.trim() : null;
    if (!bundleUrl) return denied('ACK_BUNDLE_REQUIRED', 'client-ack 必须给 bundle.url（前端实际加载的 bundle 地址）。');
    const activatedAt = Number.isFinite(Number(bundle.activatedAt)) ? Number(bundle.activatedAt) : null;
    const key = `${bundleUrl}|${activatedAt ?? 'unknown'}`;
    const now = this.clock.now();
    const prior = this.frontendAckIndex.get(key);
    const record = prior
      ? { ...prior, lastAckAt: now, count: (prior.count ?? 1) + 1 }
      : {
        bundleUrl,
        activatedAt,
        firstAckAt: now,
        lastAckAt: now,
        mounted: request?.mounted === true,
        detailTransport: request?.detailTransport && typeof request.detailTransport === 'object' ? { ...request.detailTransport } : null,
        frontendRev: typeof request?.frontendRev === 'string' ? request.frontendRev : null,
        count: 1,
        acknowledgedBy: actor.memberId ?? actor.role ?? null,
      };
    this.frontendAckIndex.set(key, record);
    // 持久化（升级后走 sidecar `meta_records`；旧 storage 不接受新表时保持内存并标记未持久化）。
    let persisted = false;
    try {
      const stored = await this.storage.put('meta_records', `frontend_ack:${key}`, record);
      persisted = stored?.ok === true;
    } catch {
      persisted = false;
    }
    record.persisted = persisted;
    this.frontendAckIndex.set(key, record);
    this.diagnostics.push('service:frontendAck', `${bundleUrl}${activatedAt ? `@${activatedAt}` : ''}（${prior ? '重复 ack 去重' : '首次 ack'}，persisted=${persisted}）`);
    return {
      ok: true,
      deduplicated: Boolean(prior),
      persisted,
      ack: record,
      frontendAck: this.frontendAckView(),
      maintenance: this.maintenanceView(),
      note: 'ack 只证明前端已挂载并报告该 bundle；不等于视觉验收，也不等于 Host 已加载新代码。',
    };
  }

  /** `/state.frontendAck` 只读形状（供 Codex/Lead 判定「发布 rev → 实际加载」）。 */
  /**
   * **官方维护压缩路径**（Lead 第 15/24 回合 B）。
   *
   * 复用 Genshin dispatch-repair 的防护逻辑（只复接口/逻辑，不安装插件、不改全局压缩配置）：
   * - 目标必须是**真实成员**，调用方只能是 lead/root；owner 不得在自己工具回合自压缩。
   * - 官方服务必须按**目标 agent 的 preset 作用域**取：`agentPresets.serviceFor(agent,'compaction')`
   *   （根 `ctx.get('compaction')` 在 isolate 配置下不是原 agent 的精确服务）；老 profile 才回退根服务。
   * - 真实检查：native `inbox.hasPending`、native 未结束 turn（session 事件/state.openTurn）、
   *   `seq` 已知且与调用方 `expectedSeq` 精确相等（CAS）。
   * - `expectedSeq` **必填**；`compactNow` 的 `outcome===undefined` **绝不能**记 COMPACTED。
   * - `requestKey` 的 receipt 持久化到 sidecar `meta_records`：done 之后的同 key 重放**只返回原 receipt**，
   *   不会再次触发压缩/费用；inflight 重入明确拒绝。
   * - 冷目标：members 表里的 session 不在 live agents 时，先按原生生命周期 `ensureLiveAgent` 恢复
   *   （保留 handle），失败才明确 `MAINTENANCE_TARGET_NOT_LIVE`；不伪造 agent。
   */
  /** 目标 agent 的精确 compaction 服务：先 preset 作用域（官方 agentPresets.serviceFor），再回退根服务。 */
  compactionServiceFor(agent) {
    if (typeof this.adapter?.serviceFor === 'function' && agent) {
      const scoped = this.adapter.serviceFor(agent, 'compaction');
      if (scoped !== undefined && typeof scoped?.compactNow === 'function') {
        return { ok: true, service: scoped, via: 'agentPresets.serviceFor', scoped: true };
      }
    }
    const presets = typeof this.ctx?.get === 'function' ? this.ctx.get('agentPresets') : undefined;
    if (presets && typeof presets.serviceFor === 'function' && agent) {
      try {
        const scoped = presets.serviceFor(agent, 'compaction');
        if (scoped !== undefined) return { ok: true, service: scoped, via: 'agentPresets.serviceFor', scoped: true };
      } catch (error) {
        this.diagnostics.push('service:maintenance:preset-service-failed', String(error?.message ?? error));
      }
    }
    const root = typeof this.ctx?.get === 'function' ? this.ctx.get('compaction') : undefined;
    if (root && typeof root.compactNow === 'function') return { ok: true, service: root, via: 'ctx.get(compaction)', scoped: false };
    return { ok: false, code: 'COMPACTION_UNAVAILABLE', service: null, via: null, scoped: false };
  }

  /** native 未结束 turn：读 session 事件（turn/start 无对应 turn/end）或已暴露的 openTurn 状态。 */
  nativeUnfinishedTurn(agent) {
    const direct = agent?.openTurn ?? agent?.session?.openTurn ?? agent?.session?.state?.openTurn ?? null;
    if (direct) return { open: true, source: 'state.openTurn', turn: typeof direct === 'object' ? (direct.turn ?? null) : direct };
    let events = null;
    try {
      if (typeof agent?.session?.snapshotEvents === 'function') events = agent.session.snapshotEvents(0);
    } catch {
      events = null;
    }
    if (!Array.isArray(events)) return { open: false, source: 'unavailable', turn: null };
    const open = new Map();
    for (const event of events) {
      const type = String(event?.type ?? '');
      const turn = event?.data?.turn ?? event?.turn ?? event?.seq ?? null;
      if (type === 'turn/start') open.set(String(turn), true);
      else if (type === 'turn/end' || type === 'turn/cancel') open.delete(String(turn));
    }
    if (open.size === 0) return { open: false, source: 'events', turn: null };
    return { open: true, source: 'events', turn: [...open.keys()][0] };
  }

  maintenanceReceiptKey(member, requestKey) {
    return `maintenance:${member?.sessionId ?? member?.memberId ?? 'unknown'}:${requestKey}`;
  }

  async readMaintenanceReceipt(key) {
    try {
      const stored = this.storage.get('meta_records', key);
      return stored && typeof stored === 'object' ? stored : null;
    } catch {
      return null;
    }
  }

  async persistMaintenanceReceipt(key, receipt) {
    try {
      const stored = await this.storage.put('meta_records', key, { ...receipt, updatedAt: this.clock.now() }, { idempotencyKey: `maintenance:${key}:${receipt.status}` });
      return {
        ok: stored?.ok === true,
        record: stored?.record ?? receipt,
        // 幂等键命中说明**另一个调用者**已经写过同 key 的同状态 intent（并发抢占），调用方必须放弃触发。
        deduplicated: stored?.deduplicated === true,
      };
    } catch (error) {
      return { ok: false, code: 'MAINTENANCE_RECEIPT_NOT_PERSISTED', message: String(error?.message ?? error) };
    }
  }

  /**
   * **原生日志核对**（触发后结果未知/失败时不做同 key 重放）：
   * 在目标 session 的事件里找 `compaction/summary`（seq > seqBefore）作为维护真实发生的回执。
   */
  verifyMaintenanceFromNative(agent, receipt = {}) {
    const seqBefore = Number.isInteger(receipt?.seqBefore) ? receipt.seqBefore : null;
    if (!agent || typeof agent.session?.snapshotEvents !== 'function') return { found: false, reason: 'EVENTS_UNAVAILABLE' };
    let events = null;
    try {
      events = agent.session.snapshotEvents(seqBefore !== null ? Math.max(0, seqBefore - 1) : 0);
    } catch (error) {
      return { found: false, reason: 'READ_FAILED', message: String(error?.message ?? error) };
    }
    if (!Array.isArray(events)) return { found: false, reason: 'EVENTS_UNAVAILABLE' };
    const summary = [...events].reverse().find((event) => {
      const type = String(event?.type ?? '');
      if (!type.includes('compaction/summary')) return false;
      const seq = Number(event?.seq);
      return seqBefore === null ? true : Number.isFinite(seq) && seq > seqBefore;
    });
    if (!summary) return { found: false, reason: 'NO_SUMMARY_AFTER_SEQ', checked: events.length };
    const data = summary.data ?? {};
    return {
      found: true,
      summarySeq: Number(summary.seq),
      endSeq: Number.isInteger(data.endSeq) ? data.endSeq : null,
      compactionId: data.compactionId ?? data.compaction?.id ?? receipt?.compactionId ?? null,
      type: String(summary.type),
      nativeEvent: { seq: summary.seq, type: String(summary.type) },
    };
  }

  /** 最后同步复核（不得夹 await）：目标身份 / inbox / 未结束 turn / seq CAS 必须仍是同一状态。 */
  maintenancePreflightSync(member, expectedSeq) {
    const listed = typeof this.adapter.listAgents === 'function' ? this.adapter.listAgents() : [];
    const agents = Array.isArray(listed) ? listed : (listed?.ok && Array.isArray(listed.value) ? listed.value : []);
    const agent = agents.find((entry) => String(entry?.id ?? '') === String(member.sessionId)) ?? null;
    if (!agent) return { ok: false, code: 'MAINTENANCE_TARGET_NOT_LIVE', detail: { sessionId: String(member.sessionId) } };
    const unfinished = this.nativeUnfinishedTurn(agent);
    const busy = agent?.busy === true
      || agent?.openTurn === true
      || agent?.session?.openTurn === true
      || agent?.inbox?.hasPending === true
      || String(agent?.status ?? '').toLowerCase() === 'running'
      || unfinished.open === true;
    if (busy) return { ok: false, code: 'MAINTENANCE_AGENT_BUSY', detail: { status: agent?.status ?? null, inboxPending: agent?.inbox?.hasPending === true, unfinished } };
    const pending = this.pendingEvents(member.teamKey, member.memberId);
    if (pending.length > 0) return { ok: false, code: 'MAINTENANCE_QUEUE_NOT_EMPTY', detail: { pending: pending.length } };
    const turn = this.memberTurnState(member.teamKey, member.memberId);
    if (!turn || turn.inFlight === true) return { ok: false, code: 'MAINTENANCE_NOT_IDLE', detail: { turn: turn ? 'running' : null } };
    const seq = Number.isInteger(agent.session?.seq) ? agent.session.seq : null;
    if (seq === null) return { ok: false, code: 'MAINTENANCE_SEQ_UNKNOWN', detail: {} };
    if (seq !== Number(expectedSeq)) return { ok: false, code: 'MAINTENANCE_SEQ_MISMATCH', detail: { seqBefore: seq, expectedSeq } };
    return { ok: true, agent, seq };
  }

  async requestMaintenance(caller, request = {}) {
    // 同进程内维护请求串行：先读 receipt → I/O 持久 intent → 最后同步复核 → 调官方 compactNow；
    // 避免两个并发同 target/key 请求都通过前置检查后各自触发一次维护。
    const run = this.maintenanceChain.then(
      () => this.requestMaintenanceInLock(caller, request),
      () => this.requestMaintenanceInLock(caller, request),
    );
    this.maintenanceChain = run.then(() => undefined, () => undefined);
    return run;
  }

  async requestMaintenanceInLock(caller, request = {}) {
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    if (actor.role !== 'lead' && actor.role !== 'root') {
      return denied('TEAM_LEAD_REQUIRED', '维护压缩只允许 lead/用户入口触发（owner 不得在自己工具回合自压缩）。');
    }
    const teamKey = this.resolveTeamKey(actor, request.teamKey);
    const memberId = typeof request.memberId === 'string' && request.memberId ? request.memberId : null;
    const member = memberId
      ? this.members.get(this.memberKey(teamKey, memberId))
      : [...this.members.values()].find((entry) => entry.teamKey === teamKey && String(entry.sessionId) === String(request.sessionId ?? ''));
    if (!member) return denied('MEMBER_NOT_FOUND', '维护压缩必须指定真实成员（memberId 或 sessionId）。');
    const at = this.clock.now();
    const record = (allowed, reason, extra = {}) => {
      const entry = { allowed, reason, at, memberId: member.memberId, sessionId: member.sessionId, ...extra };
      this.maintenanceLog.push(entry);
      if (this.maintenanceLog.length > 50) this.maintenanceLog.shift();
      this.diagnostics.push('service:maintenance', `${member.memberId}: ${allowed ? 'allowed' : `denied(${reason})`}${entry.seqBefore === undefined ? '' : ` seq ${entry.seqBefore}→${entry.seqAfter}`}`);
      return entry;
    };
    // ① expectedSeq 必填（CAS 前置；未知/缺省不得盲压缩）。
    if (!Number.isInteger(request.expectedSeq)) {
      return { ok: false, code: 'MAINTENANCE_EXPECTED_SEQ_REQUIRED', maintenance: record(false, 'EXPECTED_SEQ_REQUIRED', {}), hint: '维护压缩必须给 expectedSeq（目标 session 当前 seq，CAS 不匹配则拒绝）。' };
    }
    // ② owner 自身工具回合禁止自压缩：调用方 agent 就是目标 agent → 拒绝。
    const callerAgentId = String(actor?.agent?.id ?? actor?.sessionId ?? '');
    if (callerAgentId && callerAgentId === String(member.sessionId)) {
      return { ok: false, code: 'MAINTENANCE_SELF_TURN_FORBIDDEN', maintenance: record(false, 'SELF_TURN', { callerAgentId }) };
    }
    // ③ 目标 agent：live 优先；冷目标按原生生命周期恢复（不是伪造 agent）。
    const listAgents = () => {
      const listed = typeof this.adapter.listAgents === 'function' ? this.adapter.listAgents() : [];
      return Array.isArray(listed) ? listed : (listed?.ok && Array.isArray(listed.value) ? listed.value : []);
    };
    let agent = listAgents().find((entry) => String(entry?.id ?? '') === String(member.sessionId));
    let coldResume = null;
    if (!agent && typeof this.adapter.ensureLiveAgent === 'function') {
      try {
        const resumed = await this.adapter.ensureLiveAgent(String(member.sessionId));
        if (resumed?.ok === true && resumed.value?.agent) {
          agent = resumed.value.agent;
          coldResume = { resumed: resumed.value.resumed === true };
          if (resumed.value.resumed === true && resumed.value.handle !== undefined) {
            this.resumedAgentHandles = this.resumedAgentHandles ?? new Map();
            this.resumedAgentHandles.set(String(member.sessionId), resumed.value.handle);
          }
        } else {
          coldResume = { resumed: false, code: resumed?.code ?? null };
        }
      } catch (error) {
        coldResume = { resumed: false, code: 'COLD_RESUME_FAILED', message: String(error?.message ?? error) };
      }
    }
    if (!agent) {
      return { ok: false, code: 'MAINTENANCE_TARGET_NOT_LIVE', coldResume, maintenance: record(false, 'TARGET_NOT_LIVE', { coldResume }), hint: '目标会话当前不是 live agent：等它按正常生命周期恢复后再维护；不要另建 owner 或重建会话。' };
    }
    // ④ 持久 receipt：done → 回放原 receipt（不重新触发）；inflight → 明确拒绝。
    const requestKey = typeof request.requestKey === 'string' && request.requestKey.trim()
      ? request.requestKey.trim()
      : `twb-maint-${member.memberId}-${request.expectedSeq}`;
    const receiptKey = this.maintenanceReceiptKey(member, requestKey);
    const priorReceipt = await this.readMaintenanceReceipt(receiptKey);
    if (priorReceipt?.status === 'done') {
      const replayed = record(true, 'REPLAYED', { requestKey, seqBefore: priorReceipt.seqBefore ?? null, seqAfter: priorReceipt.seqAfter ?? null, replayed: true });
      return { ok: true, replayed: true, requestKey, receipt: priorReceipt, maintenance: replayed, note: '同一 requestKey 已完成过：原样回放持久 receipt，没有再次压缩/计费。' };
    }
    if (priorReceipt?.status === 'inflight') {
      return { ok: false, code: 'MAINTENANCE_IN_FLIGHT', requestKey, receipt: priorReceipt, maintenance: record(false, 'IN_FLIGHT', { requestKey }) };
    }
    if (priorReceipt && priorReceipt.status !== 'aborted') {
      // 除 done/inflight 外，**同 key 不允许再次触发**：先读原生日志核对上次是否真的压缩过。
      const nativeCheck = this.verifyMaintenanceFromNative(agent, priorReceipt);
      if (nativeCheck.found) {
        const corrected = {
          ...priorReceipt,
          status: 'done',
          summarySeq: nativeCheck.summarySeq ?? priorReceipt.summarySeq ?? null,
          endSeq: nativeCheck.endSeq ?? priorReceipt.endSeq ?? null,
          compactionId: nativeCheck.compactionId ?? priorReceipt.compactionId ?? null,
          recoveredFromNativeLog: nativeCheck,
          recoveredAt: this.clock.now(),
        };
        await this.persistMaintenanceReceipt(receiptKey, corrected);
        const replayed = record(true, 'REPLAYED_RECOVERED', { requestKey, seqBefore: corrected.seqBefore ?? null, seqAfter: corrected.seqAfter ?? null, replayed: true, summarySeq: corrected.summarySeq });
        return { ok: true, replayed: true, recovered: true, requestKey, receipt: corrected, maintenance: replayed, note: '同 key 之前的结果不确定；原生日志里找到真实 compaction/summary，已回填 done receipt（没有再次触发压缩）。' };
      }
      if (priorReceipt.status === 'empty') {
        const replayed = record(false, 'REPLAYED_EMPTY', { requestKey, seqBefore: priorReceipt.seqBefore ?? null, replayed: true });
        return { ok: false, code: 'NOTHING_TO_COMPACT', replayed: true, requestKey, receipt: priorReceipt, maintenance: replayed, nativeCheck, note: '同一 requestKey 上次判定无可压缩范围：不重复触发；需要重试请用新的 requestKey。' };
      }
      // unknown / unverified / failed / unresolved：原生日志也没有 summary → 不允许同 key 重放触发。
      const unresolved = { ...priorReceipt, status: 'unresolved', nativeCheck, nativeCheckedAt: this.clock.now() };
      await this.persistMaintenanceReceipt(receiptKey, unresolved);
      const replayed = record(false, 'UNRECOVERABLE_REPLAY', { requestKey, seqBefore: priorReceipt.seqBefore ?? null, replayed: true });
      return {
        ok: false,
        code: 'MAINTENANCE_OUTCOME_UNRECOVERABLE',
        replayed: true,
        requestKey,
        receipt: unresolved,
        nativeCheck,
        maintenance: replayed,
        hint: '同 requestKey 已触发过维护且原生日志未找到真实 summary 回执：先按原生日志/会话核对，再用**新的 requestKey** 重试；不允许相同 key 重复触发（避免重复费用）。',
      };
    }    // ⑤ 真实 native 忙碌/待处理/未结束 turn（不能只看 status=running）。
    const unfinished = this.nativeUnfinishedTurn(agent);
    const nativeBusy = agent?.busy === true
      || agent?.openTurn === true
      || agent?.session?.openTurn === true
      || agent?.session?.pending === true
      || agent?.inbox?.hasPending === true
      || (Number.isInteger(agent?.pendingRequests) && agent.pendingRequests > 0)
      || String(agent?.status ?? '').toLowerCase() === 'running'
      || unfinished.open === true;
    if (nativeBusy) {
      return { ok: false, code: 'MAINTENANCE_AGENT_BUSY', maintenance: record(false, 'NATIVE_BUSY', { status: agent?.status ?? null, inboxPending: agent?.inbox?.hasPending === true, unfinished }) };
    }
    const pending = this.pendingEvents(member.teamKey, member.memberId);
    if (pending.length > 0) return { ok: false, code: 'MAINTENANCE_QUEUE_NOT_EMPTY', maintenance: record(false, 'QUEUE_NOT_EMPTY', { pending: pending.length }) };
    // 真实合同：memberTurnState(teamKey, memberId) 是**方法**（不是 Map）。inFlight===false 才是 idle。
    const turn = this.memberTurnState(member.teamKey, member.memberId);
    const turnState = turn?.inFlight === true ? 'running' : (turn ? 'idle' : null);
    if (turnState !== 'idle') return { ok: false, code: 'MAINTENANCE_NOT_IDLE', maintenance: record(false, turnState ? 'NOT_IDLE' : 'IDLE_UNVERIFIED', { turnState }) };
    const seqBefore = Number.isInteger(agent.session?.seq) ? agent.session.seq : null;
    // 未知 seq 不做盲压缩：没有可 CAS 的序号就拒绝（避免与在途写入竞争）。
    if (seqBefore === null) return { ok: false, code: 'MAINTENANCE_SEQ_UNKNOWN', maintenance: record(false, 'SEQ_UNKNOWN', {}) };
    if (seqBefore !== Number(request.expectedSeq)) {
      return { ok: false, code: 'MAINTENANCE_SEQ_MISMATCH', maintenance: record(false, 'SEQ_MISMATCH', { seqBefore, expectedSeq: request.expectedSeq }) };
    }
    // ⑥ 官方维护服务：按目标 agent preset 作用域取（隔离组），根服务只作老 profile 回退。
    const resolved = this.compactionServiceFor(agent);
    if (resolved.ok !== true) {
      return { ok: false, code: resolved.code ?? 'COMPACTION_UNAVAILABLE', maintenance: record(false, 'COMPACTION_UNAVAILABLE', { seqBefore }) };
    }
    const compaction = resolved.service;
    if (typeof compaction?.compactNow !== 'function') {
      return { ok: false, code: 'COMPACTION_UNAVAILABLE', maintenance: record(false, 'COMPACTION_UNAVAILABLE', { seqBefore, via: resolved.via }) };
    }
    if (typeof agent.runMaintenance !== 'function') {
      return { ok: false, code: 'MAINTENANCE_API_UNAVAILABLE', maintenance: record(false, 'MAINTENANCE_API_UNAVAILABLE', { seqBefore }) };
    }
    const signal = request.signal ?? new AbortController().signal;
    // ⑦ 先持久 inflight receipt（没有持久 once 保证就不触发压缩）。
    const claimId = `claim-${this.clock.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const inflight = await this.persistMaintenanceReceipt(receiptKey, {
      status: 'inflight', claimId, requestKey, memberId: member.memberId, sessionId: String(member.sessionId), seqBefore, at, via: resolved.via, scoped: resolved.scoped === true,
    });
    if (inflight.ok !== true) {
      return { ok: false, code: 'MAINTENANCE_RECEIPT_NOT_PERSISTED', message: inflight.message ?? '维护 receipt 未能持久化：不触发压缩（否则重启后可能重复计费）。', maintenance: record(false, 'RECEIPT_NOT_PERSISTED', { requestKey }) };
    }
    // 并发 CAS：同 key 的 inflight 已被另一个调用者写入（幂等键命中或 claimId 不符）→ 本次不得触发。
    if (inflight.deduplicated === true || (inflight.record?.claimId && inflight.record.claimId !== claimId)) {
      return { ok: false, code: 'MAINTENANCE_IN_FLIGHT', requestKey, receipt: inflight.record, maintenance: record(false, 'IN_FLIGHT_RACE', { requestKey }) };
    }
    // ---- 最后同步复核（I/O 期间目标可能变化；此后不得 await 再调官方维护）----
    const finalCheck = this.maintenancePreflightSync(member, request.expectedSeq);
    if (finalCheck.ok !== true) {
      await this.persistMaintenanceReceipt(receiptKey, { status: 'aborted', claimId, requestKey, memberId: member.memberId, sessionId: String(member.sessionId), seqBefore, at, via: resolved.via, abortCode: finalCheck.code, abortDetail: finalCheck.detail ?? null });
      return { ok: false, code: finalCheck.code, maintenance: record(false, 'ABORTED_BEFORE_TRIGGER', { requestKey, abortCode: finalCheck.code, detail: finalCheck.detail ?? null }), hint: '持久 intent 后目标状态已变化：已中止、未触发维护；同 key 可安全重试（aborted 不视为已触发）。' };
    }
    const finalAgent = finalCheck.agent ?? agent;
    const finalResolved = this.compactionServiceFor(finalAgent);
    if (finalResolved.ok !== true || typeof finalResolved.service?.compactNow !== 'function') {
      await this.persistMaintenanceReceipt(receiptKey, { status: 'aborted', claimId, requestKey, memberId: member.memberId, sessionId: String(member.sessionId), seqBefore, at, via: finalResolved.via ?? resolved.via, abortCode: 'COMPACTION_UNAVAILABLE' });
      return { ok: false, code: 'COMPACTION_UNAVAILABLE', maintenance: record(false, 'COMPACTION_UNAVAILABLE', { seqBefore, via: finalResolved.via ?? resolved.via }) };
    }
    const finalCompaction = finalResolved.service;
    try {
      // 官方 `compactNow` **自己**执行 `agent.runMaintenance`（dsh-compaction-basic/lib/index.js:985）；
      // 这里再嵌一层会产生嵌套 busy，因此直接调用。占用/进行中由 compactNow 内部检查。
      const outcome = await finalCompaction.compactNow(finalAgent, signal, requestKey);
      const seqAfter = Number.isInteger(agent.session?.seq) ? agent.session.seq : null;
      if (outcome === null) {
        // outcome===null = 无可压缩范围：不得记 COMPACTED 成功；允许同 key 重新评估。
        await this.persistMaintenanceReceipt(receiptKey, { status: 'empty', requestKey, memberId: member.memberId, sessionId: String(member.sessionId), seqBefore, seqAfter, at, via: resolved.via, scoped: resolved.scoped === true });
        return { ok: false, code: 'NOTHING_TO_COMPACT', maintenance: record(false, 'NOTHING_TO_COMPACT', { seqBefore, seqAfter, requestKey }) };
      }
      // **undefined/坏形状不得记 COMPACTED**：官方成功回执必须带 summarySeq/endSeq。
      if (outcome === undefined || outcome === null || typeof outcome !== 'object') {
        await this.persistMaintenanceReceipt(receiptKey, { status: 'unknown', requestKey, memberId: member.memberId, sessionId: String(member.sessionId), seqBefore, seqAfter, at, via: resolved.via });
        return { ok: false, code: 'MAINTENANCE_OUTCOME_UNKNOWN', maintenance: record(false, 'OUTCOME_UNKNOWN', { seqBefore, seqAfter, requestKey, outcomeKind: outcome === undefined ? 'undefined' : typeof outcome }) };
      }
      const summarySeq = Number.isInteger(outcome.summarySeq) ? outcome.summarySeq : null;
      const endSeq = Number.isInteger(outcome.endSeq) ? outcome.endSeq : null;
      if (summarySeq === null || endSeq === null) {
        await this.persistMaintenanceReceipt(receiptKey, { status: 'unverified', requestKey, memberId: member.memberId, sessionId: String(member.sessionId), seqBefore, seqAfter, at, via: resolved.via });
        return { ok: false, code: 'MAINTENANCE_SUMMARY_UNVERIFIED', maintenance: record(false, 'SUMMARY_UNVERIFIED', { seqBefore, seqAfter, requestKey, summarySeq, endSeq }) };
      }
      // 原生 summary 回执：能读事件时核对真实存在 compaction/summary（读不到不伪造，明确 readback=unavailable）。
      let summaryReadback = { ok: null, reason: 'UNAVAILABLE' };
      try {
        if (typeof agent.session?.snapshotEvents === 'function') {
          const events = agent.session.snapshotEvents(Math.max(0, summarySeq - 2));
          if (Array.isArray(events)) {
            const hit = events.find((event) => String(event?.type ?? '').startsWith('compaction/') && Number(event?.seq) === summarySeq);
            summaryReadback = hit ? { ok: true, seq: summarySeq, type: String(hit.type) } : { ok: false, reason: 'SUMMARY_EVENT_NOT_FOUND' };
          }
        }
      } catch (error) {
        summaryReadback = { ok: null, reason: 'READBACK_FAILED', message: String(error?.message ?? error) };
      }
      const receipt = {
        status: 'done', requestKey, memberId: member.memberId, sessionId: String(member.sessionId),
        seqBefore, seqAfter, at, via: resolved.via, scoped: resolved.scoped === true,
        compactionId: outcome.compactionId ?? null, startSeq: outcome.startSeq ?? null, summarySeq, endSeq,
        shadowedSeqs: Array.isArray(outcome.shadowedSeqs) ? outcome.shadowedSeqs : [],
        shadowedTokenCount: Number.isFinite(outcome.shadowedTokenCount) ? outcome.shadowedTokenCount : null,
        summaryReadback,
      };
      const persisted = await this.persistMaintenanceReceipt(receiptKey, receipt);
      record(true, 'COMPACTED', { seqBefore, seqAfter, requestKey, via: resolved.via, scoped: resolved.scoped === true, summarySeq, endSeq, summaryReadback: summaryReadback.ok ?? null });
      if (persisted.ok !== true) {
        return { ok: false, code: 'MAINTENANCE_RECEIPT_NOT_PERSISTED', message: '压缩已发生但 receipt 未能持久化：重启后无法回放，需显式核查。', receipt, maintenance: this.maintenanceLog[this.maintenanceLog.length - 1] };
      }
      return { ok: true, replayed: false, requestKey, receipt, maintenance: this.maintenanceLog[this.maintenanceLog.length - 1], note: '经目标 agent 的官方 compactNow 完成维护压缩（其内部执行 runMaintenance，保留队列）；持久 receipt 已写入 meta_records。' };
    } catch (error) {
      await this.persistMaintenanceReceipt(receiptKey, { status: 'failed', requestKey, memberId: member.memberId, sessionId: String(member.sessionId), seqBefore, at, via: resolved.via, error: String(error?.message ?? error) });
      return { ok: false, code: 'COMPACTION_FAILED', message: String(error?.message ?? error), maintenance: record(false, 'COMPACTION_FAILED', { seqBefore, requestKey, error: String(error?.message ?? error) }) };
    }
  }

  /** 只读维护检查（lead/root）：不触发压缩，给正常产品路径/面板核对前置事实。 */
  async maintenanceInspect(caller, request = {}) {
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    if (actor.role !== 'lead' && actor.role !== 'root') return denied('TEAM_LEAD_REQUIRED', '维护检查只允许 lead/用户入口。');
    const teamKey = this.resolveTeamKey(actor, request.teamKey);
    const memberId = typeof request.memberId === 'string' && request.memberId ? request.memberId : null;
    const member = memberId
      ? this.members.get(this.memberKey(teamKey, memberId))
      : [...this.members.values()].find((entry) => entry.teamKey === teamKey && String(entry.sessionId) === String(request.sessionId ?? ''));
    if (!member) return denied('MEMBER_NOT_FOUND', '维护检查必须指定真实成员（memberId 或 sessionId）。');
    const listed = typeof this.adapter.listAgents === 'function' ? this.adapter.listAgents() : [];
    const agents = Array.isArray(listed) ? listed : (listed?.ok && Array.isArray(listed.value) ? listed.value : []);
    const agent = agents.find((entry) => String(entry?.id ?? '') === String(member.sessionId)) ?? null;
    const unfinished = agent ? this.nativeUnfinishedTurn(agent) : { open: null, source: 'target-not-live' };
    const resolved = agent ? this.compactionServiceFor(agent) : { ok: false, code: 'TARGET_NOT_LIVE', via: null, scoped: false };
    const requestKey = typeof request.requestKey === 'string' && request.requestKey.trim() ? request.requestKey.trim() : null;
    const receipt = requestKey ? await this.readMaintenanceReceipt(this.maintenanceReceiptKey(member, requestKey)) : null;
    const turn = this.memberTurnState(member.teamKey, member.memberId);
    return {
      ok: true,
      readOnly: true,
      target: { memberId: member.memberId, sessionId: String(member.sessionId), live: Boolean(agent) },
      preset: agent && typeof this.ctx?.get === 'function' && this.ctx.get('agentPresets')?.composedPreset
        ? (() => { try { return this.ctx.get('agentPresets').composedPreset(agent) ?? null; } catch { return null; } })()
        : null,
      seq: agent && Number.isInteger(agent.session?.seq) ? agent.session.seq : null,
      expectedSeq: Number.isInteger(request.expectedSeq) ? request.expectedSeq : null,
      inboxHasPending: agent?.inbox?.hasPending === true,
      unfinishedTurn: unfinished,
      sidecarTurn: turn ? { inFlight: turn.inFlight === true } : null,
      pendingEvents: this.pendingEvents(member.teamKey, member.memberId).length,
      compaction: { available: resolved.ok === true, via: resolved.via ?? null, scoped: resolved.scoped === true, code: resolved.code ?? null },
      receipt,
      note: '只读检查：不触发压缩、不产生费用、不改 agent/队列；压缩必须由 team_maintenance(compact) 或 /op maintenance 以 expectedSeq+requestKey 触发。',
    };
  }

  /** `/state.maintenance` 只读：维护路径可用性与最近记录（不伪造 available）。 */
  maintenanceView() {
    const presets = typeof this.ctx?.get === 'function' ? this.ctx.get('agentPresets') : undefined;
    const presetPath = Boolean(presets && typeof presets.serviceFor === 'function');
    const root = typeof this.ctx?.get === 'function' ? this.ctx.get('compaction') : undefined;
    const rootAvailable = Boolean(root && typeof root.compactNow === 'function');
    const available = presetPath || rootAvailable;
    return {
      available,
      reason: available ? null : 'COMPACTION_UNAVAILABLE',
      // 说明真实解析顺序：先目标 agent 的 preset 作用域，再老 profile 的根服务。
      path: presetPath ? 'agentPresets.serviceFor(agent, "compaction").compactNow → agent.runMaintenance' : 'agent.runMaintenance → ctx.get("compaction").compactNow',
      via: presetPath ? 'agentPresets.serviceFor' : (rootAvailable ? 'ctx.get(compaction)' : null),
      scoped: presetPath,
      entries: [
        { kind: 'tool', name: 'team_maintenance', ops: ['inspect', 'compact'], permission: 'lead/root only' },
        { kind: 'web', path: '/op', op: 'maintenance', permission: 'lead/root only' },
      ],
      requires: ['expectedSeq（必填，CAS）', 'requestKey（持久 once，可重放 receipt）', 'target idle + inbox 空 + 无未结束 turn'],
      count: this.maintenanceLog.length,
      last: this.maintenanceLog.length > 0 ? this.maintenanceLog[this.maintenanceLog.length - 1] : null,
      recent: this.maintenanceLog.slice(-5),
      note: '维护压缩只从维护路径触发（lead/用户入口）；owner 工具回合禁止自压缩、禁止取消回合；不安装额外插件、不改全局压缩配置。',
    };
  }

  frontendAckView() {
    const rows = [...this.frontendAckIndex.values()];
    const persistenceNote = '（升级前 ack 只存内存、不持久；热升级后经 sidecar `meta_records` 持久化。）';
    if (rows.length === 0) {
      return { mounted: false, bundleUrl: null, activatedAt: null, firstAckAt: null, lastAckAt: null, rev: null, count: 0, uniqueBundles: 0, persisted: false, note: `尚无前端激活回执（client-ack）。${persistenceNote}` };
    }
    const latest = rows.slice().sort((left, right) => (right.lastAckAt ?? 0) - (left.lastAckAt ?? 0))[0];
    return {
      mounted: rows.some((row) => row.mounted === true),
      bundleUrl: latest.bundleUrl ?? null,
      activatedAt: latest.activatedAt ?? null,
      firstAckAt: Math.min(...rows.map((row) => row.firstAckAt ?? 0)) || null,
      lastAckAt: Math.max(...rows.map((row) => row.lastAckAt ?? 0)) || null,
      rev: latest.frontendRev ?? null,
      count: rows.reduce((sum, row) => sum + (row.count ?? 1), 0),
      uniqueBundles: rows.length,
      // 逐条持久化标记：只要有一条没能落 sidecar，就在这里如实说"不持久"。
      persisted: rows.length > 0 && rows.every((row) => row.persisted !== false),
      unpersistedAcks: rows.filter((row) => row.persisted === false).length,
      detailTransport: latest.detailTransport ?? null,
      note: `ack 只证明前端已挂载并报告该 bundle；不等于视觉验收，也不等于 Host 已加载新代码。${persistenceNote}`,
    };
  }

  /**
   * CONTRACT v2 §7.2：`GET /state/detail` 的只读分页实现（findings|errors|usage）。
   * 只读、分页、不触发模型调用；不在这里做全量深拷贝（只切页）。
   */
  stateDetail(query = {}) {
    const section = String(query.section ?? 'findings');
    const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
    const pageSize = Math.min(Math.max(Number.parseInt(query.pageSize ?? '20', 10) || 20, 1), 50);
    const ownerMemberId = typeof query.ownerMemberId === 'string' && query.ownerMemberId ? query.ownerMemberId : null;
    const teamKey = typeof query.teamKey === 'string' && query.teamKey ? query.teamKey : null;
    const slice = (rows) => {
      const filtered = ownerMemberId
        ? rows.filter((row) => String(row.ownerMemberId ?? row.memberId ?? '') === ownerMemberId)
        : rows;
      const total = filtered.length;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      return { total, pages, items: filtered.slice((page - 1) * pageSize, page * pageSize) };
    };
    if (section === 'findings') {
      const kind = String(query.kind ?? 'verified');
      const findings = this.findingsSnapshot({ teamKey });
      const result = findingsDetailPage(findings, { kind, page, pageSize, ownerMemberId, teamKey });
      if (!result.ok) return { ok: false, code: result.code, section, kind, page, pageSize };
      return { ok: true, section, kind, page, pageSize, pages: result.pages, total: result.total, items: result.items };
    }
    if (section === 'errors') {
      const snapshot = this.errorFingerprintSnapshot({ teamKey, limit: 500 });
      const pageResult = slice(snapshot.groups ?? []);
      return { ok: true, section, kind: 'errors', page, pageSize, pages: pageResult.pages, total: pageResult.total, items: pageResult.items };
    }
    if (section === 'usage') {
      const usage = this.usageSnapshot({ teamKey });
      const usageKind = String(query.kind ?? 'byOwner');
      if (usageKind === 'byWork' || usageKind === 'byPhase') {
        const source = usageKind === 'byWork' ? (usage?.scopes?.byWork ?? {}) : (usage?.scopes?.byPhase ?? {});
        const rows = Object.entries(source).map(([key, budget]) => ({
          ...(usageKind === 'byWork' ? { workId: key } : { phase: key }),
          requests: budget.requests ?? 0,
          inputTokens: budget.inputTokens ?? 0,
          outputTokens: budget.outputTokens ?? 0,
          cacheReadTokens: budget.cacheReadTokens ?? 0,
          costEstimate: budget.costEstimate ?? 0,
          costUnknownRequests: budget.costUnknownRequests ?? 0,
          costByCurrency: budget.costByCurrency ?? {},
          retries: budget.retries ?? 0,
          duplicatesSuppressed: budget.duplicatesSuppressed ?? 0,
        }));
        const pageResult = slice(rows);
        return { ok: true, section, kind: usageKind, page, pageSize, pages: pageResult.pages, total: pageResult.total, items: pageResult.items };
      }
      const rows = Object.entries(usage?.scopes?.byOwner ?? {}).map(([owner, budget]) => ({
        ownerMemberId: owner,
        requests: budget.requests ?? 0,
        inputTokens: budget.inputTokens ?? 0,
        outputTokens: budget.outputTokens ?? 0,
        cacheReadTokens: budget.cacheReadTokens ?? 0,
        costEstimate: budget.costEstimate ?? 0,
        costUnknownRequests: budget.costUnknownRequests ?? 0,
        retries: budget.retries ?? 0,
        duplicatesSuppressed: budget.duplicatesSuppressed ?? 0,
      }));
      const pageResult = slice(rows);
      return { ok: true, section, kind: 'byOwner', page, pageSize, pages: pageResult.pages, total: pageResult.total, items: pageResult.items };
    }
    return { ok: false, code: 'UNKNOWN_SECTION', section };
  }
  // ---- 有界热升级（Codex 审阅 5）：先 dry-run 审阅，确认后在现有 service 上挂新组件 ----
  /**
   * 只读升级计划（不触发任何写入/监听器/定时器）。
   * 保留现有 teams/members/works/attempts/队列/lease 与既有 wrapper。
   */
  upgradePlan(caller) {
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    if (actor.role !== 'lead' && actor.role !== 'root') {
      return denied('TEAM_LEAD_REQUIRED', '热升级计划只能由 lead/用户入口查看。');
    }
    // 有 controller 时用它（真实 sidecar/facade + 方法装载计划）；否则退回只读静态计划。
    return typeof this.__upgradeController?.plan === 'function' ? this.__upgradeController.plan() : planHotUpgrade(this);
  }

  /**
   * 有界热升级（必须显式 `confirm:'activate'`）。
   * 不卸载 ui-recovery、不覆盖既有 workbench wrapper、不改 app.asar、不新建进程。
   */
  async upgradeActivate(caller, request = {}) {
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    if (actor.role !== 'lead' && actor.role !== 'root') {
      return denied('TEAM_LEAD_REQUIRED', '热升级只能由 lead/用户入口在审阅后激活。');
    }
    // 真实实现全在 controller（upgradeBundle）：sidecar+facade 探针 → 组件/方法装载 →
    // 工具/路由/挂钩/费用 → postcondition。这里只做权限校验与转交。
    const result = await applyHotUpgrade(this, { confirm: request.confirm, installableEntry: request.installableEntry });
    this.diagnostics.push('service:upgradeActivate', `${result.ok ? 'ok' : result.code}${result.alreadyUpgraded ? '（幂等）' : ''}`);
    return result;
  }

  /** §6 受管任务上下文分页查询（只读、紧凑、不触发模型）。 */
  contextQuery(caller, request = {}) {
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    if (actor.role !== 'member' && actor.role !== 'lead') {
      return denied('TEAM_MEMBER_REQUIRED', '上下文查询只允许 Team 成员/lead（leaf 用任务包里的指针）。');
    }
    const teamKey = this.resolveTeamKey(actor, request.teamKey);
    const scope = this.assertModuleScope(actor, teamKey, actor.memberId);
    if (!scope.ok) return scope;
    const memberId = actor.memberId;
    const works = [...this.works.values()].filter((work) => work.teamKey === teamKey && work.ownerMemberId === memberId);
    const workIds = new Set(works.map((work) => work.workId));
    const attempts = [...this.attempts.values()].filter((attempt) => workIds.has(attempt.workId));
    const events = this.eventsFor(teamKey, memberId).filter((event) => event.state === 'pending' || event.payload?.workId);
    const prints = this.fingerprints.snapshot({ teamKey, limit: 50 }).groups.filter((group) => group.workIds.some((workId) => workIds.has(workId)));
    return buildContextPage({
      works,
      attempts,
      events,
      fingerprints: prints,
      memberId,
      teamKey,
      cursor: request.cursor,
      limit: request.limit ?? CONTEXT_LIMITS.defaultLimit,
      budgetChars: request.budgetChars ?? CONTEXT_LIMITS.defaultBudgetChars,
      includeDetail: request.includeDetail === true,
      now: this.clock.now(),
    });
  }


  /**
   * 历史数据视图（契约 §8）：4 条 `OWNER_MEMBER_MISSING` work + 18 条历史失败。
   *
   * 只**显示**，不清理、不重跑、不改失败计数：面板必须能看到"具体待处理原因"，
   * 而不是让统计变绿。
   */
  legacyRecoveryView() {
    const orphanWorks = [...this.works.values()].filter(
      (work) => work.state === 'blocked' && (work.blockedReason === 'OWNER_MEMBER_MISSING' || work.blockedReason === 'LEGACY_MAPPING_AMBIGUOUS'),
    );
    const failedAttempts = [...this.attempts.values()].filter((attempt) => attempt.state === 'failed');
    const historyAttempts = failedAttempts.filter((attempt) => !attempt.recoveryAction);
    return {
      orphanWorks: orphanWorks.map((work) => ({
        workId: work.workId,
        teamKey: work.teamKey,
        ownerMemberId: work.ownerMemberId,
        blockedReason: work.blockedReason,
        pendingReason: work.legacyPendingReason ?? 'owner 成员记录缺失，且不能用唯一可核对的原生身份恢复',
        rev: work.rev,
        attempts: (work.attempts ?? []).length,
      })),
      failedAttempts: failedAttempts.length,
      historicalFailedAttempts: historyAttempts.length,
      note: '历史数据保留可见：不编造成员身份、不自动重跑旧工作、不删除失败记录让统计变绿。',
    };
  }

  /** 锁外预取原生状态，避免在状态锁内等待原生调用。 */
  async prefetchNative() {
    const agents = this.adapter.listAgents();
    const childrenByParent = {};
    const parents = new Set();
    for (const attempt of this.attempts.values()) {
      if (!TERMINAL_ATTEMPT_STATES.has(attempt.state) && attempt.parentSessionId) parents.add(attempt.parentSessionId);
    }
    for (const parentId of parents) {
      const result = await this.adapter.listChildren(parentId);
      childrenByParent[parentId] = result.ok && Array.isArray(result.value) ? result.value.map((entry) => String(entry.id)) : [];
      if (!result.ok) this.diagnostics.push('service:prefetch:children-failed', `${parentId}: ${result.code} ${result.message}`);
    }
    // 原生 roster：历史数据恢复时用来做**保守**映射（只在能唯一确定时才映射）。
    const roster = [];
    for (const team of this.teams.values()) {
      const lead = team.rootSessionId ? this.adapter.agentFor(team.rootSessionId) : undefined;
      if (!lead) continue;
      const listed = await this.adapter.listMembers(lead);
      if (listed.ok && Array.isArray(listed.value)) {
        for (const entry of listed.value) {
          roster.push({ teamKey: team.teamKey, id: String(entry?.id ?? ''), name: String(entry?.name ?? ''), role: entry?.role ?? null, status: entry?.status ?? null });
        }
      }
    }
    return { at: this.clock.now(), agents: agents.map((agent) => String(agent.id)), childrenByParent, roster };
  }

  /** 锁内对账：启动回执、过期 lease、ready 队列重建。**不重跑已完成任务。** */
  async reconcileInLock(prefetch, options = {}) {
    const applyLegacy = options.legacyMapping === 'apply-unique';
    const report = { adopted: [], released: [], requeued: [], staleLeases: [], lateResults: this.lateResults.length, missingNative: [], orphanOwner: [], legacyMapped: [], legacyPending: [], readOnly: this.readOnly };
    const now = this.clock.now();

    // 「孤儿工作项」对账：work 的 owner 在 members 表里不存在。
    //
    // 为什么会有：真实缺陷（2026-10-14 实测）——`members` 表的键是 `${teamKey}/${name}`（含 `/`），
    // 而 per-record JSON 后端只接受 `[A-Za-z0-9_-]`，于是**成员记录从未落盘**（见 storage.js `encodeKey`）。
    // 成员在内存里活着、work 指向它，重启后成员消失、work 变孤儿。
    // 这里**不猜、不自动删**：只把无法执行的原因显式记录成 `blocked(OWNER_MEMBER_MISSING)`，
    // 让用户看到"为什么不跑"，并可用重新提交（指定有效 owner）或重建成员来恢复。
    for (const work of [...this.works.values()]) {
      if (work.ownerMemberId === 'lead') continue;
      const ownerKey = `${work.teamKey}/${work.ownerMemberId}`;

      // **恢复路径**：owner 记录后来才到位（成员重建 / 持久化重试成功）→ 解除孤儿标记。
      // 复核指出旧实现里 `blocked(OWNER_MEMBER_MISSING)` 是**只写一次**的：成员稍后出现，
      // work 仍永久 blocked，只能靠人显式重新提交。那对"重启后成员表恢复"这种正常情形太苛刻。
      if (this.members.has(ownerKey)) {
        if (work.state === 'blocked' && work.blockedReason === 'OWNER_MEMBER_MISSING') {
          const cleared = await this.storage.put('works', work.workId, { ...work, state: 'ready', blockedReason: null }, { expectRev: work.rev });
          if (cleared.ok) {
            this.works.set(work.workId, cleared.record);
            report.requeued.push(work.workId);
            this.diagnostics.push('service:reconcile:orphan-owner-recovered', `${work.workId} 的 owner「${work.ownerMemberId}」已到位：解除 blocked(OWNER_MEMBER_MISSING)，放回 ready。`);
          }
        }
        continue;
      }

      report.orphanOwner.push({ workId: work.workId, ownerMemberId: work.ownerMemberId, teamKey: work.teamKey });
      if (work.state === 'executing' || work.activeAttemptId) continue; // 正在跑的交给 attempt 对账

      // 历史数据（契约 §8）：**保守、幂等**。
      //
      // 默认行为**不变**：标记 blocked(OWNER_MEMBER_MISSING) 并保留可见。
      // 额外只做两件不可作弊的事：
      //   1) 查原生 roster，把"能唯一确定的映射候选"作为**候选**记录下来（不自动应用）；
      //   2) 写明**具体待处理原因**。
      // 真正的映射只在调用方显式要求时应用（`reconcile({ legacyMapping: 'apply-unique' })`），
      // 且应用后仍是 blocked（LEGACY_PENDING_REAUTH）——历史记录缺少成员规划授权，
      // **不得静默升级为"成员已批准"**，必须由真实 owner 重新接收后才允许新派发。
      const candidates = (prefetch.roster ?? []).filter(
        (entry) => entry.teamKey === work.teamKey && entry.name === work.ownerMemberId && entry.role === 'teammate' && entry.id,
      );
      const unique = candidates.length === 1 && this.adapter.agentFor(candidates[0].id) ? candidates[0] : undefined;
      const pendingReason = candidates.length === 0
        ? '原生 roster 里没有同名 teammate（无法唯一确定成员身份）：保留可见，等待真实成员重建或人工核对。'
        : candidates.length > 1
          ? `原生 roster 里有 ${candidates.length} 个同名 teammate：身份歧义，不自动映射。`
          : '原生 roster 命中唯一同名 teammate：可显式应用映射（应用后仍为 blocked，等待真实 owner 重新接收计划）。';
      report.legacyPending.push({ workId: work.workId, ownerMemberId: work.ownerMemberId, pendingReason, candidateSessionId: unique?.id ?? null, candidateCount: candidates.length });
      if (applyLegacy && unique) {
        const key = this.memberKey(work.teamKey, work.ownerMemberId);
        if (!this.members.has(key)) {
          const storedMember = await this.storage.put('members', key, {
            memberId: work.ownerMemberId,
            teamKey: work.teamKey,
            role: 'teammate',
            phase: 'active',
            sessionId: unique.id,
            responsibility: null,
            writeScopes: [],
            context: 'fresh',
            provider: null,
            model: null,
            createdAt: this.clock.now(),
            legacyMapped: true,
            legacyMappedFrom: 'native-roster-unique',
            provenance: provenance({ memberId: work.ownerMemberId, nativeTeamId: work.teamKey, workId: work.workId, at: this.clock.now(), extra: { action: 'legacy-member-map' } }),
          }, { idempotencyKey: `legacy-member-map:${key}:${unique.id}` });
          if (storedMember.ok) this.members.set(key, storedMember.record);
          report.legacyMapped.push({ workId: work.workId, memberId: work.ownerMemberId, sessionId: unique.id, mapped: storedMember.ok === true });
        }
        const current = this.works.get(work.workId);
        if (current && current.state !== 'executing') {
          const migrated = await this.storage.put('works', work.workId, {
            ...current,
            state: 'blocked',
            blockedReason: 'LEGACY_PENDING_REAUTH',
            legacyPendingReason: 'owner 已按原生 roster 唯一映射；历史记录没有成员规划授权，必须由真实 owner 重新提交计划/授权后才允许派发。',
          }, { expectRev: current.rev });
          if (migrated.ok) this.works.set(work.workId, migrated.record);
        }
        this.diagnostics.push('service:reconcile:legacy-owner-mapped', `${work.workId} 的 owner「${work.ownerMemberId}」按原生 roster **唯一**匹配到 session ${unique.id}：映射已应用（不编造身份、不自动重跑、不静默升级为已批准）。`);
        continue;
      }
      if (work.state === 'blocked' && work.blockedReason === 'OWNER_MEMBER_MISSING') {
        if (work.legacyPendingReason !== pendingReason) {
          // **附注写入绝不阻塞主标记**：它只是把"具体待处理原因"写进记录。
          const latest = this.works.get(work.workId);
          const annotated = await this.storage.put('works', work.workId, { ...latest, legacyPendingReason: pendingReason }, { expectRev: latest.rev });
          if (annotated.ok) this.works.set(work.workId, annotated.record);
          else this.diagnostics.push('service:reconcile:orphan-note-not-persisted', `${work.workId}: 待处理原因未能落盘（${annotated.code}）：内存态仍可见。`);
        }
        continue;
      }
      const stored = await this.storage.put('works', work.workId, {
        ...work,
        state: 'blocked',
        blockedReason: 'OWNER_MEMBER_MISSING',
        legacyPendingReason: pendingReason,
        deferReason: null,
      }, { expectRev: work.rev });
      if (stored.ok) {
        this.works.set(work.workId, stored.record);
        this.diagnostics.push(
          'service:reconcile:orphan-owner',
          `${work.workId} 的 owner「${work.ownerMemberId}」不在 members 表里：已标记 blocked(OWNER_MEMBER_MISSING)，不自动删除、不自动代跑。`,
          { workId: work.workId, ownerMemberId: work.ownerMemberId, teamKey: work.teamKey },
        );
      } else {
        // **必须区分"检测到但没标记上"**：写入被拒（如只读态 SECOND_WRITER）时，
        // 这条 work 实际仍是 `state`，不能被说成"已标记 blocked"——诊断撒谎比没有诊断更糟。
        this.diagnostics.push(
          'service:reconcile:orphan-owner-not-marked',
          `${work.workId} 的 owner「${work.ownerMemberId}」不在 members 表里，但标记写入失败（${stored.code}）：**仍是 ${work.state}，未按 blocked 处理**。`,
          { workId: work.workId, ownerMemberId: work.ownerMemberId, teamKey: work.teamKey, code: stored.code, readOnly: this.readOnly },
        );
      }
    }

    for (const attempt of [...this.attempts.values()]) {
      if (TERMINAL_ATTEMPT_STATES.has(attempt.state)) continue;
      const children = attempt.parentSessionId ? (prefetch.childrenByParent[attempt.parentSessionId] ?? []) : [];
      const present = children.includes(String(attempt.executorChildId));

      if (present) {
        if (attempt.intent !== 'started') {
          const stored = await this.storage.put('attempts', attempt.attemptId, { ...attempt, state: 'executing', intent: 'adopted', adoptedAt: now, startedAt: attempt.startedAt ?? now }, { expectRev: attempt.rev });
          if (stored.ok) {
            this.attempts.set(attempt.attemptId, stored.record);
            report.adopted.push(attempt.attemptId);
          }
        }
        continue;
      }

      if (attempt.state === 'reserved' || attempt.intent === 'start-in-flight' || attempt.intent === 'start-receipt-lost') {
        // 启动回执丢失且原生 catalog 里不存在 → 释放预留，不重复创建。
        const stored = await this.storage.put('attempts', attempt.attemptId, { ...attempt, state: 'failed', intent: 'start-not-created', error: 'START_RECEIPT_LOST_NOT_CREATED', endedAt: now }, { expectRev: attempt.rev });
        if (stored.ok) {
          this.attempts.set(attempt.attemptId, stored.record);
          report.released.push(attempt.attemptId);
          report.missingNative.push({ attemptId: attempt.attemptId, childId: attempt.executorChildId });
        }
      } else if (attempt.state === 'executing' && attempt.leaseExpiresAt && now > attempt.leaseExpiresAt) {
        const stored = await this.storage.put('attempts', attempt.attemptId, { ...attempt, state: 'failed', error: 'LEASE_EXPIRED_ON_RECOVERY', endedAt: now }, { expectRev: attempt.rev });
        if (stored.ok) {
          this.attempts.set(attempt.attemptId, stored.record);
          report.staleLeases.push(attempt.attemptId);
        }
      }

      const work = this.works.get(attempt.workId);
      if (work && work.activeAttemptId === attempt.attemptId) {
        const currentAttempt = this.attempts.get(attempt.attemptId);
        if (TERMINAL_ATTEMPT_STATES.has(currentAttempt.state)) {
          const next = { ...work, activeAttemptId: null, state: currentAttempt.state === 'failed' ? 'ready' : work.state };
          const stored = await this.storage.put('works', work.workId, next, { expectRev: work.rev });
          if (stored.ok) {
            this.works.set(work.workId, stored.record);
            report.requeued.push(work.workId);
          }
        }
      }
    }

    // 依赖满足后把 blocked 重新放回 ready（不重跑已完成任务）。
    //
    // **只有「依赖未满足」才允许自动放行。** 其他 blocked 原因必须显式解除：
    //   - `OWNER_MEMBER_MISSING`（owner 不在 members 表）
    //   - `REPEATED_IDENTICAL_FAILURE` / `ATTEMPT_BUDGET_EXHAUSTED`（失败终态）
    // 否则每次 `reconcile()`（重启、team_recover）都会把它们复活成 ready →
    // 永久失败的 work 被反复重跑（**重启即重试风暴**），且孤儿 work 会显示成可派发。
    // 这条曾经真漏掉过：孤儿标记写完立刻被本循环改回 ready（rev 2→3 但 state 未变）。
    for (const work of [...this.works.values()]) {
      if (work.state !== 'blocked') continue;
      if (work.blockedReason !== 'DEPENDENCIES_UNSATISFIED') continue;
      const satisfied = work.blockedBy.every((id) => this.isDependencySatisfied(id, work.artifactDependencies));
      if (satisfied) {
        // **放行到哪个状态**由 `restoredStateForDependencyRelease` 决定（不是一律 ready）：
        //   execution:'self' → `self_running`（成员自己做，永远不会有 attempt；落 ready 就是
        //   "既不能 selfReport、也不该被调度器启动"的死结 —— 实测 equip-verify-package）；
        //   delegate+已授权 → `ready`；delegate+未授权（别人替成员建的）→ `planned`。
        //
        // 注意：`expectRev` 用的是**记录自己的 rev**。任何绕过 service 直接写 storage 的调用方
        // 必须把返回记录写回内存（`if (stored.ok) this.works.set(...)`），否则内存 rev 落后 →
        // 这里的 CAS 会以 `CAS_MISMATCH` 失败（测试构造踩过这个坑，见 w10 第 6 组注释）。
        const restoredState = this.restoredStateForDependencyRelease(work);
        const stored = await this.storage.put('works', work.workId, { ...work, state: restoredState, blockedReason: null }, { expectRev: work.rev });
        if (stored.ok) {
          this.works.set(work.workId, stored.record);
          report.requeued.push(work.workId);
          if (restoredState === 'self_running') {
            this.diagnostics.push('service:reconcile:self-released', `${work.workId}: 依赖放行后回到 self_running（成员自己做，调度器不启动它）。`);
          }
        } else {
          this.diagnostics.push('service:reconcile:revive-cas-miss', `${work.workId}: 自动放行写入被拒（${stored.code}），保持 blocked 不改状态。`);
        }
      }
    }

    const changed = report.adopted.length + report.released.length + report.requeued.length + report.staleLeases.length > 0;
    if (changed) {
      this.diagnostics.push('service:reconcile', 'reconciled with changes', {
        adopted: report.adopted.length,
        released: report.released.length,
        requeued: report.requeued.length,
        staleLeases: report.staleLeases.length,
      });
    }
    return report;
  }

  async reconcile(options = {}) {
    const prefetch = await this.prefetchNative();
    // 契约 §3：源版本变化 → 证据过期（**锁外**只读文件，不重跑任务；过期后依赖不被错误解锁）。
    const evidenceRefresh = await this.refreshEvidenceValidity();
    const report = await this.mutex.run(() => this.reconcileInLock(prefetch, options));
    const merged = { ...report, evidenceRefresh: { checked: evidenceRefresh.checked, stale: evidenceRefresh.stale.length } };
    this.notify('reconciled', merged);
    return merged;
  }

  /**
   * 显式应用**唯一可核对**的历史 owner 映射（契约 §8）。
   * 默认对账绝不自动改写历史 owner；只有这个显式入口才会写映射，
   * 且映射后仍是 `blocked(LEGACY_PENDING_REAUTH)`：历史记录没有成员规划授权，
   * 必须由真实 owner 重新提交计划/授权后才允许派发。
   */
  async applyLegacyMemberMapping(caller) {
    const actor = this.actor(caller);
    if (!actor.ok) return actor;
    if (actor.role !== 'lead') return denied('TEAM_LEAD_REQUIRED', '只有 Team lead 能显式应用历史数据映射。');
    const writable = this.assertWritable();
    if (!writable.ok) return writable;
    return this.reconcile({ legacyMapping: 'apply-unique' });
  }

  // ---------------------------------------------------------------------------
  // 快照
  // ---------------------------------------------------------------------------
  /**
   * 角色段刷新代理（skills-workflow 已导出 `skills.js:refreshSkillSections`，Lead 第 18 回合第 3 点）：
   * 幂等——先清本模块上次注册的旧 instance/段，再对**当前 live agents** 重注册 leader/member/leaf 段；
   * 只动角色段，不卸载 workbench/ui-recovery、不重建插件。**不抛**：返回 `{ok,cleared,registered,agents,detail|code}`。
   */
  async refreshSkillSections(options = {}) {
    return refreshSkillSections(options);
  }

  snapshot(caller) {
    const actor = this.actor(caller);
    const capacity = this.capacity();
    return {
      revision: this.revision,
      writerEpoch: this.storage.writerEpoch,
      durable: this.storage.durable,
      storage: {
        backend: this.storage.backend,
        durable: this.storage.durable,
        degraded: this.storage.degraded ?? false,
        openedByUs: this.storage.openedByUs ?? null,
        backendError: this.storage.backendError,
        fallbackDir: this.storage.fallbackDir,
        dataDir: typeof this.storage.dataDir === 'function' ? this.storage.dataDir() : null,
        location: typeof this.storage.location === 'function' ? this.storage.location() : null,
        migrationRequired: this.storage.migrationRequired,
        tables: Object.fromEntries((this.storage.tables ?? []).map((name) => [name, this.storage.size(name)])),
        diagnostics: typeof this.storage.diagnostics === 'function' ? this.storage.diagnostics().slice(-20) : [],
      },
      readOnly: this.readOnly,
      readOnlyReason: this.readOnlyReason,
      migrationRequired: this.storage.migrationRequired,
      startedAt: this.startedAt,
      at: this.clock.now(),
      actor: actor.ok ? { sessionId: String(actor.agent.id), role: actor.role, teamKey: actor.teamKey, memberId: actor.memberId } : { error: actor.code },
      layout: this.layout(),
      teams: [...this.teams.values()].map(safeClone),
      members: [...this.members.values()].map(safeClone),
      works: [...this.works.values()].map(safeClone),
      attempts: [...this.attempts.values()].map(safeClone),
      missions: [...this.missions.values()].map(safeClone),
      dispatchIntents: [...this.dispatchIntents.values()].map(safeClone),
      // 客户端消费面（契约 §8）：成员自治视图 + 历史数据恢复视图。
      autonomy: this.memberAutonomyView(),
      legacyRecovery: this.legacyRecoveryView(),
      // leaf 启动实际传下去的 toolFilter（§15 回归的现场证据：deny 名单 + 被丢弃的未注册名字）。
      leafToolFilter: this.lastLeafToolFilter ?? null,
      // ---- 2026-10-17 整改：契约 §1 冻结字段（只读投影，不触发模型调用/日志重扫）----
      usage: this.usageSnapshot(),
      // CONTRACT v2 §7.1：`/state` 只下发**汇总 + preview（≤5）**，全量明细走 GET /state/detail。
      // CONTRACT v2/v4：能力声明（显式合同；前端三档：能力→冻结路径→旧 Host 回退）。
      capabilities: {
        apiVersion: 'workbench-v2',
        basePath: this.config?.web?.basePath ?? '/plugin/team-workbench',
        detail: { endpoint: '/state/detail', version: 1, pageSize: 50 },
        ack: { op: 'client-ack' },
        evidenceGate: 'evidence-gate-v2',
      },
      findings: summaryOfFindings(this.findingsSnapshot()),
      errorFingerprints: this.errorFingerprintSnapshot(),
      // 前端激活回执（只读；语义边界见 recordFrontendAck 注释）。
      frontendAck: this.frontendAckView(),
      maintenance: this.maintenanceView(),
      // 受管上下文控制（pre-step 注入 + 原生工具守卫）的**来源预算统计**（Codex 审阅 2）。
      contextControl: this.contextControl.snapshot(),
      execution: {
        runs: this.executionRunner.size(),
        roots: this.executionRunner.roots,
        declaredCommandsOnly: true,
        note: 'team_exec_check 只允许执行 work.verificationCommands 声明的命令（lead 可执行 config 白名单）；scope=live 一律拒绝。',
      },
      hotUpgrade: this.__hotUpgrade ?? null,
      // 证据与可信执行的可见计数（明细走 /op 分页，不塞进 state）
      evidence: {
        records: this.evidenceRecords.size,
        invalidated: this.evidenceInvalidations.length,
        executionRuns: this.executionRunner.size(),
      frontendAcks: this.frontendAckIndex.size,
        requireStrongForAccept: this.config?.evidence?.requireStrongForAccept !== false,
        note: 'accepted 必须引用 Host 记录的真实执行 runId（team_exec_check）；weak 证据只能支撑 produced。',
      },
      capacity,
      writeScopeHolders: this.writeScopeHolders(),
      stats: { ...this.stats },
      diagnostics: this.diagnostics.list().slice(-60),
      adapter: { counts: this.adapter.counts(), availability: this.adapter.availability() },
    };
  }
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function defaultLayout() {
  return {
    mode: 1,
    activePaneId: 'pane-1',
    // 四个窗格是**固定身份**，`mode` 只决定可见几个。客户端也按这个模型（`tbPaneIds` 恒为
    // pane-1..pane-4），所以 Host 记录必须始终持有这四个 id；否则会出现"mode=4 但只有 3 个
    // pane"的漂移记录（真实桌面现场出现过）。
    panes: CANONICAL_PANE_IDS.map((paneId) => ({ paneId, target: null, role: 'auto', label: '窗格 ' + paneId.slice(5) })),
    ratios: {},
    teamView: { grouped: true, showLeaves: true },
    updatedAt: 0,
    rev: 0,
  };
}

/** 客户端与 Host 共同遵守的窗格身份集合。 */
export const CANONICAL_PANE_IDS = Object.freeze(['pane-1', 'pane-2', 'pane-3', 'pane-4']);

function normalizeLayout(value) {
  const base = defaultLayout();
  if (!value || typeof value !== 'object') return base;
  const given = Array.isArray(value.panes) ? value.panes.map(normalizePane) : [];
  const byId = new Map(given.map((pane) => [pane.paneId, pane]));
  // 补齐缺失的窗格身份、忽略外来 id：记录形状永远与客户端一致。
  const panes = CANONICAL_PANE_IDS.map((paneId) => byId.get(paneId) ?? { paneId, target: null, role: 'auto', label: '' });
  return {
    mode: [1, 2, 4].includes(Number(value.mode)) ? Number(value.mode) : base.mode,
    activePaneId: panes.some((pane) => pane.paneId === value.activePaneId) ? value.activePaneId : panes[0].paneId,
    panes,
    ratios: value.ratios && typeof value.ratios === 'object' ? { ...value.ratios } : {},
    teamView: value.teamView && typeof value.teamView === 'object' ? { ...value.teamView } : { ...base.teamView },
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
    rev: Number.isInteger(value.rev) ? value.rev : 0,
  };
}

function normalizePane(pane) {
  const source = pane && typeof pane === 'object' ? pane : {};
  return {
    paneId: typeof source.paneId === 'string' && source.paneId ? source.paneId : newId('pane'),
    target: normalizeTarget(source.target),
    role: typeof source.role === 'string' ? source.role : 'auto',
    label: typeof source.label === 'string' ? source.label : '',
    workspaceId: typeof source.workspaceId === 'string' ? source.workspaceId : null,
  };
}

function normalizeTarget(target) {
  if (!target || typeof target !== 'object') return null;
  if (typeof target.sessionId === 'string' && target.sessionId) return { sessionId: target.sessionId };
  if (typeof target.childSessionId === 'string' && target.childSessionId) {
    return {
      parentSessionId: typeof target.parentSessionId === 'string' ? target.parentSessionId : null,
      childSessionId: target.childSessionId,
      mode: target.mode === 'one-shot' ? 'one-shot' : 'continuable',
    };
  }
  return null;
}

function sessionIdOf(target) {
  if (!target || typeof target !== 'object') return null;
  return typeof target.sessionId === 'string' ? target.sessionId : (typeof target.childSessionId === 'string' ? target.childSessionId : null);
}

function normalizePrompt(prompt, fallbackText) {
  if (Array.isArray(prompt) && prompt.length > 0) {
    return prompt.filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string');
  }
  return [{ type: 'text', text: fallbackText }];
}

function normalizeArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) return [];
  return artifacts
    .filter((artifact) => artifact && typeof artifact === 'object' && typeof artifact.path === 'string' && artifact.path.trim())
    .map((artifact) => ({
      path: artifact.path.trim(),
      version: Number.isInteger(artifact.version) ? artifact.version : 1,
      kind: typeof artifact.kind === 'string' ? artifact.kind : 'file',
      evidence: typeof artifact.evidence === 'string' ? artifact.evidence : null,
    }));
}

function rotateFairly(works, cursor) {
  if (works.length <= 1) return works.slice();
  const buckets = new Map();
  const order = [];
  for (const work of works) {
    const key = `${work.teamKey}/${work.ownerMemberId}`;
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key).push(work);
  }
  const rotatedKeys = [...order.slice(cursor % order.length), ...order.slice(0, cursor % order.length)];
  const out = [];
  let index = 0;
  for (;;) {
    let added = false;
    for (const key of rotatedKeys) {
      const bucket = buckets.get(key);
      if (index < bucket.length) {
        out.push(bucket[index]);
        added = true;
      }
    }
    if (!added) break;
    index += 1;
  }
  return out;
}

function resolveParentSessionId(service, work) {
  const member = service.members.get(`${work.teamKey}/${work.ownerMemberId}`);
  if (member?.sessionId) return member.sessionId;
  if (work.ownerMemberId === 'lead') {
    const team = service.teams.get(work.teamKey);
    return team?.rootSessionId ?? null;
  }
  return null;
}

/** 产物引用合并：同路径取更高版本（回执与 self 回执共用同一规则）。 */
function mergeArtifactRefs(existing, incoming) {
  const refs = (Array.isArray(existing) ? existing : []).map((item) => ({ ...item }));
  for (const artifact of Array.isArray(incoming) ? incoming : []) {
    const found = refs.find((item) => item.path === artifact.path);
    if (found) found.version = Math.max(found.version ?? 1, artifact.version ?? 1);
    else refs.push({ path: artifact.path, version: artifact.version ?? 1, kind: artifact.kind ?? 'file' });
  }
  return refs;
}

/** attempt → 定向启动/补位共用的 plan 形状。 */
function planOfAttempt(attempt) {
  return {
    workId: attempt.workId,
    attemptId: attempt.attemptId,
    childId: attempt.executorChildId,
    teamKey: attempt.teamKey,
    ownerMemberId: attempt.ownerMemberId,
    parentSessionId: attempt.parentSessionId,
    leaseEpoch: attempt.leaseEpoch,
    dispatchIntentId: attempt.dispatchIntentId ?? null,
  };
}

function holderOf(work, attempt) {
  return {
    workId: work.workId,
    attemptId: attempt.attemptId,
    teamKey: work.teamKey,
    ownerMemberId: work.ownerMemberId,
    state: attempt.state,
    scopes: [...new Set([...(work.writeScopes ?? []), ...(work.outputs ?? [])])],
  };
}

function rejectionMessage(rejection) {
  switch (rejection?.code) {
    case 'DISPATCH_NOT_AUTHORIZED':
      return '该工作项没有成员授权的派发意图：永不自动启动（等待 team_dispatch_authorize）。';
    case 'WRITE_SCOPE_CONFLICT':
      return `写入范围与正在执行的工作项重叠：${(rejection.conflicts ?? []).map((item) => item.workId).join(', ')}。`;
    case 'RESIDENT_CAPACITY_FULL':
      return 'resident 容量已满：拒绝并保持 ready，不排队空等。';
    case 'WORKER_CAPACITY_FULL':
      return '叶子容量已满：拒绝并保持 ready，不排队空等。';
    case 'MEMBER_FAIR_SHARE_FULL':
      return '该成员的名额已满：拒绝并保持 ready，把名额让给其它成员。';
    case 'PROVIDER_CAPACITY_FULL':
      return 'provider 请求上限已到：拒绝并保持 ready。';
    case 'ATTEMPT_BUDGET_EXHAUSTED':
      return '该工作项的 attempt 预算已耗尽：需要 owner 改变方法或证据后重新提交。';
    default:
      return `预留被拒绝：${rejection?.code ?? 'UNKNOWN'}`;
  }
}

/** 公开 `brief` 参数与 Host 生成的交付包合并（保证公开参数不被实现丢弃）。 */
export function composeBrief(base, extra) {
  const head = typeof base === 'string' && base.trim() ? base.trim() : '';
  const tail = typeof extra === 'string' && extra.trim() ? extra.trim() : '';
  if (!tail) return head;
  if (!head) return tail;
  return `${head}\n\n## owner 追加说明（team_subagent_start.brief）\n${tail}`;
}

/** 唤醒成员的提示文本：只给**指针与待办**，原始材料留在事件记录/产物里。 */
function buildWakePrompt({ member, pending, reason }) {
  const types = {};
  for (const event of pending) types[event.type] = (types[event.type] ?? 0) + 1;
  const lines = [
    `[team-workbench] 你的成员收件箱有 ${pending.length} 条待处理事件（触发原因：${reason}）。`,
    `- 成员：${member.memberId}`,
    `- 事件类型计数：${Object.entries(types).map(([type, count]) => `${type}×${count}`).join('、') || '（无）'}`,
    '',
    '请调用 `team_member_inbox` 读取事件，然后按你自己的模块判断处理：',
    '- 新的模块委托 → 用 `team_plan_submit` 提交/修订你自己的计划（execution: self 自己做；delegate 交给子智能体）。',
    '- 需要派发 → 用 `team_dispatch_authorize` 为你 planRevision 匹配的 work 建派发意图（Host 只启动你已授权的项）。',
    '- 子智能体回执/求助 → 用 `team_work_verify` 核验（produced ≠ accepted）或在模块内调整计划/补适配器。',
    '- 取消未来派发 → `team_plan_cancel`；取消不会杀掉正在跑的执行。',
    '',
    '不要等待 leader 再发话：这条消息就是唤醒你的输入。',
  ];
  return lines.join('\n');
}

/** leaf 的任务包：目标、边界、输入证据、接口版本、输出位置、验收、约束。 */
function buildLeafBrief(service, plan) {
  const work = service.works.get(plan.workId);
  const attempt = service.attempts.get(plan.attemptId);
  const briefText = attempt?.brief ?? work.brief ?? null;
  return [
    `# 独立交付任务：${work.title}`,
    '',
    `你要**独立完成**这一份交付：${work.deliverable}`,
    '',
    `- 交付物（必须真实产出到这些位置）：${work.outputs.join('、')}`,
    `- 输入/证据：${work.inputs.length > 0 ? work.inputs.join('、') : '（无外部输入，自行调查）'}`,
    `- 验收条件：${work.acceptance.join('；')}`,
    `- 写入范围：${work.writeScopes.length > 0 ? work.writeScopes.join('、') : '（未指定，遵循 owner 的模块边界）'}`,
    `- 上下文策略：${work.contextPolicy}`,
    work.artifactDependencies.length > 0
      ? `- 依赖的其它交付物：${work.artifactDependencies.map((dep) => `${dep.artifact}@v${dep.version}(${dep.requires})`).join('、')}`
      : '',
    work.missionId ? `- 所属模块委托：${work.missionId}（owner=${work.ownerMemberId}，planRevision=${work.planRevision ?? 'n/a'}）` : '',
    typeof briefText === 'string' && briefText.trim() ? `- owner 的任务包说明：\n${briefText.trim()}` : '',
    '',
    '要求：',
    '1) 调查、实现、自检、修复都在这一份任务内部完成，**不要**把“调查结果交回再等别人实现”。',
    '2) 不要用占位实现或 TODO 充当完成；没有条件验证时如实说明。',
    '3) 完成后提交回执：产物路径 + 版本、可核查的证据、未解决事项。`idle`、超时、非空文件都不是完成。',
    '4) 你没有创建 member 或提交他人工作项的权限。',
    '5) 缺输入或需要跨模块接口时，用 `team_ask_owner` 向你的 owner 求助（带 workId + 具体缺什么），不要试图用 team_message。',
    '6) 你有真实的文件与命令工具（`read` / `write` / `edit` / `glob` / `grep` / `pwsh` 等）：**产物必须由你亲自写盘并自检**。不要以"没有文件工具"为理由只交回执。',
    `7) 回执请带上：workId=${work.workId}，attemptId=${plan.attemptId}，leaseEpoch=${plan.leaseEpoch}。`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}
