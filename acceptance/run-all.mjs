/**
 * 一次跑完全部确定性用例并汇总 PASS/FAIL。
 *
 * 用法：
 *   node acceptance/run-all.mjs                 # 人类可读 + 机器可读 JSON
 *   node acceptance/run-all.mjs --json out.json # 同时写聚合 JSON
 *   node acceptance/run-all.mjs --only s02,s06  # 只跑匹配的用例
 *
 * 退出码：0 = 全部 PASS；1 = 有 FAIL / ERROR；2 = 有 PENDING_HOST（未产出真实模块）。
 *
 * 所有用例在**同一进程内**按顺序执行（不经过子进程 stdio），每个用例各自输出
 * 自己的结构化 JSON 到 stdout，聚合结果由本文件给出。
 */
import process from 'node:process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** 用例清单：顺序即依赖顺序（自检在前）。 */
export const SUITES = [
  { id: '00-harness-selfcheck', file: 'tests/00-harness-selfcheck.mjs', area: 'harness' },
  { id: 's02-s03-rolling-refill', file: 'tests/s02-s03-rolling-refill.mjs', area: 'scheduler' },
  { id: 's04-s10-capacity-fairness', file: 'tests/s04-s10-capacity-fairness.mjs', area: 'capacity' },
  { id: 's05-interrupt-scope', file: 'tests/s05-interrupt-scope.mjs', area: 'lifecycle' },
  { id: 's06-determinism', file: 'tests/s06-determinism.mjs', area: 'determinism' },
  { id: 's07-receipt-and-lease', file: 'tests/s07-receipt-and-lease.mjs', area: 'recovery' },
  { id: 's08-restart-recovery', file: 'tests/s08-restart-recovery.mjs', area: 'recovery' },
  { id: 's08b-storage-grace', file: 'tests/s08b-storage-grace.mjs', area: 'lifecycle' },
  { id: 's09-adapter-recovery', file: 'tests/s09-adapter-recovery.mjs', area: 'recovery' },
  { id: 'w01-horizontal-split-policy', file: 'tests/w01-horizontal-split.mjs', area: 'policy' },
  // 团队自治 v1（docs/ARCHITECTURE.md）：实现未到位时红是正确的，不得放宽。
  { id: 'standalone-contract', file: 'tests/standalone-contract.mjs', area: 'autonomy' },
  { id: 't07-targeted-start', file: 'tests/t07-targeted-start.mjs', area: 'autonomy' },
  { id: 't09-horizontal-delivery', file: 'tests/t09-horizontal-delivery.mjs', area: 'autonomy' },
  { id: 't12-boundaries', file: 'tests/t12-boundaries.mjs', area: 'autonomy' },
  { id: 'w03-leaf-brief', file: 'tests/w03-leaf-brief.mjs', area: 'workflow' },
  { id: 'w07-repeated-registration', file: 'tests/w07-repeated-registration.mjs', area: 'lifecycle' },
  { id: 'w06-team-tools', file: 'tests/w06-team-tools.mjs', area: 'tools' },
  { id: 'w08-storage-migration', file: 'tests/w08-storage-migration.mjs', area: 'storage' },
  { id: 'w09-bindable-target-guards', file: 'tests/w09-bindable-target-guards.mjs', area: 'tools' },
  { id: 'w10-storage-key-encoding', file: 'tests/w10-storage-key-encoding.mjs', area: 'storage' },
  // 客户端产物：mini-React 打桩，**simulated**（不是真实页面渲染）
  { id: 'client-bundle-smoke', file: 'tests/client/client-bundle-smoke.mjs', area: 'client' },
];

const argv = process.argv.slice(2);
const jsonFlagIndex = argv.indexOf('--json');
const jsonPath = jsonFlagIndex >= 0 ? argv[jsonFlagIndex + 1] : null;
const onlyIndex = argv.indexOf('--only');
const onlyFilter = onlyIndex >= 0 && argv[onlyIndex + 1]
  ? new Set(String(argv[onlyIndex + 1]).split(',').map((value) => value.trim()).filter(Boolean))
  : null;

function line(char = '─', width = 78) {
  return char.repeat(width);
}

