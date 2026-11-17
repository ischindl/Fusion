/*
FNXC:UnclaimedGraphWork 2026-11-17-01:05 (RUFU-1050):
A one-value in-process memo: when the planning-continuation drain last made progress. It exists so a
release surface can answer truthfully about a card it is refusing.

The question this answers is narrow and load-bearing. A card refused at the execution gate with an
armed Plan Review continuation gets the sentence "Plan Review is already queued for this card and
will run". Whether that is true depends entirely on whether the drain that consumes the row is
actually running, and nothing outside the runtime knows that. The runtime already measures it for its
own pump watchdog (`workflowContinuationDrainProgressAt` in `runtimes/in-process-runtime.ts`); this
module is the read side of that same measurement, exported because `execution/hold-release.ts` cannot
reach a private field of a class it does not own.

Absence is deliberately NOT read as "stalled". A process that never recorded a drain pass may simply
be a process that does not run the drain (a CLI one-shot, a narrow test harness), and treating that as
proof would rewrite the release sentence for every caller that has never had a pump. Unobserved means
"no evidence either way", which is the same answer the seam gave before this measurement existed.
*/

let lastProgressAtMs = 0;

/** Record that a planning-continuation drain pass made progress. Called from the runtime's own mark. */
export function notePlanningContinuationDrainProgress(atMs: number = Date.now()): void {
  if (Number.isFinite(atMs) && atMs > 0) lastProgressAtMs = atMs;
}

/** Age of the last recorded drain progress, or null when this process has never observed one. */
export function planningContinuationDrainProgressAgeMs(now: number = Date.now()): number | null {
  if (lastProgressAtMs <= 0) return null;
  return Math.max(0, now - lastProgressAtMs);
}

/** Test seam: forget the observation so a harness can assert the unobserved default. */
export function resetPlanningContinuationDrainProgress(): void {
  lastProgressAtMs = 0;
}
