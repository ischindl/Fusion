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
  const store = Object.assign(new EventEmitter(), {
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
    logEntry: vi.fn(async () => undefined),
    getAgentLogs: vi.fn(async () => []),
    recordRunAuditEvent: vi.fn(async () => undefined),
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
