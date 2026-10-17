/**
 * `autonomy.js` — 成员自治核心的数据语义（纯函数，无 IO）。
 *
 * 与 `policy.js` 同一层：只回答"某个字段是什么意思、某个状态从哪来"，
 * 让 `service.js` 保持"唯一的写入者"，让确定性测试可以直接断言语义。
 *
 * 对应 `docs/contracts/autonomy-v1.md` §1/§2/§4/§5/§6。
 */

// -----------------------------------------------------------------------------
// 三种对象
// -----------------------------------------------------------------------------

/** mission（模块委托）：leader 建，**叶子调度器永不消费**。 */
export const MISSION_STATES = Object.freeze(['assigned', 'planning', 'planned', 'closed']);

/** dispatch_intent（派发意图）：member 建，调度器只执行 `authorized`。 */
export const INTENT_STATES = Object.freeze(['authorized', 'consumed', 'cancelled']);

/** work 的执行归属：成员自己做 / 授权派发。 */
export const EXECUTION_MODES = Object.freeze(['self', 'delegate']);

/**
 * 自治 work 的状态词汇（契约 §2）。
 *
 * 说明：旧数据仍使用 `ready/claimed/executing/produced/verifying/blocked` 等历史状态，
 * 这里**不删除**它们，只保证新的自治路径使用下面这套更细的语义，
 * 从而"不会都显示成 ready/running"。
 */
export const AUTONOMOUS_WORK_STATES = Object.freeze([
  'needs_plan',
  'planned',
  'self_running',
  'dispatch_authorized',
  'ready',
  'executing',
  'produced',
  'awaiting_verification',
  'accepted',
  'failed',
  'cancelled',
]);

/** 成员事件类型（契约 §6）。 */
export const MEMBER_EVENT_TYPES = Object.freeze([
  'mission_assigned',
  'user_instruction',
  'peer_message',
  'leaf_receipt',
  'leaf_need',
  'dependency_changed',
  'replan_required',
  'recovery',
]);

/**
 * `true` = 该 work 走**成员自治语义**（有 mission 或 planRevision）。
 * 只用于状态语义/展示，**不再**决定"是否需要授权"（见 §11，授权一律必需）。
 */
export function isAutonomousWork(work) {
  if (!work) return false;
  if (work.missionId !== undefined && work.missionId !== null) return true;
  return Number.isInteger(work.planRevision);
}

/**
 * 是否要求"有 authorized 派发意图才能启动"。
 *
 * 契约 §11（v1.2）把"必须由 owner 自己授权"做成**统一规则**，不再按数据新旧豁免：
 *   - `submitWork` 的 caller === `work.ownerMemberId`（owner 是 lead 时就是 lead 自己）
 *     → Host 自动记录一条**来自 owner 的授权**（`authorizedBy: actorSessionId`、`via:'submitWork'`）；
 *   - caller ≠ owner → work 照常创建但**不产生授权**，初始 `needs_plan`，向 owner 入队事件；
 *     owner 自己 `team_dispatch_authorize` 之后才可能启动。
 *
 * 所以"是否需要授权"对所有 work 都成立：调度器只启动有 authorized 意图的 work，
 * 没有授权的 work 永远留在 needs_plan/planned（不是"历史数据豁免"）。
 */
export function requiresAuthorizedIntent() {
  return true;
}

/** 成员自己执行的自治 work 由 member 自己的回合完成，不由叶子调度器启动。 */
export function requiresSchedulerStart(work) {
  if (!work) return false;
  if (work.execution === 'self') return false;
  return true;
}

// -----------------------------------------------------------------------------
// Provenance（契约 §4）
// -----------------------------------------------------------------------------

/**
 * Host 依据**真实调用上下文**生成 provenance。
 *
 * 硬规则：模型传来的 `plannedBy` / `memberApproved` / `actorId` **一律不作为身份**，
 * 因此这里只接受 Host 侧的 actor / 调用现场字段，不读取 args 里的任何身份字段。
 *
 * @param {{
 *   actor?: object, toolCallId?: string|null, missionId?: string|null, workId?: string|null,
 *   planRevision?: number|null, dispatchIntentId?: string|null, parentSessionId?: string|null,
 *   childSessionId?: string|null, attemptId?: string|null, leaseEpoch?: number|null, at: number,
 *   extra?: object,
 * }} input
 */
export function provenance(input) {
  const actor = input?.actor ?? {};
  const record = {
    actorSessionId: typeof actor.agent?.id === 'string' ? actor.agent.id : null,
    memberId: actor.memberId ?? null,
    nativeTeamId: actor.teamKey ?? null,
    missionId: input?.missionId ?? null,
    workId: input?.workId ?? null,
    planRevision: Number.isInteger(input?.planRevision) ? input.planRevision : null,
    toolCallId: typeof input?.toolCallId === 'string' && input.toolCallId ? input.toolCallId : null,
    dispatchIntentId: input?.dispatchIntentId ?? null,
    parentSessionId: input?.parentSessionId ?? null,
    childSessionId: input?.childSessionId ?? null,
    attemptId: input?.attemptId ?? null,
    leaseEpoch: Number.isInteger(input?.leaseEpoch) ? input.leaseEpoch : null,
    at: input?.at ?? 0,
  };
  return input?.extra && typeof input.extra === 'object' ? { ...record, ...input.extra } : record;
}

