/*
FNXC:SweepFailureAudit 2026-11-18-17:29 (RUFU-898):
A maintenance sweep that catches its own exception, logs one console line, and returns `0` is
byte-identical on the board to a healthy pass that found no work. Two instances were measured, by two
authors a day apart, which is what makes this a general invariant and not one function's oversight:
`recoverReviewTasksWithFailedPreMergeSteps()` — the only owner that can rescue a review card with no
verdict — carried zero `emitBoundedRunAudit` calls across its whole body while its neighbour
`reconcileArchivedTasksIntoDone()` writes one row per outcome; and `reconcileAbandonedPlanningSessions()`
carried the same defect in two arms the day RUFU-470 merged it. The known price is already paid in this
repo: the FNXC note in `no-verdict-review-stall-park.test.ts` (WorkflowPassCacheFixture 2026-11-06-02:36)
records that all three reroute/seed assertions lost their meaning "with no visible cause" when a fake
store lacked `workflowDefinitionEpoch()` and the outer catch collapsed the entire pass — RUFU-405
repaired the fake and left the product catch blind.

WHY A NEW `sweep:*` FAMILY AND NOT A TENTH `-no-action` REASON (the written decision AC7 demands):
1. `-no-action` means "the ladder reached a decision and decided not to act". An exception means the
   ladder never reached a decision; folding an abort into `outcome: "refused"` would make the
   refuse/reclaim ratio RUFU-470's note exists to protect uncountable.
2. Instance 1 has no per-card event at all, so one new family is the only shape that covers BOTH
   instances with one query.
3. RUFU-356's `probe-threw` / `probe-unknown` is not the counterexample it looks like: there the sweep
   still consumed a tri-state probe answer and kept its park, i.e. it decided. Here nothing decided.
4. A `sweep:` prefix cannot collide with the `task:reconcile-abandoned-planning` prefix that
   `self-healing-abandoned-planning-sessions.test.ts` filters on, so a new row cannot silently renumber
   an existing test's destructured single-row assertion.
5. All-lowercase keeps the name inside the catalogue's own naming grammar
   (`run-audit-catalogue.test.ts` requires `^[a-z]+:[a-z0-9:-]+$`), so a later decision to catalogue the
   family cannot fail on its name.

CATALOGUE DECISION, measured rather than guessed: the family stays OUTSIDE
`DELIVERY_PIPELINE_RUN_AUDIT_EVENTS`. That test compares the catalogue table-for-table against only the
DOC'S TABLE ROWS (`^\\| \`event\` \\|`), measured 47 rows against 47 catalogue events at planning time,
and a maintenance-pass crash is not a delivery-pipeline step. Document it as a heading plus prose in
`docs/run-audit.md`, exactly as `runtime:heap-ceiling` and the `memory:*` trio do — and never as a table
row, or the lock-step test fails.
*/
import { WEDGE_RENOTIFY_COOLDOWN_MS } from "@fusion/core";
import { emitBoundedRunAudit, type RunAuditSinkHost } from "../util/emit-bounded-run-audit.js";
import { generateSyntheticRunId } from "../util/run-audit.js";

/** The whole pass aborted before finishing. `target` is the sweep name; no card is attributable. */
export const SWEEP_PASS_FAILURE_EVENT = "sweep:pass-failure";

/** One card's repair threw and the pass continued. `target` and `taskId` are both the card id. */
export const SWEEP_CANDIDATE_FAILURE_EVENT = "sweep:candidate-failure";

/*
FNXC:SweepFailureAudit 2026-11-18-17:29 (RUFU-898):
The `sweep` vocabulary is keyed on the METHOD name and not on a registration step name, because the two
step runners name instance 1 differently (`failed-pre-merge-steps` at startup vs
`recover-failed-pre-merge-steps` in maintenance batch 1) for the same function. A key derived from a
registration name would split one function into two identities. `as const` so the census test can iterate
it rather than re-list it.
*/
export const SWEEP_FAILURE_SWEEPS = [
  "recover-review-tasks-with-failed-pre-merge-steps",
  "reconcile-abandoned-planning-sessions",
] as const;

/** Which pass aborted. Closed enum; the census test fails if an arm names a sweep that is not listed. */
export type SweepFailureSweep = (typeof SWEEP_FAILURE_SWEEPS)[number];

/*
FNXC:SweepFailureAudit 2026-11-18-17:29 (RUFU-898):
One stage per catch arm, so a query answers which arm threw without an error sentence: instance 1 has
two candidate arms (the no-verdict re-seed and the remediation revival) and instance 2 has one.
*/
export const SWEEP_FAILURE_STAGES = [
  "no-verdict-recovery",
  "revive",
  "candidate-repair",
] as const;

/** Which arm of the pass threw. Closed enum per sweep. */
export type SweepFailureStage = (typeof SWEEP_FAILURE_STAGES)[number];

/**
 * The exact metadata shape of each arm. It is a separate closed type with a closed signature precisely
 * so a caught value has NO PARAMETER through which it could arrive: an error message, class, stack, or
 * path is unrepresentable in the row by construction, not merely unused by convention.
 */
export type SweepFailureMetadata =
  | { sweep: SweepFailureSweep; outcome: "aborted"; candidateFailureCount: number }
  | { sweep: SweepFailureSweep; taskId: string; stage: SweepFailureStage };

/**
 * Bucketed dedupe key for a pass-level abort.
 *
 * The bucket is the whole point, exactly as in RUFU-318's `unrunGateParkEpisodeKey`: a key over the
 * sweep name alone is swallowed by the memo for the rest of the process, so a pass that dies every
 * poll for a week produces one row and then silence. Dividing wall clock by the wedge re-notify window
 * makes a persistent failure re-announce at most once per window while repeats inside a window still
 * collapse to one row.
 */
