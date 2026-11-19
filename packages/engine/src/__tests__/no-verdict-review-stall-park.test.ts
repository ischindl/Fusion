/*
FNXC:NoVerdictStallParkAdmission 2026-09-28-09:15 (RUFU-391):
The saneca shape: a workspace `in-review` card whose Code Review session died before authoring a
verdict, then parked itself with `in-review-stall-deadlock`. Two guards made that park permanent —
the recovery sweep skipped `task.paused` blanket, and the seed lane refused workspace cards. These
tests pin both halves of the fix plus the operator holds that must stay refused.
*/
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  getBuiltinWorkflow,
  IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
  resolveRequiredPreMergeStepIds,
  type Task,
  type WorkflowStepResult,
} from "@fusion/core";
import { resolvePreMergeGateForTask } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import { rerouteFailedNoVerdictPreMergeGateToReview } from "../merge/pre-merge-gate-reseed.js";
import {
  SWEEP_CANDIDATE_FAILURE_EVENT,
  SWEEP_PASS_FAILURE_EVENT,
} from "../self-healing/sweep-failure-audit.js";

const IR = getBuiltinWorkflow("builtin:coding")!.ir;
const REQUIRED = resolveRequiredPreMergeStepIds(IR, ["plan-review", "code-review"]);
const PARK_ERROR = "In-review stall deadlock: completed-review-status-none repeated 3× without progress. Completed review task has no merge owner or status for >= 5 min";

const approvedPlanRow = (): WorkflowStepResult => ({
  workflowStepId: "plan-review",
  workflowStepName: "Plan Review",
  status: "passed",
  verdict: "APPROVE",
  reviewKind: "plan",
  startedAt: "2026-09-23T14:00:00.000Z",
  completedAt: "2026-09-23T14:00:00.000Z",
});

const lostCodeReviewRow = (): WorkflowStepResult => ({
  workflowStepId: "code-review",
  workflowStepName: "Code Review",
  status: "failed",
  reviewKind: "code",
  startedAt: "2026-09-26T12:38:28.456Z",
  completedAt: "2026-09-26T12:41:14.089Z",
});

function parkedWorkspaceCard(overrides: Partial<Task> = {}): Task {
  return {
    id: "SANE-454",
    column: "in-review",
    status: "failed",
    error: PARK_ERROR,
    paused: true,
    userPaused: false,
    pausedReason: IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
    worktree: null,
    branch: "fusion/sane-454",
    workspaceWorktrees: { saneca: { worktreePath: "/tmp/sane-454", branch: "fusion/sane-454" } },
    repositoryScope: { state: "confirmed", revision: 1, repositories: ["saneca"] },
    enabledWorkflowSteps: ["plan-review", "code-review"],
    workflowStepResults: [approvedPlanRow(), lostCodeReviewRow()],
    steps: [{ id: 0, status: "done" }, { id: 1, status: "done" }],
    log: [],
    updatedAt: "2026-09-26T12:41:14.089Z",
    ...overrides,
  } as unknown as Task;
}

