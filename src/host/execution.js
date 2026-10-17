/**
 * `execution.js` — 可信执行记录（证据式完成判定的唯一来源；契约 v1 §3 修订）。
 *
 * ## 为什么必须由 Host 执行
 *
 * 旧证据规则里，`{kind:'verification', command:'npm test', ok:true}` 就够——**命令字符串
 * 从未被执行**也能把 work 标成已验收。改造后：证据必须引用 `runId`，而 `runId` 只能由
 * 本模块在 Host 进程里**真实 spawn** 出来。
 *
 * ## 记录形状（`execution_runs` sidecar）
 *
 * ```jsonc
 * {
 *   "runId": "run-…",
 *   "workId": "…", "attemptId": "…"|null, "teamKey": "…", "ownerMemberId": "…",
 *   "scope": "offline" | "batch",          // live 只能由外部捕获导入，本 Host 不伪造
 *   "command": "node", "argv": ["--test"], "cwd": "…",
 *   "status": "completed" | "failed" | "timeout" | "spawn-error",
 *   "exitCode": 0, "signal": null,
 *   "startedAt": 0, "endedAt": 0, "durationsMs": 0,
 *   "stdoutBytes": 0, "stdoutSha256": "…", "stderrBytes": 0, "stderrSha256": "…",
 *   "stdoutTail": "…（截断，只留尾部供人看；不进模型上下文）",
 *   "artifactsBefore": [{path,sha256,bytes,exists}],
 *   "artifactsAfter":  [{path,sha256,bytes}],
 *   "noModelCalls": true
 * }
 * ```
 *
 * ## 安全边界
 *
 * - **不用 shell**：`spawn(command, argv, {shell:false})`，argv 是数组，杜绝命令拼接注入。
 * - `cwd` 必须在允许根内；产物路径同样必须在允许根内。
 * - 环境变量**只传允许列表**（PATH/SystemRoot/TEMP/…），不把含密钥的 env 传给子进程。
 * - 输出有上限（默认 256KB），超出即截断并标记；只保留尾部供人工查看。
 * - 超时强制 kill（SIGKILL after grace），记 `status:'timeout'`。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newId } from './util.js';

export const RUN_TABLE = 'execution_runs';
export const RUN_STATUSES = Object.freeze(['completed', 'failed', 'timeout', 'spawn-error']);

/** 允许传给子进程的环境变量（不含任何密钥/凭据）。 */
const ENV_ALLOWLIST = Object.freeze([
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR',
  'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'COMSPEC', 'ComSpec', 'NODE_PATH',
  'LANG', 'LC_ALL', 'TZ', 'SHELL', 'APPDATA', 'LOCALAPPDATA',
]);

export function safeEnv(base = process.env) {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (base && typeof base[key] === 'string') env[key] = base[key];
  }
  return env;
}

function sha256Text(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex').toUpperCase();
}

export function withinRoot(absolute, roots) {
  const target = path.resolve(String(absolute));
  for (const root of roots ?? []) {
    const base = path.resolve(String(root));
    if (target === base) return base;
    const withSep = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
    if (target.startsWith(withSep)) return base;
  }
  return null;
}

async function digestFile(absolute, maxBytes = 1024 * 1024) {
  try {
    const info = await fsp.stat(absolute);
    if (!info.isFile()) return { exists: false, reason: 'NOT_A_FILE' };
    if (info.size > maxBytes) {
      return { exists: true, sha256: null, bytes: info.size, oversized: true };
    }
    const hash = createHash('sha256');
    const handle = await fsp.open(absolute, 'r');
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
    return { exists: true, sha256: hash.digest('hex').toUpperCase(), bytes: info.size, mtimeMs: info.mtimeMs };
  } catch (error) {
    const code = String(error?.code ?? '');
    if (code === 'ENOENT') return { exists: false, sha256: null, bytes: 0 };
    return { exists: false, sha256: null, bytes: 0, error: `${code || 'STAT_FAILED'}: ${String(error?.message ?? error)}` };
  }
}

