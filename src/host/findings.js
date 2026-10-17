/**
 * `findings.js` — 证据式成果投影（契约 v1 §1 `snapshot.findings`）+ 受管任务上下文查询（§6）。
 *
 * ## findings：成果等级由 **Host** 判定，不接受模型自报
 *
 * - `verified` 只放 Host 能复核的成果：`accepted` **且**有通过校验的 evidence 记录
 *   **且**产物带版本（`artifactRefs[].version`）。
 * - 旧 `accepted`（在没有证据校验规则之前签的）**不改历史**，放进 `invalidated` 并标
 *   `legacyOwnerClaim:true` / `reason:'LEGACY_ACCEPTED_UNVERIFIED'`——它是 owner 的历史声明，
 *   不是 Host 复核结论。
 * - `invalidated`：证据过期（源版本/hash 变化）或旧声明。
 * - `inProgress` / `unfinished` / `rejected` 按 work 状态与 verification 结果投影。
 * - `lastEffectiveProgress` **只来自状态迁移**（attempt 启动/结算、verification、依赖放行），
 *   绝不把"日志/文件字节变化"当有效进展（契约 §2 要求）。
 *
 * ## 上下文查询（§6）
 *
 * 只针对**受管任务**（team/member 作用域），默认**紧凑 + 分页**：
 * 每行只有 `workId/state/at/摘要指针`，不返回整段原文；原件留在磁盘按需取。
 * 分页游标稳定（`updatedAt:workId`），不会因为截断导致重复调查。
 * 只读：不触发模型调用、不写状态、不与当前 turn 竞争。
 */

import { sha256Hex } from './util.js';

/** 视为"进行中"的状态。 */
export const IN_PROGRESS_STATES = Object.freeze([
  'needs_plan',
  'planned',
  'dispatch_authorized',
  'ready',
  'executing',
  'self_running',
  'claimed',
  'blocked',
]);

/** 视为"产物已交回但未验收/未完成"的状态。 */
export const AWAITING_STATES = Object.freeze(['produced', 'verifying', 'awaiting_verification']);

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** `claimScope`：这件成果是谁的、跨不跨模块（CONTRACT §7.2 枚举）。 */
export function claimScopeOf(work, evidenceScopes = []) {
  if (Array.isArray(evidenceScopes) && (evidenceScopes.includes('batch') || evidenceScopes.includes('live'))) return 'integration';
  if (Array.isArray(work?.inputs) && work.inputs.length > 0) return 'cross-module';
  if (work?.ownerMemberId === 'lead') return 'coordination';
  return 'own-work';
}

/** `verificationLevel`：证据层级映射（只降不升；未知一律不升级）。 */
export function verificationLevelOf(record, trusted = null) {
  if (!record || record.valid !== true) return null;
  if (record.strong !== true) return null;
  // 契约 v4 §11.3：没有 Host 可信执行（attempt/run/exitCode/产物 hash）→ 最多 offline，
  // 不得用统一 verified 掩盖 integration/gameplay/user-confirmation。
  if (trusted && trusted.complete !== true) return 'offline';
  const scopes = Array.isArray(record.scopes) ? record.scopes : [];
  if (scopes.includes('live')) return 'gameplay'; // live 观察仍不是"用户接受"，见 findings.limitations
  if (scopes.includes('batch')) return 'integration';
  if (scopes.includes('offline')) return 'offline';
  return 'offline';
}

const VERIFICATION_LEVELS = ['offline', 'integration', 'engineering-save', 'gameplay', 'user-confirmation'];

/** `/state` 只下发的**汇总**形状（CONTRACT §7.1）。 */
export function summaryOfFindings(findings) {
  const byLevel = Object.fromEntries(VERIFICATION_LEVELS.map((level) => [level, 0]));
  for (const item of findings?.verified ?? []) {
    const level = item.verificationLevel ?? 'offline';
    if (byLevel[level] === undefined) byLevel[level] = 0;
    byLevel[level] += 1;
  }
  const take = (list) => (Array.isArray(list) ? list.slice(0, 5) : []);
  return {
    generatedAt: findings?.generatedAt ?? 0,
    counts: { ...(findings?.counts ?? {}), verifiedByLevel: byLevel },
    preview: {
      verified: take(findings?.verified),
      unfinished: take(findings?.unfinished),
      rejected: take(findings?.rejected),
      invalidated: take(findings?.invalidated),
    },
    levels: findings?.levels ?? { verified: [] },
    lastEffectiveProgress: findings?.lastEffectiveProgress ?? { at: 0, workId: null, ownerMemberId: null, text: '' },
    note: findings?.note ?? '',
  };
}

