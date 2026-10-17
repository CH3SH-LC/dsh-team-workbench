/**
 * T12 边界：跨团队拒绝；leaf 不能建成员；不能伪造 owner 认可；不得旁路受管队列
 *
 * 依据：`docs/ARCHITECTURE.md`（含 §10 可测接缝）。实现行为若与契约不一致，
 * **报给 lead 由 host-autonomy 改实现**，不在这里改期望；无法在本机确定性证明的标"未执行"。
 */
import { createFakeClock } from './helpers/fake-clock.mjs';
import { runSuite, isMain, main } from './helpers/suite.mjs';
import { createWorkbench, leadAgent } from './helpers/harness.mjs';

export const meta = {
  id: 't12-boundaries',
  title: 'T12 边界：跨团队拒绝；leaf 不能建成员；不能伪造 owner 认可；不得旁路受管队列',
  acceptance: ["T12"],
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
    // ---- T12：边界与权限 --------------------------------------------------
    {
      await wb.service.defineTeam(s.memberActor, { teamKey: 'team-b', goal: '异队' });
      const crossTeam = await wb.service.planSubmit(s.memberActor, { teamKey: 'team-a', missionId: s.missionId, expectedPlanRevision: s.planRevision, deliverables: [] });
      suite.assert(crossTeam.ok === false, 'T12：member 不能跨团队提交/修改他人模块的计划（拒绝）', crossTeam);
      const leafActor = { id: 'session-leaf-actor', sessionId: 'session-leaf-actor', origin: 'subagent' };
      const leafCreate = await wb.service.createMember(leafActor, { teamKey: 'team-a', name: 'rogue', description: '越权成员' });
      suite.assert(leafCreate.ok === false, 'T12：leaf/子会话不能创建同级成员（拒绝）', leafCreate);
      const forged = await wb.service.workVerify(s.memberActor, { workId: 'w-target', outcome: 'accepted', note: '伪造认可' });
      const notForged = forged.ok === false || forged.work?.verifiedBy === s.memberSessionId || forged.verifiedBy === s.memberSessionId;
      suite.assert(notForged, 'T12：不能伪造 owner 认可（非 owner 验收被拒，或 verifiedBy 必须是真实 actor）', forged);
      const bypass = await wb.service.subagentStart(s.memberActor, { workId: 'w-other' });
      suite.assert(bypass.ok === false, 'T12：不得用定向入口旁路受管队列（未授权 work 启动被拒）', bypass);
    }

  });
}

if (isMain(import.meta.url)) await main(run, meta);
