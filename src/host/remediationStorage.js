/**
 * `remediationStorage.js` — 新 sidecar 表的**独立持久化 facade**（Lead 第 8 回合要求 2）。
 *
 * ## 为什么需要 facade
 *
 * 宿主只读审计确认：旧 `storage` 的合法表集合是**闭包固定的 13 张表**
 * （`source-baseline/src/host/storage.js:32-48`，现实现 `storage.js:168` 闭包 memory、
 * `:271` 返回 `Object.freeze(TABLES)`）。因此：
 * - `service.storage.tables.push(...)` 会 TypeError（冻结数组）；
 * - 同名 `storageDomain` 不能二次 open（`already-open`）；
 * - 旧 domain 也不接受新表。
 *
 * 结论：新增表必须走**独立 sidecar**，再用 facade 把「新表 → sidecar；旧表 → 原 storage」
 * 路由起来，原 storage 对象/writerEpoch/队列/身份**原样不变**。service 内部所有
 * `this.storage.put/get/list(newTable)` 调用点通过 facade 自动落 sidecar，无需逐个改调用点。
 *
 * ## 落盘形式（费用审计 14:27 失败项 21/26 修复）
 *
 * 旧实现每条 `put` 都重写整张表（40 条记录 → 20.6 倍写放大；28K 表更差），且
 * 损坏的现有文件会被当成空表继续写。现在：
 *
 * - **追加日志** `<table>.log`：每条变更一行 `{"k":key,"r":record}`，append + fsync 成功
 *   之后 `put` 才返回 ok（"先持久化、后提交内存累计"的底层保证）。
 * - **有界快照压缩** `<table>.json`：当追加行数达到 `max(16, 表规模/4)` 时，把内存表
 *   整体写成快照（唯一 tmp + rename + fsync），然后清空日志。写放大从 O(n²) 降为
 *   O(n·log n) 级别，且单次写入有界。
 * - **加载失败关闭**：现有 `.json` / `.log` 解析失败**不是空表**——该表被标记 failed，
 *   `load()` 抛错、`put` 明确返回 `SIDECAR_LOAD_FAILED`，磁盘原始字节保持不动（供恢复）。
 * - **并发有序**：同一 store 的写入/压缩/日志清空全部走单链（`writeChain`），
 *   tmp 名字含 pid+单调序号，绝不共享 tmp。
 * - 委托表：`put/get/list/remove/heartbeat/...` 直接调用原 storage，**不做任何改写**。
 * - `tables` 只读：返回原 storage 的 `tables`（原样引用/getter），sidecar 表通过
 *   `sidecarTables` 单独暴露；绝不 push。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './storage-fallback.js';

export const SIDECAR_TABLES = Object.freeze([
  'identity_records',
  'evidence_records',
  'error_fingerprints',
  'execution_runs',
  'usage_requests',
  'usage_cursors',
  'usage_totals',
  'usage_step_cursors',
  // client-ack / 维护 receipt 持久化需要真实表；缺这张会让 /state.frontendAck 永远 persisted:false。
  'meta_records',
]);

function nowOf(clock) {
  return typeof clock?.now === 'function' ? clock.now() : Date.now();
}

/** 快照压缩阈值：日志行数达到 `max(MIN_SNAPSHOT_LINES, ceil(size/SNAPSHOT_DIVISOR))` 时压缩。 */
const MIN_SNAPSHOT_LINES = 16;
const SNAPSHOT_DIVISOR = 4;
/** 日志单行上限（防御性；单记录超过它仍会写入，只是不会被截断）。 */
const MAX_LOG_LINE_BYTES = 8 * 1024 * 1024;

