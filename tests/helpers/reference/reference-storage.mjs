/**
 * Reference (simulated) implementation of docs/ARCHITECTURE.md；历史检查 2.2.
 *
 * Proves the harness can drive: single-writer claim, compare-and-set,
 * idempotency keys, durable write-through, restart over the same backend.
 * Marked simulated — it is not the shipped storage layer.
 */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

export const STORAGE_DOMAIN = {
  name: 'team-workbench.test',
  version: 1,
  layout: 'per-record',
  global: { schema: null, initial: { writerEpoch: null, heartbeatAt: 0, schemaVersion: 1 } },
  tables: {
    layout: { valueSchema: null },
    teams: { valueSchema: null },
    members: { valueSchema: null },
    works: { valueSchema: null },
    attempts: { valueSchema: null },
    lateResults: { valueSchema: null },
    counters: { valueSchema: null },
    idem: { valueSchema: null },
  },
};

const WRITER_STALE_MS = 5_000;

/**
 * @param {{ adapter:object, clock:{now:()=>number}, schemaVersion?:number }} deps
 */
export async function createReferenceStorage(deps) {
  const { adapter, clock } = deps;
  const schemaVersion = deps.schemaVersion ?? 1;
  const writerEpoch = `epoch-${randomUUID().slice(0, 8)}`;
  const stats = { puts: 0, casRejections: 0, idempotentReplays: 0, deletes: 0, writes: 0 };

  const opened = await adapter.openDomain(STORAGE_DOMAIN);
  if (!opened?.ok) throw new Error(`reference storage cannot open domain: ${opened?.code}`);
  const domain = opened.value;

  /** table -> Map(key -> { v, rev, value }) */
  const cache = new Map();
  for (const table of Object.keys(STORAGE_DOMAIN.tables)) {
    const rows = new Map();
    for (const [key, record] of domain.table(table).entries()) rows.set(key, record);
    cache.set(table, rows);
  }

  const idemKey = (idempotencyKey) => createHash('sha256').update(String(idempotencyKey), 'utf8').digest('hex').slice(0, 32);

  function tableOf(table) {
    if (!cache.has(table)) throw new Error(`unknown table ${table}`);
    return cache.get(table);
  }

  async function persist(table, key, record) {
    await domain.table(table).put(key, record);
    stats.writes += 1;
  }

  const storage = {
    simulated: true,
    domainName: STORAGE_DOMAIN.name,
    writerEpoch,
    schemaVersion,
    stats,

    async ready() {
      return undefined;
    },

    async loadAll() {
      const out = { schemaVersion: domain.global.get()?.schemaVersion ?? schemaVersion };
      for (const [table, rows] of cache.entries()) {
        out[table] = Object.fromEntries([...rows.entries()].map(([key, record]) => [key, record.value]));
      }
      return out;
    },

    get(table, key) {
      const record = tableOf(table).get(String(key));
      return record ? { ...record } : undefined;
    },

    list(table) {
      return [...tableOf(table).values()].map((record) => ({ key: record.key, ...record }));
    },

    /** @returns {{ok:true, record:object, rev:number, code?:string} | {ok:false, code:string, current:object|null, currentRev:number}} */
    async put(table, key, value, options = {}) {
      const rows = tableOf(table);
      const normalizedKey = String(key);
      if (options.idempotencyKey) {
        const hashed = idemKey(options.idempotencyKey);
        const idemRow = cache.get('idem').get(hashed);
        if (idemRow) {
          const previous = tableOf(idemRow.value.table).get(idemRow.value.key);
          if (previous) {
            stats.idempotentReplays += 1;
            return { ok: true, code: 'IDEMPOTENT_REPLAY', record: { ...previous }, rev: previous.rev };
          }
        }
      }
      const current = rows.get(normalizedKey);
      if (options.expectRev !== undefined && (current?.rev ?? 0) !== options.expectRev) {
        stats.casRejections += 1;
        return { ok: false, code: 'CAS_MISMATCH', current: current ? structuredClone(current.value) : null, currentRev: current?.rev ?? 0 };
      }
      const rev = (current?.rev ?? 0) + 1;
      const record = { key: normalizedKey, v: schemaVersion, rev, value: structuredClone(value) };
      await persist(table, normalizedKey, record);
      rows.set(normalizedKey, record);
      if (options.idempotencyKey) {
        const hashed = idemKey(options.idempotencyKey);
        const idemRecord = { key: hashed, v: schemaVersion, rev, value: { table, key: normalizedKey, rev } };
        await persist('idem', hashed, idemRecord);
        cache.get('idem').set(hashed, idemRecord);
      }
      stats.puts += 1;
      return { ok: true, record: { ...record }, rev };
    },

    async delete(table, key) {
      const rows = tableOf(table);
      const existed = rows.delete(String(key));
      if (existed) {
        await domain.table(table).delete(String(key));
        stats.deletes += 1;
      }
      return existed;
    },

    /** Detect a concurrent Host writer through the durable global record. */
    async claimWriter() {
      const global = domain.global.get() ?? {};
      const fresh = global.writerEpoch && global.writerEpoch !== writerEpoch
        && Number.isFinite(global.heartbeatAt)
        && clock.now() - global.heartbeatAt < WRITER_STALE_MS;
      if (fresh) return { ok: false, code: 'SECOND_WRITER', current: global.writerEpoch };
      await domain.global.set({ ...global, writerEpoch, heartbeatAt: clock.now(), schemaVersion });
      return { ok: true, epoch: writerEpoch };
    },

    /** Test/diagnostic view of the durable global record. */
    globalRecord() {
      return domain.global.get();
    },

    async close() {
      await domain.close();
    },
  };

  return storage;
}

export default createReferenceStorage;
