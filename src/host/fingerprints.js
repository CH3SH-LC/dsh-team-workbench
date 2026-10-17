/**
 * `fingerprints.js` — 错误指纹与"不重复执行"（契约 v1 §2 / 验收 §5.4）。
 *
 * ## 为什么需要
 *
 * 真实历史里同一确定性失败被反复执行：同一个 `ACTIVATION_LIMIT_REACHED` /
 * `SUBAGENT_START_FAILED` / 权限拒绝被当成"再试一次就好了"，白烧 attempt 预算，
 * 还把失败计数打穿（`REPEATED_IDENTICAL_FAILURE` 是事后才拦）。
 *
 * ## 指纹构成（契约要求：tool + 规范化输入 + 文件/依赖版本 + 错误分类 + 读取状态 epoch）
 *
 * ```
 * fingerprint = sha256({ tool, inputHash, versions, errorClass, readEpochHash })
 * ```
 *
 * - `inputHash`：规范化输入（排序键、去掉易变字段如时间戳/随机 id/请求 id）
 * - `versions`：涉及的产物/依赖版本（`path@version` / `dep@version`）
 * - `errorClass`：错误分类（见 `classifyError`）
 * - `readEpochHash`：本次判断所依据的"读取状态"指纹（文件 mtime/size/sha、或 state revision）
 *
 * ## 重试策略（**不是固定三次放弃**）
 *
 * | 分类 | 同指纹再遇到时 |
 * |---|---|
 * | `deterministic` | **不重复执行**，返回 `guidance` 说明"改什么条件才会重试"（改输入 / 改版本 / 换工具 / 显式 force） |
 * | `permission` | 不自动重试；必须原 owner 一次性定位（权限边界不允许绕过） |
 * | `capacity` | 不重复执行但**允许退避后重试**（不是错误，保持 ready） |
 * | `transient-network` | 允许重试，但记录次数与退避；超过阈值提示换路径 |
 * | `source-changed` | 允许重试（源已变，旧结论作废；同时触发证据过期） |
 * | `read-state-reset` | 允许重试（读取基准已重置，epoch 已变） |
 *
 * 指纹**不落进模型上下文**：只以聚合快照（`snapshot.errorFingerprints`）暴露给前端。
 */

import { sha256Hex, stableStringify } from './util.js';

export const ERROR_CLASSES = Object.freeze([
  'deterministic',
  'capacity',
  'permission',
  'transient-network',
  'source-changed',
  'read-state-reset',
  'unknown',
]);

/** 易变字段（不能进指纹，否则同一失败每次指纹都不同）。 */
const VOLATILE_FIELDS = Object.freeze([
  'at',
  'now',
  'timestamp',
  'requestId',
  'toolCallId',
  'idempotencyKey',
  'signal',
  'controller',
  'traceId',
  'nonce',
  'random',
  'attemptId',
  'childId',
  'executorChildId',
  'leaseEpoch',
  'rev',
  'updatedAt',
]);

const CAPACITY_CODES = new Set([
  'ACTIVATION_LIMIT_REACHED',
  'CAPACITY_FULL',
  'RESIDENT_CAPACITY_FULL',
  'WORKER_CAPACITY_FULL',
  'MEMBER_FAIR_SHARE_FULL',
  'PROVIDER_CAPACITY_FULL',
  'SUBAGENT_DELIVERY_UNAVAILABLE',
  'NATIVE_CAPACITY_COOLDOWN',
  'RESIDENT_CAPACITY_EXHAUSTED',
]);

const PERMISSION_CODES = new Set([
  'EPERM',
  'EACCES',
  'PERMISSION_DENIED',
  'MATERIALIZE_PERMISSION_DENIED',
  'DELEGATION_SCOPE',
  'TEAM_LEAD_REQUIRED',
  'TEAM_MEMBER_REQUIRED',
  'LEAF_IDENTITY_REQUIRED',
  'WORK_PAUSED_BY_USER',
  'WRITE_SCOPE_CONFLICT',
  'IDENTITY_SCOPE_OWNER_CONFLICT',
  'IDENTITY_OWNER_MISMATCH',
]);

