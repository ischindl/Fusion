import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { createTaskRetryTool } from "../agent-tools.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-9317",
    description: "Recover an admitted merge retry",
    dependencies: [],
    column: "in-review",
    steps: [{ id: "step-1", title: "Implement", status: "done" }],
    currentStep: 0,
    log: [],
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    status: null,
    mergeRetries: 0,
    ...overrides,
  } as Task;
}

function atomicStore(task: Task) {
  return vi.fn(async (_id: string, mutate: (current: Task) => Partial<Task> | null | Promise<Partial<Task> | null>) => {
    const patch = await mutate(task);
    return patch ? { ...task, ...patch } : task;
  });
}

describe("createTaskRetryTool", () => {
  it("keeps a completed status-none review task in review and resets its merge recovery state", async () => {
    const completedReviewTask = task();
    const updateTask = vi.fn().mockResolvedValue(completedReviewTask);
    const logEntry = vi.fn().mockResolvedValue(undefined);
    const moveTask = vi.fn();
    const updateTaskAtomic = atomicStore(completedReviewTask);
    const resetInReviewMergeRetry = vi.fn().mockResolvedValue("reset");
    const store = {
      getTask: vi.fn().mockResolvedValue(completedReviewTask),
      getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
      updateTask,
      updateTaskAtomic,
      logEntry,
      moveTask,
    } as unknown as TaskStore;

    const result = await createTaskRetryTool(store, { resetInReviewMergeRetry }).execute(
      "run", { id: completedReviewTask.id }, undefined as never, undefined as never, undefined as never,
    );

    expect((result as { isError?: boolean }).isError).not.toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Retried FN-9317 in review");
    expect(resetInReviewMergeRetry).toHaveBeenCalledWith(completedReviewTask);
    expect(updateTaskAtomic).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(logEntry).toHaveBeenCalledWith("FN-9317", expect.stringContaining("in-review merge retry"));
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("re-seeds a failed no-verdict review through the ProjectEngine fence without resetting merge state", async () => {
    const noVerdictTask = task({
      workflowStepResults: [{
        workflowStepId: "code-review",
        status: "failed",
        phase: "pre-merge",
        findings: [{ id: "fn-9372-unfixed-pipeline-smoke", severity: "critical" }],
      }],
    });
    const resetInReviewMergeRetry = vi.fn();
    const rerouteFailedNoVerdictPreMergeReview = vi.fn().mockResolvedValue("rerouted");
    const logEntry = vi.fn().mockResolvedValue(undefined);
    const store = {
      getTask: vi.fn().mockResolvedValue(noVerdictTask),
      getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
      logEntry,
    } as unknown as TaskStore;

    const result = await createTaskRetryTool(store, {
      resetInReviewMergeRetry,
      rerouteFailedNoVerdictPreMergeReview,
    }).execute("run", { id: noVerdictTask.id }, undefined as never, undefined as never, undefined as never);

    expect((result as { isError?: boolean }).isError).not.toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("failed review re-seeded");
    expect(rerouteFailedNoVerdictPreMergeReview).toHaveBeenCalledWith(noVerdictTask);
    expect(resetInReviewMergeRetry).not.toHaveBeenCalled();
    expect(logEntry).toHaveBeenCalledWith(noVerdictTask.id, expect.stringContaining("failed no-verdict"));
  });

  it("refuses a no-verdict retry when ProjectEngine observes a selection race before queue admission", async () => {
    const noVerdictTask = task({
      workflowStepResults: [{
        workflowStepId: "code-review",
        status: "failed",
        phase: "pre-merge",
        findings: [{ id: "fn-9372-unfixed-pipeline-smoke", severity: "critical" }],
      }],
    });
    const resetInReviewMergeRetry = vi.fn();
    const rerouteFailedNoVerdictPreMergeReview = vi.fn().mockImplementation(async () => {
      await Promise.resolve();
      return "changed";
    });
    const logEntry = vi.fn();
    const store = {
      getTask: vi.fn().mockResolvedValue(noVerdictTask),
      getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
      logEntry,
      seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(),
    } as unknown as TaskStore;

    const result = await createTaskRetryTool(store, {
      resetInReviewMergeRetry,
      rerouteFailedNoVerdictPreMergeReview,
    }).execute("run", { id: noVerdictTask.id }, undefined as never, undefined as never, undefined as never);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("ownership is unavailable, active, or changed");
    expect(resetInReviewMergeRetry).not.toHaveBeenCalled();
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    expect(logEntry).not.toHaveBeenCalled();
  });

  it("refuses a status-none retry while ProjectEngine still owns the queued merge", async () => {
    const queuedMergeTask = task();
    const updateTask = vi.fn();
    const logEntry = vi.fn();
    const updateTaskAtomic = vi.fn();
    const isMergePending = vi.fn().mockResolvedValue(true);
    const resetInReviewMergeRetry = vi.fn().mockResolvedValue("pending");
    const store = {
      getTask: vi.fn().mockResolvedValue(queuedMergeTask),
      getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
      updateTask,
      updateTaskAtomic,
      logEntry,
    } as unknown as TaskStore;

    const result = await createTaskRetryTool(store, { isMergePending, resetInReviewMergeRetry }).execute(
      "run", { id: queuedMergeTask.id }, undefined as never, undefined as never, undefined as never,
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("merge is queued or active");
    expect(resetInReviewMergeRetry).toHaveBeenCalledWith(queuedMergeTask);
    expect(isMergePending).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(updateTaskAtomic).not.toHaveBeenCalled();
    expect(logEntry).not.toHaveBeenCalled();
  });

  it("refuses a completed status-none review card held for manual merge", async () => {
    const manualReviewTask = task({ autoMerge: false });
    const updateTask = vi.fn();
    const logEntry = vi.fn();
    const moveTask = vi.fn();
    const store = {
      getTask: vi.fn().mockResolvedValue(manualReviewTask),
      getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
      updateTask,
      logEntry,
      moveTask,
    } as unknown as TaskStore;

    const result = await createTaskRetryTool(store).execute(
      "run", { id: manualReviewTask.id }, undefined as never, undefined as never, undefined as never,
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("not in a retryable state");
    expect(updateTask).not.toHaveBeenCalled();
    expect(logEntry).not.toHaveBeenCalled();
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("fails closed when chat lacks ProjectEngine merge ownership", async () => {
    const completedReviewTask = task();
    const updateTaskAtomic = vi.fn();
    const store = {
      getTask: vi.fn().mockResolvedValue(completedReviewTask),
      getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
      updateTaskAtomic,
      logEntry: vi.fn(),
    } as unknown as TaskStore;

    const result = await createTaskRetryTool(store).execute("run", { id: completedReviewTask.id }, undefined as never, undefined as never, undefined as never);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("authoritative merge ownership is unavailable");
    expect(updateTaskAtomic).not.toHaveBeenCalled();
  });

  /*
  FNXC:TaskRetrySurfaceSeparation 2026-09-22-10:14 (RUFU-261):
  Chat Retry is the third operator Retry surface, and it releases a failed card rather than parking
  it — by a different mechanism than the CLI surfaces, which state the release explicitly
  (`parkOnHold: false`) because they keep `moveSource: "user"` for attribution. This surface passes
  NO move options at all, so `moveTask` derives `moveSource: "engine"` and the hold-lane park
  predicate (`moveSource === "user"`) can never fire. Pinning the absence of a park-producing source
  is the contract: adding operator attribution here later would silently make chat Retry the same
  self-defeating park RUFU-261 removed, and no other case in this file exercises the re-queue branch.
  */
  it("re-queues a failed task without a park-producing move source", async () => {
    const failedTask = task({ column: "in-progress", status: "failed", error: "boom", userPaused: true, paused: true });
    const updateTask = vi.fn().mockResolvedValue(failedTask);
    const moveTask = vi.fn().mockResolvedValue(failedTask);
    const logEntry = vi.fn().mockResolvedValue(undefined);
    const store = {
      getTask: vi.fn().mockResolvedValue(failedTask),
      getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
      getSettings: vi.fn().mockResolvedValue({}),
      updateTask,
      moveTask,
      logEntry,
    } as unknown as TaskStore;

    const result = await createTaskRetryTool(store).execute(
      "run", { id: failedTask.id }, undefined as never, undefined as never, undefined as never,
    );

    expect((result as { isError?: boolean }).isError).not.toBe(true);
    expect(updateTask).toHaveBeenCalledWith(failedTask.id, { status: null, error: null });
    expect(moveTask).toHaveBeenCalledTimes(1);
    const [, targetColumn, moveOptions] = moveTask.mock.calls[0] as [
      string,
      string,
      { moveSource?: string; parkOnHold?: boolean } | undefined,
    ];
    // The rebound destination (the board's hold lane, legacy `todo` when the workflow is unreadable)
    // is the parking lane, so the move's source is the only thing keeping this card dispatchable.
    expect(typeof targetColumn).toBe("string");
    expect(targetColumn.length).toBeGreaterThan(0);
    expect(moveOptions?.moveSource).not.toBe("user");
    expect(moveOptions?.parkOnHold).not.toBe(true);
    // Three-argument call: the third is the "Task reset to <lane> for retry" detail, so the row is
    // auditable with the destination it actually landed in.
    expect(logEntry.mock.calls[0][0]).toBe(failedTask.id);
    expect(logEntry.mock.calls[0][1]).toBe("Retry requested via chat tool");
    expect(String(logEntry.mock.calls[0][2])).toContain(targetColumn);
  });

  it("refuses when the ProjectEngine-owned reset fence observes a merge admission", async () => {
    const completedReviewTask = task();
    const resetInReviewMergeRetry = vi.fn().mockResolvedValue("pending");
    const logEntry = vi.fn();
    const store = {
      getTask: vi.fn().mockResolvedValue(completedReviewTask),
      getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
      logEntry,
    } as unknown as TaskStore;

    const result = await createTaskRetryTool(store, { resetInReviewMergeRetry }).execute("run", { id: completedReviewTask.id }, undefined as never, undefined as never, undefined as never);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("merge is queued or active");
    expect(resetInReviewMergeRetry).toHaveBeenCalledWith(completedReviewTask);
    expect(logEntry).not.toHaveBeenCalled();
  });

  /*
  FNXC:StrandedGateRetry 2026-10-13-04:55 (STAS-299 req 4 + Invariant C):
  The chat tool is the retry an in-session agent can reach, and for STAS-281 it answered "not in a
  retryable state (status: none)" — because this tool, like the board and the CLI, keyed retryability
  on a card-level failure while self-heal's damage sat in a step row. The card had an approved plan and
  a full step list; there was nothing an agent could do except park.

  These cases pin both halves of the fix on this surface: the shape is admitted whether or not the card
  carries the post-fix `failed` status, and discharging it changes exactly the failure state and the
  verdict-less gate rows — no lane move, no discarded plan, steps, work, or worktree.
  */
  const strandedPlanGateTask = (overrides: Partial<Task> = {}) => task({
    column: "todo",
    status: null,
    approvedPlanFingerprint: "7a73aaff",
    steps: [
      { id: "step-1", title: "Preflight", status: "done" },
      { id: "step-2", title: "Await the plan-review verdict", status: "pending" },
    ],
    currentStep: 1,
    worktree: "/tmp/fusion-stranded-worktree",
    branch: "fusion/FN-9317",
    workflowStepResults: [{
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      phase: "pre-merge",
      source: "optional-group",
      status: "failed",
      reviewKind: "plan",
      startedAt: "2026-09-24T00:16:39.000Z",
      output: "Pending step result had no live session or lease; marked failed by self-healing (FN-8492).",
    }],
    ...overrides,
  } as Partial<Task>);

  function strandedStore(stranded: Task) {
    const updateTask = vi.fn().mockResolvedValue(stranded);
    const logEntry = vi.fn().mockResolvedValue(undefined);
    const moveTask = vi.fn();
    const store = {
      getTask: vi.fn().mockResolvedValue(stranded),
      getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
      updateTask,
      updateTaskAtomic: vi.fn(),
      logEntry,
      moveTask,
    } as unknown as TaskStore;
    return { store, updateTask, logEntry, moveTask };
  }

  it.each([["the post-fix card self-heal parked as failed", { status: "failed", error: "1 workflow step result(s) marked failed by self-healing (FN-8492)" }], ["the card stranded before the lifecycle fix, which carried no status", {}]])(
    "discharges a hold-lane verdict-less plan gate in place — %s", async (_name, overrides) => {
      const stranded = strandedPlanGateTask(overrides);
      const { store, updateTask, logEntry, moveTask } = strandedStore(stranded);

      const result = await createTaskRetryTool(store, {}).execute("run", { id: stranded.id }, undefined as never, undefined as never, undefined as never);

      expect((result as { isError?: boolean }).isError).not.toBe(true);
      expect((result.content[0] as { text: string }).text).toContain("gate row(s) were discharged");

      const patch = updateTask.mock.calls[0][1] as Record<string, unknown>;
      expect(updateTask.mock.calls[0][0]).toBe(stranded.id);
      expect(patch.status).toBeNull();
      expect(patch.error).toBeNull();
      // The gate row is dropped, not re-armed to `pending`: a `pending` row reads as in-flight work.
      expect(patch.workflowStepResults).toEqual([]);
      // Invariant C: the approved plan, its step list and the work itself are not inputs to this retry.
      for (const destructive of ["steps", "currentStep", "approvedPlanFingerprint", "planDoc", "worktree", "branch", "baseBranch", "baseCommitSha"]) {
        expect(patch, destructive).not.toHaveProperty(destructive);
      }
      // The card stays where it is — a hold lane is already the lane a re-queue would target, and
      // RUFU-261 exists because a move into a hold lane can park the card the retry was asked to run.
      expect(moveTask).not.toHaveBeenCalled();
      expect(logEntry).toHaveBeenCalledWith(stranded.id, expect.stringContaining("gate row(s) discharged in todo"));
    },
  );
});

/*
FNXC:PlanningStrandedRetry 2026-11-10-22:55 (RUFU-575, chat-tool surface of four):
The second half of "an agent-reachable Retry exists" is THIS tool: it is what a running agent calls. Its
status gate accepted neither of the two cards this task was filed from - SANE-282 (`queued`) and SANE-524
(`needs-replan`), each parked in its planning lane carrying
`Specification failed after 3 transient errors: Request timed out.` - so the card had no way back at all
while the provider episode that killed its spec run was already over.

The classification itself is proven in `planning-stranded-retry.test.ts` (core) and against a real
PostgreSQL row at the CLI and extension surfaces; what is specific to this surface is WHERE the check
sits. It is hoisted above the status gate rather than nested in its refusal arm, and the third case below
is what that placement buys: a legacy `PLANNING_FAILED_EXHAUSTED:` park IS `failed`, so a check inside the
refusal arm would have let it fall through to the generic path below - which clears the status to `null`
and MOVES the card - while the CLI re-armed the identical row without moving it.
*/
describe("createTaskRetryTool — planning-stranded re-arm", () => {
  const SPEC_TIMEOUT_ERROR = "Specification failed after 3 transient errors: Request timed out.";
  const LEGACY_PARK_ERROR = "PLANNING_FAILED_EXHAUSTED: specification failed 3 times - last error: Request timed out.";

  function planningStrandedTask(overrides: Partial<Task> = {}): Task {
    return task({
      id: "SANE-282",
      column: "todo",
      status: "queued",
      error: SPEC_TIMEOUT_ERROR,
      steps: [{ id: "step-1", title: "Preflight", status: "pending" }],
      currentStep: 0,
      /* A real `TaskPlanningFailureState` shape (`lifecycleLockTransport` is one of its named markers),
         so the fixture states the intent the patch must clear rather than inventing a key. */
      planningFailure: {
        lifecycleLockTransport: {
          message: "Request timed out.",
          at: new Date(Date.now() - 86_400_000).toISOString(),
          attempt: 3,
        },
      },
      recoveryRetryCount: 3,
      nextRecoveryAt: new Date(Date.now() - 86_400_000).toISOString(),
      mergeRetries: 2,
      worktree: "/tmp/fusion-planning-stranded-worktree",
      branch: "fusion/SANE-282",
      baseBranch: "main",
      ...overrides,
    } as Partial<Task>) as Task;
  }

  /** A store that APPLIES the patch, so the assertions below read the resulting row, not a call log. */
  function applyingStore(seed: Task) {
    let row = { ...seed };
    const updateTask = vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      row = { ...row, ...patch } as Task;
      return row;
    });
    const logEntry = vi.fn().mockResolvedValue(undefined);
    const moveTask = vi.fn();
    const store = {
      getTask: vi.fn(async () => row),
      getTaskWorkflowSelection: vi.fn().mockReturnValue(undefined),
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true }),
      updateTask,
      updateTaskAtomic: vi.fn(),
      logEntry,
      moveTask,
    } as unknown as TaskStore;
    return { store, updateTask, logEntry, moveTask, read: () => row };
  }

  it.each([
    ["SANE-282, parked `queued` with the incident marker", { status: "queued", error: SPEC_TIMEOUT_ERROR }],
    ["SANE-524, parked `needs-replan` with the incident marker", { status: "needs-replan", error: SPEC_TIMEOUT_ERROR }],
    ["the post-FN-9512 shape, `queued` with no error and an escalated-reseed disposition", { status: "queued", error: null, recoveryDisposition: "escalated-reseed" }],
    ["a legacy `PLANNING_FAILED_EXHAUSTED:` park, which carries a `failed` status", { status: "failed", error: LEGACY_PARK_ERROR }],
  ])("re-arms planning in place for %s", async (_name, overrides) => {
    const stranded = planningStrandedTask(overrides as Partial<Task>);
    const { store, moveTask, logEntry, read } = applyingStore(stranded);

    const result = await createTaskRetryTool(store, {}).execute("run", { id: stranded.id }, undefined as never, undefined as never, undefined as never);

    expect((result as { isError?: boolean }).isError).not.toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("re-armed to needs-replan");

    const after = read();
    expect(after.status).toBe("needs-replan");
    expect(after.error ?? null).toBeNull();
    expect(after.planningFailure ?? null).toBeNull();
    expect(after.recoveryDisposition ?? null).toBeNull();
    expect(after.recoveryRetryCount ?? null).toBeNull();
    expect(after.mergeRetries).toBe(0);
    // The card stays put: its planning lane is already the lane the planner works in.
    expect(after.column).toBe("todo");
    expect(moveTask).not.toHaveBeenCalled();
    expect(logEntry).toHaveBeenCalledWith(stranded.id, expect.stringContaining("planning run exhausted in todo"));
  });

  it("writes none of the fields whose preservation is the point of the class", async () => {
    /*
    FNXC:PlanningStrandedRetry 2026-11-10-23:58 (RUFU-575):
    Why F4 (no `PROMPT.md`) and F5 (seed-only body) are not fixtures on THIS surface while they are on the
    other three: the chat tool decides from the row and the workflow IR and has no task directory in this
    seam, so a file-state test here could not fail even if the gate regressed - the classification takes
    `{task, ir, now?}` (arity-pinned in `planning-stranded-retry.test.ts`), and the assertion below is the
    matching structural proof that this surface neither reads nor writes the specification. The destructive
    risk was the board's unlink, and that one is proven on the board surface with real bytes on disk.
    */
    const stranded = planningStrandedTask();
    const { store, updateTask } = applyingStore(stranded);

    await createTaskRetryTool(store, {}).execute("run", { id: stranded.id }, undefined as never, undefined as never, undefined as never);

    const patch = updateTask.mock.calls[0][1] as Record<string, unknown>;
    expect(patch.status).toBe("needs-replan");
    /* A spec/lane/worktree key here would make the retry destructive no matter what the surface does.
       Deleting `PROMPT.md` is what the BOARD used to do to exactly this row. */
    for (const destructive of ["column", "steps", "currentStep", "promptContent", "worktree", "branch", "baseBranch", "baseCommitSha", "sessionFile", "workflowStepResults", "approvedPlanFingerprint"]) {
      expect(patch, destructive).not.toHaveProperty(destructive);
    }
  });

  it("still refuses a capacity-throttled queued card, which is progressing rather than stranded", async () => {
    const throttled = planningStrandedTask({ error: "maxConcurrent capacity exhausted: used=12/12" });
    const { store, updateTask, moveTask } = applyingStore(throttled);

    const result = await createTaskRetryTool(store, {}).execute("run", { id: throttled.id }, undefined as never, undefined as never, undefined as never);

    /* This task's own card logged exactly this line while waiting for a WIP slot. Admitting it would be
       the global reclassification of every `queued` card that this task forbids. */
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("not in a retryable state");
    expect(updateTask).not.toHaveBeenCalled();
    expect(moveTask).not.toHaveBeenCalled();
  });

  /*
  FNXC:ReseedLaneDiscriminator 2026-11-12-15:06 (RUFU-575 code review P0):
  The same row, one field apart. An EXECUTION reseed writes the same cleared error and cadence the
  planning reseed writes, and the scheduler then stamps `queued` on both, so before the lane split this
  card was indistinguishable from a stranded planning run to every reader of the row. It keeps its
  finished spec by being refused.
  */
  it("refuses an execution-reseeded card the scheduler queued, while the planning reseed row stays admitted", async () => {
    const executionReseeded = planningStrandedTask({
      status: "queued",
      error: null,
      recoveryRetryCount: null,
      nextRecoveryAt: null,
      recoveryDisposition: "escalated-execution-reseed",
    });
    const { store, updateTask, moveTask } = applyingStore(executionReseeded);

    const result = await createTaskRetryTool(store, {}).execute("run", { id: executionReseeded.id }, undefined as never, undefined as never, undefined as never);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("not in a retryable state (status: queued)");
    expect(updateTask).not.toHaveBeenCalled();
    expect(moveTask).not.toHaveBeenCalled();

    // The control: swap only the author of the diagnostic and the same verb re-arms planning.
    const planningReseeded = planningStrandedTask({
      status: "queued",
      error: null,
      recoveryRetryCount: null,
      nextRecoveryAt: null,
      recoveryDisposition: "escalated-reseed",
    });
    const planning = applyingStore(planningReseeded);
    const accepted = await createTaskRetryTool(planning.store, {}).execute("run", { id: planningReseeded.id }, undefined as never, undefined as never, undefined as never);
    expect((accepted.content[0] as { text: string }).text).toContain("re-armed to needs-replan");
  });

  it("leaves a failed card in the review lane on its in-review path rather than re-arming planning", async () => {
    const reviewCard = planningStrandedTask({
      column: "in-review",
      status: "failed",
      error: SPEC_TIMEOUT_ERROR,
      steps: [{ name: "Implement", status: "done" }, { name: "Verify", status: "pending" }],
    });
    const { store, moveTask, read } = applyingStore(reviewCard);

    await createTaskRetryTool(store, {}).execute("run", { id: reviewCard.id }, undefined as never, undefined as never, undefined as never);

    /* The class refuses this card on the COLUMN, so review keeps owning it: the pre-existing path clears
       the status and re-queues, and never stamps `needs-replan`. Asserting the rejected value is the
       point - a column-blind leg in the class would send a mid-flight implementation back to planning. */
    expect(read().status).not.toBe("needs-replan");
    expect(moveTask).toHaveBeenCalled();
  });
});
