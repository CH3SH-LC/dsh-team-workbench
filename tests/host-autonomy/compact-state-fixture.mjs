/**
 * `compact-state-fixture.mjs` — compactStateFor / 维护入口 / sidecar 冷热地址的**真实类实例**回归。
 *
 * 目的（Lead 收口项）：不能只用纯对象冒充 service。
 *  - 用 `tests/helpers/harness.mjs` 装配**真实 shipped** `TeamWorkbenchService`（只有原生 seam 是替身）；
 *  - 断言 `compactStateFor(agent)` 真的带出已知失败/接口版本等关键事实（P2-9 注入依赖它）；
 *  - 断言 `team_maintenance` 的生产实现可被 lead 以 expectedSeq 调用，且 owner 自身被拒；
 *  - 断言 sidecar 在 storageDomain（无 dataDir）下使用**显式稳定根**：同一 DSH_TEAM_WORKBENCH_DIR
 *    写入后，新实例（模拟 normal apply 冷启动）能读回同一记录。
 *
 * 运行：node tests/host-autonomy/compact-state-fixture.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createWorkbench, leadAgent } from '../helpers/harness.mjs';
import { createSidecarStore, createRemediationStorage, sidecarDirFor } from '../../src/host/remediationStorage.js';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) console.error(`FAIL ${name} :: ${JSON.stringify(detail)}`);
}

async function testCompactStateFacts() {
  const workbench = await createWorkbench();
  if (workbench.mode !== 'real') {
    check('真实 Host 模块可装配', false, { mode: workbench.mode, pendingReason: workbench.pendingReason });
    return;
  }
  try {
    const { service, native } = workbench;
    const lead = leadAgent(workbench);
    await service.defineTeam(lead, { teamKey: 'team-a' });
    await service.createMember(lead, { teamKey: 'team-a', name: 'steady', description: '真实类实例 owner' });
    const member = service.members.get('team-a/steady');
    const sessionId = 'session-member-steady';
    native.registerAgent(sessionId, { name: 'steady' });
    native.registerMembership(sessionId, { root: lead, id: 'team-a', role: 'teammate', name: 'steady' });
    member.sessionId = sessionId;
    service.members.set('team-a/steady', member);
    const submitted = await service.submitWork(lead, {
      teamKey: 'team-a',
      workId: 'real-compact-work',
      title: '紧凑上下文真实类实例',
      deliverable: '真实类实例上的紧凑状态事实回归',
      ownerMemberId: 'steady',
      outputs: ['src/real/compact.ts'],
      acceptance: ['可集成'],
      artifactDependencies: [{ artifact: 'hook.dll', version: 7, requires: 'verified-result' }],
    });
    check('真实 service 上提交 work', submitted?.ok === true, submitted);
    const work = service.works.get('real-compact-work');
    work.lastFailureMessage = 'KNOWN: kind4 helper does not call production entry';
    work.lastFailureCode = 'TOOL_RESULT_ERROR';
    const agent = native.agentFor(sessionId);
    const state = service.compactStateFor(agent);
    check('compactStateFor 真实类实例返回 work 事实', Array.isArray(state?.works) && state.works.some((entry) => entry.workId === 'real-compact-work'), state);
    const row = state?.works?.find((entry) => entry.workId === 'real-compact-work');
    check('compactStateFor 带出 lastFailureMessage（P2-9 关键事实）', row?.lastFailureMessage === work.lastFailureMessage, row);
    check('compactStateFor 带出接口版本（artifactDependencies）', Array.isArray(row?.artifactDependencies) && row.artifactDependencies[0]?.artifact === 'hook.dll', row?.artifactDependencies);
    // 维护入口可发现且 owner 自压缩被拒（lead 调用 owner 目标在无 compaction 服务时明确返回不可用码）。
    const ownerView = await service.requestMaintenance(agent, { teamKey: 'team-a', memberId: 'steady', expectedSeq: 1, requestKey: 'fixture-maintenance-owner' });
    check('owner 自身调用维护被拒（lead/root 或 self-turn 边界）', ownerView?.ok === false && ['MAINTENANCE_SELF_TURN_FORBIDDEN', 'TEAM_LEAD_REQUIRED'].includes(ownerView.code), ownerView);
    const missingSeq = await service.requestMaintenance(lead, { teamKey: 'team-a', memberId: 'steady', requestKey: 'fixture-missing-seq' });
    check('维护缺 expectedSeq 被拒（MAINTENANCE_EXPECTED_SEQ_REQUIRED）', missingSeq?.ok === false && missingSeq.code === 'MAINTENANCE_EXPECTED_SEQ_REQUIRED', missingSeq);
    const inspect = await service.maintenanceInspect(lead, { teamKey: 'team-a', memberId: 'steady', requestKey: 'fixture-inspect' });
    check('维护 inspect 只读可用且读出 target/preset/seq 字段', inspect?.ok === true && inspect.readOnly === true && inspect.target?.memberId === 'steady', inspect);
  } finally {
    await workbench.dispose();
  }
}

async function testSidecarStableAddress() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'twb-sidecar-stable-'));
  const previous = process.env.DSH_TEAM_WORKBENCH_DIR;
  process.env.DSH_TEAM_WORKBENCH_DIR = root;
  try {
    // storageDomain 永远没有 dataDir → 必须使用显式稳定根（不是 cwd）。
    const storageLike = { tables: Object.freeze([]), dataDir: () => null, list: () => [] };
    const dir = sidecarDirFor(storageLike);
    check('sidecarDirFor 使用显式稳定根（不落到 cwd）', path.resolve(dir).startsWith(path.resolve(root)), { dir, root });
    // 第一实例（模拟 hot 升级写入）。
    const hot = createSidecarStore({ dir });
    await hot.load();
    const hotFacade = createRemediationStorage({ base: storageLike, sidecar: hot });
    const ack = { bundleUrl: '/plugin/team-workbench/client.js?v=1', activatedAt: 123, mounted: true, persisted: true };
    const wrote = await hotFacade.put('meta_records', 'frontend_ack:fixture', ack);
    check('hot 实例写入 meta_records 成功', wrote?.ok === true, wrote);
    const hotSidecarDir = sidecarDirFor(storageLike);
    // 第二实例（模拟 normal apply 冷启动）；路径必须相同。
    const cold = createSidecarStore({ dir: hotSidecarDir });
    await cold.load();
    const coldFacade = createRemediationStorage({ base: storageLike, sidecar: cold });
    const read = coldFacade.get('meta_records', 'frontend_ack:fixture');
    check('normal apply 冷读回 hot 写入（同 sidecar 地址）', read?.bundleUrl === ack.bundleUrl && read?.mounted === true, read);
    const readBack = await cold.readBackFromDisk('meta_records', 'frontend_ack:fixture');
    check('冷读是磁盘独立读回（不是同进程内存）', readBack?.bundleUrl === ack.bundleUrl, readBack);
  } finally {
    if (previous === undefined) delete process.env.DSH_TEAM_WORKBENCH_DIR;
    else process.env.DSH_TEAM_WORKBENCH_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

await testCompactStateFacts();
await testSidecarStableAddress();
const failed = results.filter((entry) => !entry.ok);
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length, failures: failed.map((entry) => entry.name) }));
process.exitCode = failed.length > 0 ? 1 : 0;
