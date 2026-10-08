import type { Logger } from "../logger.js";

/*
FNXC:RunSuspendedAuditBackoff 2026-10-07-09:10 (RUFU-442):
A suspended graph run is a WAIT, not an event. The scheduler re-dispatches the same continuation on
every pass, so a card parked at a capacity seam wrote one full `task:workflow-run-suspended` audit row
AND one `log()` line per re-dispatch. Measured: one `todo` card wrote 108 rows in ~45 min (2.4/min), and
the fleet monitor's `capacity_suspends` is `count(*)` over those rows — so 40 → 105 measured one card
talking to itself, not board pressure.

The refusal is legitimate (the running-agent cap is genuinely saturated) and the row's metadata is
already complete; only the repetition is wrong.

FNXC:RunSuspendedAuditBackoff 2026-10-07-18:40 (RUFU-442 follow-up, measured after deploying the first cut):
Keying on state transitions alone did NOT bound this loop, and the deployed build proves it: SANE-556
recorded 7 rows for the SAME `(task, node='parse', reason='capacity')` inside 4 distinct minutes. Two
independent reasons, both mine:

1. The signature included the continuation identity (`continuationId`, `continuationState`,
   `continuationNodeId`). In a re-dispatch loop those fields change BY CONSTRUCTION — the scheduler
   installs a fresh continuation row each pass — so every cycle looked like a new wait. A signature may
   only contain fields that are stable for the duration of the thing being counted.
2. `clear()` ran on every non-suspended disposition. A capacity loop alternates suspend → non-suspend
   dispositions, so the remembered signature was erased between cycles and the next identical wait
   re-reported. A bound that its own caller wipes is not a bound.

So the signature is now the durable wait identity only — node, reason, column boundary — and the bound
is a time floor rather than a state memory. A changed signature still reports IMMEDIATELY (a new node,
a new reason, a new boundary is a new condition an operator must see without delay); an identical
signature reports at most once per `SUSPEND_NOTICE_WINDOW_MS`. Repeated identical waits therefore cost
~12 rows/hour/card instead of ~105, while the row itself is unchanged and complete.
*/

/** Minimum spacing between two audit rows for one card's identical wait. */
export const SUSPEND_NOTICE_WINDOW_MS = 5 * 60_000;

/** Per-card: the last wait that was reported at full level, and when. */
const lastNoticeByKey = new Map<string, { signature: string; recordedAt: number }>();

export interface RunSuspendedNoticeInput {
  nodeId: string;
  reason: string;
  fromColumn: string | null;
  toColumn: string | null;
  /**
   * ACCEPTED AND DELIBERATELY IGNORED. A caller that already has the continuation in hand may pass it,
   * and keeping the fields in the type is what lets a test pin the invariant that broke the first cut:
   * varying continuation identity must not change the signature. Do not start using them in the signature.
   */
  continuationId?: string | null;
  continuationNodeId?: string | null;
  continuationState?: string | null;
}

/**
 * The one signature shape for a suspended run: the fields that are STABLE while a card keeps waiting.
 *
 * Deliberately excluded: continuation id/state/node. Those churn on every re-dispatch, and including
 * them made each cycle of a capacity loop look like a first-time wait (measured 2026-10-07 above).
 */
export function runSuspendedNoticeSignature(input: RunSuspendedNoticeInput): string {
  return [input.nodeId, input.reason, `${input.fromColumn ?? "-"}->${input.toColumn ?? "-"}`].join("|");
}

/**
 * Report a suspended graph run.
 *
 * @returns `true` when the caller must write the audit row — either the signature changed, or the
 * window elapsed on an unchanged one. `false` means the same wait again: the line dropped to
 * `debug()` and no audit row may be written.
 */
export function noteWorkflowRunSuspended(
  logger: Logger,
  taskId: string,
  signature: string,
  message: string,
  now: number = Date.now(),
): boolean {
  const previous = lastNoticeByKey.get(taskId);
  if (previous && previous.signature === signature && now - previous.recordedAt < SUSPEND_NOTICE_WINDOW_MS) {
    logger.debug(message);
    return false;
  }
  lastNoticeByKey.set(taskId, { signature, recordedAt: now });
  logger.log(message);
  return true;
}

/** Drop all remembered waits (engine stop / tests). */
export function resetWorkflowRunSuspendedNoticeState(): void {
  lastNoticeByKey.clear();
}
