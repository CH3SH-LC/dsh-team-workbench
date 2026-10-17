/**
 * `evidence.js` — 证据式完成判定 v2（契约 v1 §3 / 验收 §5.6/§5.7；Codex 只读审阅后重写）
 *
 * ## 为什么 v1 仍是假完成漏洞
 *
 * v1 的 `verification` 只要"文件存在非空 + command 字符串"就判有效，再用
 * `acceptanceIndex` 映射放行。问题：
 * - **任意模型写出的非空文件**都能满足"文件存在"；
 * - **一个从未执行的命令字符串**也算"执行过"；
 * - `failed` / `cancelled` 的 attempt 记录也能被引用；
 * - 验收与产物版本没有绑定，"通过"不指向任何可复核的执行。
 *
 * ## v2 规则：证据必须指向 **Host 记录的真实执行**
 *
 * Host 新增 `execution_runs`（sidecar）与工具 `team_exec_check`：
 * 命令由 **Host 进程**以 `spawn(argv)`（无 shell、无模型参与）执行，记录
 * `{runId, workId, attemptId, argv, cwd, exitCode, status, startedAt, endedAt,
 *   stdoutSha256, stderrSha256, artifactsBefore[], artifactsAfter[], scope}`。
 *
 * | kind | 必须带 | 判定依据（Host 可复核） |
 * |---|---|---|
 * | `verification` | `runId`（Host 记录的 run） | run 属于本 work；`status='completed'`；`exitCode=0`；声明的 `file` 必须出现在 **run.artifactsAfter** 且 sha256 一致；再对当前文件重读一次确认**未被事后篡改** |
 * | `acceptance` | `acceptanceIndex` + `runId`（或 `evidenceRef` 指向有效 verification） | 映射到 work 声明的验收条件；后置条件必须绑定到同一 run 或 run 产物（`postcondition`） |
 * | `execution` | `attemptId` | attempt 属于本 work **且 state='produced'**（failed/cancelled 不算） |
 * | `diagnostic` | `code` | 出现在 Host diagnostics 里 |
 *
 * **证据强度**：
 * - `strong`：来自 Host 记录的 run（verification/acceptance）或已结算 produced 的 attempt。
 * - `weak`：仅"文件存在+命令字符串"（没有 runId）。weak 只能支撑 `produced`（产物交回），
 *   **绝不能**让 work 变成 `accepted`。
 * - `accepted` 门槛：≥1 条 strong verification **且**每条验收条件都映射到 strong acceptance。
 *
 * **离线 / 实机证据范围分开**：
 * `scope` = `offline`（本机 Host 执行）| `batch`（批量验收执行）| `live`（实机/编辑器内观察）。
 * `live` 证据必须指向一条 `scope:'live'` 的 Host 记录；本 Host 不会伪造 live run，
 * 没有 live 记录时直接判 `EVIDENCE_SCOPE_UNAVAILABLE`（不得用 offline 冒充实机）。
 *
 * **版本过期**：run 记录里的产物 sha256 与当前文件不一致 → 证据过期（`EVIDENCE_STALE`），
 * 相关 work 的 `evidenceValid=false`，依赖方**不会被错误解锁**；旧 accepted 保留为
 * owner 历史声明，不批量改写。
 */

import { sha256Hex, stableStringify } from './util.js';

export const EVIDENCE_KINDS = Object.freeze(['execution', 'verification', 'acceptance', 'diagnostic']);
export const EVIDENCE_SCOPES = Object.freeze(['offline', 'batch', 'live']);

