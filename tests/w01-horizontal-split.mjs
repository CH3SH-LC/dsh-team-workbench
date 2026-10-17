/**
 * W01 — 只做横向拆分。
 *
 * 接受：Boss + 10 小怪 → 11 份独立完整交付；跨交付物的真实依赖（带 version + requires）。
 * 拒绝：同一 Boss 的「背景调查→设计→数值检查」；「计划→编码→审查」；用 depends_on
 *       把同一交付物的时序阶段伪装成依赖。
 */
import { createFakeClock } from './helpers/fake-clock.mjs';
import { runSuite, isMain, main } from './helpers/suite.mjs';
import { createWorkbench, leadAgent } from './helpers/harness.mjs';

export const meta = {
  id: 'w01-horizontal-split-policy',
  title: '横向拆分：Boss+10 小怪接受；阶段接力与伪装依赖拒绝',
  acceptance: ['W01', 'W04'],
  requires: ['policy', 'service'],
};

const TEAM = 'team-a';

function spec(overrides) {
  return {
    teamKey: TEAM,
    ownerMemberId: 'lead',
    acceptance: ['产物可用'],
    ...overrides,
  };
}

export async function run() {
  return runSuite(meta, async (suite) => {
    const workbench = await createWorkbench({ clock: createFakeClock(), config: { capacity: { globalLeafLimit: 4 } } });
    if (workbench.mode !== 'real') {
      suite.fail('真实 Host 模块可用', { mode: workbench.mode, pendingReason: workbench.pendingReason });
      return;
    }
    const { policy, service } = workbench;
    const lead = leadAgent(workbench);
    await service.defineTeam(lead, { teamKey: TEAM });

    // ----------------------------------------------------------- 1. 接受
    const monsters = Array.from({ length: 10 }, (_, index) => {
      const number = String(index + 1).padStart(2, '0');
      return spec({
        workId: `monster-${number}`,
        title: `怪物 ${number} 完整交付`,
        deliverable: `怪物 ${number} 的完整机制、数值与实现`,
        kind: 'object',
        outputs: [`src/monsters/monster-${number}.ts`, `docs/monsters/monster-${number}.md`],
      });
    });
    const boss = spec({
      workId: 'boss-01',
      title: '冰霜守卫 Boss 完整交付',
      deliverable: '冰霜守卫 Boss 的完整机制、数值与实现',
      kind: 'object',
      outputs: ['src/bosses/ice-warden.ts'],
    });
    const accepted = [];
    for (const item of [...monsters, boss]) {
      const result = await service.submitWork(lead, item);
      accepted.push(result);
    }
    suite.equal(accepted.filter((result) => result.ok).length, 11, 'Boss + 10 小怪 → 11 份独立交付全部被接受');
    suite.equal(new Set(accepted.map((result) => result.work?.workId)).size, 11, '11 份交付各有独立 workId');
    suite.assert(
      accepted.every((result) => result.work?.splitKind === 'independent-deliverable'),
      '全部标记为 independent-deliverable',
      accepted.map((result) => result.work?.splitKind),
    );
    suite.equal(service.works.size, 11, '侧车只登记了这 11 份横向交付');

    const splitOfBoss = policy.classifySplit(boss);
    suite.equal(splitOfBoss.kind, 'object', 'Boss 完整交付被分类为 object（不是 stage）');
    suite.equal(policy.isStageOnly(boss), false, 'isStageOnly(完整交付) === false');

    // ------------------------------------------- 2. 拒绝：同一 Boss 三阶段
    const relay = [
      spec({ workId: 'r1', title: 'Boss 背景调查', deliverable: 'Boss 背景调查', partOf: 'boss-01', outputs: ['docs/boss-background-report.md'] }),
      spec({ workId: 'r2', title: 'Boss 设计', deliverable: 'Boss 设计方案', partOf: 'boss-01', outputs: ['docs/boss-design.md'] }),
      spec({ workId: 'r3', title: 'Boss 数值检查', deliverable: 'Boss 数值检查结论', partOf: 'boss-01', outputs: ['docs/boss-numbers-report.md'] }),
    ];
    const relayResults = [];
    for (const item of relay) relayResults.push(await service.submitWork(lead, item));
    suite.assert(
      relayResults.every((result) => result.ok === false),
      '「背景调查→设计→数值检查」三件全部被拒绝',
      relayResults.map((result) => ({ workId: result.work?.workId, ok: result.ok, code: result.code })),
    );
    suite.assert(
      relayResults.every((result) => result.ok === false && result.code === 'PHASE_RELAY_SPLIT'),
      '拒绝码为 PHASE_RELAY_SPLIT',
      relayResults.map((result) => result.code),
    );
    suite.assert(
      relayResults.every((result) => typeof result.hint === 'string' && result.hint.length > 10),
      '每条拒绝都返回可执行的横向重排建议（hint）',
      relayResults.map((result) => result.hint),
    );
    suite.includes(relayResults[0].hint ?? '', '完整交付', '重排建议说明"完整交付给同一 owner"');
    suite.includes(relayResults[0].hint ?? '', '独立对象', '重排建议说明按独立对象/模块横向切');
    suite.equal(service.works.has('r1'), false, '被拒绝的阶段件 r1（背景调查报告）没有登记');
    suite.equal(service.works.has('r3'), false, '被拒绝的阶段件 r3（数值检查报告）没有登记');

    // 图级：即使单条校验漏掉，三件同一 partOf 也必须被判为阶段接力。
    const relayGraph = policy.validateWorkGraph(
      relay.map((item, index) => ({
        workId: item.workId,
        subject: item.partOf,
        title: item.title,
        deliverable: item.deliverable,
        outputs: item.outputs,
        artifactDependencies: [],
        stageIndex: index,
      })),
      { phaseRelay: 'reject' },
    );
    suite.equal(relayGraph.ok, false, '图级校验把同一 Boss 的三阶段判为违规');
    suite.assert(
      relayGraph.violations.some((violation) => violation.code === 'PHASE_RELAY_GRAPH'),
      '图级违反码为 PHASE_RELAY_GRAPH',
      relayGraph.violations.map((violation) => violation.code),
    );

    // ------------------------------------------- 3. 拒绝：计划→编码→审查
    // 三件各自都是"有真实产物"的合法工作项，单条校验不会拒；
    // 只有把同一 partOf 的三阶段放在一起看才是阶段接力 → 必须在入库前被图级校验阻断。
    const trio = [
      spec({ workId: 'p1', title: '功能 Y 交付 A', deliverable: '功能 Y 交付 A 的完整产物', partOf: 'feature-y', outputs: ['src/feature-y/a1.ts'], acceptance: ['计划阶段验收通过'] }),
      spec({ workId: 'p2', title: '功能 Y 交付 B', deliverable: '功能 Y 交付 B 的完整产物', partOf: 'feature-y', outputs: ['src/feature-y/a2.ts'], acceptance: ['编码阶段验收通过'] }),
      spec({ workId: 'p3', title: '功能 Y 交付 C', deliverable: '功能 Y 交付 C 的完整产物', partOf: 'feature-y', outputs: ['src/feature-y/a3.ts'], acceptance: ['审查阶段验收通过'] }),
    ];
    const trioResults = [];
    for (const item of trio) trioResults.push(await service.submitWork(lead, item));
    suite.equal(trioResults[0].ok, true, '「计划」单条校验通过（有真实产物，不是只交中间产物）');
    suite.equal(trioResults[1].ok, true, '「编码」单条校验通过');
    const graphBlocked = trioResults[2];
    suite.equal(graphBlocked.ok, false, '第三条同一 partOf 的阶段件被图级校验阻断');
    suite.equal(graphBlocked.code, 'PHASE_RELAY_GRAPH', '阻断码为 PHASE_RELAY_GRAPH');
    suite.assert(
      typeof graphBlocked.hint === 'string' && graphBlocked.hint.length > 10,
      '图级阻断给出横向重排建议（hint）',
      graphBlocked.hint,
    );
    suite.assert(
      Array.isArray(graphBlocked.violations) && graphBlocked.violations.length > 0,
      '图级阻断返回具体 violations 供审计',
      graphBlocked.violations,
    );
    suite.equal(service.works.has('p3'), false, '被图级阻断的工作项没有入库');
    suite.equal(service.storage.get('works', 'p3'), undefined, '被图级阻断的工作项没有落盘');
    suite.equal(service.works.has('p1') && service.works.has('p2'), true, '前两条已入库的工作项没有被回滚');
    const acceptedViolations = trioResults
      .filter((result) => result.ok)
      .flatMap((result) => result.graphViolations ?? []);
    suite.equal(acceptedViolations.length, 0, '入库成功的工作项不带图级违规（审计字段为空）');

    // 只交中间产物的阶段件，单条就应该被拒。
    const intermediateOnly = await service.submitWork(lead, spec({
      workId: 'plan-only',
      title: '功能 X 计划',
      deliverable: '功能 X 计划',
      outputs: ['docs/feature-x-plan.md'],
      acceptance: ['计划完成'],
    }));
    suite.equal(intermediateOnly.ok, false, '只产出计划文档的阶段件单条即被拒');
    suite.equal(intermediateOnly.code, 'PHASE_RELAY_SPLIT', '拒绝码为 PHASE_RELAY_SPLIT');
    suite.assert(
      typeof intermediateOnly.hint === 'string' && intermediateOnly.hint.length > 10,
      '单条拒绝同样给出横向重排建议',
      intermediateOnly.hint,
    );

    const graphWorks = [
      { workId: 'g-plan', subject: 'feature-x', title: '功能 X 计划', deliverable: '功能 X 计划', outputs: ['docs/feature-x-plan.md'], artifactDependencies: [] },
      { workId: 'g-code', subject: 'feature-x', title: '功能 X 编码', deliverable: '功能 X 实现', outputs: ['src/feature-x.ts'], artifactDependencies: [{ artifact: 'docs/feature-x-plan.md', version: 1, requires: 'published-interface' }] },
      { workId: 'g-review', subject: 'feature-x', title: '功能 X 审查', deliverable: '功能 X 审查结论', outputs: ['docs/feature-x-review.md'], artifactDependencies: [] },
    ];
    const graph = policy.validateWorkGraph(graphWorks, { phaseRelay: 'reject' });
    suite.equal(graph.ok, false, '图级校验识别「计划→编码→审查」为阶段接力');
    suite.assert(
      graph.violations.some((violation) => violation.code === 'PHASE_RELAY_GRAPH'),
      '违反码为 PHASE_RELAY_GRAPH',
      graph.violations.map((violation) => violation.code),
    );
    suite.assert(
      (graph.violations.find((violation) => violation.code === 'PHASE_RELAY_GRAPH')?.hint ?? '').length > 10,
      '图级违反也带横向重排建议',
    );

    // ------------------------------- 4. 拒绝：用 depends_on 伪装同一交付物阶段
    const sameDeliverable = [
      { workId: 'd-design', subject: 'boss-01', title: 'Boss 设计', deliverable: 'Boss 设计方案', outputs: ['docs/boss-design.md'], artifactDependencies: [] },
      {
        workId: 'd-check',
        subject: 'boss-01',
        title: 'Boss 数值检查',
        deliverable: 'Boss 数值检查结论',
        outputs: ['docs/boss-numbers.md'],
        artifactDependencies: [{ artifact: 'docs/boss-design.md', version: 1, requires: 'published-interface' }],
      },
    ];
    const graphDeps = policy.validateWorkGraph(sameDeliverable, { phaseRelay: 'reject' });
    suite.equal(graphDeps.ok, false, '同一交付物内部依赖被判为违规');
    suite.assert(
      graphDeps.violations.some((violation) => violation.code === 'SAME_DELIVERABLE_DEPENDENCY'),
      '违反码为 SAME_DELIVERABLE_DEPENDENCY',
      graphDeps.violations.map((violation) => violation.code),
    );

    // ------------------------------- 5. 接受：跨交付物的真实依赖（独立工作台，图干净）
    {
      const clean = await createWorkbench({ clock: createFakeClock(), config: { capacity: { globalLeafLimit: 4 } } });
      const cleanLead = leadAgent(clean);
      await clean.service.defineTeam(cleanLead, { teamKey: TEAM });
      const cross = await clean.service.submitWork(cleanLead, spec({
        workId: 'shop-ui',
        title: '商店界面完整交付',
        deliverable: '商店界面的完整实现',
        outputs: ['src/shop/ui.ts'],
        artifactDependencies: [{ artifact: 'inventory-api', version: 2, requires: 'published-interface' }],
      }));
      suite.equal(cross.ok, true, '跨交付物、带 version + requires 的真实依赖被接受');
      suite.equal(cross.graphViolations.length, 0, '真实依赖不产生图级违规');

      const missingVersion = await clean.service.submitWork(cleanLead, spec({
        workId: 'shop-ui-2',
        title: '商店逻辑完整交付',
        deliverable: '商店逻辑的完整实现',
        outputs: ['src/shop/logic.ts'],
        artifactDependencies: [{ artifact: 'inventory-api', requires: 'published-interface' }],
      }));
      suite.equal(missingVersion.ok, false, '缺少 version 的依赖被拒绝');
      suite.equal(missingVersion.code, 'DEPENDENCY_WITHOUT_VERSION', '拒绝码为 DEPENDENCY_WITHOUT_VERSION');
      await clean.dispose();
    }

    // ------------------------------------------------- 6. 完成门槛分层
    const work = service.works.get('boss-01');
    const gateNoAttempt = policy.completionGate({ work, attempt: null, evidence: [] });
    suite.equal(gateNoAttempt.level, 'none', '没有 attempt → level none（不把 idle 当成功）');
    const gateRunning = policy.completionGate({ work, attempt: { state: 'executing' }, evidence: [] });
    suite.equal(gateRunning.level, 'none', '执行中的 attempt → level none');
    const gateNoArtifacts = policy.completionGate({ work, attempt: { state: 'produced', artifactRefs: [] }, evidence: [] });
    suite.equal(gateNoArtifacts.level, 'none', 'produced 但无产物引用 → 不算完成');
    const gatePseudo = policy.completionGate({
      work,
      attempt: { state: 'produced', artifactRefs: [{ path: 'src/bosses/ice-warden.ts', version: 1 }], signals: { idle: true, timedOut: true } },
      evidence: [],
    });
    suite.equal(gatePseudo.level, 'none', 'idle / 超时等伪成功信号不能冒充完成');
    const gateVerified = policy.completionGate({
      work,
      attempt: { state: 'produced', artifactRefs: [{ path: 'src/bosses/ice-warden.ts', version: 1 }] },
      evidence: [{ kind: 'verification', runId: 'run-real-1' }],
    });
    suite.equal(gateVerified.level, 'verified', '有真实验证证据 → verified');
    suite.equal(gateVerified.pendingUserAcceptance, true, 'verified ≠ 用户确认，仍显示待验收');
    const gateAccepted = policy.completionGate({
      work: { ...work, acceptance: ['逐条验收 A', '逐条验收 B'] },
      attempt: { state: 'produced', artifactRefs: [{ path: 'src/bosses/ice-warden.ts', version: 1 }] },
      evidence: [{ kind: 'verification', runId: 'run-real-1' }, { kind: 'acceptance', commandRef: 'node --test' }, { kind: 'acceptance', commandRef: 'node --test' }],
    });
    suite.equal(gateAccepted.level, 'accepted', '逐条验收证据齐备 → accepted');
    const gateUser = policy.completionGate({
      work: { ...work, acceptance: ['逐条验收 A', '逐条验收 B'] },
      attempt: { state: 'produced', artifactRefs: [{ path: 'src/bosses/ice-warden.ts', version: 1 }] },
      evidence: [{ kind: 'verification', runId: 'run-real-1' }, { kind: 'acceptance', commandRef: 'node --test' }, { kind: 'acceptance', commandRef: 'node --test' }],
      userConfirmed: true,
    });
    suite.equal(gateUser.level, 'user-confirmed', '用户明确确认 → user-confirmed');
    suite.note('图级违规（PHASE_RELAY_GRAPH / SAME_DELIVERABLE_DEPENDENCY）由 validateWorkGraph 检测，submitWork 通过 graphViolations 上报；不阻断单条提交。');
    await workbench.dispose();
  });
}

if (isMain(import.meta.url)) await main(run, meta);
