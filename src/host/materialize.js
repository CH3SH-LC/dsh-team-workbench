/**
 * `materialize.js` — 机械复制/物化/哈希（契约 v1 §2 / 验收 §5.3：**零 LLM 转抄**）。
 *
 * ## 真实缺陷
 *
 * 17 转抄子会话的做法是：让模型把已生成文件的内容**读进上下文再写出去**。后果：
 * 逐 token 计费、可能截断/改写内容、hash 对不上、原始材料被复制成"新证据"。
 *
 * ## 现在的路径（真实可调用）
 *
 * Host 工具 `team_materialize` → `service.materialize()` → 本模块：
 *
 * ```
 * op='copy'   { from, to, overwrite?, expectSha256?, scopes? }
 *   → 程序化 copyFile + 计算 sha256 + 字节数；目标已存在且内容相同 → noop（幂等）
 * op='hash'   { from }
 *   → { sha256, bytes, mtimeMs }
 * op='verify' { from, expectSha256 }
 *   → { match:boolean }
 * ```
 *
 * **不经过模型、不读入上下文、不做分段转抄**；返回值里明确 `noModelCalls:true`。
 *
 * ## 边界与权限
 *
 * - 路径必须落在配置的允许根（`roots`）内；解析后校验 `..` 逃逸与 symlink 逃逸。
 * - 若传了 `scopes`（来自 work.writeScopes/产物范围），目标必须被其中一个覆盖。
 * - `overwrite` 默认 **false**：不静默覆盖别人的产物。
 * - 权限失败（EPERM/EACCES）→ `MATERIALIZE_PERMISSION_DENIED`，带**确切路径 + 原 owner**
 *   定位建议；**不重试、不换路径绕过、不让模型转抄**。
 */

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export const MATERIALIZE_OPS = Object.freeze(['copy', 'hash', 'verify']);

const PERMISSION_CODES = new Set(['EPERM', 'EACCES', 'EROFS']);

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

/** 把任意输入路径解析成绝对路径（相对路径按 `cwd` 解析）。 */
export function resolveTarget(candidate, cwd) {
  if (typeof candidate !== 'string' || !candidate.trim()) return fail('MATERIALIZE_PATH_REQUIRED', '必须给出真实文件路径。');
  const raw = candidate.trim().replace(/\\/g, '/');
  if (raw.includes('\0')) return fail('MATERIALIZE_PATH_INVALID', '路径包含空字符。');
  return { ok: true, absolute: path.resolve(cwd ?? process.cwd(), raw), raw };
}

/** 绝对路径是否落在某个允许根内（按路径段判断，避免 `/root2` 命中 `/root`）。 */
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

/** 目标是否被声明的写范围覆盖（范围是相对路径；绝对/相对都接受）。 */
export function withinScopes(absolute, scopes, cwd) {
  const list = (Array.isArray(scopes) ? scopes : []).map((scope) => String(scope).trim()).filter(Boolean);
  if (list.length === 0) return true; // 未声明范围时只受 roots 约束
  const normalizedTarget = path.resolve(String(absolute)).replace(/\\/g, '/');
  for (const scope of list) {
    const normalizedScope = path.resolve(cwd ?? process.cwd(), scope.replace(/\\/g, '/')).replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalizedTarget === normalizedScope) return true;
    if (normalizedTarget.startsWith(`${normalizedScope}/`)) return true;
  }
  return false;
}

/** 流式 sha256（大文件不进内存）。 */
export async function sha256OfFile(absolute) {
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
  return hash.digest('hex').toUpperCase();
}

