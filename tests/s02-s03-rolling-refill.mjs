/**
 * S02 + S03 — 滚动补位与"慢任务不阻塞无关项"
 *
 * 场景：20 个独立交付、10 个 worker 槽、5 个 member（每人 4 项，低于 perMemberLeaves=6，
 * 因此限制槽位的是 workerCapacity 而不是成员公平额度）。
 *   T01..T15 初始 ready；T16..T20 真实依赖慢任务 T10。
 *
 * 断言（docs/ARCHITECTURE.md；历史检查 2.5 / 方案 §7）：
 *   1. 任何时刻 activeLeaves <= workerCapacity，residentInUse <= residentCapacity；
 *   2. 每个 settlement 独立补位：结算 k 项就补 k 项，没有"等整批完成"的屏障；
 *   3. 慢任务 T10 不影响无关项；
 *   4. 依赖未满足的 T16..T20 从不被调度启动（真正的调度层不偷跑）；
 *   5. 依赖项在 claim/状态层面也不得被当作 ready（冻结语义 §2.5）；
 *   6. T10 真正交付后 T16..T20 才启动；
 *   7. 调度器不持有批次状态。
 */
import { createFakeClock } from './helpers/fake-clock.mjs';
import { runSuite, isMain, main } from './helpers/suite.mjs';
import { createWorkbench, leadAgent } from './helpers/harness.mjs';

export const meta = {
  id: 's02-s03-rolling-refill',
  title: '滚动补位：20 项 / 10 槽 / 逐项补位 / 慢任务与依赖不偷跑',
  acceptance: ['S02', 'S03'],
  requires: ['service', 'scheduler', 'storage', 'policy'],
};

const MEMBERS = ['m1', 'm2', 'm3', 'm4', 'm5'];
const SLOW_WORK = 't10';
const BLOCKED_IDS = ['t16', 't17', 't18', 't19', 't20'];

const workIdOf = (index) => `t${String(index).padStart(2, '0')}`;

async function produced(service, plan, moduleIndex) {
  const attempt = service.attempts.get(plan.attemptId);
  // 契约 v4：verification 必须引用 Host execution_runs 的 runId；用真实 runVerification 产生再交给 reportWork。
  const artifact = `src/mod${moduleIndex}/index.ts`;
  // 可信执行只允许该模块 owner 成员/lead：用 owner 成员 agent 产生 run，leaf 回执引用它。
  const work = service.works.get(plan.workId);
  const ownerMember = service.members?.get(`${work?.teamKey ?? 'team-a'}/${plan.ownerMemberId ?? work?.ownerMemberId}`);
  const ownerSessionId = ownerMember?.sessionId;
  const ownerAgent = ownerSessionId ? (service.ctx?.agents?.get(ownerSessionId) ?? { id: ownerSessionId }) : null;
  const declared = Array.isArray(work?.verificationCommands) ? work.verificationCommands : [];
  if (declared.length === 0) {
    // 该 work 没有计划期声明检查（非 T10 收尾路径）：按契约只交回产物，不伪造验证证据。
    return service.reportWork({ id: attempt.executorChildId }, { attemptId: plan.attemptId, leaseEpoch: attempt.leaseEpoch, outcome: 'produced', artifacts: [{ path: artifact, version: 1 }], summary: `模块 ${moduleIndex} 完成（无声明检查）` });
  }
  const run = await service.runVerification(ownerAgent, {
    workId: plan.workId,
    command: 'node',
    argv: ['-e', 'process.exit(0)'],
    artifacts: [artifact],
    scope: 'offline',
  });
  if (run.ok !== true) throw new Error(`produced: runVerification failed ${run.code} ${run.message}`);
  return service.reportWork(
    { id: attempt.executorChildId },
    {
      attemptId: plan.attemptId,
      leaseEpoch: attempt.leaseEpoch,
      outcome: 'produced',
      artifacts: [{ path: artifact, version: 1 }],
      evidence: [{ kind: 'verification', runId: run.runId, file: artifact, version: 1 }],
      summary: `模块 ${moduleIndex} 完成`,
    },
  );
}

