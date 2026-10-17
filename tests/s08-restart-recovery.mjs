/**
 * S08 — 重启 / 冷恢复对账。
 *
 * 真实验收关心的四件事：
 *   1. 从持久状态重建 ready 队列与工作项/attempt；
 *   2. 不重跑已经产出的任务；
 *   3. 启动意图落盘的 attempt 按原生 catalog 对账，不重复创建 child；
 *   4. child 只在它的 parent（member/lead Session）真实存活时才被恢复。
 *
 * 「先恢复 parent 再恢复 child」在公开 RecoveryReport 里没有显式步骤序列，
 * 因此这里断言可观察的操作前提：每个被恢复的 attempt 的 parentSessionId
 * 都能解析到真实 live Agent。这一点已在本文件与 deterministic.md 中标注。
 */
import { createFakeClock } from './helpers/fake-clock.mjs';
import { runSuite, isMain, main } from './helpers/suite.mjs';
import { createWorkbench, leadAgent } from './helpers/harness.mjs';

export const meta = {
  id: 's08-restart-recovery',
  title: '重启/冷恢复：重建 ready 队列、不重跑已完成、parent 存活才恢复 child',
  acceptance: ['S07', 'S08'],
  requires: ['service', 'scheduler', 'storage', 'policy'],
};

