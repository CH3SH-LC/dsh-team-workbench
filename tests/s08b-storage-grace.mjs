/**
 * S08b — 启动门闸 A/B（Lead 在独立 profile 里发现的两个「新进程才暴露」的缺陷）。
 *
 * A：`apply` 必须是**同步注册段**。若 apply 是 async，第一个 `await` 之后的
 *    `ctx.inject` / `ctx.effect` / `ctx.on` 会抛 Cordis 的 `INACTIVE_EFFECT`。
 *    断言方式：在 fake ctx 上同步调用 `apply`，返回后**不做任何 await** 就检查
 *    工具/线路/命令是否已注册，并确认没有 `INACTIVE_EFFECT` / `provide-failed` 诊断。
 *    （A 的核心断言在 `tests/w07-repeated-registration.mjs`；这里补一条独立复现。）
 *
 * B：`storageDomain` 由 storage-domain 插件通过 `ctx.inject(backends)` 挂载，
 *    时机晚于本行 activate。启动时一次性探测必然拿到 `SERVICE_UNAVAILABLE`。
 *    断言：门闸在服务迟到时能初始化成功；服务始终不来时按 `storageGraceMs`
 *    有界兜底、留下明确诊断、并退到插件自有的持久 JSON 后端。
 *
 * 注：兜底后端的落盘目录由 `DSH_TEAM_WORKBENCH_DIR` 重定向到 `tests/tmp/**`
 * （本 harness 的写范围内），避免在仓库外产生副作用。
 */
import path from 'node:path';
import { createFakeClock } from './helpers/fake-clock.mjs';
import { createFakeAdapter } from './helpers/fake-adapter.mjs';
import { createFakeContext } from './helpers/fake-ctx.mjs';
import { runSuite, isMain, main } from './helpers/suite.mjs';
import { loadHostModule, WORKSPACE_ROOT } from './helpers/host-loader.mjs';
import { EXPECTED_TEAM_TOOL_COUNT } from './helpers/expected-tools.mjs';

export const meta = {
  id: 's08b-storage-grace',
  title: '启动门闸：同步 apply（A）+ storageDomain 迟到/超时兜底（B）',
  acceptance: ['S07', 'S08', 'W07'],
  requires: ['index', 'storage'],
};

const FALLBACK_DIR = path.join(WORKSPACE_ROOT, 'tests', 'tmp', 'grace-fallback');

function realSleep(ms) {
  // 注意：这里**不能** unref —— 测试自己的等待必须能撑住事件循环，
  // 否则 Node 会在 top-level await 未 settle 时以 code 13 退出。
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll a diagnostic predicate using bounded real time (the startup gate uses a real timer). */
async function waitFor(predicate, { attempts = 120, stepMs = 10 } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return true;
    await realSleep(stepMs);
  }
  return predicate();
}

