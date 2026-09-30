import type { InReviewStallCode, InReviewStallSignal, Task } from "@fusion/core";
import { isReviewColumnRole } from "./columnRoles";
import { MAX_AUTO_MERGE_RETRIES } from "../hooks/useBlockerFanout";
import { getUnifiedTaskProgress } from "./taskProgress";
import { getTaskLogEntryAction } from "./taskLogEntryDisplay";

export interface InReviewStallCopy {
  badgeLabel: string;
  counter?: string;
  headline: string;
  description: string;
  suggestedAction: string;
  code: InReviewStallCode;
}

export interface InReviewStallDeadlockCopy {
  headline: string;
  description: string;
  nextAction: string;
}

const BADGE_LABEL_BY_CODE: Record<InReviewStallCode, string> = {
  "merge-blocker": "Merge blocked",
  "transient-merge-status-no-owner": "Merge stalled",
  "merge-retries-exhausted": "Retries exhausted",
  /*
  FNXC:InReviewStallBadge 2026-09-28-18:56 (RUFU-393 era observation):
  This badge used to read "Merge retry stalled". The classifier that produces this code REQUIRES
  `mergeRetries === 0` (`packages/core/src/tasks/in-review-stall.ts`), so no merge retry had ever run
  on any card carrying it — the label pointed the operator at merge-retry tooling for a state that
  contains no retries at all. Measured the same day: 26 saneca `in-review` cards wore that badge while
  their actual condition was a Code Review row that died with NO authored verdict. The badge now names
  the observable fact (review finished, nothing merged) and the description carries both real causes.
  The `merge-retries-exhausted` code keeps the retry wording, because there it is true.
  */
  "completed-review-status-none": "Review not merged",
  "no-worktree-no-merge-confirmed": "No worktree",
  "non-retryable-provider-error": "Provider error",
  /*
  FNXC:ReviewRevisionWait 2026-09-29-16:40 (RUFU-280):
  The label names the observable fact (a reviewer asked for changes) and never the machinery. It is only
  ever read on a surface that already opted in — this code is badge-suppressed below — so it exists to keep
  the returned copy shape complete, the same role `held-human-review`'s badge label plays in the resolver.
  */
  "awaiting-review-revision": "Review corrections",
};

const COPY_BY_CODE: Record<InReviewStallCode, Omit<InReviewStallCopy, "badgeLabel" | "counter" | "code">> = {
  "merge-blocker": {
    headline: "Merge blocked by a pre-merge check",
    description:
      "A workflow step or merge precondition is reporting a blocker. The task is waiting for that check to pass before it can finalize.",
    suggestedAction: "Open the Review tab to see which step is blocking, then fix the failure or override the step.",
  },
  "transient-merge-status-no-owner": {
    headline: "Stuck in a transient merge state with no active merger",
    description:
      "The task is parked in a merging/merging-pr/merging-fix status but no merger process owns it. Self-healing will retry, but if this repeats the merge worker may need attention.",
    suggestedAction: "Wait one self-healing cycle; if it persists, inspect engine logs for crashed merger runs.",
  },
  "merge-retries-exhausted": {
    headline: "Auto-merge retries exhausted",
    description: "The merger hit its retry ceiling without confirming a merge. The task will not be re-enqueued automatically.",
    suggestedAction:
      "Resolve the underlying merge problem manually and re-run the merge from the Review tab, or move the task back to in-progress.",
  },
  "completed-review-status-none": {
    headline: "Review finished but nothing was merged",
    description:
      "Every workflow step is done or skipped, yet the card has no status, no error, and zero merge retries — so this is not a retry that stalled. Two shapes produce it: a required review gate whose latest row has NO authored verdict (the review session died), or an approved card whose auto-merge hand-off never durably started.",
    suggestedAction:
      "Open the Review tab. A missing verdict needs no manual repair — the no-verdict recovery re-seeds that gate and lifts the stall park itself. When a verdict exists, Retry restarts the merge hand-off.",
  },
  "no-worktree-no-merge-confirmed": {
    headline: "No worktree on disk and merge not confirmed",
    description:
      "The task's working tree is gone but the merge was never confirmed. Either the worktree was removed prematurely or the merge metadata is incomplete.",
    suggestedAction:
      "Check the Changes tab and Git history; if the work landed, mark the merge confirmed, otherwise re-create the worktree.",
  },
  /*
  FNXC:ReviewRevisionWait 2026-09-29-16:40 (RUFU-280):
  The state this code names is the review loop WORKING, so the copy must not read as a fault: no "blocked",
  no pointer at merge-retry tooling (there is no retry to retry), and no instruction to intervene while the
  remediation steps are still advancing. The operator's real action is to notice when they stop.
  */
  "awaiting-review-revision": {
    headline: "Applying review corrections",
    description:
      "The latest code review authored a REVISE verdict and this card still has unfinished remediation steps. The engine is executing them, which is why the card sits in review without being stalled.",
    suggestedAction:
      "Let the next review round run. Open the Review tab only if the remediation steps stop advancing; Retry or a manual fix is for a card that stops producing progress, not for one mid-correction.",
  },
  "non-retryable-provider-error": {
    headline: "Terminal provider error",
    description:
      "The provider rejected the task with a non-retryable error such as an invalid model, unsupported request, or permission denial. Self-healing will pause the task instead of retrying the same failure.",
    suggestedAction:
      "Fix the model/provider configuration or permissions, then unpause and retry the task once the provider can accept the request.",
  },
};

