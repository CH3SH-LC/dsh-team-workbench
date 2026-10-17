/**
 * S07 — 幂等与迟到结果：启动回执丢失后对账不重复创建；过期 lease 的迟到结果
 *       只归档（lateResults），绝不覆盖新版本。
 */
import { createFakeClock } from './helpers/fake-clock.mjs';
import { runSuite, isMain, main } from './helpers/suite.mjs';
import { createWorkbench, leadAgent } from './helpers/harness.mjs';

export const meta = {
  id: 's07-receipt-and-lease',
  title: '启动回执丢失对账 + 过期 lease 迟到结果只归档',
  acceptance: ['S06', 'S07', 'S08'],
  requires: ['service', 'scheduler', 'storage', 'policy'],
};

export async function run() {
  return runSuite(meta, async (suite) => {
    // ------------------------------------------------- 启动回执丢失 → 对账
    {
      const workbench = await createWorkbench({
        clock: createFakeClock(),
        config: { capacity: { globalLeafLimit: 4 }, scheduler: { maxStartsPerTick: 4 } },
        receiptPlan: ['ok', 'lost-after-create-uncertain', 'ok'],
      });
      if (workbench.mode !== 'real') {
        suite.fail('真实 Host 模块可用', { mode: workbench.mode, pendingReason: workbench.pendingReason });
        return;
      }
      const { service, scheduler, native, storage } = workbench;
      const lead = leadAgent(workbench);
      await service.defineTeam(lead, { teamKey: 'team-a' });
      for (const index of [1, 2, 3]) {
        await service.submitWork(lead, {
          teamKey: 'team-a', workId: `w${index}`, title: `交付 ${index}`,
          deliverable: `模块 ${index} 完整实现`, ownerMemberId: 'lead',
          outputs: [`src/m${index}.ts`], acceptance: ['ok'],
        });
      }

      const tick = await scheduler.tick();
      suite.equal(tick.started.length, 2, '回执丢失的那一项不算"已启动"（只有 2 项确认启动）');
      suite.equal(native.counters.startContinuable, 3, '原生确实收到了 3 次 startContinuable 调用');
      suite.equal(native.childrenSnapshot().length, 3, '原生侧确实创建了 3 个 child（其中 1 个回执丢失）');

      const lost = [...service.attempts.values()].find((attempt) => attempt.state === 'starting');
      suite.assert(lost !== undefined, '存在一个 intent=start-in-flight/receipt-lost 的 attempt', [...service.attempts.values()].map((a) => a.state));
      suite.equal(lost.intent !== 'started', true, '该 attempt 的 intent 不是 started（没有谎称已启动）');
      const persisted = storage.get('attempts', lost.attemptId);
      suite.equal(persisted.executorChildId, lost.executorChildId, '预分配 childId 已经落盘（重启也能对账）');
      suite.equal(
        native.childrenSnapshot().some((child) => child.id === lost.executorChildId),
        true,
        '丢失的 childId 在原生 catalog 里真实存在',
      );

      // 对账：按原生 catalog 认领，不重复创建。
      const before = native.counters.startContinuable;
      const report = await service.reconcile();
      suite.assert(report.adopted.includes(lost.attemptId), '对账把回执丢失的 attempt 认领为已启动', report);
      suite.equal(service.attempts.get(lost.attemptId).state, 'executing', '对账后 attempt 进入 executing');
      suite.equal(native.counters.startContinuable, before, '对账没有再次调用 startContinuable（不重复创建）');
      suite.equal(native.childrenSnapshot().length, 3, '原生 child 数量不变（没有第二个同名 child）');
      suite.equal(new Set(native.childrenSnapshot().map((child) => child.id)).size, 3, '不存在重复 childId');
      await workbench.dispose();
    }

    // ------------------------------------------------- 过期 lease → 迟到归档
    {
      const workbench = await createWorkbench({
        clock: createFakeClock(),
        config: { capacity: { globalLeafLimit: 2 }, scheduler: { maxStartsPerTick: 2 } },
      });
      const { service, scheduler, native } = workbench;
      const lead = leadAgent(workbench);
      await service.defineTeam(lead, { teamKey: 'team-a' });
      await service.submitWork(lead, {
        teamKey: 'team-a', workId: 'w1', title: '交付 1', deliverable: '模块 1 完整实现',
        ownerMemberId: 'lead', outputs: ['src/m1.ts'], acceptance: ['ok'],
      });
      const tick = await scheduler.tick();
      const plan = tick.started[0];
      const attempt = service.attempts.get(plan.attemptId);
      suite.equal(attempt.leaseEpoch, 1, '首次 attempt 的 leaseEpoch = 1');

      const stale = await service.reportWork({ id: attempt.executorChildId }, {
        attemptId: attempt.attemptId,
        leaseEpoch: attempt.leaseEpoch + 1,
        outcome: 'produced',
        artifacts: [{ path: 'src/m1.ts', version: 99 }],
        evidence: [{ kind: 'verification', ok: true, command: 'stale', ref: 'stale' }],
        summary: '来自过期 lease 的迟到结果',
      });
      suite.equal(stale.ok, true, '迟到结果不报错（被安全归档）');
      suite.equal(stale.quarantined, true, '迟到结果被标记 quarantined');
      suite.matches(stale.code, /LEASE/, '归档原因包含 LEASE（leaseEpoch 过期）');
      suite.equal(service.lateResults.length, 1, 'lateResults 里恰好一条归档记录');
      suite.equal(service.works.get('w1').artifactRefs.length, 0, '迟到结果没有写入 workspace 的 artifactRefs');
      suite.equal(service.works.get('w1').state, 'executing', '工作项状态没有被迟到结果推进');
      suite.equal(service.attempts.get(attempt.attemptId).state, 'executing', 'attempt 状态没有被迟到结果覆盖');

      const tickLate = await scheduler.tick();
      suite.equal(tickLate.lateResults.length, 1, 'tick 报告里能看到迟到结果（workId/attemptId/leaseEpoch/reason）');
      suite.equal(tickLate.lateResults[0].workId, 'w1', '迟到结果带有 workId');
      suite.equal(tickLate.lateResults[0].attemptId, attempt.attemptId, '迟到结果带有 attemptId');

      // 正确的 lease 回执生效，并成为"新版本"。
      const good = await service.reportWork({ id: attempt.executorChildId }, {
        attemptId: attempt.attemptId,
        leaseEpoch: attempt.leaseEpoch,
        outcome: 'produced',
        artifacts: [{ path: 'src/m1.ts', version: 1 }],
        evidence: [{ kind: 'verification', ok: true, command: 'node --test', ref: 'tests/m1' }],
        summary: '正确 lease 的结果',
      });
      suite.equal(good.ok, true, '正确 leaseEpoch 的回执被接受');
      suite.equal(service.works.get('w1').artifactRefs[0].version, 1, '产物版本为新版本 v1');
      suite.assert(['produced', 'verifying'].includes(service.works.get('w1').state), '工作项推进到 produced/verifying', service.works.get('w1').state);

      // 第二个迟到回执试图用旧版本覆盖新结果 → 仍然只归档。
      const stale2 = await service.reportWork({ id: attempt.executorChildId }, {
        attemptId: attempt.attemptId,
        leaseEpoch: attempt.leaseEpoch + 7,
        outcome: 'produced',
        artifacts: [{ path: 'src/m1.ts', version: 42 }],
        summary: '第二次迟到结果',
      });
      suite.equal(stale2.quarantined, true, '第二个迟到结果同样只归档');
      suite.equal(service.lateResults.length, 2, 'lateResults 累积到 2 条');
      suite.equal(service.works.get('w1').artifactRefs[0].version, 1, '迟到结果没有把产物版本覆盖成 42');
      suite.equal(service.works.get('w1').state !== 'executing', true, '已完成的工作项没有被迟到结果拉回执行态');
      suite.equal(native.childrenSnapshot().filter((child) => child.status === 'running').length, 1, '迟到结果不影响原生 child 生命周期');
      await workbench.dispose();
    }
  });
}

if (isMain(import.meta.url)) await main(run, meta);
