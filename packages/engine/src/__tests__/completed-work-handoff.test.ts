import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "@fusion/core";
import { dispatchUnpauseResume } from "../executor/unpause-resume.js";

/*
FNXC:ExecutionReArmCeiling 2026-11-14-16:20 (RUFU-1028):
The completed-work hand-off must stop reading "no merge was recorded" as `!task.mergeDetails`.

Both arms matter, and a test that exercises only one of them proves nothing:

- The card that never merged. RUFU-583's `mergeDetails` carried only recovery bookkeeping (a push-recovery
  attempt and the re-arm episode's old host). Truthiness called that merge-bearing, so the fast path refused to
  hand the finished card to review and it went through a full re-execution — the same misread that drove the
  execute-preflight reset two lines away.
- The card that really did merge. That bounce is RUFU-469's stale-generation guarantee: a card whose landing is
  recorded must NOT be silently handed off as if the previous generation's landing were its own. Removing it
  would trade one bug for a wrong merge.
*/

const EPISODE = {
  signature: "rearm:steps#1:step-execute:x:occupied",
  attempt: 5,
  refusal: 0,
  firstAt: "2026-11-14T15:38:41.000Z",
  at: "2026-11-14T15:52:54.000Z",
  heldAt: "2026-11-14T15:52:54.000Z",
  questionStamp: "steps#1:step-execute|plan-review-none|1",
};

function finishedTask(mergeDetails: Record<string, unknown> | undefined): Task {
  return {
    id: "RUFU-1028-H",
    title: "finished card",
    description: "",
    column: "in-progress",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    deletedAt: null,
    dependencies: [],
    // Every step done or skipped: this is the completed-work shape the fast path is about.
    steps: [{ id: "0", status: "done" }, { id: "1", status: "skipped" }],
    currentStep: 2,
    createdAt: "2026-11-14T00:00:00.000Z",
    updatedAt: "2026-11-14T00:00:00.000Z",
    ...(mergeDetails === undefined ? {} : { mergeDetails: mergeDetails as Task["mergeDetails"] }),
  } as unknown as Task;
}

function harness(task: Task) {
  const empty = new Set<string>();
  const store = {
    listTasks: vi.fn(async () => [task]),
    updateTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
  } as any;
  const deps = {
    store,
    getRunContextFor: () => undefined,
    executing: new Set(empty),
    resumingUnpaused: new Set(empty),
    recoveringCompleted: new Set(empty),
    activeSessions: new Set(empty),
    activeStepExecutors: new Set(empty),
    activeWorkflowStepSessions: new Set(empty),
    graphRouting: new Set(empty),
    approvalSuspended: new Set(empty),
    getExecutionPauseLabel: vi.fn(async () => null),
    recoverCompletedTask: vi.fn(async () => true),
    // The bounce arm is `execute`, not a "resume" helper: the non-fast path re-enters execution.
    execute: vi.fn(async () => undefined),
    recoverApprovedStepsOnResume: vi.fn(async () => undefined),
    clearResumeFailureState: vi.fn(async () => undefined),
  } as any;
  return { deps, store };
}

describe("completed-work hand-off reads merge evidence, not mergeDetails truthiness", () => {
  it("hands off a finished card whose mergeDetails carries only recovery bookkeeping", async () => {
    const task = finishedTask({
      pushRecovery: { target: "origin/main", commitSha: "abc123", nextAttemptAt: "2026-11-14T00:00:00Z" },
      executionRearm: EPISODE,
    });
    const { deps } = harness(task);

    expect(await dispatchUnpauseResume(deps, task)).toBe(true);
    // The hand-off ran. Nothing re-executed the card, which is what the truthiness read used to force.
    expect(deps.recoverCompletedTask).toHaveBeenCalledTimes(1);
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.store.updateTask).not.toHaveBeenCalled();
  });

  it("still bounces a finished card whose row records a real merge", async () => {
    const task = finishedTask({ commitSha: "abc123", landedFiles: ["src/a.ts"], mergeConfirmed: true });
    const { deps } = harness(task);

    expect(await dispatchUnpauseResume(deps, task)).toBe(true);
    // RUFU-469 stays intact: with landing evidence on the row, the completed-work fast path must NOT fire, so
    // the card goes through the normal resume that re-verifies rather than being handed off on stale evidence.
    expect(deps.recoverCompletedTask).not.toHaveBeenCalled();
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });

  it("hands off a finished card with no mergeDetails at all, exactly as before", async () => {
    const task = finishedTask(undefined);
    const { deps } = harness(task);
    expect(await dispatchUnpauseResume(deps, task)).toBe(true);
    expect(deps.recoverCompletedTask).toHaveBeenCalledTimes(1);
  });

  it("does not hand off a card whose work is unfinished even with bookkeeping only", async () => {
    const task = finishedTask({ executionRearm: EPISODE });
    (task as any).steps = [{ id: "0", status: "done" }, { id: "1", status: "in-progress" }];
    const { deps } = harness(task);

    expect(await dispatchUnpauseResume(deps, task)).toBe(true);
    expect(deps.recoverCompletedTask).not.toHaveBeenCalled();
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });
});

/*
FNXC:ExecutionReArmCeiling 2026-11-14-16:20 (RUFU-1028):
STRUCTURAL GUARD, not a symptom test. Four sites read this row and all four had to move together; the reason is
the four-times-fixed history this card cites (FN-5787/5789/5803, FN-5797/5875/5919). A future fifth site that
reaches for `!task.mergeDetails` re-creates the bug in a file no test in this family touches, so the call-site
shape itself is pinned here. Asserting the call site (a code construct) is what this repo allows; asserting
prose would not be.
*/
describe("every completed-work / merge-reset guard routes through the one predicate", () => {
  const sites = [
    "executor/unpause-resume.ts",
    "executor/resume-orphaned.ts",
    "executor/reset-merge-state.ts",
    "executor/run-implementation.ts",
  ];
  const here = new URL("..", import.meta.url).pathname;

  for (const site of sites) {
    it(`${site} asks the predicate`, () => {
      const source = readFileSync(join(here, site), "utf8");
      expect(source).toContain("mergeDetailsCarriesMergeEvidence(");
      // The specific mistake, not all truthiness: a guard that treats the row's bare existence as merge
      // evidence is the shape that misread RUFU-583 and RUFU-278.
      expect(source).not.toMatch(/if\s*\(\s*!task\.mergeDetails\s*\)/);
      expect(source).not.toMatch(/&&\s*!task\.mergeDetails\s*\)/);
    });
  }
});