function defaultCopy(signal: InReviewStallSignal): InReviewStallCopy {
  if (process.env.NODE_ENV !== "production") {
    console.warn(`Unhandled inReviewStall code in dashboard copy map: ${signal.code}`);
  }
  return {
    badgeLabel: "In-review stall",
    code: signal.code,
    headline: "In-review stall surfaced",
    description: signal.reason,
    suggestedAction: "Open the activity log for details.",
  };
}

type ReviewProgressTask = Pick<Task, "steps" | "enabledWorkflowSteps" | "workflowStepResults">;

/*
FNXC:InReviewStallBadge 2026-09-20-00:53:
Failed pre-merge gates must remain visible even when the task has no top-level status.
Reuse workflow progress filtering; superseded attempts, disabled gates and advisory failures are not blockers.
All card, list and detail surfaces use this same classification.
*/
function failedReviewGate(task: Partial<ReviewProgressTask>) {
  const results = [...new Map((task.workflowStepResults ?? []).map(result => [result.workflowStepId, result])).values()];
  return getUnifiedTaskProgress({ ...task, steps: [], workflowStepResults: results }).items.find(
    item => item.source === "workflow" && item.phase === "pre-merge" && item.status === "failed",
  );
}

export function getInReviewStallCopy(
  signal: InReviewStallSignal,
  options?: { mergeRetries?: number | null; maxAutoMergeRetries?: number } & Partial<ReviewProgressTask>,
): InReviewStallCopy {
  const mapped = COPY_BY_CODE[signal.code];
  if (!mapped) {
    return defaultCopy(signal);
  }

  const failedGate = signal.code === "merge-blocker" && options ? failedReviewGate(options) : undefined;
  if (failedGate) {
    const result = [...(options?.workflowStepResults ?? [])].reverse().find(row => `workflow-${row.workflowStepId}` === failedGate.id);
    return {
      ...mapped,
      code: signal.code,
      badgeLabel: `${failedGate.name} blocked`,
      headline: `${failedGate.name} failed`,
      description: result?.output || signal.reason,
    };
  }

  const maxAutoMergeRetries = options?.maxAutoMergeRetries ?? MAX_AUTO_MERGE_RETRIES;
  const mergeRetries = options?.mergeRetries;
  const counter =
    signal.code === "merge-retries-exhausted" && Number.isFinite(mergeRetries) && mergeRetries != null && mergeRetries >= 0
      ? `${Math.max(mergeRetries, maxAutoMergeRetries)}/${maxAutoMergeRetries}`
      : undefined;

  return {
    badgeLabel: BADGE_LABEL_BY_CODE[signal.code],
    code: signal.code,
    counter,
    ...mapped,
  };
}

