/**
 * Deterministic, injectable fake for the native DSH Host seam described in
 * docs/ARCHITECTURE.md；历史检查 2.1.
 *
 * This is the *only* place in the test tree that pretends to be the native
 * runtime. It is deliberately strict where the real runtime is strict
 * (activation pool refusal, lead-only spawn, CAS on task revision, durable
 * domain open) so a scheduler that over-reserves capacity fails loudly here.
 *
 * Every method follows the frozen adapter rule:
 *   success -> { ok:true, value }   (value fields are also spread on top level)
 *   failure -> { ok:false, code, message }
 * Nothing throws across the seam.
 */
import { createFakeStorageDomain } from './fake-domain.mjs';
import { createFakeClock } from './fake-clock.mjs';

/** Activation capacity error code, verbatim from the live subagent runtime. */
export const ACTIVATION_LIMIT_REACHED = 'ACTIVATION_LIMIT_REACHED';

export function createFakeAdapter(options = {}) {
  const clock = options.clock ?? createFakeClock();
  const domainFacility = options.storageDomain ?? createFakeStorageDomain();
  const activationLimit = Number.isFinite(options.activationLimit) ? options.activationLimit : 40;

  const diagnostics = [];
  const counters = {
    agentFor: 0,
    membership: 0,
    listMembers: 0,
    listTasks: 0,
    getTask: 0,
    createTask: 0,
    updateTask: 0,
    sendTeamMessage: 0,
    waitForChange: 0,
    spawnTeammate: 0,
    interrupt: 0,
    startContinuable: 0,
    listChildren: 0,
    listDescendants: 0,
    interruptChild: 0,
    openDomain: 0,
    registerProjection: 0,
    now: 0,
  };

  /** native-side state */
  const agents = new Map(); // sessionId -> { id }
  const memberships = new Map(); // sessionId -> TeamMembership
  const tasks = new Map(); // taskId -> TeamTaskView
  const children = new Map(); // childId -> { id, parentSessionId, label, mode, createdAt, status, stopReason }
  const activeActivations = new Set(); // childId currently holding a resident slot
  const memberActivations = new Set(); // teammate sessions holding a resident slot (members are Activations too)
  const startLog = []; // every accepted startContinuable, in order
  const fullRejections = []; // every ACTIVATION_LIMIT_REACHED refusal
  const messageLog = [];
  let taskSeq = 0;
  let childSeq = 0;

  /** scripted receipt behaviour queue; consumed one per startContinuable call */
  let receiptPlan = Array.isArray(options.receiptPlan) ? options.receiptPlan.slice() : [];

  function record(call, ok, detail) {
    diagnostics.push({ at: clock.now(), call, ok, code: ok ? null : (detail?.code ?? null) });
    if (diagnostics.length > 500) diagnostics.shift();
  }

  function fail(call, code, message, extra) {
    record(call, false, { code });
    return { ok: false, code, message: String(message ?? code), ...(extra ?? {}) };
  }

  function succeed(call, value) {
    record(call, true);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { ok: true, value, ...value };
    }
    return { ok: true, value };
  }

  function registerAgent(id, meta = {}) {
    const agent = { id: String(id), ...meta };
    agents.set(agent.id, agent);
    return agent;
  }

  function registerMembership(sessionId, membership) {
    memberships.set(String(sessionId), membership);
    return membership;
  }

  const adapter = {
    clock,
    available: {
      agentTeams: true,
      subagents: true,
      agents: true,
      storageDomain: true,
      projections: true,
      webServer: true,
    },
    /** simulated = this adapter is not the real DSH runtime */
    simulated: true,

    // ---- identity -----------------------------------------------------------
    agentFor(sessionId) {
      counters.agentFor += 1;
      const key = String(sessionId ?? '');
      return agents.get(key);
    },

    membership(agent) {
      counters.membership += 1;
      if (!agent || typeof agent.id !== 'string') return undefined;
      // exact live identity only, mirroring tryMembership
      if (agents.get(agent.id) !== agent) return undefined;
      return memberships.get(agent.id);
    },

    listMembers(agent) {
      counters.listMembers += 1;
      const membership = adapter.membership(agent);
      if (!membership) return fail('listMembers', 'TEAM_NOT_MEMBER', 'caller is not a team member');
      const roster = [];
      for (const [sessionId, entry] of memberships.entries()) {
        if (entry.id !== membership.id) continue;
        roster.push({
          id: sessionId,
          name: entry.name,
          role: entry.role,
          status: 'running',
          diagnostics: [],
        });
      }
      return succeed('listMembers', roster);
    },

    // ---- native team task board --------------------------------------------
    listTasks(agent) {
      counters.listTasks += 1;
      if (!adapter.membership(agent)) return fail('listTasks', 'TEAM_NOT_MEMBER', 'caller is not a team member');
      return succeed('listTasks', [...tasks.values()].map((task) => ({ ...task })));
    },

    getTask(agent, id) {
      counters.getTask += 1;
      if (!adapter.membership(agent)) return fail('getTask', 'TEAM_NOT_MEMBER', 'caller is not a team member');
      const task = tasks.get(String(id));
      if (!task) return fail('getTask', 'TEAM_TASK_NOT_FOUND', `unknown task ${id}`);
      return succeed('getTask', { ...task });
    },

    createTask(agent, request) {
      counters.createTask += 1;
      if (!adapter.membership(agent)) return fail('createTask', 'TEAM_NOT_MEMBER', 'caller is not a team member');
      const blockedBy = Array.isArray(request?.blockedBy) ? request.blockedBy.map(String) : [];
      // native readiness: every blocker must be a completed sibling
      const ready = blockedBy.every((id) => tasks.get(id)?.status === 'completed');
      const view = {
        id: String(request?.id ?? `task-${++taskSeq}`),
        revision: 1,
        subject: String(request?.subject ?? ''),
        description: String(request?.description ?? ''),
        status: 'pending',
        blockedBy,
        writeScopes: Array.isArray(request?.writeScopes) ? request.writeScopes.map(String) : [],
        ownerName: request?.ownerName ? String(request.ownerName) : undefined,
        ready,
        writeScopeWarnings: [],
      };
      tasks.set(view.id, view);
      return succeed('createTask', { ...view });
    },

    updateTask(agent, request) {
      counters.updateTask += 1;
      if (!adapter.membership(agent)) return fail('updateTask', 'TEAM_NOT_MEMBER', 'caller is not a team member');
      const task = tasks.get(String(request?.taskId));
      if (!task) return fail('updateTask', 'TEAM_TASK_NOT_FOUND', `unknown task ${request?.taskId}`);
      if (!Number.isFinite(request?.expectedRevision) || request.expectedRevision !== task.revision) {
        return fail('updateTask', 'TEAM_TASK_STALE_REVISION', `expected revision ${request?.expectedRevision} but task is at ${task.revision}`, {
          current: { ...task },
        });
      }
      const next = { ...task, revision: task.revision + 1 };
      switch (request.action) {
        case 'claim':
          next.status = 'in_progress';
          next.ownerName = request.owner ?? next.ownerName;
          break;
        case 'release':
        case 'reopen':
          next.status = 'pending';
          next.ownerName = undefined;
          break;
        case 'complete':
          next.status = 'completed';
          break;
        case 'edit':
          if (request.subject !== undefined) next.subject = String(request.subject);
          if (request.description !== undefined) next.description = String(request.description);
          break;
        case 'set_dependencies':
          next.blockedBy = Array.isArray(request.blockedBy) ? request.blockedBy.map(String) : [];
          break;
        case 'reassign':
          next.ownerName = request.owner === undefined ? undefined : String(request.owner);
          break;
        case 'delete':
          next.status = 'deleted';
          break;
        default:
          return fail('updateTask', 'TEAM_TASK_INVALID_ACTION', `unknown action ${request.action}`);
      }
      next.ready = next.status === 'pending' && next.blockedBy.every((id) => tasks.get(id)?.status === 'completed');
      tasks.set(next.id, next);
      return succeed('updateTask', { ...next });
    },

    sendTeamMessage(agent, request) {
      counters.sendTeamMessage += 1;
      if (!adapter.membership(agent)) return fail('sendTeamMessage', 'TEAM_NOT_MEMBER', 'caller is not a team member');
      const messageId = `team-message-${messageLog.length + 1}`;
      messageLog.push({ messageId, target: String(request?.target ?? ''), at: clock.now() });
      return succeed('sendTeamMessage', { messageId, status: 'accepted' });
    },

    async waitForChange() {
      counters.waitForChange += 1;
      // Deterministic: never blocks. A real implementation waits on the journal.
      return succeed('waitForChange', { timedOut: false });
    },

    spawnTeammate(agent, request) {
      counters.spawnTeammate += 1;
      const membership = adapter.membership(agent);
      if (!membership) return fail('spawnTeammate', 'TEAM_NOT_MEMBER', 'caller is not a team member');
      if (membership.role !== 'lead') return fail('spawnTeammate', 'TEAM_LEAD_REQUIRED', 'only the lead may create members');
      const sessionId = `session-member-${request?.name}`;
      registerAgent(sessionId, { name: request?.name });
      registerMembership(sessionId, { root: agent, id: membership.id, role: 'teammate', name: String(request?.name) });
      // A member is a durable teammate Session: it occupies one native
      // Activation for as long as the team lives (plan §7: 5 members + 30 leaves = 35).
      memberActivations.add(sessionId);
      record('spawnTeammate', true);
      return { ok: true, value: { member: { id: sessionId, name: String(request?.name), role: 'teammate', status: 'running', diagnostics: [] } } };
    },

    interrupt(caller, name) {
      counters.interrupt += 1;
      if (!adapter.membership(caller)) return fail('interrupt', 'TEAM_NOT_MEMBER', 'caller is not a team member');
      return succeed('interrupt', { previousStatus: 'running', target: String(name) });
    },

    // ---- continuable children ----------------------------------------------
    /**
     * @param {{ provider:string, label:string, childId?:string, request:object, signal?:AbortSignal }} spec
     */
    startContinuable(spec) {
      counters.startContinuable += 1;
      const resident = activeActivations.size + memberActivations.size;
      if (resident >= activationLimit) {
        fullRejections.push({ at: clock.now(), label: spec?.label, active: resident, limit: activationLimit });
        return fail('startContinuable', ACTIVATION_LIMIT_REACHED, `subagent limit reached (active child limit: ${activationLimit})`);
      }
      const plan = receiptPlan.length > 0 ? receiptPlan.shift() : 'ok';
      if (plan === 'fail-before-create') {
        return fail('startContinuable', 'START_FAILED', 'simulated provider start failure');
      }
      const childId = String(spec?.childId ?? `child-${++childSeq}`);
      if (children.has(childId)) {
        // A pre-allocated childId must never be created twice.
        return fail('startContinuable', 'CHILD_ID_REUSED', `child ${childId} already exists`);
      }
      const parentSessionId = String(spec?.request?.parent?.id ?? spec?.parentSessionId ?? '');
      const entry = {
        id: childId,
        parentSessionId,
        label: String(spec?.label ?? ''),
        mode: 'continuable',
        createdAt: clock.now(),
        status: 'running',
        stopReason: null,
      };
      children.set(childId, entry);
      activeActivations.add(childId);
      startLog.push({ childId, parentSessionId, label: entry.label, startedAt: clock.now() });
      if (plan === 'lost-after-create') {
        // The child exists natively; only the receipt was lost. Reconciliation
        // must find it through listChildren instead of starting it again.
        return fail('startContinuable', 'START_RECEIPT_LOST', 'simulated lost start receipt', { childId });
      }
      if (plan === 'lost-after-create-uncertain') {
        // Same situation, but surfaced with a code the Host classifies as
        // "uncertain" (start may or may not have happened) — the only case
        // where the persisted intent must be reconciled against the catalog.
        return fail('startContinuable', 'SUBAGENT_START_FAILED', 'simulated lost start receipt (uncertain)', { childId });
      }
      return succeed('startContinuable', { childId, messageId: `msg-${childId}` });
    },

    listChildren(parentSessionId) {
      counters.listChildren += 1;
      const parent = String(parentSessionId ?? '');
      const entries = [...children.values()]
        .filter((child) => child.parentSessionId === parent)
        .map((child) => ({ id: child.id, createdAt: child.createdAt, mode: child.mode, label: child.label }));
      return { ok: true, value: entries, entries };
    },

    listDescendants(rootSessionId) {
      counters.listDescendants += 1;
      const root = String(rootSessionId ?? '');
      const out = [];
      for (const child of children.values()) {
        if (child.parentSessionId === root || child.parentSessionId.startsWith(`${root}/`)) {
          out.push({ ...child, parentId: child.parentSessionId, depth: 1 });
        }
      }
      return { ok: true, value: out, entries: out };
    },

    interruptChild(childSessionId, parentSessionId, mode = 'continuable') {
      counters.interruptChild += 1;
      const child = children.get(String(childSessionId));
      if (!child) return fail('interruptChild', 'SUBAGENT_NOT_FOUND', `unknown child ${childSessionId}`);
      child.status = 'settled';
      child.stopReason = 'aborted';
      activeActivations.delete(child.id);
      return succeed('interruptChild', { accepted: true, mode });
    },

    // ---- storage / projections ---------------------------------------------
    async openDomain(spec) {
      counters.openDomain += 1;
      try {
        const domain = await domainFacility.open(spec);
        return succeed('openDomain', domain);
      } catch (error) {
        return fail('openDomain', error?.code ?? 'DOMAIN_OPEN_FAILED', error?.message ?? String(error));
      }
    },

    registerProjection(definition) {
      counters.registerProjection += 1;
      const dispose = () => {
        adapter.projections.delete(definition?.key);
      };
      adapter.projections.set(String(definition?.key), definition);
      dispose.ok = true;
      dispose.value = dispose;
      return dispose;
    },

    now() {
      counters.now += 1;
      return clock.now();
    },

    diagnostics() {
      return diagnostics.slice();
    },

    // ---- test control surface (NOT part of the adapter contract) -----------
    projections: new Map(),
    counters,
    startLog,
    fullRejections,
    messageLog,
    domainFacility,

    registerAgent,
    registerMembership,

    get activations() {
      return activeActivations.size + memberActivations.size;
    },
    get leafActivations() {
      return activeActivations.size;
    },
    /** Live agents, for a native-shaped `ctx.agents.list()`. */
    get roster() {
      return [...agents.values()];
    },
    get memberships() {
      return [...memberships.values()];
    },
    /** 让一个 Agent 从原生注册表里消失（模拟 member 在两次回合之间被回收）。 */
    unregisterAgent(id) {
      const key = String(id);
      const existed = agents.delete(key);
      memberships.delete(key);
      return existed;
    },
    get activationLimit() {
      return activationLimit;
    },
    childrenSnapshot() {
      return [...children.values()].map((child) => ({ ...child }));
    },
    /** Simulate a child settling; the scheduler learns through notify(). */
    settleChild(childId, stopReason = 'completed') {
      const child = children.get(String(childId));
      if (!child) return false;
      child.status = 'settled';
      child.stopReason = stopReason;
      activeActivations.delete(child.id);
      return true;
    },
    /** Simulate a lease that expired while the old writer kept working. */
    reviveChild(childId) {
      const child = children.get(String(childId));
      if (!child) return false;
      child.status = 'running';
      activeActivations.add(child.id);
      return true;
    },
    /** Queue scripted receipt behaviour for the next startContinuable calls. */
    planReceipts(plan) {
      receiptPlan = Array.isArray(plan) ? plan.slice() : [];
    },
    pendingReceiptPlans() {
      return receiptPlan.length;
    },
    settleAll() {
      for (const id of [...activeActivations]) adapter.settleChild(id);
    },
  };

  // The lead session is always a live member so `createMember` can be driven.
  // `id` mirrors the native TeamId: the smoke harness and the real service both
  // use the membership `id` as `actor.teamKey` / `rootId`, so a lead-scoped
  // parent session must resolve back to the live lead Agent.
  const leadSession = options.leadSessionId ?? 'session-lead';
  const leadAgent = registerAgent(leadSession);
  registerMembership(leadSession, { root: leadAgent, id: leadSession, role: 'lead', name: 'lead' });

  return adapter;
}

export default createFakeAdapter;
