/**
 * Reference (simulated) implementation of docs/ARCHITECTURE.md；历史检查 2.3.
 *
 * Exists so the harness can be exercised end-to-end before the real
 * `src/host/service.js` lands. All suites that use it are marked
 * `simulated: true`; results from it are never reported as real acceptance.
 */
import { createReferencePolicy } from './reference-policy.mjs';

export class WorkbenchError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'WorkbenchError';
    this.code = code;
    this.detail = detail;
  }
}

const TERMINAL_ATTEMPT_STATES = new Set(['produced', 'failed', 'cancelled']);
const SATISFIED_WORK_STATES = new Set(['produced', 'verifying', 'accepted', 'completed']);

export function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** §2.5 ready(task) — deliberately free of any whole-batch barrier. */
export function computeReady(works, options = {}) {
  const failedOwners = options.failedOwners ?? new Set();
  const out = [];
  for (const work of works.values ? works.values() : works) {
    if (failedOwners.has(work.ownerMemberId)) continue;
    const blockersSatisfied = (work.blockedBy ?? []).every((id) => {
      const blocker = works.get ? works.get(id) : works.find((entry) => entry.workId === id);
      return blocker && SATISFIED_WORK_STATES.has(blocker.state);
    });
    if (!blockersSatisfied) continue;
    const idleClaim = work.state === 'claimed' && !work.activeAttemptId;
    if (work.state === 'ready' || work.state === 'blocked' || idleClaim) out.push(work);
  }
  return out;
}

