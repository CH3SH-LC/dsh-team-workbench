/* @local/dsh-team-workbench — member autonomy read layer (autonomy-v1 §八).
 *
 * The web workbench must show what a MEMBER ITSELF decided (its own plan revision, its own
 * deliverables with `execution: self|delegate`, the dispatch intents IT authorized, the
 * receipts/verifications IT handled), not just the background dispatcher's log.
 *
 * Everything here is a PURE READ of the Host payload (`GET /state`). Nothing is fabricated:
 * a field the Host did not send is reported as `undefined` and the UI renders "未提供" for it.
 * Field names are resolved through a small list of accepted paths, because the Host owns the
 * payload shape (autonomy-v1 §1/§2) and may nest it differently without breaking the client.
 *
 * Objects mirrored from the contract:
 *   mission        { missionId, title, goal, state }
 *   plan           { planRevision, submittedAt, deliverables[] }
 *   deliverable    { workId, title, kind, execution:'self'|'delegate', state, outputs[],
 *                    acceptance[], writeScopes[], dependencies[] }
 *   dispatchIntent { intentId, workId, state:'authorized'|'consumed'|'cancelled',
 *                    consumedByAttemptId, at }
 *   attempt        { attemptId, workId, state, startedAt, leaseEpoch }
 *   receipt        { workId, attemptId, outcome, at, verification:'pending'|'accepted'|'rejected' }
 *   inbox          { pending, oldestAt, byType }
 */

