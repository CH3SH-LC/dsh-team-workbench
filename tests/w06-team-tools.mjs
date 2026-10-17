/**
 * W06 — 工具层：注册集合、官方保留名不冲突、lead 自动补登记、非 lead 被拒。
 *
 * 计数**派生**自 `tests/fixtures/dsh-tool-names.json`（单一来源），
 * 并与真实 `registerTools()` 的返回集合逐名比较，避免"再加一个工具就红"。
 */
import { createFakeClock } from './helpers/fake-clock.mjs';
import { runSuite, isMain, main } from './helpers/suite.mjs';
import { createWorkbench, leadAgent, registerMember } from './helpers/harness.mjs';
import { loadHostModule } from './helpers/host-loader.mjs';
import {
  EXPECTED_TEAM_TOOL_COUNT,
  RESERVED_OFFICIAL_TEAM_NAMES,
  TEAM_TOOLS,
  compareToolSets,
} from './helpers/expected-tools.mjs';

export const meta = {
  id: 'w06-team-tools',
  title: '工具层：注册集合/保留名/自动补登记/非 lead 拒绝',
  acceptance: ['W06', 'W02'],
  requires: ['tools', 'service', 'scheduler', 'storage'],
};

/** 通过假 ctx 的 tools registry 真跑一个工具。 */
async function callTool(workbench, name, args, agent) {
  const result = await workbench.ctx.tools.execute({
    callId: `call-${name}`,
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  });
  return result;
}

