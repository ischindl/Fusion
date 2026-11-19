/*
FNXC:ReviewLaneDeclineAttribution 2026-11-19-22:55 (RUFU-478):
Durable record for the one review-lane state that was previously warn-only.

`ReviewDispatchSweep` is the only thing that starts a review. When a project has no enabled reviewer it
declines the whole lane and said so with `E4: no enabled reviewer agent exists; review-lane cards stay
undispatched by design.` — a `log.warn` on a 5-minute cooldown that writes nothing durable. Measured on the
deployed node: 214 identical lines in ~7 hours, none carrying a project id, while 12 of 24 projects genuinely
have no enabled reviewer. That made an operator's *configuration* state indistinguishable from a dead engine,
and "which projects cannot be reviewed?" unanswerable after log rotation. This module is the durable half;
the warn line stays the human-facing half (`logReviewerConfigurationGap`, unchanged).

Two properties make the row trustworthy rather than decorative:

  * IT ALWAYS MEANS A WAITING CARD. `runPass()` returns before the pool is ever resolved when the candidate
    list is empty, so a decline recorded at that call site is never noise about an idle lane and
    `waitingCount` is a real queue depth.
  * A DECLINE NEVER COMES FROM A BROKEN READ. `runPass()` has no try/catch around `resolveReviewerPool()`, so
    a rejected `listAgents()` aborts the tick before this recorder is reached. An infrastructure failure must
    not be reported as a configuration gap.

Dedupe is per `(projectId, reasonCode)` episode, so a lane that stays unconfigured for a week costs one row,
not one per 15 s tick — the flood this replaces. A project whose pool later becomes non-empty is cleared
(`clearReviewDispatchDeclineSignature`), so a repair followed by a regression produces a NEW row instead of
being swallowed forever.

SEAM CHOICE — this is the one deliberate divergence from the recorder it mirrors.
`packages/engine/src/util/dispatch-latency.ts` emits through the VOID lane (`emitBoundedRunAudit`) because its
whole contract is "never delay the lane it measures". Since RUFU-453 that lane hands the row to the store's
buffered drain, so an accepted emit is NOT yet a durable row. This record's entire value is being queryable
after the fact, so it takes the AWAITED outcome lane (`emitBoundedRunAuditWithOutcome`), whose write is direct
and settles before the tick returns — the same reason the `store:open` provenance row chose that variant. The
await is bounded at `RUN_AUDIT_EMIT_TIMEOUT_MS` (2 s) and deduped to once per project episode, so it adds no
per-tick latency, and it is what makes the Postgres durability assertion deterministic rather than racing a drain.

RUFU-430 is the reason the emit SHAPE is asserted by tests rather than trusted: an event whose first emit
omitted the NOT NULL `target` produced zero rows in production while the bounded seam swallowed the rejection.
`target` therefore falls back to the stable literal `unknown-project` — never an empty string, which would
satisfy NOT NULL and still be unattributable.
*/

import type { RunAuditSinkHost } from "../util/emit-bounded-run-audit.js";
import { emitBoundedRunAuditWithOutcome } from "../util/emit-bounded-run-audit.js";
import { generateSyntheticRunId } from "../util/run-audit.js";

/** The one live decline reason. See the retirement note on `task:review-dispatch-declined`. */
export type ReviewDispatchDeclineReason = "no-enabled-reviewer";

/** Kept as a named constant so the sweep, the tests and the union cannot drift apart on a literal. */
export const REVIEW_DISPATCH_DECLINE_MUTATION_TYPE = "task:review-dispatch-declined";

/** `run_audit_events.target` is NOT NULL; a project-less host still needs a stable, attributable target. */
export const UNKNOWN_REVIEW_DECLINE_PROJECT_TARGET = "unknown-project";

/** Metadata bound. An unbounded id array in an audit row is a load problem, not a diagnostic. */
export const MAX_DECLINE_CANDIDATE_IDS = 20;

const DEFAULT_MAX_DECLINE_SIGNATURES = 512;
/*
FNXC:ReviewLaneDeclineAttribution 2026-11-19-23:42 (RUFU-478):
NUL joins the two key parts because no task or project id can contain it, so a `(projectId, reasonCode)` pair
can never collide with a neighbour the way a `:`-joined key can when an id carries the separator.
Write it as an ESCAPE, never as the literal character: a raw NUL in the file makes git treat the SOURCE as
binary (`Bin a -> b` in every diffstat) and every grep, blame, and diff of this module silently degrades.
*/
const SIGNATURE_SEPARATOR = "\0";