async function statOf(absolute) {
  try {
    const info = await fsp.stat(absolute);
    if (!info.isFile()) return { ok: false, code: 'MATERIALIZE_NOT_A_FILE', message: `${absolute} 不是普通文件。` };
    return { ok: true, bytes: info.size, mtimeMs: info.mtimeMs };
  } catch (error) {
    const code = String(error?.code ?? '');
    if (PERMISSION_CODES.has(code)) {
      return {
        ok: false,
        code: 'MATERIALIZE_PERMISSION_DENIED',
        message: `无权限读取 ${absolute}（${code}）：权限边界不可绕过。`,
        hint: '这是文件权限/边界问题，不由模型分段转抄绕过：请由该产物的原 owner 一次性定位（检查 ACL/占用/写范围），或改用有权限的合法路径。',
        path: absolute,
        systemCode: code,
      };
    }
    if (code === 'ENOENT') return { ok: false, code: 'MATERIALIZE_SOURCE_MISSING', message: `源文件不存在：${absolute}`, path: absolute };
    return { ok: false, code: 'MATERIALIZE_STAT_FAILED', message: `${absolute}: ${String(error?.message ?? error)}`, path: absolute };
  }
}

/**
 * 创建物化器。
 *
 * @param {{roots:string[], cwd?:string, maxBytes?:number, fs?:object}} options
 */