export function createReferenceService(deps) {
  const { adapter, storage, clock } = deps;
  const config = deps.config ?? {};
  const policy = deps.policy ?? createReferencePolicy(config.policy ?? {});

  const teams = new Map();
  const members = new Map(); // memberId -> { memberId, sessionId, name, role, teamKey, status, kind }
  const works = new Map();
  const attempts = new Map();
  const lateResults = [];
  const counters = { work: 0, attempt: 0 };
  const leadSessionId = deps.leadSessionId ?? 'session-lead';

  function memberOf(caller) {
    const membership = adapter.membership(caller);
    if (!membership) throw new WorkbenchError('TEAM_NOT_MEMBER', 'caller is not a team member');
    return membership;
  }

  function requireWork(workId) {
    const work = works.get(String(workId));
    if (!work) throw new WorkbenchError('WORK_NOT_FOUND', `unknown work ${workId}`);
    return work;
  }

  const service = {
    simulated: true,
    policy,
    storage,

    // ---- observation ------------------------------------------------------
    snapshot() {
      return {
        simulated: true,
        teams: [...teams.values()].map(clone),
        members: [...members.values()].map(clone),
        works: [...works.values()].map(clone),
        attempts: [...attempts.values()].map(clone),
        lateResults: lateResults.map(clone),
        counters: { ...counters },
        diagnostics: adapter.diagnostics(),
      };
    },

    /** Test-facing accessor: lateResults table (invariant 5). */
    lateResults() {
      return lateResults.map(clone);
    },

    attemptsFor(workId) {
      return [...attempts.values()].filter((attempt) => attempt.workId === workId).map(clone);
    },

    /** Live work references (NOT clones) for the scheduler's state lock. */
    __works() {
      return [...works.values()];
    },

    activeAttempts() {
      return [...attempts.values()].filter((attempt) => attempt.slotHeld !== false);
    },

    /**
     * Release the resident/worker slot of attempts whose child already settled
     * natively. Runs inside the state lock at the head of every tick so a
     * settlement frees capacity immediately instead of waiting for a report.
     */
    async __reconcileCapacity() {
      const released = [];
      const children = adapter.childrenSnapshot();
      for (const attempt of attempts.values()) {
        if (attempt.slotHeld === false) continue;
        if (attempt.state === 'starting') continue; // receipt reconciliation owns this state
        const child = children.find((entry) => entry.id === attempt.executorChildId);
        if (!child || child.status !== 'running') {
          attempt.slotHeld = false;
          if (attempt.state === 'executing') attempt.state = 'awaiting-report';
          attempt.settledAt = attempt.settledAt ?? clock.now();
          if (child?.stopReason) attempt.stopReason = child.stopReason;
          await storage.put('attempts', attempt.attemptId, clone(attempt));
          released.push({ attemptId: attempt.attemptId, workId: attempt.workId, childId: attempt.executorChildId });
        }
      }
      return released;
    },

    // ---- teams / members --------------------------------------------------
    defineTeam(caller, spec = {}) {
      memberOf(caller);
      const teamKey = String(spec.teamKey ?? `team-${teams.size + 1}`);
      const team = { teamKey, title: String(spec.title ?? teamKey), createdAt: clock.now(), members: [] };
      teams.set(teamKey, team);
      return clone(team);
    },

    createMember(caller, spec = {}) {
      const membership = memberOf(caller);
      if (membership.role !== 'lead') throw new WorkbenchError('TEAM_LEAD_REQUIRED', 'only the lead may create members');
      const result = adapter.spawnTeammate(caller, {
        name: String(spec.name ?? `member-${members.size + 1}`),
        description: String(spec.description ?? ''),
        prompt: [],
        context: spec.context ?? 'fresh',
        provider: spec.provider ?? 'default',
      });
      if (!result.ok) throw new WorkbenchError(result.code, result.message);
      const sessionId = result.value?.member?.id ?? result.member?.id;
      const member = {
        memberId: `member-${members.size + 1}`,
        sessionId,
        name: String(spec.name ?? sessionId),
        role: 'teammate',
        teamKey: String(spec.teamKey ?? 'default'),
        status: 'running',
        kind: 'member',
      };
      members.set(member.memberId, member);
      const team = teams.get(member.teamKey);
      if (team) team.members.push(member.memberId);
      // A member session is itself a resident Activation (plan §7: 5 members × 6 leaves = 35).
      adapter.registerAgent(sessionId, { name: member.name });
      adapter.registerMembership(sessionId, { root: caller, id: membership.id, role: 'teammate', name: member.name });
      return clone(member);
    },

    listMembers() {
      return [...members.values()].map(clone);
    },

    // ---- work items --------------------------------------------------------
    async submitWork(caller, spec = {}) {
      const membership = memberOf(caller);
      // Idempotency: reserve the key first, then create. A repeated submit of the
      // same intention must return the first work instead of a second one.
      let reservation = null;
      if (spec.idempotencyKey) {
        reservation = await storage.put('counters', `idem:${spec.idempotencyKey}`, { workId: null }, {
          idempotencyKey: `work-idem:${spec.idempotencyKey}`,
        });
        if (reservation.code === 'IDEMPOTENT_REPLAY') {
          const existingId = reservation.record?.value?.workId;
          if (existingId && works.has(existingId)) return clone(works.get(existingId));
        }
      }
      const validated = policy.validateWorkSpec(spec);
      if (!validated.ok) {
        throw new WorkbenchError(validated.code, validated.message, { hint: validated.hint });
      }
      const normalized = validated.normalized;
      const workId = normalized.workId ?? `work-${++counters.work}`;
      if (works.has(workId)) {
        throw new WorkbenchError('WORK_EXISTS', `work ${workId} already exists`);
      }
      const ownerMember = members.get(normalized.ownerMemberId)
        ?? [...members.values()].find((member) => member.name === (spec.ownerName ?? membership.name));
      const work = {
        workId,
        teamKey: normalized.teamKey,
        title: normalized.title,
        deliverable: normalized.deliverable,
        ownerMemberId: ownerMember?.memberId ?? normalized.ownerMemberId ?? membership.name,
        ownerName: ownerMember?.name ?? spec.ownerName ?? membership.name,
        splitKind: 'independent-deliverable',
        kind: normalized.kind,
        inputs: normalized.inputs,
        outputs: normalized.outputs,
        acceptance: normalized.acceptance,
        artifactDependencies: normalized.artifactDependencies,
        writeScopes: normalized.writeScopes,
        contextPolicy: normalized.contextPolicy,
        delegationBudget: normalized.delegationBudget,
        nativeTaskId: null,
        revision: 1,
        state: normalized.blockedBy.length > 0 ? 'blocked' : 'ready',
        blockedBy: normalized.blockedBy,
        blockedReason: null,
        attempts: [],
        activeAttemptId: null,
        artifactRefs: [],
        evidenceRefs: [],
        priority: normalized.priority,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      };
      if (spec.nativeTask !== false) {
        const created = adapter.createTask(caller, { subject: work.title, description: work.deliverable, blockedBy: [], writeScopes: work.writeScopes });
        if (created.ok) work.nativeTaskId = created.value?.id ?? created.id;
      }
      works.set(workId, work);
      const written = await storage.put('works', workId, clone(work));
      if (written.ok) work.revision = written.rev;
      if (reservation?.ok) {
        await storage.put('counters', `idem:${spec.idempotencyKey}`, { workId }, { expectRev: reservation.rev });
      }
      return clone(work);
    },

    async claimWork(caller, request = {}) {
      const membership = memberOf(caller);
      const work = requireWork(request.workId);
      if (Number(request.expectedRevision) !== work.revision) {
        throw new WorkbenchError('CAS_MISMATCH', `stale revision ${request.expectedRevision} != ${work.revision}`, { current: clone(work) });
      }
      if (work.activeAttemptId) {
        throw new WorkbenchError('ALREADY_CLAIMED', `work ${work.workId} already has an active attempt`, { current: clone(work) });
      }
      if (!['ready', 'blocked', 'claimed'].includes(work.state)) {
        throw new WorkbenchError('INVALID_STATE', `work ${work.workId} is ${work.state}`);
      }
      if (work.state === 'blocked' && !(work.blockedBy ?? []).every((id) => SATISFIED_WORK_STATES.has(works.get(id)?.state))) {
        throw new WorkbenchError('NOT_READY', `work ${work.workId} still blocked`);
      }
      const next = clone(work);
      next.ownerMemberId = next.ownerMemberId ?? membership.name;
      next.state = 'claimed';
      next.revision = work.revision + 1;
      next.updatedAt = clock.now();
      next.activeAttemptId = request.attemptId ?? null;
      const written = await storage.put('works', work.workId, next, { expectRev: work.revision });
      if (!written.ok) throw new WorkbenchError(written.code, 'compare-and-set refused the claim', { current: written.current });
      Object.assign(work, next);
      return clone(work);
    },

    async reportWork(caller, request = {}) {
      memberOf(caller);
      const work = requireWork(request.workId);
      const attempt = attempts.get(String(request.attemptId));
      if (!attempt) throw new WorkbenchError('ATTEMPT_NOT_FOUND', `unknown attempt ${request.attemptId}`);
      if (attempt.workId !== work.workId) throw new WorkbenchError('ATTEMPT_WORK_MISMATCH', 'attempt belongs to another work');

      const leaseMatches = Number(request.leaseEpoch) === Number(attempt.leaseEpoch);
      const liveState = attempt.state === 'executing' || attempt.state === 'starting'
        || attempt.state === 'awaiting-report' || attempt.state === 'produced';
      if (!leaseMatches || !liveState) {
        const late = {
          workId: work.workId,
          attemptId: attempt.attemptId,
          leaseEpoch: request.leaseEpoch ?? null,
          currentLeaseEpoch: attempt.leaseEpoch,
          reason: leaseMatches ? `ATTEMPT_${String(attempt.state).toUpperCase()}` : 'STALE_LEASE',
          archivedAt: clock.now(),
          summary: String(request.summary ?? ''),
        };
        lateResults.push(late);
        await storage.put('lateResults', `${attempt.attemptId}:${lateResults.length}`, late);
        return { ok: false, code: 'LATE_RESULT_ARCHIVED', lateResult: late, work: clone(work) };
      }
      if (attempt.state === 'produced') {
        return { ok: true, code: 'IDEMPOTENT_REPLAY', work: clone(work), attempt: clone(attempt) };
      }

      attempt.state = request.outcome === 'failed' ? 'failed' : 'produced';
      attempt.slotHeld = false;
      attempt.summary = String(request.summary ?? '');
      attempt.artifacts = Array.isArray(request.artifacts) ? request.artifacts : [];
      attempt.evidence = Array.isArray(request.evidence) ? request.evidence : [];
      attempt.settledAt = clock.now();
      attempt.unresolved = Array.isArray(request.unresolved) ? request.unresolved : [];
      const gate = policy.completionGate(work, attempt, request);

      const previousRevision = work.revision;
      work.state = attempt.state === 'produced' ? 'produced' : 'failed';
      work.revision += 1;
      work.updatedAt = clock.now();
      work.activeAttemptId = null;
      work.artifactRefs = attempt.artifacts.map((artifact) => (typeof artifact === 'string' ? { path: artifact, version: 1 } : artifact));
      work.evidenceRefs = attempt.evidence.slice();
      const written = await storage.put('works', work.workId, clone(work), { expectRev: previousRevision });
      if (!written.ok) throw new WorkbenchError(written.code, 'report refused by compare-and-set', { current: written.current });
      await storage.put('attempts', attempt.attemptId, clone(attempt));
      return { ok: true, work: clone(work), attempt: clone(attempt), gate };
    },

    // ---- execution ---------------------------------------------------------
    async startSubagent(caller, request = {}) {
      const membership = memberOf(caller);
      const work = requireWork(request.workId);
      if (work.activeAttemptId) throw new WorkbenchError('ALREADY_CLAIMED', `work ${work.workId} already has an active attempt`);
      if (!['ready', 'blocked', 'claimed'].includes(work.state)) throw new WorkbenchError('INVALID_STATE', `work ${work.workId} is ${work.state}`);
      const attempt = await service.__allocateAttempt(work, { parent: caller, memberName: membership.name, brief: request.brief });
      return service.__launchAttempt(attempt);
    },

    /**
     * Atomic reservation inside the state lock: one `attempt/<workId>` record
     * carries the pre-allocated childId, the lease and the capacity intent.
     */
    async __allocateAttempt(work, options = {}) {
      const index = ++counters.attempt;
      const attemptId = `attempt-${index}`;
      const childId = `child-pre-${index}`;
      const attempt = {
        attemptId,
        workId: work.workId,
        teamKey: work.teamKey,
        ownerMemberId: work.ownerMemberId,
        ownerName: work.ownerName,
        role: 'leaf',
        parentSessionId: options.parent?.id ?? leadSessionId,
        executorChildId: childId,
        state: 'starting',
        leaseEpoch: 1,
        slotHeld: true,
        reservedAt: clock.now(),
        startedAt: null,
        heartbeatAt: clock.now(),
        intent: { childId, persistedAt: clock.now(), brief: options.brief ?? null },
        receiptLost: false,
        artifacts: [],
        evidence: [],
        summary: '',
        outcome: null,
        recovery: null,
      };
      attempts.set(attemptId, attempt);
      const previousRevision = work.revision;
      work.attempts.push(attemptId);
      work.activeAttemptId = attemptId;
      work.state = 'executing';
      work.revision += 1;
      work.updatedAt = clock.now();
      await storage.put('attempts', attemptId, clone(attempt), { idempotencyKey: `attempt:${work.workId}:${index}` });
      await storage.put('works', work.workId, clone(work), { expectRev: previousRevision });
      return attempt;
    },

    /** Outside the state lock: talk to the native runtime. */
    async __launchAttempt(attempt) {
      const parent = adapter.agentFor(attempt.parentSessionId) ?? adapter.agentFor(leadSessionId);
      const result = await adapter.startContinuable({
        provider: 'team-workbench-leaf',
        label: `${attempt.workId}#${attempt.attemptId}`,
        childId: attempt.executorChildId,
        request: { parent, prompt: [{ type: 'text', text: `execute ${attempt.workId}` }] },
      });
      if (result.ok) {
        attempt.state = 'executing';
        attempt.startedAt = clock.now();
        attempt.receiptLost = false;
      } else if (result.code === 'START_RECEIPT_LOST') {
        attempt.state = 'starting';
        attempt.receiptLost = true;
      } else {
        attempt.state = 'failed';
        attempt.slotHeld = false;
        attempt.outcome = result.code;
      }
      await storage.put('attempts', attempt.attemptId, clone(attempt));
      return clone(attempt);
    },

    // ---- recovery ----------------------------------------------------------
    async __reconcileStarting() {
      const reconciled = [];
      for (const attempt of attempts.values()) {
        if (attempt.state !== 'starting') continue;
        const listed = await adapter.listChildren(attempt.parentSessionId);
        const entries = listed?.value ?? listed?.entries ?? [];
        const found = Array.isArray(entries) ? entries.find((entry) => entry.id === attempt.executorChildId) : undefined;
        if (found) {
          attempt.state = 'executing';
          attempt.startedAt = attempt.startedAt ?? clock.now();
          attempt.recoveredBy = 'native-catalog';
          attempt.receiptLost = false;
        } else {
          attempt.state = 'failed';
          attempt.slotHeld = false;
          attempt.outcome = 'RECEIPT_LOST_NO_CATALOG';
        }
        await storage.put('attempts', attempt.attemptId, clone(attempt));
        reconciled.push({ attemptId: attempt.attemptId, childId: attempt.executorChildId, state: attempt.state, recoveredBy: attempt.recoveredBy ?? null });
      }
      return reconciled;
    },

    async reconcile(caller) {
      if (caller) memberOf(caller);
      const steps = [];
      const resumedAttempts = [];
      const notRestarted = [];
      const receiptReconciled = [];

      // 1. parents (members) first — a child cannot be resumed before its parent
      for (const member of members.values()) {
        const live = adapter.agentFor(member.sessionId);
        steps.push({ kind: 'member', id: member.memberId, sessionId: member.sessionId, status: live ? 'live' : 'missing' });
      }
      // 2. works: already produced must never be re-run
      for (const work of works.values()) {
        if (SATISFIED_WORK_STATES.has(work.state)) {
          notRestarted.push(work.workId);
          steps.push({ kind: 'work', id: work.workId, status: 'already-produced' });
        } else if (work.state === 'executing' && !work.activeAttemptId) {
          work.state = work.blockedBy?.length ? 'blocked' : 'ready';
          work.updatedAt = clock.now();
          steps.push({ kind: 'work', id: work.workId, status: 'requeued' });
        }
      }
      // 3. children: reconcile lost receipts through the native catalog
      for (const entry of await service.__reconcileStarting()) {
        receiptReconciled.push(entry);
        steps.push({ kind: 'child', id: entry.childId, attemptId: entry.attemptId, status: entry.state });
        if (entry.state === 'executing') resumedAttempts.push(entry.attemptId);
      }

      const ready = computeReady(works).map((work) => work.workId);
      return {
        simulated: true,
        steps,
        order: steps.map((step) => step.kind),
        resumedAttempts,
        receiptReconciled,
        notRestarted,
        readyAfter: ready,
        writerEpoch: storage.writerEpoch,
      };
    },

    // ---- lifecycle ---------------------------------------------------------
    interruptWork(caller, request = {}) {
      memberOf(caller);
      const work = requireWork(request.workId);
      const attempt = work.activeAttemptId ? attempts.get(work.activeAttemptId) : null;
      if (attempt) {
        adapter.interruptChild(attempt.executorChildId, attempt.parentSessionId, 'continuable');
        attempt.state = 'cancelled';
        attempt.slotHeld = false;
        attempt.outcome = 'interrupted';
      }
      work.state = 'cancelled';
      work.revision += 1;
      work.activeAttemptId = null;
      return clone(work);
    },

    interruptTeam(caller, request = {}) {
      memberOf(caller);
      const teamKey = String(request.teamKey ?? '');
      const stopped = [];
      for (const work of works.values()) {
        if (teamKey && work.teamKey !== teamKey) continue;
        if (SATISFIED_WORK_STATES.has(work.state)) continue;
        service.interruptWork(caller, { workId: work.workId });
        stopped.push(work.workId);
      }
      return { teamKey, stopped };
    },

    // ---- layout (thin; UI suites own the real behaviour) -------------------
    layout() {
      return { mode: 'single', panes: [], activePaneId: null };
    },
    setLayout(mode) {
      return { mode, panes: [], activePaneId: null };
    },
    upsertPane() {
      return service.layout();
    },
    removePane() {
      return service.layout();
    },
    focusPane() {
      return service.layout();
    },
  };

  return service;
}

export default createReferenceService;