/**
 * Suppressed `(projectId, reasonCode)` episodes, insertion-ordered. Module-global on purpose: the sweep is
 * per project runtime, but the bound must hold across every runtime in one process.
 */
const suppressedEpisodes = new Set<string>();

export function reviewDispatchDeclineSignature(
  projectId: string | null | undefined,
  reasonCode: ReviewDispatchDeclineReason,
): string {
  return [projectId ?? UNKNOWN_REVIEW_DECLINE_PROJECT_TARGET, reasonCode].join(SIGNATURE_SEPARATOR);
}

export interface ReviewDispatchDeclineInput {
  readonly host: RunAuditSinkHost;
  /** The project whose review lane declined; null falls back to the stable unknown-project target. */
  readonly projectId: string | null | undefined;
  readonly reasonCode: ReviewDispatchDeclineReason;
  /** What the sweep actually resolved, so the row and the warn line can never disagree. */
  readonly enabledReviewerCount: number;
  /** Queue depth behind the decline — always > 0, guaranteed by the caller's early return. */
  readonly waitingCount: number;
  /** Waiting cards in the sweep's own stable order (oldest review entry first). */
  readonly candidateTaskIds: readonly string[];
}

/**
 * Record one project-scoped review-lane decline.
 *
 * Returns whether a row was ATTEMPTED (false = suppressed as a duplicate episode, or the recorder itself
 * failed). Never throws and never rejects: a diagnostic may not break the lane it observes, and the caller
 * does not branch on the result — the await exists for durability, not for control flow.
 */
export async function recordReviewDispatchDecline(input: ReviewDispatchDeclineInput): Promise<boolean> {
  try {
    const signature = reviewDispatchDeclineSignature(input.projectId, input.reasonCode);
    if (suppressedEpisodes.has(signature)) return false;
    // Bounded retention: drop the oldest insertion rather than grow without limit. Losing a suppression
    // costs one redundant row, never a missing fact.
    if (suppressedEpisodes.size >= DEFAULT_MAX_DECLINE_SIGNATURES) {
      const oldest = suppressedEpisodes.values().next().value;
      if (oldest !== undefined) suppressedEpisodes.delete(oldest);
    }
    // Claimed BEFORE the await, exactly as the dispatch-latency recorder claims before handing off: a
    // persistently failing sink must not turn every tick into a fresh attempt.
    suppressedEpisodes.add(signature);

    const target = input.projectId || UNKNOWN_REVIEW_DECLINE_PROJECT_TARGET;
    await emitBoundedRunAuditWithOutcome(input.host, {
      // No `taskId`: the episode belongs to a project, and a card-scoped row would make "which projects"
      // a scan over every waiting card.
      agentId: "system",
      runId: generateSyntheticRunId("review-dispatch-decline", target),
      domain: "database",
      mutationType: REVIEW_DISPATCH_DECLINE_MUTATION_TYPE,
      target,
      metadata: {
        reasonCode: input.reasonCode,
        enabledReviewerCount: input.enabledReviewerCount,
        waitingCount: input.waitingCount,
        candidateTaskIds: input.candidateTaskIds.slice(0, MAX_DECLINE_CANDIDATE_IDS),
      },
    } as never);
    return true;
  } catch {
    return false;
  }
}

/**
 * Forget a project's suppressed episode so the next decline is recorded again — the recovery re-arm. Called
 * when the same sweep resolves a NON-empty pool, i.e. the gap was repaired.
 */
export function clearReviewDispatchDeclineSignature(projectId: string | null | undefined): void {
  // One delete: `reviewDispatchDeclineSignature` applies the same unknown-project normalization the claim
  // used, so a project's episode can never clear another project's (or the fallback's) silence.
  suppressedEpisodes.delete(reviewDispatchDeclineSignature(projectId, "no-enabled-reviewer"));
}

/** Test seam: the suppression set is process-global, so cases must not inherit each other's silence. */
export function resetReviewDispatchDeclineSignaturesForTests(): void {
  suppressedEpisodes.clear();
}

/** Diagnostics/tests: how many episodes are currently suppressed. */
export function retainedReviewDispatchDeclineSignatureCount(): number {
  return suppressedEpisodes.size;
}