/** 极简、可测、可回滚的 JSON 文件 sidecar（追加日志 + 有界快照）。 */
export function createSidecarStore({ dir, clock, diagnostics } = {}) {
  const root = dir;
  const state = new Map(); // table -> Map(key -> record)
  const failedTables = new Map(); // table -> { code, message }（加载失败关闭）
  const loadedTables = new Set();
  let loaded = false;
  let lastFlushError = null;
  let tempSeq = 0;
  let writeChain = Promise.resolve();
  /** 每张表自上次快照后的日志行数（写成功才 +1）。 */
  const logLines = new Map();
  /** 每张表最近一次快照的文件字节数（用于压缩阈值判断的稳定性，不作为性能证明）。 */
  const snapshotBytes = new Map();
  let writeStats = { appends: 0, appendsBytes: 0, snapshots: 0, snapshotsBytes: 0, logTruncates: 0 };

  if (!root) {
    // 无目录：所有写入失败关闭（探针/测试会看到 SIDECAR_FLUSH_FAILED），不静默成功。
    const failNoDir = async () => ({ ok: false, code: 'SIDECAR_DIR_UNAVAILABLE', message: 'sidecar 目录未配置' });
    for (const table of SIDECAR_TABLES) failedTables.set(table, { code: 'SIDECAR_DIR_UNAVAILABLE', message: 'sidecar 目录未配置' });
    return {
      list: () => [],
      get: () => undefined,
      put: failNoDir,
      remove: failNoDir,
      load: async () => { throw Object.assign(new Error('sidecar 目录未配置'), { code: 'SIDECAR_DIR_UNAVAILABLE' }); },
      flushAll: async () => ({ ok: false, code: 'SIDECAR_DIR_UNAVAILABLE', results: [] }),
      probe: failNoDir,
      writeStats: () => ({ ...writeStats }),
      failedTables: () => [...failedTables.keys()],
      tables: SIDECAR_TABLES.slice(),
    };
  }

  const tablePath = (table) => path.join(root, `${table}.json`);
  const logPath = (table) => path.join(root, `${table}.log`);

  /** 单链串行：同一 store 的所有磁盘写有序（并发 put 不会互相覆盖）。 */
  function enqueue(task) {
    const run = writeChain.then(task, task);
    // 保持链不因单次失败断掉；调用方拿到的仍是对应 task 的结果。
    writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  async function readText(absolute) {
    try {
      return await fsp.readFile(absolute, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  function parseSnapshot(table, text) {
    const parsed = JSON.parse(text);
    const map = new Map();
    for (const [key, value] of Object.entries(parsed?.records ?? {})) map.set(key, value);
    return map;
  }

  function parseLog(table, text) {
    const lines = String(text ?? '').split('\n');
    let pending = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (!entry || typeof entry !== 'object' || typeof entry.k !== 'string') throw new Error('log entry 缺少 k');
        storeFor(table).set(entry.k, entry.r);
        pending += 1;
      } catch (error) {
        // 尾部半行（崩溃/断电留下、且从未 ack）允许忽略；完整行损坏 → 失败关闭。
        const isLast = index === lines.length - 1;
        const tornTail = isLast && !String(text).endsWith('\n');
        if (tornTail) {
          diagnostics?.push?.('storage:sidecar:log-torn-tail', `${table}: 忽略未 ack 的尾部半行`);
          break;
        }
        throw error;
      }
    }
    return pending;
  }

  function storeFor(table) {
    let map = state.get(table);
    if (!map) {
      map = new Map();
      state.set(table, map);
    }
    return map;
  }

  async function loadTable(table) {
    if (loadedTables.has(table)) return;
    const snapshotText = await readText(tablePath(table));
    if (snapshotText !== null) {
      try {
        state.set(table, parseSnapshot(table, snapshotText));
      } catch (error) {
        failedTables.set(table, { code: 'SIDECAR_LOAD_CORRUPT', message: `${table}.json: ${String(error?.message ?? error)}` });
        diagnostics?.push?.('storage:sidecar:load-failed', `${table}: ${String(error?.message ?? error)}`);
        loadedTables.add(table);
        throw Object.assign(new Error(`sidecar 表 ${table}.json 解析失败：${String(error?.message ?? error)}`), {
          code: 'SIDECAR_LOAD_CORRUPT',
          table,
        });
      }
    } else {
      state.set(table, state.get(table) ?? new Map());
    }
    const logText = await readText(logPath(table));
    if (logText !== null && logText.trim()) {
      try {
        logLines.set(table, parseLog(table, logText));
      } catch (error) {
        failedTables.set(table, { code: 'SIDECAR_LOAD_CORRUPT', message: `${table}.log: ${String(error?.message ?? error)}` });
        diagnostics?.push?.('storage:sidecar:load-failed', `${table}: ${String(error?.message ?? error)}`);
        loadedTables.add(table);
        throw Object.assign(new Error(`sidecar 表 ${table}.log 解析失败：${String(error?.message ?? error)}`), {
          code: 'SIDECAR_LOAD_CORRUPT',
          table,
        });
      }
    } else {
      logLines.set(table, 0);
    }
    if (snapshotText !== null) snapshotBytes.set(table, Buffer.byteLength(snapshotText, 'utf8'));
    loadedTables.add(table);
  }

  /** 加载全部表；任一表损坏 → 抛错（该表标记 failed，写入被拒绝），其余表仍可用。 */
  async function load() {
    if (loaded) return { ok: failedTables.size === 0, failed: [...failedTables.keys()] };
    await fsp.mkdir(root, { recursive: true }).catch((error) => {
      diagnostics?.push?.('storage:sidecar:mkdir-failed', String(error?.message ?? error));
    });
    const errors = [];
    for (const table of SIDECAR_TABLES) {
      try {
        await loadTable(table);
      } catch (error) {
        errors.push(error);
      }
    }
    loaded = true;
    if (errors.length > 0) {
      const aggregate = new AggregateError(errors, `sidecar 有 ${errors.length} 张表损坏：加载失败关闭（不当作空表写入）`);
      aggregate.code = 'SIDECAR_LOAD_CORRUPT';
      aggregate.tables = [...failedTables.keys()];
      throw aggregate;
    }
    return { ok: true, failed: [] };
  }

  /** 写入通过 **FileHandle.writeFile**（真实可被外部观测/计量的持久写 API）；随后 fsync。 */
  async function writeAll(handle, text) {
    const payload = String(text ?? '');
    await handle.writeFile(payload, 'utf8');
    return Buffer.byteLength(payload, 'utf8');
  }
  async function fsyncQuietly(handle) {
    try {
      await handle.sync();
    } catch {
      /* 某些 FS 不支持 fsync：写入语义仍以 write 成功为准 */
    }
  }

  /** 追加一行到 `<table>.log`（append + fsync）；失败返回 ok:false，不改变磁盘已有内容。 */
  async function appendLog(table, key, record) {
    const target = logPath(table);
    const line = `${JSON.stringify({ k: key, r: record })}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > MAX_LOG_LINE_BYTES) {
      // 超大单条：直接走快照路径（避免日志行无界）。
      return { ok: false, code: 'SIDECAR_LOG_ENTRY_TOO_LARGE', message: `${bytes} bytes` };
    }
    let handle = null;
    try {
      // 目录可能还不存在（首次写入 / 被清理）：先兜底创建；目录不可创建时 open 会失败并返回 ok:false。
      await fsp.mkdir(root, { recursive: true }).catch(() => {});
      handle = await fsp.open(target, 'a');
      await writeAll(handle, line);
      await fsyncQuietly(handle);
      writeStats.appends += 1;
      writeStats.appendsBytes += bytes;
      logLines.set(table, (logLines.get(table) ?? 0) + 1);
      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'SIDECAR_FLUSH_FAILED', message: String(error?.message ?? error) };
    } finally {
      if (handle) { try { await handle.close(); } catch { /* closed */ } }
    }
  }

  /** 把内存表整体写成快照：唯一 tmp（wx）→ fsync → rename；成功后清空日志。 */
  async function writeSnapshot(table) {
    const map = state.get(table) ?? new Map();
    const text = JSON.stringify({ table, updatedAt: nowOf(clock), records: Object.fromEntries(map) });
    let temp = null;
    try {
      await fsp.mkdir(root, { recursive: true });
      const target = tablePath(table);
      temp = `${target}.${process.pid}.${tempSeq += 1}.tmp`;
      const handle = await fsp.open(temp, 'wx');
      try {
        await writeAll(handle, text);
        await fsyncQuietly(handle);
      } finally {
        await handle.close();
      }
      await fsp.rename(temp, target);
      temp = null;
      snapshotBytes.set(table, Buffer.byteLength(text, 'utf8'));
      writeStats.snapshots += 1;
      writeStats.snapshotsBytes += Buffer.byteLength(text, 'utf8');
      // 快照已 rename 成功后才清空日志：崩溃在两者之间只会重放日志（幂等覆盖，不丢记录）。
      await truncateLog(table);
      logLines.set(table, 0);
      return { ok: true };
    } catch (error) {
      lastFlushError = { table, code: 'SIDECAR_FLUSH_FAILED', message: String(error?.message ?? error) };
      diagnostics?.push?.('storage:sidecar:flush-failed', `${table}: ${String(error?.message ?? error)}`);
      if (temp) { try { await fsp.rm(temp, { force: true }); } catch { /* cleanup */ } }
      // 失败**不得**返回 ok：调用方据此不推进 cursor。
      return { ok: false, code: 'SIDECAR_FLUSH_FAILED', message: String(error?.message ?? error) };
    }
  }

  async function truncateLog(table) {
    const target = logPath(table);
    let handle = null;
    try {
      // Windows：append('a') 句柄不允许 ftruncate（EPERM）；压缩清空日志必须用 'r+'。
      handle = await fsp.open(target, 'r+');
      await handle.truncate(0);
      await fsyncQuietly(handle);
      writeStats.logTruncates += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    } finally {
      if (handle) { try { await handle.close(); } catch { /* closed */ } }
    }
  }

  /** 压缩阈值：日志行数达到 max(16, 表规模/4) 时写快照（写放大有界、O(n·log n)）。 */
  function needsSnapshot(table) {
    const size = state.get(table)?.size ?? 0;
    const limit = Math.max(MIN_SNAPSHOT_LINES, Math.ceil(size / SNAPSHOT_DIVISOR));
    return (logLines.get(table) ?? 0) >= limit;
  }

  function list(table) {
    const map = state.get(table);
    if (!map) return [];
    return [...map.entries()].map(([key, value]) => [key, value]);
  }
  function get(table, key) {
    return state.get(table)?.get(key);
  }

  async function put(table, key, value, options = {}) {
    if (failedTables.has(table)) {
      return { ok: false, code: 'SIDECAR_LOAD_FAILED', message: failedTables.get(table).message };
    }
    if (!loadedTables.has(table)) {
      try {
        await loadTable(table);
      } catch (error) {
        return { ok: false, code: 'SIDECAR_LOAD_CORRUPT', message: String(error?.message ?? error) };
      }
    }
    return enqueue(async () => {
      const map = storeFor(table);
      const current = map.get(key);
      if (options.idempotencyKey && current && current.idempotencyKey === options.idempotencyKey) {
        return { ok: true, record: current, deduplicated: true };
      }
      if (Number.isInteger(options.expectRev) && current && Number(current.rev) !== options.expectRev) {
        return { ok: false, code: 'CAS_MISMATCH', message: `${table}/${key} rev ${current.rev} != ${options.expectRev}` };
      }
      const record = { ...value, rev: (Number(current?.rev) || 0) + 1, updatedAt: nowOf(clock), ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) };
      // **先写日志（durable）再提交内存**：日志 append+fsync 失败时内存保持旧值。
      const appended = await appendLog(table, key, record);
      if (appended.ok !== true) {
        return { ok: false, code: appended.code ?? 'SIDECAR_FLUSH_FAILED', message: appended.message ?? 'sidecar append failed' };
      }
      map.set(key, record);
      if (needsSnapshot(table)) {
        const snap = await writeSnapshot(table);
        if (snap.ok !== true) {
          // 记录已 append+fsync 到日志（**已持久**，加载时会重放）；快照只是压缩优化。
          // 压缩失败不得把一次已 durable 的写入报成失败（否则调用方会不推进 cursor、重复采集）。
          diagnostics?.push?.('storage:sidecar:compaction-failed', `${table}: ${snap.message ?? snap.code}`);
          return { ok: true, record, deduplicated: false, compacted: false, compactionWarning: snap.code ?? 'SIDECAR_FLUSH_FAILED' };
        }
      }
      return { ok: true, record, deduplicated: false, compacted: true };
    });
  }

  async function remove(table, key) {
    if (failedTables.has(table)) return { ok: false, code: 'SIDECAR_LOAD_FAILED', message: failedTables.get(table).message };
    if (!loadedTables.has(table)) {
      try { await loadTable(table); } catch (error) { return { ok: false, code: 'SIDECAR_LOAD_CORRUPT', message: String(error?.message ?? error) }; }
    }
    return enqueue(async () => {
      const map = state.get(table);
      if (!map?.has(key)) return { ok: true, removed: false };
      const record = { __removed: true, rev: (Number(map.get(key)?.rev) || 0) + 1 };
      const appended = await appendLog(table, key, record);
      if (appended.ok !== true) return { ok: false, code: 'SIDECAR_FLUSH_FAILED', message: appended.message };
      map.delete(key);
      if (needsSnapshot(table)) {
        const snap = await writeSnapshot(table);
        if (snap.ok !== true) return { ok: true, removed: true, compacted: false, compactionWarning: snap.code ?? 'SIDECAR_FLUSH_FAILED' };
      }
      return { ok: true, removed: true };
    });
  }

  /** 批量 flush：把所有未压缩的日志写成快照（按唯一 tmp 落盘）；任一失败返回 ok:false。 */
  async function flushAll() {
    const results = [];
    for (const table of SIDECAR_TABLES) {
      if (failedTables.has(table)) { results.push({ table, ok: false, code: 'SIDECAR_LOAD_FAILED' }); continue; }
      if ((logLines.get(table) ?? 0) === 0) { results.push({ table, ok: true, skipped: true }); continue; }
      const result = await enqueue(() => writeSnapshot(table));
      results.push({ table, ...result });
    }
    return { ok: results.every((item) => item.ok !== false), results };
  }

  /** 独立读回：直接从磁盘（快照 + 日志重放）读一条记录，证明落盘而不是只读内存。 */
  async function readBackFromDisk(table, key) {
    let map;
    const snapshotText = await readText(tablePath(table));
    if (snapshotText === null) map = new Map();
    else map = parseSnapshot(table, snapshotText);
    const logText = await readText(logPath(table));
    if (logText && logText.trim()) {
      for (const line of logText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const entry = JSON.parse(trimmed);
        if (entry.k === key) map.set(entry.k, entry.r);
      }
    }
    return map.get(key);
  }

  /** sidecar 就绪探针：逐表 put → **独立磁盘读回**（不是内存 get）。失败即 SIDECAR_PROBE_FAILED。 */
  async function probe() {
    const results = [];
    for (const table of SIDECAR_TABLES) {
      const key = '__probe__';
      const at = nowOf(clock);
      const stored = await put(table, key, { probe: true, at }, { idempotencyKey: `probe:${table}:${at}` });
      let read = null;
      let readError = null;
      try {
        read = await readBackFromDisk(table, key);
      } catch (error) {
        readError = String(error?.message ?? error);
      }
      const ok = stored?.ok === true && read?.probe === true;
      results.push({ table, ok, rev: read?.rev ?? null, readError });
      if (!ok) return { ok: false, code: 'SIDECAR_PROBE_FAILED', table, results };
    }
    return { ok: true, results };
  }

  return {
    list,
    get,
    put,
    remove,
    load,
    flushAll,
    probe,
    readBackFromDisk,
    writeStats: () => ({ ...writeStats }),
    failedTables: () => [...failedTables.keys()],
    tables: SIDECAR_TABLES.slice(),
  };
}

/**
 * 创建 remediation façade。
 *
 * @param {{ base:object, sidecar:object, diagnostics?:object }} deps
 */
export function createRemediationStorage({ base, sidecar, diagnostics } = {}) {
  const newTables = new Set(SIDECAR_TABLES);
  const isNew = (table) => newTables.has(String(table));
  const delegate = (method) => (...args) => {
    if (!base || typeof base[method] !== 'function') return { ok: false, code: 'STORAGE_METHOD_MISSING', message: `base.${method}` };
    return base[method](...args);
  };

  const facade = {
    // ---- 新表 → sidecar -----------------------------------------------------
    put(table, key, value, options) {
      if (isNew(table)) return sidecar.put(table, key, value, options);
      return delegate('put')(table, key, value, options);
    },
    get(table, key) {
      if (isNew(table)) return sidecar.get(table, key);
      return typeof base?.get === 'function' ? base.get(table, key) : undefined;
    },
    list(table) {
      if (isNew(table)) return sidecar.list(table);
      return typeof base?.list === 'function' ? base.list(table) : [];
    },
    remove(table, key) {
      if (isNew(table)) return sidecar.remove(table, key);
      return delegate('remove')(table, key);
    },
    // ---- 委托属性：原样引用，绝不改写 --------------------------------------
    get tables() {
      return base?.tables;
    },
    get sidecarTables() {
      return SIDECAR_TABLES.slice();
    },
    get durable() {
      return base?.durable !== false;
    },
    get backend() {
      return base?.backend;
    },
    get degraded() {
      return base?.degraded ?? false;
    },
    get writerEpoch() {
      return base?.writerEpoch;
    },
    get migrationRequired() {
      return base?.migrationRequired ?? false;
    },
    heartbeat(...args) {
      return typeof base?.heartbeat === 'function' ? base.heartbeat(...args) : Promise.resolve({ ok: true });
    },
    dataDir(...args) {
      return typeof base?.dataDir === 'function' ? base.dataDir(...args) : null;
    },
    location(...args) {
      return typeof base?.location === 'function' ? base.location(...args) : null;
    },
    diagnostics(...args) {
      return typeof base?.diagnostics === 'function' ? base.diagnostics(...args) : [];
    },
    size(table) {
      if (isNew(table)) return sidecar.list(table).length;
      return typeof base?.size === 'function' ? base.size(table) : 0;
    },
    /** 统一 ready：先完成旧 core storage 的 ready（真实稳定目录），再 load 同一 sidecar。
     *  损坏表 → 返回 `{ok:false, code:'SIDECAR_LOAD_CORRUPT'}` 并记诊断（绝不把损坏表当空表继续写）。 */
    async ready(...args) {
      const baseReady = typeof base?.ready === "function" ? await base.ready(...args) : { ok: true };
      let sidecarLoad = { ok: true };
      try {
        sidecarLoad = { ...(await sidecar.load?.()) };
      } catch (error) {
        sidecarLoad = { ok: false, code: error?.code ?? 'SIDECAR_LOAD_CORRUPT', message: String(error?.message ?? error), failedTables: sidecar.failedTables?.() ?? [] };
        diagnostics?.push?.('storage:sidecar:load-closed', String(error?.message ?? error));
      }
      return { ...(baseReady ?? {}), ...sidecarLoad, sidecarLoaded: sidecarLoad.ok !== false, sidecarDir: sidecarDirFor(base) };
    },
    /** sidecar 就绪探针：逐表 put → 独立磁盘读回校验。失败即 `SIDECAR_PROBE_FAILED`。 */
    async probe() {
      try {
        await sidecar.load?.();
      } catch (error) {
        return { ok: false, code: 'SIDECAR_LOAD_CORRUPT', message: String(error?.message ?? error) };
      }
      const result = typeof sidecar.probe === 'function' ? await sidecar.probe() : { ok: false, code: 'SIDECAR_PROBE_UNAVAILABLE' };
      if (result.ok !== true) return result;
      // 旧表委托探针：确认 facade 对旧表仍走原 storage（不产生新写入副作用，只读 list）。
      const baseTables = Array.isArray(base?.tables) ? base.tables : [];
      const delegates = baseTables.slice(0, 3).map((table) => ({ table, listOk: Array.isArray(facade.list(table)) }));
      return { ...result, delegates, baseTables };
    },
    writeStats() {
      return typeof sidecar.writeStats === 'function' ? sidecar.writeStats() : null;
    },
  };
  void diagnostics;
  const proxied = new Proxy(facade, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (base && typeof base[prop] === "function") return base[prop].bind(base);
      return base?.[prop];
    },
  });
  return proxied;
}

/** 默认 sidecar 根目录：优先 base.dataDir()，否则进程 cwd 下 .runtime。 */
export function sidecarDirFor(base) {
  const dataDir = typeof base?.dataDir === 'function' ? base.dataDir() : null;
  if (dataDir) return path.join(dataDir, 'remediation-sidecar');
  // storageDomain **永远没有 dataDir**（只读事实）。为了让 hot 写 → normal apply 冷读落在同一地址，
  // 这里用**显式稳定根**（DSH_TEAM_WORKBENCH_DIR / DSH_HOME），只有都没有时才退回进程内 cwd 根。
  const explicit = typeof process.env.DSH_TEAM_WORKBENCH_DIR === 'string' && process.env.DSH_TEAM_WORKBENCH_DIR.trim()
    ? process.env.DSH_TEAM_WORKBENCH_DIR.trim()
    : null;
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim()
    ? path.join(process.env.DSH_HOME.trim(), 'team-workbench')
    : null;
  return path.join(explicit || home || path.join(process.cwd(), '.runtime', 'dsh-team-workbench'), 'remediation-sidecar');
}
