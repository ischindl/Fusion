/*
FNXC:ZeroCommitWorkspaceDelivery 2026-09-30-20:55 (RUFU-451):
A workspace card whose own plan declares `noCommitsExpected` delivers without commits, so git showing
"no branch, no landedSha" is the expected shape — not lost work. Before this change the workspace
partial-land sweep parked exactly that card `failed`, and because `getTaskMergeBlocker` is the single
merge authority every door and stall classifier consults, one write refused the automatic merge, the
operator's manual `in-review → done` drag (`409 code=merge-blocked`), and every recovery lane at once.
Measured live on SANE-509: source-free File Scope, both member branches at zero unique commits, review
re-executed green against a pinned harness, card frozen.

Per FN-5893 these cases assert the invariant on EVERY surface that reads the authority, not the one
reported repro:
  • the merge door itself (`getTaskMergeBlocker`), including the lane-agnostic call shape moves.ts uses;
  • the recovery door (`getTaskHardMergeBlocker`);
  • the canonical stall derivation (`deriveTaskStallReason` → `merge-blocker`);
  • the review-lane stall classifier (`getInReviewStallReason`);
  • the recognition predicate's own boundaries (flag absent/false/true, unrelated error text,
    non-failed status).
The controls matter as much as the waiver: a commit-expected card, a card whose park error was
overwritten by an unrelated failure, and a paused card must all keep refusing.
*/
import { describe, expect, it } from "vitest";
import {
  getTaskHardMergeBlocker,
  getTaskMergeBlocker,
} from "../merge/task-merge.js";
import {
  hasZeroCommitDeliveryAuthorization,
  isWorkspacePartialLandParkError,
  isZeroCommitWorkspaceLandPark,
  WORKSPACE_PARTIAL_LAND_EVIDENCE_UNAVAILABLE_PREFIX,
  WORKSPACE_PARTIAL_LAND_UNRECOVERABLE_PREFIX,
} from "../merge/zero-commit-landing-proof.js";
import { deriveTaskStallReason } from "../tasks/task-stall-reason.js";
import { getInReviewStallReason } from "../tasks/in-review-stall.js";
import type { StepStatus, Task } from "../types.js";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");

/** The two sentences the workspace partial-land sweep writes when it parks a card. */
const FORK_A_PARK = `${WORKSPACE_PARTIAL_LAND_UNRECOVERABLE_PREFIX} sub-repo(s) lager-2026 have no branch (fusion/sane-509) and no landedSha — manual intervention required.`;
const STARVATION_PARK = `${WORKSPACE_PARTIAL_LAND_EVIDENCE_UNAVAILABLE_PREFIX} branch state could not be read after 3 sweeps for sub-repo(s) lager-manager — manual intervention required.`;

function reviewTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "SANE-509",
    column: "in-review",
    paused: false,
    status: undefined as string | undefined,
    error: undefined as string | undefined,
    steps: [{ name: "implement", status: "done" }] as Array<{ name: string; status: StepStatus }>,
    workflowStepResults: undefined,
    // A review card normally still holds its checkout. The review-lane classifier checks content arms
    // in order, so without this it answers `no-worktree-no-merge-confirmed` before it ever reaches the
    // merge authority — which would make the classifier case below assert nothing.
    worktree: "/tmp/fusion-rufu-451-review",
    createdAt: new Date(NOW - 3_600_000).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  } as unknown as Task;
}

describe("zero-commit workspace land park recognition", () => {
  it("recognizes both park sentences and nothing else", () => {
    expect(isWorkspacePartialLandParkError(FORK_A_PARK)).toBe(true);
    expect(isWorkspacePartialLandParkError(STARVATION_PARK)).toBe(true);
    // A later unrelated failure that overwrote the park is not this class.
    expect(isWorkspacePartialLandParkError("merge conflict during squash")).toBe(false);
    // The retryable partial-land sentence (a different writer, a different contract) is not a park.
    expect(isWorkspacePartialLandParkError("Workspace partial land: 1 of 2 repositories landed")).toBe(false);
    expect(isWorkspacePartialLandParkError(undefined)).toBe(false);
    expect(isWorkspacePartialLandParkError(null)).toBe(false);
  });

  it("treats only an explicit noCommitsExpected as authorization", () => {
    expect(hasZeroCommitDeliveryAuthorization({ noCommitsExpected: true })).toBe(true);
    expect(hasZeroCommitDeliveryAuthorization({ noCommitsExpected: false })).toBe(false);
    expect(hasZeroCommitDeliveryAuthorization({})).toBe(false);
  });

  it("pairs the authorization with the failed status and the park sentence", () => {
    expect(isZeroCommitWorkspaceLandPark({ status: "failed", error: FORK_A_PARK, noCommitsExpected: true })).toBe(true);
    expect(isZeroCommitWorkspaceLandPark({ status: "failed", error: STARVATION_PARK, noCommitsExpected: true })).toBe(true);
    expect(isZeroCommitWorkspaceLandPark({ status: "failed", error: FORK_A_PARK, noCommitsExpected: false })).toBe(false);
    expect(isZeroCommitWorkspaceLandPark({ status: "failed", error: FORK_A_PARK })).toBe(false);
    expect(isZeroCommitWorkspaceLandPark({ status: "failed", error: "merge conflict during squash", noCommitsExpected: true })).toBe(false);
    expect(isZeroCommitWorkspaceLandPark({ status: "stale", error: FORK_A_PARK, noCommitsExpected: true })).toBe(false);
  });
});