function sweepStore(cards: Task[]): EventEmitter & Record<string, any> {
  /*
  FNXC:SweepFailureAudit 2026-11-18-17:29 (RUFU-898):
  Rows are now CAPTURED, not just accepted, because the symptom RUFU-898 removes is only assertable
  against a row: "the pass died" must be a query, and the existing `toHaveBeenCalledWith` assertions
  here keep working unchanged.
  */
  const auditRows: Array<Record<string, unknown>> = [];
  const store = Object.assign(new EventEmitter(), {
    auditRows,
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
    listTasks: vi.fn(async (options?: { column?: string }) => (options?.column === "in-review" ? cards : [])),
    getTask: vi.fn(async (id: string) => cards.find((card) => card.id === id)),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const card = cards.find((entry) => entry.id === id)!;
      Object.assign(card, patch);
      return card;
    }),
    updateTaskAtomic: vi.fn(async (id: string, updater: (current: Task) => Record<string, unknown> | null) => {
      const card = cards.find((entry) => entry.id === id)!;
      const patch = updater(card);
      if (patch) Object.assign(card, patch);
      return card;
    }),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: ["plan-review", "code-review"] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: ["plan-review", "code-review"] })),
    peekMergeQueue: vi.fn(async () => []),
    getMergeRequestRecordAsync: vi.fn(async () => null),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    transitionQueuedEpisode: vi.fn(async () => ({ appended: true })),
    parseFileScopeFromPrompt: vi.fn(async () => []),
    getWorkflowDefinition: vi.fn(async (id: string) => (id === "builtin:coding" ? { ir: IR } : undefined)),
    /* Empty project definition list: the lane vocabulary falls back to its legacy review lane,
       which is what a board with one review column resolves to. */
    listWorkflowDefinitions: vi.fn(async () => []),
    /*
    FNXC:WorkflowPassCacheFixture 2026-11-06-02:36:
    RUFU-584 (`58d561b1c1`) made `SelfHealingManager.batchWorkflowIrCache()` read
    `store.workflowDefinitionEpoch()` unconditionally, so this hand-rolled fake threw on the first cache
    read and `recoverReviewTasksWithFailedPreMergeSteps()`'s outer catch collapsed the whole pass into one
    `log.warn` — all three cases here lost their reroute/seed assertion with no visible cause. Same drift
    class this repo already stubs in `merge-not-run-gate-wedge.test.ts` and
    `in-review-stall-deadlock-disposition.test.ts`: a product store read lands, the fakes do not. A
    constant epoch is the correct fake because no case in this file writes a workflow selection or
    definition mid-pass, so cache invalidation is never the subject.
    */
    workflowDefinitionEpoch: vi.fn(() => 0),
    workflowSelectionEpoch: vi.fn(() => 0),
    logEntry: vi.fn(async () => undefined),
    getAgentLogs: vi.fn(async () => []),
    recordRunAuditEvent: vi.fn(async (row: Record<string, unknown>) => { auditRows.push(row); }),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async () => ({ seeded: true })),
  }) as unknown as EventEmitter & Record<string, any>;
  return store;
}

describe("no-verdict review recovery admits the engine's own stall park", () => {
  it("re-seeds the lost Code Review gate for a stalled WORKSPACE card and lifts the park", async () => {
    const card = parkedWorkspaceCard();
    const store = sweepStore([card]);
    const reroute = vi.fn(async () => "rerouted" as const);

    await new SelfHealingManager(store, {
      rootDir: "/tmp/rufu-391",
      recoverFailedPreMergeStep: vi.fn(async () => false),
      rerouteFailedNoVerdictPreMergeReview: reroute,
    } as never).recoverReviewTasksWithFailedPreMergeSteps();

    // The park no longer disqualifies the card from the recovery that owes it a verdict.
    expect(reroute).toHaveBeenCalledTimes(1);
    expect((reroute.mock.calls[0] as unknown as [Task])[0].id).toBe("SANE-454");
    // And the seed's follow-up clears the park so the re-run can reach the merge door.
    expect(card.paused).toBe(false);
    expect(card.pausedReason).toBeNull();
    expect(card.status).toBeNull();
    expect(card.error).toBeNull();
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:review-no-verdict-park-repaired",
      metadata: expect.objectContaining({ taskId: "SANE-454", outcome: "cleared", workflowStepId: "code-review" }),
    }));
  });

  it.each([
    ["an operator hold", { userPaused: true }],
    ["a different engine pause", { pausedReason: "external-block" }],
    ["a park whose error was overwritten", { error: "Unrelated later failure" }],
    // Control: an un-paused card whose row still carries the park sentence is the ordinary case.
    ["nothing at all", {}],
  ])("leaves the park untouched for %s", async (label, overrides) => {
    const card = parkedWorkspaceCard(overrides as Partial<Task>);
    const store = sweepStore([card]);
    const reroute = vi.fn(async () => "rerouted" as const);

    await new SelfHealingManager(store, {
      rootDir: "/tmp/rufu-391",
      recoverFailedPreMergeStep: vi.fn(async () => false),
      rerouteFailedNoVerdictPreMergeReview: reroute,
    } as never).recoverReviewTasksWithFailedPreMergeSteps();

    if (label === "nothing at all") {
      expect(reroute).toHaveBeenCalledTimes(1);
      expect(card.paused).toBe(false);
    } else {
      expect(reroute).not.toHaveBeenCalled();
      expect(card.paused).toBe(true);
      expect(card.status).toBe("failed");
    }
  });

  /*
  FNXC:NoVerdictStallParkAdmission 2026-09-28-09:15 (RUFU-391): this pass injects NO delegated
  rerouter, so the local fallback runs the real seed lane (content capture + idle-seed primitive)
  against a WORKSPACE card — the shape the old `not-singular` guard refused outright.
  */
  it("runs the real seed lane end-to-end for a stalled workspace card", async () => {
    const card = parkedWorkspaceCard();
    const store = sweepStore([card]);
    const recovered = await new SelfHealingManager(store, {
      rootDir: "/tmp/rufu-391",
      recoverFailedPreMergeStep: vi.fn(async () => false),
    } as never).recoverReviewTasksWithFailedPreMergeSteps();

    /* The sweep's return value counts fixer recoveries only; the observable proof is the seed call
       plus the lifted park. */
    expect(recovered).toBe(0);
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledTimes(1);
    expect(card.paused).toBe(false);
    expect(card.status).toBeNull();
  });

  it("keeps the seed lane honest about what it may admit", async () => {
    const baseStore = (card: Task) => ({
      ...sweepStore([card]),
      getTask: vi.fn(async () => card),
      getTaskWorkflowSelectionAsync: undefined,
    });
    const mergeContent = { kind: "workspace" as const, repositories: { state: "captured" as const, fingerprints: { saneca: "fp" }, inScopeModified: ["saneca"] } };
    const options = { requiredPreMergeStepIds: REQUIRED, mergeContent, expectedWorkflowSelection: "builtin:coding" };

    // A stalled workspace card is seedable.
    const parked = parkedWorkspaceCard();
    await expect(rerouteFailedNoVerdictPreMergeGateToReview(baseStore(parked) as never, parked, options))
      .resolves.toMatchObject({ rerouted: true, nodeId: "code-review" });
    expect(parked.paused).toBe(true); // the seed does not touch pause fields; the sweep clears them

    // An operator hold and a foreign pause stay hard refusals.
    const held = parkedWorkspaceCard({ userPaused: true });
    await expect(rerouteFailedNoVerdictPreMergeGateToReview(baseStore(held) as never, held, options))
      .resolves.toMatchObject({ rerouted: false, reason: "operator-held" });
    const otherPause = parkedWorkspaceCard({ pausedReason: "external-block" });
    await expect(rerouteFailedNoVerdictPreMergeGateToReview(baseStore(otherPause) as never, otherPause, options))
      .resolves.toMatchObject({ rerouted: false, reason: "operator-held" });
    // A park whose error names a later, unrelated failure is not this class either.
    const drifted = parkedWorkspaceCard({ error: "Unrelated later failure" });
    await expect(rerouteFailedNoVerdictPreMergeGateToReview(baseStore(drifted) as never, drifted, options))
      .resolves.toMatchObject({ rerouted: false, reason: "operator-held" });
  });
});

