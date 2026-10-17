/**
 * Small dependency-free helpers shared by every Host module.
 *
 * Only `node:` builtins are allowed here: this plugin must load in profiles
 * where bare `@deepseek-ai/*` specifiers are not resolvable from the workspace
 * directory.
 */
import { createHash, randomUUID } from 'node:crypto';

/** Brand-free identity helper: the Host only ever compares ids as strings. */
export function asId(value) {
  return typeof value === 'string' ? value : String(value ?? '');
}

/**
 * Monotonic-ish wall clock. Injectable so deterministic tests can drive time.
 * @param {() => number} [source]
 */
export function createClock(source = () => Date.now()) {
  return {
    now: () => source(),
  };
}

/** System clock used in production. */
export const systemClock = createClock();

/**
 * Serialised critical section. Every state mutation of the workbench runtime
 * goes through exactly one of these, so a single Host process is the only
 * writer even when many asynchronous events arrive at once.
 *
 * The mutex deliberately never awaits a model call, network request or child
 * settlement inside `run()`.
 */
export function createMutex(label = 'state') {
  let tail = Promise.resolve();
  let depth = 0;
  return {
    get label() {
      return label;
    },
    /** True while a transaction body is executing. Used by diagnostics only. */
    get busy() {
      return depth > 0;
    },
    /**
     * @template T
     * @param {() => T | Promise<T>} operation
     * @returns {Promise<T>}
     */
    run(operation) {
      const result = tail.then(async () => {
        depth += 1;
        try {
          return await operation();
        } finally {
          depth -= 1;
        }
      });
      // Keep the chain alive even when one transaction rejects.
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

/** Random, collision-free identifier with a readable prefix. */
export function newId(prefix) {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** Short stable hash used for idempotency keys and evidence fingerprints. */
export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** Deterministic JSON with sorted object keys; used for CAS fingerprints. */
export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

/** JSON clone that never throws on cyclic input. */
export function safeClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

/** Bounded append-only buffer for operator diagnostics. */
export function createDiagnostics(limit = 200) {
  const entries = [];
  return {
    push(code, message, detail) {
      entries.push({ at: Date.now(), code: String(code), message: String(message ?? ''), detail: detail === undefined ? null : safeClone(detail) });
      while (entries.length > limit) entries.shift();
    },
    list() {
      return entries.slice();
    },
    clear() {
      entries.length = 0;
    },
  };
}

/**
 * Monotonic revision counter. Every accepted mutation of any entity bumps the
 * global revision; per-entity revisions come from the same source so a
 * compare-and-set over `(entity.revision, globalRevision)` is unambiguous.
 */
export function createRevisions(start = 0) {
  let value = start;
  return {
    current: () => value,
    next: () => {
      value += 1;
      return value;
    },
    /** Observe an externally restored revision (recovery) without regressing. */
    observe(candidate) {
      if (Number.isFinite(candidate) && candidate > value) value = candidate;
      return value;
    },
  };
}

/** Normalise an unknown value to a string array without throwing. */
export function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}

/** Clamp a number into an inclusive range, with a fallback for non-numbers. */
export function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/** Await with a deadline that never rejects; resolves to `{ timedOut }`. */
export function withTimeout(promise, ms) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([
    Promise.resolve(promise).then(
      (value) => ({ timedOut: false, value }),
      (error) => ({ timedOut: false, error }),
    ),
    guard,
  ]).finally(() => clearTimeout(timer));
}

/** True when `text` contains any of the needles (case-insensitive). */
export function containsAny(text, needles) {
  const haystack = String(text ?? '').toLowerCase();
  return needles.some((needle) => haystack.includes(String(needle).toLowerCase()));
}

/**
 * 归一化一个写入范围：统一分隔符、去掉首尾斜杠、Windows 下大小写不敏感。
 * 原生 Team 的 `writeScopes` 只是**提醒**，本插件自己用它们做互斥调度，
 * 因此归一化规则必须在插件里唯一且可测。
 */
export function normalizeScope(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!text) return null;
  if (text.endsWith('/')) text = text.slice(0, -1);
  if (!text) return null;
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

function scopeCovers(scope, other) {
  if (scope === other) return true;
  // 目录范围覆盖其下所有内容；文件范围不覆盖兄弟文件。
  return other.startsWith(`${scope}/`) || scope.startsWith(`${other}/`);
}

/** 两组写入范围是否冲突（任一元素相互覆盖即冲突）。 */
export function scopeConflict(left, right) {
  const a = (Array.isArray(left) ? left : []).map(normalizeScope).filter(Boolean);
  const b = (Array.isArray(right) ? right : []).map(normalizeScope).filter(Boolean);
  const hits = [];
  for (const one of a) {
    for (const other of b) {
      if (scopeCovers(one, other)) hits.push(one === other ? one : `${one} ↔ ${other}`);
    }
  }
  return [...new Set(hits)];
}

/** 一组范围与一组"已持有"范围是否冲突。 */
export function conflictsWithHolders(scopes, holders) {
  const hits = [];
  for (const holder of holders ?? []) {
    const overlap = scopeConflict(scopes, holder.scopes);
    if (overlap.length > 0) hits.push({ workId: holder.workId, attemptId: holder.attemptId, overlap });
  }
  return hits;
}

/** Count occurrences of every needle; returned keys keep the original spelling. */
export function countHits(text, needles) {
  const haystack = String(text ?? '').toLowerCase();
  const hits = {};
  for (const needle of needles) {
    const lowered = String(needle).toLowerCase();
    let index = 0;
    let count = 0;
    for (;;) {
      const found = haystack.indexOf(lowered, index);
      if (found < 0) break;
      count += 1;
      index = found + lowered.length;
    }
    if (count > 0) hits[needle] = count;
  }
  return hits;
}