/** `/state/detail` 的 findings 分页（1-based page；只读，不做全量扫描泄漏）。 */
export function findingsDetailPage(findings, options = {}) {
  const kind = String(options.kind ?? 'verified');
  const page = Math.max(1, Number.isInteger(options.page) ? options.page : 1);
  const pageSize = Math.min(Math.max(Number.isInteger(options.pageSize) ? options.pageSize : 20, 1), 50);
  const ownerMemberId = options.ownerMemberId ? String(options.ownerMemberId) : null;
  const teamKey = options.teamKey ? String(options.teamKey) : null;
  const lists = {
    verified: findings?.verified ?? [],
    unfinished: findings?.unfinished ?? [],
    inProgress: findings?.inProgress ?? [],
    rejected: findings?.rejected ?? [],
    invalidated: findings?.invalidated ?? [],
    activity: findings?.activity ?? [],
    errors: findings?.errors ?? [],
  };
  if (!lists[kind]) return { ok: false, code: 'UNKNOWN_KIND', kind };
  let rows = lists[kind].filter((row) => (!ownerMemberId || String(row.ownerMemberId) === ownerMemberId) && (!teamKey || !row.teamKey || String(row.teamKey) === teamKey));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  rows = rows.slice((page - 1) * pageSize, page * pageSize);
  return { ok: true, kind, page, pageSize, pages, total, items: rows };
}

function artifactsWithVersion(work) {
  return (Array.isArray(work?.artifactRefs) ? work.artifactRefs : [])
    .filter((item) => item && typeof item.path === 'string' && item.path)
    .map((item) => ({ path: item.path, version: Number.isInteger(item.version) ? item.version : 1 }));
}

/**
 * 构建 findings 投影。
 *
 * @param {object} input
 * @param {object[]} input.works
 * @param {object[]} input.attempts
 * @param {object[]} [input.evidenceRecords] 已校验通过的证据记录（`evidence_records` 表）
 * @param {object[]} [input.invalidations] 过期/历史声明记录
 * @param {number} [input.now]
 * @param {string|null} [input.teamKey] 只要这个团队的成果
 */
