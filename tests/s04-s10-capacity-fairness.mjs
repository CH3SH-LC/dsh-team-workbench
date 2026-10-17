/**
 * S04 + S10 — 三层容量、父成员等待不死锁、每成员公平额度、双团队配额与写入冲突
 *
 * 场景 A（S04 全展开）：5 members × 6 leaves = 30 个叶子；hostActivationLimit=40，
 *   recoveryReserve=3、interactiveReserve=2 → residentCapacity=35。
 *   全展开时 30 leaves + 5 个等待 children 的父成员 = 35，正好用满但不能死锁。
 * 场景 B（公平额度）：m1 独占 20 项、m2/m3/m4 各 1 项，globalLeafLimit=8。
 *   单一成员不得垄断全部槽位。
 * 场景 C（S10 双团队）：两个 team 同时运行，配额公平、leader 交互余量保留。
 * 场景 D（S10 不跨项目写）：两个团队的工作项 writeScopes 重叠时不得并发启动。
 */
import { createFakeClock } from './helpers/fake-clock.mjs';
import { runSuite, isMain, main } from './helpers/suite.mjs';
import { createWorkbench, leadAgent } from './helpers/harness.mjs';

export const meta = {
  id: 's04-s10-capacity-fairness',
  title: '容量：全展开不死锁、每成员公平额度、双团队配额与写入冲突',
  acceptance: ['S04', 'S10'],
  requires: ['service', 'scheduler', 'storage', 'policy'],
};

/** Resolve a work-id set from the started log. */
const ids = (plans) => plans.map((plan) => plan.workId);

/** 契约：dispatchAuthorize 是唯一授权入口；按成员批量授权其名下 work。 */
async function authorizeWorks(service, native, lead, teamKey, names) {
  for (const name of names) {
    const member = service.members.get(`${teamKey}/${name}`);
    const sessionId = member?.sessionId;
    if (!sessionId) continue;
    const agent = native.agentFor(sessionId) ?? native.registerAgent(sessionId, { name });
    native.registerMembership(sessionId, { id: teamKey, role: 'teammate', name, root: lead });
    const owned = [...service.works.values()].filter((item) => item.teamKey === teamKey && item.ownerMemberId === name).map((item) => item.workId);
    if (owned.length === 0) continue;
    const planRevision = service.works.get(owned[0])?.planRevision ?? 0;
    const authorized = await service.dispatchAuthorize(agent, { teamKey, planRevision, workIds: owned });
    if (!authorized.ok) throw new Error(`dispatchAuthorize ${teamKey}/${name}: ${authorized.code} ${authorized.message}`);
  }
}

async function submit(service, lead, spec) {
  const result = await service.submitWork(lead, spec);
  if (!result.ok) throw new Error(`submitWork ${spec.workId} failed: ${result.code} ${result.message}`);
  return result.work;
}

