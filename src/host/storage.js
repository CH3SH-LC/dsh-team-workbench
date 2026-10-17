/**
 * `storage.js` — 插件 sidecar。
 *
 * 原生 Session/Team journal 仍然是会话、成员、任务主体与 revision 的权威来源；
 * 这里只存扩展事实：attempt、executor、lease、资源预算、产物证据、布局、幂等回执。
 *
 * 已核实的 storageDomain 事实（`docs/contracts/host-api.md` §storageDomain）：
 *  - `KvTable` = get / entries / keys / size / put / delete / update；`DomainGlobal` = get / set。
 *  - **没有 CAS、没有跨表事务、没有自动 schema 迁移**（version 不符则 open 直接 `version-mismatch`）。
 *  - 一次写入只有在后端确认持久化之后才 resolve，随后才改内存并 emit `domain/changed`。
 *  - 域/表名必须匹配 `/^[a-z][a-z0-9_]*$/`（所以用 `team_workbench`，不能用连字符）。
 *
 * 因此本模块自己提供：
 *  - **单 Host 写者**：writer 心跳记录 + 过期接管。
 *  - **CAS**：每条记录自带 `rev`，`put(..., { expectRev })` 不匹配则 `CAS_MISMATCH`。
 *  - **幂等键**：`put(..., { idempotencyKey })` 重复写返回首次结果。
 *  - **显式迁移表**：`MIGRATIONS`，缺失迁移路径时保留原数据并记诊断，绝不静默丢弃。
 */
import { createDiagnostics, createMutex, safeClone } from './util.js';
import { createFallbackDomain, resolveDataDir } from './storage-fallback.js';

export const DOMAIN_NAME = 'team_workbench';
export const DOMAIN_VERSION = 1;
export const SCHEMA_VERSION = 1;

/**
 * 表名必须匹配后端强制的 `/^[a-z][a-z0-9_]*$/`（`dsh-storage-json` 会用
 * `malformed-medium: invalid table name` 拒绝整个 domain 打开）。
 * 之前 `lateResults` 因为这个规则让 storageDomain 打不开——这里显式断言，
 * 未来再加表时立刻在本地失败而不是上线后静默降级。
 */
export const TABLES = Object.freeze([
  'meta',
  'layout',
  'teams',
  'members',
  'works',
  'attempts',
  'idempotency',
  'writer',
  'late_results',
  // 成员自治核心（契约 §4：走受支持的 storageDomain sidecar，不追加未注册的 Session 事件类型）。
  // 表名必须匹配 `/^[a-z][a-z0-9_]*$/`（下划线可以，连字符不行）。
  'missions',
  'dispatch_intents',
  'member_events',
  'member_cursors',
  // 2026-10-17 整改（契约 v1）：费用归账 / 错误指纹 / 证据 / 稳定身份。
  // 全部是**新增** sidecar 表，旧表一行不动；表名仍匹配 `/^[a-z][a-z0-9_]*$/`。
  'usage_requests',
  'usage_cursors',
  'usage_totals',
  'error_fingerprints',
  'evidence_records',
  'identity_records',
  // 可信执行记录：证据式完成判定的唯一来源（Codex 审阅要求：命令必须由 Host 真实执行）。
  'execution_runs',
  // 费用跨批计费键游标（attempt seq / retry 序号必须跨分页、跨重启稳定）。
  'usage_step_cursors',
]);

/** 与 `dsh-storage` 的 `UNIT_NAME_RE` 完全一致。 */
export const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** 迟到结果表的名字（导出常量，避免调用方再写裸字符串）。 */
export const LATE_RESULTS_TABLE = 'late_results';

export function assertTableNames(tables = TABLES) {
  const invalid = tables.filter((name) => !UNIT_NAME_RE.test(name));
  if (invalid.length > 0) throw new Error(`storage table names must match ${UNIT_NAME_RE}: ${invalid.join(', ')}`);
  if (!UNIT_NAME_RE.test(DOMAIN_NAME)) throw new Error(`domain name '${DOMAIN_NAME}' must match ${UNIT_NAME_RE}`);
  return true;
}

