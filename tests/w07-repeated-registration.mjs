/**
 * W07 — 重复注册：连续 apply/dispose 两轮，provider / section / tool /
 *        web route / scheduler 的存活注册计数不增长。
 *
 * 这一条直接对应 HMR 与「停用后重开」：第二世代不能留下第一世代的
 * prompt 段、工具、技能 provider、投影、监听器或调度器。
 */
import { createFakeClock } from './helpers/fake-clock.mjs';
import { createFakeAdapter } from './helpers/fake-adapter.mjs';
import { createFakeContext } from './helpers/fake-ctx.mjs';
import { runSuite, isMain, main } from './helpers/suite.mjs';
import { loadHostModule } from './helpers/host-loader.mjs';
import { EXPECTED_TEAM_TOOL_COUNT } from './helpers/expected-tools.mjs';

export const meta = {
  id: 'w07-repeated-registration',
  title: '连续 apply/dispose 两轮：注册计数不增长、无重复 prompt/工具/调度器',
  acceptance: ['W07'],
  requires: ['index'],
};

const RAW_CONFIG = {
  singleWriter: true,
  capacity: { hostActivationLimit: 40, globalLeafLimit: 30, recoveryReserve: 3, interactiveReserve: 2, perMemberLeaves: 6, teamsMaxConcurrent: 3 },
};

const TRACKED_KEYS = [
  'tools',
  'sections',
  'contexts',
  'webRoutes',
  'skillProviders',
  'skills',
  'projections',
  'listeners',
  'commands',
  'promptTools',
  'effects',
];

function pick(counts) {
  const out = {};
  for (const key of TRACKED_KEYS) out[key] = counts[key];
  return out;
}

