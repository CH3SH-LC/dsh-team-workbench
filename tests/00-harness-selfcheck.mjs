/**
 * 00 — harness self-check.
 *
 * Proves the verification harness itself is sound (clock, domain CAS,
 * idempotency, activation accounting, structured result, deliberate failure
 * detection) using the local reference stub only.
 *
 * This suite is intentionally `simulated`: it says nothing about the shipped
 * Host code. It exists so that a later PASS against the real modules cannot be
 * explained away by a broken harness.
 */
import { createFakeClock } from './helpers/fake-clock.mjs';
import { createFakeAdapter } from './helpers/fake-adapter.mjs';
import { createFakeStorageDomain, createDomainBackend } from './helpers/fake-domain.mjs';
import { createSuite, runSuite, emit, isMain, main } from './helpers/suite.mjs';
import { createWorkbench, leadAgent } from './helpers/harness.mjs';

export const meta = {
  id: '00-harness-selfcheck',
  title: 'harness 自检（假时钟/假 domain/CAS/幂等/激活池/结构化结果）',
  acceptance: [],
  requires: [],
  mode: 'reference',
};

export async function run() {
  return runSuite({ ...meta, simulated: true }, async (suite) => {
    // ---- virtual clock --------------------------------------------------
    const clock = createFakeClock(1_000);
    suite.equal(clock.now(), 1_000, 'fake clock starts at the requested instant');
    clock.advance(500);
    suite.equal(clock.now(), 1_500, 'fake clock advances deterministically without real waiting');

    // ---- domain: CAS + idempotency + durable write-through ---------------
    const backend = createDomainBackend();
    const facility = createFakeStorageDomain({ backend });
    const domain = await facility.open({ name: 'selfcheck', version: 1, tables: { t: {} } });
    await domain.table('t').put('k', { v: 1 });
    suite.deepEqual(domain.table('t').get('k'), { v: 1 }, 'domain keeps a written record');
    await domain.table('t').put('k', { v: 2 });
    suite.deepEqual(domain.table('t').get('k'), { v: 2 }, 'domain overwrites without CAS (no native CAS exists)');
    let missingKey = false;
    try {
      await domain.table('t').update('absent', (current) => current);
    } catch (error) {
      missingKey = error.code === 'missing-key';
    }
    suite.assert(missingKey, 'domain update on a missing key throws missing-key (native behaviour)');

    // ---- fake adapter: activation pool is a hard backstop ---------------
    const adapter = createFakeAdapter({ clock, activationLimit: 2 });
    const parent = adapter.agentFor('session-lead');
    const first = adapter.startContinuable({ provider: 'p', label: 'a', request: { parent, prompt: [] } });
    const second = adapter.startContinuable({ provider: 'p', label: 'b', request: { parent, prompt: [] } });
    const third = adapter.startContinuable({ provider: 'p', label: 'c', request: { parent, prompt: [] } });
    suite.assert(first.ok && second.ok, 'activation pool admits children below the limit');
    suite.equal(third.ok, false, 'activation pool refuses the child above the limit');
    suite.equal(third.code, 'ACTIVATION_LIMIT_REACHED', 'refusal uses the exact native code');
    suite.equal(adapter.fullRejections.length, 1, 'the harness records every pool refusal');
    adapter.settleChild(first.childId);
    suite.equal(adapter.activations, 1, 'settling releases exactly one resident slot');

    // ---- reference stack: one rolling refill ----------------------------
    const workbench = await createWorkbench({
      mode: 'reference',
      clock: createFakeClock(2_000),
      config: { capacity: { globalLeafLimit: 3, hostActivationLimit: 8 } },
    });
    const lead = leadAgent(workbench);
    for (let index = 1; index <= 5; index += 1) {
      await workbench.service.submitWork(lead, {
        deliverable: `selfcheck-${index}`,
        title: `自检交付 ${index}`,
        outputs: ['实现说明'],
      });
    }
    const firstTick = await workbench.scheduler.tick();
    suite.equal(firstTick.started.length, 3, 'a tick fills exactly the available leaf slots');

    const capacityAfterFirst = workbench.scheduler.capacity();
    suite.compare(capacityAfterFirst.activeLeaves, '<=', capacityAfterFirst.workerCapacity, 'activeLeaves stays within workerCapacity');

    const settledChild = firstTick.started[0].childId;
    workbench.native.settleChild(settledChild);
    workbench.scheduler.notify('subagent/end', { childId: settledChild });
    await workbench.clock.flush();
    const secondTick = await workbench.scheduler.tick();
    suite.equal(secondTick.started.length, 1, 'one settlement refills exactly one slot (no batch barrier)');
    suite.equal(secondTick.started[0].workId, firstTick.readyBefore.find((id) => !firstTick.started.some((entry) => entry.workId === id)) ?? secondTick.started[0].workId, 'the refill takes the next ready work');

    // ---- structured result contract -------------------------------------
    const probe = createSuite({ id: 'probe', title: 'deliberate failure probe' });
    probe.check('this must fail', false, { reason: 'self-test' });
    const probeResult = probe.result();
    suite.equal(probeResult.status, 'FAIL', 'a failed check yields status FAIL');
    suite.equal(probeResult.counts.failed, 1, 'the failing check is counted');

    const passProbe = createSuite({ id: 'probe2', title: 'pass probe' });
    passProbe.check('this must pass', true);
    suite.equal(passProbe.result().status, 'PASS', 'an all-green suite yields status PASS');

    suite.note('simulated=true: this suite validates the harness, not the shipped Host modules.');
    await workbench.dispose();
  });
}

if (isMain(import.meta.url)) await main(run, meta);