export async function run() {
  const toolsModule = await loadHostModule('tools');
  return runSuite(meta, async (suite) => {
    const workbench = await createWorkbench({
      clock: createFakeClock(),
      config: { capacity: { globalLeafLimit: 4 } },
    });
    if (workbench.mode !== 'real' || !toolsModule.real) {
      suite.fail('真实 Host 模块可用', { mode: workbench.mode, tools: toolsModule.real, pendingReason: workbench.pendingReason });
      return;
    }
    const { service, scheduler, adapter, config, ctx, native } = workbench;
    const lead = leadAgent(workbench);

    const registration = toolsModule.mod.registerTools({ service, scheduler, adapter, config });
    const registered = registration.registered ?? [];
    const comparison = compareToolSets(registered);

    // ---- 注册集合与官方保留名 ---------------------------------------------
    suite.equal(
      registered.length,
      EXPECTED_TEAM_TOOL_COUNT,
      `注册的 team_* 工具数 = 基线清单长度（${EXPECTED_TEAM_TOOL_COUNT}）`,
    );
    suite.deepEqual(comparison.missing, [], '基线清单里的工具都注册了', comparison.missing);
    suite.deepEqual(comparison.unexpected, [], '没有注册基线清单之外的工具', comparison.unexpected);
    suite.assert(
      registered.every((name) => name.startsWith('team_')),
      '所有工具都用 team_ 前缀',
      registered.filter((name) => !name.startsWith('team_')),
    );
    suite.deepEqual(
      registered.filter((name) => RESERVED_OFFICIAL_TEAM_NAMES.includes(name)),
      [],
      '没有重复注册官方已占用的名字',
    );
    suite.deepEqual(registration.skipped ?? [], [], '没有工具因为冲突/失败被跳过', registration.skipped);
    suite.assert(
      TEAM_TOOLS.includes('team_define'),
      '基线清单包含 team_define（lead 登记团队的入口）',
      TEAM_TOOLS,
    );
    suite.equal(ctx.tools.get('team_define') !== undefined, true, 'team_define 已进入 tools registry');
    suite.equal(ctx.tools.get('send_message'), undefined, '官方 send_message 没有被本插件覆盖');

    // ---- team_define：只有 lead 能做 --------------------------------------
    const memberSessionId = registerMember(workbench, 'combat-system', 'session-lead');
    const member = native.agentFor(memberSessionId);
    const defineByMember = await callTool(
      workbench,
      'team_define',
      { teamKey: 'team-x', goal: '非法尝试' },
      member,
    );
    suite.equal(defineByMember.isError, false, 'team_define 对非 lead 返回结构化结果而不是抛错');
    suite.equal(defineByMember.value?.ok, false, 'team_define 对非 lead 被拒绝');
    suite.equal(defineByMember.value?.code, 'TEAM_LEAD_REQUIRED', '拒绝码为 TEAM_LEAD_REQUIRED');
    suite.equal(service.teams.has('team-x'), false, '被拒绝的 team_define 没有登记团队');

    const defineByLead = await callTool(workbench, 'team_define', { teamKey: 'team-a', goal: '显式登记' }, lead);
    suite.equal(defineByLead.value?.ok, true, 'lead 的 team_define 成功');
    suite.equal(service.teams.has('team-a'), true, '团队已登记');

    // ---- lead 未登记团队时 team_work_submit 自动补登记 ---------------------
    {
      const fresh = await createWorkbench({
        clock: createFakeClock(),
        config: { capacity: { globalLeafLimit: 4 } },
      });
      const freshLead = leadAgent(fresh);
      const freshTools = toolsModule.mod.registerTools({
        service: fresh.service,
        scheduler: fresh.scheduler,
        adapter: fresh.adapter,
        config: fresh.config,
      });
      suite.assert(freshTools.registered.includes('team_work_submit'), '新工作台上 team_work_submit 已注册');
      // 关键：不传 teamKey → 解析为调用者自己的团队 id；团队未登记 → 应自动补登记。
      const submitted = await callTool(fresh, 'team_work_submit', {
        workId: 'auto-1',
        title: '自动登记后的第一份交付',
        deliverable: '自动登记模块的完整实现',
        ownerMemberId: 'lead',
        outputs: ['src/auto/index.ts'],
        acceptance: ['可集成'],
      }, freshLead);

      suite.equal(submitted.isError, false, 'team_work_submit 未登记团队时没有抛错');
      suite.equal(submitted.value?.ok, true, 'lead 未登记团队时 team_work_submit 自动补登记并提交成功', submitted.value);
      const diagnosticCodes = (fresh.service.diagnostics.list() ?? []).map((entry) => String(entry.code));
      suite.assert(
        diagnosticCodes.includes('service:team-autoregistered'),
        '留下 service:team-autoregistered 诊断（不静默补登记）',
        diagnosticCodes.slice(-8),
      );
      suite.equal(fresh.service.teams.size, 1, '自动补登记恰好一个团队');
      suite.equal([...fresh.service.teams.keys()][0], 'session-lead', '自动登记的 teamKey = 调用者自己的团队 id');
      suite.equal(fresh.service.works.has('auto-1'), true, '工作项确实入库');

      // 第二次提交不再补登记（幂等）。
      const before = diagnosticCodes.filter((code) => code === 'service:team-autoregistered').length;
      await callTool(fresh, 'team_work_submit', {
        workId: 'auto-2',
        title: '第二份交付',
        deliverable: '第二个模块的完整实现',
        ownerMemberId: 'lead',
        outputs: ['src/auto/two.ts'],
        acceptance: ['可集成'],
      }, freshLead);
      const after = (fresh.service.diagnostics.list() ?? []).filter((entry) => entry.code === 'service:team-autoregistered').length;
      suite.equal(after, before, '团队已存在时不再重复自动登记');
      await fresh.dispose();
    }

    // ---- team_snapshot 可用 ------------------------------------------------
    const snapshotResult = await callTool(workbench, 'team_snapshot', { teamKey: 'team-a' }, lead);
    suite.equal(snapshotResult.isError, false, 'team_snapshot 调用成功');
    suite.equal(snapshotResult.value?.ok, true, 'team_snapshot 返回 ok');
    suite.assert(
      Array.isArray(snapshotResult.value?.snapshot?.works),
      'team_snapshot 返回 works 数组',
      Object.keys(snapshotResult.value?.snapshot ?? {}),
    );

    registration.dispose?.();
    await workbench.dispose();
  });
}

if (isMain(import.meta.url)) await main(run, meta);
