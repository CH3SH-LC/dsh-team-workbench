/**
 * Structured test-suite harness.
 *
 * Every acceptance script prints exactly one JSON object to stdout, framed by
 * markers so a parent runner cannot be confused by stray Host output:
 *
 *   #DSH-SUITE-JSON#{"suite":"s02",...}#/DSH-SUITE-JSON#
 *
 * Human-readable progress goes to stderr. `acceptance/run-all.mjs` imports the
 * suites in-process (no child-process stdio), so it reads `run()` directly.
 */
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const JSON_OPEN = '#DSH-SUITE-JSON#';
export const JSON_CLOSE = '#/DSH-SUITE-JSON#';

/** Stable stringify used by deepEqual so key order never matters. */
export function stable(value) {
  return JSON.stringify(sort(value));
}

function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sort(value[key]);
    return out;
  }
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
  if (value === undefined) return '[undefined]';
  return value;
}

function brief(value, limit = 320) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(sort(value));
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * @param {{ id:string, title:string, acceptance?:string[], requires?:string[],
 *   simulated?:boolean, pending?:boolean, pendingReason?:string }} def
 */
export function createSuite(def) {
  const checks = [];
  const notes = [];
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  const suite = {
    id: def.id,
    title: def.title,
    acceptance: def.acceptance ?? [],
    requires: def.requires ?? [],
    /** true when the suite was driven by the local reference stub, not the real Host */
    simulated: Boolean(def.simulated),
    pending: Boolean(def.pending),
    pendingReason: def.pendingReason ?? null,
    checks,
    notes,
    startedAt,

    note(text) {
      notes.push(String(text));
      return text;
    },

    /** Low-level assertion. `detail` is kept verbatim in the JSON result. */
    check(name, ok, detail) {
      const entry = { name: String(name), ok: Boolean(ok) };
      if (detail !== undefined) entry.detail = sort(detail);
      checks.push(entry);
      if (entry.ok) {
        console.error(`  PASS  ${entry.name}`);
      } else {
        console.error(`  FAIL  ${entry.name}${detail !== undefined ? `  ${brief(detail)}` : ''}`);
      }
      return entry.ok;
    },

    assert(ok, name, detail) {
      return suite.check(name, ok, detail);
    },

    /** `actual === expected` with the observed value recorded on failure. */
    equal(actual, expected, name) {
      return suite.check(name, actual === expected, { expected, actual });
    },

    deepEqual(actual, expected, name) {
      const same = stable(actual) === stable(expected);
      return suite.check(name, same, same ? undefined : { expected, actual });
    },

    includes(haystack, needle, name) {
      const text = typeof haystack === 'string' ? haystack : JSON.stringify(sort(haystack));
      const found = text.includes(needle);
      return suite.check(name, found, found ? undefined : { needle, haystack: brief(text, 600) });
    },

    matches(value, regex, name) {
      const text = String(value ?? '');
      const found = regex.test(text);
      return suite.check(name, found, found ? undefined : { regex: String(regex), value: brief(text) });
    },

    /** Compare numbers/lengths without the suite author repeating boilerplate. */
    compare(actual, op, expected, name) {
      const a = actual;
      const ok =
        op === '<=' ? a <= expected
          : op === '>=' ? a >= expected
            : op === '<' ? a < expected
              : op === '>' ? a > expected
                : false;
      return suite.check(name, ok, ok ? undefined : { op, expected, actual: a });
    },

    fail(name, detail) {
      return suite.check(name, false, detail);
    },

    /** Await a promise and record success/failure as one check. */
    async attempt(name, fn, detailOnError) {
      try {
        const value = await fn();
        return suite.check(name, true, undefined) ? value : value;
      } catch (error) {
        return suite.check(name, false, { message: error?.message, code: error?.code, ...(detailOnError ?? {}) });
      }
    },

    result(bodyError) {
      const finishedAt = new Date().toISOString();
      const failures = checks.filter((entry) => !entry.ok);
      const status = suite.pending
        ? 'PENDING_HOST'
        : bodyError || failures.length > 0 || checks.length === 0
          ? 'FAIL'
          : 'PASS';
      return {
        suite: def.id,
        title: def.title,
        acceptance: suite.acceptance,
        requires: suite.requires,
        simulated: Boolean(def.simulated),
        status,
        ok: status === 'PASS',
        counts: { total: checks.length, passed: checks.length - failures.length, failed: failures.length },
        failures,
        notes,
        pendingReason: suite.pending ? suite.pendingReason : null,
        bodyError: bodyError
          ? { name: bodyError.name, message: bodyError.message, stack: String(bodyError.stack ?? '').split('\n').slice(0, 6) }
          : null,
        startedAt,
        finishedAt,
        durationMs: Date.now() - startMs,
      };
    },
  };

  return suite;
}

/**
 * Run one suite body and return its structured result.
 * @param {object} def
 * @param {(suite: ReturnType<typeof createSuite>) => unknown} body
 */
export async function runSuite(def, body) {
  const suite = createSuite(def);
  console.error(`\n=== ${def.id} :: ${def.title} ===`);
  if (suite.pending) {
    console.error(`  SKIP  ${suite.pendingReason ?? 'host module missing'}`);
    if (body) {
      // The body may still want to prove the harness itself works before we bail.
      try {
        await body(suite);
      } catch (error) {
        suite.fail('pending-suite body completed', { message: error?.message });
      }
    }
    return suite.result(undefined);
  }
  let bodyError;
  try {
    await body(suite);
  } catch (error) {
    bodyError = error;
    suite.fail('suite body completed without throwing', {
      message: error?.message,
      stack: String(error?.stack ?? '').split('\n').slice(0, 5),
    });
  }
  return suite.result(bodyError);
}

/** Print the framed JSON result to stdout (the machine-readable contract). */
export function emit(result) {
  process.stdout.write(`\n${JSON_OPEN}${JSON.stringify(result, null, 2)}${JSON_CLOSE}\n`);
}

/** True when this module is the process entry point. */
export function isMain(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return importMetaUrl === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

/**
 * Standard tail for every acceptance script:
 *   export const meta = {...}
 *   export async function run() { ... }
 *   if (isMain(import.meta.url)) main(run, meta)
 */
export async function main(run, meta) {
  const result = await run();
  emit(result);
  console.error(`--- ${result.suite}: ${result.status} (${result.counts.passed}/${result.counts.total}) ---`);
  process.exitCode = result.status === 'PASS' ? 0 : 1;
  return result;
}