/** Read `obj[key]` only when it is a plain object (never fabricate a wrapper). */
function tbObj(obj, key) {
  if (obj === null || obj === undefined || typeof obj !== 'object') return undefined;
  const value = obj[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

/** Read `obj[key]` only when it is an array. */
function tbArr(obj, key) {
  if (obj === null || obj === undefined || typeof obj !== 'object') return undefined;
  const value = obj[key];
  return Array.isArray(value) ? value : undefined;
}

/** Read `obj[key]` only when it is a string (or a finite number rendered as string). */
function tbStr(obj, key) {
  if (obj === null || obj === undefined || typeof obj !== 'object') return undefined;
  const value = obj[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Read `obj[key]` only when it is a finite number. */
function tbNum(obj, key) {
  if (obj === null || obj === undefined || typeof obj !== 'object') return undefined;
  const value = obj[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Where the Host put this member's autonomy block. Ordered by likelihood; the first hit wins
 * and the path is reported in `source` so the UI (and the acceptance record) can show which
 * contract path was actually used. `undefined` when the payload has no autonomy data at all.
 */
function tbAutonomyPaths() {
  return [
    { source: 'autonomy.byMember', pick: (snapshot, sessionId) => tbObj(tbObj(snapshot, 'autonomy'), 'byMember')?.[sessionId] },
    { source: 'autonomy.members', pick: (snapshot, sessionId) => tbObj(tbObj(snapshot, 'autonomy'), 'members')?.[sessionId] },
    { source: 'memberAutonomy', pick: (snapshot, sessionId) => tbObj(snapshot, 'memberAutonomy')?.[sessionId] },
    { source: 'sessions[].autonomy', pick: (snapshot, sessionId) => {
      const rows = tbArr(snapshot, 'sessions');
      if (rows === undefined) return undefined;
      const row = rows.find((entry) => tbStr(entry, 'sessionId') === sessionId);
      return tbObj(row, 'autonomy');
    } },
    { source: 'members[].autonomy', pick: (snapshot, sessionId) => {
      const rows = tbArr(snapshot, 'members');
      if (rows === undefined) return undefined;
      const row = rows.find((entry) => tbStr(entry, 'sessionId') === sessionId || tbStr(entry, 'id') === sessionId);
      return tbObj(row, 'autonomy') ?? row;
    } }
  ];
}

/**
 * Normalize the member-autonomy block for one member session.
 *
 * @returns {{found: boolean, source: string|undefined, mission: object|undefined,
 *   plan: object|undefined, planRevision: number|undefined, deliverables: Array|undefined,
 *   dispatchIntents: Array|undefined, attempts: Array|undefined, receipts: Array|undefined,
 *   decision: object|undefined, waitReason: object|undefined, recentProgress: Array|undefined,
 *   subtasks: Array|undefined, inbox: object|undefined, pausedBy: string|undefined,
 *   missing: string[]}}
 *   `missing` lists the CONTRACT FIELDS the Host did not provide — the UI renders those as
 *   "未提供" instead of guessing.
 */
function tbAutonomyFor(snapshot, sessionId) {
  const empty = {
    found: false,
    source: undefined,
    mission: undefined,
    plan: undefined,
    planRevision: undefined,
    deliverables: undefined,
    dispatchIntents: undefined,
    attempts: undefined,
    receipts: undefined,
    decision: undefined,
    waitReason: undefined,
    recentProgress: undefined,
    subtasks: undefined,
    inbox: undefined,
    pausedBy: undefined,
    missing: ['mission', 'plan', 'dispatchIntents', 'receipts', 'decision', 'waitReason', 'recentProgress', 'subtasks', 'inbox']
  };
  if (sessionId === undefined || sessionId === null || snapshot === null || snapshot === undefined) return empty;
  let block;
  let source;
  for (const path of tbAutonomyPaths()) {
    let picked;
    try {
      picked = path.pick(snapshot, sessionId);
    } catch {
      picked = undefined;
    }
    if (picked !== undefined) {
      block = picked;
      source = path.source;
      break;
    }
  }
  if (block === undefined) return empty;

  const mission = tbObj(block, 'mission');
  const plan = tbObj(block, 'plan');
  const planRevision = tbNum(plan, 'planRevision') ?? tbNum(block, 'planRevision');
  // Deliverables may sit inside `plan` or at the top level; both are contract-legal.
  const deliverables = tbArr(plan, 'deliverables') ?? tbArr(block, 'deliverables');
  const dispatchIntents = tbArr(block, 'dispatchIntents') ?? tbArr(block, 'intents');
  const attempts = tbArr(block, 'attempts');
  const receipts = tbArr(block, 'receipts') ?? tbArr(block, 'verifications');
  const decision = tbObj(block, 'decision');
  const waitReason = tbObj(block, 'waitReason') ?? tbObj(block, 'waiting');
  const recentProgress = tbArr(block, 'recentProgress') ?? tbArr(block, 'progress');
  const subtasks = tbArr(block, 'subtasks') ?? tbArr(block, 'children');
  const inbox = tbObj(block, 'inbox');
  const pausedBy = tbStr(block, 'pausedBy');

  const missing = [];
  if (mission === undefined) missing.push('mission');
  if (plan === undefined && planRevision === undefined) missing.push('plan');
  if (deliverables === undefined) missing.push('deliverables');
  if (dispatchIntents === undefined) missing.push('dispatchIntents');
  if (receipts === undefined) missing.push('receipts');
  if (decision === undefined) missing.push('decision');
  if (waitReason === undefined) missing.push('waitReason');
  if (recentProgress === undefined) missing.push('recentProgress');
  if (subtasks === undefined) missing.push('subtasks');
  if (inbox === undefined) missing.push('inbox');

  return {
    found: true,
    source,
    mission,
    plan,
    planRevision,
    deliverables,
    dispatchIntents,
    attempts,
    receipts,
    decision,
    waitReason,
    recentProgress,
    subtasks,
    inbox,
    pausedBy,
    missing
  };
}

/** Counts for the always-visible summary line (all derived, nothing invented). */
function tbAutonomyCounts(autonomy) {
  const deliverables = autonomy.deliverables ?? [];
  let self = 0;
  let delegate = 0;
  for (const item of deliverables) {
    if (tbStr(item, 'execution') === 'self') self += 1;
    else if (tbStr(item, 'execution') === 'delegate') delegate += 1;
  }
  const intents = autonomy.dispatchIntents ?? [];
  const pendingReceipts = (autonomy.receipts ?? []).filter((row) => tbStr(row, 'verification') === 'pending' || tbStr(row, 'verification') === undefined).length;
  return {
    deliverables: deliverables.length,
    self,
    delegate,
    intents: intents.length,
    authorized: intents.filter((row) => tbStr(row, 'state') === 'authorized').length,
    consumed: intents.filter((row) => tbStr(row, 'state') === 'consumed').length,
    pendingReceipts,
    inboxPending: tbNum(autonomy.inbox, 'pending'),
    subtasks: (autonomy.subtasks ?? []).length
  };
}

/** Short display id for long host ids (keeps the row readable without hiding the value). */
function tbShortId(value) {
  if (typeof value !== 'string' || value === '') return undefined;
  return value.length <= 10 ? value : value.slice(0, 8) + '…';
}
