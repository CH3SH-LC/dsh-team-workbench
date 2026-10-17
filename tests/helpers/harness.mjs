/**
 * Assemble a complete workbench runtime for a suite.
 *
 * `mode: 'real'` (the default) wires the shipped Host modules exactly the way
 * `src/host/index.js` does:
 *
 *   native fake ctx → createAdapter(ctx) → createStorage(ctx, adapter, {clock})
 *   → new TeamWorkbenchService(ctx, adapter, storage, config, {clock})
 *   → createScheduler({service, adapter, storage, config, clock})
 *
 * Only the *native seam* is faked: `tests/helpers/fake-ctx.mjs` +
 * `fake-adapter.mjs` stand in for the live DSH runtime. Every Host module under
 * test is the real file from `src/host/`.
 *
 * `mode: 'reference'` uses the local stub instead and is always reported as
 * `simulated`.
 */
import { createFakeClock } from './fake-clock.mjs';
import { createFakeAdapter } from './fake-adapter.mjs';
import { createFakeContext } from './fake-ctx.mjs';
import { createFakeStorageDomain, createDomainBackend } from './fake-domain.mjs';
import { defaultReferenceConfig } from './reference/reference-scheduler.mjs';
import { createReferenceStorage } from './reference/reference-storage.mjs';
import { createReferenceService } from './reference/reference-service.mjs';
import { createReferenceScheduler } from './reference/reference-scheduler.mjs';
import { createReferencePolicy } from './reference/reference-policy.mjs';
import { loadHostModule, loadHostModules } from './host-loader.mjs';

export const REQUIRED_HOST_MODULES = ['config', 'adapter', 'storage', 'service', 'scheduler', 'policy'];

/** Merge the suite's overrides onto the plugin's default config shape. */
function rawConfig(overrides = {}) {
  return {
    ...overrides,
    singleWriter: overrides.singleWriter ?? true,
    capacity: { ...(overrides.capacity ?? {}) },
    scheduler: { ...(overrides.scheduler ?? {}) },
    policy: { ...(overrides.policy ?? {}) },
  };
}

/**
 * @param {{
 *   mode?: 'real'|'reference',
 *   clock?: object,
 *   native?: object,
 *   domainFacility?: object,
 *   storageBackend?: object,
 *   config?: object,
 *   activationLimit?: number,
 *   leadSessionId?: string,
 *   receiptPlan?: string[],
 * }} [options]
 */
export async function createWorkbench(options = {}) {
  const mode = options.mode ?? 'real';
  const clock = options.clock ?? createFakeClock();
  const loaded = await loadHostModules(REQUIRED_HOST_MODULES);
  const missing = Object.entries(loaded)
    .filter(([, entry]) => !entry.real)
    .map(([name, entry]) => ({ name, file: entry.file, reason: entry.error ? `import failed: ${entry.error.message}` : 'not written yet' }));

  const referenceConfig = defaultReferenceConfig(options.config ?? {});
  const configModule = loaded.config.real ? loaded.config.mod : null;
  const config = configModule ? configModule.normalizeConfig(rawConfig(options.config)) : referenceConfig;

  const domainFacility = options.domainFacility ?? createFakeStorageDomain({
    backend: options.storageBackend ?? createDomainBackend(),
  });
  const native = options.native ?? createFakeAdapter({
    clock,
    storageDomain: domainFacility,
    activationLimit: options.activationLimit ?? config.capacity.hostActivationLimit,
    leadSessionId: options.leadSessionId,
    receiptPlan: options.receiptPlan,
  });

  const base = {
    clock,
    config,
    native,
    domainFacility,
    configModule,
    missingHostModules: missing,
  };

  if (mode === 'reference') {
    return { ...base, ...(await buildReferenceStack({ clock, native, config })), mode: 'reference', simulated: true };
  }

  if (missing.length > 0) {
    return {
      ...base,
      mode: 'pending',
      simulated: false,
      pendingReason: missing.map((entry) => `${entry.name} (${entry.file}): ${entry.reason}`).join('; '),
      storage: null,
      service: null,
      scheduler: null,
      adapter: null,
      ctx: null,
      policy: loaded.policy.real ? loaded.policy.mod : null,
      async dispose() {},
    };
  }

  const ctx = createFakeContext({ adapter: native, clock });
  const adapter = loaded.adapter.mod.createAdapter(ctx, {});
  const storage = loaded.storage.mod.createStorage(ctx, adapter, { clock });
  const ready = await storage.ready();
  const service = new loaded.service.mod.TeamWorkbenchService(ctx, adapter, storage, config, { clock });
  const initReport = await service.init();
  const scheduler = loaded.scheduler.mod.createScheduler({ service, adapter, storage, config, clock });

  return {
    ...base,
    mode: 'real',
    simulated: false,
    ctx,
    adapter,
    storage,
    service,
    scheduler,
    policy: loaded.policy.mod,
    ready,
    initReport,
    exports: {
      normalizeConfig: 'normalizeConfig',
      createAdapter: 'createAdapter',
      createStorage: 'createStorage',
      TeamWorkbenchService: 'TeamWorkbenchService',
      createScheduler: 'createScheduler',
    },
    async dispose() {
      try {
        scheduler.dispose?.();
      } catch {
        /* teardown must not throw */
      }
      try {
        await service.dispose?.();
      } catch {
        /* teardown must not throw */
      }
    },
  };
}

async function buildReferenceStack({ clock, native, config }) {
  const storage = await createReferenceStorage({ adapter: native, clock });
  const policy = createReferencePolicy(config.policy);
  const service = createReferenceService({ adapter: native, storage, clock, config, policy });
  const scheduler = createReferenceScheduler({ service, adapter: native, storage, config, clock });
  return {
    storage,
    service,
    scheduler,
    policy,
    adapter: native,
    async dispose() {
      scheduler.stop();
      await storage.close();
    },
  };
}

/** The lead identity used by every suite. */
export function leadAgent(workbench, id = 'session-lead') {
  const agent = workbench.native.agentFor(id);
  if (!agent) throw new Error(`no fake agent registered for ${id}`);
  return agent;
}

/** Register a native agent + membership for a member created outside createMember. */
export function registerMember(workbench, name, teamKey = 'team-a') {
  const sessionId = `session-member-${name}`;
  const lead = leadAgent(workbench);
  workbench.native.registerAgent(sessionId, { name });
  workbench.native.registerMembership(sessionId, { root: lead, id: teamKey, role: 'teammate', name });
  return sessionId;
}

/**
 * Settle children and let the scheduler refill, recording the capacity view
 * after every single settlement so an invariant like
 * "activeLeaves <= workerCapacity" is checked at every observable instant.
 */
export async function settleAndRefill(workbench, childIds) {
  const observations = [];
  for (const childId of childIds) {
    workbench.native.settleChild(childId);
    workbench.scheduler.notify('subagent/end', { childId, stopReason: 'completed' });
    await workbench.clock.flush();
    const report = await workbench.scheduler.tick();
    observations.push({ childId, report, capacity: workbench.scheduler.capacity() });
  }
  return observations;
}

/** Submit a horizontal, policy-legal work item. */
export function workSpec(overrides = {}) {
  const index = overrides.index ?? 1;
  return {
    teamKey: 'team-a',
    title: `独立交付 ${index}`,
    deliverable: `模块 ${index} 的完整实现`,
    ownerMemberId: 'lead',
    outputs: [`src/mod${index}/index.ts`],
    acceptance: [`模块 ${index} 可用于真实集成`],
    ...overrides,
  };
}

export default createWorkbench;
export { loadHostModule, loadHostModules };