/** 证据文件路径归一化（Windows 大小写不敏感）。 */
export function normalizeEvidencePath(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (text.startsWith('./')) text = text.slice(2);
  if (text.endsWith('/')) text = text.slice(0, -1);
  if (!text) return null;
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function samePath(left, right) {
  const a = normalizeEvidencePath(left);
  const b = normalizeEvidencePath(right);
  return Boolean(a && b && a === b);
}

/** 验收条件规范化：用于 acceptanceText 精确匹配。 */
export function normalizeAcceptanceText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * 单条证据的**结构性**判定（不需要 IO）：能不能被映射、缺什么、强度。
 *
 * @returns {{ sample:object, kind:string|null, mapped:boolean, strength:'strong'|'weak'|null,
 *   scope:string|null, reason:string|null, hint:string|null }}
 */
export function classifyEvidenceItem(raw, index = 0) {
  const reject = (reason, hint) => ({ sample: { index, kind: null }, kind: null, mapped: false, strength: null, scope: null, reason, hint });
  if (!isPlainObject(raw)) {
    return reject(
      'EVIDENCE_NOT_MAPPED',
      '证据项必须是对象。裸字符串/裸布尔/裸路径都不算证据。',
    );
  }
  const kind = typeof raw.kind === 'string' ? raw.kind : null;
  if (!kind) {
    return reject('EVIDENCE_NOT_MAPPED', '证据必须声明 kind（execution / verification / acceptance / diagnostic）；只有 ok:true 或 note 的条目不算独立证据。');
  }
  if (!EVIDENCE_KINDS.includes(kind)) {
    return reject('EVIDENCE_KIND_UNKNOWN', `未知证据类型 "${kind}"。`);
  }
  const scope = EVIDENCE_SCOPES.includes(raw.scope) ? raw.scope : null;
  const base = { index, kind, ok: raw.ok === true, scope };

  if (kind === 'execution') {
    const attemptId = typeof raw.attemptId === 'string' && raw.attemptId.trim()
      ? raw.attemptId.trim()
      : (typeof raw.ref === 'string' && raw.ref.trim() ? raw.ref.trim() : null);
    if (!attemptId) {
      return { sample: base, kind, mapped: false, strength: null, scope: null, reason: 'EVIDENCE_EXECUTION_WITHOUT_ATTEMPT', hint: 'execution 证据必须带 attemptId（Host 的 attempt 记录）。' };
    }
    return { sample: { ...base, attemptId }, kind, mapped: true, strength: 'strong', scope, reason: null, hint: null };
  }

  if (kind === 'verification') {
    const runId = typeof raw.runId === 'string' && raw.runId.trim()
      ? raw.runId.trim()
      : (typeof raw.executionId === 'string' && raw.executionId.trim() ? raw.executionId.trim() : null);
    const file = normalizeEvidencePath(raw.file ?? raw.path ?? null);
    const command = typeof raw.command === 'string' ? raw.command.trim() : '';
    if (!runId) {
      // **契约 v4 / Codex 审阅：不存在 weak 通道。** 没有 Host 执行记录（execution_runs）
      // 时：命令字符串 → COMMAND_NOT_EXECUTED；只有文件 → UNTRUSTED_EVIDENCE_FILE；
      // 空条目 → EVIDENCE_WITHOUT_RUN。一律 invalid（不能支撑 accepted，也不支撑 produced）。
      const reason = command && !file
        ? 'COMMAND_NOT_EXECUTED'
        : (file ? 'UNTRUSTED_EVIDENCE_FILE' : 'EVIDENCE_WITHOUT_RUN');
      return {
        sample: { ...base, runId: null, file, command, sha256: null, bytes: null },
        kind,
        mapped: false,
        strength: null,
        scope: null,
        reason,
        hint: reason === 'COMMAND_NOT_EXECUTED'
          ? '命令字符串不等于执行：必须用 team_exec_check 在 Host 里真实跑过并引用返回的 runId。'
          : (reason === 'UNTRUSTED_EVIDENCE_FILE'
            ? '模型写出的非空文件不能证明真实执行：必须引用 Host execution_runs 的 runId + exitCode + 产物哈希。'
            : 'verification 证据必须引用 Host 记录的真实执行 runId。'),
      };
    }
    return {
      sample: {
        ...base,
        runId,
        file,
        command,
        sha256: typeof raw.sha256 === 'string' && /^[0-9a-fA-F]{16,64}$/.test(raw.sha256.trim()) ? raw.sha256.trim().toUpperCase() : null,
        bytes: Number.isInteger(raw.bytes) && raw.bytes >= 0 ? raw.bytes : null,
        version: Number.isInteger(raw.version) ? raw.version : null,
      },
      kind,
      mapped: true,
      strength: 'strong',
      scope,
      reason: null,
      hint: null,
    };
  }

  if (kind === 'acceptance') {
    const acceptanceIndex = Number.isInteger(raw.acceptanceIndex) ? raw.acceptanceIndex : null;
    const acceptanceText = typeof raw.acceptanceText === 'string' && raw.acceptanceText.trim() ? raw.acceptanceText.trim() : null;
    if (acceptanceIndex === null && !acceptanceText) {
      return {
        sample: base,
        kind,
        mapped: false,
        strength: null,
        scope: null,
        reason: 'EVIDENCE_ACCEPTANCE_UNMAPPED',
        hint: 'acceptance 证据必须带 acceptanceIndex（或与声明完全一致的 acceptanceText），并绑定一次真实执行（runId 或 evidenceRef 指向有效 verification）。',
      };
    }
    if (!isPlainObject(raw.postcondition) && !raw.runId && !Number.isInteger(raw.evidenceRef)) {
      return {
        sample: base,
        kind,
        mapped: false,
        strength: null,
        scope: null,
        reason: 'EVIDENCE_ACCEPTANCE_WITHOUT_LINK',
        hint: 'acceptance 必须绑定**后置条件**：postcondition:{kind:"run",runId} 或 postcondition:{kind:"artifact",path,sha256}，或 evidenceRef 指向同批一条有效 verification。',
      };
    }
    return {
      sample: {
        ...base,
        acceptanceIndex,
        acceptanceText,
        runId: typeof raw.runId === 'string' && raw.runId.trim() ? raw.runId.trim() : null,
        evidenceRef: Number.isInteger(raw.evidenceRef) ? raw.evidenceRef : null,
        // 契约 v4：验收必须绑定**已执行检查**（checkId/commandRef → run 内记录 + exitCode）。
        checkId: typeof raw.checkId === 'string' && raw.checkId ? raw.checkId : null,
        commandRef: typeof raw.commandRef === 'string' && raw.commandRef ? raw.commandRef : null,
        postcondition: isPlainObject(raw.postcondition) ? raw.postcondition : null,
        note: typeof raw.note === 'string' ? raw.note : '',
      },
      kind,
      mapped: true,
      strength: 'strong',
      scope,
      reason: null,
      hint: null,
    };
  }

  const code = typeof raw.code === 'string' && raw.code.trim() ? raw.code.trim() : null;
  if (!code) {
    return { sample: base, kind, mapped: false, strength: null, scope: null, reason: 'EVIDENCE_DIAGNOSTIC_WITHOUT_CODE', hint: 'diagnostic 证据必须带 code（Host diagnostics 里真实出现过的错误码）。' };
  }
  return { sample: { ...base, code }, kind, mapped: true, strength: 'strong', scope, reason: null, hint: null };
}

/** 从 run 记录里找产物条目（按路径）。 */
function findRunArtifact(run, filePath) {
  const artifacts = Array.isArray(run?.artifactsAfter) ? run.artifactsAfter : [];
  return artifacts.find((item) => samePath(item?.path, filePath)) ?? null;
}

/**
 * 校验一整批证据（v2）。
 *
 * @param {object} input
 * @param {object[]} input.evidence
 * @param {object} input.work
 * @param {Map<string,object>|object[]} [input.attempts]
 * @param {Map<string,object>|object[]} [input.runs] **Host 记录的 execution_runs**
 * @param {{list?:()=>object[]}} [input.diagnostics]
 * @param {(path:string)=>Promise<{ok:boolean,exists?:boolean,bytes?:number,sha256?:string,error?:string}>} [input.readFile]
 * @param {{requireVerification?:boolean, requireAcceptance?:boolean, requireStrongForAccept?:boolean}} [input.options]
 */
export async function validateEvidence(input = {}) {
  const work = input.work ?? {};
  const rawEvidence = Array.isArray(input.evidence) ? input.evidence : [];
  const toList = (value) => (Array.isArray(value) ? value : [...(value instanceof Map ? value.values() : [])]);
  const attemptsById = new Map(toList(input.attempts).map((attempt) => [String(attempt?.attemptId ?? ''), attempt]));
  const runs = toList(input.runs);
  const runsById = new Map(runs.map((run) => [String(run?.runId ?? ''), run]));
  const diagnosticCodes = new Set(
    (typeof input.diagnostics?.list === 'function' ? input.diagnostics.list() : (Array.isArray(input.diagnostics) ? input.diagnostics : []))
      .map((entry) => String(entry?.code ?? ''))
      .filter(Boolean),
  );
  const readFile = typeof input.readFile === 'function' ? input.readFile : null;
  const acceptance = Array.isArray(work.acceptance) ? work.acceptance.map(normalizeAcceptanceText) : [];
  const options = {
    requireVerification: true,
    requireAcceptance: true,
    requireStrongForAccept: true,
    ...(input.options && typeof input.options === 'object' ? input.options : {}),
  };

  const items = [];
  // P1 假背书修复：每条 acceptance 必须独占一条**已执行检查**（run.checkId/argv + exit0 + 产物版本）。
  // 同一条 run 不能给多条未执行验收背书；同一 checkId 也不能复用。
  const acceptanceRunUsage = new Map();
  const codes = [];
  const hints = [];
  const missing = [];
  let strongVerifications = 0;
  let acceptanceCount = 0;
  let executionCount = 0;
  let diagnosticCount = 0;

  // 只记录失败原因，**不 push**：每个分支末尾统一 `items.push(entry)`，避免同一项进数组两次。
  const failItem = (entry, reason, hint) => {
    entry.reason = reason;
    codes.push(reason);
    if (hint) hints.push(hint);
  };

  if (rawEvidence.length === 0) {
    return {
      ok: false,
      items: [],
      codes: ['EVIDENCE_REQUIRED'],
      missing: ['evidence'],
      hints: ['验收必须给出可复核的证据：先 `team_exec_check` 在 Host 里真实执行命令拿到 runId，再在 `team_work_verify` 的 evidence 里引用它；空证据一律拒绝。'],
      strongVerifications: 0,
      verificationCount: 0,
      acceptanceCount: 0,
      executionCount: 0,
      diagnosticCount: 0,
      digest: sha256Hex('empty').slice(0, 32),
      artifactRefs: [],
      runs: [],
    };
  }

  for (let index = 0; index < rawEvidence.length; index += 1) {
    const classified = classifyEvidenceItem(rawEvidence[index], index);
    const entry = {
      index,
      kind: classified.kind,
      mapped: classified.mapped,
      valid: false,
      strong: false,
      source: null,
      scope: classified.scope,
      reason: classified.reason,
      detail: null,
    };
    if (!classified.mapped) {
      failItem(entry, classified.reason, classified.hint);
      items.push(entry);
      continue;
    }

    // ---- execution -----------------------------------------------------------
    if (classified.kind === 'execution') {
      const attempt = attemptsById.get(String(classified.sample.attemptId));
      if (!attempt) {
        failItem(entry, 'EVIDENCE_ATTEMPT_NOT_FOUND', `execution 证据引用的 attemptId ${classified.sample.attemptId} 在 Host 记录里不存在。`);
      } else if (attempt.workId !== work.workId) {
        failItem(entry, 'EVIDENCE_ATTEMPT_MISMATCH', `attempt ${attempt.attemptId} 属于 work ${attempt.workId}，不是本工作项 ${work.workId}。`);
      } else if (['failed', 'cancelled', 'aborted', 'superseded'].includes(String(attempt.state))) {
        // failed / cancelled / waiting 的执行**不能**证明验收成功。
        failItem(entry, 'ATTEMPT_NOT_SUCCEEDED', `attempt ${attempt.attemptId} 状态是 ${attempt.state}：failed/cancelled/未结算的执行不能作为验收证据（只有 produced 可以）。`);
      } else {
        entry.valid = true;
        entry.strong = true;
        entry.source = 'host-attempt';
        entry.detail = { attemptId: attempt.attemptId, state: attempt.state, attemptSuccessProxy: 'produced', childSessionId: attempt.executorChildId ?? null, artifacts: (attempt.artifactRefs ?? []).length };
        executionCount += 1;
      }
      items.push(entry);
      continue;
    }

    // ---- verification --------------------------------------------------------
    if (classified.kind === 'verification') {
      const sample = classified.sample;
      // 契约 v4：**文件存在性/命令字符串不再是任何 valid 路径**。没有 Host runId 的
      // verification 在 classifyEvidenceItem 已判 invalid（COMMAND_NOT_EXECUTED /
      // UNTRUSTED_EVIDENCE_FILE / EVIDENCE_WITHOUT_RUN），这里不再保留任何 weak 放行分支。
      if (!sample.runId) {
        failItem(entry, classified.reason ?? 'EVIDENCE_WITHOUT_RUN', classified.hint);
        items.push(entry);
        continue;
      }

      // strong：必须有一条真实 Host run 记录。
      const run = runsById.get(String(sample.runId));
      if (!run) {
        failItem(entry, 'EVIDENCE_RUN_NOT_FOUND', `runId ${sample.runId} 不在 Host 的 execution_runs 记录里：命令必须由 team_exec_check 真实执行过。`);
        items.push(entry);
        continue;
      }
      if (run.workId !== work.workId) {
        failItem(entry, 'EVIDENCE_RUN_WORK_MISMATCH', `run ${sample.runId} 属于 work ${run.workId}，不是本工作项 ${work.workId}。`);
        items.push(entry);
        continue;
      }
      if (String(run.status) !== 'completed' || Number(run.exitCode) !== 0) {
        failItem(entry, 'EVIDENCE_RUN_FAILED', `run ${sample.runId} 是 ${run.status}（exitCode=${run.exitCode}）：失败/取消/超时的执行不能证明验收成功。`);
        items.push(entry);
        continue;
      }
      if (sample.scope === 'live' && String(run.scope) !== 'live') {
        failItem(entry, 'EVIDENCE_SCOPE_UNAVAILABLE', `声明 scope=live 但 run ${sample.runId} 是 ${run.scope} 执行：离线/批量证据不能冒充实机证据。`);
        items.push(entry);
        continue;
      }
      if (sample.scope && sample.scope !== 'live' && String(run.scope) !== sample.scope) {
        failItem(entry, 'EVIDENCE_SCOPE_MISMATCH', `证据声明 scope=${sample.scope}，但 run 记录的 scope 是 ${run.scope}。`);
        items.push(entry);
        continue;
      }
      const runArtifacts = Array.isArray(run.artifactsAfter) ? run.artifactsAfter : [];
      if (runArtifacts.length === 0) {
        failItem(entry, 'EVIDENCE_RUN_WITHOUT_ARTIFACTS', `run ${sample.runId} 没有记录任何产物：不能证明这次执行产出了交付物。`);
        items.push(entry);
        continue;
      }
      const declaredFiles = sample.file ? [sample.file] : runArtifacts.map((item) => item.path);
      // 契约 v4：产物版本必须与 work.artifactRefs 的 path@version 匹配（缺版本也算不匹配）。
      const refs = Array.isArray(work.artifactRefs) ? work.artifactRefs : [];
      for (const declared of declaredFiles) {
        const ref = refs.find((candidate) => samePath(candidate?.path, declared));
        if (!ref) continue;
        const refVersion = Number.isInteger(ref.version) ? ref.version : (Number(ref.version) || null);
        if (sample.version === null || refVersion === null || Number(sample.version) !== Number(refVersion)) {
          failItem(entry, 'ARTIFACT_VERSION_MISMATCH', `产物 ${declared} 的版本不匹配（evidence=${sample.version ?? 'missing'}，artifactRefs=${refVersion ?? 'missing'}）。`);
          break;
        }
      }
      if (entry.reason === 'ARTIFACT_VERSION_MISMATCH') { items.push(entry); continue; }
      let tampered = null;
      for (const file of declaredFiles) {
        const artifact = findRunArtifact(run, file);
        if (!artifact) {
          tampered = { path: file, reason: 'NOT_IN_RUN' };
          break;
        }
        if (sample.sha256 && String(artifact.sha256 ?? '').toUpperCase() !== sample.sha256) {
          tampered = { path: file, reason: 'DECLARED_HASH_MISMATCH' };
          break;
        }
        // 事后篡改检测：当前文件必须仍与 run 记录的 sha256 一致。
        if (readFile) {
          const current = await readFile(file);
          if (!current || current.ok !== true || current.exists === false) {
            tampered = { path: file, reason: 'FILE_MISSING' };
            break;
          }
          if (artifact.sha256 && String(current.sha256 ?? '').toUpperCase() !== String(artifact.sha256).toUpperCase()) {
            tampered = { path: file, reason: 'CHANGED_AFTER_RUN' };
            break;
          }
        }
      }
      if (tampered) {
        failItem(
          entry,
          'EVIDENCE_STALE',
          `run ${sample.runId} 的产物 ${tampered.path} 与记录不一致（${tampered.reason}）：证据已过期，需重新执行 team_exec_check。`,
        );
        items.push(entry);
        continue;
      }
      // 命令元数据若声明，必须与 run 实际 argv 一致（防止"贴一个没跑过的命令"）。
      if (sample.command) {
        const actual = [run.command ?? '', ...(Array.isArray(run.argv) ? run.argv : [])].join(' ').toLowerCase();
        if (!actual.includes(sample.command.toLowerCase().slice(0, 64))) {
          failItem(entry, 'EVIDENCE_COMMAND_MISMATCH', `证据里的 command 与 run ${sample.runId} 实际执行的不一致：命令字符串不能替代 runId。`);
          items.push(entry);
          continue;
        }
      }
      entry.valid = true;
      entry.strong = true;
      entry.source = 'host-run';
      entry.detail = {
        runId: run.runId,
        scope: run.scope ?? sample.scope ?? 'offline',
        exitCode: run.exitCode,
        status: run.status,
        artifacts: runArtifacts.map((item) => ({ path: item.path, sha256: item.sha256 ?? null, bytes: item.bytes ?? null })),
        durationsMs: run.durationsMs ?? null,
      };
      strongVerifications += 1;
      items.push(entry);
      continue;
    }

    // ---- acceptance ----------------------------------------------------------
    if (classified.kind === 'acceptance') {
      const sample = classified.sample;
      let resolvedIndex = sample.acceptanceIndex;
      if (resolvedIndex === null && sample.acceptanceText) {
        resolvedIndex = acceptance.findIndex((item) => item === normalizeAcceptanceText(sample.acceptanceText));
      }
      if (!Number.isInteger(resolvedIndex) || resolvedIndex < 0 || resolvedIndex >= acceptance.length) {
        failItem(entry, 'EVIDENCE_ACCEPTANCE_UNMAPPED', `acceptance 证据没有映射到该 work 声明的验收条件（共 ${acceptance.length} 条）。`);
        items.push(entry);
        continue;
      }
      // 后置条件必须绑定到 strong verification 的 run 或 run 产物。
      const refIndex = Number.isInteger(sample.evidenceRef) ? sample.evidenceRef : null;
      const backings = refIndex !== null
        ? items.filter((item) => item.index === refIndex)
        : items.filter((item) => item.valid && item.kind === 'verification');
      const strongBacking = backings.find((item) => item.valid && item.strong === true && item.kind === 'verification');
      const postcondition = sample.postcondition;
      let postconditionOk = Boolean(strongBacking);
      let postconditionDetail = null;
      if (postcondition) {
        if (postcondition.kind === 'run') {
          const run = runsById.get(String(postcondition.runId ?? ''));
          postconditionOk = Boolean(run && run.workId === work.workId && String(run.status) === 'completed' && Number(run.exitCode) === 0);
          postconditionDetail = { kind: 'run', runId: postcondition.runId ?? null, ok: postconditionOk };
        } else if (postcondition.kind === 'artifact') {
          const file = normalizeEvidencePath(postcondition.path);
          const sha = typeof postcondition.sha256 === 'string' ? postcondition.sha256.toUpperCase() : null;
          const linked = strongBacking?.detail?.artifacts?.find((artifact) => samePath(artifact.path, file));
          postconditionOk = Boolean(linked) && (!sha || String(linked.sha256 ?? '').toUpperCase() === sha);
          postconditionDetail = { kind: 'artifact', path: file, ok: postconditionOk, runId: strongBacking?.detail?.runId ?? null };
        } else {
          postconditionOk = false;
          postconditionDetail = { kind: String(postcondition.kind ?? 'unknown'), ok: false };
        }
      }
      // 契约 v4：验收必须绑定**本次 run 中已执行的检查**（checkId/commandRef ↔ execution_runs 的
      // command/checkId + exitCode）；`evidenceRef` 只作引用，**不再免费放行**。
      // P1-1：验收只能映射到**计划期冻结检查**（checkId 精确相等 + acceptanceIndexes 覆盖 + planRevision 匹配）。
      // 禁止：调用者重标 checkId、子串/前缀绑定、旧 plan 的 run、额外 argv 扩大；声明检查可合法覆盖多个验收条件（这里只按索引映射，不做"一 run 一验收"机械限制）。
      const boundRun = strongBacking?.detail?.runId ? runsById.get(String(strongBacking?.detail?.runId)) : null;
      const requestedCheckId = typeof sample.checkId === 'string' ? sample.checkId.trim() : (typeof sample.commandRef === 'string' ? sample.commandRef.trim() : '');
      const runCheckId = String(boundRun?.checkId ?? '');
      const checkIdExact = requestedCheckId.length > 0 && runCheckId.length > 0 && requestedCheckId === runCheckId;
      const coveredIndexes = Array.isArray(boundRun?.acceptanceIndexes)
        ? boundRun.acceptanceIndexes.map(Number)
        : (Number.isInteger(boundRun?.acceptanceIndex) ? [Number(boundRun.acceptanceIndex)] : []);
      const covered = Number.isInteger(resolvedIndex) && coveredIndexes.includes(Number(resolvedIndex));
      const runRevision = boundRun?.planRevision;
      const revisionMatch = runRevision === null || runRevision === undefined
        || work?.planRevision === null || work?.planRevision === undefined
        || Number(runRevision) === Number(work.planRevision);
      const uniqueKey = String(boundRun?.runId ?? boundRun?.executionRunId ?? '') + '#' + String(resolvedIndex);
      const duplicated = acceptanceRunUsage.has(uniqueKey);
      const runChecked = Boolean(boundRun) && String(boundRun.status) === 'completed' && Number(boundRun.exitCode) === 0
        && checkIdExact && covered && revisionMatch && !duplicated;
      if (!runChecked) {
        const code = duplicated
          ? 'ACCEPTANCE_DUPLICATE'
          : (!requestedCheckId
            ? 'CHECKID_REQUIRED'
            : (runCheckId && requestedCheckId !== runCheckId ? 'CHECKID_MISMATCH' : 'ACCEPTANCE_NOT_COVERED'));
        failItem(entry, code, !requestedCheckId
          ? '验收必须带计划期冻结的 checkId（不能把自由文本/子串映射成放行）。'
          : `验收 ${resolvedIndex} 未绑定到已执行的冻结检查（requested=${requestedCheckId}, run=${runCheckId || 'missing'}）。`);
        items.push(entry);
        continue;
      }
      acceptanceRunUsage.set(uniqueKey, true);
      if (!postconditionOk) {
        failItem(entry, 'EVIDENCE_POSTCONDITION_FAILED', '验收的后置条件没有通过：postcondition 指向的 run 不成功，或其产物 hash 与验证记录不一致。');
        items.push(entry);
        continue;
      }
      entry.valid = true;
      entry.strong = true;
      entry.source = 'acceptance-mapping';
      entry.detail = { acceptanceIndex: resolvedIndex, acceptanceText: acceptance[resolvedIndex], evidenceRef: refIndex, checkId: sample.checkId ?? null, commandRef: sample.commandRef ?? null, runId: strongBacking?.detail?.runId ?? null, postcondition: postconditionDetail };
      acceptanceCount += 1;
      items.push(entry);
      continue;
    }

    // ---- diagnostic ----------------------------------------------------------
    const code = classified.sample.code;
    if (!diagnosticCodes.has(code)) {
      failItem(entry, 'EVIDENCE_DIAGNOSTIC_UNKNOWN', `diagnostic 证据引用的错误码 "${code}" 没有出现在 Host diagnostics 里。`);
    } else {
      entry.valid = true;
      entry.strong = true;
      entry.source = 'host-diagnostic';
      entry.detail = { code };
      diagnosticCount += 1;
    }
    items.push(entry);
  }

  // 契约 v4：没有 weak 通道；verification 计数只统计 strong（来自 Host run）。
  const verificationCount = strongVerifications;

  // Codex 审阅 3：**成功的 `node -e ""` 不能给所有验收条件背书**。
  // 要求：work 声明的每个产物都必须被某条 strong verification 的 run 真实覆盖
  // （run.artifactsAfter 里出现且 sha256 一致），否则不能 accepted。
  const declaredOutputs = Array.isArray(work.outputs) ? work.outputs.map(normalizeEvidencePath).filter(Boolean) : [];
  const coveredOutputs = new Set(
    items
      .filter((item) => item.valid && item.strong === true && item.kind === 'verification')
      .flatMap((item) => (item.detail?.artifacts ?? []).map((artifact) => normalizeEvidencePath(artifact.path)))
      .filter(Boolean),
  );
  const uncoveredOutputs = declaredOutputs.filter((output) => !coveredOutputs.has(output));
  if (uncoveredOutputs.length > 0) {
    missing.push('outputs-not-covered');
    codes.push('EVIDENCE_OUTPUTS_NOT_COVERED');
    hints.push(`这些声明产物没有被任何可信执行覆盖：${uncoveredOutputs.join('、')}。在 team_exec_check 的 artifacts 里包含它们（记录执行后 sha256），再引用该 runId。`);
  }

  // 同一条验收条件不能被重复计数（防止"多写几行 acceptanceIndex"凑数）。
  const acceptanceIndexes = items
    .filter((item) => item.valid && item.kind === 'acceptance')
    .map((item) => item.detail?.acceptanceIndex)
    .filter((index) => Number.isInteger(index));
  if (new Set(acceptanceIndexes).size !== acceptanceIndexes.length) {
    codes.push('EVIDENCE_ACCEPTANCE_DUPLICATED');
    hints.push('同一 acceptanceIndex 出现了多次：每条验收条件只需一条证据，重复计数不算覆盖更多条件。');
    missing.push('acceptance-duplicated');
  }

  // 证据层级（scope ceiling）：offline < batch < live。**只降不升**——
  // offline 证据永远不能声称实机/接入/玩法/用户接受。
  const scopeRank = { offline: 1, batch: 2, live: 3 };
  let highestScope = null;
  let highestRank = 0;
  for (const item of items) {
    if (item.valid !== true) continue;
    const scope = item.scope ?? item.detail?.scope ?? null;
    const rank = scopeRank[scope] ?? 0;
    if (rank > highestRank) {
      highestRank = rank;
      highestScope = scope;
    }
  }
  const ceiling = highestScope === 'live'
    ? 'live-observed'
    : (highestScope === 'batch' ? 'batch-verified' : (highestScope === 'offline' ? 'offline-verified' : 'none'));
  if (options.requireVerification && verificationCount === 0) {
    missing.push('verification-evidence');
    if (!codes.includes('EVIDENCE_VERIFICATION_MISSING')) {
      codes.push('EVIDENCE_VERIFICATION_MISSING');
      hints.push('至少一条 verification 证据；accepted 还要求它来自 Host 真实执行（team_exec_check → runId）。');
    }
  }
  if (options.requireStrongForAccept && strongVerifications === 0 && rawEvidence.length > 0) {
    missing.push('strong-verification-evidence');
    if (!codes.includes('EVIDENCE_STRONG_VERIFICATION_MISSING')) {
      codes.push('EVIDENCE_STRONG_VERIFICATION_MISSING');
      hints.push('没有任何来自 Host 真实执行的验证：Weak 证据（文件存在 + 命令字符串）只能支撑 produced，不能让 work 变成 accepted。请先 team_exec_check 拿到 runId。');
    }
  }
  if (options.requireAcceptance && acceptance.length > 0 && acceptanceCount < acceptance.length) {
    missing.push('acceptance-evidence');
    if (!codes.includes('EVIDENCE_ACCEPTANCE_INCOMPLETE')) {
      codes.push('EVIDENCE_ACCEPTANCE_INCOMPLETE');
      hints.push(`验收条件有 ${acceptance.length} 条，只覆盖了 ${acceptanceCount} 条（每条都要绑定真实执行的后置条件）。`);
    }
  }

  const artifactRefs = items
    .filter((item) => item.valid && item.kind === 'verification')
    .flatMap((item) => (item.detail?.artifacts ?? (item.detail?.file ? [{ path: item.detail.file, sha256: item.detail.sha256 ?? null, bytes: item.detail.bytes ?? null }] : [])));
  const digest = sha256Hex(
    stableStringify(items.map((item) => ({ kind: item.kind, valid: item.valid, strong: item.strong, source: item.source, detail: item.detail ?? null }))),
  ).slice(0, 32);

  return {
    ok: codes.length === 0 && missing.length === 0,
    items,
    codes: [...new Set(codes)],
    missing: [...new Set(missing)],
    hints: [...new Set(hints)],
    verificationCount,
    strongVerifications,
    acceptanceCount,
    executionCount,
    diagnosticCount,
    digest,
    artifactRefs,
    runs: items.filter((item) => item.kind === 'verification' && item.detail?.runId).map((item) => item.detail.runId),
  };
}

/**
 * 证据是否过期：`record` 是校验时写入的快照；与 run 记录/当前文件比对。
 * @param {object} record
 * @param {Map<string,{sha256?:string,bytes?:number,exists?:boolean}>} currentByPath
 */
export function isEvidenceStale(record, currentByPath) {
  const files = Array.isArray(record?.files) ? record.files : [];
  if (files.length === 0) return { stale: false, changed: [] };
  const changed = [];
  for (const file of files) {
    const current = currentByPath instanceof Map ? currentByPath.get(file.path) : currentByPath?.[file.path];
    if (!current) continue;
    if (current.exists === false) changed.push({ path: file.path, reason: 'FILE_MISSING' });
    else if (file.bytes !== null && file.bytes !== undefined && current.bytes !== file.bytes) changed.push({ path: file.path, reason: 'BYTES_CHANGED' });
    else if (file.sha256 && current.sha256 && String(file.sha256).toUpperCase() !== String(current.sha256).toUpperCase()) changed.push({ path: file.path, reason: 'SHA256_CHANGED' });
  }
  return { stale: changed.length > 0, changed };
}

/** 由校验结果生成 evidence 记录（写 sidecar，供过期判定与 findings 使用）。 */
export function evidenceRecordFor({ work, validation, attemptId, at, verifiedBy }) {
  return {
    workId: work?.workId ?? null,
    teamKey: work?.teamKey ?? null,
    ownerMemberId: work?.ownerMemberId ?? null,
    attemptId: attemptId ?? null,
    verifiedBy: verifiedBy ?? null,
    at: at ?? 0,
    digest: validation?.digest ?? null,
    codes: validation?.codes ?? [],
    valid: validation?.ok === true,
    strong: (validation?.strongVerifications ?? 0) > 0,
    strongVerifications: validation?.strongVerifications ?? 0,
    acceptanceCount: validation?.acceptanceCount ?? 0,
    executionCount: validation?.executionCount ?? 0,
    diagnosticCount: validation?.diagnosticCount ?? 0,
    runIds: validation?.runs ?? [],
    scopes: [...new Set((validation?.items ?? []).map((item) => item.scope).filter(Boolean))],
    files: (validation?.artifactRefs ?? []).map((item) => ({ path: item.path, sha256: item.sha256, bytes: item.bytes })),
    items: (validation?.items ?? []).map((item) => ({
      index: item.index,
      kind: item.kind,
      valid: item.valid,
      strong: item.strong === true,
      source: item.source,
      scope: item.scope ?? null,
      reason: item.reason ?? null,
    })),
  };
}

/** 把 validation 的结果转成 `completion` 形状（**accepted 才清 missing**）。 */
export function completionFromValidation({ work, validation, accepted, at, verifiedBy }) {
  const acceptance = Array.isArray(work?.acceptance) ? work.acceptance.length : 0;
  if (accepted) {
    return {
      level: 'accepted',
      pendingUserAcceptance: true,
      missing: [],
      verifiedBy: verifiedBy ?? null,
      verifiedAt: at ?? 0,
      evidenceDigest: validation?.digest ?? null,
      evidenceStrong: (validation?.strongVerifications ?? 0) > 0,
      evidenceCounts: {
        strongVerifications: validation?.strongVerifications ?? 0,
        acceptance: validation?.acceptanceCount ?? 0,
        execution: validation?.executionCount ?? 0,
        diagnostic: validation?.diagnosticCount ?? 0,
      },
      acceptanceRequired: acceptance,
    };
  }
  return {
    level: 'produced',
    pendingUserAcceptance: true,
    missing: validation?.missing?.length > 0 ? validation.missing : ['owner-verification'],
    reasons: validation?.codes ?? [],
    hints: validation?.hints ?? [],
    evidenceDigest: validation?.digest ?? null,
    acceptanceRequired: acceptance,
  };
}



/**
 * **证据门版本**（契约 v4 / Codex 统一验收负例）：热升级 postcondition 通过它自证
 * "非空文件 + 自报命令"仍被拒绝、"runId+exit0+artifact 版本+checkId 绑定"可通过。
 * 纯内存构造、无副作用、不写盘、不调用模型。
 */
export const EVIDENCE_GATE_VERSION = 'evidence-gate-v2';

export async function probeEvidenceGate() {
  const work = {
    workId: 'probe-work',
    teamKey: 'probe-team',
    ownerMemberId: 'probe-owner',
    outputs: ['probe/artifact.txt'],
    acceptance: ['probe acceptance'],
    artifactRefs: [{ path: 'probe/artifact.txt', version: 1 }],
  };
  const readFile = async () => ({ ok: true, exists: true, bytes: 12, sha256: 'A'.repeat(64) });
  // 负例：模型写出的非空文件 + 自报 command（没有任何 Host run 记录）。
  const negative = await validateEvidence({
    work,
    evidence: [{ kind: 'verification', file: 'probe/artifact.txt', command: 'node --test', ok: true }],
    attempts: [],
    runs: [],
    readFile,
  });
  const negativeCode = (negative.codes ?? []).find((code) => code === 'UNTRUSTED_EVIDENCE_FILE' || code === 'COMMAND_NOT_EXECUTED') ?? (negative.codes ?? [])[0] ?? null;
  // 正例：真实 runId + exit0 + 产物版本 + checkId 绑定。
  const run = {
    runId: 'probe-run',
    workId: work.workId,
    status: 'completed',
    exitCode: 0,
    checkId: 'probe-check',
    acceptanceIndexes: [0],
    command: 'node',
    argv: ['--probe'],
    artifactsAfter: [{ path: 'probe/artifact.txt', sha256: 'A'.repeat(64), bytes: 12 }],
  };
  const positive = await validateEvidence({
    work,
    evidence: [
      { kind: 'verification', runId: 'probe-run', file: 'probe/artifact.txt', version: 1, checkId: 'probe-check' },
      { kind: 'acceptance', acceptanceIndex: 0, checkId: 'probe-check', evidenceRef: 0 },
    ],
    attempts: [],
    runs: [run],
    readFile,
  });
  return {
    version: EVIDENCE_GATE_VERSION,
    negativeCase: { rejected: negative.ok === false && Boolean(negativeCode), code: negativeCode },
    positiveCase: { ok: positive.ok === true, codes: positive.codes ?? [] },
  };
}