export async function run() {
  return runSuite(meta, async (suite) => {
    // ---------------------------------------------------------------- 场景 A
    {
      const workbench = await createWorkbench({
        clock: createFakeClock(),
        config: { capacity: { hostActivationLimit: 40, globalLeafLimit: 30, recoveryReserve: 3, interactiveReserve: 2, perMemberLeaves: 6, teamsMaxConcurrent: 3 } },
      });
      if (workbench.mode !== 'real') {
        suite.fail('真实 Host 模块可用', { mode: workbench.mode, pendingReason: workbench.pendingReason });
        return;
      }
      const { service, scheduler, native } = workbench;
      const lead = leadAgent(workbench);
      await service.defineTeam(lead, { teamKey: 'team-a' });
      const members = [];
      for (let index = 1; index <= 5; index += 1) {
        const name = `m${index}`;
        members.push(name);
        const created = await service.createMember(lead, { teamKey: 'team-a', name, description: `${name} 模块` });
        if (!created.ok) suite.fail(`createMember ${name}`, created);
      }
      for (let index = 1; index <= 30; index += 1) {
        await submit(service, lead, {
          teamKey: 'team-a',
          workId: `c${String(index).padStart(2, '0')}`,
          title: `完整交付 ${index}`,
          deliverable: `模块 ${index} 的完整实现`,
          ownerMemberId: members[(index - 1) % members.length],
          outputs: [`src/c${index}/index.ts`],
          acceptance: [`模块 ${index} 可集成`],
        });
      }

      // 契约：dispatchAuthorize 是唯一授权入口（scheduler 只消费 authorized intent）。
      for (const name of members) {
        const member = service.members.get(`team-a/${name}`);
        const sessionId = member?.sessionId;
        const agent = native.agentFor(sessionId) ?? native.registerAgent(sessionId, { name });
        native.registerMembership(sessionId, { id: 'team-a', role: 'teammate', name, root: lead });
        const owned = [...service.works.values()].filter((item) => item.ownerMemberId === name).map((item) => item.workId);
        const planRevision = service.works.get(owned[0])?.planRevision ?? 0;
        const authorized = await service.dispatchAuthorize(agent, { teamKey: 'team-a', planRevision, workIds: owned });
        if (!authorized.ok) suite.fail(`dispatchAuthorize ${name}`, authorized);
      }

      let started = [];
      for (let round = 0; round < 6; round += 1) {
        const report = await scheduler.tick();
        started = started.concat(report.started);
        if (started.length >= 30) break;
      }
      suite.equal(started.length, 30, 'S04：5×6=30 个叶子全部获得执行（父成员等待 children 不会占满全池导致死锁）');

      const cap = scheduler.capacity();
      suite.equal(cap.activeLeaves, 30, 'S04：activeLeaves 达到 30（= workerCapacity）');
      suite.equal(service.memberCount('team-a'), 5, 'S04：5 个 member 均已登记');
      suite.equal(cap.residentInUse, 35, 'S04：residentInUse = 30 leaves + 5 个等待父成员 = 35');
      suite.equal(cap.residentCapacity, 35, 'S04：residentCapacity = 40-3-2 = 35');
      suite.compare(cap.residentInUse, '<=', cap.residentCapacity, 'S04：不超 residentCapacity');
      suite.equal(cap.interactiveReserve, 2, 'S04：交互保留 2 个名额（根交互会话不被团队占满）');
      suite.equal(cap.memberLimit, 6, 'S04：6 个活跃成员时动态成员准入上限 = perMemberLeaves = 6');
      suite.equal(cap.perMemberLeaves, 6, 'S04：每成员叶子额度 perMemberLeaves=6（新 capacity 形状，等价断言）');
      suite.equal(native.fullRejections.length, 0, 'S04：原生 Activation 池零拒绝（40 个名额够用）');
      const perMember = new Map();
      for (const plan of started) perMember.set(plan.ownerMemberId, (perMember.get(plan.ownerMemberId) ?? 0) + 1);
      suite.equal(perMember.size, 5, 'S04：5 个成员都拿到了执行名额（公平轮转，无成员被饿死）');
      suite.assert([...perMember.values()].every((count) => count === 6), 'S04：每个成员恰好 6 个叶子（perMemberLeaves 生效）', Object.fromEntries(perMember));

      const constraints = scheduler.constraints.describe();
      suite.equal(constraints.residentCapacity, 35, 'S04：constraints 推导 residentCapacity=35');
      suite.equal(constraints.workerCapacity, 30, 'S04：constraints 推导 workerCapacity=30');
      suite.equal(constraints.fullExpansionExample, 35, 'S04：全展开示例 = 5×6+3+2 = 35');
      await workbench.dispose();
    }

    // ---------------------------------------------------------------- 场景 B
    {
      const workbench = await createWorkbench({
        clock: createFakeClock(),
        config: { capacity: { hostActivationLimit: 40, globalLeafLimit: 8, recoveryReserve: 3, interactiveReserve: 2, perMemberLeaves: 6 } },
      });
      const { service, scheduler, native } = workbench;
      const lead = leadAgent(workbench);
      await service.defineTeam(lead, { teamKey: 'team-b' });
      for (const name of ['m1', 'm2', 'm3', 'm4']) {
        await service.createMember(lead, { teamKey: 'team-b', name, description: `${name} 模块` });
      }
      const plan = [
        ...Array.from({ length: 20 }, (_, index) => ({ workId: `huge-${index + 1}`, owner: 'm1' })),
        { workId: 'small-1', owner: 'm2' },
        { workId: 'small-2', owner: 'm3' },
        { workId: 'small-3', owner: 'm4' },
      ];
      for (const entry of plan) {
        await submit(service, lead, {
          teamKey: 'team-b',
          workId: entry.workId,
          title: `交付 ${entry.workId}`,
          deliverable: `${entry.workId} 的完整实现`,
          ownerMemberId: entry.owner,
          outputs: [`src/${entry.workId}.ts`],
          acceptance: ['可集成'],
        });
      }
      await authorizeWorks(service, native, lead, 'team-b', ['m1', 'm2', 'm3', 'm4']);
      const report = await scheduler.tick();
      const byOwner = new Map();
      for (const item of report.started) byOwner.set(item.ownerMemberId, (byOwner.get(item.ownerMemberId) ?? 0) + 1);
      const m1Count = byOwner.get('m1') ?? 0;
      const othersCount = (byOwner.get('m2') ?? 0) + (byOwner.get('m3') ?? 0) + (byOwner.get('m4') ?? 0);
      suite.equal(report.started.length, 8, 'S04：单轮恰好填满 8 个槽位');
      suite.compare(m1Count, '<=', 6, 'S04：单一成员不超过 perMemberLeaves=6（不能垄断全部槽位）');
      suite.compare(m1Count, '<', 8, 'S04：单一成员没有占满 workerCapacity');
      suite.compare(othersCount, '>=', 2, 'S04：其他成员仍获得名额（公平轮转生效）');
      const cap = scheduler.capacity();
      suite.equal(cap.memberInUse === undefined, true, 'S04：capacity 使用 "<teamKey>/<memberId>" 作为成员键');
      suite.equal(cap.perMemberLeaves, 6, 'S04：成员公平额度 = perMemberLeaves（新 capacity 形状）');
      await workbench.dispose();
    }

    // ---------------------------------------------------------------- 场景 C
    {
      const workbench = await createWorkbench({
        clock: createFakeClock(),
        config: {
          capacity: { hostActivationLimit: 40, globalLeafLimit: 10, recoveryReserve: 3, interactiveReserve: 2, perMemberLeaves: 6, teamsMaxConcurrent: 3 },
          scheduler: { maxStartsPerTick: 10 },
        },
      });
      const { service, scheduler, native } = workbench;
      const lead = leadAgent(workbench);
      for (const teamKey of ['team-x', 'team-y']) {
        await service.defineTeam(lead, { teamKey });
        await service.createMember(lead, { teamKey, name: `${teamKey}-owner`, description: `${teamKey} 模块` });
      }
      for (const teamKey of ['team-x', 'team-y']) {
        for (let index = 1; index <= 10; index += 1) {
          await submit(service, lead, {
            teamKey,
            workId: `${teamKey}-w${index}`,
            title: `${teamKey} 交付 ${index}`,
            deliverable: `${teamKey} 模块 ${index} 完整实现`,
            ownerMemberId: `${teamKey}-owner`,
            outputs: [`src/${teamKey}/m${index}.ts`],
            acceptance: ['可集成'],
          });
        }
      }
      // 契约：每个团队按成员批量授权（scheduler 只消费 authorized intent）。
      await authorizeWorks(service, native, lead, 'team-x', ['team-x-owner']);
      await authorizeWorks(service, native, lead, 'team-y', ['team-y-owner']);
      const report = await scheduler.tick();
      suite.equal(report.started.length, 10, 'S10：两个团队同时运行时恰好填满 10 个槽位');
      const perTeam = new Map();
      for (const item of report.started) perTeam.set(item.teamKey, (perTeam.get(item.teamKey) ?? 0) + 1);
      suite.equal(perTeam.get('team-x') ?? 0, 5, 'S10：team-x 获得 5 个槽位');
      suite.equal(perTeam.get('team-y') ?? 0, 5, 'S10：team-y 获得 5 个槽位（跨团队配额公平，单一团队不垄断）');
      const cap = scheduler.capacity();
      suite.equal(cap.teams['team-x'].fairShare, 5, 'S10：团队公平额度 = floor(workerCapacity / 活跃团队数)');
      suite.equal(cap.teams['team-y'].fairShare, 5, 'S10：另一团队同样的公平额度');
      suite.compare(cap.residentInUse, '<=', cap.residentCapacity, 'S10：跨团队总额度仍统一受控');
      await workbench.dispose();
    }

    // ---------------------------------------------------------------- 场景 E
    {
      const workbench = await createWorkbench({
        clock: createFakeClock(),
        config: { capacity: { hostActivationLimit: 40, globalLeafLimit: 30, recoveryReserve: 3, interactiveReserve: 2, perMemberLeaves: 6 } },
      });
      const { service, scheduler, native } = workbench;
      const lead = leadAgent(workbench);
      await service.defineTeam(lead, { teamKey: 'team-l' });
      suite.equal(scheduler.capacity().memberLimit, 30, 'S04：只有 lead 时成员准入上限 = workerCapacity（不浪费空槽）');
      await service.createMember(lead, { teamKey: 'team-l', name: 'only', description: '唯一成员' });
      suite.equal(scheduler.capacity().memberLimit, 24, 'S04：2 个活跃成员时 limit = workerCapacity - perMemberLeaves = 24');
      for (const name of ['m2', 'm3', 'm4', 'm5']) {
        await service.createMember(lead, { teamKey: 'team-l', name, description: `${name} 模块` });
      }
      suite.equal(scheduler.capacity().memberLimit, 6, 'S04：6 个活跃成员时 limit 收缩到 perMemberLeaves = 6');
      suite.equal(scheduler.constraints.memberFairShare(), 6, 'S04：constraints.memberFairShare() 仍是最低保证额度');
      await workbench.dispose();
    }

    // ---------------------------------------------------------------- 场景 D
    {
      const workbench = await createWorkbench({
        clock: createFakeClock(),
        config: { capacity: { hostActivationLimit: 40, globalLeafLimit: 10, recoveryReserve: 3, interactiveReserve: 2, perMemberLeaves: 6 } },
      });
      const { service, scheduler, native } = workbench;
      const lead = leadAgent(workbench);
      for (const teamKey of ['proj-a', 'proj-b']) {
        await service.defineTeam(lead, { teamKey });
        await service.createMember(lead, { teamKey, name: `${teamKey}-owner`, description: `${teamKey} 模块` });
      }
      await submit(service, lead, {
        teamKey: 'proj-a',
        workId: 'a-writes-shared',
        title: 'A 项目写入 shared 包',
        deliverable: 'shared 包 A 侧完整实现',
        ownerMemberId: 'proj-a-owner',
        outputs: ['shared/pkg/index.ts'],
        acceptance: ['可集成'],
        writeScopes: ['shared/pkg'],
      });
      await submit(service, lead, {
        teamKey: 'proj-b',
        workId: 'b-writes-shared',
        title: 'B 项目也写入 shared 包',
        deliverable: 'shared 包 B 侧完整实现',
        ownerMemberId: 'proj-b-owner',
        outputs: ['shared/pkg/index.ts'],
        acceptance: ['可集成'],
        writeScopes: ['shared/pkg'],
      });

      // 契约：写入范围冲突测试也必须在授权后才进入调度（scheduler 只消费 authorized intent）。
      await authorizeWorks(service, native, lead, 'proj-a', ['proj-a-owner']);
      await authorizeWorks(service, native, lead, 'proj-b', ['proj-b-owner']);

      const tick1 = await scheduler.tick();
      suite.equal(tick1.started.length, 1, 'S10：重叠 writeScopes 的第二个工作项没有在同一轮一起启动');
      suite.assert(
        tick1.rejected.some((entry) => entry.code === 'WRITE_SCOPE_CONFLICT'),
        'S10：被挡住的项以 WRITE_SCOPE_CONFLICT 显式拒绝（不是静默丢弃）',
        tick1.rejected,
      );
      const held = service.writeScopeHolders();
      suite.assert(
        held.some((entry) => entry.workId === 'a-writes-shared' || entry.workId === 'b-writes-shared'),
        'S10：快照可以读出谁持有哪些写入范围（writeScopeHolders）',
        held,
      );

      const second = await scheduler.tick();
      suite.equal(
        second.started.length,
        0,
        'S10：写入范围重叠时不得并发派发（ARCHITECTURE §2.5 ready() 含“无写入冲突”）',
        { started: second.started.map((plan) => plan.workId), rejected: second.rejected },
      );
      suite.equal(service.works.get('b-writes-shared').state === 'cancelled', false, 'S10：被挡住的项保持在 ready/cancelled 之外的队列里（拒绝并保持 ready，不丢弃）');
      const queueState = service.works.get('b-writes-shared').state;
      suite.assert(
        ['ready', 'blocked', 'claimed', 'executing'].includes(queueState),
        'S10：被挡住的项没有进入 cancelled/terminal',
        queueState,
      );

      const firstPlan = tick1.started[0];
      const attempt = service.attempts.get(firstPlan.attemptId);
      await service.reportWork(
        { id: attempt.executorChildId },
        {
          attemptId: attempt.attemptId,
          leaseEpoch: attempt.leaseEpoch,
          outcome: 'produced',
          artifacts: [{ path: 'shared/pkg/index.ts', version: 1 }],
          evidence: [{ kind: 'verification', ok: true, command: 'node --test', ref: 'tests/shared' }],
          summary: 'done',
        },
      );
      const third = await scheduler.tick();
      suite.equal(third.started.length, 1, 'S10：前一个写入范围释放后，重叠项才被启动');
      const otherWorkId = firstPlan.workId === 'a-writes-shared' ? 'b-writes-shared' : 'a-writes-shared';
      suite.equal(third.started[0]?.workId, otherWorkId, 'S10：启动的正是另一个项目的重叠项');
      suite.note('边界（ARCHITECTURE §2.5）：仅保证本插件调度出的执行者不并发写同一范围；不是 OS 级文件锁，无法阻止仍在运行的旧进程直接用 shell 写文件。');
      await workbench.dispose();
    }

    // ---------------------------------------------------------------- 场景 F
    // S10 补强：两个 team 各 1 member 各 1 work —— 只画一个团队的容量视图不算数。
    {
      const workbench = await createWorkbench({
        clock: createFakeClock(),
        config: {
          capacity: { hostActivationLimit: 40, globalLeafLimit: 10, recoveryReserve: 3, interactiveReserve: 2, perMemberLeaves: 6, teamsMaxConcurrent: 3 },
          scheduler: { maxStartsPerTick: 10 },
        },
      });
      const { service, scheduler, native } = workbench;
      const lead = leadAgent(workbench);
      for (const teamKey of ['alpha', 'beta']) {
        await service.defineTeam(lead, { teamKey });
        await service.createMember(lead, { teamKey, name: `${teamKey}-owner`, description: `${teamKey} 模块完整交付` });
        await submit(service, lead, {
          teamKey,
          workId: `${teamKey}-w1`,
          title: `${teamKey} 的完整交付`,
          deliverable: `${teamKey} 模块的完整实现`,
          ownerMemberId: `${teamKey}-owner`,
          outputs: [`src/${teamKey}/index.ts`],
          acceptance: ['可集成'],
        });
      }

      // 契约：每个团队按成员批量授权（scheduler 只消费 authorized intent）。
      await authorizeWorks(service, native, lead, 'alpha', ['alpha-owner']);
      await authorizeWorks(service, native, lead, 'beta', ['beta-owner']);

      const beforeTick = scheduler.capacity();
      suite.assert(
        Object.keys(beforeTick.teams).sort().join(',') === 'alpha,beta',
        'S10：启动前 capacity().teams 就同时包含两个团队 key',
        Object.keys(beforeTick.teams),
      );
      suite.equal(beforeTick.teams.alpha.fairShare, beforeTick.teams.beta.fairShare, 'S10：两个团队的 fairShare 相等');
      suite.equal(beforeTick.teams.alpha.inUse, 0, 'S10：启动前 alpha 占用为 0');
      suite.equal(beforeTick.teams.beta.inUse, 0, 'S10：启动前 beta 占用为 0');

      const tick = await scheduler.tick();
      suite.equal(tick.started.length, 2, 'S10：两个团队各自的工作项都被启动');
      const startedTeams = tick.started.map((plan) => plan.teamKey).sort();
      suite.deepEqual(startedTeams, ['alpha', 'beta'], 'S10：一个团队的 worker 没有把另一个团队挤成 0');

      const afterTick = scheduler.capacity();
      suite.assert(
        Object.keys(afterTick.teams).sort().join(',') === 'alpha,beta',
        'S10：启动后 capacity().teams 仍然同时包含两个团队 key',
        Object.keys(afterTick.teams),
      );
      suite.compare(afterTick.teams.alpha.inUse, '>=', 1, 'S10：alpha 至少占用 1 个 worker');
      suite.compare(afterTick.teams.beta.inUse, '>=', 1, 'S10：beta 至少占用 1 个 worker');
      suite.equal(afterTick.teams.alpha.fairShare, beforeTick.teams.alpha.fairShare, 'S10：fairShare 不随占用变化');
      suite.equal(afterTick.teams.beta.fairShare, beforeTick.teams.beta.fairShare, 'S10：另一团队 fairShare 同样稳定');
      suite.compare(afterTick.activeLeaves, '<=', afterTick.workerCapacity, 'S10：跨团队总额度仍受 workerCapacity 约束');
      suite.compare(afterTick.residentInUse, '<=', afterTick.residentCapacity, 'S10：跨团队 resident 总额度仍受约束');
      await workbench.dispose();
    }
  });
}

if (isMain(import.meta.url)) await main(run, meta);