/** 没有 zod 时使用的极小 schema 替身：storageDomain 只调用 `parse` / `safeParse`。 */
function anyRecordSchema(label) {
  return {
    __label: label,
    parse(value) {
      if (value === undefined) throw new Error(`${label}: undefined record`);
      return value;
    },
    safeParse(value) {
      return value === undefined
        ? { success: false, error: new Error(`${label}: undefined record`) }
        : { success: true, data: value };
    },
  };
}

/** global 必须是“不接受 null”的 schema（null 是介质的“从未写入”哨兵）。 */
function nonNullGlobalSchema(label) {
  return {
    __label: label,
    parse(value) {
      if (value === null || value === undefined) throw new Error(`${label}: null global`);
      return value;
    },
    safeParse(value) {
      return value === null || value === undefined
        ? { success: false, error: new Error(`${label}: null global`) }
        : { success: true, data: value };
    },
  };
}

/**
 * 域声明。
 *
 * 刻意**不声明 `global`**：`DomainFacility.open` 对 fresh 单元的 `snapshot.global`
 * 只在严格等于 `null` 时才回退到 `initial`，返回 `undefined` 会走 `schema.parse(undefined)`
 * 并让整个 open 以 `invalid-record` 失败。插件自己的全局状态（schemaVersion / revision /
 * writerEpoch）因此存在 `meta` 表的 `global` 键里，走同一条记录通道。
 *
 * `invalidRecords: 'backup-and-skip'`：单条坏记录被移走并跳过，而不是让整个域打不开。
 */
export function domainSpec() {
  assertTableNames();
  const tables = {};
  for (const name of TABLES) tables[name] = { valueSchema: anyRecordSchema(name) };
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    layout: 'per-record',
    invalidRecords: 'backup-and-skip',
    tables,
  };
}

/** 显式前向迁移。键是**存储版本**，值是迁移函数。缺失路径不会被静默跳过。 */
export const MIGRATIONS = Object.freeze({
  // 0: (state) => ({ ...state, schemaVersion: 1 }),
});

const WRITER_STALE_MS = 120_000;
const IDEMPOTENCY_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * 同机写者存活探测。
 *
 * 只靠心跳会在"上一个 Host 崩溃/被强杀"时把新的 Host 挡在只读态最多 `WRITER_STALE_MS`——
 * 实测中连续两次短命验证进程就会互相挡住。因此优先用 pid 存活判断：
 *   - pid 已不存在 → 记录判定为陈旧，可以安全接管（并清掉旧记录）；
 *   - pid 存活或 cwd 不可判定（EPERM/跨机）→ 回退到心跳窗口。
 * `process.kill(pid, 0)` 只做权限与存在性检查，不发送信号。
 */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'EPERM') return true;
    return false;
  }
}

/**
 * @param {object} ctx
 * @param {object} adapter `createAdapter(ctx)` 的返回
 * @param {{ clock?: { now: () => number }, diagnosticsLimit?: number, writerStaleMs?: number }} [options]
 */
