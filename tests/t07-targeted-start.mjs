/**
 * T07 定向启动回归：只启动目标 work；被拒零副作用；幂等复用；并发只创建一个 attempt
 *
 * 依据：`docs/ARCHITECTURE.md`（含 §10 可测接缝）。实现行为若与契约不一致，
 * **报给 lead 由 host-autonomy 改实现**，不在这里改期望；无法在本机确定性证明的标"未执行"。
 */
import { createFakeClock } from './helpers/fake-clock.mjs';
import { runSuite, isMain, main } from './helpers/suite.mjs';
import { createWorkbench, leadAgent } from './helpers/harness.mjs';

export const meta = {
  id: 't07-targeted-start',
  title: 'T07 定向启动回归：只启动目标 work；被拒零副作用；幂等复用；并发只创建一个 attempt',
  acceptance: ["T07"],
  requires: ["service","tools","storage"],
};

const snapshotWork = (wb) => [...wb.service.works.values()].map((w) => ({ workId: w.workId, rev: w.rev, state: w.state, attempts: w.attemptIds?.length ?? 0 }));
const snapshotStats = (wb) => JSON.parse(JSON.stringify(wb.service.stats ?? {}));

/** 建 1 lead + 1 member + 1 个已授权可启动的 work（走契约路径）。返回 { ok, ... } 或 { ok:false, step, raw }。 */
async function scaffold(wb, { teamKey = 'team-a', memberName = 'alpha' } = {}) {
  const { service, native } = wb;
  const lead = leadAgent(wb);
  await service.defineTeam(lead, { teamKey, goal: '自治验收' });
  const created = await service.createMember(lead, { teamKey, name: memberName, description: '确定性验收用的成员' });
  const memberSessionId = created.sessionId ?? created.member?.sessionId;
  // 铁律（Lead 从 fake-adapter:113-119 读出）：
  //   1) caller 必须是**裸 agent 对象**，且 `agents.get(id) === agent`（同一引用）；
  //   2) `service.actor(x)` 是**内部解析器**，其返回值没有 `.id`，绝不能当 caller 回传。
  //   3) `registerMembership(第一个参数)` 是 **sessionId 字符串**；name 就是 actor 的 memberId。
  const memberAgent = native.agentFor(memberSessionId) ?? native.registerAgent(memberSessionId, { name: memberName });
  native.registerMembership(memberSessionId, { id: teamKey, role: 'teammate', name: memberName, root: lead });
  const memberActor = memberAgent; // 裸 agent 对象（角色读取时才用 service.actor）
  const mission = await service.missionAssign(lead, { teamKey, memberId: memberName, title: '模块', goal: '完成模块交付' });
  if (mission.ok !== true) return { ok: false, step: 'missionAssign', raw: mission };
  const missionId = mission.mission?.missionId ?? mission.missionId;
  const plan = await service.planSubmit(memberActor, {
    teamKey,
    missionId,
    expectedPlanRevision: 0,
    deliverables: [
      { workId: 'w-target', title: '目标交付', deliverable: '目标交付的完整实现', kind: 'module', outputs: ['src/target/index.js'], acceptance: ['可集成'], writeScopes: ['src/target'], execution: 'delegate' },
      { workId: 'w-other', title: '无关交付', deliverable: '无关交付的完整实现', kind: 'module', outputs: ['src/other/index.js'], acceptance: ['可集成'], writeScopes: ['src/other'], execution: 'delegate' },
    ],
  });
  if (plan.ok !== true) return { ok: false, step: 'planSubmit', raw: plan };
  const planRevision = plan.planRevision ?? plan.plan?.planRevision;
  const auth = await service.dispatchAuthorize(memberActor, { teamKey, planRevision, workIds: ['w-target'] });
  if (auth.ok !== true) return { ok: false, step: 'dispatchAuthorize', raw: auth };
  return { ok: true, lead, memberActor, memberSessionId, missionId, planRevision };
}

export async function run() {
  const wb = await createWorkbench({ clock: createFakeClock(), config: { capacity: { globalLeafLimit: 4 } } });
  if (wb.mode !== 'real') {
    return runSuite({ ...meta, pending: true, pendingReason: '真实 Host 模块不可加载' }, null);
  }
  return runSuite(meta, async (suite) => {
    const seams = ['subagentStart', 'missionAssign', 'planSubmit', 'dispatchAuthorize', 'workVerify', 'askOwner', 'memberInbox', 'planCancel'];
    suite.assert(seams.every((name) => typeof wb.service[name] === 'function'), '契约 §10 具名接缝全部可从进程内调用', { missing: seams.filter((n) => typeof wb.service[n] !== 'function') });
    const s = await scaffold(wb);
    suite.assert(s.ok === true, '契约路径可建：defineTeam → createMember → missionAssign → planSubmit → dispatchAuthorize', s.ok ? undefined : s);
    if (!s.ok) return;
    // ---- T07：定向启动（契约 §10 硬要求） --------------------------------
    {
      const before = snapshotWork(wb);
      const statsBefore = snapshotStats(wb);
      const rejected = await wb.service.subagentStart(s.memberActor, { workId: 'w-other' });
      const after = snapshotWork(wb);
      suite.assert(rejected.ok === false, 'T07：没有授权意图的 work 不得被定向启动（拒绝）', rejected);
      suite.deepEqual(after, before, 'T07：被拒时所有 work 的 state/rev/attempts 逐条不变（零副作用）');
      suite.deepEqual(snapshotStats(wb), statsBefore, 'T07：被拒时容量/失败计数不变');
    }
    {
      const before = snapshotWork(wb);
      const started = await wb.service.subagentStart(s.memberActor, { workId: 'w-target', brief: '定向 brief 证据' });
      const after = snapshotWork(wb);
      suite.assert(started.ok === true, 'T07：已授权且 ready 的目标可以被定向启动', started);
      const changed = after.filter((w, i) => JSON.stringify(w) !== JSON.stringify(before[i])).map((w) => w.workId);
      suite.deepEqual(changed.sort(), ['w-target'], 'T07：只有目标 work 发生变化（others 的 rev/attempts 不变）');
      suite.assert(typeof started.childSessionId === 'string' && started.childSessionId.length > 0, 'T07：返回真实 childSessionId', started);
      suite.assert(started.brief !== null && String(started.brief).includes('定向 brief 证据'), 'T07：brief 真的到达执行者（不被丢弃）', started.brief);
      const again = await wb.service.subagentStart(s.memberActor, { workId: 'w-target' });
      suite.assert(again.ok === true && again.reused === true, 'T07：重复调用返回 reused:true（不双重创建）', again);
      suite.equal(again.attemptId, started.attemptId, 'T07：复用同一个 attemptId');
      const attemptsForTarget = [...wb.service.attempts.values()].filter((a) => a.workId === 'w-target');
      suite.equal(attemptsForTarget.length, 1, 'T07：目标 work 只有一个 attempt');
    }
    {
      const beforeCount = [...wb.service.attempts.values()].filter((a) => a.workId === 'w-target').length;
      const [a, b] = await Promise.all([
        wb.service.subagentStart(s.memberActor, { workId: 'w-target' }),
        wb.service.subagentStart(s.memberActor, { workId: 'w-target' }),
      ]);
      const afterCount = [...wb.service.attempts.values()].filter((a2) => a2.workId === 'w-target').length;
      suite.equal(afterCount, beforeCount, 'T07：并发两次定向启动不额外创建 attempt');
      suite.assert(a.ok === true && b.ok === true, 'T07：并发调用都返回成功（其中一个 reused）', { a, b });
    }

  });
}

if (isMain(import.meta.url)) await main(run, meta);
