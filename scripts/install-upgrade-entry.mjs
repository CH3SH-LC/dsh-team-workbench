#!/usr/bin/env node
/**
 * `install-upgrade-entry.mjs` — 热接入 `upgrade-entry` 插件行的安装器 **v2**。
 *
 * 通过 Cordis insert 补丁添加入口，保持 profile 中已有内容：
 * - YAML 形状：profile 顶层是序列，新行作为**独立顶层条目**追加：
 *     - id: team-workbench-upgrade-entry
 *       name: '@local/dsh-team-workbench/upgrade-entry'
 *       config: { autoActivate: false, ... }
 * - `name` 用**包 export**（Loader 只读 options.name），不用本地绝对文件路径。
 * - 写入：Buffer 逐字节保留原 profile；`before sha256` CAS 校验；`tmp → rename`；intent/receipt `wx` create-exclusive。
 * - 回滚：按 `- id:` 精确块删除（保留并发新增内容），块不存在/不一致则拒绝并给证据。
 *
 * 用法：
 *   node scripts/install-upgrade-entry.mjs --profile <path>                    # dry-run（默认）
 *   node scripts/install-upgrade-entry.mjs --profile <path> --apply
 *   node scripts/install-upgrade-entry.mjs --profile <path> --rollback [--addition-sha256 <sha>]
 *   [--installable-entry <abs>] [--skills-upgrade-entry <abs>] [--out-dir <dir>]
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DEFAULT_OUT = path.join(REPO_ROOT, '.runtime', 'team-workbench');

const ENTRY_ID = 'team-workbench-upgrade-entry';
const ENTRY_NAME = '@local/dsh-team-workbench/upgrade-entry';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function argOf(argv, name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : true;
}

const argv = process.argv.slice(2);
const profilePath = argOf(argv, 'profile');
const outDir = argOf(argv, 'out-dir') ?? DEFAULT_OUT;
const apply = argv.includes('--apply');
const rollback = argv.includes('--rollback');
const installableEntry = argOf(argv, 'installable-entry');
const skillsUpgradeEntry = argOf(argv, 'skills-upgrade-entry');
// 当前运行进程可能缓存旧包导出（baseline package.json 无 ./upgrade-entry）；允许已核实的绝对入口路径。
const entryModuleArg = argOf(argv, 'entry-module');
const entryName = typeof entryModuleArg === 'string' && entryModuleArg ? entryModuleArg : ENTRY_NAME;

if (!profilePath) {
  console.error(JSON.stringify({ ok: false, code: 'PROFILE_REQUIRED' }));
  process.exitCode = 2;
  process.exit();
}

/** 顶层序列条目（缩进 0），内部键 2/4 空格。 */
function buildAddition() {
  // 官方 cordis-plugin-include.applyEntryPatches：非 insert 只修改现有行，新 id 不存在会 warn+skip；
  // 必须追加 `- insert:`，其中每项是新插件行。
  const config = [
    '        autoActivate: false',
    `        installableEntry: ${installableEntry ? JSON.stringify(String(installableEntry)) : 'null'}`,
    `        skillsUpgradeEntry: ${skillsUpgradeEntry ? JSON.stringify(String(skillsUpgradeEntry)) : 'null'}`,
  ].join('\n');
  return [
    '- insert:',
    `    - id: ${ENTRY_ID}`,
    `      name: ${JSON.stringify(entryName)}`,
    '      config:',
    config,
    '',
  ].join('\n');
}

const ADDITION = buildAddition();
const ADDITION_BUFFER = Buffer.from(ADDITION, 'utf8');
const ADDITION_SHA = sha256(ADDITION_BUFFER);

async function writeExclusive(file, text) {
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, text, { encoding: 'utf8', flag: 'wx' });
    return { ok: true, file };
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const existing = await fsp.readFile(file, 'utf8').catch(() => '');
      return { ok: false, file, code: 'EXISTS', same: existing === text };
    }
    return { ok: false, file, code: 'WRITE_FAILED', message: String(error?.message ?? error) };
  }
}

async function writeJson(name, value) {
  return writeExclusive(path.join(outDir, name), JSON.stringify(value, null, 2));
}

