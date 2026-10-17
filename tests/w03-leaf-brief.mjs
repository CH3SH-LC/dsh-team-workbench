/**
 * W03 — 大材料交 fresh 子智能体：**输入侧**保证（leaf 任务包内容）。
 *
 * 断言 Host 真正发给原生 `startContinuable` 的 brief 同时包含：
 *   目标 / 真实产物位置 / 验收条件 / 写入范围 / 上下文策略 / 依赖版本，
 *   以及「调查、实现、自检、修复都在本任务内完成」与
 *   「idle、超时、非空文件都不是完成」这两条约束。
 *
 * 说明：brief 通过拦截 fake native 的 `subagents.startContinuable(spec)` 取得
 * （`spec.request.prompt[0].text`），也就是**运行时实际发出去的内容**，
 * 不是直接 import 一个内部函数。
 *
 * **输出侧**（parent 是否真的只收到摘要 + 证据引用）只能用真实模型验证，
 * 不在本用例范围内、也不得用模拟冒充；见 real-acceptance.md 的 W03 行。
 */
import { createFakeClock } from './helpers/fake-clock.mjs';
import { runSuite, isMain, main } from './helpers/suite.mjs';
import { createWorkbench, leadAgent } from './helpers/harness.mjs';

export const meta = {
  id: 'w03-leaf-brief',
  title: 'W03：leaf 任务包（输入侧）——目标/产物/验收/范围/上下文/依赖版本/约束',
  acceptance: ['W03'],
  requires: ['service', 'scheduler', 'storage', 'policy'],
};

