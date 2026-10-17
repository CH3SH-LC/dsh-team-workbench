/**
 * In-memory `storageDomain` emulation (Domain + KvTable + KvUnit).
 *
 * Mirrors the live contract recorded in docs/ARCHITECTURE.md:
 *   - `open(spec)` rejects with `already-open` / `version-mismatch`;
 *   - tables expose get/entries/keys/size/put/delete/update;
 *   - `update` on a missing key throws `missing-key`;
 *   - a write resolves only after the backend acknowledged durability, and only
 *     then is `domain/changed` emitted;
 *   - there is **no CAS and no transaction**: the Host's storage layer must build
 *     compare-and-set itself (that is one of the things we are verifying).
 *
 * The backend object survives across `createFakeStorageDomain()` calls so a
 * "restart / cold recovery" test can build a second Host instance over the same
 * bytes.
 */

export class DomainError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.detail = detail;
  }
}

/** Fresh durable backend. Keep the reference across simulated restarts. */
export function createDomainBackend() {
  return {
    version: 1,
    domains: new Map(),
    writes: 0,
    /** When > 0, the next N putRecord calls reject (memory must stay untouched). */
    failNextWrites: 0,
    /** Backend-level operation log, useful for asserting "no duplicate create". */
    log: [],
  };
}

function domainSlot(backend, name, spec) {
  let slot = backend.domains.get(name);
  if (!slot) {
    slot = {
      version: spec.version,
      tables: new Map(),
      global: spec.global ? structuredClone(spec.global.initial) : undefined,
    };
    backend.domains.set(name, slot);
  }
  return slot;
}

/**
 * @param {{ backend?: ReturnType<typeof createDomainBackend>, onChanged?: (change:object)=>void }} [options]
 */