const IN_REVIEW_STALL_DEADLOCK_LOG_PREFIX = "In-review stall auto-disposed [";

const IN_REVIEW_STALL_DEADLOCK_COPY: InReviewStallDeadlockCopy = {
  headline: "In-review deadlock auto-disposed",
  description:
    "Self-healing paused this in-review task after the same stall repeated without progress. This prevents infinite merge-blocker churn.",
  nextAction:
    "Inspect the merge blocker/branch conflict, recover manually, then unpause to retry. If recovery needs extra implementation, create a follow-up with fn_task_refine.",
};

/**
 * FNXC:TaskLogs 2026-06-14-14:27:
 * In-review deadlock detection must tolerate legacy/operator task log entries that may not have an `action` field.
 * Route through getTaskLogEntryAction so older persisted activity logs cannot crash dashboard rendering while checking for the self-healing marker.
 */
export function getInReviewStallDeadlockCopy(task: Pick<Task, "pausedReason" | "log">): InReviewStallDeadlockCopy | undefined {
  if (task.pausedReason === "in-review-stall-deadlock") {
    return IN_REVIEW_STALL_DEADLOCK_COPY;
  }

  const hasDeadlockLog = task.log?.some((entry) => getTaskLogEntryAction(entry).startsWith(IN_REVIEW_STALL_DEADLOCK_LOG_PREFIX)) ?? false;
  return hasDeadlockLog ? IN_REVIEW_STALL_DEADLOCK_COPY : undefined;
}

/*
FNXC:InReviewStallBadge 2026-07-26-18:05:
Badge suppression list. A suppressed code still computes and stores `task.inReviewStall` — only the
visual affordance is withheld — so the Review tab, run-audit, and self-healing continue to see it.

- `no-worktree-no-merge-confirmed`: never surfaced as a badge.
- `merge-blocker`: ordinary waiting stays quiet; a current failed pre-merge gate overrides suppression.
- `awaiting-review-revision` (RUFU-280): a REVISE verdict with unfinished remediation is the review loop
  mid-flight, and the executor's remediation steps already name that work on the card. Badging it would
  mark routine revision abnormal — the same reasoning that quiets `merge-blocker`, and the reason the
  notification wedge table admits it as `null` rather than an alert.

The other codes (transient-merge-status-no-owner, merge-retries-exhausted, non-retryable-provider-error)
still badge — they report genuinely stuck states needing an operator.
*/
const BADGE_SUPPRESSED_CODES: ReadonlySet<InReviewStallCode> = new Set([
  "no-worktree-no-merge-confirmed",
  "merge-blocker",
  "awaiting-review-revision",
]);

export function shouldShowInReviewStallBadge(
  task: Pick<Task, "column" | "paused" | "inReviewStall" | "status"> & Partial<ReviewProgressTask>,
  columnFlags?: Parameters<typeof isReviewColumnRole>[0],
): boolean {
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-13:10 (batch-dashboard-app):
  `columnFlags` resolves the REVIEW role; omitted -> the legacy id, i.e. today's behaviour.
  Keyed on the literal, the in-review stall badge never rendered on a renamed board — the signal was
  computed and then thrown away at the last gate, so a stalled review looked healthy.
  */
  if (!isReviewColumnRole(columnFlags, task.column) || task.paused === true || task.inReviewStall == null) {
    return false;
  }

  return (task.inReviewStall.code === "merge-blocker" && Boolean(failedReviewGate(task)))
    || !BADGE_SUPPRESSED_CODES.has(task.inReviewStall.code);
}