const TRANSIENT_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'NETWORK_ERROR',
  'PROVIDER_TIMEOUT',
  'RATE_LIMITED',
  'HTTP_429',
  'HTTP_500',
  'HTTP_502',
  'HTTP_503',
  'HTTP_504',
]);

const SOURCE_CHANGED_CODES = new Set([
  'EVIDENCE_HASH_MISMATCH',
  'EVIDENCE_BYTES_MISMATCH',
  'SOURCE_VERSION_CHANGED',
  'IDEMPOTENCY_CONFLICT',
  'CAS_MISMATCH',
  'PLAN_CAS_MISMATCH',
  'PLAN_REVISION_STALE',
]);

const READ_STATE_CODES = new Set(['READ_EPOCH_RESET', 'COLD_RESUME', 'WRITER_TOOK_OVER', 'STORAGE_REOPENED']);

/** 错误分类：只按**错误码/错误名**归类（message 只做兜底关键词）。 */
export function classifyError(code, message = '') {
  const key = String(code ?? '').trim();
  if (CAPACITY_CODES.has(key)) return 'capacity';
  if (PERMISSION_CODES.has(key)) return 'permission';
  if (TRANSIENT_CODES.has(key)) return 'transient-network';
  if (SOURCE_CHANGED_CODES.has(key)) return 'source-changed';
  if (READ_STATE_CODES.has(key)) return 'read-state-reset';
  const text = String(message ?? '').toLowerCase();
  if (/(timeout|timed out|econnreset|econnrefused|socket hang up|network)/.test(text)) return 'transient-network';
  if (/(permission denied|eacces|eperm|not permitted|拒绝)/.test(text)) return 'permission';
  if (/(version mismatch|hash mismatch|已变更|stale)/.test(text)) return 'source-changed';
  // 参数/契约/状态类错误默认确定性：同一输入再跑一次结果一样。
  if (key) return 'deterministic';
  return 'unknown';
}

/** 规范化输入：深拷贝 + 删除易变字段 + 排序键；不改变语义，只消除"同输入不同指纹"。 */
export function normalizeInput(value, depth = 0) {
  if (depth > 8) return '[depth]';
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value; // 指纹覆盖完整语义输入：不截断（长命令前缀碰撞会误拦/漏拦）
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'function') return '[function]';
  if (Array.isArray(value)) return value.map((item) => normalizeInput(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE_FIELDS.includes(key)) continue;
      out[key] = normalizeInput(value[key], depth + 1);
    }
    return out;
  }
  return String(value);
}

/** 规范化版本表：`{ 'path': version|sha }` 或数组 → 排序后的 `path@version` 列表。 */
export function normalizeVersions(input) {
  const list = [];
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') list.push(item);
      else if (item && typeof item === 'object') {
        const path = item.path ?? item.artifact ?? item.workId;
        const version = item.version ?? item.sha256 ?? item.bytes ?? null;
        if (path) list.push(`${path}@${version ?? '?'}`);
      }
    }
  } else if (input && typeof input === 'object') {
    for (const key of Object.keys(input).sort()) list.push(`${key}@${input[key] ?? '?'}`);
  }
  return [...new Set(list)].map(String).sort();
}

/**
 * 计算指纹。`readEpoch` 可以是字符串（如 `rev:12` / `mtime:123`）或对象。
 * @returns {{ fingerprint:string, inputHash:string, versions:string[], errorClass:string, readEpochHash:string }}
 */
export function fingerprintOf({ tool, input, versions, code, message, readEpoch } = {}) {
  const errorClass = classifyError(code, message);
  const inputHash = sha256Hex(stableStringify(normalizeInput(input))).slice(0, 16);
  const versionList = normalizeVersions(versions);
  const readEpochHash = sha256Hex(stableStringify(normalizeReadEpoch(readEpoch ?? null))).slice(0, 12);
  const fingerprint = sha256Hex(
    stableStringify({
      tool: String(tool ?? 'unknown'),
      inputHash,
      versions: versionList,
      errorClass,
      readEpochHash,
    }),
  ).slice(0, 24);
  return { fingerprint, inputHash, versions: versionList, errorClass, readEpochHash };
}

