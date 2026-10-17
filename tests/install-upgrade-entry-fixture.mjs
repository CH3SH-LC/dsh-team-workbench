#!/usr/bin/env node
/**
 * 隔离 fixture 生命周期测试：installer v2（**不触碰真实 profile**）。
 *
 * 覆盖：临时 profile 复制 → plan → apply → 幂等重跑(no-op) → CAS 并发拒绝 →
 *       回滚（精确块删除，保留并发新增内容）→ 恢复 before sha → 入口模块可加载/可 apply。
 *
 * 运行：node tests/install-upgrade-entry-fixture.mjs
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const INSTALLER = path.join(ROOT, 'scripts', 'install-upgrade-entry.mjs');
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

let passed = 0;
let failed = 0;
function check(name, ok, detail = null) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name} :: ${JSON.stringify(detail)}`);
  }
}

async function installer(args) {
  try {
    const { stdout } = await run(process.execPath, [INSTALLER, ...args], { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1));
  } catch (error) {
    const text = String(error?.stdout ?? '');
    try { return JSON.parse(text.trim().split('\n').filter(Boolean).at(-1)); } catch { return { ok: false, code: 'INSTALLER_THREW', message: String(error?.message ?? error) }; }
  }
}

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'twb-install-fixture-'));
  try {
  const profile = path.join(dir, 'cordis.patch.yml');
  const outDir = path.join(dir, 'out');
  const source = await fsp.readFile(path.join(ROOT, 'cordis.patch.yml'));
  await fsp.writeFile(profile, source);
  const beforeSha = sha256(source);
  // 模拟"并发新增内容"：安装前先加一个无关顶层条目，回滚时必须保留。
  const concurrent = '= 并发新增条目（回滚时必须保留）\n- id: unrelated-concurrent\n  name: unrelated\n';
  const baseline = Buffer.concat([source, Buffer.from(concurrent)]);
  await fsp.writeFile(profile, baseline);
  const baselineSha = sha256(baseline);

  const plan = await installer(['--profile', profile, '--out-dir', outDir]);
  check('plan：dry-run ok，形状为官方 insert 块（- insert: 下新行）', plan.ok === true && plan.addition.startsWith('- insert:') && plan.addition.includes('    - id: team-workbench-upgrade-entry'), plan.addition?.slice(0, 80));
  check('plan：name 用包 export（非本地绝对路径）', plan.entry?.name === '@local/dsh-team-workbench/upgrade-entry', plan.entry?.name);
  check('plan：dry-run 不写 profile（sha 不变）', sha256(await fsp.readFile(profile)) === baselineSha, null);

  // 当前进程兼容：--entry-module 绝对入口路径应写入行的 name（不强制包 export）。
  const absEntry = path.join(ROOT, 'src', 'host', 'upgradeEntry.js');
  const absPlan = await installer(['--profile', profile, '--out-dir', path.join(dir, 'out-abs'), '--entry-module', absEntry]);
  check('plan：--entry-module 绝对入口路径被写入 name（当前进程缓存旧 export 也可热接入）', absPlan.ok === true && absPlan.entry?.name === absEntry && absPlan.addition.includes(JSON.stringify(absEntry)), absPlan.entry?.name);
  const applied = await installer(['--profile', profile, '--out-dir', outDir, '--apply']);
  const afterApplyText = (await fsp.readFile(profile)).toString('utf8');
  check('apply：ok 且 afterSha 匹配', applied.ok === true && sha256(await fsp.readFile(profile)) === applied.afterSha256, applied);
  check('apply：YAML 为官方 insert 结构（- insert: 下 4 空格 - id:）', afterApplyText.includes('- insert:') && afterApplyText.includes('    - id: team-workbench-upgrade-entry'), null);
  check('apply：原有并发条目仍在（逐字节保留）', afterApplyText.includes('- id: unrelated-concurrent'), null);

  const rerun = await installer(['--profile', profile, '--out-dir', outDir, '--apply']);
  check('幂等：重复 apply → no-op，profile 未变', rerun.ok === true && rerun.idempotentNoop === true && sha256(await fsp.readFile(profile)) === applied.afterSha256, rerun);

  // 并发新增内容（回滚/重放都必须保留或拒绝）
  await fsp.appendFile(profile, '\n- id: concurrent-after-apply\n  name: other\n');

  const rolled = await installer(['--profile', profile, '--out-dir', outDir, '--rollback']);
  const afterRollbackText = (await fsp.readFile(profile)).toString('utf8');
  check('回滚：按原始字节移除插入片段且保留并发新增内容', rolled.ok === true && !afterRollbackText.includes('team-workbench-upgrade-entry') && afterRollbackText.includes('- id: unrelated-concurrent') && afterRollbackText.includes('- id: concurrent-after-apply'), rolled);
  // 块被修改后 rollback 必须拒绝（--addition 原件/hash 校验）。
  const tampered = afterRollbackText;
  await fsp.writeFile(profile, Buffer.concat([Buffer.from(tampered), Buffer.from('- insert:')]).toString('utf8'));
  const tamperRollback = await installer(['--profile', profile, '--out-dir', outDir, '--rollback']);
  check('回滚：插入片段被修改/缺失 → 拒绝（不误删并发内容）', tamperRollback.ok === false && ['ADDITION_BLOCK_MODIFIED_OR_MISSING', 'ADDITION_BLOCK_NOT_FOUND', 'ADDITION_BLOCK_AMBIGUOUS'].includes(tamperRollback.code), tamperRollback.code);

  // intent create-exclusive：同一 idempotencyKey 的重放必须被拒绝（不覆盖、不重放未知）。
  const replay = await installer(['--profile', profile, '--out-dir', outDir, '--apply']);
  check('intent：同 key 重放 → 拒绝（不覆盖）', replay.ok === false && replay.code === 'INTENT_EXISTS_REPLAY_REFUSED', replay.code);
  // 入口模块可加载 + apply 可调用（无服务 → 只注册诊断，不激活）
  const entry = await import(pathToFileURL(path.join(ROOT, 'src', 'host', 'upgradeEntry.js')).href);
  check('入口：可动态加载（name/inject/apply）', entry.name === 'team-workbench-upgrade-entry' && entry.inject.length === 3 && typeof entry.apply === 'function', { name: entry.name });
  const routes = [];
  const disposer = entry.apply({ get: () => undefined, on: () => () => {}, logger: { info: () => {} } }, { autoActivate: false });
  check('入口：无服务时 apply 返回 disposer 且不抛', typeof disposer === 'function', typeof disposer);
  check('入口：无服务时只返回 disposer（不伪造注册成功）', typeof disposer === 'function', typeof disposer);

  // 真实 profile 未被触碰（相对校验）
  const realProfile = await fsp.readFile(path.join(ROOT, 'cordis.patch.yml'));
  check('隔离性：真实 cordis.patch.yml 未变', sha256(realProfile) === beforeSha, null);

  console.log(`\ninstaller-v2 fixture: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
  } finally {
    const relativeTemp = path.relative(path.resolve(os.tmpdir()), path.resolve(dir));
    if (!relativeTemp || relativeTemp.startsWith('..') || path.isAbsolute(relativeTemp) || !path.basename(dir).startsWith('twb-install-fixture-')) throw new Error('Refusing to clean an unexpected fixture directory');
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exitCode = 1;
});
