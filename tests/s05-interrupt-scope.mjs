/**
 * S05 — leader idle / 只停当前 turn 时成员继续；按范围停止的三种语义。
 *
 * 断言（方案第十三节 S05 + ARCHITECTURE §2.3）：
 *   1. `interruptTeam(lead, {scope:'turn'})` **对成员零影响**：成员的 attempt 仍 executing、
 *      `activeAttemptId` 未清、容量未释放，返回体 note 明确只停调用者自己的回合；
 *   2. `scope:'members'` → 成员 attempt 转 `waiting`、work 仍保留（ready，不是 cancelled）；
 *   3. `scope:'team'`   → attempt 取消、work cancelled、成员 phase 变 stopped；
 *   4. `interruptWork(caller, {scope:'turn'})` 之后该 work 回到 `ready`，
 *      但**写入范围仍被持有**（`writeScopeHolders()` 里还在）——
 *      "旧执行者确认停止前不换 lease、不释放范围"。
 */
import { createFakeClock } from './helpers/fake-clock.mjs';
import { runSuite, isMain, main } from './helpers/suite.mjs';
import { createWorkbench, leadAgent } from './helpers/harness.mjs';

export const meta = {
  id: 's05-interrupt-scope',
  title: 'S05：scope=turn 不影响成员；members 保留 work；team 取消；turn 后仍持有写入范围',
  acceptance: ['S05', 'S10'],
  requires: ['service', 'scheduler', 'storage', 'policy'],
};

