/**
 * Reference (simulated) implementation of docs/ARCHITECTURE.md；历史检查 2.5.
 *
 * Implements the frozen rolling-refill algorithm with no whole-batch barrier:
 *   reconcile -> compute ready -> reserve fairly inside the state lock ->
 *   launch outside the lock, one settlement at a time.
 *
 * Simulated only: the real `src/host/scheduler.js` is the deliverable.
 */
import { computeReady } from './reference-service.mjs';

const TERMINAL = new Set(['produced', 'failed', 'cancelled']);

export function defaultReferenceConfig(overrides = {}) {
  return {
    singleWriter: true,
    capacity: {
      hostActivationLimit: 40,
      globalLeafLimit: 30,
      recoveryReserve: 3,
      interactiveReserve: 2,
      perMemberLeaves: 6,
      perMemberAttempts: 24,
      teamsMaxConcurrent: 3,
      providerRequestLimit: null,
      ...(overrides.capacity ?? {}),
    },
    scheduler: {
      agingPerMinute: 1.5,
      maxStartsPerTick: 8,
      wakeCoalesceMs: 40,
      ...(overrides.scheduler ?? {}),
    },
    policy: {
      splitBy: 'independent-deliverable',
      phaseRelay: 'reject',
      requireArtifactVersion: true,
      completionGate: 'acceptance-satisfied',
      ...(overrides.policy ?? {}),
    },
  };
}

/** Workspace-relative write-scope overlap, mirroring the native prefix rule. */
export function scopesConflict(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  for (const one of a) {
    for (const two of b) {
      if (one === two) return true;
      if (one.startsWith(`${two}/`)) return true;
      if (two.startsWith(`${one}/`)) return true;
    }
  }
  return false;
}

