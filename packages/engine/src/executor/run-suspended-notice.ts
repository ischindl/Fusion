import type { Logger } from "../logger.js";
import { createRepeatSuppressedLog } from "../util/repeat-suppressed-log.js";

/*
FNXC:RunSuspendedAuditBackoff 2026-10-07-09:10 (RUFU-442):
A suspended graph run is a WAIT, not an event. The scheduler re-dispatches the same continuation on
every pass, so a card parked at a capacity seam wrote one full `task:workflow-run-suspended` audit row
AND one `log()` line per re-dispatch. Measured: one `todo` card wrote 108 rows in ~45 min (2.4/min),
and the fleet monitor's `capacity_suspends` is `count(*)` over those rows — so 40 → 105 measured one
card talking to itself, not board pressure. Field sample on 2026-10-07: 176 suspensions in 45 min
across 6 saneca cards at node `parse`, with the engine at 0 leases.

The refusal is legitimate (the running-agent cap is genuinely saturated) and the row's metadata is
already complete; only the repetition is wrong. This module makes the pair — the audit row and its
log line — fire on the TRANSITION only, reusing the shared `createRepeatSuppressedLog` primitive
rather than inventing a second suppression keyspace.

The signature deliberately includes the continuation identity and state, because those are the two
fields that distinguish "still the same wait" from "a new wait": a re-seed installs a new
continuation, and a continuation that moved node/state is a different condition an operator needs to
see. A row is therefore still emitted once per (card, node, reason, boundary, continuation) — which
is what the monitor should be counting — and repeats collapse to `debug()`.
*/

/** Per-card keyspace: one remembered signature per card, cleared when its run stops being suspended. */
const runSuspendedNotice = createRepeatSuppressedLog();

export interface RunSuspendedNoticeInput {
  nodeId: string;
  reason: string;
  fromColumn: string | null;
  toColumn: string | null;
  continuationId: string | null;
  continuationNodeId: string | null;
  continuationState: string | null;
}

/**
 * The one signature shape for a suspended run. Built here (not at the call site) so the audit row and
 * the log line can never disagree about what "the same wait" means.
 */
export function runSuspendedNoticeSignature(input: RunSuspendedNoticeInput): string {
  return [
    input.nodeId,
    input.reason,
    `${input.fromColumn ?? "-"}->${input.toColumn ?? "-"}`,
    input.continuationId ?? "-",
    input.continuationState ?? "-",
    // The continuation's own node is part of the identity: a wait re-seeded onto a different node is
    // a new condition even when the suspension carries the previous node's fields.
    input.continuationNodeId ?? "-",
  ].join("|");
}

/**
 * Report a suspended graph run.
 *
 * @returns `true` on the first observation of `signature` for `taskId` (or after it changed) — the
 * caller must then write the audit row. `false` means this is the same wait again: the line was
 * dropped to `debug()` and no audit row may be written.
 */
export function noteWorkflowRunSuspended(
  logger: Logger,
  taskId: string,
  signature: string,
  message: string,
): boolean {
  return runSuspendedNotice.logOnce(logger, taskId, signature, message);
}

/** Forget a card's last suspension so a later wait is reported afresh. */
export function clearWorkflowRunSuspendedNotice(taskId: string): void {
  runSuspendedNotice.clear(taskId);
}

/** Test-only: drop all remembered suspensions. */
export function resetWorkflowRunSuspendedNoticeState(): void {
  runSuspendedNotice.reset();
}