/**
 * **唯一的环境指纹 builder**（Lead 第 10 回合要求 1）：
 * guard（执行前预检）与 record（失败入库生产者）必须用同一个 builder，否则键对不上、
 * 预检永远失效。字段固定为：tool + 规范化 input + 产物/依赖版本 + 读取 epoch。
 *
 * @param {{tool:string, input:unknown, versions?:unknown, readEpoch?:unknown,
 *          code?:string|null, message?:string|null, memberId?:string|null,
 *          workId?:string|null, attemptId?:string|null}} source
 */
/**
 * **文件 epoch**（Lead 第 N 回合）：把相关实际文件的可观察状态（sha256/bytes/mtimeMs）
 * 纳入指纹环境。ENOENT→文件被创建、内容被修好等真实变化都会产生新 epoch，
 * 从而允许重试；纯同输入同文件状态仍判同一条确定性失败。
 */
export function fileEpochOf(files = []) {
  const list = (Array.isArray(files) ? files : [])
    .filter(Boolean)
    .map((file) => ({
      path: String(file.path ?? ''),
      exists: file.exists === true,
      sha256: file.sha256 ?? null,
      bytes: Number.isFinite(file.bytes) ? file.bytes : null,
      mtimeMs: Number.isFinite(file.mtimeMs) ? Math.floor(file.mtimeMs) : null,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return sha256Hex(stableStringify(list)).slice(0, 16);
}

/**
 * **规范化读取 epoch**（P1-2 根因修复）。
 *
 * 缺陷：失败记录侧用 `{planRevision, rev}`、预检侧用 `{rev, planRevision, files:null}`，
 * 而 `normalizeInput` 会**删掉 `rev` 字段**，导致一侧变成 `{planRevision}`、
 * 另一侧变成 `{planRevision, files:null}` → 同一个确定性失败永远匹配不上（漏拦）。
 *
 * 现在两侧都走这一个固定形状（四个键永远存在，缺省 null），并且**保留 rev/readSeq**
 * （它们正是"读取状态是否变化"的判据）。`readSeq` 在真实成功 read 后递增：
 * 读取基准已重置 → 允许重试；未重新读取就原样重试 → 仍然拦住。
 */
export const READ_EPOCH_FIELDS = Object.freeze(['planRevision', 'rev', 'files', 'readSeq']);

export function normalizeReadEpoch(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || Array.isArray(value)) return normalizeInput(value);
  const out = {};
  for (const key of READ_EPOCH_FIELDS) {
    const raw = value[key];
    out[key] = raw === undefined ? null : raw;
  }
  // 保留调用方显式提供的额外事实字段（不丢弃，但排序稳定）。
  for (const key of Object.keys(value).sort()) if (!(key in out)) out[key] = value[key] ?? null;
  return out;
}

export function buildOperationDescriptor(source = {}) {
  const tool = String(source.tool ?? 'unknown');
  const descriptor = {
    tool,
    input: normalizeInput(source.input),
    versions: normalizeVersions(source.versions),
    readEpoch: normalizeReadEpoch(source.readEpoch ?? null),
  };
  return {
    ...descriptor,
    fingerprint: fingerprintOf({ ...descriptor, code: source.code ?? null, message: source.message ?? null }).fingerprint,
    code: typeof source.code === 'string' && source.code ? source.code : null,
    message: typeof source.message === 'string' ? source.message : null,
    memberId: source.memberId ?? null,
    workId: source.workId ?? null,
    attemptId: source.attemptId ?? null,
  };
}

/** 该分类是否**禁止**同指纹自动重复执行。 */
export function blocksAutomaticRetry(errorClass) {
  return errorClass === 'deterministic' || errorClass === 'permission' || errorClass === 'capacity';
}

/**
 * "改什么条件才会重试"——必须具体到可执行的条件，而不是"再试一次"。
 */
export function retryGuidance({ errorClass, code, tool, versions }) {
  const common = `同一输入（${tool ?? 'tool'}，代码 ${code ?? 'unknown'}）已经确定性失败过，原样重跑结果不变。`;
  switch (errorClass) {
    case 'permission':
      return `${common} 这是权限/归属边界，不可绕过：请由该模块 owner 一次性定位（检查 owner 归属、writeScopes、团队归属、是否被用户暂停），改由合法入口或换到自己的写范围后再试。`;
    case 'capacity':
      return `${common} 这是容量拒绝（不是失败）：保持 ready，等释放名额后由补位自动重试；不要手动连打，也不要扩大预算。`;
    case 'deterministic':
      return `${common} 重试前至少要改一个条件：① 修改输入（参数/标题/交付物定义）；② 改产物或依赖版本（version/sha256）；③ 换等价的合法工具或接口；④ 由 owner 显式 force 并说明理由。`;
    case 'transient-network':
      return `${common} 属于网络瞬态：允许退避重试；连续多次仍失败时请换数据入口或联系服务方，不要无预算重试。`;
    case 'source-changed':
      return `${common} 源已变化（版本/hash/CAS 不符）：允许重试，但必须重新读取源并让旧证据过期。`;
    case 'read-state-reset':
      return `${common} 读取基准已重置（epoch 变化）：允许重试，但必须以新的读取状态重新取证。`;
    default:
      return `${common} 请先记录并定位具体失败点，再决定改变哪个条件后重试。`;
  }
}

/**
 * 错误指纹存储（sidecar `error_fingerprints` 表；只以聚合快照暴露给前端）。
 *
 * @param {{storage:object, clock:{now:()=>number}, limit?:number, table?:string}} deps
 */
export function createErrorFingerprints({ storage, clock, limit = 500, table = 'error_fingerprints' }) {
  const cache = new Map();

  function hydrate() {
    cache.clear();
    for (const [key, value] of storage.list(table)) cache.set(key, value);
    return cache.size;
  }

  function groupKey(fingerprint) {
    return fingerprint;
  }

  async function recordFailure(descriptor = {}) {
    const at = clock.now();
    const normalizedEpoch = normalizeReadEpoch(descriptor.readEpoch ?? null);
    const normalized = { ...descriptor, readEpoch: normalizedEpoch };
    const computed = fingerprintOf(normalized);
    const key = groupKey(computed.fingerprint);
    const existing = cache.get(key);
    const next = existing
      ? {
        ...existing,
        count: (existing.count ?? 0) + 1,
        lastAt: at,
        code: descriptor.code ?? existing.code,
        memberId: descriptor.memberId ?? existing.memberId ?? null,
        workIds: [...new Set([...(existing.workIds ?? []), ...(descriptor.workId ? [descriptor.workId] : [])])].slice(-20),
        attemptIds: [...new Set([...(existing.attemptIds ?? []), ...(descriptor.attemptId ? [descriptor.attemptId] : [])])].slice(-20),
        errorClass: computed.errorClass,
        versions: computed.versions,
        teamKey: descriptor.teamKey ?? existing?.teamKey ?? null,
        // 环境固定形状（P1-2）：同一失败不因字段缺省/None 差异而失忆；读取基准变化才释放。
        readEpoch: normalizedEpoch ?? existing?.readEpoch ?? null,
        guidance: retryGuidance({ errorClass: computed.errorClass, code: descriptor.code, tool: descriptor.tool, versions: computed.versions }),
      }
      : {
        fingerprint: computed.fingerprint,
        code: String(descriptor.code ?? 'UNKNOWN'),
        errorClass: computed.errorClass,
        tool: String(descriptor.tool ?? 'unknown'),
        count: 1,
        firstAt: at,
        lastAt: at,
        memberId: descriptor.memberId ?? null,
        workIds: descriptor.workId ? [descriptor.workId] : [],
        attemptIds: descriptor.attemptId ? [descriptor.attemptId] : [],
        inputHash: computed.inputHash,
        versions: computed.versions,
        teamKey: descriptor.teamKey ?? existing?.teamKey ?? null,
        readEpoch: normalizedEpoch,
        readEpochHash: computed.readEpochHash,
        message: String(descriptor.message ?? '').slice(0, 500),
        guidance: retryGuidance({ errorClass: computed.errorClass, code: descriptor.code, tool: descriptor.tool, versions: computed.versions }),
      };
    cache.set(key, next);
    const stored = await storage.put(table, key, next, { idempotencyKey: `fingerprint:${key}:${next.count}` });
    if (stored.ok && stored.record) cache.set(key, stored.record);
    // 有界：超限时淘汰最久未见的组（只淘汰缓存，不删历史——历史用于对账）。
    if (cache.size > limit) {
      const oldest = [...cache.values()].sort((left, right) => (left.lastAt ?? 0) - (right.lastAt ?? 0))[0];
      if (oldest) cache.delete(oldest.fingerprint);
    }
    return { ...next, isRepeat: Boolean(existing), blocked: blocksAutomaticRetry(computed.errorClass) };
  }

  /** 同输入同版本同 epoch 是否应跳过执行。 */
  function shouldSkip(descriptor = {}) {
    const computed = fingerprintOf(descriptor);
    const existing = cache.get(groupKey(computed.fingerprint));
    if (!existing) return { skip: false, fingerprint: computed.fingerprint, errorClass: computed.errorClass, guidance: null, count: 0 };
    const blocked = blocksAutomaticRetry(computed.errorClass);
    return {
      skip: blocked && descriptor.force !== true,
      fingerprint: computed.fingerprint,
      errorClass: computed.errorClass,
      count: existing.count ?? 1,
      guidance: blocked
        ? retryGuidance({ errorClass: computed.errorClass, code: existing.code, tool: existing.tool, versions: computed.versions })
        : retryGuidance({ errorClass: computed.errorClass, code: existing.code, tool: existing.tool, versions: computed.versions }),
    };
  }

  /**
   * **按"操作 + 规范化输入 + 版本"查历史确定性失败**（不看错误码）。
   *
   * 为什么需要：调用方在执行前**还不知道会失败成什么码**，用 `code:null` 去算指纹永远
   * 对不上（缺陷 4）。正确做法是用操作身份（tool+inputHash+versions）去扫已记录的组，
   * 命中确定性失败就拒绝；瞬态/源变更/读状态重置类不拦。
   *
   * @param {{tool:string, input:unknown, versions?:unknown, readEpoch?:unknown}} descriptor
   */
  function findByOperation(descriptor = {}) {
    const tool = String(descriptor.tool ?? 'unknown');
    const inputHash = sha256Hex(stableStringify(normalizeInput(descriptor.input))).slice(0, 16);
    const versionList = normalizeVersions(descriptor.versions);
    // P1-2：两侧同一固定形状；缺省/None 的差异不再造成漏拦，读取基准（files/readSeq）变化才释放。
    const queryEpoch = descriptor.readEpoch === undefined || descriptor.readEpoch === null
      ? null
      : normalizeReadEpoch(descriptor.readEpoch);
    const matches = [...cache.values()]
      .filter((group) => String(group.tool) === tool)
      .filter((group) => String(group.inputHash ?? '') === inputHash)
      .filter((group) => stableStringify(group.versions ?? []) === stableStringify(versionList))
      .filter((group) => {
        if (queryEpoch === null) return true;
        return stableStringify(group.readEpoch ?? null) === stableStringify(queryEpoch);
      })
      .filter((group) => blocksAutomaticRetry(group.errorClass))
      .sort((left, right) => (right.lastAt ?? 0) - (left.lastAt ?? 0));
    if (matches.length === 0) {
      return { skip: false, fingerprint: null, code: null, errorClass: null, count: 0, guidance: null };
    }
    const group = matches[0];
    const force = descriptor.force === true ? decideForce(group, descriptor.forceReason) : { allowed: false, reason: 'not-requested' };
    return {
      // **force:true 不是无条件绕过**：必须带理由、同一条件最多两次，且会被记录。
      skip: force.allowed !== true,
      forced: force.allowed === true,
      forceDenial: force.allowed === true ? null : force.reason,
      fingerprint: group.fingerprint,
      code: group.code,
      errorClass: group.errorClass,
      count: group.count ?? 1,
      guidance: retryGuidance({ errorClass: group.errorClass, code: group.code, tool: group.tool, versions: group.versions ?? [] }),
      group,
    };
  }

  /** 受控 force 策略：理由必须具体、每指纹最多 2 次、每次记录。 */
  function decideForce(group, reason) {
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (text.length < 8) {
      return { allowed: false, reason: '显式 force 必须带 forceReason（≥8 字符，说明改了什么条件/为什么这次会不同）；无条件 force 不被接受。' };
    }
    const log = Array.isArray(group?.forceLog) ? group.forceLog : [];
    if (log.length >= 2) {
      return { allowed: false, reason: `同一确定性失败已被 force ${log.length} 次（上限 2）：请真正改变输入/版本/工具，而不是继续 force。` };
    }
    const lastAt = Number(log[log.length - 1]?.at ?? 0);
    if (lastAt > 0 && clock.now() - lastAt < 1000) {
      return { allowed: false, reason: 'force 之间至少间隔 1s：连续 force 等同于重试刷屏。' };
    }
    return { allowed: true, reason: null, record: { at: clock.now(), reason: text } };
  }

  /** 记录一次受控 force（持久化到指纹组，便于审计）。 */
  async function recordForce(fingerprint, reason) {
    const key = groupKey(fingerprint);
    const group = cache.get(key);
    if (!group) return { ok: false, code: 'FINGERPRINT_NOT_FOUND' };
    const log = [...(Array.isArray(group.forceLog) ? group.forceLog : []), { at: clock.now(), reason: String(reason ?? '').slice(0, 300) }].slice(-10);
    const next = { ...group, forceLog: log, forceCount: log.length };
    cache.set(key, next);
    const stored = await storage.put(table, key, next, { idempotencyKey: `fingerprint-force:${key}:${log.length}` });
    if (stored.ok && stored.record) cache.set(key, stored.record);
    return { ok: true, forceCount: log.length };
  }

  /** 聚合快照（`snapshot.errorFingerprints`，契约冻结形状）。 */
  function snapshot({ teamKey = null, limit: pageSize = 50, resolveTeamKey = null } = {}) {
    const groups = [...cache.values()]
      .filter((group) => {
        if (!teamKey) return true;
        if (group.teamKey === teamKey) return true;
        if (!group.teamKey && typeof resolveTeamKey === "function") return (group.workIds ?? []).some((id) => resolveTeamKey(String(id)) === teamKey);
        return false;
      })
      .sort((left, right) => (right.lastAt ?? 0) - (left.lastAt ?? 0))
      .slice(0, pageSize)
      .map((group) => ({
        fingerprint: group.fingerprint,
        code: group.code,
        count: group.count ?? 1,
        firstAt: group.firstAt ?? 0,
        lastAt: group.lastAt ?? 0,
        memberId: group.memberId ?? null,
        workIds: Array.isArray(group.workIds) ? group.workIds : [],
        guidance: group.guidance ?? retryGuidance({ errorClass: group.errorClass, code: group.code, tool: group.tool }),
        errorClass: group.errorClass ?? 'unknown',
      }));
    return {
      generatedAt: clock.now(),
      total: cache.size,
      groups,
      note: '同输入+同版本+同读取 epoch 的确定性失败不会被重复执行；要重试必须改变输入/版本/工具，或由 owner 显式 force 并说明理由。',
    };
  }

  function clear(fingerprint) {
    if (fingerprint) cache.delete(fingerprint);
    else cache.clear();
  }

  return { hydrate, recordFailure, shouldSkip, findByOperation, recordForce, decideForce, snapshot, clear, size: () => cache.size, table };
}

export const FINGERPRINT_TABLE = 'error_fingerprints';
/** 分类失败时的兜底文案（contextControl 引用）。 */
export const CLASSIFY_ERROR_FALLBACK = '请先记录并定位具体失败点，再决定改变哪个条件后重试；无预算重试同一失败只会消耗预算。';