/** 每次写入追加到 `provenanceLog`（有界，避免记录无限增长）。 */
export const PROVENANCE_LOG_LIMIT = 40;

export function appendProvenance(log, entry) {
  const list = Array.isArray(log) ? log.slice(-(PROVENANCE_LOG_LIMIT - 1)) : [];
  list.push(entry);
  return list;
}

/**
 * 丢弃模型自己传的身份字段，并**明确记录**它们被丢弃过。
 * 这是"模型传来的 plannedBy 不能作为自治证明"这条不变量的可观测形式。
 */
export const SPOOFABLE_IDENTITY_FIELDS = Object.freeze([
  'plannedBy',
  'memberApproved',
  'actorId',
  'approvedBy',
  'verifiedBy',
  'actorSessionId',
  'memberId',
  'nativeTeamId',
]);

export function stripSpoofedIdentity(args) {
  const source = args && typeof args === 'object' ? args : {};
  const dropped = [];
  for (const field of SPOOFABLE_IDENTITY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field)) dropped.push(field);
  }
  return { dropped, args: source };
}

// -----------------------------------------------------------------------------
// 事件
// -----------------------------------------------------------------------------

export function isMemberEventType(value) {
  return typeof value === 'string' && MEMBER_EVENT_TYPES.includes(value);
}

/** 事件内容指纹：用于"合并重复事件"，让同一个事实不会反复唤醒成员。 */
export function eventDedupeKey(teamKey, memberId, event) {
  const payload = event?.payload ?? {};
  return [
    'member-event',
    teamKey,
    memberId,
    String(event?.type ?? ''),
    String(event?.dedupe ?? payload.dedupe ?? ''),
  ].join(':');
}

/** 事件摘要：避免把整段原始材料塞进事件记录（原始材料留在产物里）。 */
export function summarizeEvent(event) {
  const payload = event?.payload ?? {};
  const bits = [];
  for (const key of ['missionId', 'workId', 'attemptId', 'intentId', 'fromMemberId', 'reason', 'title', 'question']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) bits.push(`${key}=${value.trim().slice(0, 120)}`);
  }
  return bits.join(' ');
}

// -----------------------------------------------------------------------------
// 决策 / 等待原因（面板可读，不参与判定）
// -----------------------------------------------------------------------------

export function wakeReasonOf(event) {
  switch (event?.type) {
    case 'mission_assigned':
      return '收到模块委托：需要自己规划';
    case 'user_instruction':
      return '用户直接给该成员的指令';
    case 'peer_message':
      return '邻接成员消息';
    case 'leaf_receipt':
      return '子智能体回执：需要核验/修订';
    case 'leaf_need':
      return '子智能体求助：需要 owner 处理';
    case 'dependency_changed':
      return '依赖状态变化：需要重新判断';
    case 'replan_required':
      return '计划需要修订';
    case 'recovery':
      return '恢复事件：需要重新对账';
    default:
      return '待处理事件';
  }
}

export function decisionAfter(event) {
  switch (event?.type) {
    case 'mission_assigned':
    case 'replan_required':
      return 'planning';
    case 'user_instruction':
      return 'planning';
    case 'peer_message':
      return 'reviewing';
    case 'leaf_receipt':
      return 'reviewing';
    case 'leaf_need':
      return 'reviewing';
    case 'dependency_changed':
      return 'planning';
    case 'recovery':
      return 'waiting';
    default:
      return 'idle';
  }
}

/** 从 work/attempt 现场推导"这个成员为什么还没动"。`member` 可选（用户暂停是成员级别的）。 */
export function waitReasonOf(work, member = null) {
  const since = work?.updatedAt ?? work?.createdAt ?? 0;
  if (member?.pausedBy === 'user' || work?.pausedBy === 'user' || work?.blockedReason === 'PAUSED_BY_USER') {
    return { kind: 'user_pause', detail: '用户显式暂停了该成员的派发；不会自动唤醒抵消，只有 resume_dispatch 解除。', since };
  }
  if (!work) return null;
  if (work.state === 'needs_plan') return { kind: 'member_planning', detail: '模块委托已到，等待成员提交计划。', since };
  if (work.state === 'planned') return { kind: 'member_authorization', detail: '计划已提交，等待成员授权派发。', since };
  if (work.state === 'blocked') {
    if (work.blockedReason === 'DEPENDENCIES_UNSATISFIED') return { kind: 'dependency', detail: '依赖的交付物尚未满足。', since };
    if (work.blockedReason === 'OWNER_MEMBER_MISSING') return { kind: 'owner_missing', detail: 'owner 成员记录缺失：保留可见，不代跑。', since };
    if (work.blockedReason === 'DEPENDENCY_NOT_VERIFIED') return { kind: 'owner_verification', detail: '依赖声明 requires=verified-result，等待 owner 实际核验。', since };
    return { kind: 'blocked', detail: String(work.blockedReason ?? 'blocked'), since };
  }
  if (work.deferredAt || work.deferReason) return { kind: 'capacity', detail: `容量拒绝（${work.deferReason ?? 'CAPACITY'}）：保持 ready，退避后重试。`, since: work.deferredAt ?? since };
  if (work.state === 'awaiting_verification') return { kind: 'owner_verification', detail: '产物已交回，等待 owner 核验（produced ≠ accepted）。', since };
  if (work.state === 'produced') return { kind: 'owner_verification', detail: '产物已交回；owner 尚未核验。', since };
  return null;
}