export function createReferenceScheduler(deps) {
  const { service, adapter, storage, clock } = deps;
  const config = deps.config ?? defaultReferenceConfig();
  const cap = config.capacity;
  const schedConfig = config.scheduler;

  const notifications = [];
  const tickLog = [];
  const startedOrder = [];
  const fairCursor = new Map();
  let tickSeq = 0;
  let running = false;
  let autoTickScheduled = false;

  function memberSessionIds() {
    return adapter.memberships.filter((membership) => membership.role === 'teammate').length;
  }

  function capacityView() {
    const active = service.activeAttempts();
    const leaves = active.filter((attempt) => attempt.role === 'leaf');
    const members = memberSessionIds();
    const teams = {};
    const memberRows = {};
    for (const attempt of leaves) {
      teams[attempt.teamKey] = teams[attempt.teamKey] ?? { inUse: 0, fairShare: Math.max(1, Math.ceil(cap.globalLeafLimit / Math.max(1, Object.keys(teams).length + 1))) };
      teams[attempt.teamKey].inUse += 1;
      memberRows[attempt.ownerMemberId] = memberRows[attempt.ownerMemberId] ?? { inUse: 0, fairShare: cap.perMemberLeaves };
      memberRows[attempt.ownerMemberId].inUse += 1;
    }
    const leafCeiling = Math.max(0, Math.min(cap.globalLeafLimit, cap.hostActivationLimit - members - cap.recoveryReserve - cap.interactiveReserve));
    return {
      hostActivationLimit: cap.hostActivationLimit,
      residentCapacity: cap.hostActivationLimit,
      workerCapacity: leafCeiling,
      leafCeiling,
      providerCapacity: cap.providerRequestLimit ?? null,
      residentInUse: members + active.length,
      activeLeaves: leaves.length,
      providerInUse: leaves.length,
      interactiveReserve: cap.interactiveReserve,
      recoveryReserve: cap.recoveryReserve,
      memberCount: members,
      teams,
      members: memberRows,
    };
  }

  function activeWorkScopeOwners() {
    const list = [];
    const works = service.__works();
    for (const attempt of service.activeAttempts()) {
      const work = works.find((entry) => entry.workId === attempt.workId);
      if (work) list.push(work);
    }
    return list;
  }

  /** Rotating, aging-weighted fair order over (teamKey, ownerMemberId) groups. */
  function orderFairly(candidates) {
    const groups = new Map();
    for (const work of candidates) {
      const key = `${work.teamKey}::${work.ownerMemberId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(work);
    }
    for (const bucket of groups.values()) {
      bucket.sort((left, right) => {
        if (right.priority !== left.priority) return right.priority - left.priority;
        const ageLeft = (clock.now() - left.createdAt) / 60000 * schedConfig.agingPerMinute;
        const ageRight = (clock.now() - right.createdAt) / 60000 * schedConfig.agingPerMinute;
        if (ageRight !== ageLeft) return ageRight - ageLeft;
        return left.createdAt - right.createdAt;
      });
    }
    const keys = [...groups.keys()].sort();
    const start = fairCursor.get('index') ?? 0;
    const ordered = [];
    let offset = 0;
    while (ordered.length < candidates.length && offset < 1000) {
      let added = false;
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[(index + start) % keys.length];
        const bucket = groups.get(key);
        if (bucket.length > 0) {
          ordered.push(bucket.shift());
          added = true;
        }
      }
      if (!added) break;
      offset += 1;
    }
    fairCursor.set('index', (start + 1) % Math.max(1, keys.length));
    return ordered;
  }

  async function tick() {
    tickSeq += 1;
    const report = {
      tick: tickSeq,
      at: clock.now(),
      mode: 'mutating',
      readyBefore: [],
      started: [],
      rejected: [],
      lateResults: [],
      reconciled: [],
      capacityAfter: null,
    };

    // 1. reconcile receipts / capacity inside the state lock
    report.capacityReleased = await service.__reconcileCapacity();
    report.reconciled = await service.__reconcileStarting();

    // 2. refresh the affected ready set
    const works = service.__works();
    const failedOwners = new Set(service.listMembers().filter((member) => member.status === 'failed').map((member) => member.memberId));
    const ready = computeReady(new Map(works.map((work) => [work.workId, work])), { failedOwners });
    report.readyBefore = ready.map((work) => work.workId).sort();

    // 3. reserve fairly (no waiting inside the lock)
    const view = capacityView();
    const perMember = new Map();
    for (const attempt of service.activeAttempts()) {
      if (attempt.role !== 'leaf') continue;
      perMember.set(attempt.ownerMemberId, (perMember.get(attempt.ownerMemberId) ?? 0) + 1);
    }
    const activeTeams = new Set(service.activeAttempts().map((attempt) => attempt.teamKey));
    const scopeOwners = activeWorkScopeOwners();
    const plans = [];
    let slots = Math.max(0, view.leafCeiling - view.activeLeaves);
    slots = Math.min(slots, schedConfig.maxStartsPerTick);

    for (const work of orderFairly(ready)) {
      if (plans.length >= slots) {
        report.rejected.push({ workId: work.workId, code: 'CAPACITY_FULL' });
        continue;
      }
      const memberUsed = perMember.get(work.ownerMemberId) ?? 0;
      if (memberUsed >= cap.perMemberLeaves) {
        report.rejected.push({ workId: work.workId, code: 'CAPACITY_FULL', scope: 'member' });
        continue;
      }
      if (!activeTeams.has(work.teamKey) && activeTeams.size >= cap.teamsMaxConcurrent) {
        report.rejected.push({ workId: work.workId, code: 'CAPACITY_FULL', scope: 'team' });
        continue;
      }
      const conflicting = [...scopeOwners, ...plans.map((plan) => plan.work)]
        .find((other) => other.workId !== work.workId
          && other.workId !== work.workId
          && scopesConflict(other.writeScopes, work.writeScopes)
          && !TERMINAL.has(other.state));
      if (conflicting) {
        report.rejected.push({ workId: work.workId, code: 'WRITE_SCOPE_CONFLICT', withWorkId: conflicting.workId });
        continue;
      }
      plans.push({ work, ownerMemberId: work.ownerMemberId });
      perMember.set(work.ownerMemberId, memberUsed + 1);
      activeTeams.add(work.teamKey);
      scopeOwners.push(work);
    }

    // 4. launch outside the state lock, one settlement at a time
    for (const plan of plans) {
      const attempt = await service.__allocateAttempt(plan.work, { parent: adapter.agentFor(plan.work.ownerSessionId ?? 'session-lead') });
      const launched = await service.__launchAttempt(attempt);
      const entry = {
        workId: plan.work.workId,
        attemptId: launched.attemptId,
        childId: launched.executorChildId,
        startedAt: launched.startedAt ?? clock.now(),
        teamKey: plan.work.teamKey,
        ownerMemberId: plan.ownerMemberId,
        state: launched.state,
      };
      report.started.push(entry);
      startedOrder.push(entry);
    }

    report.capacityAfter = capacityView();
    tickLog.push({ tick: tickSeq, at: report.at, started: report.started.length, rejected: report.rejected.length, activeLeaves: report.capacityAfter.activeLeaves });
    return report;
  }

  const scheduler = {
    simulated: true,
    config,
    capacity: capacityView,
    startedOrder,
    tickLog,

    start() {
      running = true;
      return () => {
        running = false;
      };
    },

    stop() {
      running = false;
    },

    /** Idempotent wakeup; multiple events in one turn collapse into one tick. */
    notify(reason, detail) {
      notifications.push({ reason: String(reason ?? 'event'), detail: detail ?? null, at: clock.now() });
      if (running && !autoTickScheduled) {
        autoTickScheduled = true;
        queueMicrotask(() => {
          autoTickScheduled = false;
          void tick();
        });
      }
      return notifications.length;
    },

    notifications() {
      return notifications.slice();
    },

    tick,
  };

  return scheduler;
}

export default createReferenceScheduler;
