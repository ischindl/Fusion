import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";

/*
FNXC:DiffLaneCancellation 2026-11-18-10:05 (RUFU-479) — a diff read stops costing the moment nobody wants it.

THE MEASURED PROBLEM: the diff lane answers with git subprocesses, and it answers SLOWLY on the deployed node
(one done card whose worktree was gone took 19.96 s and 28.35 s back to back). Before this change a client
that gave up — the operator switched card, closed the Changes tab, the component unmounted — stopped WAITING
but did not stop the work: the subprocess ran to completion, in a lane the whole single-process dashboard
shares.

Why an AsyncLocalStorage rather than threading an `AbortSignal` parameter: the lane reaches git through one
function (`runGitCommand` in ./resolve-diff-base.js) from deep inside helpers shared by several routes and by
the workspace/done/active branches (`runNumstatCounts`, `collectDoneTaskFiles`, `computeWorkspaceTaskFiles`).
A parameter would mean editing every signature between the handler and the spawn, and the next helper added
to that call graph would silently be uncancellable. The store makes cancellation a property of the REQUEST,
so every git call made while handling it is cancellable by construction — including ones added later.

SCOPE IS DELIBERATELY NARROW: this is mounted on `/tasks/:id/file-diffs` only. The `?stats=1` lane of
`/tasks/:id/diff` runs its computation inside a single-flight rendezvous (`taskDiffStatsInFlight`), where the
first request's subprocess answers EVERY joined waiter — aborting the owner because one client navigated away
would fail strangers. A shared computation is not this request's to cancel; a per-request patch fan-out is.
*/

const diffRequestSignalStore = new AsyncLocalStorage<AbortSignal>();

/** The signal of the diff request currently being handled, or undefined outside a cancellable request. */
export function currentDiffRequestSignal(): AbortSignal | undefined {
  return diffRequestSignalStore.getStore();
}

/**
 * Express middleware that opens a cancellable scope for the routes it guards.
 *
 * It is middleware rather than a handler-wrapping helper, and that is a typing fact rather than a style
 * choice: a `with…(handler)` helper makes the inline handler an ARGUMENT whose `req.params` is typed by the
 * helper's own generic, which collapses express's path-derived narrowing (`/tasks/:id` -> `params.id:
 * string`) back to `string | string[]`. Mounted as route middleware, every guarded handler keeps its
 * route-typed params.
 *
 * `store.run(signal, next)` covers the whole downstream chain because AsyncLocalStorage propagates through
 * the synchronous call stack express walks and through the async continuations that follow it — precisely
 * the reach a hand-threaded parameter would have had to achieve by editing every signature in between.
 *
 * The `close` listener is removed once the response is over instead of staying attached: a keep-alive
 * socket is reused by later requests, and a listener registered per request and never removed is how this
 * lane accumulated listeners per poll cycle.
 */
export const diffRequestCancellation: RequestHandler = (req, res, next) => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once("close", abort);
  const detach = () => req.removeListener("close", abort);
  res.once("finish", detach);
  // A response that errors without finishing must still not leave the listener attached.
  res.once("close", detach);
  diffRequestSignalStore.run(controller.signal, next);
};
