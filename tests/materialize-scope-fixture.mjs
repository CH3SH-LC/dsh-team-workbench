#!/usr/bin/env node
/**
 * 隔离 fixture（P1-6）：materialize caller scopes 只能缩小。
 * 使用真实 TeamWorkbenchService 实例（tests/helpers/harness 的 real 模式）。
 *
 * 运行：node tests/materialize-scope-fixture.mjs
 */

import { createWorkbench, leadAgent, registerMember } from './helpers/harness.mjs';
import { createFakeClock } from './helpers/fake-clock.mjs';
import { promises as fsp } from 'node:fs';

let passed = 0;
let failed = 0;
function check(name, ok, detail = null) {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name} :: ${JSON.stringify(detail)}`); }
}

async function main() {
  const workbench = await createWorkbench({ clock: createFakeClock() });
  if (workbench.mode !== 'real') {
    console.log(`SKIP: harness mode=${workbench.mode} (${workbench.pendingReason ?? ''})`);
    process.exitCode = 1;
    return;
  }
  try {
    const lead = leadAgent(workbench);
    const service = workbench.service;
    await service.defineTeam(lead, { teamKey: 'team-m' });
    await service.createMember(lead, { teamKey: 'team-m', name: 'owner', description: '物化范围 owner' });
    const sessionId = registerMember(workbench, 'owner', 'team-m');
    const member = workbench.native.agentFor(sessionId) ?? { id: sessionId };
    const submitted = await service.submitWork(lead, {
      teamKey: 'team-m',
      workId: 'mat-1',
      title: '物化范围测试交付',
      deliverable: '物化范围测试模块完整实现',
      ownerMemberId: 'owner',
      outputs: ['src/mat/index.ts'],
      writeScopes: ['src/mat'],
      acceptance: ['可集成'],
    });
    check('fixture 前提：work 提交成功', submitted.ok === true, submitted.code ?? submitted);

    // 越界：caller 想把 scopes 扩到 work 授权范围之外。
    const escalated = await service.materialize(member, { workId: 'mat-1', op: 'copy', scopes: ['src/other'], from: 'src/mat/index.ts' });
    check('P1-6：caller scopes 越界 → MATERIALIZE_SCOPE_ESCALATION', escalated.ok === false && escalated.code === 'MATERIALIZE_SCOPE_ESCALATION', escalated.code ?? escalated);

    // 子集：只缩到 work 授权范围内 → 不因越界被拒（后续失败码必须不是 escalation）。
    const narrowed = await service.materialize(member, { workId: 'mat-1', op: 'copy', scopes: ['src/mat'], from: 'src/mat/index.ts' });
    check('P1-6：caller scopes 为目标范围子集 → 不触发 escalation', narrowed.code !== 'MATERIALIZE_SCOPE_ESCALATION', narrowed.code ?? null);

    // P1-7：机械搬运必须由 Host materialize 返回 receipt（noModelCalls），不派给 LLM。
    await fsp.mkdir('tmp-mat', { recursive: true });
    await fsp.writeFile('tmp-mat/from.txt', 'mechanical copy fixture\n', 'utf8');
    const copied = await service.materialize(member, { op: 'copy', scopes: ['tmp-mat'], from: 'tmp-mat/from.txt', to: 'tmp-mat/to.txt' });
    check('P1-7：materialize 成功并返回 receipt（no model calls）', copied.ok === true && (copied.noModelCalls === true || copied.receipt?.noModelCalls === true), { code: copied.code ?? null, noModelCalls: copied.noModelCalls ?? copied.receipt?.noModelCalls ?? null });
    const copiedBytes = await fsp.readFile('tmp-mat/to.txt', 'utf8').catch(() => '');
    check('P1-7：机械复制结果正确（非 LLM 转抄）', copiedBytes === 'mechanical copy fixture\n', copiedBytes.slice(0, 40));
    // 未给 workId 时 caller scopes 直接被采用（不扩大任何 work 授权）。
    const withoutWork = await service.materialize(member, { op: 'copy', scopes: ['src/free'], from: 'src/free/x.ts' });
    check('P1-6：无 workId 时 caller scopes 直接采用，不隐式扩大', withoutWork.code !== 'MATERIALIZE_SCOPE_ESCALATION' && withoutWork.code !== 'DELEGATION_SCOPE', withoutWork.code ?? null);
  } finally {
    await workbench.dispose();
  }
  console.log(`\nmaterialize-scope fixture: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exitCode = 1;
});
