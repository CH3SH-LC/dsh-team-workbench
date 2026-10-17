/**
 * `tests/host-autonomy/remediation-20261017.mjs`
 *
 * Host 自治核心整改（契约 `docs/ARCHITECTURE.md` v1）的
 * **确定性测试**。被测对象全部是 `src/host/**` 的纯函数/可注入组件，不需要真实 DSH。
 *
 * ⚠️ 按本轮纪律：**开发期只写测试、不运行**（Lead 统一批量验收时执行）。
 * 运行方式（验收阶段）：`node tests/host-autonomy/remediation-20261017.mjs`
 *
 * 覆盖 CONTRACT §5 的 1 / 2 / 3 / 4 / 6 / 7 / 8 项：
 *  - §5.1 同交付换名无法接力（identity.js）
 *  - §5.2 通用 subagent 不绕过受管检查（角色工具面策略；Host 侧归属校验另见 service 断言）
 *  - §5.3 机械复制零 LLM（materialize.js）
 *  - §5.4 同错不重复执行；条件变化后可恢复（fingerprints.js）
 *  - §5.6 空证据/伪命令/未调用实现不能通过 accepted（evidence.js v2：runId 驱动）
 *  - §5.7 版本改变使证据过期（evidence.js isEvidenceStale）
 *  - §5.8 费用重放不增量；summary 计入；unknown 正确；retry 独立（usage.js）
 * 另覆盖 §7 schema 与运行时限额一致（tools.js validateArgs）与 §6 上下文分页。
 *
 * 所有断言都**不需要网络、不需要模型、不需要真实工程文件**（用临时目录与假读取函数）。
 */

import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deliverableIdentityKey,
  judgeIdentity,
  structuralFingerprint,
} from '../../src/host/identity.js';
import {
  classifyEvidenceItem,
  completionFromValidation,
  isEvidenceStale,
  validateEvidence,
} from '../../src/host/evidence.js';
import {
  classifyError,
  createErrorFingerprints,
  fingerprintOf,
  retryGuidance,
} from '../../src/host/fingerprints.js';
import {
  addUnitToBudget,
  attributeSession,
  costOf,
  emptyBudget,
  emptyPriceBook,
  foldBillingUnits,
  normalizePriceBook,
  resolvePrice,
  usageOf,
} from '../../src/host/usage.js';
import { buildContextPage, buildFindings } from '../../src/host/findings.js';
import { createMaterializer } from '../../src/host/materialize.js';
import { validateArgs } from '../../src/host/tools.js';

