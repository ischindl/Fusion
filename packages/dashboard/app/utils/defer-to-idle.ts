/*
FNXC:IdleBoardReadCost 2026-11-18-09:25 (RUFU-479) — one place that says "ask later, not at first paint".

THE MEASURED PROBLEM is a queue-width problem, not a render problem: a cold board mount issued 63 requests
with 42 of them inside a single second, and the read queue is `MAX_CONCURRENT_READS = 4`. Chrome-level
counts (a stash-orphan badge that reads zero on almost every board, a notes list nobody has opened) were
taking two of those four slots while the board's own lane reads waited behind them, and a slow endpoint on
the same server held a slot for seconds (measured `/api/usage` at 61-82 s holding two of four slots).

This helper is the smallest honest instrument for that class: the read still happens, without a user action,
but after the first paint instead of inside the boot burst. It is deliberately NOT a cache, a TTL, or a way
to skip work - a badge that never arrived would be a wrong badge, and a count the operator can see missing is
better than one that silently never updates.

Why a helper rather than each hook reaching for `requestIdleCallback`: the fallback and the deadline are the
whole contract. An idle callback with no timeout starves behind a busy main thread, and `setTimeout(0)` in a
test environment is indistinguishable from synchronous, which is how a "deferred" read quietly becomes a boot
read again. Both are stated once, here.
*/

interface IdleWindow {
  requestIdleCallback?: (cb: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
}

/**
 * Schedule `run` after the browser's first paint work, with a bounded wait.
 *
 * `timeoutMs` bounds how long the read may be starved by a busy main thread: the deferral is a politeness,
 * never a permission slip for the data to arrive arbitrarily late. Returns a cancel that is safe to call
 * twice and after the run has fired.
 */
export function deferToIdle(run: () => void, options?: { timeoutMs?: number }): () => void {
  const timeoutMs = options?.timeoutMs ?? 2_000;
  const win = (typeof window !== "undefined" ? window : undefined) as (Window & IdleWindow) | undefined;
  let settled = false;
  let cancelled = false;
  let handle: number | undefined;
  const invoke = () => {
    if (cancelled || settled) return;
    settled = true;
    run();
  };

  if (win && typeof win.requestIdleCallback === "function") {
    handle = win.requestIdleCallback(invoke, { timeout: timeoutMs });
  } else {
    // The starvation bound belongs on the idle path, where a busy main thread is the reason for waiting.
    // On the fallback path the deadline is the ONLY reason the read would be late at all, so it defers by a
    // task, not by a duration: leaving the synchronous mount burst is the goal, and an arbitrary 200 ms of
    // its own would only make the data slower for no additional reason.
    handle = window.setTimeout(invoke, 0) as unknown as number;
  }

  return () => {
    cancelled = true;
    if (handle === undefined) return;
    if (win && typeof win.cancelIdleCallback === "function") {
      win.cancelIdleCallback(handle);
      return;
    }
    clearTimeout(handle);
  };
}