export async function run() {
  const workbench = await createWorkbench({
    clock: createFakeClock(),
    config: {
      capacity: { hostActivationLimit: 40, globalLeafLimit: 10, recoveryReserve: 3, interactiveReserve: 2, perMemberLeaves: 6 },
      scheduler: { maxStartsPerTick: 10 },
      // harness fake adapter 没有真实原生 tools.execute：用直接执行路径（真实 spawn/退出码），仍产生真实 runId。
      execution: { nativeExecution: false },
    },
  });

  return runSuite(meta, async (suite) => {
    if (workbench.mode !== 'real') {
      suite.fail('真实 Host 模块可用', { mode: workbench.mode, pendingReason: workbench.pendingReason });
      return;
    }
    const { service, scheduler, native, config } = workbench;
    const lead = leadAgent(workbench);

    const team = await service.defineTeam(lead, { teamKey: 'team-a', goal: '滚动补位验收' });
    suite.equal(team.ok, true, 'defineTeam 成功');
    for (const name of MEMBERS) {
      const created = await service.createMember(lead, { teamKey: 'team-a', name, description: `${name} 模块完整交付` });
      if (!created.ok) suite.fail(`createMember ${name}`, created);
    }
    suite.equal(service.memberCount('team-a'), MEMBERS.length, '5 个 member 已登记');

    // ---- 20 个独立交付：§11/§12/§13 新前提 ---------------------------------
    // work 由 **member 自己** planSubmit 创建（leader 只 missionAssign）；跨成员 `blockedBy` 合法（§13.1）；
    // 依赖未满足 → 显式 `blocked`（§13.2，冻结语义保留）；`dispatchAuthorize` 是唯一授权入口。
    const memberAgents = new Map();
    for (const name of MEMBERS) {
      const member = service.members.get(`team-a/${name}`);
      const sessionId = member?.sessionId;
      const agent = native.agentFor(sessionId) ?? native.registerAgent(sessionId, { name });
      native.registerMembership(sessionId, { id: 'team-a', role: 'teammate', name, root: lead });
      memberAgents.set(name, agent);
    }
    const missions = new Map();
    for (const name of MEMBERS) {
      const mission = await service.missionAssign(lead, { teamKey: 'team-a', memberId: name, title: `${name} 模块`, goal: `${name} 模块的 4 份独立交付` });
      if (!mission.ok) suite.fail(`missionAssign ${name}`, mission);
      missions.set(name, mission.mission?.missionId ?? mission.missionId);
    }
    // 原因 1（Lead 裁定）：**被依赖项必须先提交**。t10 的 owner 先 planSubmit，之后才提交 t16..t20，
    // 否则 planSubmit 会被正确拒绝（DEPENDENCY_UNRESOLVED，整批原子失败）——语义与强度不变。
    const slowIndex = Number(String(SLOW_WORK).replace(/\\D/g, '')) || 10;
    const slowOwner = MEMBERS[(slowIndex - 1) % MEMBERS.length];
    const submitOrder = [slowOwner, ...MEMBERS.filter((n) => n !== slowOwner)];
    for (const name of submitOrder) {
      const deliverables = [];
      for (let index = 1; index <= 20; index += 1) {
        if (MEMBERS[(index - 1) % MEMBERS.length] !== name) continue;
        deliverables.push({
          workId: workIdOf(index),
          title: `独立交付 ${index}`,
          deliverable: `模块 ${index} 的完整实现`,
          kind: 'module',
          outputs: [`src/mod${index}/index.ts`],
          acceptance: [`模块 ${index} 可真实集成`],
          writeScopes: [`src/mod${index}`],
          execution: 'delegate',
          // 契约 v4：验收必须绑定**计划期声明**的可执行检查（verificationCommands），不能临时空跑。
          verificationCommands: [{ command: 'node', argvPrefix: ['-e', 'process.exit(0)'], acceptanceIndex: 0 }],
          blockedBy: index >= 16 ? [SLOW_WORK] : [],
        });
      }
      const planned = await service.planSubmit(memberAgents.get(name), { teamKey: 'team-a', missionId: missions.get(name), expectedPlanRevision: 0, deliverables });
      if (!planned.ok) suite.fail(`planSubmit ${name}`, planned);
      const revision = planned.planRevision ?? planned.plan?.planRevision;
      const authorized = await service.dispatchAuthorize(memberAgents.get(name), { teamKey: 'team-a', planRevision: revision, workIds: deliverables.map((d) => d.workId) });
      if (!authorized.ok) suite.fail(`dispatchAuthorize ${name}`, authorized);
    }    suite.equal(service.works.get('t16').blockedBy.length, 1, 'T16 记录了真实依赖 T10');
    suite.equal(service.works.get('t16').state, 'blocked', 'T16 提交后即为 blocked（冻结语义 §2.5：blockedBy 必须全部 produced）');
    const prematureClaim = await service.claimWork(lead, { workId: 't16' });
    suite.assert(
      prematureClaim.ok === false && prematureClaim.code === 'WORK_BLOCKED',
      '依赖未满足的 T16 不能被认领（WORK_BLOCKED）',
      { ok: prematureClaim.ok, code: prematureClaim.code },
    );

    // ---- 第一轮：填满 10 个槽 ---------------------------------------------
    const tick1 = await scheduler.tick();
    suite.equal(tick1.started.length, 10, '首轮恰好启动 10 项（= workerCapacity）');
    const firstBatchIds = tick1.started.map((plan) => plan.workId);
    suite.assert(
      tick1.started.every((plan) => !BLOCKED_IDS.includes(plan.workId)),
      '依赖未满足的 T16..T20 从未被调度启动',
      firstBatchIds,
    );
    suite.assert(
      tick1.readyBefore.every((workId) => !BLOCKED_IDS.includes(workId)),
      '依赖未满足的 T16..T20 不在 ready 集合里',
      tick1.readyBefore,
    );

    const cap1 = scheduler.capacity();
    suite.compare(cap1.activeLeaves, '<=', cap1.workerCapacity, 'activeLeaves <= workerCapacity');
    suite.compare(cap1.residentInUse, '<=', cap1.residentCapacity, 'residentInUse <= residentCapacity');
    suite.equal(cap1.workerCapacity, 10, 'workerCapacity 取 globalLeafLimit=10');
    suite.equal(cap1.residentCapacity, 35, 'residentCapacity = 40-3-2=35');
    suite.equal(scheduler.batchState().hasBatch, false, '调度器不持有批次状态（无全批屏障）');
    suite.equal(native.fullRejections.length, 0, '原生 Activation 池从未拒绝（预留与原生限额一致）');

    // ---- 单项 settlement → 单项补位（无屏障） ------------------------------
    const slowPlan = tick1.started.find((plan) => plan.workId === SLOW_WORK);
    suite.assert(slowPlan !== undefined, '慢任务 T10 已在首个批次中启动', firstBatchIds);

    const others = tick1.started.filter((plan) => plan.workId !== SLOW_WORK);
    const notStartedYet = tick1.readyBefore.filter((workId) => !firstBatchIds.includes(workId));

    const firstPlan = others[0];
    const report1 = await produced(service, firstPlan, Number(String(firstPlan.workId).slice(1)));
    suite.equal(report1.ok, true, `结算 ${firstPlan.workId} 后回执被接受`);

    const tickAfterOne = await scheduler.tick();
    suite.equal(tickAfterOne.started.length, 1, '只结算 1 项就只补 1 项（逐项补位，无整批屏障）');
    suite.assert(
      notStartedYet.includes(tickAfterOne.started[0].workId),
      '补位项来自首轮未启动的 ready 集合（不是等待同批重启）',
      { refill: tickAfterOne.started[0].workId, notStartedYet },
    );
    suite.assert(
      !firstBatchIds.includes(tickAfterOne.started[0].workId),
      '补位项不是已在运行的同批项',
      { firstBatchIds, refill: tickAfterOne.started[0].workId },
    );
    const capAfterOne = scheduler.capacity();
    suite.compare(capAfterOne.activeLeaves, '<=', capAfterOne.workerCapacity, '补位后 activeLeaves 仍不超上限');

    // ---- 其余 4 项 settlement → 再补 4 项 ----------------------------------
    for (const plan of others.slice(1, 5)) {
      const result = await produced(service, plan, Number(String(plan.workId).slice(1)));
      if (!result.ok) suite.fail(`结算 ${plan.workId}`, result);
    }
    const tickAfterFive = await scheduler.tick();
    suite.equal(tickAfterFive.started.length, 4, '其余 4 项 settlement 后补 4 项');
    suite.assert(
      tickAfterFive.started.every((plan) => !BLOCKED_IDS.includes(plan.workId)),
      '第二轮补位仍不包含被 T10 阻塞的 T16..T20',
      tickAfterFive.started.map((plan) => plan.workId),
    );
    const cap5 = scheduler.capacity();
    suite.compare(cap5.activeLeaves, '<=', cap5.workerCapacity, '第二轮补位后 activeLeaves <= workerCapacity');
    suite.compare(cap5.residentInUse, '<=', cap5.residentCapacity, '第二轮补位后 residentInUse <= residentCapacity');

    // ---- 慢任务仍在运行，依赖项仍不偷跑 ------------------------------------
    suite.equal(service.works.get(SLOW_WORK).state, 'executing', '慢任务 T10 仍在执行（未结算）');
    const stillBlocked = await scheduler.tick();
    suite.equal(stillBlocked.started.length, 0, 'T10 未完成时没有空槽，也没有依赖项偷跑');
    suite.assert(
      stillBlocked.readyBefore.every((workId) => !BLOCKED_IDS.includes(workId)),
      'T16..T20 始终不在 ready 集合里（依赖真实未满足）',
      stillBlocked.readyBefore,
    );

    // ---- 慢任务真正交付 → 依赖项才启动 -------------------------------------
    const slowAttempt = service.attempts.get(slowPlan.attemptId);
    const slowReport = await produced(service, slowPlan, 10);
    suite.equal(slowReport.ok, true, '慢任务 T10 提交真实回执');
    // Lead 裁定：自治 work 回执 produced + 证据后按契约 §2 落 **`awaiting_verification`**
    //（"产物已交回，等待 owner 核验"）。这条**更精确**、不是放宽：它同时锁住"已交回"与"尚未验收"。
    // "未验收不得算完成"的含义仍由下游 `requires:'verified-result'` 那条断言守护（保留）。
    const slowWork = service.works.get(SLOW_WORK);
    // Lead 裁定（词表来自 `src/host/policy.js:49` COMPLETION_LEVELS + `completionGate`）：
    //   `completion.level`（提交方能提供到什么程度的证据）与 `state`（owner 是否已核验）是**两个维度**。
    //   `level==='verified'` + `state==='awaiting_verification'` 不是矛盾，正是正解：
    //   leaf 交了**真实验证证据**，但**验收权在 owner**、尚未核验 → **不算完成**。
    //   这条比原来"只接受 produced 一个词"**更精确**（同时锁住证据等级与验收状态两个维度）。
    suite.assert(
      slowWork.completion?.level === 'verified'
        && slowWork.state === 'awaiting_verification'
        && slowWork.verification?.outcome === undefined,
      'T10 已交回且带真实验证证据，但未被 owner 验收（produced/verified ≠ accepted）',
      { state: slowWork.state, level: slowWork.completion?.level ?? null, outcome: slowWork.verification?.outcome ?? null },
    );
    suite.assert(
      slowWork.state !== 'accepted' && slowWork.completion?.level !== 'accepted',
      '未验收不得被当成 accepted（独立性：证据等级与验收状态必须分开看）',
      { state: slowWork.state, level: slowWork.completion?.level ?? null },
    );

    const tickUnblocked = await scheduler.tick();
    const unblockedIds = tickUnblocked.started.map((plan) => plan.workId);
    suite.assert(unblockedIds.length >= 1, 'T10 交付后空出的槽位开始服务依赖项', unblockedIds);
    suite.assert(
      unblockedIds.every((workId) => BLOCKED_IDS.includes(workId)),
      'T10 交付后启动的全部是真正依赖它的项（T16..T20）',
      unblockedIds,
    );
    suite.equal(slowAttempt.leaseEpoch, 1, '慢任务 attempt 的 leaseEpoch 保持 1（未被抢占）');

    // ---- 释放剩余槽位，依赖项应全部获得执行 --------------------------------
    const startedLog = [...tick1.started, ...tickAfterOne.started, ...tickAfterFive.started, ...tickUnblocked.started];
    let guard = 0;
    while (guard < 60) {
      guard += 1;
      const startedIds = new Set(startedLog.map((plan) => plan.workId));
      if (BLOCKED_IDS.every((workId) => startedIds.has(workId))) break;
      const victim = [...service.attempts.values()].find(
        (attempt) => attempt.state === 'executing' && !BLOCKED_IDS.includes(attempt.workId),
      );
      if (!victim) break;
      const result = await produced(service, { workId: victim.workId, attemptId: victim.attemptId }, 0);
      if (!result.ok) break;
      const next = await scheduler.tick();
      startedLog.push(...next.started);
    }
    const startedIdsFinal = new Set(startedLog.map((plan) => plan.workId));
    suite.assert(
      BLOCKED_IDS.every((workId) => startedIdsFinal.has(workId)),
      '依赖项 T16..T20 在依赖交付后全部获得执行机会',
      { missing: BLOCKED_IDS.filter((workId) => !startedIdsFinal.has(workId)), guard },
    );

    // ---- 汇总不变量 ---------------------------------------------------------
    suite.equal(startedIdsFinal.size, 20, '20 项最终全部获得执行机会（无重复启动）');
    suite.equal(startedLog.length, 20, '没有任何工作项被启动两次');
    const finalCap = scheduler.capacity();
    suite.compare(finalCap.activeLeaves, '<=', finalCap.workerCapacity, '最终 activeLeaves <= workerCapacity');
    suite.compare(finalCap.residentInUse, '<=', finalCap.residentCapacity, '最终 residentInUse <= residentCapacity');
    suite.equal(native.fullRejections.length, 0, '全程原生 Activation 池零拒绝');
    suite.assert(scheduler.stats().ticks >= 5, 'tick 序列可被测试完全驱动（无真实定时器）', scheduler.stats());
    suite.note(`capacity=${JSON.stringify(config.capacity)}; startedOrder=${startedLog.map((plan) => plan.workId).join(',')}`);
  });
}

if (isMain(import.meta.url)) await main(run, meta);