export function createFakeStorageDomain(options = {}) {
  const backend = options.backend ?? createDomainBackend();
  const openNames = new Map();
  const listeners = [];
  const stats = { opened: 0, closed: 0, puts: 0, deletes: 0, globals: 0, rejects: 0 };

  const domain_facility = {
    backend,
    stats,
    /** Test hook: observe every emitted domain/changed. */
    onChange(listener) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    /** Test hook: replay a change as if a duplicate notification arrived. */
    emitChange(change) {
      for (const listener of listeners.slice()) listener(change);
    },
    isOpen(name) {
      return openNames.has(name);
    },

    async open(spec) {
      if (openNames.has(spec.name)) {
        stats.rejects += 1;
        throw new DomainError('already-open', `domain ${spec.name} is already open`);
      }
      const slot = backend.domains.get(spec.name);
      if (slot && slot.version !== spec.version) {
        const compatible = Array.isArray(spec.compatibleVersions) && spec.compatibleVersions.includes(slot.version);
        if (!compatible) {
          stats.rejects += 1;
          throw new DomainError('version-mismatch', `domain ${spec.name}: stored version ${slot.version} != spec version ${spec.version}`, {
            stored: slot.version,
            spec: spec.version,
          });
        }
      }
      const live = domainSlot(backend, spec.name, spec);
      stats.opened += 1;

      const tableNames = Object.keys(spec.tables ?? {});
      if (!live.tables.has('__names__')) live.tables.set('__names__', new Map());
      for (const name of tableNames) {
        if (!live.tables.has(name)) live.tables.set(name, new Map());
      }

      const table = (name) => {
        if (!live.tables.has(name)) throw new DomainError('missing-key', `unknown table ${name}`);
        const rows = live.tables.get(name);
        return {
          get(key) {
            return rows.get(key);
          },
          entries() {
            return rows.entries();
          },
          keys() {
            return rows.keys();
          },
          get size() {
            return rows.size;
          },
          async put(key, value) {
            // 模仿真实 `layout:'per-record'` JSON 后端的键约束：键会被当作**文件名**，
            // 只接受 `[A-Za-z0-9_-]`。真实后端原文：
            //   `per-record key 'probe4%2Fprobe4' is not path-safe (must match /^[a-zA-Z0-9_-]+$/)`
            // 因此 Host 必须在域边界做键编码；这里直接抛错，让"忽略 put 返回值"无处藏身。
            if (!/^[a-zA-Z0-9_-]+$/.test(String(key))) {
              backend.log.push({ op: 'put', name: spec.name, table: name, key: String(key), rejected: true, reason: 'not-path-safe' });
              throw new DomainError(
                'invalid-key',
                `per-record key '${key}' is not path-safe (must match /^[a-zA-Z0-9_-]+$/)`,
                { key: String(key) },
              );
            }
            if (backend.failNextWrites > 0) {
              backend.failNextWrites -= 1;
              backend.log.push({ op: 'put', name: spec.name, table: name, key, rejected: true });
              throw new DomainError('backend-unavailable', 'simulated backend write failure');
            }
            const stored = structuredClone(value);
            rows.set(key, stored);
            backend.writes += 1;
            stats.puts += 1;
            backend.log.push({ op: 'put', name: spec.name, table: name, key });
            const change = { domain: spec.name, table: name, key, operation: 'put', value: structuredClone(stored) };
            for (const listener of listeners.slice()) listener(change);
          },
          async delete(key) {
            if (backend.failNextWrites > 0) {
              backend.failNextWrites -= 1;
              throw new DomainError('backend-unavailable', 'simulated backend write failure');
            }
            const existed = rows.delete(key);
            backend.writes += 1;
            stats.deletes += 1;
            backend.log.push({ op: 'delete', name: spec.name, table: name, key });
            if (existed) {
              const change = { domain: spec.name, table: name, key, operation: 'deleted' };
              for (const listener of listeners.slice()) listener(change);
            }
            return existed;
          },
          async update(key, fn) {
            if (!rows.has(key)) throw new DomainError('missing-key', `${spec.name}/${name}/${key}`);
            const next = fn(rows.get(key));
            await this.put(key, next);
            return rows.get(key);
          },
        };
      };

      const handle = {
        name: spec.name,
        version: spec.version,
        table,
        get global() {
          return {
            get: () => live.global,
            set: async (value) => {
              if (backend.failNextWrites > 0) {
                backend.failNextWrites -= 1;
                throw new DomainError('backend-unavailable', 'simulated backend write failure');
              }
              live.global = structuredClone(value);
              stats.globals += 1;
              const change = { domain: spec.name, table: '', key: '', operation: 'put', value: structuredClone(live.global) };
              for (const listener of listeners.slice()) listener(change);
            },
          };
        },
        async close() {
          openNames.delete(spec.name);
          stats.closed += 1;
        },
      };
      openNames.set(spec.name, handle);
      return handle;
    },

    get(name) {
      return openNames.get(name);
    },

    async closeAll() {
      for (const handle of openNames.values()) await handle.close();
      openNames.clear();
    },

    /** KvUnit seam, for a storage layer that prefers it over `open()`. */
    kvUnit(name, spec = { version: 1 }) {
      const live = domainSlot(backend, name, spec);
      return {
        async loadAll() {
          const tables = {};
          for (const [tableName, rows] of live.tables.entries()) {
            if (tableName === '__names__') continue;
            tables[tableName] = Object.fromEntries(rows);
          }
          return { tables, global: live.global };
        },
        async putRecord(tableName, key, value) {
          if (!live.tables.has(tableName)) live.tables.set(tableName, new Map());
          live.tables.get(tableName).set(key, structuredClone(value));
          backend.writes += 1;
          stats.puts += 1;
        },
        async deleteRecord(tableName, key) {
          live.tables.get(tableName)?.delete(key);
          backend.writes += 1;
        },
        async setGlobal(value) {
          live.global = structuredClone(value);
          backend.writes += 1;
        },
        async close() {
          stats.closed += 1;
        },
      };
    },
  };

  return domain_facility;
}

export default createFakeStorageDomain;
