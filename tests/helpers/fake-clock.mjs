/**
 * Deterministic injectable clock.
 *
 * The Host modules take `{ clock }` and may only read `clock.now()`. This file
 * additionally provides a virtual timer queue so a *stub or reference* host can
 * coalesce wakeups without touching real `setTimeout` (real timers would make
 * the acceptance scripts non-deterministic and flaky).
 *
 * Nothing here imports `@deepseek-ai/*`: the whole test tree must run with
 * plain `node tests/xxx.mjs`.
 */

/** Default virtual epoch: 2026-01-01T00:00:00Z, chosen so ISO strings are obvious. */
export const FAKE_EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);

/**
 * @param {number} [start] initial virtual milliseconds
 */
export function createFakeClock(start = FAKE_EPOCH) {
  let current = Number(start);
  /** @type {{ at: number, seq: number, fn: Function, cancelled: boolean }[]} */
  let timers = [];
  let seq = 0;
  let microtaskDepth = 0;

  function dueTimers(target) {
    return timers
      .filter((timer) => !timer.cancelled && timer.at <= target)
      .sort((a, b) => a.at - b.at || a.seq - b.seq);
  }

  const clock = {
    /** Host contract: the only method the adapter/scheduler may rely on. */
    now() {
      return current;
    },
    /** Alias kept for readability inside tests. */
    get current() {
      return current;
    },
    get epoch() {
      return start;
    },
    /** Virtual timers. Not used by the real Host (which must coalesce on microtasks). */
    setTimeout(fn, delay = 0) {
      const timer = { at: current + Math.max(0, Number(delay) || 0), seq: seq++, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    clearTimeout(handle) {
      if (typeof handle === 'function') handle();
    },
    /** Run every timer due at or before `current + ms`, in deterministic order. */
    advance(ms) {
      const target = current + Math.max(0, Number(ms) || 0);
      for (;;) {
        const next = dueTimers(target)[0];
        if (!next) break;
        next.cancelled = true;
        current = next.at;
        try {
          next.fn();
        } catch {
          /* a virtual timer callback must never break the drive loop */
        }
      }
      current = target;
      timers = timers.filter((timer) => !timer.cancelled);
      return current;
    },
    /** Jump forward without running any pending timer. */
    jump(ms) {
      current += Math.max(0, Number(ms) || 0);
      return current;
    },
    set(ms) {
      current = Number(ms);
      return current;
    },
    pendingTimers() {
      return timers.filter((timer) => !timer.cancelled).length;
    },
    iso(ms = current) {
      return new Date(ms).toISOString();
    },
    /**
     * Let already-queued microtasks settle. `await clock.flush()` is the
     * deterministic replacement for `await sleep(0)`.
     */
    async flush(rounds = 8) {
      for (let index = 0; index < rounds; index += 1) {
        microtaskDepth += 1;
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
      return microtaskDepth;
    },
  };

  return clock;
}

/** Convenience: run `fn` and return `{ value, error }` without throwing. */
export async function capture(fn) {
  try {
    return { value: await fn(), error: undefined };
  } catch (error) {
    return { value: undefined, error };
  }
}

export default createFakeClock;