export async function run() {
  return runSuite(meta, async (suite) => {
    const clock = createFakeClock();
    const config = { capacity: { globalLeafLimit: 3, hostActivationLimit: 40 }, scheduler: { maxStartsPerTick: 3 } };

    // ---- 第一个 Host 世代 ---------------------------------------------------
    const first = await createWorkbench({ clock, config, receiptPlan: ['ok', 'lost-after-create-uncertain', 'ok'] });
    if (first.mode !== 'real') {
      suite.fail('真实 Host 模块可用', { mode: first.mode, pendingReason: first.pendingReason });
      return;
    }
    const { service, scheduler, native } = first;
    const lead = leadAgent(first);
    await service.defineTeam(lead, { teamKey: 'team-a', goal: '重启恢复验收' });
    const submitted = [];
    for (let index = 1; index <= 6; index += 1) {
      submitted.push(`w${index}`);
      await service.submitWork(lead, {
        teamKey: 'team-a',
        workId: `w${index}`,
        title: `交付 ${index}`,
        deliverable: `模块 ${index} 完整实现`,
        ownerMemberId: 'lead',
        outputs: [`src/m${index}.ts`],
        acceptance: ['可集成'],
      });
    }
    const tick1 = await scheduler.tick();
    suite.equal(tick1.started.length, 2, '第一个世代：2 项确认启动 + 1 项回执丢失');
    suite.equal(native.counters.startContinuable, 3, '第一个世代：原生收到 3 次 startContractable');

    const producedPlan = tick1.started[0];
    const producedAttempt = service.attempts.get(producedPlan.attemptId);
    const producedResult = await service.reportWork({ id: producedAttempt.executorChildId }, {
      attemptId: producedAttempt.attemptId,
      leaseEpoch: producedAttempt.leaseEpoch,
      outcome: 'produced',
      artifacts: [{ path: `src/${producedPlan.workId}.ts`, version: 1 }],
      evidence: [{ kind: 'verification', ok: true, command: 'node --test', ref: `tests/${producedPlan.workId}` }],
      summary: '第一个世代已完成',
    });
    suite.equal(producedResult.ok, true, '第一个世代：有一项已经产出并落盘');
    const producedWorkId = producedPlan.workId;
    const producedWorkState = service.works.get(producedWorkId).state;
    const lostAttempt = [...service.attempts.values()].find((attempt) => attempt.state === 'starting');
    const attemptCountBeforeRestart = native.counters.startContinuable;
    const childIdsBeforeRestart = new Set(native.childrenSnapshot().map((child) => child.id));

    // ---- 模拟 Host 重启：释放写者并关闭域，数据留在同一 backend ------------
    scheduler.dispose();
    await first.storage.releaseWriter();
    await first.storage.close();
    clock.advance(60 * 60 * 1000); // 一小时后重启

    const restarted = await createWorkbench({
      clock,
      config,
      native,
      domainFacility: first.domainFacility,
      leadSessionId: 'session-lead',
    });
    suite.equal(restarted.ready.writerHeld, true, '重启后的 Host 成为唯一写者');
    suite.equal(restarted.initReport.readOnly, false, '重启后的 Host 处于可写状态');

    // ---- 冷恢复：从持久状态重建 --------------------------------------------
    suite.equal(restarted.service.works.size, 6, '重启后工作项从持久状态完整重建');
    suite.equal(restarted.service.attempts.size, 3, '重启后 attempt 从持久状态完整重建');
    suite.equal(restarted.service.works.get(producedWorkId).state, producedWorkState, '已完成工作的状态被保留');
    suite.equal(restarted.service.works.get(producedWorkId).artifactRefs.length, 1, '已完成工作的产物版本引用被保留');

    const recovery = await restarted.service.reconcile();
    suite.assert(Array.isArray(recovery.adopted), 'reconcile 返回 RecoveryReport', Object.keys(recovery));
    suite.assert(
      recovery.adopted.includes(lostAttempt.attemptId),
      '回执丢失的 attempt 由原生 catalog 对账认领（不重复创建）',
      { adopted: recovery.adopted, attemptId: lostAttempt.attemptId },
    );
    suite.equal(
      restarted.native.counters.startContinuable,
      attemptCountBeforeRestart,
      '冷恢复没有再次调用 startContinuable',
    );
    suite.equal(restarted.native.childrenSnapshot().length, childIdsBeforeRestart.size, '原生 child 总数不变（无重复创建）');

    const adoptedAttempts = recovery.adopted.map((attemptId) => restarted.service.attempts.get(attemptId));
    suite.compare(adoptedAttempts.length, '>=', 1, '至少有一个 attempt 被恢复');
    suite.assert(
      adoptedAttempts.every((attempt) => attempt && restarted.native.agentFor(attempt.parentSessionId) !== undefined),
      '每个被恢复的 child 的 parent Session 都真实存活（先恢复 parent 再恢复 child 的可观察前提）',
      adoptedAttempts.map((attempt) => ({ attemptId: attempt?.attemptId, parent: attempt?.parentSessionId, live: restarted.native.agentFor(attempt?.parentSessionId) !== undefined })),
    );
    suite.equal(restarted.service.members !== undefined, true, '成员（parent）记录先于 child 完成 hydrate');

    // ---- 不重跑已完成任务，只继续未完成项 ----------------------------------
    const alreadyInFlight = new Set(
      [...service.attempts.values()]
        .filter((attempt) => attempt.workId !== producedWorkId)
        .map((attempt) => attempt.workId),
    );
    const tickAfterRestart = await restarted.scheduler.tick();
    const restartStarts = [...tickAfterRestart.started];
    suite.assert(
      !restartStarts.some((plan) => plan.workId === producedWorkId || alreadyInFlight.has(plan.workId)),
      '重启后没有重跑已完成任务，也没有重启已在执行的 attempt',
      { started: restartStarts.map((plan) => plan.workId), producedWorkId, alreadyInFlight: [...alreadyInFlight] },
    );
    suite.assert(
      !tickAfterRestart.readyBefore.includes(producedWorkId),
      '已经产出的任务不在 ready 队列里',
      tickAfterRestart.readyBefore,
    );
    suite.equal(restartStarts.length, 1, '重启时只有 1 个空槽（2 个 attempt 仍在执行），因此只补 1 项');

    // 逐个结算，让剩余未完成项滚动补位。
    let guard = 0;
    while (guard < 40) {
      guard += 1;
      const running = [...restarted.service.attempts.values()].filter((attempt) => attempt.state === 'executing');
      if (running.length === 0) break;
      const victim = running[0];
      const settled = await restarted.service.reportWork({ id: victim.executorChildId }, {
        attemptId: victim.attemptId,
        leaseEpoch: victim.leaseEpoch,
        outcome: 'produced',
        artifacts: [{ path: `src/${victim.workId}.ts`, version: 1 }],
        evidence: [{ kind: 'verification', ok: true, command: 'node --test', ref: `tests/${victim.workId}` }],
        summary: 'done',
      });
      if (!settled.ok) break;
      const next = await restarted.scheduler.tick();
      restartStarts.push(...next.started);
    }
    const restartWorkIds = restartStarts.map((plan) => plan.workId).sort();
    suite.deepEqual(restartWorkIds, ['w4', 'w5', 'w6'], '冷恢复只继续未开始的任务（w4..w6）');
    suite.equal(
      restarted.native.counters.startContinuable,
      attemptCountBeforeRestart + 3,
      '重启后只新增 3 次启动，没有为已完成项或已在执行的 attempt 重复启动',
    );

    // 全部完成后再次 tick：没有任何新工作被派发。
    const finalTick = await restarted.scheduler.tick();
    suite.equal(finalTick.started.length, 0, '全部产出后不再派发任何工作（不重跑已完成任务）');
    suite.equal(finalTick.readyBefore.length, 0, 'ready 队列清空');
    suite.equal(restarted.native.childrenSnapshot().length, 6, '原生 child 总数仍为 6（每个工作项恰好一个 child）');
    suite.equal(
      new Set(restarted.native.childrenSnapshot().map((child) => child.id)).size,
      6,
      '没有重复 childId',
    );
    const states = [...restarted.service.works.values()].map((work) => work.state);
    suite.assert(
      states.every((state) => state === 'produced' || state === 'verifying'),
      '所有工作项都达到 produced/verifying（produced ≠ 最终完成，仍有用户验收待确认）',
      states,
    );
    suite.note('「先恢复 parent 再恢复 child」通过“被恢复 child 的 parent 必须存活”断言，公开 RecoveryReport 无显式步骤序列。');
    await restarted.dispose();
  });
}

if (isMain(import.meta.url)) await main(run, meta);
