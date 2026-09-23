/*
FNXC:SharedStoreErrorShape 2026-09-23-06:00:
STAS-251. During the 2026-09-23 stall one database held every task but the pool could not
answer, and the tools turned that into two kinds of lie: "Task STAS-250 not found" for a card
that was alive (an agent rebuilt it), and "Step 7 → done" for a transition the store had
refused. Both read as successes because `AgentLogger` records `tool_error` only when a result
carries `isError`. Every tool that learns the store — not its data — stopped it now returns
one of these two results, so the agent can tell a card that is absent from a board it cannot
reach, and a step it closed from one it merely asked about.
*/

/** A step transition the store holds the authority to refuse, and what to do next. */
export const STEP_LIFECYCLE_GUIDANCE =
  "Nothing was persisted. A step moves pending → in-progress → done one transition at a time and never backwards; " +
  "find the step the frontier is actually on, move that one, and retry.";

/** The store is slow, unreachable, or past its boot deadline, so nothing was read or written. */
export const STORE_RETRY_GUIDANCE =
  "The board recorded nothing. Retry the call; if it fails again, report the failure instead of assuming the change landed.";

/* One line of failure text — a stack trace is noise to a model, not detail. */
function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0];
}

/**
 * The store failed a call. Not-found is excluded on purpose: a card that is genuinely absent
 * is a fact about the board, and reporting it in this shape would teach agents that an
 * outage made their work disappear.
 */
export function storeErrorResult(what: string, error: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: `ERROR: ${what} did not reach the task store: ${reason(error)} ${STORE_RETRY_GUIDANCE}`,
    }],
    details: { code: "STORE_UNAVAILABLE" },
    isError: true,
  };
}

/**
 * The store answered but kept the step on its old status — it refuses an out-of-order or
 * regressing transition by returning the task unchanged rather than throwing, so the returned
 * status is the only honest answer about what the board now holds.
 */
export function stepLifecycleNoopResult(opts: {
  stepIndex: number;
  stepName: string;
  requested: string;
  persisted: string;
  progress?: { done: number; total: number };
}) {
  const progressNote = opts.progress ? ` Progress: ${opts.progress.done}/${opts.progress.total} done.` : "";
  return {
    content: [{
      type: "text" as const,
      text: `Step ${opts.stepIndex} (${opts.stepName}) remains ${opts.persisted} — ${opts.requested} request ignored to preserve step lifecycle invariants. ${STEP_LIFECYCLE_GUIDANCE}${progressNote}`,
    }],
    details: {
      stepIndex: opts.stepIndex,
      requestedStatus: opts.requested,
      persistedStatus: opts.persisted,
      code: "STEP_LIFECYCLE_NOOP",
    },
    isError: true,
  };
}