export async function run() {
  const indexModule = await loadHostModule('index');
  if (!indexModule.real) {
    return runSuite({
      ...meta,
      pending: true,
      pendingReason: `${indexModule.file} 不可加载：${indexModule.error?.message ?? 'not written yet'}`,
    }, null);
  }
  // 预加载 skills.js，让 apply 里的动态 import 命中模块缓存（确定性）。
  await loadHostModule('skills');

  return runSuite(meta, async (suite) => {
    const clock = createFakeClock();
    const native = createFakeAdapter({ clock });
    const apply = indexModule.mod.apply;

    /** Run one plugin generation on a fresh Cordis-shaped context. */
    async function generation(label) {
      const ctx = createFakeContext({ adapter: native, clock });
      const baseline = ctx.liveCounts();
      const dispose = apply(ctx, RAW_CONFIG);
      // ---- 断言 A：apply 必须是同步注册段 ---------------------------------
      // 在 apply 返回后、任何 await 之前就必须已经完成全部注册；否则 Cordis 会在
      // 第一个 await 之后让 ctx.inject/effect/on 抛 INACTIVE_EFFECT。
      const syncCounts = ctx.liveCounts();
      const syncService = ctx.get('teamWorkbench');
      const syncDiagnostics = (syncService?.diagnostics?.list?.() ?? []).map((entry) => String(entry.code));

      // 等到异步段（hydration / 动态导入 / 调度启动 / 启动对账）落定。
      let settled = false;
      for (let round = 0; round < 25 && !settled; round += 1) {
        await clock.flush(20);
        settled = ctx.liveCounts().tools > 0 && ctx.liveCounts().webRoutes > 0;
      }
      const afterApply = ctx.liveCounts();
      const service = ctx.get('teamWorkbench');
      // storage 侧：HMR 两代同进程时，第二代必须仍落在 storageDomain 后端，
      // 不能因为 already-open 退到插件自有的空 JSON 库（split-brain）。
      const storageView = service?.snapshot?.({ id: 'session-lead' })?.storage ?? null;
      const storageDiagnostics = (service?.storage?.diagnostics?.() ?? []).map((entry) => String(entry.code));
      await dispose();
      await ctx.dispose();
      await clock.flush(20);
      const afterDispose = ctx.liveCounts();
      return { label, ctx, baseline, afterApply, afterDispose, service, settled, syncCounts, syncDiagnostics, syncService, storageView, storageDiagnostics };
    }

    const first = await generation('generation-1');
    // 断言 A：`apply` 返回前不得有 await（同步注册段）。
    suite.equal(first.syncService !== undefined, true, 'A：apply 同步段就提供了 teamWorkbench 服务');
    suite.equal(first.syncCounts.tools, EXPECTED_TEAM_TOOL_COUNT, `A：apply 返回时 ${EXPECTED_TEAM_TOOL_COUNT} 个 team_* 工具已同步注册`);
    suite.compare(first.syncCounts.webRoutes, '>=', 3, 'A：apply 返回时 web 路由已同步注册');
    suite.equal(first.syncCounts.commands, 1, 'A：apply 返回时人类命令已同步注册');
    suite.note(`A：apply 同步段 tools=${first.syncCounts.tools} webRoutes=${first.syncCounts.webRoutes} commands=${first.syncCounts.commands}；技能 provider 已拆到独立 bundle（workbench 侧保持基线 0）。`);
    suite.assert(
      !first.syncDiagnostics.some((code) => code.includes('INACTIVE_EFFECT') || code.includes('provide-failed') || code.includes('inject')),
      'A：同步段没有出现 INACTIVE_EFFECT / provide-failed / inject 失败诊断',
      first.syncDiagnostics.filter((code) => code.includes('INACTIVE') || code.includes('inject') || code.includes('failed')),
    );
    suite.equal(first.settled, true, '第一世代：工具与 web 路由注册完成');
    suite.equal(first.afterApply.tools, EXPECTED_TEAM_TOOL_COUNT, `第一世代注册了 ${EXPECTED_TEAM_TOOL_COUNT} 个 team_* 工具`);
    suite.compare(first.afterApply.webRoutes, '>=', 3, '第一世代注册了 web 工作台路由');
    suite.equal(first.afterApply.commands, 1, '第一世代注册了 team-workbench 人类命令');
    suite.assert(first.service !== undefined, '第一世代提供了 teamWorkbench 服务', first.service === undefined ? 'missing' : 'ok');
    // 工作台只提供团队角色提示词段，不冒充外部技能provider；注册数保持基线。
    suite.equal(
      first.afterApply.skillProviders,
      first.baseline.skillProviders,
      'workbench 不注册外部技能 provider',
    );
    // 角色段是 agent-scoped：fakes ctx 里拿不到 agent 自己的 ctx，插件必须
    // **拒绝**把它降级成全局段（skills:sections:no-agent-scope），因此计数不变。
    suite.equal(first.afterApply.sections, first.baseline.sections, '角色段没有被错误地注册成全局 systemPrompt 段');
    const sectionDiagnostics = (first.service?.diagnostics?.list?.() ?? []).filter((entry) => String(entry.code).startsWith('skills:sections'));
    suite.assert(
      sectionDiagnostics.some((entry) => entry.code === 'skills:sections:no-agent-scope'),
      '插件留下了准确的诊断：拿不到 agent 自己的 ctx 时跳过角色段',
      sectionDiagnostics.map((entry) => entry.code),
    );

    const firstDisposed = pick(first.afterDispose);
    const firstBaseline = pick(first.baseline);
    suite.deepEqual(firstDisposed, firstBaseline, 'dispose 之后所有注册都回到基线（无残留）');
    suite.equal(first.afterDispose.tools, 0, 'dispose 之后 team_* 工具全部注销');
    suite.equal(first.afterDispose.webRoutes, 0, 'dispose 之后 web 路由全部注销');
    suite.equal(first.afterDispose.skillProviders, first.baseline.skillProviders, 'dispose 之后技能 provider 已注销');
    suite.equal(first.afterDispose.listeners, first.baseline.listeners, 'dispose 之后事件监听器全部注销');
    suite.equal(first.ctx.get('teamWorkbench'), undefined, 'dispose 之后 teamWorkbench 服务已注销');

    const second = await generation('generation-2');
    suite.equal(second.settled, true, '第二世代：apply 再次成功');

    // ---- storage 侧：两代同进程（模拟 HMR）不 split-brain -------------------
    suite.assert(first.storageView !== null, '第一世代有 storage 快照', first.storageView);
    suite.assert(second.storageView !== null, '第二世代有 storage 快照', second.storageView);
    suite.equal(first.storageView?.backend, 'storageDomain', '第一世代使用 storageDomain 后端');
    suite.equal(second.storageView?.backend, 'storageDomain', '第二世代仍是 storageDomain 后端（没有退到空 JSON 库）');
    suite.equal(first.storageView?.degraded, false, '第一世代 degraded=false');
    suite.equal(second.storageView?.degraded, false, '第二世代 degraded=false');
    suite.equal(first.storageView?.durable, true, '第一世代 durable=true');
    suite.equal(second.storageView?.durable, true, '第二世代 durable=true');
    suite.equal(second.storageView?.backendError ?? null, null, '第二世代没有遗留 backendError');
    suite.equal(
      first.storageDiagnostics.includes('storage:fallback-active'),
      false,
      '第一世代没有切到插件自有 fallback',
      first.storageDiagnostics,
    );
    suite.equal(
      second.storageDiagnostics.includes('storage:fallback-active'),
      false,
      '第二世代没有切到插件自有 fallback（split-brain 回归锁）',
      second.storageDiagnostics,
    );
    suite.assert(
      second.storageDiagnostics.some((code) => code === 'storage:writer-claimed' || code === 'storage:adopted-open-domain'),
      '第二世代正常拿到写权或接管同一 handle',
      second.storageDiagnostics.slice(-6),
    );

    const firstApplied = pick(first.afterApply);
    const secondApplied = pick(second.afterApply);
    suite.deepEqual(secondApplied, firstApplied, '第二世代的存活注册计数与第一世代完全相同（不增长）');
    suite.deepEqual(pick(second.afterDispose), pick(second.baseline), '第二世代 dispose 后同样回到基线');

    // 明确列出关键计数，便于 deterministic.md 记录。
    suite.equal(secondApplied.tools, firstApplied.tools, '工具数不随世代增长');
    suite.equal(secondApplied.sections, firstApplied.sections, 'prompt 段数不随世代增长');
    suite.equal(secondApplied.skillProviders, firstApplied.skillProviders, '技能 provider 数不随世代增长');
    suite.equal(secondApplied.projections, firstApplied.projections, '投影数不随世代增长');
    suite.equal(secondApplied.listeners, firstApplied.listeners, '事件监听器数不随世代增长');
    suite.equal(secondApplied.webRoutes, firstApplied.webRoutes, 'web 路由数不随世代增长');
    suite.equal(secondApplied.commands, firstApplied.commands, '命令数不随世代增长');

    // 调度器：dispose 之后不能再自动唤醒；effect 全部释放。
    suite.equal(first.afterDispose.effects, first.baseline.effects, '第一世代 dispose 后 effect 全部释放');
    suite.equal(second.afterDispose.effects, second.baseline.effects, '第二世代 dispose 后 effect 全部释放');
    suite.note(`generation-1 afterApply=${JSON.stringify(firstApplied)}`);
    suite.note(`baseline=${JSON.stringify(firstBaseline)}`);
  });
}

if (isMain(import.meta.url)) await main(run, meta);