export function createStorage(ctx, adapter, options = {}) {
  const clock = options.clock ?? { now: () => Date.now() };
  const writerStaleMs = Number.isFinite(options.writerStaleMs) ? options.writerStaleMs : WRITER_STALE_MS;
  const diagnostics = createDiagnostics(options.diagnosticsLimit ?? 200);
  const mutex = createMutex('storage');
  const memory = new Map(TABLES.map((name) => [name, new Map()]));

  const state = {
    durable: false,
    opened: false,
    backend: 'none',
    backendError: null,
    fallbackDir: null,
    /** true = 本世代自己 open 的 domain，关闭时由我们 close；false = 接管上一世代的 handle。 */
    openedByUs: false,
    /** true = 没拿到 storageDomain 而用了插件自有后端（降级，必须显式暴露）。 */
    degraded: false,
    writerEpoch: null,
    writerHeld: false,
    secondWriter: null,
    replicaId: `${process.pid ?? 0}-${Math.random().toString(36).slice(2, 10)}`,
    migrationRequired: false,
  };

  let domain = null;

  /**
   * 键在 **domain 边界**上编码成后端允许的字符集。
   *
   * 真因（2026-10-14 实测，来自后端自己的报错）：
   * `per-record key 'probe4%2Fprobe4' is not path-safe (must match /^[a-zA-Z0-9_-]+$/)`
   * —— `layout:'per-record'` 的 JSON 后端把键当**文件名**，只接受 `[A-Za-z0-9_-]`。
   * 而 `members` 表的键是 `${teamKey}/${name}`（含 `/`）→ **写入必然失败**。
   * 现场证据：一次真实 `team_member_create` 返回 `ok:true`（teammate 真的建出来了），
   * 但 `~/.dsh/storages/team_workbench/members/` **根本不存在**。成员只活在内存里，
   * 重启后消失，而 work 仍指向这些 `ownerMemberId` → 孤儿工作项 + 空团队树。
   *
   * 方案：**已经合法的键原样使用**（因此全部既有落盘键——`wb-real-verify` / `nav-core` /
   * `attempt-<hex>` / `current` / `global` / `<pid>-<rand>`——逐字节不变，向后兼容），
   * 只有含非法字符的键才编码。
   *
   * **编码方案：以 `_` 为转义符的前缀编码（单射 + 紧凑 + 自证）**
   *
   * 判据与算法：
   * - 键匹配 `^[A-Za-z0-9-]+$`（安全**且不含 `_`**）→ **原样使用**（既有落盘键
   *   `wb-real-verify` / `nav-core` / `attempt-<hex>` / `current` / `global` / `<pid>-<rand>` 全部命中，
   *   逐字节不变，向后兼容）；
   * - 其余一律编码为 `_` + 逐码元转义：`_` → `__`，其它非法字符 → `_` + 4 位十六进制。
   *   由于**编码结果必然以 `_` 开头**、而直通键**必然不含 `_`**，两集合不相交 ⇒
   *   `encodeKey` **单射**：不存在"某个键的编码形式恰好等于另一个键"的碰撞
   *   （旧方案有：`encodeKey(T)` 本身仍在直通字母表里，`encodeKey(encodeKey(T)) === encodeKey(T)`）。
   * - 解码：以 `_` 开头才解码，否则原样返回。空键编码为 `_`，解码回 `''`（旧方案会把空键改名）。
   *
   * **紧凑性是硬要求（D3）**：旧方案每码元 4 个十六进制字符，键长 ×4 且**无上限**；
   * 而 `idempotency` 表的真实键长达 49 字符（实测磁盘文件名 152–204 字符），
   * 且后端把键当**文件名路径段**（`<key>.json`，只校验字符集、不校验长度）——
   * 一旦超过 255 字符就会写失败。新方案下 `probe5/probe5` → `_probe5_002fprobe5`（17 字符，旧方案 68），
   * 49 字符的真实键 → ~56 字符，留出充分余量。
   * 另外仍加**长度硬闸**：编码后超过 `MAX_ENCODED_KEY_LEN` 直接以 `KEY_TOO_LONG` 失败（不静默、不让后端抛晦涩错误）。
   */
  const PASSTHROUGH_KEY_RE = /^[a-zA-Z0-9-]+$/;
  const KEY_MARKER = '_';
  const MAX_ENCODED_KEY_LEN = 200;

  function encodeKey(key) {
    const text = String(key);
    if (PASSTHROUGH_KEY_RE.test(text)) return text;
    let encoded = KEY_MARKER;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === 0x5f) encoded += '__'; // `_` 自身
      else if (
        (code >= 0x30 && code <= 0x39)
        || (code >= 0x41 && code <= 0x5a)
        || (code >= 0x61 && code <= 0x7a)
        || code === 0x2d
      ) {
        encoded += text[index];
      } else {
        encoded += `_${code.toString(16).padStart(4, '0')}`;
      }
    }
    return encoded;
  }

  function decodeKey(key) {
    const text = String(key);
    if (!text.startsWith(KEY_MARKER)) return text;
    let decoded = '';
    for (let index = 1; index < text.length; index += 1) {
      if (text[index] !== '_') {
        decoded += text[index];
        continue;
      }
      const next = text[index + 1];
      if (next === '_') {
        decoded += '_';
        index += 1;
        continue;
      }
      const hex = text.slice(index + 1, index + 5);
      if (hex.length !== 4 || !/^[0-9a-f]{4}$/.test(hex)) return text; // 形状不符 → 原样返回，绝不误解码历史键
      decoded += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
    }
    return decoded;
  }

  function table(name) {
    if (!TABLES.includes(name)) throw new Error(`unknown storage table ${name}`);
    return memory.get(name);
  }

  function tableSnapshot(name) {
    return [...table(name).entries()].map(([key, value]) => [key, safeClone(value)]);
  }

  /** 从 domain 读取所有表到内存镜像。 */
  function hydrate() {
    for (const name of TABLES) {
      const target = table(name);
      target.clear();
      let kv;
      try {
        kv = domain.table(name);
      } catch (error) {
        diagnostics.push('storage:table-missing', `domain table ${name} unavailable: ${String(error?.message ?? error)}`);
        continue;
      }
      for (const [key, value] of kv.entries()) target.set(decodeKey(key), value);
    }
  }

  async function persist(name, key) {
    if (!domain) return { ok: true, skipped: true };
    const encoded = encodeKey(key);
    // 后端把键当**文件名路径段**（`<key>.json`），只校验字符集、不校验长度 —— 超过 FS 上限会失败。
    // 新编码已把真实键压到 ~67 字符，这里再加一道硬闸，让"太长"变成**明确的失败**而不是晦涩的后端报错。
    if (encoded.length > MAX_ENCODED_KEY_LEN) {
      return { ok: false, code: 'KEY_TOO_LONG', message: `键编码后 ${encoded.length} 字符 > ${MAX_ENCODED_KEY_LEN}（原键 ${String(key).length} 字符）：后端会把它当文件名路径段，可能超出文件系统上限。` };
    }
    const value = table(name).get(key);
    try {
      const kv = domain.table(name);
      if (value === undefined) await kv.delete(encoded);
      else await kv.put(encoded, value);
      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'PERSIST_FAILED', message: String(error?.message ?? error) };
    }
  }

  async function open() {
    const spec = domainSpec();
    const result = await adapter.openDomain(spec);

    // `already-open` 不是"storageDomain 坏了"，而是**同一进程的上一个插件世代**还持着
    // 这个 domain（热重载顺序不保证旧世代先 dispose）。此时若退到插件自有的空 JSON 目录，
    // 会在两个后端之间形成 split-brain 并让界面显示 0 条团队/工作项——实测踩到过。
    // 正确做法是接管同一个 handle（`DomainFacility.get(name)` 是公开方法）。
    if (!result.ok && result.code === 'already-open') {
      const existing = adapter.getDomain(DOMAIN_NAME);
      if (existing) {
        domain = existing;
        state.durable = true;
        state.backend = 'storageDomain';
        state.backendError = null;
        state.openedByUs = false;
        state.degraded = false;
        hydrate();
        const adoptedGlobal = readGlobal();
        if (adoptedGlobal.schemaVersion !== SCHEMA_VERSION) await migrate(adoptedGlobal);
        pruneIdempotency();
        diagnostics.push('storage:adopted-open-domain', `domain ${DOMAIN_NAME} 已由上一世代打开：接管同一个 handle（不切 fallback、不丢内存状态）。`);
        return;
      }
      diagnostics.push('storage:already-open-without-handle', 'domain 报 already-open 但取不到 handle，只能降级。');
    }

    if (!result.ok) {
      // 首选 storageDomain 打不开：保住持久性，退到插件自有的原子 JSON 目录，
      // 并把原生错误原样留下（不隐藏缺口）。**降级必须显式**（state.degraded）。
      state.durable = false;
      state.degraded = true;
      state.backendError = { code: result.code ?? 'DOMAIN_OPEN_FAILED', message: result.message ?? '' };
      diagnostics.push('storage:domain-unavailable', `${state.backendError.code}: ${state.backendError.message}；改用插件自有 JSON 目录 fallback（仍然持久，但不再是 storageDomain）。`);
      const fallback = createFallbackDomain({
        tables: TABLES,
        logger: (code, message) => diagnostics.push(code, message),
      });
      try {
        const info = await fallback.init();
        domain = fallback;
        state.durable = true;
        state.backend = 'json-files';
        state.openedByUs = true;
        state.fallbackDir = info.rootDir;
        diagnostics.push('storage:fallback-active', `fallback durable backend at ${info.rootDir}`, { primaryError: state.backendError });
      } catch (error) {
        state.backend = 'memory-only';
        state.backendError = { code: 'FALLBACK_FAILED', message: String(error?.message ?? error) };
        diagnostics.push('storage:memory-only', `fallback 也失败，退到进程内存储（不持久）：${state.backendError.message}`);
        domain = null;
        state.openedByUs = false;
        state.durable = false;
      }
      hydrate();
      const globalFallback = readGlobal();
      if (globalFallback.schemaVersion !== SCHEMA_VERSION) await migrate(globalFallback);
      pruneIdempotency();
      return;
    }
    domain = result.value;
    state.durable = true;
    state.backend = 'storageDomain';
    state.backendError = null;
    state.openedByUs = true;
    state.degraded = false;
    hydrate();
    const global = readGlobal();
    if (global.schemaVersion !== SCHEMA_VERSION) {
      await migrate(global);
    }
    pruneIdempotency();
    diagnostics.push('storage:opened', `domain ${DOMAIN_NAME} v${DOMAIN_VERSION} opened (durable=${state.durable})`, {
      tables: Object.fromEntries(TABLES.map((name) => [name, table(name).size])),
    });
  }

  function readGlobal() {
    const stored = table('meta').get('global');
    if (stored && typeof stored === 'object') return stored;
    return { schemaVersion: SCHEMA_VERSION, revision: 0, writerEpoch: null, updatedAt: 0 };
  }

  async function writeGlobal(next) {
    const target = table('meta');
    target.set('global', next);
    if (domain) {
      try {
        await domain.table('meta').put('global', next);
        return { ok: true };
      } catch (error) {
        return { ok: false, code: 'PERSIST_FAILED', message: String(error?.message ?? error) };
      }
    }
    return { ok: true, skipped: true };
  }

  async function migrate(global) {
    const from = Number.isInteger(global?.schemaVersion) ? global.schemaVersion : 0;
    const migration = MIGRATIONS[from];
    if (typeof migration !== 'function') {
      state.migrationRequired = true;
      diagnostics.push(
        'storage:migration-missing',
        `存储 schemaVersion=${from} 与当前 ${SCHEMA_VERSION} 不符，且没有显式迁移路径。保留原数据，不做静默丢弃。`,
        { from, to: SCHEMA_VERSION },
      );
      return;
    }
    await mutex.run(async () => {
      const next = migration({ tables: Object.fromEntries(TABLES.map((name) => [name, tableSnapshot(name)])), global: safeClone(global) });
      for (const name of TABLES) {
        const rows = next?.tables?.[name] ?? [];
        const target = table(name);
        target.clear();
        for (const [key, value] of rows) target.set(String(key), value);
        for (const [key] of rows) await persist(name, String(key));
      }
      await writeGlobal({ ...global, schemaVersion: SCHEMA_VERSION, updatedAt: clock.now() });
    });
    diagnostics.push('storage:migrated', `migrated storage schema ${from} → ${SCHEMA_VERSION}`);
  }

  function pruneIdempotency() {
    const cutoff = clock.now() - IDEMPOTENCY_TTL_MS;
    const target = table('idempotency');
    let removed = 0;
    for (const [key, value] of [...target.entries()]) {
      if (!value || typeof value.at !== 'number' || value.at < cutoff) {
        target.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) diagnostics.push('storage:idempotency-pruned', `pruned ${removed} idempotency records`);
  }

  // ---------------------------------------------------------------------------
  // 单 Host 写者
  // ---------------------------------------------------------------------------
  async function claimWriter() {
    const epoch = state.writerEpoch ?? `${clock.now().toString(36)}-${state.replicaId}`;
    state.writerEpoch = epoch;
    const now = clock.now();
    const writers = table('writer');
    const conflicts = [];
    const stale = [];
    for (const [key, record] of writers.entries()) {
      if (key === epoch || !record) continue;
      const alive = processAlive(record.pid);
      const fresh = Number.isFinite(record.heartbeatAt) && now - record.heartbeatAt < writerStaleMs;
      // 同一个进程里的**上一个插件世代**不是"第二个写者"：热重载后必须能直接接管，
      // 否则本插件会在自己进程里被判成 SECOND_WRITER 而进入只读态。
      // 判据是裸 pid：操作系统不会把同一个 pid 给两个进程，所以 `pid === process.pid`
      // 只可能是本进程的历史世代（同进程内的 harness 也按同一语义构造用例）。
      if (record.pid !== null && record.pid === process.pid) {
        stale.push({ epoch: key, pid: record.pid, reason: 'SAME_PROCESS_PREVIOUS_GENERATION' });
        continue;
      }
      if (alive === false) {
        stale.push({ epoch: key, pid: record.pid ?? null, reason: 'OWNER_PROCESS_GONE' });
        continue;
      }
      if (alive === true || fresh) conflicts.push({ epoch: key, pid: record.pid ?? null, heartbeatAt: record.heartbeatAt ?? null });
    }
    if (conflicts.length > 0 && options.singleWriter !== false) {
      state.writerHeld = false;
      state.secondWriter = conflicts;
      diagnostics.push('storage:second-writer', '另一个 Host 写者仍持有数据目录；本进程进入只读诊断态，不抢写。', { conflicts, stale });
      return { ok: false, code: 'SECOND_WRITER', message: '另一个 Host 写者仍持有该数据目录', conflicts, stale };
    }
    // 接管：清掉确认已死的写者记录，避免它们继续阻塞后续进程。
    for (const record of stale) {
      writers.delete(record.epoch);
      await persist('writer', record.epoch);
    }
    if (stale.length > 0) diagnostics.push('storage:writer-takeover', `接管 ${stale.length} 条已死写者记录`, stale);
    writers.set(epoch, { epoch, replicaId: state.replicaId, pid: process.pid ?? null, claimedAt: now, heartbeatAt: now });
    await persist('writer', epoch);
    await writeGlobal({ ...readGlobal(), writerEpoch: epoch, updatedAt: now });
    state.writerHeld = true;
    state.secondWriter = null;
    diagnostics.push('storage:writer-claimed', `writer epoch ${epoch}`, { pid: process.pid ?? null, tookOver: stale.length });
    return { ok: true, value: { epoch, tookOver: stale } };
  }

  async function heartbeat() {
    if (!state.writerEpoch) return { ok: false, code: 'NO_WRITER' };
    const now = clock.now();
    const writers = table('writer');
    const record = writers.get(state.writerEpoch);
    if (!record) return { ok: false, code: 'NO_WRITER' };
    writers.set(state.writerEpoch, { ...record, heartbeatAt: now });
    await persist('writer', state.writerEpoch);
    return { ok: true };
  }

  async function releaseWriter() {
    if (!state.writerEpoch) return { ok: true };
    table('writer').delete(state.writerEpoch);
    await persist('writer', state.writerEpoch);
    state.writerHeld = false;
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // 记录读写
  // ---------------------------------------------------------------------------
  function fingerprint(value) {
    return JSON.stringify(safeClone(value));
  }

  /**
   * @param {string} name table
   * @param {string} key
   * @param {object} value record body
   * @param {{ expectRev?: number, idempotencyKey?: string, touchGlobalRevision?: boolean }} [opts]
   */
  function put(name, key, value, opts = {}) {
    return mutex.run(async () => {
      if (state.secondWriter && options.singleWriter !== false) {
        return { ok: false, code: 'SECOND_WRITER', current: safeClone(table(name).get(key)) };
      }
      const target = table(name);
      const current = target.get(key);
      const currentRev = Number.isInteger(current?.rev) ? current.rev : 0;

      if (Number.isInteger(opts.expectRev) && opts.expectRev !== currentRev) {
        return { ok: false, code: 'CAS_MISMATCH', current: safeClone(current), expectedRev: opts.expectRev, actualRev: currentRev };
      }

      if (typeof opts.idempotencyKey === 'string' && opts.idempotencyKey) {
        const seen = table('idempotency').get(opts.idempotencyKey);
        const fp = fingerprint({ name, key, value });
        if (seen) {
          if (seen.fingerprint === fp) {
            return { ok: true, deduplicated: true, record: safeClone(target.get(seen.key) ?? seen.record) };
          }
          return { ok: false, code: 'IDEMPOTENCY_CONFLICT', current: safeClone(target.get(seen.key)), seen };
        }
      }

      const global = readGlobal();
      const nextRev = currentRev + 1;
      const nextGlobalRev = Math.max(Number.isInteger(global.revision) ? global.revision : 0, nextRev) + 1;
      const record = { ...safeClone(value), rev: nextRev, updatedAt: clock.now() };
      target.set(key, record);
      const written = await persist(name, key);
      if (!written.ok) {
        if (current === undefined) target.delete(key);
        else target.set(key, current);
        return { ok: false, code: written.code ?? 'PERSIST_FAILED', message: written.message, current: safeClone(current) };
      }
      if (opts.idempotencyKey) {
        table('idempotency').set(opts.idempotencyKey, { key, fingerprint: fingerprint({ name, key, value }), at: clock.now(), rev: nextRev });
        // 幂等记录**必须真的落盘**：它是"重复事件/重启不重复创建"的唯一凭据。
        // 写失败时不能静默（旧代码丢掉了返回值），否则重启后去重保护消失。
        const idempotencyStored = await persist('idempotency', opts.idempotencyKey);
        if (!idempotencyStored.ok) {
          diagnostics.push('storage:idempotency-not-persisted', `幂等键 ${opts.idempotencyKey} 未能落盘（${idempotencyStored.code}: ${idempotencyStored.message}）：本次会话内仍生效，但**重启后去重会失效**。`);
        }
      }
      if (opts.touchGlobalRevision !== false) {
        await writeGlobal({ ...global, revision: nextGlobalRev, writerEpoch: state.writerEpoch, updatedAt: clock.now() });
      }
      return { ok: true, record: safeClone(record), rev: nextRev, globalRevision: nextGlobalRev };
    });
  }

  async function remove(name, key, opts = {}) {
    return mutex.run(async () => {
      if (state.secondWriter && options.singleWriter !== false) return { ok: false, code: 'SECOND_WRITER' };
      const target = table(name);
      const current = target.get(key);
      if (current === undefined) return { ok: true, removed: false };
      if (Number.isInteger(opts.expectRev) && opts.expectRev !== current.rev) return { ok: false, code: 'CAS_MISMATCH', current: safeClone(current) };
      target.delete(key);
      const written = await persist(name, key);
      if (!written.ok) {
        target.set(key, current);
        return { ok: false, code: written.code ?? 'PERSIST_FAILED', message: written.message };
      }
      return { ok: true, removed: true };
    });
  }

  return {
    get durable() {
      return state.durable;
    },
    get backend() {
      return state.backend;
    },
    /** true = 没拿到 storageDomain，正在用插件自有后端（降级）。 */
    get degraded() {
      return state.degraded;
    },
    get openedByUs() {
      return state.openedByUs;
    },
    get backendError() {
      return state.backendError;
    },
    get fallbackDir() {
      return state.fallbackDir;
    },
    get migrationRequired() {
      return state.migrationRequired;
    },
    get writerEpoch() {
      return state.writerEpoch;
    },
    get writerHeld() {
      return state.writerHeld;
    },
    get secondWriter() {
      return state.secondWriter;
    },
    diagnostics: () => diagnostics.list(),
    tables: TABLES,
    mutex,

    async ready() {
      if (!state.opened) {
        state.opened = true;
        await open();
        await mutex.run(async () => {
          const claim = await claimWriter();
          if (!claim.ok) {
            // 只读诊断态：仍然加载数据，但所有写被拒绝。
            diagnostics.push('storage:read-only', claim.message);
          }
        });
      }
      return {
        durable: state.durable,
        backend: state.backend,
        degraded: state.degraded,
        openedByUs: state.openedByUs,
        backendError: state.backendError,
        fallbackDir: state.fallbackDir,
        writerHeld: state.writerHeld,
        secondWriter: state.secondWriter,
        migrationRequired: state.migrationRequired,
      };
    },

    /** 后端位置的可读描述（storageDomain 时不指向 fallback 目录，避免误导）。 */
    location() {
      if (state.backend === 'storageDomain') return `storageDomain:${DOMAIN_NAME}`;
      if (state.backend === 'json-files') return state.fallbackDir ?? 'json-files';
      return 'memory-only';
    },

    /** 仅在 fallback（json-files）生效时非 null。 */
    dataDir: () => state.fallbackDir,

    loadAll() {
      return {
        schemaVersion: Number.isInteger(readGlobal().schemaVersion) ? readGlobal().schemaVersion : 0,
        revision: Number.isInteger(readGlobal().revision) ? readGlobal().revision : 0,
        writerEpoch: readGlobal().writerEpoch ?? null,
        tables: Object.fromEntries(TABLES.map((name) => [name, Object.fromEntries(tableSnapshot(name))])),
      };
    },

    get(name, key) {
      const value = table(name).get(key);
      return value === undefined ? undefined : safeClone(value);
    },

    list(name) {
      return [...table(name).entries()].map(([key, value]) => [key, safeClone(value)]);
    },

    size(name) {
      return table(name).size;
    },

    put,
    remove,
    claimWriter,
    heartbeat,
    releaseWriter,
    /** 仅供确定性测试与恢复路径：直接把内存镜像灌入。 */
    hydrateFrom(tables) {
      for (const name of TABLES) {
        const rows = tables?.[name] ?? {};
        const target = table(name);
        target.clear();
        for (const [key, value] of Object.entries(rows)) target.set(String(key), value);
      }
    },
    async close() {
      await releaseWriter();
      // 只关闭本世代自己 open 的 domain；接管来的 handle 属于上一世代，不能替它 close。
      if (domain && state.openedByUs) await adapter.closeDomain(domain);
      domain = null;
      state.opened = false;
      state.openedByUs = false;
    },
  };
}
