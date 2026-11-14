import { PLAN_REVIEW_GROUP_ID } from "../workflows/builtin-plan-review-group.js";
import type { WorkflowStepResult } from "../types/workflow/workflow-steps.js";

export type NoOpCompletionMarkerKind = "premise-stale" | "no-op" | "duplicate" | "redundant";

export interface NoOpCompletionMarker {
  kind: NoOpCompletionMarkerKind;
  reason: string;
  canonicalId?: string;
}

const PREFIXES: Array<{ pattern: RegExp; kind: NoOpCompletionMarkerKind }> = [
  { pattern: /^PREMISE STALE:\s*/i, kind: "premise-stale" },
  { pattern: /^NO-OP:\s*/i, kind: "no-op" },
  { pattern: /^NOOP:\s*/i, kind: "no-op" },
  { pattern: /^DUPLICATE:\s*/i, kind: "duplicate" },
  { pattern: /^REDUNDANT:\s*/i, kind: "redundant" },
];

/**
 * Detects explicit executor completion summaries that mean the task was
 * verified as already satisfied on HEAD (no source commit is appropriate).
 *
 * The marker must be a leading, case-insensitive prefix. Mid-summary mentions
 * intentionally do not match so ordinary prose cannot accidentally bypass the
 * no-commits invariant.
 */
export function parseNoOpCompletionMarker(summary: string | undefined): NoOpCompletionMarker | null {
  const trimmed = summary?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  for (const { pattern, kind } of PREFIXES) {
    const match = trimmed.match(pattern);
    if (!match) continue;

    const reason = trimmed.slice(match[0].length).trim();
    const idMatch = kind === "duplicate" || kind === "redundant"
      ? reason.match(/\b(FN-\d+)\b/i)
      : null;

    return {
      kind,
      reason,
      ...(idMatch ? { canonicalId: idMatch[1].toUpperCase() } : {}),
    };
  }

  return null;
}

/*
FNXC:TerminalPlanReviewClose 2026-11-14-02:40 (RUFU-599 reproduction 3, SANE-532):
An ACCEPTED terminal close — Plan Review `passed` with verdict `CLOSE_NO_OP` and a leading sentinel in its
notes — is the card's END, not a gate it passed on the way to executing. Nothing said so on the resume path:
`isPlanReviewSatisfied` answers true for any `passed` row, so a re-entry read the close as "gate released"
and placed the run on the node after Plan Review. The card then executed its step list and completed as
ordinary work, which is the reported symptom (a card recorded as closed at Plan Review yet running anyway).

The sentinel is part of the identity, not decoration: `parseNoOpCompletionMarker` is what made the close
legal at the authoring gate (an invalid request keeps failed evidence and suspends), so a row without it
cannot be terminal either. A superseded row retires with the plan it belongs to, and only the LATEST
Plan Review row counts — a re-run, a replan, or a reopen wipes or supersedes it, which is exactly how a
card legitimately returns to being worked on.
*/
export function isTerminalPlanReviewCloseRow(
  row: Pick<WorkflowStepResult, "workflowStepId" | "status" | "verdict" | "notes" | "supersededAt"> | undefined,
): boolean {
  if (!row) return false;
  if (row.workflowStepId !== PLAN_REVIEW_GROUP_ID) return false;
  if (row.supersededAt != null) return false;
  if (row.status !== "passed") return false;
  if (row.verdict !== "CLOSE_NO_OP") return false;
  return parseNoOpCompletionMarker(row.notes) !== null;
}

/** The latest non-superseded Plan Review row, newest-first on the same stamps `latestRowFor` uses. */
export function latestPlanReviewRow(
  results: readonly Pick<WorkflowStepResult, "workflowStepId" | "completedAt" | "startedAt" | "status" | "verdict" | "notes" | "supersededAt">[] | undefined,
): Pick<WorkflowStepResult, "workflowStepId" | "status" | "verdict" | "notes" | "supersededAt"> | undefined {
  let best: Pick<WorkflowStepResult, "workflowStepId" | "status" | "verdict" | "notes" | "supersededAt"> | undefined;
  let bestAt = -1;
  for (const row of results ?? []) {
    if (row.workflowStepId !== PLAN_REVIEW_GROUP_ID || row.supersededAt != null) continue;
    const stamp = Date.parse(row.completedAt ?? row.startedAt ?? "") || 0;
    // `>=` keeps the LAST duplicate when timestamps tie or are unparseable.
    if (stamp >= bestAt) {
      best = row;
      bestAt = stamp;
    }
  }
  return best;
}

/** The card's accepted terminal close, or `undefined` when its latest Plan Review evidence says otherwise. */
export function acceptedTerminalPlanReviewClose(
  results: readonly Pick<WorkflowStepResult, "workflowStepId" | "completedAt" | "startedAt" | "status" | "verdict" | "notes" | "supersededAt">[] | undefined,
): ReturnType<typeof latestPlanReviewRow> {
  const latest = latestPlanReviewRow(results);
  return isTerminalPlanReviewCloseRow(latest) ? latest : undefined;
}