export function buildFindings(input = {}) {
  const now = num(input.now) || Date.now();
  const teamKey = input.teamKey ?? null;
  const works = (Array.isArray(input.works) ? input.works : []).filter((work) => work && (!teamKey || work.teamKey === teamKey));
  const attempts = Array.isArray(input.attempts) ? input.attempts : [];
  const evidenceRecords = Array.isArray(input.evidenceRecords) ? input.evidenceRecords : [];
  const extraInvalidations = Array.isArray(input.invalidations) ? input.invalidations : [];

  const evidenceByWork = new Map();
  for (const record of evidenceRecords) {
    if (!record || !record.workId) continue;
    const bucket = evidenceByWork.get(record.workId) ?? [];
    bucket.push(record);
    evidenceByWork.set(record.workId, bucket);
  }
  const attemptsByWork = new Map();
  for (const attempt of attempts) {
    if (!attempt || !attempt.workId) continue;
    const bucket = attemptsByWork.get(attempt.workId) ?? [];
    bucket.push(attempt);
    attemptsByWork.set(attempt.workId, bucket);
  }

  const verified = [];
  const inProgress = [];
  const unfinished = [];
  const rejected = [];
  const invalidated = [];
  /** 调度活动（attempt 启动/失败/心跳）与真正的交付进展**分栏**（Codex 审阅 D）。 */
  const activity = [];
  const errors = [];
  let lastEffectiveProgress = { at: 0, workId: null, ownerMemberId: null, text: '' };

  /** 只有**交付/验收**类状态迁移才算"有效进展"；attempt 启动/失败只进 activity。 */
  const noteProgress = (at, work, text) => {
    const time = num(at);
    if (time <= lastEffectiveProgress.at) return;
    lastEffectiveProgress = { at: time, workId: work?.workId ?? null, ownerMemberId: work?.ownerMemberId ?? null, text };
  };

  // **先**收集失效集合，后面 verified 必须排除它（否则同一 work 会同时出现在 verified 与 invalidated）。
  const invalidatedWorkIds = new Set(
    extraInvalidations
      .map((entry) => entry?.workId)
      .filter(Boolean)
      .map(String),
  );
  /** 证据层级上限：offline 证据永远不能声称接入/保存/玩法/用户接受。 */
  const scopeRank = { offline: 1, batch: 2, live: 3 };
  const evidenceLevelOf = (record) => {
    if (!record) return 'none';
    if (!record.valid) return 'invalid';
    const scopes = Array.isArray(record.scopes) ? record.scopes : [];
    const best = scopes.map((scope) => scopeRank[scope] ?? 0).sort((left, right) => right - left)[0] ?? 0;
    if (record.strong !== true) return 'produced-only';
    return best >= 3 ? 'live-observed' : (best >= 2 ? 'batch-verified' : 'offline-verified');
  };

  for (const work of works) {
    const workAttempts = (attemptsByWork.get(work.workId) ?? []).slice().sort((left, right) => num(left.startedAt ?? left.reservedAt) - num(right.startedAt ?? right.reservedAt));
    const records = (evidenceByWork.get(work.workId) ?? []).slice().sort((left, right) => num(left.at) - num(right.at));
    const latestRecord = records.length > 0 ? records[records.length - 1] : null;
    const artifacts = artifactsWithVersion(work);
    const verification = work.verification ?? null;

    // ---- verified：Host 可复核 ------------------------------------------------
    if (work.state === 'accepted') {
      const hostVerified = Boolean(latestRecord?.valid) && artifacts.length > 0 && !invalidatedWorkIds.has(String(work.workId));
      if (hostVerified) {
        const level = evidenceLevelOf(latestRecord);
        verified.push({
          workId: work.workId,
          ownerMemberId: work.ownerMemberId,
          title: work.title ?? '',
          artifacts,
          evidence: (latestRecord?.items ?? [])
            .filter((item) => item.valid)
            .map((item) => ({ kind: item.kind, ref: `evidence#${item.index}`, ok: true, source: item.source ?? null, strong: item.strong === true, scope: item.scope ?? null })),
          verifiedAt: num(work.verifiedAt) || num(latestRecord?.at),
          evidenceDigest: latestRecord?.digest ?? null,
          // 证据层级（Codex 审阅 D）：只降不升；offline 不能冒充接入/实机/用户接受。
          evidenceLevel: level,
          scope: level === 'live-observed' ? 'live' : (level === 'batch-verified' ? 'batch' : 'offline'),
          ceiling: level === 'live-observed' ? 'live-observed' : (level === 'batch-verified' ? 'batch-verified' : 'offline-verified'),
          claimScope: claimScopeOf(work, (latestRecord?.scopes ?? [])),
          // 契约 v4 §11.3：产物版本 + 依赖版本 + Host 可信执行三元组（缺一项即降级并写明）。
          artifactVersions: artifacts,
          dependencyVersions: (work.artifactDependencies ?? []).map((dep) => ({ artifact: dep.artifact, version: dep.version ?? null, requires: dep.requires ?? 'published-interface' })),
          trustedExecution: (() => {
            const runId = Array.isArray(latestRecord?.runIds) ? latestRecord.runIds[0] ?? null : null;
            const attemptId = latestRecord?.attemptId ?? null;
            const exitCode = latestRecord?.exitCode ?? null;
            const artifactSha256 = (latestRecord?.files ?? []).find((file) => file?.sha256)?.sha256 ?? null;
            return { attemptId, executionRunId: runId, exitCode, artifactSha256, complete: Boolean(attemptId && runId && exitCode === 0 && artifactSha256) };
          })(),
          verificationLevel: verificationLevelOf(latestRecord, { complete: Boolean(latestRecord?.attemptId && (latestRecord?.runIds ?? []).length > 0 && latestRecord?.exitCode === 0 && (latestRecord?.files ?? []).some((file) => file?.sha256)) }),
          limitations: level === 'offline-verified'
            ? ['offline-verified：只证明本机 Host 真实执行并通过；不能据此声称已接入运行中的 DSH / 已保存 / 玩法可用 / 用户接受。']
            : [],
        });
        noteProgress(num(work.verifiedAt) || num(latestRecord?.at), work, `owner 验收通过（${work.title ?? work.workId}）`);
      } else {
        // 历史 accepted 或没有可复核证据：保留为 owner 历史声明，**不改 work 记录**。
        invalidated.push({
          workId: work.workId,
          reason: invalidatedWorkIds.has(String(work.workId))
            ? 'EVIDENCE_STALE'
            : (artifacts.length === 0 ? 'ACCEPTED_WITHOUT_ARTIFACTS' : 'LEGACY_ACCEPTED_UNVERIFIED'),
          at: num(work.verifiedAt) || now,
          legacyOwnerClaim: true,
          note: '这是 owner 的历史验收声明，Host 没有可复核的执行记录 + 产物版本证据；不批量改写历史，也不作为"已实机通过"的结论。',
        });
      }
      if (verification?.outcome === 'rejected') rejected.push({ workId: work.workId, ownerMemberId: work.ownerMemberId, note: verification.note ?? '', at: num(verification.at) });
      continue;
    }

    if (verification?.outcome === 'rejected') {
      rejected.push({ workId: work.workId, ownerMemberId: work.ownerMemberId, note: verification.note ?? '', at: num(verification.at) });
    }

    if (AWAITING_STATES.includes(work.state)) {
      unfinished.push({
        workId: work.workId,
        ownerMemberId: work.ownerMemberId,
        title: work.title ?? '',
        state: work.state,
        claimScope: claimScopeOf(work),
        missing: Array.isArray(work.completion?.missing) && work.completion.missing.length > 0
          ? work.completion.missing
          : ['owner-verification'],
      });
      noteProgress(num(work.producedAt) || num(work.updatedAt), work, `产物交回，等待 owner 核验（${work.title ?? work.workId}）`);
      continue;
    }

    if (work.state === 'cancelled' || work.state === 'failed') {
      unfinished.push({
        workId: work.workId,
        ownerMemberId: work.ownerMemberId,
        title: work.title ?? '',
        state: work.state,
        missing: [work.state === 'cancelled' ? 'cancelled' : (work.lastFailureCode ? `failed:${work.lastFailureCode}` : 'failed')],
      });
      continue;
    }

    // 进行中（含 blocked：blocked 的 reason 就是"还没完成的原因"）
    if (IN_PROGRESS_STATES.includes(work.state)) {
      const lastAttempt = workAttempts[workAttempts.length - 1];
      let lastEffectiveAt = Math.max(num(work.updatedAt), num(lastAttempt?.startedAt), num(lastAttempt?.endedAt));
      let text = `进行中（${work.state}）`;
      if (work.state === 'blocked') {
        unfinished.push({
          workId: work.workId,
          ownerMemberId: work.ownerMemberId,
          title: work.title ?? '',
          state: work.state,
          claimScope: claimScopeOf(work),
        missing: [String(work.blockedReason ?? 'blocked')],
        });
      } else {
        inProgress.push({
          workId: work.workId,
          ownerMemberId: work.ownerMemberId,
          title: work.title ?? '',
          state: work.state,
          lastEffectiveAt,
        });
      }
      if (lastAttempt && ['produced', 'failed'].includes(String(lastAttempt.state))) {
        // attempt 启动/失败属于**调度活动**，不是交付进展：进 activity，不进 lastEffectiveProgress。
        activity.push({
          workId: work.workId,
          ownerMemberId: work.ownerMemberId,
          kind: lastAttempt.state === 'failed' ? 'attempt-failed' : 'attempt-settled',
          at: num(lastAttempt.endedAt) || lastEffectiveAt,
          note: lastAttempt.error ?? null,
        });
        if (lastAttempt.state === 'failed') {
          errors.push({ workId: work.workId, code: lastAttempt.error ?? 'ATTEMPT_FAILED', at: num(lastAttempt.endedAt) || lastEffectiveAt });
        }
      } else if (work.state !== 'blocked') {
        activity.push({ workId: work.workId, ownerMemberId: work.ownerMemberId, kind: 'dispatch', at: lastEffectiveAt, note: work.state });
      }
    }
  }

  // 证据过期（源版本/ hash 变化）→ invalidated，**不错误解锁依赖**
  for (const entry of extraInvalidations) {
    invalidated.push({
      workId: entry.workId,
      reason: entry.reason ?? 'EVIDENCE_STALE',
      at: num(entry.at) || now,
      changed: entry.changed ?? [],
      legacyOwnerClaim: false,
    });
  }

  const dedupeByWork = (list) => {
    const seen = new Set();
    return list.filter((item) => {
      const key = `${item.workId}:${item.reason ?? item.state ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  return {
    generatedAt: now,
    verified: dedupeByWork(verified),
    inProgress: dedupeByWork(inProgress),
    unfinished: dedupeByWork(unfinished),
    rejected: dedupeByWork(rejected),
    invalidated: dedupeByWork(invalidated),
    // 调度活动与错误**分栏**（Codex 审阅 D）：不是交付进展，也不与 verified 混在一起。
    activity: dedupeByWork(activity),
    errors: dedupeByWork(errors),
    levels: {
      verified: dedupeByWork(verified).map((item) => ({ workId: item.workId, evidenceLevel: item.evidenceLevel, ceiling: item.ceiling })),
      note: '证据层级只降不升：offline-verified 不能声称接入运行中的 DSH / 已保存 / 玩法可用 / 用户接受；这些需要独立可信来源。',
    },
    lastEffectiveProgress,
    counts: {
      verified: verified.length,
      inProgress: inProgress.length,
      unfinished: unfinished.length,
      rejected: rejected.length,
      invalidated: invalidated.length,
      activity: activity.length,
      errors: errors.length,
    },
    note: 'verified 只含 Host 能复核的成果（accepted + 通过校验的证据 + 产物版本，且未被证据失效剔除）；旧 accepted 作为 owner 历史声明列在 invalidated；activity 是调度活动、errors 是失败，两者都不算交付进展。',
  };
}

// ---------------------------------------------------------------------------
// §6 受管任务上下文：紧凑、分页、只读
// ---------------------------------------------------------------------------

/**
 * 构建一页上下文（默认紧凑，只含指针）。
 *
 * @param {object} input
 * @param {object[]} input.works 该成员的受管 work
 * @param {object[]} [input.attempts]
 * @param {object[]} [input.events] 成员事件（已消费/待处理）
 * @param {object[]} [input.fingerprints] 错误指纹组（保留"被否决方法/错误原因"事实）
 * @param {string} [input.cursor] 上一页的 nextCursor
 * @param {number} [input.limit] 每页条数（默认 10，上限 50）
 * @param {number} [input.budgetChars] 本页字符预算（默认 4000）
 * @param {boolean} [input.includeDetail] true 时才返回原文摘要（仍受预算限制）
 */
export function buildContextPage(input = {}) {
  const limit = Math.min(Math.max(Number.isInteger(input.limit) ? input.limit : 10, 1), 50);
  const budgetChars = Math.min(Math.max(Number.isInteger(input.budgetChars) ? input.budgetChars : 4000, 200), 200000);
  const includeDetail = input.includeDetail === true;
  const works = Array.isArray(input.works) ? input.works : [];
  const attempts = Array.isArray(input.attempts) ? input.attempts : [];
  const events = Array.isArray(input.events) ? input.events : [];
  const fingerprints = Array.isArray(input.fingerprints) ? input.fingerprints : [];

  const attemptsByWork = new Map();
  for (const attempt of attempts) {
    const bucket = attemptsByWork.get(attempt?.workId) ?? [];
    bucket.push(attempt);
    attemptsByWork.set(attempt?.workId, bucket);
  }
  const eventsByWork = new Map();
  for (const event of events) {
    const workId = event?.payload?.workId;
    if (!workId) continue;
    const bucket = eventsByWork.get(workId) ?? [];
    bucket.push(event);
    eventsByWork.set(workId, bucket);
  }
  const printsByWork = new Map();
  for (const group of fingerprints) {
    for (const workId of group.workIds ?? []) {
      const bucket = printsByWork.get(workId) ?? [];
      bucket.push(group);
      printsByWork.set(workId, bucket);
    }
  }

  const rows = works
    .map((work) => {
      const workAttempts = (attemptsByWork.get(work.workId) ?? []).slice().sort((left, right) => num(left.startedAt ?? left.reservedAt) - num(right.startedAt ?? right.reservedAt));
      const lastAttempt = workAttempts[workAttempts.length - 1] ?? null;
      const workEvents = (eventsByWork.get(work.workId) ?? []).slice().sort((left, right) => num(left.at) - num(right.at));
      const lastEvent = workEvents[workEvents.length - 1] ?? null;
      const workPrints = printsByWork.get(work.workId) ?? [];
      // 事实保留（契约 §5.5）：没有 work 级指纹时，退回**全部已知失败/被否决方案**，
      // 否则紧凑上下文会丢掉"这条错已经撞过、别再用"的关键事实。
      const prints = workPrints.length > 0 ? workPrints : fingerprints;
      const at = Math.max(num(work.updatedAt), num(lastAttempt?.startedAt), num(lastAttempt?.endedAt), num(lastEvent?.at));
      return {
        ref: `${work.workId}`,
        at,
        updatedAt: num(work.updatedAt),
        kind: 'work',
        workId: work.workId,
        ownerMemberId: work.ownerMemberId ?? null,
        title: work.title ?? '',
        state: work.state ?? 'unknown',
        // 紧凑指针：原件留在磁盘/记录里，按需用 workId 取。
        pointers: {
          outputs: (work.outputs ?? []).slice(0, 5),
          acceptanceCount: Array.isArray(work.acceptance) ? work.acceptance.length : 0,
          missing: Array.isArray(work.completion?.missing) ? work.completion.missing.slice(0, 5) : [],
          blockedReason: work.blockedReason ?? null,
          lastAttempt: lastAttempt ? { attemptId: lastAttempt.attemptId, state: lastAttempt.state } : null,
          pendingEvents: workEvents.filter((event) => event.state === 'pending').length,
          errorCodes: prints.map((group) => group.code).slice(0, 5),
        },
        // 事实保留：被否决方法/接口版本/错误原因（契约 §5.5：压缩后事实保留）
        facts: {
          interfaces: (work.artifactDependencies ?? []).map((dep) => `${dep.artifact}@v${dep.version}(${dep.requires})`).slice(0, 5),
          rejectedApproaches: prints.map((group) => ({ code: group.code, guidance: group.guidance })).slice(0, 3),
          unresolved: (work.lastFailureMessage ? [String(work.lastFailureMessage).slice(0, 160)] : []),
        },
        ...(includeDetail ? { detail: { deliverable: String(work.deliverable ?? '').slice(0, 400) } } : {}),
      };
    })
    .sort((left, right) => right.updatedAt - left.updatedAt || String(left.workId).localeCompare(String(right.workId)));

  // 游标：`updatedAt:workId`（稳定；被截断的项下次一定还能取到）
  const cursorParts = typeof input.cursor === 'string' && input.cursor.includes(':') ? input.cursor.split(':') : null;
  const cursorUpdatedAt = cursorParts ? num(cursorParts[0]) : null;
  const cursorWorkId = cursorParts ? cursorParts[1] : null;
  let startIndex = 0;
  if (cursorUpdatedAt !== null) {
    startIndex = rows.findIndex((row) => row.updatedAt < cursorUpdatedAt || (row.updatedAt === cursorUpdatedAt && String(row.workId) > String(cursorWorkId ?? '')));
    if (startIndex < 0) startIndex = rows.length;
  }

  const page = [];
  let usedChars = 0;
  let index = startIndex;
  /** 预算不足时把单行缩成**稳定指针 + 关键事实**（游标仍能取到完整原件）。 */
  const shrinkRowToBudget = (row, available) => {
    const clip = (value, max) => {
      const text = String(value ?? '');
      return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 12))}…`;
    };
    const candidates = [];
    // 1) 原行（若已在预算内直接返回）。
    candidates.push(row);
    // 2) 只缩指针与标题。
    candidates.push({
      ...row,
      title: clip(row.title, 40),
      pointers: { ...row.pointers, outputs: (row.pointers?.outputs ?? []).slice(0, 1).map((item) => clip(item, 60)), missing: (row.pointers?.missing ?? []).slice(0, 2).map((item) => clip(item, 30)) },
      facts: { interfaces: (row.facts?.interfaces ?? []).slice(0, 1).map((item) => clip(item, 40)), rejectedApproaches: [], unresolved: (row.facts?.unresolved ?? []).slice(0, 1).map((item) => clip(item, 80)) },
    });
    // 3) 最小稳定指针（workId/state/ref/updatedAt + 原件入口）。
    candidates.push({
      ref: row.ref,
      at: row.at,
      updatedAt: row.updatedAt,
      kind: 'work',
      workId: clip(row.workId, 60),
      ownerMemberId: row.ownerMemberId,
      title: clip(row.title, 24),
      state: row.state,
      pointers: { outputs: [], acceptanceCount: row.pointers?.acceptanceCount ?? 0, missing: [], blockedReason: row.pointers?.blockedReason ?? null, lastAttempt: null, pendingEvents: 0, errorCodes: (row.pointers?.errorCodes ?? []).slice(0, 2) },
      facts: { interfaces: [], rejectedApproaches: [], unresolved: (row.facts?.unresolved ?? []).slice(0, 1).map((item) => clip(item, 40)) },
      compacted: true,
      pointerNote: '行内容超出页面字符预算：已缩成稳定指针，用 workId 取完整原件。',
    });
    // 4) 绝对最小指针：预算极小时仍给出可继续查询的身份。
    candidates.push({
      ref: row.ref,
      workId: clip(row.workId, 48),
      state: row.state,
      kind: 'work',
      compacted: true,
      note: '预算不足：已缩成最小指针，用 team_context_query 加大 budgetChars 取完整行。',
    });
    for (const candidate of candidates) {
      const size = JSON.stringify(candidate).length;
      if (size <= available) return { row: candidate, size };
    }
    return null;
  };
  for (; index < rows.length && page.length < limit; index += 1) {
    const row = rows[index];
    const size = JSON.stringify(row).length;
    if (usedChars + size <= budgetChars) {
      page.push(row);
      usedChars += size;
      continue;
    }
    // 首项也不能无界突破：预算内缩成稳定指针；连指针都放不下 → 本页为空（hasMore 保留，让调用方加大预算）。
    const available = budgetChars - usedChars;
    const shrunk = shrinkRowToBudget(row, available);
    if (shrunk) {
      page.push(shrunk.row);
      usedChars += shrunk.size;
    }
    break;
  }
  const hasMore = index < rows.length;
  const last = page[page.length - 1];

  return {
    kind: 'managed-context-page',
    generatedAt: num(input.now) || Date.now(),
    scope: { teamKey: input.teamKey ?? null, memberId: input.memberId ?? null },
    rows: page,
    count: page.length,
    total: rows.length,
    hasMore,
    nextCursor: hasMore && last ? `${last.updatedAt}:${last.workId}` : null,
    budget: { chars: budgetChars, used: usedChars, truncated: hasMore },
    sources: {
      works: works.length,
      attempts: attempts.length,
      events: events.length,
      errorFingerprints: fingerprints.length,
    },
    includeDetail,
    note: '受管任务上下文默认紧凑分页（只给指针对与事实摘要，原件留在磁盘按需取）；本查询只读，不触发模型调用、不改状态、不放大续工额度。',
  };
}

/** 分页/预算的默认值（供工具 schema 与实现共用，避免 schema 与运行时限额不一致）。 */
export const CONTEXT_LIMITS = Object.freeze({ defaultLimit: 10, maxLimit: 50, defaultBudgetChars: 4000, minBudgetChars: 200, maxBudgetChars: 200000 });

/** findings 快照 digest（用于前端判断"是否需要刷新"，不触发重算）。 */
export function findingsDigest(findings) {
  return sha256Hex(JSON.stringify({ verified: findings?.counts?.verified ?? 0, inProgress: findings?.counts?.inProgress ?? 0, unfinished: findings?.counts?.unfinished ?? 0, rejected: findings?.counts?.rejected ?? 0, invalidated: findings?.counts?.invalidated ?? 0 })).slice(0, 16);
}
