/**
 * W09 — Host 侧「可绑定目标」三态闸（`assertBindableTarget`）。
 *
 * 判定规格（`src/host/service.js`）：
 *   1. 顶层会话目标 → 允许；
 *   2. sidecar `members` 命中 → 允许；
 *   3. 有 `parentSessionId` 且父 Agent 存活 → 查**原生 roster**：命中 → 允许；
 *   4. 无法核实（缺父地址 / 父不存活 / roster 读不到）→ **fail-open 放行** +
 *      `capacity().guards.unverifiedSubagentTargets` +1 + `service:subagent-target-unverified` 诊断；
 *   5. 父存活且 roster **明确不含** → `LEAF_NOT_BINDABLE` + `capacity().guards.leafTargetsRejected` +1。
 *
 * 第 4 条是**刻意设计的可见残余缺口**：断言它"可见且被计数"，**不**断言它被拦截
 * （客户端 `isTargetBindable` 才做 fail-closed 兜底）。
 *
 * 另：原生契约 `agentTeams.listMembers(agent): TeamMemberView[]` 是**同步**方法，
 * 但 adapter 走 `await`，因此 fake 同时覆盖「返回数组」与「返回 Promise」两种形态。
 */
import { createFakeClock } from './helpers/fake-clock.mjs';
import { runSuite, isMain, main } from './helpers/suite.mjs';
import { createWorkbench, leadAgent } from './helpers/harness.mjs';

export const meta = {
  id: 'w09-bindable-target-guards',
  title: 'Host 侧可绑定目标闸：成员允许 / roster 明确不含则拒 / 无法核实则 fail-open 且计数可见',
  acceptance: ['W06', 'S10'],
  requires: ['service', 'adapter', 'storage'],
};

const guards = (service) => service.capacity().guards ?? {};
const diagnosticCodes = (service) => (service.diagnostics.list() ?? []).map((entry) => String(entry.code));
const unverifiedEntries = (service) =>
  (service.diagnostics.list() ?? []).filter((entry) => String(entry.code) === 'service:subagent-target-unverified');

