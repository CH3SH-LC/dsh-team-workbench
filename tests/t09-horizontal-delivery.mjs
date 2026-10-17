/**
 * T09 横向交付：mission 不被调度器消费；阶段接力被拒或被标记图级违规
 *
 * 依据：`docs/ARCHITECTURE.md`（含 §10 可测接缝）。实现行为若与契约不一致，
 * **报给 lead 由 host-autonomy 改实现**，不在这里改期望；无法在本机确定性证明的标"未执行"。
 */
import { createFakeClock } from './helpers/fake-clock.mjs';
import { runSuite, isMain, main } from './helpers/suite.mjs';
import { createWorkbench, leadAgent } from './helpers/harness.mjs';

export const meta = {
  id: 't09-horizontal-delivery',
  title: 'T09 横向交付：mission 不被调度器消费；阶段接力被拒或被标记图级违规',
  acceptance: ["T09"],
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
    // ---- T09：mission 不被调度器消费 + 阶段接力被拒 ------------------------
    {
      const missionWorks = [...wb.service.works.values()].filter((w) => w.missionId === s.missionId && ['ready', 'executing'].includes(String(w.state)) && w.planRevision === undefined);
      suite.deepEqual(missionWorks.map((w) => w.workId), [], 'T09：未分解的 mission 不得被调度器直接消费（不产生可调度项）');
      const schedulable = [...wb.service.works.values()].filter((w) => ['ready', 'executing'].includes(String(w.state)));
      const unauthorized = schedulable.filter((w) => ![...wb.service.dispatchIntents?.values?.() ?? []].some((i) => i.workId === w.workId && i.state === 'authorized'));
      suite.deepEqual(unauthorized.map((w) => w.workId), [], 'T09：所有可调度/执行中的 work 都必须有 authorized 派发意图');
      const relay = await wb.service.planSubmit(s.memberActor, {
        teamKey: 'team-a',
        missionId: s.missionId,
        expectedPlanRevision: s.planRevision,
        deliverables: [
          { workId: 'relay-bg', title: '背景调查', deliverable: '同一个交付物', kind: 'module', outputs: ['a'], acceptance: ['x'], execution: 'delegate' },
          { workId: 'relay-design', title: '设计', deliverable: '同一个交付物', kind: 'module', outputs: ['b'], acceptance: ['x'], dependencies: ['relay-bg'], execution: 'delegate' },
          { workId: 'relay-check', title: '检查', deliverable: '同一个交付物', kind: 'module', outputs: ['c'], acceptance: ['x'], dependencies: ['relay-design'], execution: 'delegate' },
        ],
      });
      const flagged = relay.ok === false || (Array.isArray(relay.graphViolations) && relay.graphViolations.length > 0);
      suite.assert(flagged, 'T09：阶段接力（背景→设计→检查，同一交付物）被拒或被标记图级违规', relay);
    }

  });
}

if (isMain(import.meta.url)) await main(run, meta);