/** 按 `- id:` 定位精确块（到下一个顶层 `- ` 或文件尾）。 */
function locateBlock(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimStart().startsWith(`- id: ${ENTRY_ID}`) && line.length === line.trimStart().length);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !(lines[end].length === lines[end].trimStart().length && lines[end].startsWith('- '))) end += 1;
  return { start, end, lines };
}

async function atomicWrite(file, buffer) {
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, buffer, { flag: 'wx' });
  await fsp.rename(temp, file);
}

async function main() {
  let beforeBuffer;
  try {
    beforeBuffer = await fsp.readFile(profilePath);
  } catch (error) {
    const plan = { kind: 'team-workbench/upgrade-entry-install-plan', ok: false, code: 'PROFILE_NOT_FOUND', profilePath, message: String(error?.message ?? error) };
    await writeJson('upgrade-entry-install-plan.json', plan);
    console.log(JSON.stringify(plan));
    process.exitCode = 2;
    return;
  }
  const beforeText = beforeBuffer.toString('utf8');
  const beforeSha = sha256(beforeBuffer);
  const alreadyInstalled = beforeText.split(/\r?\n/).some((line) => line.trim() === `- id: ${ENTRY_ID}`);
  const needsNewline = beforeText.length > 0 && !beforeText.endsWith('\n');
  const nextText = alreadyInstalled ? beforeText : `${beforeText}${needsNewline ? '\n' : ''}${ADDITION}`;
  const nextBuffer = Buffer.from(nextText, 'utf8');
  const nextSha = sha256(nextBuffer);

  const plan = {
    kind: 'team-workbench/upgrade-entry-install-plan',
    ok: true,
    dryRun: !apply,
    profilePath,
    entry: { id: ENTRY_ID, name: entryName, config: { autoActivate: false, installableEntry: installableEntry ?? null, skillsUpgradeEntry: skillsUpgradeEntry ?? null } },
    addition: ADDITION,
    additionSha256: ADDITION_SHA,
    alreadyInstalled,
    idempotentNoop: alreadyInstalled,
    beforeSha256: beforeSha,
    afterSha256: alreadyInstalled ? beforeSha : nextSha,
    oldBytesKept: !alreadyInstalled,
    rollback: {
      command: `node scripts/install-upgrade-entry.mjs --profile ${JSON.stringify(profilePath)} --rollback --out-dir ${JSON.stringify(outDir)}`,
      semantics: '按 - id: 精确定位块删除（保留并发新增内容）；块缺失/不一致 → 拒绝并给证据',
    },
  };
  await writeJson('upgrade-entry-install-plan.json', plan);

  if (rollback) {
    const current = await fsp.readFile(profilePath).catch(() => null);
    if (!current) {
      console.log(JSON.stringify({ kind: 'team-workbench/upgrade-entry-install-receipt', action: 'rollback', ok: false, code: 'PROFILE_NOT_FOUND', profilePath }));
      return;
    }
    // 必须按**原始字节**定位本次添加片段：块被修改（如 autoActivate 被改）→ 拒绝，保留全部字节。
    const currentBuffer = current;
    const firstHit = currentBuffer.indexOf(Buffer.from(ADDITION, 'utf8'));
    const secondHit = firstHit >= 0 ? currentBuffer.indexOf(Buffer.from(ADDITION, 'utf8'), firstHit + 1) : -1;
    if (firstHit < 0 || secondHit >= 0) {
      const receipt = { kind: 'team-workbench/upgrade-entry-install-receipt', action: 'rollback', ok: false, code: firstHit < 0 ? 'ADDITION_BLOCK_MODIFIED_OR_MISSING' : 'ADDITION_BLOCK_AMBIGUOUS', profilePath, additionSha256: ADDITION_SHA };
      await writeJson('upgrade-entry-install-receipt.json', receipt);
      console.log(JSON.stringify(receipt));
      process.exitCode = 3;
      return;
    }
    const cleanedBuffer = Buffer.concat([currentBuffer.subarray(0, firstHit), currentBuffer.subarray(firstHit + ADDITION_BUFFER.length)]);
    const removed = [ADDITION];
    await atomicWrite(profilePath, cleanedBuffer);
    const receipt = {
      kind: 'team-workbench/upgrade-entry-install-receipt',
      action: 'rollback',
      ok: true,
      profilePath,
      removedBlockSha256: sha256(Buffer.from(removed.join('\n'), 'utf8')),
      expectedAdditionSha256: ADDITION_SHA,
      beforeSha256: beforeSha,
      afterSha256: sha256(cleanedBuffer),
      restoredExactly: sha256(cleanedBuffer) === beforeSha,
      concurrentContentPreserved: !removed.join('\n').includes('name:'),
    };
    await writeJson('upgrade-entry-install-receipt.json', receipt);
    console.log(JSON.stringify(receipt));
    return;
  }

  if (!apply || alreadyInstalled) {
    console.log(JSON.stringify({ ...plan, action: alreadyInstalled ? 'noop' : 'dry-run' }));
    return;
  }

  const intent = {
    kind: 'team-workbench/upgrade-entry-install-intent',
    idempotencyKey: sha256(Buffer.from(`${profilePath}|${beforeSha}|${ADDITION_SHA}`)),
    at: Date.now(),
    profilePath,
    beforeSha256: beforeSha,
    afterSha256: nextSha,
    additionSha256: ADDITION_SHA,
  };
  const intentWrite = await writeJson('upgrade-entry-install-intent.json', intent);
  if (!intentWrite.ok) {
    console.log(JSON.stringify({ kind: 'team-workbench/upgrade-entry-install-receipt', action: 'apply', ok: false, code: 'INTENT_EXISTS_REPLAY_REFUSED', intent: intentWrite }));
    process.exitCode = 4;
    return;
  }
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, 'upgrade-entry-profile-before.yml'), beforeBuffer, { flag: 'w' });

  // CAS：写前再读，sha 必须与 plan 时一致（并发修改 → 拒绝，不覆盖）。
  const cas = await fsp.readFile(profilePath);
  if (sha256(cas) !== beforeSha) {
    const receipt = { kind: 'team-workbench/upgrade-entry-install-receipt', action: 'apply', ok: false, code: 'CAS_MISMATCH', expected: beforeSha, actual: sha256(cas), profilePath };
    await writeJson('upgrade-entry-install-receipt.json', receipt);
    console.log(JSON.stringify(receipt));
    process.exitCode = 5;
    return;
  }

  try {
    await atomicWrite(profilePath, nextBuffer);
    const written = await fsp.readFile(profilePath);
    const writtenSha = sha256(written);
    if (writtenSha !== nextSha) throw new Error(`APPLY_SHA_MISMATCH written=${writtenSha} expected=${nextSha}`);
    const receipt = {
      kind: 'team-workbench/upgrade-entry-install-receipt',
      action: 'apply',
      ok: true,
      at: Date.now(),
      profilePath,
      entry: plan.entry,
      beforeSha256: beforeSha,
      afterSha256: writtenSha,
      additionSha256: ADDITION_SHA,
      backupPath: path.join(outDir, 'upgrade-entry-profile-before.yml'),
      next: [
        '等待 plugins/events 出现 upgrade-entry 行（同一 PID，不重启）',
        'GET /plugin/team-workbench-upgrade/plan（x-team-workbench 头）只读预检',
        "POST /plugin/team-workbench-upgrade/activate {confirm:'activate', installableEntry}",
      ],
    };
    await writeJson('upgrade-entry-install-receipt.json', receipt);
    console.log(JSON.stringify(receipt));
  } catch (error) {
    // 精确块回滚（不整文件替换）：删除刚追加的块。
    const currentText = (await fsp.readFile(profilePath).catch(() => null))?.toString('utf8') ?? '';
    const located = locateBlock(currentText);
    if (located) {
      const removed = located.lines.splice(located.start, located.end - located.start);
      await atomicWrite(profilePath, Buffer.from(located.lines.join('\n'), 'utf8'));
      void removed;
    }
    const receipt = { kind: 'team-workbench/upgrade-entry-install-receipt', action: 'apply', ok: false, code: 'APPLY_FAILED_ROLLED_BACK', message: String(error?.message ?? error), profilePath };
    await writeJson('upgrade-entry-install-receipt.json', receipt);
    console.error(JSON.stringify(receipt));
    process.exitCode = 6;
  }
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exitCode = 1;
});