export function createMaterializer(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const roots = (Array.isArray(options.roots) && options.roots.length > 0 ? options.roots : [cwd]).map((root) => path.resolve(String(root)));
  const maxBytes = Number.isFinite(options.maxBytes) ? Number(options.maxBytes) : 256 * 1024 * 1024;

  function guard(candidate) {
    const resolved = resolveTarget(candidate, cwd);
    if (!resolved.ok) return resolved;
    const root = withinRoot(resolved.absolute, roots);
    if (!root) {
      return fail(
        'MATERIALIZE_OUTSIDE_ROOTS',
        `路径不在允许根内：${resolved.absolute}`,
        { allowedRoots: roots, hint: '机械复制只允许在工作区/配置根内进行；越界路径请改到自己的写范围，或由原 owner 处理。' },
      );
    }
    return { ok: true, absolute: resolved.absolute, root };
  }

  /** op='hash' */
  async function hash({ from }) {
    const guarded = guard(from);
    if (!guarded.ok) return guarded;
    const stat = await statOf(guarded.absolute);
    if (!stat.ok) return stat;
    if (stat.bytes > maxBytes) return fail('MATERIALIZE_TOO_LARGE', `${guarded.absolute} ${stat.bytes} 字节超过上限 ${maxBytes}：拒绝整文件读入（机械操作也应流式/分块，但这里先拒绝）。`);
    try {
      const sha256 = await sha256OfFile(guarded.absolute);
      return { ok: true, op: 'hash', path: guarded.absolute, sha256, bytes: stat.bytes, mtimeMs: stat.mtimeMs, noModelCalls: true };
    } catch (error) {
      return fail('MATERIALIZE_HASH_FAILED', String(error?.message ?? error), { path: guarded.absolute, noModelCalls: true });
    }
  }

  /** op='verify' */
  async function verify({ from, expectSha256 }) {
    const expected = typeof expectSha256 === 'string' ? expectSha256.trim().toUpperCase() : '';
    if (!expected) return fail('MATERIALIZE_EXPECT_REQUIRED', 'op=verify 必须给出 expectSha256。');
    const hashed = await hash({ from });
    if (!hashed.ok) return hashed;
    return { ok: true, op: 'verify', path: hashed.path, sha256: hashed.sha256, bytes: hashed.bytes, expectSha256: expected, match: hashed.sha256 === expected, noModelCalls: true };
  }

  /** op='copy'：确定性复制（幂等；不覆盖除非显式 overwrite）。 */
  async function copy({ from, to, overwrite = false, expectSha256, scopes }) {
    const source = guard(from);
    if (!source.ok) return source;
    const target = guard(to);
    if (!target.ok) return target;
    if (!withinScopes(target.absolute, scopes, cwd)) {
      return fail('MATERIALIZE_SCOPE_DENIED', `目标不在声明的写范围内：${target.absolute}`, {
        scopes: scopes ?? [],
        hint: '复制目标必须落在该 work 的 writeScopes/产物范围内；跨范围请先与原 owner 约定并升版写范围，不要绕过。',
        noModelCalls: true,
      });
    }
    const sourceStat = await statOf(source.absolute);
    if (!sourceStat.ok) return sourceStat;
    if (sourceStat.bytes > maxBytes) return fail('MATERIALIZE_TOO_LARGE', `源文件 ${sourceStat.bytes} 字节超过上限 ${maxBytes}。`, { noModelCalls: true });
    let sourceSha;
    try {
      sourceSha = await sha256OfFile(source.absolute);
    } catch (error) {
      return fail('MATERIALIZE_HASH_FAILED', String(error?.message ?? error), { path: source.absolute, noModelCalls: true });
    }
    if (typeof expectSha256 === 'string' && expectSha256.trim() && sourceSha !== expectSha256.trim().toUpperCase()) {
      return fail('MATERIALIZE_SOURCE_HASH_MISMATCH', `源文件 sha256 与声明不符：${source.absolute}`, { sha256: sourceSha, expectSha256: expectSha256.trim().toUpperCase(), noModelCalls: true });
    }

    const existing = await statOf(target.absolute).catch(() => ({ ok: false, code: 'ENOENT' }));
    if (existing.ok) {
      const existingSha = await sha256OfFile(target.absolute).catch(() => null);
      if (existingSha === sourceSha) {
        return { ok: true, op: 'copy', noop: true, from: source.absolute, to: target.absolute, sha256: sourceSha, bytes: sourceStat.bytes, noModelCalls: true, note: '目标已存在且内容相同：幂等 no-op，没有重复写入。' };
      }
      if (overwrite !== true) {
        return fail('MATERIALIZE_TARGET_EXISTS', `目标已存在且内容不同：${target.absolute}`, {
          existingSha256: existingSha,
          sourceSha256: sourceSha,
          hint: '默认不覆盖别人的产物。确需覆盖时显式 overwrite:true，并在回执里记录旧 sha256（可追溯）。',
          noModelCalls: true,
        });
      }
    }

    try {
      await fsp.mkdir(path.dirname(target.absolute), { recursive: true });
      await fsp.copyFile(source.absolute, target.absolute);
    } catch (error) {
      const code = String(error?.code ?? '');
      if (PERMISSION_CODES.has(code)) {
        return fail('MATERIALIZE_PERMISSION_DENIED', `无权限写入 ${target.absolute}（${code}）：权限边界不可绕过。`, {
          path: target.absolute,
          systemCode: code,
          hint: '写权限失败请由该目标范围的原 owner 一次性定位（ACL/占用/写范围），不要换路径绕过，也不要让模型分段转抄。',
          noModelCalls: true,
        });
      }
      return fail('MATERIALIZE_COPY_FAILED', `${target.absolute}: ${String(error?.message ?? error)}`, { systemCode: code, noModelCalls: true });
    }

    const copiedSha = await sha256OfFile(target.absolute).catch(() => null);
    const copiedStat = await statOf(target.absolute);
    if (!copiedStat.ok) return copiedStat;
    if (copiedSha !== sourceSha) {
      return fail('MATERIALIZE_COPY_VERIFY_FAILED', `复制后 sha256 与源不一致：${target.absolute}`, { sourceSha256: sourceSha, copiedSha256: copiedSha, noModelCalls: true });
    }
    return {
      ok: true,
      op: 'copy',
      noop: false,
      from: source.absolute,
      to: target.absolute,
      sha256: copiedSha,
      bytes: copiedStat.bytes,
      overwritten: existing.ok === true,
      noModelCalls: true,
      note: '机械复制：程序化 copyFile + sha256 校验，未经过模型转抄。',
    };
  }

  async function run(op, args = {}) {
    switch (op) {
      case 'copy':
        return copy(args);
      case 'hash':
        return hash(args);
      case 'verify':
        return verify(args);
      default:
        return fail('MATERIALIZE_OP_UNKNOWN', `未知物化操作 "${op}"；只接受 ${MATERIALIZE_OPS.join(' / ')}。`, { ops: MATERIALIZE_OPS });
    }
  }

  return { run, copy, hash, verify, roots, cwd, maxBytes, guard };
}

export const MATERIALIZE_NO_MODEL_NOTE = '物化/复制/哈希全部由 Host 程序化完成（copyFile + sha256），不经过模型转抄，也不把文件内容读进上下文。';