export async function run() {
  return runSuite(meta, async (suite) => {
    const workbench = await createWorkbench({
      clock: createFakeClock(),
      config: { capacity: { globalLeafLimit: 4 }, scheduler: { maxStartsPerTick: 4 } },
    });
    if (workbench.mode !== 'real') {
      suite.fail('真实 Host 模块可用', { mode: workbench.mode, pendingReason: workbench.pendingReason });
      return;
    }
    const { service, scheduler, native } = workbench;
    const lead = leadAgent(workbench);

    // 拦截原生启动，记录 Host 实际发出去的 spec。
    const captured = [];
    const originalStart = native.startContinuable.bind(native);
    native.startContinuable = (spec) => {
      captured.push(spec);
      return originalStart(spec);
    };

    // §11/§12 新前提：work 由 **member 自己** planSubmit 创建，再由成员自己 dispatchAuthorize；
    // leader 只 missionAssign。强度不变（仍断言 leaf 启动 1 次、brief 十类要素原样）。
    await service.defineTeam(lead, { teamKey: 'team-a', goal: 'leaf 任务包验收' });
    const createdCombat = await service.createMember(lead, { teamKey: 'team-a', name: 'combat', description: '战斗系统完整交付' });
    const combatSessionId = createdCombat.sessionId ?? createdCombat.member?.sessionId;
    const combatAgent = native.agentFor(combatSessionId) ?? native.registerAgent(combatSessionId, { name: 'combat' });
    native.registerMembership(combatSessionId, { id: 'team-a', role: 'teammate', name: 'combat', root: lead });
    const mission = await service.missionAssign(lead, { teamKey: 'team-a', memberId: 'combat', title: '战斗数值表', goal: '战斗数值表及其实现完整交付' });
    if (!mission.ok) suite.fail('missionAssign combat', mission);
    const planned = await service.planSubmit(combatAgent, {
      teamKey: 'team-a',
      missionId: mission.mission?.missionId ?? mission.missionId,
      expectedPlanRevision: 0,
      deliverables: [{
        workId: 'brief-1',
        title: '战斗数值表完整交付',
        deliverable: '战斗数值表及其实现，可直接接入战斗系统',
        kind: 'module',
        inputs: ['docs/combat/design.md', 'artifacts/legacy/table.csv'],
        outputs: ['src/combat/numbers.ts', 'docs/combat/numbers.md'],
        acceptance: ['数值表与设计一致', '接入战斗系统后无占位实现'],
        writeScopes: ['src/combat', 'docs/combat'],
        execution: 'delegate',
        artifactDependencies: [{ artifact: 'inventory-api', version: 2, requires: 'published-interface' }],
      }],
    });
    suite.equal(planned.ok, true, '工作项经成员 planSubmit 提交成功');
    const planRevision = planned.planRevision ?? planned.plan?.planRevision;
    const authorized = await service.dispatchAuthorize(combatAgent, { teamKey: 'team-a', planRevision, workIds: ['brief-1'] });
    suite.equal(authorized.ok, true, '成员 dispatchAuthorize 成功');

    const tick = await scheduler.tick();
    suite.equal(tick.started.length, 1, 'leaf 成功启动');
    suite.equal(captured.length, 1, '捕获到一次原生 startContinuable');

    const spec = captured[0];
    const brief = spec?.request?.prompt?.[0]?.text ?? '';
    suite.equal(typeof brief, 'string', 'brief 是文本');
    suite.compare(brief.length, '>', 200, 'brief 有实质内容（不是空壳）');

    // ---- 目标 / 背景 -------------------------------------------------------
    suite.includes(brief, '战斗数值表完整交付', 'brief 含工作项目标（title）');
    suite.includes(brief, '战斗数值表及其实现，可直接接入战斗系统', 'brief 含交付物定义（deliverable）');
    suite.includes(brief, '独立完成', 'brief 明确要求"独立完成这一份交付"');

    // ---- 真实产物位置 ------------------------------------------------------
    suite.includes(brief, 'src/combat/numbers.ts', 'brief 含第一个真实产物位置');
    suite.includes(brief, 'docs/combat/numbers.md', 'brief 含第二个真实产物位置');
    suite.includes(brief, '必须真实产出到这些位置', 'brief 说明产物必须真实落盘');

    // ---- 输入证据 ----------------------------------------------------------
    suite.includes(brief, 'docs/combat/design.md', 'brief 含输入证据路径 1');
    suite.includes(brief, 'artifacts/legacy/table.csv', 'brief 含输入证据路径 2');

    // ---- 验收条件 ----------------------------------------------------------
    suite.includes(brief, '数值表与设计一致', 'brief 含验收条件 1');
    suite.includes(brief, '接入战斗系统后无占位实现', 'brief 含验收条件 2');

    // ---- 写入范围 ----------------------------------------------------------
    suite.includes(brief, 'src/combat', 'brief 含写入范围 1');
    suite.includes(brief, 'docs/combat', 'brief 含写入范围 2');

    // ---- 上下文策略（fresh） ----------------------------------------------
    suite.equal(service.works.get('brief-1').contextPolicy, 'fresh-with-evidence-references', '工作项上下文策略默认 fresh-with-evidence-references');
    suite.includes(brief, 'fresh-with-evidence-references', 'brief 明确写出上下文策略（fresh，不 fork parent 长上下文）');

    // ---- 依赖版本 + requires ----------------------------------------------
    suite.includes(brief, 'inventory-api@v2(published-interface)', 'brief 含依赖的 artifact@version(requires)');

    // ---- 约束：本任务内闭环，不接力 ----------------------------------------
    suite.includes(brief, '调查、实现、自检、修复都在这一份任务内部完成', 'brief 要求调查→实现→自检→修复在本任务内闭环');
    suite.includes(brief, '把“调查结果交回再等别人实现”', 'brief 明确禁止"只调查再交给别人"的接力');
    suite.includes(brief, '不要用占位实现或 TODO 充当完成', 'brief 禁止占位实现冒充完成');

    // ---- 约束：伪成功信号不算完成 ------------------------------------------
    suite.includes(brief, 'idle', 'brief 点名 idle 不算完成');
    suite.includes(brief, '超时', 'brief 点名超时不算完成');
    suite.includes(brief, '非空文件都不是完成', 'brief 点名非空文件不算完成');
    suite.includes(brief, '可核查的证据', 'brief 要求回执带可核查证据');

    // ---- 权限边界 ----------------------------------------------------------
    suite.includes(brief, '没有创建 member 或提交他人工作项的权限', 'brief 声明 leaf 的权限边界');

    // ---- 只发这一份任务包（不 fork 全部聊天） ------------------------------
    suite.equal(spec.request.prompt.length, 1, '只发一个 prompt 块（最小任务包）');
    suite.equal(spec.request.prompt[0].type, 'text', 'prompt 块是纯文本');
    suite.equal(spec.request.parent?.id, service.members.get('team-a/combat').sessionId, 'leaf 的 parent 是 owner member 的真实 live Agent');
    suite.equal(spec.childId !== undefined && spec.childId === service.attempts.get(tick.started[0].attemptId).executorChildId, true, '原生收到的 childId 与预分配一致');

    suite.note(`brief 长度 ${brief.length} 字符；包含 目标/产物位置/输入证据/验收/写入范围/上下文策略/依赖版本/闭环约束/伪成功约束/权限边界 十类要素。`);
    suite.note('输出侧（parent 实际只收到摘要+证据引用）只能真实模型验证，见 real-acceptance.md W03。');

    native.startContinuable = originalStart;
    await workbench.dispose();
  });
}

if (isMain(import.meta.url)) await main(run, meta);
