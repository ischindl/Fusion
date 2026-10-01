/**
 * FNXC:CodeOrganization 2026-08-03-13:10:
 * Tiny pure TaskExecutor predicates peeled from executor.ts (U4).
 * No instance state; re-exported from the facade for call-site stability.
 */
import type { Task } from "@fusion/core";
import { MERGE_BOUNDARY_UNPROVEN_VALUE } from "../workflows/workflow-merge-nodes.js";

/** True when every step is done or skipped (and at least one step exists). */
export function isTaskWorkComplete(task: Task): boolean {
  if (task.steps.length === 0) return false;
  return task.steps.every((s) => s.status === "done" || s.status === "skipped");
}

/*
FNXC:WorkflowExecutionOwnership 2026-09-15-22:51 (RUFU-237):
True when the row is a CLEAN completed handoff that already sits in the workflow's resolved review
lane — the shape the generic graph-failure sink must honor instead of terminalizing.

Why this classifier exists (sighting RUFU-217, 2026-09-14): `fn_task_done` succeeded and the row
moved to review at 16:28:44Z; ~90 s later the SAME graph dispatch's session tail resolved a
`failed` disposition (the execute seam collapses out-of-band exits — e.g.
`review-handoff-paused-after-completion` — to `taskDone:false`), and the generic sink overwrote the
delivered row with "Workflow graph terminated with failure at node 'steps#0:step-execute'". No
run-context fence can catch that shape: the stale failure belongs to the run that owns the row's
execution context (capturedRunId == currentRunId), `capturedColumnMovedAt` is captured after the
handoff already moved the row, and `hasLiveTaskSessionSurface` is false once the session ended. Only
a live-row predicate can (see task document `race-source`).

Clause rationale (each maps to a spec row state):
- `deletedAt` / `status != null` / `error != null` → refuse: soft-deleted rows are not delivered
  work, and a row already carrying an ending (including the FN-8141 honest `BLOCKED:` park, which
  always sets `error`) stays owned by the classifier that wrote that ending.
- `userPaused !== true` (NOT bare `paused`) → refuse operator holds only. A lingering `paused: true`
  with `userPaused` unset must still honor the handoff — the FN-6648 precedent: the
  paused-after-completion handoff leaves exactly that residue, and engine/system pause is transient
  while the row itself is already delivered.
- `task.column === reviewColumn` → the row must physically sit in the review lane RESOLVED from its
  own workflow (`resolveResumeLanes`'s `review`), never a hardcoded `"in-review"` literal, so
  renamed boards (`waiting`, …) are honored and WIP/hold-lane rows still terminalize. An unresolved
  lane (`undefined`) REFUSES — not knowing the lane must never widen the classifier.
- `isTaskWorkComplete` → every step done/skipped (≥1 step); a half-executed card in review (e.g.
  moved by hand) is not a completed handoff.

Deliberately NO `columnMovedAt` requirement: the invariant is keyed on the observable row state
(lane + completion + clean), not on the provenance stamp of the move — a legitimate placement into
the review lane that never went through the stamping `moveTask` path must still be honored, and the
spec's reproduction fixture carries no stamp. Regression non-vacuity is instead owned by the
control cases in the RUFU-237 tests (incomplete steps / non-null status / non-review lane must all
still terminalize).

Why this is NOT the sink's local `alreadyFinalizedToReview` (`handle-graph-failure.ts`): that one is
completion-finalize-provenance-specific — it additionally requires `persistedCompletionFinalizeLog`
and is gated on the pause-abort path — while this is the sink's lane-based check with no log
provenance requirement.

Ordering constraint: `isTaskWorkComplete` reads `task.steps` only — it cannot see UNRUN workflow
gates (a required pre-merge approval with no result row looks "complete" here). That is exactly why
this predicate must never be consulted ahead of the FN-9243 unrun-gate reroute, the RUFU-217
verdict-less re-run, or the remediation producers; it is the last classifier before the terminal
write, not a shortcut around the review-lane block.
*/
export function isHandedOffAndWorkComplete(
  task: Task,
  reviewColumn: string | undefined,
): boolean {
  return !task.deletedAt
    && task.status == null
    && task.error == null
    && task.userPaused !== true
    && reviewColumn !== undefined
    && task.column === reviewColumn
    && isTaskWorkComplete(task);
}

/** Failed with "without calling fn_task_done" and zero step progress. */
export function isNoProgressNoTaskDoneFailure(task: Task): boolean {
  return task.status === "failed" &&
    task.error?.includes("without calling fn_task_done") === true &&
    task.steps.every((step) => step.status === "pending");
}

export function createSeenSteeringIds(task: {
  comments?: Array<{ id: string }>;
  steeringComments?: Array<{ id: string }>;
}): Set<string> {
  const seenSteeringIds = new Set<string>();
  for (const comment of task.steeringComments ?? task.comments ?? []) {
    seenSteeringIds.add(comment.id);
  }
  return seenSteeringIds;
}

export function createConfiguredCommandAbortError(taskId: string, command: string): Error {
  const error = new Error(`Configured command aborted for ${taskId}: ${command}`);
  error.name = "AbortError";
  return error;
}

/** Composite key for graph-owned per-instance state: never share parallel foreach instances. */
export function graphActiveContextKey(taskId: string, instanceId: string): string {
  return `${taskId}:${instanceId}`;
}

export function isRetryableMergePauseAbortStatus(status: string | null | undefined): boolean {
  /*
  FNXC:WorkflowMerge 2026-07-01-22:05:
  FN-7335 surfaced a merge-node pause/resume abort while the row was legitimately `in-review` with status="reviewing" from the AI merge reviewer. That status is merge activity, not a pre-existing terminal failure; keep the retry classifier strict on real errors while allowing transient merge/review statuses to re-enter bounded merge retry.
  */
  return status == null || status === "reviewing" || status === "merging" || status === "merging-pr";
}

export function isTerminalMergeGraphFailureValue(value: string | undefined): boolean {
  if (!value) return false;
  if (value === MERGE_BOUNDARY_UNPROVEN_VALUE) return true;
  const normalized = value.toLowerCase();
  return normalized.includes("conflict")
    || normalized.includes("contamination")
    || normalized.includes("foreign")
    || normalized.includes("retry-exhausted")
    || normalized.includes("retries exhausted")
    || normalized.includes("max retries");
}

export function isAwaitingGraphFailureValue(
  value: string | undefined,
): value is "awaiting-user-input" | "awaiting-cli-approval" {
  return value === "awaiting-user-input" || value === "awaiting-cli-approval";
}