describe("getTaskMergeBlocker — zero-commit workspace park", () => {
  it("does not refuse the automatic merge door on the park alone", () => {
    const task = reviewTask({ status: "failed", error: FORK_A_PARK, noCommitsExpected: true });
    expect(getTaskMergeBlocker(task, { skipColumnIdentityCheck: true })).toBeUndefined();
  });

  it("does not refuse the lane-resolved call shape that moves.ts uses for review → complete", () => {
    const task = reviewTask({ status: "failed", error: STARVATION_PARK, noCommitsExpected: true });
    expect(getTaskMergeBlocker(task, { reviewColumns: new Set(["in-review"]) })).toBeUndefined();
  });

  it("lets the recovery door answer the same way as the merge door", () => {
    const task = reviewTask({ status: "failed", error: FORK_A_PARK, noCommitsExpected: true });
    expect(getTaskHardMergeBlocker(task, { reviewColumns: new Set(["in-review"]) })).toBeUndefined();
  });

  it("control: a commit-expected card keeps the blocking-status refusal verbatim", () => {
    for (const noCommitsExpected of [false, undefined]) {
      const task = reviewTask({ status: "failed", error: FORK_A_PARK, noCommitsExpected });
      expect(getTaskMergeBlocker(task, { skipColumnIdentityCheck: true })).toBe(
        `task is marked 'failed': ${FORK_A_PARK}`,
      );
    }
  });

  it("control: a park overwritten by an unrelated failure still refuses", () => {
    const task = reviewTask({ status: "failed", error: "merge worktree disappeared", noCommitsExpected: true });
    expect(getTaskMergeBlocker(task, { skipColumnIdentityCheck: true })).toBe(
      "task is marked 'failed': merge worktree disappeared",
    );
  });

  it("control: the waiver never lifts an operator pause or an unapproved gate", () => {
    const paused = reviewTask({ status: "failed", error: FORK_A_PARK, noCommitsExpected: true, paused: true });
    expect(getTaskMergeBlocker(paused, { skipColumnIdentityCheck: true })).toBe("task is paused");

    const rejectedReview = {
      workflowStepId: "code-review",
      status: "failed",
      startedAt: new Date(NOW - 60_000).toISOString(),
      completedAt: new Date(NOW - 30_000).toISOString(),
      output: "",
      notes: "",
      phase: "pre-merge" as const,
    };
    const rejected = reviewTask({
      status: "failed",
      error: FORK_A_PARK,
      noCommitsExpected: true,
      workflowStepResults: [rejectedReview] as Task["workflowStepResults"],
    });
    expect(getTaskMergeBlocker(rejected, {
      skipColumnIdentityCheck: true,
      requiredPreMergeStepIds: new Set(["code-review"]),
    })).toBeDefined();
  });
});

describe("stall classification — zero-commit workspace park", () => {
  it("the canonical derivation reports no stall for the waived card", async () => {
    const task = reviewTask({ status: "failed", error: FORK_A_PARK, noCommitsExpected: true });
    await expect(deriveTaskStallReason(task, { now: NOW })).resolves.toBeUndefined();
  });

  it("control: the same card without the authorization still stalls as merge-blocker", async () => {
    const task = reviewTask({ status: "failed", error: FORK_A_PARK, noCommitsExpected: false });
    const stall = await deriveTaskStallReason(task, { now: NOW });
    expect(stall?.code).toBe("merge-blocker");
    expect(stall?.reason).toBe(`task is marked 'failed': ${FORK_A_PARK}`);
  });

  it("the review-lane classifier stops calling the waived card merge-blocker", () => {
    const waived = reviewTask({ status: "failed", error: STARVATION_PARK, noCommitsExpected: true });
    // The card may still be counted by an unrelated arm (this fixture carries no worktree, so the
    // worktree/merge-confirmed arm answers) — the invariant under test is narrower: the refusal that
    // froze the card came from the merge door, so `merge-blocker` must be gone.
    expect(getInReviewStallReason(waived, { reviewColumns: new Set(["in-review"]) })?.code).not.toBe("merge-blocker");

    const control = reviewTask({ status: "failed", error: STARVATION_PARK, noCommitsExpected: false });
    expect(getInReviewStallReason(control, { reviewColumns: new Set(["in-review"]) })?.code).toBe("merge-blocker");
  });
});