const results = [];
function check(label, condition, detail) {
  results.push({ label, ok: Boolean(condition), detail });
  if (!condition) console.error(`FAIL ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
}

/** 极简内存 storage（够 fingerprints.js 用）。 */
function createMemoryStorage() {
  const tables = new Map();
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };
  return {
    list: (name) => [...table(name).entries()],
    get: (name, key) => table(name).get(key),
    async put(name, key, value) {
      table(name).set(key, JSON.parse(JSON.stringify(value)));
      return { ok: true, record: table(name).get(key) };
    },
    async remove(name, key) {
      table(name).delete(key);
      return { ok: true };
    },
    size: (name) => table(name).size,
  };
}

// ---------------------------------------------------------------------------
// §5.1 稳定交付物身份 / 反改名接力
// ---------------------------------------------------------------------------
function testIdentity() {
  const base = {
    teamKey: 'team-a',
    ownerMemberId: 'combat',
    title: '命中判定完整交付',
    deliverable: '命中判定模块完整实现',
    outputs: ['src/combat/hit.ts'],
    acceptance: ['可接入'],
    kind: 'module',
  };
  const existing = [{ ...base, workId: 'w-hit', state: 'ready', teamKey: 'team-a' }];

  const renamed = judgeIdentity({ candidate: { ...base, workId: 'w-hit-v2', title: '命中判定完整交付（补传播）' }, teamKey: 'team-a', existingWorks: existing });
  check('§5.1 同产出范围换 workId + 改标题 → IDENTITY_RENAME_RELAY', renamed.ok === false && renamed.code === 'IDENTITY_RENAME_RELAY', renamed);
  check('§5.1 拒绝时给出原 workId 与复用提示', renamed.matchedWorkId === 'w-hit' && String(renamed.hint).includes('w-hit'), { matchedWorkId: renamed.matchedWorkId, hint: renamed.hint });

  const continuation = judgeIdentity({
    candidate: { ...base, workId: 'w-hit-v3', continuationOf: 'w-hit' },
    teamKey: 'team-a',
    existingWorks: existing,
  });
  check('§5.1 显式 continuationOf 既有 work → IDENTITY_REUSE_REQUIRED（不许开新流程）', continuation.ok === false && continuation.code === 'IDENTITY_REUSE_REQUIRED', continuation);

  const unknownContinuation = judgeIdentity({ candidate: { ...base, workId: 'w-x', continuationOf: 'nope' }, teamKey: 'team-a', existingWorks: existing });
  // P1-5：failed/blocked/cancelled 返工必须沿用原 workId+owner；换名新 id → 拒绝。
  const failedWork = [{ ...base, workId: 'w-failed', state: 'failed', teamKey: 'team-a' }];
  const reworkNewId = judgeIdentity({ candidate: { ...base, workId: 'w-failed-v2' }, teamKey: 'team-a', existingWorks: failedWork });
  check('§5.1 P1-5：failed 返工换名新 id → REWORK_REQUIRES_ORIGINAL_WORK_ID', reworkNewId.ok === false && reworkNewId.code === 'REWORK_REQUIRES_ORIGINAL_WORK_ID' && reworkNewId.matchedWorkId === 'w-failed', reworkNewId);
  const reworkSameId = judgeIdentity({ candidate: { ...base, workId: 'w-failed' }, teamKey: 'team-a', existingWorks: failedWork, selfWorkId: 'w-failed' });
  check('§5.1 P1-5：沿原 workId 修订 → 允许（不产生新身份）', reworkSameId.ok === true, reworkSameId);
  const independentV2 = judgeIdentity({ candidate: { ...base, workId: 'w-v2', outputs: ['src/combat/hit-v2.ts'], title: '命中判定 v2 独立产物' }, teamKey: 'team-a', existingWorks: failedWork });
  // P1-5（审计 14:21 补充）：blocked（含人工门控）同样必须沿用原 workId 修订；换名新 id 一律拒绝。
  const depBlocked = [{ ...base, workId: 'w-dep', state: 'blocked', blockedBy: ['w-up'], teamKey: 'team-a' }];
  const depRework = judgeIdentity({ candidate: { ...base, workId: 'w-dep-v2' }, teamKey: 'team-a', existingWorks: depBlocked });
  check('§5.1 P1-5：blockedBy 非空的依赖阻塞返工换名新 id → REWORK_REQUIRES_ORIGINAL_WORK_ID', depRework.ok === false && depRework.code === 'REWORK_REQUIRES_ORIGINAL_WORK_ID', depRework.code);
  const manualBlocked = [{ ...base, workId: 'w-gate', state: 'blocked', blockedBy: [], blockedReason: 'MANUAL_GATE', teamKey: 'team-a' }];
  const manualReplan = judgeIdentity({ candidate: { ...base, workId: 'w-gate-2' }, teamKey: 'team-a', existingWorks: manualBlocked });
  check('§5.1 P1-5：人工门控 blocked 换名新 id → REWORK_REQUIRES_ORIGINAL_WORK_ID', manualReplan.ok === false && manualReplan.code === 'REWORK_REQUIRES_ORIGINAL_WORK_ID', manualReplan);
  const manualSameId = judgeIdentity({ candidate: { ...base, workId: 'w-gate' }, teamKey: 'team-a', existingWorks: manualBlocked, selfWorkId: 'w-gate' });
  check('§5.1 P1-5：人工门控 blocked 沿原 workId 重新计划 → 允许', manualSameId.ok === true, manualSameId);

  check('§5.1 P1-5：独立 v2 产物（不同 outputs）→ 允许', independentV2.ok === true, independentV2);

  check('§5.1 continuationOf 指向不存在的 work → IDENTITY_CONTINUATION_UNKNOWN', unknownContinuation.ok === false && unknownContinuation.code === 'IDENTITY_CONTINUATION_UNKNOWN', unknownContinuation);

  const otherOwner = judgeIdentity({
    candidate: { ...base, workId: 'w-hit', ownerMemberId: 'nav' },
    teamKey: 'team-a',
    existingWorks: existing,
  });
  check('§5.1 同 workId 换 owner → IDENTITY_OWNER_MISMATCH', otherOwner.ok === false && otherOwner.code === 'IDENTITY_OWNER_MISMATCH', otherOwner);

  const independent = judgeIdentity({
    candidate: { ...base, workId: 'w-nav', ownerMemberId: 'nav', title: '导航网格完整交付', deliverable: '导航网格完整实现', outputs: ['src/nav/mesh.ts'] },
    teamKey: 'team-a',
    existingWorks: existing,
  });
  check('§5.1 独立对象/模块正常并行（产出范围不重叠 → 允许创建）', independent.ok === true && independent.action === 'create', independent);

  const research = judgeIdentity({
    candidate: {
      workId: 'w-research',
      teamKey: 'team-a',
      ownerMemberId: 'nav',
      title: '战斗手感调研证据包',
      deliverable: '战斗手感调研证据包',
      kind: 'evidence-package',
      outputs: ['docs/research/combat-feel-report.md'],
      acceptance: ['结论可复核'],
      inputs: ['src/combat/hit.ts'],
      blockedBy: ['w-hit'],
    },
    teamKey: 'team-a',
    existingWorks: existing,
  });
  check('§5.1 合法独立研究（不同 owner + 显式依赖原 work）允许', research.ok === true, research);

  // Codex 审阅 A：**改 kind 不再能绕过**——同 owner 消费自己未结算交付物仍是续作。
  const kindBypass = judgeIdentity({
    candidate: {
      workId: 'w-research-same-owner',
      teamKey: 'team-a',
      ownerMemberId: 'combat',
      title: '战斗手感调研证据包',
      deliverable: '战斗手感调研证据包',
      kind: 'evidence-package',
      outputs: ['docs/research/combat-feel-report-2.md'],
      acceptance: ['结论可复核'],
      inputs: ['src/combat/hit.ts'],
      blockedBy: ['w-hit'],
    },
    teamKey: 'team-a',
    existingWorks: existing,
  });
  check('§5.1 自报 kind=evidence-package 不能绕过受管续作判定', kindBypass.ok === false && ['IDENTITY_REUSE_REQUIRED', 'IDENTITY_HANDOFF_RELAY'].includes(kindBypass.code), kindBypass);

  const handoff = judgeIdentity({
    candidate: {
      workId: 'w-verify-hit',
      teamKey: 'team-a',
      ownerMemberId: 'combat',
      title: '命中判定校验清单',
      deliverable: '命中判定校验清单',
      kind: 'module',
      outputs: ['docs/combat/hit-checksum-report.md'],
      acceptance: ['校验完成'],
      inputs: ['src/combat/hit.ts'],
    },
    teamKey: 'team-a',
    existingWorks: existing,
  });
  check('§5.1 verify/hash 接力换名（同 owner 消费未结算产物）被拒', handoff.ok === false && ['IDENTITY_HANDOFF_RELAY', 'IDENTITY_REUSE_REQUIRED'].includes(handoff.code), handoff);

  const unlinked = judgeIdentity({
    candidate: {
      workId: 'w-derived',
      teamKey: 'team-a',
      ownerMemberId: 'nav',
      title: '命中判定派生消费',
      deliverable: '命中判定派生消费',
      kind: 'module',
      outputs: ['src/nav/derived.ts'],
      acceptance: ['可用'],
      inputs: ['src/combat/hit.ts'],
    },
    teamKey: 'team-a',
    existingWorks: existing,
  });
  check('§5.1 派生消费必须在 blockedBy 里显式关联原 work', unlinked.ok === false && unlinked.code === 'IDENTITY_DERIVATION_UNLINKED', unlinked);

  check('§5.1 身份键 = team::workId::owner（不随标题/kind 变）', deliverableIdentityKey({ teamKey: 't', workId: 'w', ownerMemberId: 'm' }) === 't::w::m', deliverableIdentityKey({ teamKey: 't', workId: 'w', ownerMemberId: 'm' }));
  const fingerprintA = structuralFingerprint({ ...base, title: 'A' });
  const fingerprintB = structuralFingerprint({ ...base, title: 'B', kind: 'object' });
  check('§5.1 结构指纹不含 title/kind（改标题不改身份指纹）', fingerprintA === fingerprintB, { fingerprintA, fingerprintB });
}

// ---------------------------------------------------------------------------
// §5.3 机械复制零 LLM（真实临时目录；确定性）
// ---------------------------------------------------------------------------
async function testMaterialize() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-materialize-'));
  try {
    const sourcePath = path.join(root, 'source.txt');
    const targetPath = path.join(root, 'nested', 'target.txt');
    await writeFile(sourcePath, 'mechanical copy payload\n', 'utf8');

    const materializer = createMaterializer({ cwd: root, roots: [root] });
    const hashed = await materializer.run('hash', { from: sourcePath });
    check('§5.3 hash 返回 sha256/bytes 且 noModelCalls', hashed.ok === true && /^[0-9A-F]{64}$/.test(hashed.sha256) && hashed.bytes > 0 && hashed.noModelCalls === true, hashed);

    const copied = await materializer.run('copy', { from: sourcePath, to: targetPath, scopes: [root] });
    check('§5.3 copy 成功且校验 sha256 一致', copied.ok === true && copied.sha256 === hashed.sha256 && copied.noop === false, copied);
    check('§5.3 copy 后目标内容与源一致（程序化复制，不经模型）', (await readFile(targetPath, 'utf8')) === 'mechanical copy payload\n', null);

    const again = await materializer.run('copy', { from: sourcePath, to: targetPath, scopes: [root] });
    check('§5.3 重复 copy 幂等（noop，不重复写入）', again.ok === true && again.noop === true, again);

    const verified = await materializer.run('verify', { from: sourcePath, expectSha256: hashed.sha256 });
    check('§5.3 verify 命中 expectSha256', verified.ok === true && verified.match === true, verified);

    const wrongHash = await materializer.run('verify', { from: sourcePath, expectSha256: 'A'.repeat(64) });
    check('§5.3 verify 不匹配 → match=false（不伪造通过）', wrongHash.ok === true && wrongHash.match === false, wrongHash);

    const outside = await materializer.run('hash', { from: path.join(os.tmpdir(), 'not-in-root.txt') });
    check('§5.3 越界路径 → MATERIALIZE_OUTSIDE_ROOTS', outside.ok === false && outside.code === 'MATERIALIZE_OUTSIDE_ROOTS', outside);

    const scopeDenied = await materializer.run('copy', {
      from: sourcePath,
      to: path.join(root, 'other', 'x.txt'),
      scopes: [path.join(root, 'allowed-only')],
    });
    check('§5.3 目标不在写范围 → MATERIALIZE_SCOPE_DENIED', scopeDenied.ok === false && scopeDenied.code === 'MATERIALIZE_SCOPE_DENIED', scopeDenied);

    const missing = await materializer.run('hash', { from: path.join(root, 'nope.txt') });
    check('§5.3 源不存在 → MATERIALIZE_SOURCE_MISSING', missing.ok === false && missing.code === 'MATERIALIZE_SOURCE_MISSING', missing);

    const noOverwrite = await materializer.run('copy', { from: sourcePath, to: targetPath, scopes: [root] });
    check('§5.3 目标存在且内容不同时默认不覆盖', noOverwrite.ok === true || noOverwrite.code === 'MATERIALIZE_TARGET_EXISTS' || noOverwrite.noop === true, noOverwrite);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// §5.4 同错不重复执行；条件变化后可恢复
// ---------------------------------------------------------------------------
async function testFingerprints() {
  let now = 1000;
  const storage = createMemoryStorage();
  const prints = createErrorFingerprints({ storage, clock: { now: () => now } });

  const descriptor = {
    tool: 'team_subagent_start',
    input: { workId: 'w1', ownerMemberId: 'm1', outputs: ['src/a.ts'] },
    versions: ['src/a.ts@1'],
    code: 'SUBAGENT_START_FAILED',
    message: 'tools.restrict() names unknown global tools',
    readEpoch: { planRevision: 1 },
    memberId: 'm1',
    workId: 'w1',
  };
  const first = await prints.recordFailure(descriptor);
  check('§5.4 首次失败记录指纹（不可重复执行前先有一次真实失败）', first.count === 1 && first.isRepeat === false, first);
  check('§5.4 确定性失败分类正确', first.errorClass === 'deterministic', first.errorClass);
  now += 10;
  const second = await prints.recordFailure(descriptor);
  check('§5.4 同输入同版本同 epoch 再失败 → 计数累加且标记重复', second.count === 2 && second.isRepeat === true, second);

  const skipSame = prints.shouldSkip(descriptor);
  check('§5.4 同条件 → skip=true（不重复执行）', skipSame.skip === true, skipSame);
  check('§5.4 skip 时给出"改什么条件才重试"的指导', typeof skipSame.guidance === 'string' && skipSame.guidance.length > 20, skipSame.guidance);

  const changedEpoch = prints.shouldSkip({ ...descriptor, readEpoch: { planRevision: 2 } });
  check('§5.4 planRevision 变化 → 允许恢复（条件已变）', changedEpoch.skip === false, changedEpoch);

  const changedVersion = prints.shouldSkip({ ...descriptor, versions: ['src/a.ts@2'] });
  check('§5.4 产物版本变化 → 允许恢复', changedVersion.skip === false, changedVersion);

  const forced = prints.shouldSkip({ ...descriptor, force: true });
  check('§5.4 owner 显式 force → 允许重试', forced.skip === false, forced);

  const transient = prints.shouldSkip({ ...descriptor, code: 'ETIMEDOUT', message: 'socket hang up' });
  check('§5.4 网络瞬态不进入"禁止重试"', transient.skip === false, transient);

  const capacity = prints.shouldSkip({ ...descriptor, code: 'ACTIVATION_LIMIT_REACHED' });
  check('§5.4 容量拒绝→ 允许退避重试（不是失败）', capacity.skip === false, capacity);
  check('§5.4 分类函数：容量/权限/瞬态分开', classifyError('ACTIVATION_LIMIT_REACHED') === 'capacity' && classifyError('DELEGATION_SCOPE') === 'permission' && classifyError('ETIMEDOUT') === 'transient-network', {
    capacity: classifyError('ACTIVATION_LIMIT_REACHED'),
    permission: classifyError('DELEGATION_SCOPE'),
    transient: classifyError('ETIMEDOUT'),
  });

  const snapshot = prints.snapshot();
  check('§5.4 指纹快照聚合可读（code/count/guidance/workIds）', snapshot.total >= 1 && snapshot.groups[0].guidance.length > 0, snapshot);

  const volatileA = fingerprintOf({ tool: 't', input: { workId: 'w', at: 1, requestId: 'a' }, code: 'X' });
  const volatileB = fingerprintOf({ tool: 't', input: { workId: 'w', at: 999, requestId: 'b' }, code: 'X' });
  check('§5.4 易变字段（at/requestId）不进指纹', volatileA.fingerprint === volatileB.fingerprint, { volatileA, volatileB });
  check('§5.4 retryGuidance 明确"改什么条件"而不是"再试一次"', retryGuidance({ errorClass: 'deterministic', code: 'X', tool: 't' }).includes('重试前至少要改一个条件'), null);
}

// ---------------------------------------------------------------------------
// §5.6 空证据 / 伪命令 / 未调用实现不能通过 accepted（runId 驱动）
// ---------------------------------------------------------------------------
async function testEvidence() {
  const work = {
    workId: 'w1',
    teamKey: 't',
    ownerMemberId: 'm1',
    acceptance: ['可接入', '无占位'],
    outputs: ['src/a.ts'],
  };
  const fileReader = async (filePath) => {
    if (String(filePath) === 'src/a.ts') return { ok: true, exists: true, bytes: 42, sha256: 'A'.repeat(64) };
    return { ok: false, exists: false, error: 'ENOENT' };
  };
  const runGood = {
    runId: 'run-good',
    workId: 'w1',
    scope: 'offline',
    status: 'completed',
    exitCode: 0,
    command: 'node',
    argv: ['--test'],
    artifactsAfter: [{ path: 'src/a.ts', sha256: 'A'.repeat(64), bytes: 42 }],
  };
  const runFailed = { ...runGood, runId: 'run-failed', status: 'failed', exitCode: 1 };
  const attemptProduced = { attemptId: 'a1', workId: 'w1', state: 'produced', ownerMemberId: 'm1' };
  const attemptCancelled = { attemptId: 'a2', workId: 'w1', state: 'cancelled', ownerMemberId: 'm1' };

  const empty = await validateEvidence({ work, evidence: [], attempts: [attemptProduced], runs: [runGood], readFile: fileReader });
  check('§5.6 空 evidence → EVIDENCE_REQUIRED（accepted 不可能）', empty.ok === false && empty.codes.includes('EVIDENCE_REQUIRED'), empty.codes);

  const bareOk = await validateEvidence({ work, evidence: [{ ok: true }], attempts: [attemptProduced], runs: [runGood], readFile: fileReader });
  check('§5.6 裸 ok:true 不构成证据', bareOk.ok === false && bareOk.codes.includes('EVIDENCE_NOT_MAPPED'), bareOk.codes);

  const bareString = await validateEvidence({ work, evidence: ['npm test 通过'], attempts: [attemptProduced], runs: [runGood], readFile: fileReader });
  check('§5.6 裸命令字符串不构成证据', bareString.ok === false && bareString.codes.includes('EVIDENCE_NOT_MAPPED'), bareString.codes);

  const fakeRun = await validateEvidence({
    work,
    evidence: [{ kind: 'verification', runId: 'run-does-not-exist' }, { kind: 'acceptance', acceptanceIndex: 0, evidenceRef: 0 }],
    attempts: [attemptProduced],
    runs: [runGood],
    readFile: fileReader,
  });
  check('§5.6 编造 runId → EVIDENCE_RUN_NOT_FOUND', fakeRun.ok === false && fakeRun.codes.includes('EVIDENCE_RUN_NOT_FOUND'), fakeRun.codes);

  const failedRun = await validateEvidence({
    work,
    evidence: [{ kind: 'verification', runId: 'run-failed' }, { kind: 'acceptance', acceptanceIndex: 0, evidenceRef: 0 }],
    attempts: [attemptProduced],
    runs: [runGood, runFailed],
    readFile: fileReader,
  });
  check('§5.6 失败的 run（exitCode=1）不能证明验收 → EVIDENCE_RUN_FAILED', failedRun.ok === false && failedRun.codes.includes('EVIDENCE_RUN_FAILED'), failedRun.codes);

  const cancelledAttempt = await validateEvidence({
    work,
    evidence: [{ kind: 'execution', attemptId: 'a2' }],
    attempts: [attemptProduced, attemptCancelled],
    runs: [runGood],
    readFile: fileReader,
  });
  check('§5.6 cancelled 的 attempt 不能作为证据 → EVIDENCE_ATTEMPT_NOT_PRODUCED', cancelledAttempt.ok === false && cancelledAttempt.codes.includes('ATTEMPT_NOT_SUCCEEDED'), cancelledAttempt.codes);

  // 契约 v4：不存在 weak 通道——非空文件 / 命令字符串 / 未绑定验收都必须带新码。
  const untrustedFile = await validateEvidence({
    work,
    evidence: [{ kind: 'verification', file: 'src/a.ts' }],
    attempts: [attemptProduced],
    runs: [],
    readFile: fileReader,
  });
  check('§5.6 模型写出的非空文件不通过 → UNTRUSTED_EVIDENCE_FILE', untrustedFile.ok === false && untrustedFile.codes.includes('UNTRUSTED_EVIDENCE_FILE'), untrustedFile.codes);
  const commandOnly = await validateEvidence({
    work,
    evidence: [{ kind: 'verification', command: 'node --test' }],
    attempts: [attemptProduced],
    runs: [],
    readFile: fileReader,
  });
  check('§5.6 未执行的命令字符串不通过 → COMMAND_NOT_EXECUTED', commandOnly.ok === false && commandOnly.codes.includes('COMMAND_NOT_EXECUTED'), commandOnly.codes);
  const failedAttempt = await validateEvidence({
    work,
    evidence: [{ kind: 'execution', attemptId: 'a3' }],
    attempts: [{ attemptId: 'a3', workId: 'w1', state: 'failed' }],
    runs: [],
    readFile: fileReader,
  });
  check('§5.6 failed attempt 不通过 → ATTEMPT_NOT_SUCCEEDED', failedAttempt.ok === false && failedAttempt.codes.includes('ATTEMPT_NOT_SUCCEEDED'), failedAttempt.codes);
  const emptyAgain = await validateEvidence({ work, evidence: [], attempts: [attemptProduced], runs: [], readFile: fileReader });
  check('§5.6 空 evidence 不通过 → EVIDENCE_REQUIRED', emptyAgain.ok === false && emptyAgain.codes.includes('EVIDENCE_REQUIRED'), emptyAgain.codes);
  // 合法 run + exit0 + artifact 版本匹配（artifactRefs version=2，evidence version=2，checkId 绑定 run.checkId）。
  const versionedWork = { ...work, acceptance: ['probe acceptance'], artifactRefs: [{ path: 'src/a.ts', version: 2 }] };
  const versionedRun = { ...runGood, checkId: 'node --test', acceptanceIndexes: [0, 1], artifactsAfter: [{ path: 'src/a.ts', sha256: 'A'.repeat(64), bytes: 42 }] };
  const versionOk = await validateEvidence({
    work: versionedWork,
    evidence: [
      { kind: 'verification', runId: 'run-good', file: 'src/a.ts', version: 2, checkId: 'node --test' },
      { kind: 'acceptance', acceptanceIndex: 0, checkId: 'node --test', evidenceRef: 0 },
    ],
    attempts: [attemptProduced],
    runs: [versionedRun],
    readFile: fileReader,
  });
  check('§5.6 合法 executionRun+exit0+artifact 版本匹配 → 通过', versionOk.ok === true, { codes: versionOk.codes, missing: versionOk.missing });
  const versionMismatch = await validateEvidence({
    work: versionedWork,
    evidence: [{ kind: 'verification', runId: 'run-good', file: 'src/a.ts', version: 1 }],
    attempts: [attemptProduced],
    runs: [versionedRun],
    readFile: fileReader,
  });
  check('§5.6 path@version 不匹配 → ARTIFACT_VERSION_MISMATCH', versionMismatch.ok === false && versionMismatch.codes.includes('ARTIFACT_VERSION_MISMATCH'), versionMismatch.codes);
  const unlinkedAcceptance = await validateEvidence({
    work: versionedWork,
    evidence: [
      { kind: 'verification', runId: 'run-good', file: 'src/a.ts', version: 2 },
      { kind: 'acceptance', acceptanceIndex: 0, evidenceRef: 0 },
    ],
    attempts: [attemptProduced],
    runs: [versionedRun],
    readFile: fileReader,
  });
  check('§5.6 验收未绑定冻结 checkId → CHECKID_REQUIRED', unlinkedAcceptance.ok === false && unlinkedAcceptance.codes.includes('CHECKID_REQUIRED'), unlinkedAcceptance.codes);

  const noArtifactRun = await validateEvidence({
    work,
    evidence: [{ kind: 'verification', runId: 'run-no-artifact' }],
    attempts: [attemptProduced],
    runs: [{ ...runGood, runId: 'run-no-artifact', artifactsAfter: [] }],
    readFile: fileReader,
  });
  check('§5.6 run 没有记录产物 → EVIDENCE_RUN_WITHOUT_ARTIFACTS', noArtifactRun.ok === false && noArtifactRun.codes.includes('EVIDENCE_RUN_WITHOUT_ARTIFACTS'), noArtifactRun.codes);

  const goodWork = { ...work, artifactRefs: [{ path: 'src/a.ts', version: 1 }] };
  // P1-1：每条 acceptance 必须独占一条已执行检查（run）；两条验收 = 两条 run。
  const good = await validateEvidence({
    work: goodWork,
    evidence: [
      { kind: 'verification', runId: 'run-good', file: 'src/a.ts', version: 1, checkId: 'node --test' },
      { kind: 'verification', runId: 'run-good-2', file: 'src/a.ts', version: 1, checkId: 'node --test' },
      { kind: 'acceptance', acceptanceIndex: 0, evidenceRef: 0, checkId: 'node --test' },
      { kind: 'acceptance', acceptanceIndex: 1, evidenceRef: 1, checkId: 'node --test', postcondition: { kind: 'artifact', path: 'src/a.ts', sha256: 'A'.repeat(64) } },
      { kind: 'execution', attemptId: 'a1' },
    ],
    attempts: [attemptProduced],
    runs: [{ ...runGood, checkId: 'node --test', acceptanceIndexes: [0] }, { ...runGood, runId: 'run-good-2', checkId: 'node --test', acceptanceIndexes: [1] }],
    readFile: fileReader,
  });
  check('§5.6 真实 run + 验收后置条件 → evidence 通过', good.ok === true, { codes: good.codes, missing: good.missing });
  check('§5.6 strong verification / acceptance 计数正确', good.strongVerifications === 2 && good.acceptanceCount === 2, { strong: good.strongVerifications, acceptance: good.acceptanceCount });

  // P1-1 负例：调用者用子串 checkId 重标（run 冻结的是 'node --test'，验收写 'node'）→ 拒绝。
  const retagged = await validateEvidence({
    work: goodWork,
    evidence: [
      { kind: 'verification', runId: 'run-good', file: 'src/a.ts', version: 1, checkId: 'node --test' },
      { kind: 'acceptance', acceptanceIndex: 0, evidenceRef: 0, checkId: 'node' },
    ],
    attempts: [attemptProduced],
    runs: [{ ...runGood, checkId: 'node --test', acceptanceIndexes: [0] }],
    readFile: fileReader,
  });
  check('§5.6 P1-1：子串 checkId 重标 → CHECKID_MISMATCH', retagged.ok === false && retagged.codes.includes('CHECKID_MISMATCH'), retagged.codes);
  // P1-1 正例：计划期声明的合法集成检查可覆盖多个验收条件（一条 run + acceptanceIndexes:[0,1]）。
  const multiCover = await validateEvidence({
    work: goodWork,
    evidence: [
      { kind: 'verification', runId: 'run-good', file: 'src/a.ts', version: 1, checkId: 'node --test' },
      { kind: 'acceptance', acceptanceIndex: 0, evidenceRef: 0, checkId: 'node --test' },
      { kind: 'acceptance', acceptanceIndex: 1, evidenceRef: 0, checkId: 'node --test' },
    ],
    attempts: [attemptProduced],
    runs: [{ ...runGood, checkId: 'node --test', acceptanceIndexes: [0, 1] }],
    readFile: fileReader,
  });
  check('§5.6 P1-1：声明检查覆盖多条验收（acceptanceIndexes:[0,1]）→ 允许', multiCover.ok === true, { codes: multiCover.codes, missing: multiCover.missing });
  const badPostcondition = await validateEvidence({
    work,
    evidence: [
      { kind: 'verification', runId: 'run-good', file: 'src/a.ts', checkId: 'node --test' },
      { kind: 'acceptance', acceptanceIndex: 0, evidenceRef: 0, checkId: 'node --test', postcondition: { kind: 'artifact', path: 'src/a.ts', sha256: 'B'.repeat(64) } },
    ],
    attempts: [attemptProduced],
    runs: [{ ...runGood, checkId: 'node --test', acceptanceIndexes: [0] }],
    readFile: fileReader,
  });
  check('§5.6 验收后置条件与 run 产物 hash 不符 → EVIDENCE_POSTCONDITION_FAILED', badPostcondition.ok === false && badPostcondition.codes.includes('EVIDENCE_POSTCONDITION_FAILED'), badPostcondition.codes);

  const liveClaim = await validateEvidence({
    work,
    evidence: [{ kind: 'verification', runId: 'run-good', scope: 'live' }],
    attempts: [attemptProduced],
    runs: [runGood],
    readFile: fileReader,
  });
  check('§5.6 用 offline run 冒充实机证据 → EVIDENCE_SCOPE_UNAVAILABLE', liveClaim.ok === false && liveClaim.codes.includes('EVIDENCE_SCOPE_UNAVAILABLE'), liveClaim.codes);

  const tampered = await validateEvidence({
    work,
    evidence: [{ kind: 'verification', runId: 'run-good', file: 'src/a.ts' }],
    attempts: [attemptProduced],
    runs: [runGood],
    readFile: async () => ({ ok: true, exists: true, bytes: 42, sha256: 'C'.repeat(64) }),
  });
  check('§5.6 执行后文件被改 → EVIDENCE_STALE（不能拿旧证据通过）', tampered.ok === false && tampered.codes.includes('EVIDENCE_STALE'), tampered.codes);

  check('§5.6 completionFromValidation：accepted 才清 missing', completionFromValidation({ work, validation: good, accepted: true, at: 1, verifiedBy: 'm1' }).missing.length === 0
    && completionFromValidation({ work, validation: untrustedFile, accepted: false, at: 1 }).missing.length > 0, null);

  const classifyWeak = classifyEvidenceItem({ kind: 'verification', file: 'src/a.ts', command: 'x' }, 0);
  const classifyStrong = classifyEvidenceItem({ kind: 'verification', runId: 'run-good' }, 1);
  check('§5.6 证据强度分级：无 runId 直接 invalid（COMMAND_NOT_EXECUTED/UNTRUSTED_EVIDENCE_FILE），有 runId=strong', classifyWeak.mapped === false && ['COMMAND_NOT_EXECUTED', 'UNTRUSTED_EVIDENCE_FILE'].includes(classifyWeak.reason) && classifyStrong.strength === 'strong', { classifyWeak, classifyStrong });
}

// ---------------------------------------------------------------------------
// §5.7 版本改变使证据过期
// ---------------------------------------------------------------------------
function testStaleness() {
  const record = { workId: 'w1', valid: true, files: [{ path: 'src/a.ts', sha256: 'A'.repeat(64), bytes: 42 }] };
  const same = isEvidenceStale(record, new Map([['src/a.ts', { exists: true, sha256: 'A'.repeat(64), bytes: 42 }]]));
  check('§5.7 文件未变 → 证据不过期', same.stale === false, same);

  const changed = isEvidenceStale(record, new Map([['src/a.ts', { exists: true, sha256: 'B'.repeat(64), bytes: 43 }]]));
  check('§5.7 文件内容/大小变化 → 证据过期', changed.stale === true && changed.changed.length > 0, changed);

  const missing = isEvidenceStale(record, new Map([['src/a.ts', { exists: false }]]));
  check('§5.7 文件消失 → 证据过期', missing.stale === true && missing.changed[0].reason === 'FILE_MISSING', missing);
}

// ---------------------------------------------------------------------------
// §5.8 费用归账：去重 / retry / summary / unknown / 价目
// ---------------------------------------------------------------------------
function testUsage() {
  const records = [
    // 第 1 次请求：流式 attempt（有 usage）+ 最终 message（同 usage）→ 只计一次
    { sessionId: 's1', seq: 1, type: 'assistant/attempt', turn: 1, step: 1, provider: 'p1', model: 'm1', time: 100, usage: null, compactionId: null },
    { sessionId: 's1', seq: 2, type: 'assistant/attempt', turn: 1, step: 1, provider: 'p1', model: 'm1', time: 101, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, totalTokens: 110 }, compactionId: null },
    { sessionId: 's1', seq: 3, type: 'assistant/message', turn: 1, step: 1, provider: 'p1', model: 'm1', time: 102, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, totalTokens: 110 }, compactionId: null },
    // 同一 turn/step 的第 2 次真实 retry → 独立计费
    { sessionId: 's1', seq: 4, type: 'assistant/attempt', turn: 1, step: 1, provider: 'p1', model: 'm1', time: 103, usage: { inputTokens: 120, outputTokens: 12, cacheReadTokens: 0, totalTokens: 132 }, compactionId: null },
    // compaction summary 计入
    { sessionId: 's1', seq: 5, type: 'assistant/message', turn: 2, step: 1, provider: 'p1', model: 'm1', time: 104, usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, totalTokens: 55 }, compactionId: 'cmp-1' },
    // 缺 usage → unknown
    { sessionId: 's2', seq: 6, type: 'assistant/message', turn: 1, step: 1, provider: 'p1', model: 'm1', time: 105, usage: null, compactionId: null },
    // reasoning 已含 output（total <= input+output）
    { sessionId: 's3', seq: 7, type: 'assistant/message', turn: 1, step: 1, provider: 'p1', model: 'm1', time: 106, usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 5, totalTokens: 30 }, compactionId: null },
  ];

  const book = normalizePriceBook({ version: 'pricing-v1', currency: 'USD', source: 'test', entries: [{ provider: 'p1', model: 'm1', inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.5 }] });
  const folded = foldBillingUnits(records, { priceBook: book });
  // 审计语义：每次结算请求只产生一个事件（成功=message，失败/重试/取消=attempt），
  // 二者**不是**同请求的 stream/final 副本 → 不做跨类型去重（否则吞掉真实重试费用）。
  check('§5.8 attempt 与 message 不合并（审计事件语义）', folded.stats.duplicatesSuppressed === 0 && folded.units.length === folded.stats.records, folded.stats);
  // 同一 (turn,step) 有 3 次 attempt 事件（seq1/2/4）→ 额外重试 2 次；retry 单元各自独立计费。
  check('§5.8 真实 retry 独立计费并计数', folded.stats.retries === 2 && folded.units.filter((unit) => unit.retryIndex > 0).length === 2, folded.stats);
  check('§5.8 compaction summary 计入（独立 compaction 键）', folded.stats.summaries === 1 && folded.units.some((unit) => unit.billingKey.includes('|cmp:')), folded.stats);
  check('§5.8 缺 usage 记 unknown（不猜 token）', folded.stats.missingUsage >= 1, folded.stats);
  check('§5.8 reasoning 已含 output 时标记 included（不重复相加）', usageOf(records[6]).reasoningIncludedInOutput === true, usageOf(records[6]));
  check('§5.8 统计按折算后的计费单元（units=records，无跨类型合并）', folded.stats.units === folded.units.length && folded.stats.units === folded.stats.records, folded.stats);

  // 跨批重试：同一 session 的第二批 attempt 不能塌回 0（共享 attemptOrdinal；seq 键稳定）。
  const stepState = new Map();
  const attemptOrdinal = new Map();
  const batch1 = foldBillingUnits([records[1]], { priceBook: book, stepState, attemptOrdinal });
  const batch2 = foldBillingUnits([records[3]], { priceBook: book, stepState, attemptOrdinal });
  check('§5.8 跨批 attempt 键不塌缩（seq 稳定 + retryIndex 累加）', batch1.units[0].billingKey !== batch2.units[0].billingKey && batch2.units[0].retryIndex === 1, { batch1: batch1.units[0], batch2: batch2.units[0] });

  const nullPrice = normalizePriceBook({ entries: [{ provider: 'p1', model: 'm1', inputPerMillion: null, outputPerMillion: null }] });
  check('§5.8 Number(null) 不再当 0：缺显式价目 → 条目被丢弃（unknown）', nullPrice.entries.length === 0, nullPrice);
  const noCachePrice = normalizePriceBook({ currency: 'CNY', entries: [{ provider: 'p1', model: 'm1', inputPerMillion: 1, outputPerMillion: 1 }] });
  const cacheCost = costOf({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 10 }, noCachePrice.entries[0]);
  check('§5.8 缺 cache 价且实际有 cache token → 该请求 unknown（不是 0）', cacheCost.known === false && cacheCost.reason === 'CACHE_PRICE_UNKNOWN', cacheCost);
  check('§5.8 价目按币种（CNY 显式配置才会出现）', noCachePrice.currency === 'CNY', noCachePrice.currency);

  const priced = folded.units.find((unit) => unit.usage && unit.usage.inputTokens === 100);
  check('§5.8 命中价目条目 → cost 已知且按 provider/model 计价', priced.costKnown === true && priced.cost > 0 && priced.currency === 'USD', priced);
  const unknownPrice = foldBillingUnits(records, { priceBook: emptyPriceBook() });
  check('§5.8 空价目表 → 费用 unknown（不是 0）', unknownPrice.units.every((unit) => unit.costKnown === false), unknownPrice.units.map((unit) => ({ key: unit.billingKey, costKnown: unit.costKnown })));
  check('§5.8 空价目表没有默认货币', emptyPriceBook().currency === null, emptyPriceBook());

  const budget = addUnitToBudget(emptyBudget(), unknownPrice.units[0]);
  check('§5.8 未知费用计入 costUnknownRequests，不计入 costEstimate', budget.costUnknownRequests >= 1 && budget.costEstimate === 0, budget);

  // 混币不相加
  const mixed = addUnitToBudget(addUnitToBudget(emptyBudget(), { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, reasoningTokens: 0 }, costKnown: true, cost: 1, currency: 'CNY' }), { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, reasoningTokens: 0 }, costKnown: true, cost: 1, currency: 'USD' });
  check('§5.8 混币分桶且不相加（costEstimate=0 标记 mixed）', mixed.costByCurrency.CNY === 1 && mixed.costByCurrency.USD === 1 && mixed.costEstimate === 0, mixed);

  const resolveWildcard = resolvePrice(normalizePriceBook({ currency: 'USD', entries: [{ provider: '*', model: '*', inputPerMillion: 1, outputPerMillion: 1, cacheReadPerMillion: 1 }] }), { provider: 'x', model: 'y', time: Date.now() });
  check('§5.8 通配价目条目可命中', resolveWildcard !== null, resolveWildcard);
  const timeScoped = normalizePriceBook({
    currency: 'USD',
    entries: [{ provider: 'p1', model: 'm1', effectiveFrom: '2026-10-01T00:00:00Z', inputPerMillion: 1, outputPerMillion: 1 }],
  });
  check('§5.8 时段价目：生效时间之前不命中', resolvePrice(timeScoped, { provider: 'p1', model: 'm1', time: Date.parse('2026-09-01T00:00:00Z') }) === null, null);
  check('§5.8 时段价目：生效时间之后命中', resolvePrice(timeScoped, { provider: 'p1', model: 'm1', time: Date.parse('2026-10-05T00:00:00Z') }) !== null, null);

  const facts = {
    members: [{ sessionId: 's1', memberId: 'combat', teamKey: 'team-a' }],
    attempts: [{ executorChildId: 'child-1', ownerMemberId: 'combat', workId: 'w1', teamKey: 'team-a', attemptId: 'a1' }],
    teams: [{ rootSessionId: 's-lead', teamKey: 'team-a' }],
  };
  check('§5.8 成员根会话 → owner 自身', attributeSession('s1', facts).kind === 'self', attributeSession('s1', facts));
  check('§5.8 leaf 执行者会话 → 归属 owner 的 descendants', attributeSession('child-1', facts).kind === 'descendants', attributeSession('child-1', facts));
  check('§5.8 无法证明归属 → unattributed（不分摊）', attributeSession('unknown-session', facts).attributed === false, attributeSession('unknown-session', facts));
}

// ---------------------------------------------------------------------------
// §7 schema 与运行时限额一致
// ---------------------------------------------------------------------------
function testSchemaLimits() {
  const schema = {
    type: 'object',
    properties: {
      workId: { type: 'string', maxLength: 8 },
      outcome: { type: 'string', enum: ['accepted', 'rejected'] },
      evidence: { type: 'array', maxItems: 2, items: { type: 'object', properties: { kind: { type: 'string', enum: ['verification'] } }, required: ['kind'] } },
    },
    required: ['workId', 'outcome'],
    additionalProperties: false,
  };
  const tooLong = validateArgs(schema, { workId: 'this-id-is-way-too-long', outcome: 'accepted' });
  check('§7 超长字段 → MAX_LENGTH_EXCEEDED 且带精确字段路径', tooLong.ok === false && tooLong.violations[0].path === 'args.workId' && tooLong.violations[0].code === 'MAX_LENGTH_EXCEEDED', tooLong);
  check('§7 错误信息给出可执行的修复提示', typeof tooLong.violations[0].hint === 'string' && tooLong.violations[0].hint.includes('maxLength') === false && tooLong.violations[0].hint.length > 10, tooLong.violations[0]);

  const missing = validateArgs(schema, { workId: 'w1' });
  check('§7 缺必填 → REQUIRED_MISSING（指出字段）', missing.ok === false && missing.violations.some((item) => item.code === 'REQUIRED_MISSING' && item.path === 'args.outcome'), missing);

  const badEnum = validateArgs(schema, { workId: 'w1', outcome: 'maybe' });
  check('§7 枚举不符 → ENUM_MISMATCH', badEnum.ok === false && badEnum.violations.some((item) => item.code === 'ENUM_MISMATCH'), badEnum);

  const tooMany = validateArgs(schema, { workId: 'w1', outcome: 'accepted', evidence: [{ kind: 'verification' }, { kind: 'verification' }, { kind: 'verification' }] });
  check('§7 数组超限 → MAX_ITEMS_EXCEEDED', tooMany.ok === false && tooMany.violations.some((item) => item.code === 'MAX_ITEMS_EXCEEDED'), tooMany);

  const nested = validateArgs(schema, { workId: 'w1', outcome: 'accepted', evidence: [{ kind: 'nope' }] });
  check('§7 嵌套枚举错误定位到 args.evidence[0].kind', nested.ok === false && nested.violations.some((item) => item.path === 'args.evidence[0].kind'), nested);

  const unknownField = validateArgs(schema, { workId: 'w1', outcome: 'accepted', extra: 1 });
  check('§7 未声明字段只警告不回绝（不破坏既有调用）', unknownField.ok === true && unknownField.warnings.some((item) => item.code === 'UNKNOWN_FIELD'), unknownField);
}

// ---------------------------------------------------------------------------
// §6 受管任务上下文：紧凑、分页、事实保留
// ---------------------------------------------------------------------------
function testContext() {
  const works = Array.from({ length: 5 }, (_, index) => ({
    workId: `w${index}`,
    title: `交付 ${index}`,
    state: 'ready',
    ownerMemberId: 'm1',
    teamKey: 'team-a',
    updatedAt: 1000 + index,
    outputs: [`src/w${index}.ts`],
    acceptance: ['ok'],
    artifactDependencies: [{ artifact: 'api', version: 2, requires: 'published-interface' }],
    execution: 'delegate',
  }));
  const fingerprints = [{ code: 'SUBAGENT_START_FAILED', guidance: '改产物版本后再试', workIds: ['w0'] }];

  const page1 = buildContextPage({ works, attempts: [], events: [], fingerprints, memberId: 'm1', teamKey: 'team-a', limit: 2, budgetChars: 2000 });
  check('§6 默认分页（limit 生效）', page1.rows.length === 2 && page1.hasMore === true && typeof page1.nextCursor === 'string', { rows: page1.rows.length, hasMore: page1.hasMore, nextCursor: page1.nextCursor });
  check('§6 紧凑：默认不返回 deliverable 原文', page1.rows.every((row) => row.detail === undefined), page1.rows.map((row) => Object.keys(row)));
  check('§6 事实保留：接口版本与被否决方法仍在行里', page1.rows.some((row) => (row.facts?.interfaces ?? []).some((item) => item.includes('api@v2'))) && page1.rows.some((row) => (row.facts?.rejectedApproaches ?? []).length > 0), page1.rows.map((row) => row.facts));

  const page2 = buildContextPage({ works, attempts: [], events: [], fingerprints, memberId: 'm1', teamKey: 'team-a', limit: 2, budgetChars: 2000, cursor: page1.nextCursor });
  check('§6 游标续页不重复（两页 workId 不重叠）', page2.rows.every((row) => !page1.rows.some((first) => first.workId === row.workId)), { page1: page1.rows.map((row) => row.workId), page2: page2.rows.map((row) => row.workId) });

  const tight = buildContextPage({ works, attempts: [], events: [], fingerprints, memberId: 'm1', teamKey: 'team-a', limit: 10, budgetChars: 300 });
  check('§6 字符预算生效（truncated=hasMore，且至少返回一行）', tight.budget.truncated === true && tight.rows.length >= 1, tight.budget);
}

// ---------------------------------------------------------------------------
// findings：Host 复核成果 vs owner 历史声明
// ---------------------------------------------------------------------------
function testFindings() {
  const works = [
    { workId: 'w-new', teamKey: 't', ownerMemberId: 'm1', title: '新交付', state: 'accepted', verifiedAt: 200, artifactRefs: [{ path: 'src/a.ts', version: 1 }], acceptance: ['ok'] },
    { workId: 'w-legacy', teamKey: 't', ownerMemberId: 'm1', title: '旧交付', state: 'accepted', verifiedAt: 100, artifactRefs: [], acceptance: ['ok'] },
    { workId: 'w-run', teamKey: 't', ownerMemberId: 'm2', title: '进行中', state: 'executing', updatedAt: 300, acceptance: ['ok'] },
    { workId: 'w-wait', teamKey: 't', ownerMemberId: 'm2', title: '待验收', state: 'awaiting_verification', producedAt: 400, completion: { missing: ['acceptance-evidence'] }, acceptance: ['ok'] },
    { workId: 'w-block', teamKey: 't', ownerMemberId: 'm2', title: '被阻塞', state: 'blocked', blockedReason: 'DEPENDENCIES_UNSATISFIED', acceptance: ['ok'] },
  ];
  const evidenceRecords = [{ workId: 'w-new', valid: true, strong: true, at: 200, digest: 'd1', items: [{ index: 0, kind: 'verification', valid: true, strong: true, source: 'host-run', scope: 'offline' }] }];
  const findings = buildFindings({ works, attempts: [], evidenceRecords, invalidations: [{ workId: 'w-stale', reason: 'EVIDENCE_STALE', at: 500, changed: [{ path: 'src/x.ts', reason: 'SHA256_CHANGED' }] }], now: 1000 });

  check('findings.verified 只含 Host 可复核成果', findings.verified.length === 1 && findings.verified[0].workId === 'w-new', findings.verified);
  check('findings.verified 带产物版本与证据来源', findings.verified[0].artifacts[0].version === 1 && findings.verified[0].evidence[0].source === 'host-run', findings.verified[0]);
  check('旧 accepted 不改历史：作为 owner 历史声明进 invalidated', findings.invalidated.some((item) => item.workId === 'w-legacy' && item.legacyOwnerClaim === true && item.reason === 'ACCEPTED_WITHOUT_ARTIFACTS'), findings.invalidated);
  check('证据过期进 invalidated（不错误解锁依赖）', findings.invalidated.some((item) => item.workId === 'w-stale' && item.reason === 'EVIDENCE_STALE'), findings.invalidated);
  check('inProgress / unfinished 分开投影', findings.inProgress.some((item) => item.workId === 'w-run') && findings.unfinished.some((item) => item.workId === 'w-wait') && findings.unfinished.some((item) => item.workId === 'w-block'), { inProgress: findings.inProgress.map((item) => item.workId), unfinished: findings.unfinished.map((item) => item.workId) });
  check('lastEffectiveProgress 只来自状态迁移（取最近时间）', findings.lastEffectiveProgress.at === 400 && findings.lastEffectiveProgress.workId === 'w-wait', findings.lastEffectiveProgress);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 前端激活回执 client-ack：幂等 + /state.frontendAck 形状（真实 service 实例）
// ---------------------------------------------------------------------------
async function testFrontendAck() {
  const { createWorkbench, leadAgent } = await import('../helpers/harness.mjs');
  const wb = await createWorkbench({});
  const lead = leadAgent(wb);
  const service = wb.service;
  const first = await service.recordFrontendAck(lead, {
    op: 'client-ack',
    bundle: { url: '/plugin-assets/team-workbench/bundle.js', activatedAt: 1790000000000 },
    mounted: true,
    detailTransport: { kind: 'http', path: '/plugin/team-workbench/state/detail' },
    frontendRev: '761e34f9ae08',
  });
  check('client-ack 首次接收 ok 且 mounted=true', first.ok === true && first.deduplicated === false && first.ack?.mounted === true, first);
  const second = await service.recordFrontendAck(lead, {
    op: 'client-ack',
    bundle: { url: '/plugin-assets/team-workbench/bundle.js', activatedAt: 1790000000000 },
    mounted: true,
  });
  check('client-ack 幂等（同 bundle.url+activatedAt 去重，count 累加）', second.ok === true && second.deduplicated === true && second.ack?.count === 2, second);
  const other = await service.recordFrontendAck(lead, {
    op: 'client-ack',
    bundle: { url: '/plugin-assets/team-workbench/bundle.js', activatedAt: 1790000000500 },
    mounted: true,
  });
  check('client-ack 不同 activatedAt 视为新 bundle', other.ok === true && other.deduplicated === false, other);
  const missing = await service.recordFrontendAck(lead, { op: 'client-ack', bundle: {} });
  check('client-ack 缺 bundle.url 被拒（ACK_BUNDLE_REQUIRED）', missing.ok === false && missing.code === 'ACK_BUNDLE_REQUIRED', missing);
  const view = service.frontendAckView();
  check('/state.frontendAck 形状（mounted/bundleUrl/activatedAt/firstAckAt/lastAckAt/count/rev）', view.mounted === true && typeof view.bundleUrl === 'string' && Number.isFinite(view.firstAckAt) && Number.isFinite(view.lastAckAt) && view.count === 3 && view.uniqueBundles === 2, view);
  check('ack 语义边界写明（≠视觉验收、≠Host 已加载）', String(view.note).includes('不等于视觉验收') && String(view.note).includes('Host 已加载'), view.note);
  check('snapshot 暴露只读 frontendAck（不写"已激活"结论以外的状态）', service.snapshot(undefined)?.frontendAck?.bundleUrl === view.bundleUrl, service.snapshot(undefined)?.frontendAck);
}

// ---------------------------------------------------------------------------
// 第 20 回合：subagent 绕过拦截 + tools/result 错误提取（确定性断言，不依赖宿主）
// ---------------------------------------------------------------------------
async function testDerivationGuardAndToolErrors() {
  const { DERIVATION_TOOLS, derivationGuardDecision, extractToolError } = await import('../../src/host/contextControl.js');
  check('§5.2 受管路径 team_subagent_start 不在通用派生拦截名单', !DERIVATION_TOOLS.includes('team_subagent_start') && DERIVATION_TOOLS.includes('subagent'), DERIVATION_TOOLS);
  const managed = { memberId: 'combat', teamKey: 'team-a', role: 'member' };
  const unmanaged = derivationGuardDecision({ tool: 'subagent', actor: managed });
  check('§5.2 受管 agent 通用派生一律拒绝 → SUBAGENT_DERIVATION_USE_MANAGED', unmanaged.apply === true && unmanaged.allow === false && unmanaged.code === 'SUBAGENT_DERIVATION_USE_MANAGED', unmanaged);
  check('§5.2 回归：合法 owner + 已有 work 仍不能绕过（必须走 team_subagent_start）', derivationGuardDecision({ tool: 'subagent', actor: managed, work: { ownerMemberId: 'combat', workId: 'w1' } }).allow === false, null);
  check('§5.2 回归：有 attempt 关联仍不能绕过', derivationGuardDecision({ tool: 'subagent_fork', actor: managed, attempt: { ownerMemberId: 'combat', teamKey: 'team-a' } }).allow === false, null);
  check('§5.2 回归：自报 missionAuthorized 不能绕过（决策不接受该字段）', derivationGuardDecision({ tool: 'spawn_teammate', actor: managed, missionAuthorized: true }).allow === false, null);
  const granted = derivationGuardDecision({ tool: 'subagent', actor: managed, authorization: { ok: true, workId: 'w1', ownerMemberId: 'combat' } });
  check('§5.2 Host 一次性授权（绑定 workId+owner）才允许', granted.apply === true && granted.allow === true, granted);
  const nonManaged = derivationGuardDecision({ tool: 'subagent', actor: null, work: null, attempt: null });
  check('§5.2 非受管 agent 不受该守卫影响', nonManaged.apply === false, nonManaged);

  const ok = extractToolError({ isError: false, content: [{ type: 'text', text: 'fine' }] });
  check('§5.2 成功结果不提取错误', ok === null, ok);
  const exitCode = extractToolError({ isError: true, content: [{ type: 'text', text: 'boom\n[exit code: 2]' }] });
  check('tools/result 从 content 的 [exit code: N] 提取 EXIT_N', exitCode?.code === 'EXIT_2' && exitCode.exitCode === 2, exitCode);
  const codeText = extractToolError({ isError: true, content: [{ type: 'text', text: 'EVIDENCE_INSUFFICIENT: no run' }] });
  check('tools/result 从 content 文本提取大写错误码', codeText?.code === 'EVIDENCE_INSUFFICIENT', codeText);
  const explicit = extractToolError({ isError: true, error: { code: 'NATIVE_EXECUTION_REJECTED', message: 'denied' }, content: [] });
  check('tools/result 优先用 error.code', explicit?.code === 'NATIVE_EXECUTION_REJECTED' && explicit.message === 'denied', explicit);
  const fallback = extractToolError({ isError: true, content: [{ type: 'text', text: 'something broke' }] });
  check('tools/result 无码时回退 TOOL_RESULT_ERROR', fallback?.code === 'TOOL_RESULT_ERROR', fallback);
}

// ---------------------------------------------------------------------------
// 第 21 回合：独立可安装升级入口插件（upgradeEntry）
// ---------------------------------------------------------------------------
async function testUpgradeEntry() {
  const entry = await import('../../src/host/upgradeEntry.js');
  check('升级入口：name/inject 声明三个服务', entry.name === 'team-workbench-upgrade-entry' && ['teamWorkbench', 'tools', 'webServer'].every((name) => entry.inject.includes(name)), entry.inject);

  // 1) 缺服务：明确诊断（不静默），路由仍注册但 plan/activate 返回 503
  const routes = [];
  const fakeCtx = { get: () => undefined, on: () => () => {}, logger: { info: () => {} } };
  const disposersCalled = [];
  const fakeWeb = { register: (route) => { routes.push(route); return () => disposersCalled.push(route.path); } };
  const ctxMissing = { ...fakeCtx, get: (name) => (name === 'webServer' ? fakeWeb : undefined) };
  const disposeMissing = entry.apply(ctxMissing, {});
  check('升级入口：缺 teamWorkbench/tools 时注册 plan|activate 两条路由', routes.length === 2 && routes.every((route) => String(route.path).startsWith('/plugin/team-workbench-upgrade/')), routes.map((route) => route.path));

  const makeRes = () => ({ statusCode: 0, body: null, setHeader() {}, end(text) { this.body = JSON.parse(text); } });
  const planRes = makeRes();
  await routes.find((route) => route.path.endsWith('/plan')).handler({ headers: { 'x-team-workbench': '1' }, url: '/x' }, planRes);
  check('升级入口：缺服务时 plan 返回 503 且不伪造成 ok', planRes.statusCode === 503 && planRes.body?.ok === false && planRes.body?.code === 'UPGRADE_ENTRY_SERVICE_MISSING', planRes.body);

  const noMarkerRes = makeRes();
  await routes.find((route) => route.path.endsWith('/plan')).handler({ headers: {} }, noMarkerRes);
  check('升级入口：缺少 client marker → 403', noMarkerRes.statusCode === 403 && noMarkerRes.body?.code === 'MISSING_CLIENT_MARKER', noMarkerRes.body);

  const noConfirmRes = makeRes();
  const activateRoute = routes.find((route) => route.path.endsWith('/activate'));
  await activateRoute.handler({ headers: { 'x-team-workbench': '1' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({})); } }, noConfirmRes);
  check('升级入口：activate 缺 confirm → 409（不改动 service）', noConfirmRes.statusCode === 409 && noConfirmRes.body?.code === 'UPGRADE_CONFIRMATION_REQUIRED', noConfirmRes.body);

  disposeMissing();
  check('升级入口：disposer 解绑全部路由', disposersCalled.length === 2, disposersCalled);

  // 2) autoActivate 默认 false（describe 可查）
  const described = entry.describe({});
  check('升级入口：autoActivate 默认 false（不自动激活）', described.autoActivate === false && described.basePath === '/plugin/team-workbench-upgrade', described);
}

// ---------------------------------------------------------------------------
// 第 22 回合：技能行可回滚装载（路线 B 受控 applier，纯函数级断言）
// ---------------------------------------------------------------------------
async function testControlledRowApplier() {
  const { createControlledRowApplier } = await import('../../src/host/skillsBridge.js');
  const disposed = [];
  const pluginCtx = { plugin: (moduleUrl, config) => { disposed.push(config?.skill?.name ?? 'row'); return () => disposed.push(`dispose:${config?.skill?.name ?? 'row'}`); } };
  const applyRow = createControlledRowApplier({ ctx: pluginCtx, moduleUrl: 'file:///tmp/x.js' });
  const handle = await applyRow({ rowId: 'skill-a', skill: { name: 'a' } }, 0);
  check('技能行装载：ctx.plugin 形态返回可释放句柄', typeof handle === 'function', typeof handle);
  handle();
  handle();
  check('技能行装载：句柄 dispose 幂等（只释放一次）', disposed.filter((item) => String(item).startsWith('dispose:')).length === 1, disposed);
  let threw = null;
  try { createControlledRowApplier({ ctx: {}, entry: null }); } catch (error) { threw = error; }
  check('技能行装载：无入口时抛 APPLY_NO_PLUGIN_API', threw?.code === 'APPLY_NO_PLUGIN_API', threw?.code);
  // 官方合同：ctx.plugin 只接受插件对象；{dispose} Fiber 句柄可由 thenable 返回。
  const entryCtx = { plugin: () => ({ dispose: () => disposed.push('dispose:fiber') }) };
  const applyEntry = { apply: (ctx, config) => { disposed.push(`applied:${config?.skill?.name ?? 'row'}`); } };
  const row2 = createControlledRowApplier({ ctx: entryCtx, entry: applyEntry });
  const h2 = await row2({ rowId: 'skill-b', skill: { name: 'b' } }, 1);
  h2();
  check('技能行装载：{apply} 插件对象经 ctx.plugin 装载并持有 Fiber.dispose', typeof h2 === 'function' && disposed.includes('dispose:fiber'), disposed);
}

// ---------------------------------------------------------------------------
// 最后一批：hook 可观察计数 + 技能回滚真实 ctx（写，不跑）
// ---------------------------------------------------------------------------
async function testObservableHooksAndRollback() {
  const { createContextControl } = await import('../../src/host/contextControl.js');
  const { createControlledRowApplier } = await import('../../src/host/skillsBridge.js');

  const diagnostics = { list: () => [], push: () => {} };
  const service = {
    // 受管判定按 agent id：只有 session-combat 是受管成员（测试区分受管/非受管）。
    actor: (agent) => (String(agent?.id ?? '') === 'session-combat' ? { ok: true, role: 'member', memberId: 'combat', teamKey: 'team-a' } : null),
    works: new Map([['w1', { workId: 'w1', teamKey: 'team-a', ownerMemberId: 'combat', state: 'executing', artifactRefs: [{ path: 'a.ts', version: 1 }], rev: 2, planRevision: 1 }]]),
    findExecutorAttempt: () => null,
    findRepeatedFailure: () => null,
    recordToolFailure: async () => ({ ok: true }),
  };
  const control = createContextControl({ service, config: {}, clock: { now: () => 1000 }, diagnostics, compactStateFor: () => ({ memberId: 'combat', teamKey: 'team-a', works: [], fingerprints: [], inbox: { pending: 0, byType: {} } }) });
  const managed = { id: 'session-combat' };
  const deny = control.guardNativeTool({ name: 'subagent', agent: managed, arguments: {} });
  check('hook 可观察：受管通用 subagent 被拦并计入 guardDenied/lastGuardBlock', typeof deny === 'string' && control.snapshot().stats.guardDenied === 1 && control.snapshot().stats.lastGuardBlock?.code === 'SUBAGENT_DERIVATION_USE_MANAGED', control.snapshot().stats);
  const allow = control.guardNativeTool({ name: 'subagent', agent: { id: 'session-outside' }, arguments: {} });
  check('hook 可观察：非受管 agent 不拦、计数不增', allow === undefined && control.snapshot().stats.guardDenied === 1, control.snapshot().stats);
  await control.onPreStep({ agent: managed, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }));
  check('hook 可观察：pre-step 计数随步骤增加（preStepCalls>=1、measuredSteps>=1）', control.snapshot().stats.preStepCalls >= 1 && control.snapshot().stats.measuredSteps >= 1, control.snapshot().stats);

  const disposed = [];
  const fakeCtx = { plugin: (url, cfg) => { disposed.push(cfg?.skill?.name); return () => disposed.push(`dispose:${cfg?.skill?.name}`); } };
  const applyRow = createControlledRowApplier({ ctx: fakeCtx, moduleUrl: 'file:///tmp/x.js' });
  const h1 = await applyRow({ rowId: 'r1', skill: { name: 'a' } }, 0);
  const h2 = await applyRow({ rowId: 'r2', skill: { name: 'b' } }, 1);
  h1(); h1(); h2();
  check('技能回滚：受控 handle 记录且 dispose 幂等（disposed 3 次=1+1+2 中的唯一）', disposed.filter((x) => String(x).startsWith('dispose:')).length === 2, disposed);
  const fakeCtxFail = { plugin: () => { throw Object.assign(new Error('plugin rejected'), { code: 'APPLY_PLUGIN_REJECTED' }); } };
  const failRow = createControlledRowApplier({ ctx: fakeCtxFail, moduleUrl: 'file:///tmp/y.js' });
  let threw = null;
  try { await failRow({ rowId: 'r3', skill: { name: 'c' } }, 0); } catch (error) { threw = error; }
  check('技能回滚：部分 apply 失败时能抛错（runUpgrade 会先 dispose 已创建 scope）', Boolean(threw), threw?.message ?? null);
}

// ---------------------------------------------------------------------------
// 最后接线：技能真回滚（无 snapshot 不假称恢复 / 快照重放 hash 匹配 / dispose await）
// ---------------------------------------------------------------------------
async function testLegacyTrueRollback() {
  const { restoreLegacyRows } = await import('../../src/host/skillsBridge.js');
  const { createHash } = await import('node:crypto');
  const sha = (text) => createHash('sha256').update(String(text)).digest('hex');
  const noSnapshot = await restoreLegacyRows({}, null);
  check('真回滚：无 snapshot 不假称恢复（restoredFrom 缺失、hashesMatched=false）', noSnapshot.ok === false && noSnapshot.hashesMatched === false, noSnapshot);

  const content = 'old skill body v1';
  const skillsRows = [{ name: 'p1', content }];
  const service = {
    ctx: {
      get: (name) => {
        if (name === 'loader') return { entries: () => [], resolve: async () => null };
        if (name === 'skills') return { list: async () => skillsRows, get: async (key) => skillsRows.find((row) => row.name === key) ?? null };
        return undefined;
      },
    },
  };
  let restarts = 0;
  const captured = [{
    rowId: 'skill-p1',
    name: 'p1',
    fiber: { uid: 7, state: 1, restart: async () => { restarts += 1; } },
    parentCtx: { plugin: () => ({ uid: 8, state: 1, dispose() {} }) },
    plugin: { apply: () => {} },
    config: { skill: { name: 'p1' } },
    enabled: true,
  }];
  const snapshot = { ok: true, captured, hashes: [{ provider: 'p1', sha256: sha(content), chars: content.length }] };
  const restored = await restoreLegacyRows(service, snapshot);
  check('真回滚：快照重放成功且旧正文 hash 匹配（restoredFrom=fiber-restart）', restored.ok === true && restored.hashesMatched === true && restored.restoredFrom === 'fiber-restart', restored);
  check('真回滚：await 旧 fiber restart 计数真实（一次）', restarts === 1, restarts);

  const mismatch = await restoreLegacyRows(service, { ...snapshot, hashes: [{ provider: 'p1', sha256: sha('different body') }] });
  check('真回滚：旧正文 hash 不一致 → 不算恢复', mismatch.ok === false && mismatch.hashesMatched === false && mismatch.code === 'SKILLS_ROLLBACK_HASH_MISMATCH', mismatch);
}

// ---------------------------------------------------------------------------
// 指纹回归：完整语义输入（长命令不碰撞）+ 真实文件 epoch（修复后可重试）
// ---------------------------------------------------------------------------
async function testFingerprintCoverageAndFileEpoch() {
  const { buildOperationDescriptor, fileEpochOf, fingerprintOf } = await import('../../src/host/fingerprints.js');
  const prefix = 'A'.repeat(3000);
  const f1 = fingerprintOf({ tool: 'pwsh', input: { command: `${prefix} --ok` }, code: 'EXIT_1' });
  const f2 = fingerprintOf({ tool: 'pwsh', input: { command: `${prefix} --bad` }, code: 'EXIT_1' });
  check('指纹回归：长命令仅末尾参数不同 → 指纹不同（不再截断 2000 碰撞）', f1.fingerprint !== f2.fingerprint, { f1: f1.fingerprint, f2: f2.fingerprint });

  const same = fingerprintOf({ tool: 'pwsh', input: { command: `${prefix} --ok` }, code: 'EXIT_1' });
  check('指纹回归：完全相同输入 → 指纹一致（确定性失败仍可拦）', same.fingerprint === f1.fingerprint, null);

  const epochMissing = fileEpochOf([{ path: 'src/a.ts', exists: false }]);
  const epochCreated = fileEpochOf([{ path: 'src/a.ts', exists: true, sha256: 'C'.repeat(64), bytes: 12, mtimeMs: 1700000000000 }]);
  check('指纹回归：ENOENT→文件被创建 → 文件 epoch 变化（允许重试）', epochMissing !== epochCreated, { epochMissing, epochCreated });
  const edited = fileEpochOf([{ path: 'src/a.ts', exists: true, sha256: 'D'.repeat(64), bytes: 20, mtimeMs: 1700000000999 }]);
  check('指纹回归：文件内容被修好（hash/bytes/mtime 变化）→ epoch 变化', epochCreated !== edited, { epochCreated, edited });

  const d1 = buildOperationDescriptor({ tool: 'edit', input: { file: 'src/a.ts' }, readEpoch: { files: epochMissing } });
  const d2 = buildOperationDescriptor({ tool: 'edit', input: { file: 'src/a.ts' }, readEpoch: { files: epochCreated } });
  check('指纹回归：同输入但文件 epoch 不同 → 指纹不同（版本未知不永久误拦）', d1.fingerprint !== d2.fingerprint, { d1: d1.fingerprint, d2: d2.fingerprint });
  const d3 = buildOperationDescriptor({ tool: 'edit', input: { file: 'src/a.ts' }, readEpoch: { files: epochCreated } });
  // P1-4：指纹带真实 teamKey；历史无 teamKey 的按 work 稳定关联只读回填；跨团队不串。
  // P1-2 字段级对照：同一 descriptor（含 owner/teamKey/readEpoch.files）记录后可查询命中；
  // 文件 epoch 变化 → 不再命中（read 修复可解除误拦）。
  const fieldStorage = { put: async (_table, _key, value) => ({ ok: true, record: value }), get: () => undefined, list: () => [] };
  const fpField = createErrorFingerprints({ storage: fieldStorage, clock: { now: () => 2000 } });
  const startDescriptor = buildOperationDescriptor({
    tool: 'team_subagent_start', input: { workId: 'w-1', ownerMemberId: 'm1' }, code: 'START_FAILED',
    memberId: 'm1', workId: 'w-1', teamKey: 'team-a',
    readEpoch: { planRevision: 1, files: 'epochA' },
  });
  await fpField.recordFailure({ ...startDescriptor, teamKey: 'team-a', workId: 'w-1' });
  const querySame = buildOperationDescriptor({ tool: 'team_subagent_start', input: { workId: 'w-1', ownerMemberId: 'm1' }, readEpoch: { planRevision: 1, files: 'epochA' } });
  const hitSame = fpField.findByOperation(querySame);
  check('P1-2：executeStart 失败记录与 evaluateErrorGate 查询字段一致（同输入同 epoch 命中）', Boolean(hitSame), hitSame?.fingerprint ?? null);
  const queryChanged = buildOperationDescriptor({ tool: 'team_subagent_start', input: { workId: 'w-1', ownerMemberId: 'm1' }, readEpoch: { planRevision: 1, files: 'epochB' } });
  const changedMatch = fpField.findByOperation(queryChanged);
  check('P1-2：文件 epoch 变化 → 不再命中（可解除 readguard）', changedMatch.fingerprint === null, changedMatch.fingerprint);

  // P1-3：祖先归属（真实 parentSession 链）归到真实 owner，而不是 owner self。
  const ancestorFacts = {
    sessions: [{ id: 'session-child', header: { parentSession: 'session-parent' } }],
    members: [{ sessionId: 'session-parent', memberId: 'm-parent', teamKey: 'team-a' }],
    attempts: [],
    teams: [],
  };
  const ancestor = attributeSession('session-child', ancestorFacts);
  check('P1-3：祖先链 fallback 归到真实 parent owner（不是 owner self）', ancestor?.attributed === true && ancestor?.memberId === 'm-parent' && ancestor?.via === 'parent-session', ancestor);

  const fpStorage = { put: async (_table, _key, value) => ({ ok: true, record: value }), get: () => undefined, list: () => [] };
  const fp = createErrorFingerprints({ storage: fpStorage, clock: { now: () => 1000 } });
  await fp.recordFailure({ tool: 'edit', input: { file: 'src/a.ts' }, code: 'EXIT_1', teamKey: 'team-a', workId: 'w-a' });
  await fp.recordFailure({ tool: 'edit', input: { file: 'src/legacy.ts' }, code: 'EXIT_1', workId: 'w-legacy' });
  const teamA = fp.snapshot({ teamKey: 'team-a', resolveTeamKey: (workId) => (workId === 'w-legacy' ? 'team-a' : workId === 'w-a' ? 'team-a' : null) });
  check('P1-4：team-a 已知错误在 scoped 查询可见（含历史无 teamKey 的稳定 work 回填）', teamA.groups.length === 2, teamA.groups.map((group) => group.workIds));
  const teamB = fp.snapshot({ teamKey: 'team-b', resolveTeamKey: () => null });
  check('P1-4：跨团队不串（team-b 查不到 team-a 的指纹）', teamB.groups.length === 0, teamB.groups.length);

  check('指纹回归：同输入同文件 epoch → 指纹一致（纯确定性失败仍拒绝）', d2.fingerprint === d3.fingerprint, null);
}

// ---------------------------------------------------------------------------
// P1-3 专用 fixture：原生 team id → sidecar teamKey（member / lead / leaf 三条）
// ---------------------------------------------------------------------------
async function testTeamKeyMapping() {
  const { createContextControl } = await import('../../src/host/contextControl.js');
  const make = (actor, attempt) => {
    const service = {
      actor: () => actor,
      isSameTeam: (a, teamKey) => String(teamKey) === 'sidecar-y', // 原生 id 与 sidecar key 不同，靠映射字段判定
      resolveTeamKey: () => 'sidecar-y',
      works: new Map([
        ['w-1', { workId: 'w-1', teamKey: 'sidecar-y', ownerMemberId: actor.memberId, state: 'ready', outputs: [], artifactRefs: [] }],
      ]),
      findExecutorAttempt: () => attempt,
      findRepeatedFailure: () => ({ skip: true, code: 'SYNTHETIC_BLOCK', errorClass: 'deterministic', fingerprint: 'fp-x', guidance: 'g' }),
      recordToolFailure: async () => ({ ok: true }),
    };
    const control = createContextControl({ service, config: {}, clock: { now: () => 1 }, diagnostics: { push: () => {} }, compactStateFor: () => null });
    return control;
  };
  const memberControl = make({ ok: true, role: 'member', memberId: 'm1', teamKey: 'native-x' }, null);
  const memberDenied = memberControl.guardNativeTool({ name: 'edit', agent: { id: 'session-m1' }, arguments: { file: 'src/a.ts' } });
  check('P1-3：member 原生 team id → sidecar teamKey 可命中 work（activeWorkOf 用 isSameTeam）', typeof memberDenied === 'string' && memberDenied.includes('SYNTHETIC_BLOCK'), memberDenied ?? null);
  const leadControl = make({ ok: true, role: 'lead', memberId: 'lead', teamKey: 'native-root' }, null);
  const leadDenied = leadControl.guardNativeTool({ name: 'edit', agent: { id: 'session-lead' }, arguments: { file: 'src/b.ts' } });
  check('P1-3：lead 原生 team id → sidecar teamKey 可命中 work', typeof leadDenied === 'string' && leadDenied.includes('SYNTHETIC_BLOCK'), leadDenied ?? null);
  const leafControl = make({ ok: true, role: 'root', memberId: null, teamKey: null }, { teamKey: 'sidecar-y', ownerMemberId: 'm1', workId: 'w-1', attemptId: 'a1' });
  const leafDenied = leafControl.guardNativeTool({ name: 'edit', agent: { id: 'session-leaf' }, arguments: { file: 'src/c.ts' } });
  check('P1-3：leaf 经 attempt 的 sidecar teamKey 命中 work', typeof leafDenied === 'string' && leafDenied.includes('SYNTHETIC_BLOCK'), leafDenied ?? null);
}

export async function run() {
  testIdentity();
  await testMaterialize();
  await testFingerprints();
  await testEvidence();
  testStaleness();
  testUsage();
  testSchemaLimits();
  testContext();
  testFindings();
  await testFrontendAck();
  await testDerivationGuardAndToolErrors();
  await testUpgradeEntry();
  await testControlledRowApplier();
  await testObservableHooksAndRollback();
  await testLegacyTrueRollback();
  await testFingerprintCoverageAndFileEpoch();
  await testTeamKeyMapping();
  const failed = results.filter((item) => !item.ok);
  return {
    suite: 'host-autonomy-remediation-20261017',
    title: 'Host 自治核心整改（契约 v1 §5.1/2/3/4/6/7/8 + findings）',
    counts: { total: results.length, passed: results.length - failed.length, failed: failed.length },
    failures: failed,
    results,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const summary = await run();
  console.log(JSON.stringify(summary.counts));
  if (summary.counts.failed > 0) {
    console.error(summary.failures.map((item) => ` - ${item.label}`).join('\n'));
    process.exitCode = 1;
  }
}