export async function run() {
  const indexModule = await loadHostModule('index');
  const storageModule = await loadHostModule('storage');
  if (!indexModule.real || !storageModule.real) {
    return runSuite({
      ...meta,
      pending: true,
      pendingReason: `index/storage 不可加载：${indexModule.error?.message ?? storageModule.error?.message ?? 'not written yet'}`,
    }, null);
  }

  return runSuite(meta, async (suite) => {
    const apply = indexModule.mod.apply;
    const clock = createFakeClock();

    // ---------------------------------------------------------------- A
    {
      const native = createFakeAdapter({ clock });
      const ctx = createFakeContext({ adapter: native, clock });
      const dispose = apply(ctx, { capacity: { globalLeafLimit: 4 } });
      const service = ctx.get('teamWorkbench');
      const codes = (service?.diagnostics?.list?.() ?? []).map((entry) => String(entry.code));
      suite.equal(service !== undefined, true, 'A：apply 同步段就提供了 teamWorkbench 服务');
      suite.equal(ctx.liveCounts().tools, EXPECTED_TEAM_TOOL_COUNT, `A：apply 返回时 ${EXPECTED_TEAM_TOOL_COUNT} 个 team_* 工具已同步注册（未 await）`);
      suite.compare(ctx.liveCounts().webRoutes, '>=', 3, 'A：apply 返回时 web 路由已同步注册（未 await）');
      suite.equal(ctx.liveCounts().commands, 1, 'A：apply 返回时人类命令已同步注册（未 await）');
      suite.assert(
        !codes.some((code) => code.includes('INACTIVE_EFFECT')),
        'A：没有 INACTIVE_EFFECT 诊断（同步注册段成立）',
        codes.filter((code) => code.includes('INACTIVE')),
      );
      suite.assert(
        !codes.some((code) => code.includes('provide-failed') || code.includes('inject')),
        'A：没有 provide/inject 失败诊断',
        codes.filter((code) => code.includes('provide-failed') || code.includes('inject')),
      );
      await dispose();
      await ctx.dispose();
    }

    // ------------------------------------------- B1：storageDomain 迟到挂载
    {
      const native = createFakeAdapter({ clock });
      const ctx = createFakeContext({ adapter: native, clock });
      const domainService = ctx.get('storageDomain');
      suite.equal(ctx.removeService('storageDomain'), true, 'B1：先卸载 storageDomain，模拟它晚于本行挂载');

      const dispose = apply(ctx, { capacity: { globalLeafLimit: 4 }, storageGraceMs: 600 });
      const service = ctx.get('teamWorkbench');
      const codes = () => (service?.diagnostics?.list?.() ?? []).map((entry) => String(entry.code));
      suite.equal(ctx.liveCounts().tools, EXPECTED_TEAM_TOOL_COUNT, 'B1：门闸未 settle 时同步段仍已完成注册');
      suite.equal(codes().includes('host:storage-gate'), false, 'B1：storageDomain 缺席时门闸保持等待（不立刻放弃）');

      // 服务迟到挂载 → 门闸应立即放行并使用 storageDomain。
      ctx.set('storageDomain', domainService);
      const settled = await waitFor(() => codes().includes('host:storage-gate'), { attempts: 60, stepMs: 10 });
      suite.equal(settled, true, 'B1：storageDomain 出现后门闸及时 settle');
      const gateEntry = (service.diagnostics.list() ?? []).find((entry) => entry.code === 'host:storage-gate');
      suite.includes(gateEntry?.message ?? '', 'available:storageDomain', 'B1：门闸记录由 storageDomain 可用触发');
      const booted = await waitFor(() => codes().includes('host:boot'), { attempts: 80, stepMs: 10 });
      suite.assert(booted, 'B1：门闸放行后启动阶段正常完成（host:boot）', codes().slice(-6));
      const snapshot = service.snapshot({ id: 'session-lead' });
      suite.equal(snapshot.storage.backend, 'storageDomain', 'B1：初始化使用 storageDomain 后端');
      suite.equal(snapshot.storage.durable, true, 'B1：storageDomain 后端是持久的');
      suite.equal(snapshot.readOnly, false, 'B1：正常拿到写者，非只读');
      await dispose();
      await ctx.dispose();
    }

    // ------------------------------------------- B2：storageDomain 始终不来
    {
      const previous = process.env.DSH_TEAM_WORKBENCH_DIR;
      process.env.DSH_TEAM_WORKBENCH_DIR = FALLBACK_DIR;
      try {
        const native = createFakeAdapter({ clock });
        const ctx = createFakeContext({ adapter: native, clock });
        ctx.removeService('storageDomain');
        const dispose = apply(ctx, { capacity: { globalLeafLimit: 4 }, storageGraceMs: 30 });
        const service = ctx.get('teamWorkbench');
        const codes = () => (service?.diagnostics?.list?.() ?? []).map((entry) => String(entry.code));

        const timedOut = await waitFor(() => codes().includes('host:storage-gate'), { attempts: 80, stepMs: 10 });
        suite.equal(timedOut, true, 'B2：storageDomain 不来时门闸按 storageGraceMs 有界兜底（不卡死启动）');
        const gateEntry = (service.diagnostics.list() ?? []).find((entry) => entry.code === 'host:storage-gate');
        suite.includes(gateEntry?.message ?? '', 'grace-timeout', 'B2：门闸记录 settle 原因是 grace-timeout');

        const booted = await waitFor(
          () => codes().includes('host:boot') || codes().includes('host:boot-failed'),
          { attempts: 100, stepMs: 10 },
        );
        suite.assert(booted, 'B2：兜底后启动阶段仍然走完（有 host:boot 或 host:boot-failed）', codes().slice(-6));
        const snapshot = service.snapshot({ id: 'session-lead' });
        suite.assert(
          snapshot.storage.backend !== 'storageDomain',
          'B2：首选 storageDomain 不可用时没有谎称用了它（不隐藏缺口）',
          snapshot.storage,
        );
        suite.assert(
          ['json-files', 'memory-only'].includes(snapshot.storage.backend),
          'B2：退回插件自有后端（json-files 持久，或 memory-only 并显式标注不持久）',
          snapshot.storage,
        );
        if (snapshot.storage.backend === 'json-files') {
          suite.equal(snapshot.storage.durable, true, 'B2：json-files 兜底仍然是持久的');
          suite.assert(
            String(snapshot.storage.fallbackDir ?? '').toLowerCase().startsWith(FALLBACK_DIR.toLowerCase()),
            'B2：兜底目录被重定向到 harness 写范围内（DSH_TEAM_WORKBENCH_DIR）',
            snapshot.storage.fallbackDir,
          );
        } else {
          suite.equal(snapshot.storage.durable, false, 'B2：memory-only 时必须显式标注不持久');
          suite.note('B2：环境里连兜底目录都建不起来，退到 memory-only —— 仍留下了明确诊断。');
        }
        suite.assert(
          ['SERVICE_UNAVAILABLE', 'DOMAIN_OPEN_FAILED', 'FALLBACK_FAILED'].includes(snapshot.storage.backendError?.code),
          'B2：backendError 记录了首选后端失败码（不静默）',
          snapshot.storage.backendError,
        );
        await dispose();
        await ctx.dispose();
      } finally {
        if (previous === undefined) delete process.env.DSH_TEAM_WORKBENCH_DIR;
        else process.env.DSH_TEAM_WORKBENCH_DIR = previous;
      }
    }

    const configModule = await loadHostModule('config');
    if (configModule.real) {
      const normalized = configModule.mod.normalizeConfig({});
      suite.assert(
        Number.isFinite(normalized.storageGraceMs) && normalized.storageGraceMs > 0,
        'B：config 里有有界的 storageGraceMs 默认值',
        normalized.storageGraceMs,
      );
    }
  });
}

if (isMain(import.meta.url)) await main(run, meta);