export async function run() {
  return runSuite(meta, async (suite) => {
    const workbench = await createWorkbench({ clock: createFakeClock(), config: { capacity: { globalLeafLimit: 4 } } });
    if (workbench.mode !== 'real') {
      suite.fail('真实 Host 模块可用', { mode: workbench.mode, pendingReason: workbench.pendingReason });
      return;
    }
    const { service, native, ctx } = workbench;
    const lead = leadAgent(workbench);

    await service.defineTeam(lead, { teamKey: 'team-a', goal: '可绑定目标闸' });
    const created = await service.createMember(lead, { teamKey: 'team-a', name: 'combat', description: '战斗系统完整交付' });
    const memberSessionId = created.member.sessionId;

    const teamId = native.membership(lead).id;
    // 只在**原生 roster** 里、不在 sidecar members 里的成员会话（模拟官方 spawn_teammate 建的成员）。
    const nativeOnlySession = 'session-native-only-member';
    native.registerAgent(nativeOnlySession, { name: 'native-only' });
    native.registerMembership(nativeOnlySession, { root: lead, id: teamId, role: 'teammate', name: 'native-only' });

    suite.equal(guards(service).leafTargetsRejected, 0, '初始 leafTargetsRejected = 0');
    suite.equal(guards(service).unverifiedSubagentTargets, 0, '初始 unverifiedSubagentTargets = 0');

    // ---- 1. 顶层会话目标：直接允许，不计任何 guard -------------------------
    {
      const result = await service.assertBindableTarget({ kind: 'session', sessionId: 'session-lead' });
      suite.equal(result.ok, true, '顶层会话目标允许绑定');
      suite.equal(guards(service).leafTargetsRejected, 0, '顶层目标不增加 leafTargetsRejected');
      suite.equal(guards(service).unverifiedSubagentTargets, 0, '顶层目标不增加 unverifiedSubagentTargets');
      suite.equal((await service.assertBindableTarget(null)).ok, true, '空目标允许（无 pane 绑定）');
    }

    // ---- 2. sidecar member 命中：允许，不计 guard --------------------------
    {
      const result = await service.assertBindableTarget({
        parentSessionId: memberSessionId,
        childSessionId: memberSessionId,
        mode: 'continuable',
      });
      suite.equal(result.ok, true, 'sidecar members 命中的会话允许绑定');
      suite.equal(guards(service).leafTargetsRejected, 0, 'sidecar 命中不增加 leafTargetsRejected');
      suite.equal(guards(service).unverifiedSubagentTargets, 0, 'sidecar 命中不增加 unverifiedSubagentTargets');
    }

    // ---- 3. 原生 roster 命中（不在 sidecar）：允许 -------------------------
    {
      const before = guards(service);
      const result = await service.assertBindableTarget({
        parentSessionId: 'session-lead',
        childSessionId: nativeOnlySession,
        mode: 'continuable',
      });
      suite.equal(result.ok, true, '原生 roster 命中的成员会话允许绑定（不误伤官方 spawn_teammate 成员）');
      suite.equal(guards(service).leafTargetsRejected, before.leafTargetsRejected, 'roster 命中不增加 leafTargetsRejected');
      suite.equal(guards(service).unverifiedSubagentTargets, before.unverifiedSubagentTargets, 'roster 命中不增加 unverifiedSubagentTargets');
    }

    // ---- 3b. roster 以 Promise 形态返回：结论一致（adapter 的 await 兼容） ---
    {
      const realAgentTeams = ctx.get('agentTeams');
      const realListMembers = realAgentTeams.listMembers;
      ctx.set('agentTeams', {
        ...realAgentTeams,
        listMembers: async (agent) => realListMembers(agent),
      });
      const result = await service.assertBindableTarget({
        parentSessionId: 'session-lead',
        childSessionId: nativeOnlySession,
        mode: 'continuable',
      });
      suite.equal(result.ok, true, 'roster 返回 Promise 时同样允许（await 兼容）');
      ctx.set('agentTeams', realAgentTeams);
    }

    // ---- 4. 父存活 + roster 明确不含 → LEAF_NOT_BINDABLE + 计数 ------------
    {
      const before = guards(service);
      const result = await service.assertBindableTarget({
        parentSessionId: 'session-lead',
        childSessionId: 'session-ghost-leaf',
        mode: 'continuable',
      });
      suite.equal(result.ok, false, '父存活且 roster 明确不含 → 拒绝');
      suite.equal(result.code, 'LEAF_NOT_BINDABLE', '拒绝码为 LEAF_NOT_BINDABLE');
      suite.includes(String(result.message ?? ''), 'roster', '拒绝信息说明是 roster 不含');
      suite.equal(
        guards(service).leafTargetsRejected,
        before.leafTargetsRejected + 1,
        'capacity().guards.leafTargetsRejected +1',
      );
      suite.equal(
        guards(service).unverifiedSubagentTargets,
        before.unverifiedSubagentTargets,
        '明确拒绝不计入 unverified（它是已核实的结论）',
      );
    }

    // ---- 5. 缺父地址 / 父不存活 / roster 读不到 → fail-open 且可见 ----------
    {
      const before = guards(service);
      const missingParent = await service.assertBindableTarget({ childSessionId: 'session-orphan', mode: 'continuable' });
      suite.equal(missingParent.ok, true, '缺 parentSessionId → fail-open 放行（不误伤）');

      const deadParent = await service.assertBindableTarget({
        parentSessionId: 'session-not-live',
        childSessionId: 'session-child-of-dead',
        mode: 'continuable',
      });
      suite.equal(deadParent.ok, true, '父 Agent 不存活 → fail-open 放行');

      const realAgentTeams = ctx.get('agentTeams');
      ctx.set('agentTeams', {
        ...realAgentTeams,
        listMembers: async () => {
          const error = new Error('roster 读不到');
          error.code = 'TEAM_NOT_MEMBER';
          throw error;
        },
      });
      const noRoster = await service.assertBindableTarget({
        parentSessionId: 'session-lead',
        childSessionId: 'session-child-unknown',
        mode: 'continuable',
      });
      ctx.set('agentTeams', realAgentTeams);
      suite.equal(noRoster.ok, true, 'roster 读不到 → fail-open 放行');

      suite.equal(
        guards(service).unverifiedSubagentTargets,
        before.unverifiedSubagentTargets + 3,
        '三次不可核实都计入 capacity().guards.unverifiedSubagentTargets',
      );
      suite.equal(
        guards(service).leafTargetsRejected,
        before.leafTargetsRejected,
        'fail-open 不计入 leafTargetsRejected',
      );

      const entries = unverifiedEntries(service).slice(-3);
      suite.equal(entries.length, 3, '每次不可核实都留下 service:subagent-target-unverified 诊断');
      const reasons = entries.map((entry) => entry.detail?.reason);
      suite.deepEqual(
        reasons.slice().sort(),
        ['PARENT_ADDRESS_MISSING', 'PARENT_AGENT_NOT_LIVE', 'ROSTER_UNAVAILABLE'],
        '三种不可核实原因分别被记录（缺口可见、被分类）',
      );
      suite.assert(
        entries.every((entry) => entry.detail?.parentSessionId !== undefined),
        '诊断里带 parentSessionId（可追溯）',
        entries.map((entry) => entry.detail),
      );
      suite.includes(
        String(entries[0]?.message ?? ''),
        'fail-open',
        '诊断明说 Host 侧是 fail-open、由客户端兜底',
      );
    }

    // ---- 6. 整批布局也不能成为绕过入口（setLayout 过滤 leaf 目标） ----------
    {
      const before = guards(service);
      const result = await service.setLayout(2, {
        panes: [
          { paneId: 'pane-1', target: { kind: 'session', sessionId: 'session-lead' }, role: 'lead', label: 'lead' },
          { paneId: 'pane-2', target: { parentSessionId: 'session-lead', childSessionId: 'session-ghost-leaf', mode: 'continuable' }, role: 'subagent', label: 'leaf' },
        ],
        activePaneId: 'pane-1',
      });
      suite.equal(result.ok, true, 'setLayout 成功');
      const panes = service.layout().panes;
      suite.equal(panes.find((pane) => pane.paneId === 'pane-1')?.target?.sessionId, 'session-lead', '合法 pane 保留绑定');
      suite.equal(panes.find((pane) => pane.paneId === 'pane-2')?.target, null, '批量布局里的 leaf 目标被清空（不能绕过闸）');
      suite.equal(
        guards(service).leafTargetsRejected,
        before.leafTargetsRejected + 1,
        '批量布局里的 leaf 目标同样计入 leafTargetsRejected',
      );
      const codes = diagnosticCodes(service);
      suite.assert(
        codes.includes('service:setLayout:leaf-target-stripped'),
        '留下 service:setLayout:leaf-target-stripped 诊断',
        codes.slice(-4),
      );
    }

    suite.note(
      `最终 guards=${JSON.stringify(guards(service))}；unverified 诊断 ${unverifiedEntries(service).length} 条（fail-open 残余缺口是刻意设计且公开可见）。`,
    );
    await workbench.dispose();
  });
}

if (isMain(import.meta.url)) await main(run, meta);
