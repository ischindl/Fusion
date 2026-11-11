import { isStaleContentApprovalBlocker, STALE_CONTENT_APPROVAL_BLOCKER, type Task } from "@fusion/core";
/*
FNXC:StaleContentParkAdmission 2026-10-09-20:04 (RUFU-343):
Candidacy is provenance-aware, so this module consumes the canonical engine-park predicate rather
than a local pause rule. The import is deliberately one-directional in behaviour even though
`pre-merge-gate-reseed.ts` imports `AUTO_MERGE_RETRY_REJECTED_PREFIX` from here: neither module
reads the other's binding during evaluation, only inside functions, so the ESM cycle stays inert.
*/
import { isEngineAuthoredInReviewStallPark } from "./pre-merge-gate-reseed.js";

export const AUTO_MERGE_RETRY_REJECTED_PREFIX = "AUTO_MERGE_RETRY_REJECTED:";

/*
FNXC:StaleContentParkShape 2026-10-09-20:04 (RUFU-343):
The fourth value names the machine's OWN park. `task:merge-stale-content-review-rerouted` reports
`parkShape` from this union, and a stalled park reports itself: its error is a container written by
the stall watchdog, so a shape read out of that container's embedded `AUTO_MERGE_RETRY_REJECTED:`
marker would attribute the card to a merge-retry terminal that never wrote the row.
*/
export type StaleContentParkShape = "retry-rejected" | "retry-exhausted" | "raw-blocker" | "stall-deadlock";

export type StaleContentParkTask = Pick<Task, "status" | "paused" | "userPaused" | "deletedAt"> & {
  error?: unknown;
  pausedReason?: string | null;
};

/**
 * FNXC:StaleContentParkShape 2026-09-05-23:08:
 * FN-295: a hidden stale-content park is recorded as a terminal failure by some auto-merge paths
 * (`status:'failed'` plus an `AUTO_MERGE_RETRY_REJECTED:` rejection) and left live by others
 * (`status:null` after the retry budget is spent). Report which shape self-healing is clearing so
 * `task:merge-stale-content-review-rerouted` can distinguish which terminal wrote the park.
 *
 * FNXC:StaleContentParkAdmission 2026-10-09-20:04 (RUFU-343):
 * A stale-content failure wrapped by the engine's own review-stall deadlock park used to be
 * mis-shaped here. The classifier decided the failed shape with
 * `task.error.startsWith(AUTO_MERGE_RETRY_REJECTED_PREFIX)`, but the stall watchdog prefixes its
 * own sentence in front of the merged refusal — `isStaleContentApprovalBlocker` still matches the
 * wrapped form (it ends with the stale-content sentence), while `startsWith` could not see the
 * marker at all and reported the park as `raw-blocker`. The scan is therefore positional: the
 * FIRST embedded approval marker in the error decides the shape, exactly like the door's
 * `endsWith` tolerance, so a wrapped `AUTO_MERGE_RETRY_REJECTED:` is never mistaken for a raw
 * blocker. Only an embedded stale-content marker ahead of any retry marker stays a raw blocker.
 */
function failedParkShape(error: string): "retry-rejected" | "raw-blocker" {
  const retryMarkerIndex = error.indexOf(AUTO_MERGE_RETRY_REJECTED_PREFIX);
  const staleMarkerIndex = error.indexOf(STALE_CONTENT_APPROVAL_BLOCKER);
  return retryMarkerIndex !== -1 && retryMarkerIndex < staleMarkerIndex ? "retry-rejected" : "raw-blocker";
}

/**
 * FNXC:StaleContentParkAdmission 2026-10-09-20:04 (RUFU-343):
 * Narrow the deliberately loose classifier input to the four facts the canonical predicate reads.
 * `error?: unknown` exists so a malformed row (a numeric `error`) is classifiable as the non-park it
 * is; the predicate only ever sees a real sentence or none.
 */
function isEngineStallDeadlockPark(task: StaleContentParkTask): boolean {
  return isEngineAuthoredInReviewStallPark({
    paused: task.paused === true,
    userPaused: task.userPaused === true,
    pausedReason: task.pausedReason ?? undefined,
    error: typeof task.error === "string" ? task.error : undefined,
  });
}

/** Classify one stale-content park terminal: retry-rejected, retry-exhausted, raw-blocker, or the engine's own stall park. */
export function classifyStaleContentPark(task: StaleContentParkTask): StaleContentParkShape | undefined {
  /*
  FNXC:StaleContentParkAdmission 2026-10-09-20:04 (RUFU-343):
  The bare `task.paused` veto made this recovery blind to the one refusal it exists to repair. The
  stall watchdog terminalises a doomed auto-merge retry with `status:"failed"` and the merged refusal
  sentence, THEN parks the card with `pausedReason:"in-review-stall-deadlock"` — so every
  stale-content-parked card was excluded by the very pause the refusal had just written, and a card
  whose review approval is provably bound to OLD content was the one shape guaranteed to reach that
  deadlock and sit there. Measured on RUFU-301 (artifact 478f5c47, 2026-10-04): the parked card's
  approval fingerprint equals `git diff --binary <base>..<tip>`, i.e. the review IS current, and the
  only thing standing between it and the merge was a park recovery could have cleared.

  Provenance, not pause state, is the discriminator: `userPaused` and any OTHER named pause stay
  hard refusals because they are operator consent, and `deletedAt` stays excluded so a soft-deleted
  card is never un-parked back into existence. The engine-authored deadlock park is not consent —
  it is the engine's own record that it stopped retrying, and this lane owns undoing it.
  */
  if (task.userPaused === true || task.deletedAt) return undefined;
  if (task.paused === true && !isEngineStallDeadlockPark(task)) return undefined;
  if (typeof task.error !== "string" || !isStaleContentApprovalBlocker(task.error)) return undefined;
  /*
  FNXC:StaleContentParkShape 2026-10-09-20:04 (RUFU-343):
  A canonical stall park reports its own provenance rather than the marker its container happens to
  embed: the container's wording belongs to the watchdog, not to a merge-retry terminal.
  */
  if (isEngineStallDeadlockPark(task)) return "stall-deadlock";
  if (task.status === "failed") return failedParkShape(task.error);
  return task.status == null ? "retry-exhausted" : undefined;
}