export async function run() {
  return runSuite(meta, async (suite) => {
    const workbench = await createWorkbench({
      clock: createFakeClock(),
      config: { capacity: { globalLeafLimit: 6 }, scheduler: { maxStartsPerTick: 6 } },
    });
    if (workbench.mode !== 'real') {
      suite.fail('真实 Host 模块可用', { mode: workbench.mode, pendingReason: workbench.pendingReason });
      return;
    }
    const { service, scheduler, native } = workbench;
    const lead = leadAgent(workbench);

    await service.defineTeam(lead, { teamKey: 'team-a', goal: '范围停止验收' });
    // §11 理想形（Lead 裁定 (ii)）：**work 由 member 通过 team_plan_submit 自己创建**，
    // 成员自建会自动授权 → ready → 调度器按原语义启动。强度断言保持原值。
    const memberAgents = new Map();
    for (const name of ['m1', 'm2']) {
      const created = await service.createMember(lead, { teamKey: 'team-a', name, description: `${name} 模块完整交付` });
      if (!created.ok) suite.fail(`createMember ${name}`, created);
      const sessionId = created.sessionId ?? created.member?.sessionId;
      const agent = native.agentFor(sessionId) ?? native.registerAgent(sessionId, { name });
      native.registerMembership(sessionId, { id: 'team-a', role: 'teammate', name, root: lead });
      memberAgents.set(name, agent);
    }
    const missions = {};
    for (const name of ['m1', 'm2']) {
      const mission = await service.missionAssign(lead, { teamKey: 'team-a', memberId: name, title: `${name} 模块`, goal: `${name} 模块完整交付` });
      if (!mission.ok) suite.fail(`missionAssign ${name}`, mission);
      missions[name] = mission.mission?.missionId ?? mission.missionId;
    }
    // 成员自己规划：m1 拥有 w1/w3，m2 拥有 w2（成员自建 → 自动授权）
    const plans = [
      ['m1', ['w1', 'w3']],
      ['m2', ['w2']],
    ];
    for (const [name, workIds] of plans) {
      // 每个 work 保留各自不同的 writeScopes（原场景：src/m1 / src/m2 / src/m3）。
      // 我在 (ii) 改写里曾把 m1 的两个 work 写成同一 scope，触发了既有的
      // "同 writeScopes 串行化"设计，导致 w3 一直不启动 —— 那是我丢了原始 scope，不是设计问题。
      const scopeOf = { w1: 'src/m1', w2: 'src/m2', w3: 'src/m3' };
      const deliverables = workIds.map((workId) => ({
        workId,
        title: `${name} 的完整交付 ${workId}`,
        deliverable: `${name} 模块 ${workId} 的完整实现`,
        kind: 'module',
        outputs: [scopeOf[workId] + "/index.ts"],
        acceptance: ['可集成'],
        writeScopes: [scopeOf[workId]],
        execution: 'delegate',
      }));
      const planned = await service.planSubmit(memberAgents.get(name), { teamKey: 'team-a', missionId: missions[name], expectedPlanRevision: 0, deliverables });
      if (!planned.ok) suite.fail(`planSubmit ${name}`, planned);
      const revision = planned.planRevision ?? planned.plan?.planRevision;
      const authorized = await service.dispatchAuthorize(memberAgents.get(name), { teamKey: 'team-a', planRevision: revision, workIds });
      if (!authorized.ok) suite.fail(`dispatchAuthorize ${name}`, authorized);
      for (const workId of workIds) suite.equal(service.works.get(workId).state, 'ready', `${workId}：成员自建+自授权后为 ready`);
    }

    // ---- §11 反例回归（必须保留）：leader 替成员建的 work 永不自动启动 ----------
    // Lead 裁定 (a)：用**独立 workbench**，避免这里的 3 次 tick() 消耗主场景槽位
    // （旧写法会把已 ready 且已授权的 w1/w2 提前启动，主场景随后 started=[]）。
    {
      const probe = await createWorkbench({ clock: createFakeClock(), config: { capacity: { globalLeafLimit: 4 } } });
      const probeService = probe.service;
      const probeScheduler = probe.scheduler;
      const probeLead = leadAgent(probe);
      await probeService.defineTeam(probeLead, { teamKey: 'team-a', goal: '§11 反例' });
      await probeService.createMember(probeLead, { teamKey: 'team-a', name: 'm1', description: '反例成员' });
      const leaderBuilt = await probeService.submitWork(probeLead, {
        teamKey: 'team-a',
        workId: 'w-leader-built',
        title: 'leader 替成员建的交付',
        deliverable: 'leader 替成员建的完整实现',
        ownerMemberId: 'm1',
        outputs: ['src/leader-built/index.ts'],
        acceptance: ['可集成'],
        writeScopes: ['src/leader-built'],
      });
      suite.equal(leaderBuilt.ok, true, '§11 反例：leader 替成员提交本身是允许的（但不得可调度）');
      suite.equal(probeService.works.get('w-leader-built').state, 'needs_plan', '§11 反例：leader 替建的 work 处于 needs_plan（不是 ready）');
      const intents = [...(probeService.dispatchIntents?.values?.() ?? [])].filter((i) => i.workId === 'w-leader-built');
      suite.equal(intents.filter((i) => i.state === 'authorized').length, 0, '§11 反例：不存在它的 authorized 意图');
      for (let i = 0; i < 3; i += 1) await probeScheduler.tick();
      suite.equal(probeService.works.get('w-leader-built').state, 'needs_plan', '§11 反例：多次 tick 后仍是 needs_plan');
      suite.equal(probeService.works.get('w-leader-built').activeAttemptId ?? null, null, '§11 反例：多次 tick 后仍没有 attempt（永不自动启动）');
      await probe.dispose();
    }
    const tick = await scheduler.tick();
    suite.equal(tick.started.length, 3, '三个工作项都启动（每个 member 一个以上）—— 强度与旧基线一致');
    const startIds = [...tick.started].map((s) => (typeof s === 'string' ? s : s.workId)).sort();
    suite.deepEqual(startIds, ['w1', 'w2', 'w3'], '授权前后 tick().started 的差集恰好是这三个 work（不多不少）');
    const w1AttemptId = service.works.get('w1').activeAttemptId;
    const w2AttemptId = service.works.get('w2').activeAttemptId;
    const w3AttemptId = service.works.get('w3').activeAttemptId;
    suite.equal(service.attempts.get(w1AttemptId).state, 'executing', 'w1 的 attempt 处于 executing');
    suite.equal(service.attempts.get(w2AttemptId).state, 'executing', 'w2 的 attempt 处于 executing');
    const capacityBefore = scheduler.capacity();
    suite.equal(capacityBefore.activeLeaves, 3, '停止前 activeLeaves = 3');

    // ---- scope: 'turn' → 只停 lead 自己的回合 ------------------------------
    const turnResult = await service.interruptTeam(lead, { scope: 'turn' });
    suite.equal(turnResult.ok, true, 'scope=turn 返回成功');
    suite.deepEqual(turnResult.stoppedAttempts, [], 'scope=turn 没有停止任何成员 attempt');
    suite.includes(String(turnResult.note ?? ''), '只停止调用者自己当前的模型回合', 'note 明确说明只停调用者自己的回合');
    suite.includes(String(turnResult.note ?? ''), '不受影响', 'note 明确说明成员不受影响');
    suite.equal(service.attempts.get(w1AttemptId).state, 'executing', 'scope=turn 后 m1 的 attempt 仍 executing');
    suite.equal(service.attempts.get(w2AttemptId).state, 'executing', 'scope=turn 后 m2 的 attempt 仍 executing');
    suite.equal(service.works.get('w1').activeAttemptId, w1AttemptId, 'scope=turn 后 w1 仍持有 activeAttemptId');
    suite.equal(service.works.get('w2').activeAttemptId, w2AttemptId, 'scope=turn 后 w2 仍持有 activeAttemptId');
    suite.equal(service.works.get('w1').state, 'executing', 'scope=turn 后 w1 状态未被改动');
    const capacityAfterTurn = scheduler.capacity();
    suite.equal(capacityAfterTurn.activeLeaves, capacityBefore.activeLeaves, 'scope=turn 没有释放任何槽位');
    suite.equal(capacityAfterTurn.residentInUse, capacityBefore.residentInUse, 'scope=turn 没有改变 resident 占用');
    const afterTurnTick = await scheduler.tick();
    suite.equal(afterTurnTick.started.length, 0, '成员仍在执行，没有空槽可补（成员确实继续运行）');

    // ---- scope: 'members' → 停每个成员当前回合，保留 work -------------------
    const membersResult = await service.interruptTeam(lead, { scope: 'members' });
    suite.equal(membersResult.ok, true, 'scope=members 返回成功');
    suite.equal(membersResult.stoppedAttempts.length, 3, 'scope=members 停止了 3 个 attempt');
    suite.equal(service.attempts.get(w1AttemptId).state, 'waiting', 'scope=members 后 attempt 转 waiting');
    suite.equal(service.attempts.get(w2AttemptId).state, 'waiting', 'scope=members 后第二个 attempt 也转 waiting');
    suite.equal(service.works.get('w1').state, 'ready', 'scope=members 后 w1 回到 ready（work 保留）');
    suite.equal(service.works.get('w1').state !== 'cancelled', true, 'scope=members 不会把 work 取消');
    suite.equal(service.works.get('w1').activeAttemptId, null, 'scope=members 后清空 activeAttemptId');
    suite.equal(service.works.get('w2').state, 'ready', 'scope=members 后 w2 回到 ready');
    for (const name of ['m1', 'm2']) {
      const member = service.members.get(`team-a/${name}`);
      suite.equal(member.phase, 'active', `scope=members 不改变成员 phase（${name} 仍 active）`);
    }
    suite.includes(String(membersResult.note ?? ''), '工作项与队列保留', 'note 说明工作项与队列保留');

    // ---- scope: 'team' → 取消 attempt + work，成员 stopped ------------------
    const teamResult = await service.interruptTeam(lead, { scope: 'team' });
    suite.equal(teamResult.ok, true, 'scope=team 返回成功');
    suite.equal(service.attempts.get(w3AttemptId).state, 'cancelled', 'scope=team 取消仍在执行态的 attempt');
    suite.equal(service.works.get('w1').state, 'cancelled', 'scope=team 取消工作项');
    suite.equal(service.works.get('w3').state, 'cancelled', 'scope=team 取消全部工作项');
    for (const name of ['m1', 'm2']) {
      suite.equal(service.members.get(`team-a/${name}`).phase, 'stopped', `scope=team 把成员 ${name} 标为 stopped`);
    }
    suite.includes(String(teamResult.note ?? ''), '整队停止', 'note 说明整队停止');
    suite.equal(native.childrenSnapshot().filter((child) => child.status === 'running').length, 0, 'scope=team 后没有仍在运行的 child');

    // ---- interruptWork(scope:'turn')：work 回 ready，但写入范围仍被持有 -----
    {
      const fresh = await createWorkbench({
        clock: createFakeClock(),
        config: { capacity: { globalLeafLimit: 4 }, scheduler: { maxStartsPerTick: 4 } },
      });
      const freshLead = leadAgent(fresh);
      await fresh.service.defineTeam(freshLead, { teamKey: 'team-b' });
      await fresh.service.createMember(freshLead, { teamKey: 'team-b', name: 'solo', description: '单模块完整交付' });
      await fresh.service.submitWork(freshLead, {
        teamKey: 'team-b',
        workId: 'hold-1',
        title: '需要独占写入的交付',
        deliverable: '独占写入模块的完整实现',
        ownerMemberId: 'solo',
        outputs: ['shared/pkg/index.ts'],
        acceptance: ['可集成'],
        writeScopes: ['shared/pkg'],
      });
      // 契约：dispatchAuthorize 是唯一授权入口（leader 提交的 work 不会自动启动）。
      const soloMember = fresh.service.members.get('team-b/solo');
      const soloSession = soloMember?.sessionId;
      const soloAgent = fresh.native.agentFor(soloSession) ?? fresh.native.registerAgent(soloSession, { name: 'solo' });
      fresh.native.registerMembership(soloSession, { id: 'team-b', role: 'teammate', name: 'solo', root: freshLead });
      const holdPlanRevision = fresh.service.works.get('hold-1')?.planRevision ?? 0;
      const holdAuthorized = await fresh.service.dispatchAuthorize(soloAgent, { teamKey: 'team-b', planRevision: holdPlanRevision, workIds: ['hold-1'] });
      if (!holdAuthorized.ok) suite.fail('dispatchAuthorize solo', holdAuthorized);
      const started = await fresh.scheduler.tick();
      suite.equal(started.started.length, 1, '独占工作项已启动');
      const attemptId = fresh.service.works.get('hold-1').activeAttemptId;
      suite.assert(
        fresh.service.writeScopeHolders().some((holder) => holder.workId === 'hold-1'),
        '启动后写入范围被持有',
        fresh.service.writeScopeHolders(),
      );
      const holdersBefore = fresh.service.writeScopeHolders().find((holder) => holder.workId === 'hold-1');

      const interrupted = await fresh.service.interruptWork(freshLead, { workId: 'hold-1', scope: 'turn' });
      suite.equal(interrupted.ok, true, 'interruptWork(scope=turn) 成功');
      suite.equal(fresh.service.attempts.get(attemptId).state, 'waiting', 'interruptWork(scope=turn) 把 attempt 置为 waiting');
      suite.equal(fresh.service.works.get('hold-1').state, 'ready', 'interruptWork(scope=turn) 后 work 回到 ready');
      suite.equal(fresh.service.works.get('hold-1').activeAttemptId, null, 'interruptWork(scope=turn) 后清空 activeAttemptId');
      const holderAfter = fresh.service.writeScopeHolders().find((holder) => holder.workId === 'hold-1');
      suite.assert(holderAfter !== undefined, 'work 回到 ready 后，写入范围**仍然**被旧执行者持有（确认停止前不释放）', fresh.service.writeScopeHolders());
      suite.equal(holderAfter?.state, 'waiting', '持有者状态是 waiting（既没换 lease 也没释放范围）');
      suite.equal(holderAfter?.attemptId, holdersBefore?.attemptId, '持有范围的是同一个 attempt（没有换 leaseEpoch）');
      suite.equal(fresh.service.attempts.get(attemptId).leaseEpoch, 1, 'leaseEpoch 保持 1，未被抢占');
      const replacement = await fresh.scheduler.tick();
      suite.assert(
        replacement.started.every((plan) => plan.workId !== 'hold-1'),
        '范围仍被持有时，同一范围的工作项不会被重新派发',
        replacement.started.map((plan) => plan.workId),
      );
      await fresh.dispose();
    }

    await workbench.dispose();
  });
}

if (isMain(import.meta.url)) await main(run, meta);
