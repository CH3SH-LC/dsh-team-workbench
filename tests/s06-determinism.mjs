/**
 * S06 — 确定性：单写者、CAS、幂等键、预分配 childId + 启动意图先落盘、
 *       重复事件 / 重复 domain/changed / 重复回执不产生重复工作。
 *
 * 全部用假时钟 + 内存 domain + fake native adapter 驱动真实 Host 模块。
 */
import { createFakeClock } from './helpers/fake-clock.mjs';
import { runSuite, isMain, main } from './helpers/suite.mjs';
import { createWorkbench, leadAgent } from './helpers/harness.mjs';
import { createFakeStorageDomain } from './helpers/fake-domain.mjs';
import { loadHostModule } from './helpers/host-loader.mjs';

export const meta = {
  id: 's06-determinism',
  title: '确定性：单写者 / CAS / 幂等键 / 预分配 childId / 重复事件不重复创建',
  acceptance: ['S06', 'S07'],
  requires: ['service', 'scheduler', 'storage', 'policy'],
};

export async function run() {
  return runSuite(meta, async (suite) => {
    // ---------------------------------------------------------------- 单写者
    {
      const first = await createWorkbench({ clock: createFakeClock(), config: { capacity: { globalLeafLimit: 4 } } });
      if (first.mode !== 'real') {
        suite.fail('真实 Host 模块可用', { mode: first.mode, pendingReason: first.pendingReason });
        return;
      }
      const lead = leadAgent(first);
      await first.service.defineTeam(lead, { teamKey: 'team-a' });
      await first.service.submitWork(lead, {
        teamKey: 'team-a', workId: 'w1', title: '交付 1', deliverable: '模块 1 完整实现',
        ownerMemberId: 'lead', outputs: ['src/m1.ts'], acceptance: ['ok'],
      });

      // 第二个 Host 进程：同一数据目录（同一个 backend），不同 facility。
      //
      // 关键：第一个 storage 的 writer 记录写的是**本进程 pid**；按 `claimWriter` 的规则
      // `pid === process.pid` 只可能是本进程的历史世代（热重载），会被直接接管。
      // 要模拟"另一个仍然存活的 Host"，必须把该记录改成一个**别的存活 pid**
      // （取不到别的活 pid 时退到 `pid: null` + 心跳新鲜，同样是冲突）。
      const storageModule = await loadHostModule('storage');
      const externalPid = storageModule.mod.processAlive(process.ppid) === true ? process.ppid : null;
      const heldDomain = first.domainFacility.get(storageModule.mod.DOMAIN_NAME);
      const heldWriters = heldDomain.table('writer');
      const ownRecord = heldWriters.get(first.storage.writerEpoch);
      suite.assert(ownRecord !== undefined, '第一写者已留下 writer 记录', first.storage.writerEpoch);
      await heldWriters.put(first.storage.writerEpoch, {
        ...ownRecord,
        pid: externalPid,
        heartbeatAt: first.clock.now(),
      });
      suite.equal(heldWriters.get(first.storage.writerEpoch).pid, externalPid, '把第一写者的记录伪装成外部存活进程');

      const secondFacility = createFakeStorageDomain({ backend: first.domainFacility.backend });
      const second = await createWorkbench({ clock: first.clock, domainFacility: secondFacility, config: { capacity: { globalLeafLimit: 4 } } });
      suite.equal(second.ready.writerHeld, false, '第二个 Host 写者没有拿到写权');
      suite.assert(
        Array.isArray(second.ready.secondWriter) && second.ready.secondWriter.length > 0,
        '第二个 Host 被识别为 SECOND_WRITER（记录冲突的 writer epoch）',
        second.ready.secondWriter,
      );
      suite.equal(second.initReport.readOnly, true, '第二个 Host 进入只读诊断态');
      suite.equal(second.initReport.readOnlyReason, 'SECOND_WRITER', '只读原因准确为 SECOND_WRITER');
      suite.equal(second.service.works.size, 1, '只读实例仍然加载了已有数据（不丢数据）');

      const denied = await second.service.submitWork(leadAgent(second), {
        teamKey: 'team-a', workId: 'w2', title: '交付 2', deliverable: '模块 2 完整实现',
        ownerMemberId: 'lead', outputs: ['src/m2.ts'], acceptance: ['ok'],
      });
      suite.equal(denied.ok, false, '只读实例拒绝写入');
      suite.equal(denied.code, 'SECOND_WRITER', '拒绝码为 SECOND_WRITER');
      suite.equal(first.storage.size('works'), 1, '第一写者的数据没有被第二个进程改动');

      const claim = await second.storage.claimWriter();
      suite.equal(claim.ok, false, 'storage.claimWriter() 对第二写者返回失败');
      suite.equal(claim.code, 'SECOND_WRITER', 'claimWriter 的失败码为 SECOND_WRITER');
      await first.dispose();
      await second.dispose();
    }

    // ------------------------------------------------------------ CAS / 幂等
    {
      const workbench = await createWorkbench({ clock: createFakeClock(), config: { capacity: { globalLeafLimit: 4 } } });
      const { storage } = workbench;
      const v1 = await storage.put('works', 'cas-key', { value: 1 });
      suite.equal(v1.ok, true, 'CAS：首次写入成功');
      const v2 = await storage.put('works', 'cas-key', { value: 2 }, { expectRev: v1.rev });
      suite.equal(v2.ok, true, 'CAS：携带正确 revision 的写入成功');
      const stale = await storage.put('works', 'cas-key', { value: 99 }, { expectRev: v1.rev });
      suite.equal(stale.ok, false, 'CAS：过期 revision 的写入被拒绝');
      suite.equal(stale.code, 'CAS_MISMATCH', 'CAS：拒绝码为 CAS_MISMATCH');
      suite.equal(storage.get('works', 'cas-key').value, 2, 'CAS：过期写入没有覆盖新结果');

      const before = storage.size('works');
      const i1 = await storage.put('works', 'idem-key', { value: 'first' }, { idempotencyKey: 'same-intent' });
      const i2 = await storage.put('works', 'idem-key', { value: 'first' }, { idempotencyKey: 'same-intent' });
      suite.equal(i1.ok, true, '幂等键：首次写入成功');
      suite.equal(i2.deduplicated, true, '幂等键：相同键 + 相同内容被去重');
      suite.equal(i2.record.rev, i1.record.rev, '幂等键：去重写入不产生新 revision');
      suite.equal(storage.size('works'), before + 1, '幂等键：只产生一条记录');
      const conflict = await storage.put('works', 'idem-key', { value: 'different' }, { idempotencyKey: 'same-intent' });
      suite.equal(conflict.ok, false, '幂等键：相同键 + 不同内容被拒绝而不是静默覆盖');
      suite.equal(conflict.code, 'IDEMPOTENCY_CONFLICT', '幂等键：冲突码为 IDEMPOTENCY_CONFLICT');
      await workbench.dispose();
    }

    // --------------------------------- 预分配 childId + 意图先落盘 / 重复提交
    {
      const workbench = await createWorkbench({
        clock: createFakeClock(),
        config: { capacity: { globalLeafLimit: 4 }, scheduler: { maxStartsPerTick: 4 } },
      });
      const { service, scheduler, native, storage } = workbench;
      const lead = leadAgent(workbench);
      await service.defineTeam(lead, { teamKey: 'team-a' });
      const spec = {
        teamKey: 'team-a', workId: 'w1', title: '交付 1', deliverable: '模块 1 完整实现',
        ownerMemberId: 'lead', outputs: ['src/m1.ts'], acceptance: ['ok'],
      };
      const submitted = await service.submitWork(lead, spec);
      suite.equal(submitted.ok, true, '提交工作项成功');

      // 锁内预留：意图与 childId 必须先落盘，再在锁外启动。
      const prefetch = await service.prefetchNative();
      const reservation = await service.reserveStarts(prefetch, 4);
      suite.equal(reservation.plans.length, 1, '预留阶段为 1 个 ready 项生成 plan');
      const plan = reservation.plans[0];
      const persistedIntent = storage.get('attempts', plan.attemptId);
      suite.assert(persistedIntent !== undefined, '预留阶段 attempt 记录已落盘（启动意图先落盘）', plan);
      suite.equal(persistedIntent.executorChildId, plan.childId, '落盘的 executorChildId 就是预分配的 childId');
      suite.equal(persistedIntent.state, 'reserved', '落盘状态为 reserved（尚未接触原生运行时）');
      suite.equal(native.startLog.length, 0, '锁内预留阶段没有调用原生 startContinuable');

      const launched = await service.executeStart(plan);
      suite.equal(launched.ok, true, '锁外启动成功');
      suite.equal(native.startLog[0].childId, plan.childId, '原生运行时收到的 childId 与预分配一致');
      suite.equal(native.childrenSnapshot().length, 1, '原生只创建了一个 child');

      // 重复提交同一意图 → 不产生第二份工作 / 第二个 attempt。
      const again = await service.submitWork(lead, spec);
      suite.equal(again.ok, true, '重复提交同一意图返回成功（幂等）');
      suite.equal(again.work.workId, 'w1', '重复提交返回同一个 workId');
      suite.equal(service.works.size, 1, '重复提交不产生第二份工作项');
      suite.equal(storage.size('works'), 1, '存储里也只有一条工作项');
      suite.equal(native.counters.createTask, 1, '原生 task 只创建一次（不重复创建）');

      // 重复 domain/changed 投递不产生重复工作。
      const worksBefore = service.works.size;
      const attemptsBefore = service.attempts.size;
      const change = { domain: 'team_workbench', table: 'works', key: 'w1', operation: 'put', value: spec };
      native.domainFacility.emitChange(change);
      native.domainFacility.emitChange(change);
      await workbench.clock.flush();
      await scheduler.tick();
      suite.equal(service.works.size, worksBefore, '重复 domain/changed 不产生重复工作项');
      suite.equal(service.attempts.size, attemptsBefore, '重复 domain/changed 不产生重复 attempt');

      // 重复回执：同一 attempt 的同一 settlement 只被接受一次。
      const attempt = service.attempts.get(plan.attemptId);
      const first = await service.reportWork({ id: attempt.executorChildId }, {
        attemptId: attempt.attemptId, leaseEpoch: attempt.leaseEpoch, outcome: 'produced',
        artifacts: [{ path: 'src/m1.ts', version: 1 }],
        evidence: [{ kind: 'verification', ok: true, command: 'node --test', ref: 'tests/m1' }],
        summary: 'done',
      });
      suite.equal(first.ok, true, '首次回执被接受');
      const revAfterFirst = service.works.get('w1').rev;
      const second = await service.reportWork({ id: attempt.executorChildId }, {
        attemptId: attempt.attemptId, leaseEpoch: attempt.leaseEpoch, outcome: 'produced',
        artifacts: [{ path: 'src/m1.ts', version: 1 }], summary: 'done again',
      });
      suite.equal(second.accepted, false, '重复回执不被再次接受');
      suite.assert(['DUPLICATE_RECEIPT', 'ALREADY_SETTLED'].includes(second.code), '重复回执返回明确去重码', second.code);
      suite.equal(service.works.get('w1').rev, revAfterFirst, '重复回执不推进工作项 revision');

      // 事件合并：start() 之后 notify 用 microtask 合并，同一 tick 多次事件只跑一次。
      const stop = scheduler.start();
      scheduler.notify('subagent/end', { childId: 'x' });
      scheduler.notify('subagent/end', { childId: 'y' });
      scheduler.notify('agent/status', { agent: { id: 'z' } });
      await workbench.clock.flush(12);
      const stats = scheduler.stats();
      suite.assert(stats.wakeCount >= 3, 'start() 之后每次 notify 都被记录', stats);
      suite.assert(stats.coalescedCount >= 2, '同一 tick 的多次事件被合并（coalescedCount >= 2）', stats);
      stop();
      suite.equal(scheduler.started, false, 'stop() 之后调度器不再自动唤醒');
      await workbench.dispose();
    }
  });
}

if (isMain(import.meta.url)) await main(run, meta);