/**
 * 创建可信执行器。
 *
 * @param {{
 *   storage: object,
 *   clock: {now:()=>number},
 *   roots: string[],
 *   cwd?: string,
 *   maxTimeoutMs?: number,
 *   maxOutputBytes?: number,
 *   table?: string,
 *   spawnImpl?: Function,
 * }} deps
 */
export function createExecutionRunner(deps = {}) {
  const storage = deps.storage;
  const clock = deps.clock ?? { now: () => Date.now() };
  const roots = (Array.isArray(deps.roots) && deps.roots.length > 0 ? deps.roots : [process.cwd()]).map((root) => path.resolve(String(root)));
  const baseCwd = deps.cwd ?? process.cwd();
  const maxTimeoutMs = Number.isFinite(deps.maxTimeoutMs) ? Number(deps.maxTimeoutMs) : 10 * 60 * 1000;
  const maxOutputBytes = Number.isFinite(deps.maxOutputBytes) ? Number(deps.maxOutputBytes) : 256 * 1024;
  const table = deps.table ?? RUN_TABLE;
  const spawnImpl = deps.spawnImpl ?? spawn;
  const runs = new Map();

  function hydrate() {
    runs.clear();
    for (const [key, value] of storage.list(table)) runs.set(key, value);
    return runs.size;
  }

  function listRuns() {
    return [...runs.values()];
  }

  function runFor(runId) {
    return runs.get(String(runId)) ?? null;
  }

  function fail(code, message, extra = {}) {
    return { ok: false, code, message, ...extra };
  }

  /**
   * 真实执行一条命令并记录 run。
   *
   * @param {object} request
   * @param {string} request.workId
   * @param {string} [request.attemptId]
   * @param {string} [request.teamKey]
   * @param {string} [request.ownerMemberId]
   * @param {string} request.command 可执行文件（不经 shell）
   * @param {string[]} [request.argv]
   * @param {string} [request.cwd]
   * @param {string[]} [request.artifacts] 必须在执行后存在/更新的产物路径
   * @param {'offline'|'batch'} [request.scope]
   * @param {number} [request.timeoutMs]
   */
  async function run(request = {}) {
    const workId = typeof request.workId === 'string' ? request.workId.trim() : '';
    if (!workId) return fail('RUN_WORK_REQUIRED', '可信执行必须绑定 workId（run 记录要能追溯到交付物）。');
    const command = typeof request.command === 'string' ? request.command.trim() : '';
    if (!command) return fail('RUN_COMMAND_REQUIRED', '必须给出可执行命令（例如 node / npm / pwsh 脚本路径）。');
    const argv = Array.isArray(request.argv) ? request.argv.map((item) => String(item)) : [];
    // P1-1：**执行时**固化计划身份（不能等验收时按当时的 work 追认补写）。
    // 这三项来自计划期冻结的 verificationCommands，由 runVerification 精确匹配后传入；
    // 之后 acceptance 证据只认这里固化的 checkId/acceptanceIndexes/planRevision。
    const frozenCheckId = typeof request.checkId === 'string' && request.checkId ? request.checkId : null;
    const frozenAcceptanceIndexes = Array.isArray(request.acceptanceIndexes)
      ? request.acceptanceIndexes.filter((value) => Number.isInteger(value))
      : [];
    const frozenPlanRevision = Number.isInteger(request.planRevision) ? request.planRevision : null;
    const scope = request.scope === 'live' ? 'live' : (request.scope === 'batch' ? 'batch' : 'offline');
    if (scope === 'live') {
      return fail(
        'LIVE_SCOPE_UNAVAILABLE',
        'Host 不能伪造实机（live）证据：live 只能由真实编辑器/引擎内的捕获记录导入，不接受本工具生成。',
        { hint: '离线证据用 scope:"offline"；批量验收用 scope:"batch"。实机证据需要外部捕获 + 用户确认，本 Host 不代填。' },
      );
    }
    const cwd = path.resolve(baseCwd, request.cwd ?? '.');
    if (!withinRoot(cwd, roots)) {
      return fail('RUN_CWD_OUTSIDE_ROOTS', `cwd 不在允许根内：${cwd}`, { allowedRoots: roots });
    }
    const timeoutMs = Math.min(Math.max(Number(request.timeoutMs) || 120000, 1000), maxTimeoutMs);
    const artifactPaths = (Array.isArray(request.artifacts) ? request.artifacts : [])
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => path.resolve(baseCwd, item.trim()));
    const outside = artifactPaths.find((absolute) => !withinRoot(absolute, roots));
    if (outside) return fail('RUN_ARTIFACT_OUTSIDE_ROOTS', `产物路径不在允许根内：${outside}`, { allowedRoots: roots });

    const artifactsBefore = [];
    for (const absolute of artifactPaths) artifactsBefore.push({ path: absolute, ...(await digestFile(absolute)) });

    const runId = newId('run');
    const startedAt = clock.now();
    const result = await new Promise((resolve) => {
      let settled = false;
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let spawnError = null;
      let timer = null;
      let child;
      const finish = (exitCode, signal) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ exitCode, signal, timedOut, spawnError, stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr: Buffer.concat(stderrChunks).toString('utf8'), stdoutBytes, stderrBytes });
      };
      try {
        child = spawnImpl(command, argv, { cwd, env: safeEnv(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        finish(null, null);
        spawnError = error;
        return;
      }
      child.on('error', (error) => {
        spawnError = error;
        finish(null, null);
      });
      if (child.stdout) {
        child.stdout.on('data', (chunk) => {
          stdoutBytes += chunk.length;
          if (stdoutBytes <= maxOutputBytes) stdoutChunks.push(chunk);
        });
      }
      if (child.stderr) {
        child.stderr.on('data', (chunk) => {
          stderrBytes += chunk.length;
          if (stderrBytes <= maxOutputBytes) stderrChunks.push(chunk);
        });
      }
      child.on('close', (code, signal) => finish(code, signal));
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
        finish(null, 'SIGKILL');
      }, timeoutMs);
      if (typeof timer?.unref === 'function') timer.unref();
    });

    const endedAt = clock.now();
    const artifactsAfter = [];
    for (const absolute of artifactPaths) {
      const digest = await digestFile(absolute);
      const relative = path.relative(baseCwd, absolute).replace(/\\/g, '/');
      artifactsAfter.push({ path: relative, absolute, sha256: digest.sha256 ?? null, bytes: digest.bytes ?? 0, exists: digest.exists === true });
    }
    const exitedZero = Number(result.exitCode) === 0 && !result.timedOut && !result.spawnError;
    const status = result.spawnError
      ? 'spawn-error'
      : (result.timedOut ? 'timeout' : (exitedZero ? 'completed' : 'failed'));
    const record = {
      runId,
      workId,
      attemptId: request.attemptId ?? null,
      teamKey: request.teamKey ?? null,
      ownerMemberId: request.ownerMemberId ?? null,
      scope,
      command,
      argv,
      // P1-1：执行时固化的计划身份（旧 run 没有这三项 → 不能给新计划验收背书）。
      planRevision: frozenPlanRevision,
      checkId: frozenCheckId,
      acceptanceIndexes: frozenAcceptanceIndexes,
      cwd,
      status,
      exitCode: result.exitCode === null || result.exitCode === undefined ? null : Number(result.exitCode),
      signal: result.signal ?? null,
      startedAt,
      endedAt,
      durationsMs: endedAt - startedAt,
      timeoutMs,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      stdoutSha256: sha256Text(result.stdout),
      stderrSha256: sha256Text(result.stderr),
      stdoutTail: result.stdout.slice(-2000),
      stderrTail: result.stderr.slice(-2000),
      truncated: result.stdoutBytes > maxOutputBytes || result.stderrBytes > maxOutputBytes,
      artifactsBefore,
      artifactsAfter,
      observedOutputs: artifactsAfter.filter((artifact) => artifact.exists === true).map((artifact) => artifact.path),
      noModelCalls: true,
      recordedAt: clock.now(),
    };
    const stored = await storage.put(table, runId, record, { idempotencyKey: `run:${runId}` });
    const committed = stored.ok ? (stored.record ?? record) : record;
    runs.set(runId, committed);
    if (!stored.ok) {
      return fail('RUN_NOT_PERSISTED', `run 记录写入失败（${stored.code}）：没有持久记录的执行不能作为证据。`, { run: committed });
    }
    return {
      ok: true,
      runId,
      workId,
      status,
      exitCode: record.exitCode,
      timedOut: result.timedOut === true,
      spawnError: result.spawnError ? String(result.spawnError?.message ?? result.spawnError) : null,
      durationsMs: record.durationsMs,
      stdoutSha256: record.stdoutSha256,
      stderrSha256: record.stderrSha256,
      stdoutTail: record.stdoutTail,
      stderrTail: record.stderrTail,
      artifactsAfter: record.artifactsAfter,
      scope,
      noModelCalls: true,
      note: exitedZero
        ? `Host 已真实执行并记录 runId=${runId}（exitCode=0）：在 evidence 里引用它，不要贴命令字符串。`
        : `命令执行结果为 ${status}（exitCode=${record.exitCode}）：失败/超时的执行不能作为验收证据。`,
    };
  }

  /**
   * **native 模式**（Lead 第 13/14 回合 A-2）：经原生 `tools.execute`（policy/approval）执行。
   *
   * 证据三件套全部宿主侧计算：
   * 1. `adapter.executeTool` 返回的官方结果（成功/失败码）；
   * 2. 宿主生成的临时文件里的 exitCode（包装脚本只追加写 exit code，不改变命令语义；
   *    **stdout 标记只作 breadcrumb，不作权威证据**）；
   * 3. 宿主读声明的产物路径、自己算 sha256/大小（`digestFile`/adapter.readFileInfo）。
   *
   * 拒绝/approval 不可用/异常 → `{ok:false, nativeAuthorization:false, code}`，由调用方 **fail-closed**。
   */
  async function runNative(request = {}) {
    const workId = typeof request.workId === 'string' ? request.workId.trim() : '';
    if (!workId) return fail('RUN_WORK_REQUIRED', '可信执行必须绑定 workId。');
    const adapter = request.adapter;
    const agent = request.agent;
    if (!adapter || typeof adapter.executeTool !== 'function') return fail('NATIVE_EXECUTION_UNAVAILABLE', '没有原生 tools.execute 入口（fail-closed，不降级）。');
    if (!agent) return fail('NATIVE_AGENT_REQUIRED', 'native 执行需要真实 live agent（policy/visibility）。');
    const command = typeof request.command === 'string' ? request.command.trim() : '';
    if (!command) return fail('RUN_COMMAND_REQUIRED', '必须给出可执行命令。');
    const argv = Array.isArray(request.argv) ? request.argv.map(String) : [];
    // P1-1：与直接执行一致——native 路径同样在**执行时**固化计划身份。
    const frozenCheckId = typeof request.checkId === 'string' && request.checkId ? request.checkId : null;
    const frozenAcceptanceIndexes = Array.isArray(request.acceptanceIndexes)
      ? request.acceptanceIndexes.filter((value) => Number.isInteger(value))
      : [];
    const frozenPlanRevision = Number.isInteger(request.planRevision) ? request.planRevision : null;
    const scope = request.scope === 'batch' ? 'batch' : 'offline';
    const runId = newId('run');
    const exitFile = path.join(os.tmpdir(), `twb-exec-${runId}.exit`);
    // 包装脚本：只执行声明命令并把 **exit code** 追加写到宿主临时文件（不改变命令语义）。
    const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const invocation = [quote(command), ...argv.map(quote)].join(' ');
    const script = [
      `$ErrorActionPreference = 'Continue'`,
      `& ${invocation}`,
      `$__twbCode = $LASTEXITCODE`,
      `Set-Content -LiteralPath ${quote(exitFile)} -Value $__twbCode -NoNewline -Encoding ascii`,
      `exit 0`,
    ].join('\n');
    const toolResult = await adapter.executeTool(agent, 'pwsh', { command: script, ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}) }, {
      callId: `twb-exec-${runId}-1`,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (!toolResult || toolResult.ok !== true) {
      return fail(
        toolResult?.code ?? 'NATIVE_EXECUTION_REJECTED',
        `原生 tools.execute 未放行（${toolResult?.code ?? 'UNKNOWN'}）：${toolResult?.message ?? 'policy/approval 拒绝'}。fail-closed：不降级执行。`,
        { nativeAuthorization: false, deniedCode: toolResult?.code ?? null },
      );
    }
    let exitCode = null;
    try {
      const text = await fsp.readFile(exitFile, 'utf8');
      const parsed = Number.parseInt(String(text).trim(), 10);
      exitCode = Number.isInteger(parsed) ? parsed : null;
    } catch (error) {
      return fail('NATIVE_EXIT_CODE_MISSING', `宿主临时文件里读不到 exitCode（${String(error?.message ?? error)}）：不接受 stdout 标记。`, { nativeAuthorization: true, runId });
    } finally {
      void fsp.rm(exitFile, { force: true }).catch(() => {});
    }
    const resolvedCwd = path.resolve(baseCwd, request.cwd ?? '.');
    const artifactPaths = (Array.isArray(request.artifacts) ? request.artifacts : [])
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => path.resolve(resolvedCwd, item.trim()));
    const artifactsAfter = [];
    for (const absolute of artifactPaths) {
      const digest = await digestFile(absolute);
      artifactsAfter.push({ path: path.relative(resolvedCwd, absolute).replace(/\\/g, '/'), absolute, sha256: digest.sha256 ?? null, bytes: digest.bytes ?? 0, exists: digest.exists === true });
    }
    const status = exitCode === 0 ? 'completed' : 'failed';
    const record = {
      runId,
      workId,
      attemptId: request.attemptId ?? null,
      teamKey: request.teamKey ?? null,
      ownerMemberId: request.ownerMemberId ?? null,
      scope,
      command,
      argv,
      // P1-1：执行时固化的计划身份（旧 run 没有这三项 → 不能给新计划验收背书）。
      planRevision: frozenPlanRevision,
      checkId: frozenCheckId,
      acceptanceIndexes: frozenAcceptanceIndexes,
      cwd: resolvedCwd,
      status,
      exitCode,
      signal: null,
      startedAt: clock.now(),
      endedAt: clock.now(),
      durationsMs: 0,
      timeoutMs: request.timeoutMs ?? null,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutSha256: null,
      stderrSha256: null,
      stdoutTail: '',
      stderrTail: '',
      truncated: false,
      artifactsBefore: [],
      artifactsAfter,
      observedOutputs: artifactsAfter.filter((artifact) => artifact.exists === true).map((artifact) => artifact.path),
      noModelCalls: true,
      nativeAuthorization: true,
      officialResult: toolResult.value === undefined ? null : { kind: 'native-tools-execute', isError: toolResult.value?.isError === true },
      recordedAt: clock.now(),
    };
    const stored = await storage.put(table, runId, record, { idempotencyKey: `run:${runId}` });
    const committed = stored.ok ? (stored.record ?? record) : record;
    runs.set(runId, committed);
    if (!stored.ok) return fail('RUN_NOT_PERSISTED', `run 记录写入失败（${stored.code}）：没有持久记录的执行不能作为证据。`, { run: committed });
    return {
      ok: true,
      runId,
      workId,
      status,
      exitCode,
      durationsMs: 0,
      artifactsAfter,
      scope,
      nativeAuthorization: true,
      noModelCalls: true,
      note: exitCode === 0
        ? `原生 tools.execute 已放行并执行（exitCode=0，宿主核验）：evidence 用 runId=${runId}。`
        : `原生执行 exitCode=${exitCode}（宿主核验）：失败执行不能作为验收证据。`,
    };
  }

  return { hydrate, run, runNative, listRuns, runFor, roots, table, size: () => runs.size };
}

export const EXECUTION_RUN_TABLE = RUN_TABLE;