/*
FNXC:SweepFailureAudit 2026-11-18-17:29 (RUFU-898):
The symptom half of this card, on the file whose own FNXC note (WorkflowPassCacheFixture
2026-11-06-02:36) IS the recorded price: a missing store seam threw, this sweep's outer catch collapsed
the entire pass into one console line, and all three assertions above silently lost their meaning "with
no visible cause". RUFU-405 repaired the fake; these cases are the product-side half it left undone.
Each case asserts the row, not a grep: an audit row that leaked the exception sentence would still
satisfy a source read.
*/
const SWEEP_NAME = "recover-review-tasks-with-failed-pre-merge-steps";
const sweepRows = (rows: Array<Record<string, unknown>>) =>
  rows.filter((row) => String(row.mutationType).startsWith("sweep:"));

describe("recoverReviewTasksWithFailedPreMergeSteps — a dead pass is queryable, not mute", () => {
  it("names the pass when a store seam throws before any candidate is reached", async () => {
    const card = parkedWorkspaceCard();
    const store = sweepStore([card]);
    // The exact RUFU-405 shape: a product store read the fake never grew.
    store.workflowDefinitionEpoch = vi.fn(() => { throw new Error("store.workflowDefinitionEpoch is not a function"); });
    const reroute = vi.fn(async () => "rerouted" as const);

    const recovered = await new SelfHealingManager(store, {
      rootDir: "/tmp/rufu-898",
      recoverFailedPreMergeStep: vi.fn(async () => false),
      rerouteFailedNoVerdictPreMergeReview: reroute,
    } as never).recoverReviewTasksWithFailedPreMergeSteps();

    // AC3: the return value the step runner consumes is unchanged by the added observation.
    expect(recovered).toBe(0);
    expect(reroute).not.toHaveBeenCalled();
    const rows = sweepRows(store.auditRows);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      mutationType: SWEEP_PASS_FAILURE_EVENT,
      agentId: "self-healing",
      domain: "database",
      target: SWEEP_NAME,
      metadata: { sweep: SWEEP_NAME, outcome: "aborted", candidateFailureCount: 0 },
    }));
    expect("taskId" in rows[0]!).toBe(false);
    // The pass poisoned nothing: no card write, and no re-seed/park-lift row for the card it never reached.
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
    expect(store.auditRows.some((row) => row.mutationType === "task:review-no-verdict-park-repaired")).toBe(false);
    // The exception sentence stays in the console line and appears nowhere in the row.
    expect(JSON.stringify(rows[0])).not.toContain("is not a function");
  });

  it("names the pass when the board read itself throws", async () => {
    const store = sweepStore([parkedWorkspaceCard()]);
    store.listTasks = vi.fn(async () => { throw new Error("connection terminated"); });

    await expect(new SelfHealingManager(store, {
      rootDir: "/tmp/rufu-898",
      recoverFailedPreMergeStep: vi.fn(async () => false),
    } as never).recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);

    const rows = sweepRows(store.auditRows);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mutationType).toBe(SWEEP_PASS_FAILURE_EVENT);
    expect(JSON.stringify(rows[0])).not.toContain("connection terminated");
  });

  it("names the card and the arm when the no-verdict re-seed seam throws", async () => {
    const card = parkedWorkspaceCard();
    const store = sweepStore([card]);
    const reroute = vi.fn(async () => { throw new Error("continuation insert refused"); });

    const recovered = await new SelfHealingManager(store, {
      rootDir: "/tmp/rufu-898",
      recoverFailedPreMergeStep: vi.fn(async () => false),
      rerouteFailedNoVerdictPreMergeReview: reroute,
    } as never).recoverReviewTasksWithFailedPreMergeSteps();

    expect(recovered).toBe(0);
    const rows = sweepRows(store.auditRows);
    // One candidate row and no pass row: the arm died, the pass finished.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      mutationType: SWEEP_CANDIDATE_FAILURE_EVENT,
      target: "SANE-454",
      taskId: "SANE-454",
      metadata: { sweep: SWEEP_NAME, taskId: "SANE-454", stage: "no-verdict-recovery" },
    }));
    expect(card.paused).toBe(true);
    expect(JSON.stringify(rows[0])).not.toContain("continuation insert refused");
  });

  it("reports a zero row for a healthy pass, which is the point of the whole change", async () => {
    const store = sweepStore([]);

    await expect(new SelfHealingManager(store, {
      rootDir: "/tmp/rufu-898",
      recoverFailedPreMergeStep: vi.fn(async () => false),
    } as never).recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);

    expect(sweepRows(store.auditRows)).toEqual([]);
  });

  /*
  FNXC:SweepFailureAudit 2026-11-18-17:29 (RUFU-898) — AC4:
  A pass that died must poison nothing: the sweep is a maintenance step, so the NEXT pass has to take
  the same card as a candidate and rescue it exactly as the healthy case above does. Run on the SAME
  manager, so a memo left behind by the failed pass would be visible here.
  */
  it("rescues the card on the next pass once the throwing seam is repaired", async () => {
    const card = parkedWorkspaceCard();
    const store = sweepStore([card]);
    const reroute = vi.fn(async () => "rerouted" as const);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/rufu-898",
      recoverFailedPreMergeStep: vi.fn(async () => false),
      rerouteFailedNoVerdictPreMergeReview: reroute,
    } as never);

    store.workflowDefinitionEpoch = vi.fn(() => { throw new Error("transient seam failure"); });
    await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);
    expect(reroute).not.toHaveBeenCalled();
    expect(sweepRows(store.auditRows)).toHaveLength(1);

    store.workflowDefinitionEpoch = vi.fn(() => 0);
    await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);

    // The rescue the healthy test asserts, byte-for-byte: same reroute, park lifted.
    expect(reroute).toHaveBeenCalledTimes(1);
    expect(card.paused).toBe(false);
    expect(card.pausedReason).toBeNull();
    expect(card.status).toBeNull();
    // And the second pass added no new failure row — the healthy pass stays silent.
    expect(sweepRows(store.auditRows)).toHaveLength(1);
  });
});