async function main() {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const results = [];
  if (onlyFilter) {
    const unknown = [...onlyFilter].filter((id) => !SUITES.some((suite) => suite.id === id));
    if (unknown.length) throw new Error(`Unknown suite id(s): ${unknown.join(', ')}`);
  }

  console.log(line('═'));
  console.log('DSH 并行工作台 — 确定性验收（真实 Host 模块 + fake native seam）');
  console.log(`工作目录：${ROOT}`);
  console.log(line('═'));

  for (const suite of SUITES) {
    if (onlyFilter && !onlyFilter.has(suite.id)) continue;
    const url = pathToFileURL(path.join(ROOT, suite.file)).href;
    let result;
    try {
      const module = await import(url);
      result = await module.run();
    } catch (error) {
      result = {
        suite: suite.id,
        title: suite.file,
        acceptance: [],
        requires: [],
        simulated: false,
        status: 'ERROR',
        ok: false,
        counts: { total: 0, passed: 0, failed: 1 },
        failures: [{ name: 'suite 加载/执行失败', ok: false, detail: { message: error?.message, stack: String(error?.stack ?? '').split('\n').slice(0, 5) } }],
        notes: [],
        pendingReason: null,
        bodyError: { message: error?.message },
      };
    }
    results.push({ ...result, area: suite.area, file: suite.file });
  }

  const finishedAt = new Date().toISOString();
  const byStatus = results.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {});
  const totals = results.reduce(
    (acc, item) => ({
      checks: acc.checks + (item.counts?.total ?? 0),
      passed: acc.passed + (item.counts?.passed ?? 0),
      failed: acc.failed + (item.counts?.failed ?? 0),
    }),
    { checks: 0, passed: 0, failed: 0 },
  );
  const overall = byStatus.FAIL || byStatus.ERROR ? 'FAIL' : byStatus.PENDING_HOST ? 'PENDING_HOST' : 'PASS';

  console.log('');
  console.log(line());
  console.log('用例汇总');
  console.log(line());
  for (const item of results) {
    const mark = item.status === 'PASS' ? 'PASS' : item.status === 'PENDING_HOST' ? 'PEND' : 'FAIL';
    const counts = `${item.counts.passed}/${item.counts.total}`.padStart(7);
    const sim = item.simulated ? ' [simulated]' : '';
    console.log(`  ${mark}  ${counts}  ${item.suite.padEnd(30)} ${(item.acceptance ?? []).join(',')}${sim}`);
    if (item.status === 'PENDING_HOST') console.log(`        └─ ${item.pendingReason}`);
    for (const failure of item.failures ?? []) {
      const detail = failure.detail === undefined ? '' : ` :: ${JSON.stringify(failure.detail)}`;
      console.log(`        ✗ ${failure.name}${detail.length > 400 ? `${detail.slice(0, 400)}…` : detail}`);
    }
  }
  console.log(line());
  console.log(`  总计：${totals.passed}/${totals.checks} 项断言通过，${totals.failed} 项失败`);
  console.log(`  用例状态：${JSON.stringify(byStatus)}`);
  console.log(`  总体：${overall}`);
  console.log(line('═'));

  const summary = {
    kind: 'dsh-team-workbench/acceptance-summary',
    startedAt,
    finishedAt,
    durationMs: Date.now() - started,
    workspaceRoot: ROOT,
    mode: (() => {
      const simulated = results.filter((item) => item.simulated);
      if (simulated.length === 0) return 'real';
      if (simulated.length === results.length) return 'simulated';
      return `real+simulated(${simulated.map((item) => item.suite).join(',')})`;
    })(),
    overall,
    byStatus,
    totals,
    suites: results,
    honesty: {
      simulatedSuites: results.filter((item) => item.simulated).map((item) => item.suite),
      note: '真实桌面/模型验收不在本文件内；请见 docs/ACCEPTANCE.md，模拟结果不得冒充真实完成。',
    },
  };

  if (jsonPath) {
    const target = path.isAbsolute(jsonPath) ? jsonPath : path.join(ROOT, jsonPath);
    writeFileSync(target, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    console.log(`聚合 JSON 已写入 ${target}`);
  }

  process.stdout.write(`\n#DSH-ACCEPTANCE-JSON#${JSON.stringify(summary)}#/DSH-ACCEPTANCE-JSON#\n`);
  process.exitCode = overall === 'PASS' ? 0 : overall === 'PENDING_HOST' ? 2 : 1;
  return summary;
}

await main();
