import type { InReviewStallCode, InReviewStallSignal, Task } from "@fusion/core";

export interface InReviewStallCopy {
  badgeLabel: string;
  headline: string;
  description: string;
  suggestedAction: string;
  code: InReviewStallCode;
}

const BADGE_LABEL = "Stall";

const COPY_BY_CODE: Record<InReviewStallCode, Omit<InReviewStallCopy, "badgeLabel" | "code">> = {
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
  "no-worktree-no-merge-confirmed": {
    headline: "No worktree on disk and merge not confirmed",
    description:
      "The task's working tree is gone but the merge was never confirmed. Either the worktree was removed prematurely or the merge metadata is incomplete.",
    suggestedAction:
      "Check the Changes tab and Git history; if the work landed, mark the merge confirmed, otherwise re-create the worktree.",
  },
};

function defaultCopy(signal: InReviewStallSignal): InReviewStallCopy {
  if (process.env.NODE_ENV !== "production") {
    console.warn(`Unhandled inReviewStall code in dashboard copy map: ${signal.code}`);
  }
  return {
    badgeLabel: BADGE_LABEL,
    code: signal.code,
    headline: "In-review stall surfaced",
    description: signal.reason,
    suggestedAction: "Open the activity log for details.",
  };
}

export function getInReviewStallCopy(signal: InReviewStallSignal): InReviewStallCopy {
  const mapped = COPY_BY_CODE[signal.code];
  if (!mapped) {
    return defaultCopy(signal);
  }
  return {
    badgeLabel: BADGE_LABEL,
    code: signal.code,
    ...mapped,
  };
}

export function shouldShowInReviewStallBadge(task: Pick<Task, "column" | "paused" | "inReviewStall">): boolean {
  return task.column === "in-review" && task.paused !== true && task.inReviewStall != null;
}
