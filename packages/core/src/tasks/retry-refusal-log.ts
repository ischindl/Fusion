/*
FNXC:ApprovalDestroyingRetry 2026-11-14-02:10 (RUFU-599 Step 7, reproduction 4 / RUFU-474):
A REFUSED RETRY LEAVES NO TRACE UNTIL THIS MODULE EXISTS. Every Retry surface answers the refusal from the
same classifier (`classifyApprovalDestroyingRetry`) and then returns or throws, so the CARD kept showing only
the reviewer's stale `REVISE` line while an operator had already pressed Retry and been refused. That is the
same narration gap RUFU-351 had to close for a declined remediation: a decision the operator can only reach by
clicking is a decision the card has to remember, otherwise the next person to open the card sees a card that
looks untouched and clicks again. (RUFU-284 / RUFU-304 measured the cost of the un-narrated version: hours of
re-burned review cycles on one card.)

The writer is deliberately SEPARATE from the classifier: that module's whole argument is that its predicate is
pure, node-free and I/O-free, and a History write would break the claim. So the decision stays there and the
narration lives here, and both are reached from the same refusal object.

Contract:
- ONE durable History line per (card, waiver gate, destroyed approval) inside a refresh window, through
  `logEntryOnce` when the store has it and plain `logEntry` when it does not — the same duck-typed fallback
  `hold-release.ts` and `project-engine.ts` use.
- The sentence is the classifier's own, verbatim. A History line that names a different remedy than the
  refusal returned to the operator is the offer/accept drift RUFU-599 exists to end.
- The write can never change the refusal. A store that throws, rejects, or hangs is swallowed behind a bound,
  because a lost History line must not turn a refusal into a success or an unhandled rejection.
*/

import type { ApprovalDestroyingRetry } from "./approval-destroying-retry.js";

/** Where the refused Retry was attempted from, so one card can tell a CLI loop from a dashboard click. */
export type ApprovalDestroyingRetryRefusalSource =
  | "cli"
  | "extension-tool"
  | "chat-tool"
  | "dashboard-restart";

/** The minimum the narration needs; every real `TaskStore` has `logEntry`, most also have `logEntryOnce`. */
export interface RetryRefusalLogStore {
  logEntry?: (id: string, action: string) => Promise<unknown> | unknown;
  logEntryOnce?: (
    id: string,
    input: { action: string; dedupeKey: string; windowMs: number },
  ) => Promise<boolean> | boolean;
}

/** Repeated attempts inside this window collapse to one line; a later attempt narrates again. */
const RETRY_REFUSAL_REFRESH_FLOOR_MS = 15 * 60_000;

/** Bound on a hostile log sink: the refusal is already decided, the write may only decorate it. */
const RETRY_REFUSAL_WRITE_BOUND_MS = 2_000;

/** The operator-facing History sentence. One line: the refusal, the gate, and the source that asked. */
export function formatApprovalDestroyingRetryRefusalLine(
  refusal: ApprovalDestroyingRetry,
  source: ApprovalDestroyingRetryRefusalSource,
): string {
  return `Retry refused (${source}): ${refusal.sentence}`;
}

/**
 * Narrate a refused Retry onto the card. Fire-and-forget safe: resolves when the write settled or was
 * refused, and NEVER rejects.
 */
export async function recordApprovalDestroyingRetryRefusal(
  store: RetryRefusalLogStore | undefined,
  taskId: string,
  refusal: ApprovalDestroyingRetry,
  source: ApprovalDestroyingRetryRefusalSource,
): Promise<void> {
  if (!store) return;
  const action = formatApprovalDestroyingRetryRefusalLine(refusal, source);
  const dedupeKey = `approval-destroying-retry:${taskId}:${refusal.waiver.workflowStepId}:${refusal.destroyedApproval.workflowStepId}`;
  try {
    const attempt = typeof store.logEntryOnce === "function"
      ? store.logEntryOnce(taskId, { action, dedupeKey, windowMs: RETRY_REFUSAL_REFRESH_FLOOR_MS })
      : typeof store.logEntry === "function"
        ? store.logEntry(taskId, action)
        : undefined;
    if (attempt && typeof (attempt as PromiseLike<unknown>).then === "function") {
      await Promise.race([
        Promise.resolve(attempt as PromiseLike<unknown>),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, RETRY_REFUSAL_WRITE_BOUND_MS);
          (timer as unknown as { unref?: () => void }).unref?.();
        }),
      ]);
    }
  } catch {
    // A missing or hostile log sink is a lost decoration, never a changed refusal.
  }
}
