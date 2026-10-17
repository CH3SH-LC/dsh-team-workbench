/**
 * `storage-fallback.js` — 当 `storageDomain.open()` 不可用时的**降级但持久**的后端。
 *
 * 为什么需要：`storageDomain` 是首选（也是需求指定的 sidecar），但它的 `open()` 会因
 * 版本不匹配、后端未路由、记录 schema 校验失败等原因整块失败，而本插件不能因此丢掉
 * attempt / lease / 幂等回执这些必须持久的事实。这里的实现与 `Domain` 的使用面**完全同形**
 * （`table(name)` → get/entries/put/delete/update/keys/size，`global` → get/set，`close()`），
 * 所以 `storage.js` 不需要分支。
 *
 * 持久性：每个表一个 JSON 文件，写入走 临时文件 + fsync + 原子 rename。
 * 目录：`$DSH_TEAM_WORKBENCH_DIR`，否则 `<$DSH_HOME | ~/.dsh>/team-workbench`。
 */
import { mkdir, readFile, rename, writeFile, open as openFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveDataDir() {
  const explicit = process.env.DSH_TEAM_WORKBENCH_DIR;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const home = process.env.DSH_HOME;
  if (typeof home === 'string' && home.trim()) return join(home.trim(), 'team-workbench');
  return join(homedir(), '.dsh', 'team-workbench');
}

async function readJson(path, fallbackValue) {
  try {
    const text = await readFile(path, 'utf8');
    if (!text.trim()) return fallbackValue;
    return JSON.parse(text);
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallbackValue;
    throw error;
  }
}

/** 原子写：临时文件 → fsync → rename，避免半写文件被当成有效状态读回。 */
async function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const text = JSON.stringify(value);
  await writeFile(tmp, text, 'utf8');
  const handle = await openFile(tmp, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

/**
 * @param {{ rootDir?: string, tables: readonly string[], logger?: (code: string, message: string) => void }} options
 */
export function createFallbackDomain(options) {
  const rootDir = options.rootDir ?? resolveDataDir();
  const tableNames = Array.from(options.tables ?? []);
  const logger = options.logger ?? (() => {});
  const dirFor = (name) => join(rootDir, `${name}.json`);
  const loaded = new Map();
  const pending = new Map();

  async function ensure(name) {
    if (loaded.has(name)) return loaded.get(name);
    if (!pending.has(name)) {
      pending.set(
        name,
        (async () => {
          await mkdir(rootDir, { recursive: true, mode: 0o700 });
          const value = await readJson(dirFor(name), {});
          const map = new Map(Object.entries(value && typeof value === 'object' ? value : {}));
          loaded.set(name, map);
          return map;
        })(),
      );
    }
    return pending.get(name);
  }

  async function flush(name) {
    const map = loaded.get(name);
    if (!map) return;
    await writeJsonAtomic(dirFor(name), Object.fromEntries(map));
  }

  const tableHandle = (name) => ({
    get: (key) => loaded.get(name)?.get(key),
    entries: () => (loaded.get(name) ?? new Map()).entries(),
    keys: () => (loaded.get(name) ?? new Map()).keys(),
    get size() {
      return loaded.get(name)?.size ?? 0;
    },
    async put(key, value) {
      await ensure(name);
      loaded.get(name).set(key, JSON.parse(JSON.stringify(value)));
      await flush(name);
    },
    async delete(key) {
      await ensure(name);
      const removed = loaded.get(name).delete(key);
      await flush(name);
      return removed;
    },
    async update(key, fn) {
      await ensure(name);
      const next = fn(loaded.get(name).get(key));
      loaded.get(name).set(key, next);
      await flush(name);
      return next;
    },
  });

  let globalLoaded = false;
  let globalValue = null;

  return {
    name: 'team_workbench_fallback',
    backend: 'json-files',
    rootDir,
    async init() {
      await mkdir(rootDir, { recursive: true, mode: 0o700 });
      for (const name of tableNames) await ensure(name);
      try {
        globalValue = await readJson(join(rootDir, 'global.json'), null);
      } catch (error) {
        logger('storage:fallback-global-read-failed', String(error?.message ?? error));
        globalValue = null;
      }
      globalLoaded = true;
      return { rootDir, tables: tableNames };
    },
    table(name) {
      if (!tableNames.includes(name)) throw new Error(`fallback domain has no table ${name}`);
      return tableHandle(name);
    },
    global: {
      get: () => globalValue,
      async set(value) {
        globalValue = JSON.parse(JSON.stringify(value));
        if (!globalLoaded) await mkdir(rootDir, { recursive: true, mode: 0o700 });
        await writeJsonAtomic(join(rootDir, 'global.json'), globalValue);
      },
    },
    async close() {
      for (const name of tableNames) await flush(name);
    },
  };
}