export function sweepPassFailureKey(sweep: SweepFailureSweep, now: number): string {
  return `${sweep}:pass:${Math.floor(now / WEDGE_RENOTIFY_COOLDOWN_MS)}`;
}

/** Bucketed dedupe key for one card's failed repair: the card and the arm join the pass and the bucket. */
export function sweepCandidateFailureKey(
  sweep: SweepFailureSweep,
  taskId: string,
  stage: SweepFailureStage,
  now: number,
): string {
  return `${sweep}:candidate:${taskId}:${stage}:${Math.floor(now / WEDGE_RENOTIFY_COOLDOWN_MS)}`;
}

/**
 * Prune-then-check claim on the in-process memo, following
 * `NotificationService.claimFallbackWedgeNotificationEpisode`.
 *
 * The bucket inside the key is what re-opens the episode; this pass is what keeps the Map bounded,
 * because a new bucket is a new key forever. A non-finite, future, or window-old stamp is deleted
 * before the check, so a clock adjustment cannot make a key immortal.
 *
 * HONEST BOUND: this memo is in-process, so a restart inside a window may write one row per window per
 * process. Every existing self-healing memo (`abandonedPlanningNoActionAudited`,
 * `staleAcquisitionConflictNoActionAudited`, `unrunGateParkAuditKeys`) carries the same bound, and
 * RUFU-318's durable key exists only because the mailbox has a store-side once-seam that run-audit does
 * not.
 */
export function claimSweepFailureEpisode(memo: Map<string, number>, key: string, now: number): boolean {
  for (const [pruneKey, emittedAt] of memo) {
    if (!Number.isFinite(emittedAt) || emittedAt > now || now - emittedAt >= WEDGE_RENOTIFY_COOLDOWN_MS) {
      memo.delete(pruneKey);
    }
  }
  if (memo.has(key)) return false;
  memo.set(key, now);
  return true;
}

/** The metadata for one report, built ONLY from the closed vocabularies. No error parameter exists. */
export function sweepFailureMetadata(input: {
  sweep: SweepFailureSweep;
  stage?: SweepFailureStage;
  taskId?: string;
  candidateFailureCount?: number;
}): SweepFailureMetadata {
  if (input.stage && input.taskId) {
    return { sweep: input.sweep, taskId: input.taskId, stage: input.stage };
  }
  return {
    sweep: input.sweep,
    outcome: "aborted",
    candidateFailureCount: input.candidateFailureCount ?? 0,
  };
}

export interface SweepFailureReport {
  /** Which pass died. */
  sweep: SweepFailureSweep;
  /** Present only for a candidate-level failure; its absence means the whole pass aborted. */
  stage?: SweepFailureStage;
  /** Present only for a candidate-level failure — the card whose own repair threw. */
  taskId?: string;
  /**
   * The caught value. It exists in the signature only so a caller cannot forget the arm has one; it is
   * dropped below and has no path into the row — `sweepFailureMetadata()` takes no error parameter, so
   * its message is UNREPRESENTABLE rather than merely unread. The console line keeps the detail.
   */
  error: unknown;
  /** Pass rows only: candidate failures this pass already counted before it died. */
  candidateFailureCount?: number;
  /** Injectable clock, so the window boundary is testable without waiting six hours. */
  now?: number;
  /** The store-backed sink host, i.e. the `SelfHealingManager`'s store. */
  store: RunAuditSinkHost;
  /** The manager's in-process episode memo. */
  memo: Map<string, number>;
}

/**
 * Emit one deduped row for a caught sweep failure through the FN-9175 bounded seam, and report whether
 * this call claimed the episode (the seam itself is best-effort, so an accepted row is not yet a
 * durable one — RUFU-453).
 *
 * The helper never throws and never awaits longer than the seam's own bound: an audit write must not
 * become the reason a recovery pass fails twice. The caller's `return 0` / `continue` and its console
 * line are unchanged by this module — that is the whole contract of RUFU-898.
 */
export async function emitSweepFailureAudit(report: SweepFailureReport): Promise<boolean> {
  const now = report.now ?? Date.now();
  const isCandidate = Boolean(report.stage && report.taskId);
  const key = isCandidate
    ? sweepCandidateFailureKey(report.sweep, report.taskId as string, report.stage as SweepFailureStage, now)
    : sweepPassFailureKey(report.sweep, now);

  if (!claimSweepFailureEpisode(report.memo, key, now)) return false;

  /*
  FNXC:SweepFailureAudit 2026-11-18-17:29 (RUFU-898):
  The caught value is dropped here, deliberately as a statement rather than by silence: everything the
  row can say comes from `sweepFailureMetadata`, whose signature has no error parameter at all. The
  console line in the caller keeps the message this row must not carry.
  */
  void report.error;
  const metadata = sweepFailureMetadata(report);
  const target = report.taskId ?? report.sweep;

  await emitBoundedRunAudit(report.store, {
    // RUFU-430's lesson: `run_audit_events.target` is NOT NULL. A pass row has no card, so it carries
    // the sweep name as its target and grows no `taskId` at all — an absent key, never a guessed one.
    ...(report.taskId ? { taskId: report.taskId } : {}),
    agentId: "self-healing",
    runId: generateSyntheticRunId(
      isCandidate ? "sweep-candidate-failure" : "sweep-pass-failure",
      target,
    ),
    domain: "database",
    mutationType: isCandidate ? SWEEP_CANDIDATE_FAILURE_EVENT : SWEEP_PASS_FAILURE_EVENT,
    target,
    // Ids, counts, and fixed enums only: no error class, message, stack, path, card title, or spec text.
    metadata,
  });
  return true;
}
