/*
FNXC:PlannerOversight 2026-09-15-19:20:
FN-429. The planner's `retryStep` handler discarded the `moveTaskToContainedBackwardTarget` result and
returned `true` unconditionally, so a containment refusal was reported to `PlannerRecoveryController` as a
successful retry. On FN-428 that produced a "retry" claim roughly every 45 seconds while `lifecycle-move`
logged the same refusal and the card never moved. These cases drive the REAL production handler (extracted
from the `ProjectEngine` prototype exactly like the FN-7551 wiring suite) with the lifecycle-move seam
controlled, so every refusal shape returns false with a single deduped diagnostic while a real move still
returns true and emits its retry intervention.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";

const { moveTaskToContainedBackwardTarget } = vi.hoisted(() => ({ moveTaskToContainedBackwardTarget: vi.fn() }));
vi.mock("../execution/lifecycle-move.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../execution/lifecycle-move.js")>();
  return { ...actual, moveTaskToContainedBackwardTarget };
});

/*
FNXC:ExecutionReArm 2026-10-07-16:00 (RUFU-308 Step 3):
RUFU-291 was this handler's OTHER half: containment refused the WIP→todo move, the card was not
`failed` (the stuck-session disposal had already cleared the status), so FN-9359's in-place fence could
not fire either, and the pass ended as a refusal forever. The cases below pin the routing added for
that shape: the refusal hands the card to the SHARED re-arm seam (the same `attemptExecutionRearm` the
graph-failure router calls), a real re-entry counts as a dispatched attempt, and a refusal that
produced no re-entry keeps FN-429 semantics untouched.
*/
const { attemptExecutionRearm } = vi.hoisted(() => ({ attemptExecutionRearm: vi.fn() }));
vi.mock("../executor/execution-rearm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../executor/execution-rearm.js")>();
  return { ...actual, attemptExecutionRearm };
});

import { ProjectEngine } from "../project-engine.js";
import type { PlannerRecoveryHandlers } from "../overseer/planner-recovery-controller.js";

interface EngineInternals {
  plannerLiveRetrySkipLogDedup: Set<string>;
  runtime: { getExecutor: () => { isTaskLiveForOverseerRetry?: (id: string) => boolean } | undefined };
  buildPlannerRecoveryHandlers(store: any): PlannerRecoveryHandlers;
}

function engineInternals(): EngineInternals {
  const engineLike = Object.create(ProjectEngine.prototype) as EngineInternals;
  engineLike.plannerLiveRetrySkipLogDedup = new Set();
  engineLike.runtime = { getExecutor: () => ({ isTaskLiveForOverseerRetry: () => false }) };
  return engineLike;
}

function fakeStore() {
  return {
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(() => ({ id: "evt-1" })),
    getTask: vi.fn(async () => task),
  } as any;
}

const task = { id: "FN-B", column: "in-progress", title: "waiting task" } as any;
const decision = { watchedStage: "executor", reason: "stalled before preflight", attemptCount: 0, attemptLimit: 3, sourceLinks: [] } as any;

describe("planner retryStep honors contained lifecycle recovery (FN-429)", () => {
  beforeEach(() => { moveTaskToContainedBackwardTarget.mockReset(); });

  it.each([
    ["in-place-recovery", { moved: false, reason: "in-place-recovery", column: "in-progress" }],
    ["no-contained-target", { moved: false, reason: "no-contained-target", column: "in-progress" }],
    ["capacity deferral", { moved: false, deferred: "capacity", detail: "destination at capacity" }],
  ] as const)("returns false and logs once for %s", async (_label, result) => {
    moveTaskToContainedBackwardTarget.mockResolvedValue(result);
    const store = fakeStore();
    const handlers = engineInternals().buildPlannerRecoveryHandlers(store);

    const outcomes = [
      await handlers.retryStep!(task, decision, {} as any),
      await handlers.retryStep!(task, decision, {} as any),
      await handlers.retryStep!(task, decision, {} as any),
    ];

    expect(outcomes).toEqual([false, false, false]);
    expect(moveTaskToContainedBackwardTarget).toHaveBeenCalledTimes(3);
    // One durable diagnostic per (taskId, stage, reason) — three 45s polls must not flood the task log.
    expect(store.logEntry.mock.calls.filter((call: any[]) => String(call[1]).includes("retry-not-dispatched"))).toHaveLength(1);
    // No retry intervention: the attempt was never dispatched, so the budget must not be consumed.
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("still returns true and emits the retry intervention when the card really moves", async () => {
    moveTaskToContainedBackwardTarget.mockResolvedValue({ moved: true });
    const store = fakeStore();
    const handlers = engineInternals().buildPlannerRecoveryHandlers(store);

    await expect(handlers.retryStep!(task, decision, {} as any)).resolves.toBe(true);
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "overseer:intervention" }));
    expect(store.logEntry.mock.calls.filter((call: any[]) => String(call[1]).includes("retry-not-dispatched"))).toHaveLength(0);
  });

  it("keeps the live-session refusal ahead of any lifecycle move", async () => {
    const store = fakeStore();
    const internals = engineInternals();
    internals.runtime = { getExecutor: () => ({ isTaskLiveForOverseerRetry: () => true }) };
    const handlers = internals.buildPlannerRecoveryHandlers(store);

    await expect(handlers.retryStep!(task, decision, {} as any)).resolves.toBe(false);
    expect(moveTaskToContainedBackwardTarget).not.toHaveBeenCalled();
  });

  it("never grants backward-move authority to the recovery reason", async () => {
    moveTaskToContainedBackwardTarget.mockResolvedValue({ moved: false, reason: "in-place-recovery", column: "in-progress" });
    const handlers = engineInternals().buildPlannerRecoveryHandlers(fakeStore());
    await handlers.retryStep!(task, decision, {} as any);
    expect(moveTaskToContainedBackwardTarget).toHaveBeenCalledWith(expect.anything(), "FN-B", "self-healing-stranded-recovery", expect.objectContaining({ preserveProgress: true, moveSource: "engine" }), "in-progress");
  });

  /*
  FNXC:ExecutionReArm 2026-10-07-16:00 (RUFU-308 Step 3):
  The stranded-recovery half of `retryStep`. The IR surfaces stay REAL (only the re-arm attempt is
  controlled), so each case also proves the handler names the owner node from the card's own step rows
  rather than assuming one, and that no case reaches `moveTask`.
  */
  describe("stranded executor-stage card gets its step re-armed in place (RUFU-308)", () => {
    const STEPWISE_IR = {
      version: "v2",
      columns: [],
      nodes: [
        { id: "steps", kind: "foreach", config: { source: "task-steps", template: { nodes: [
          { id: "step-execute", kind: "prompt", config: { seam: "step-execute" } },
          { id: "step-review", kind: "prompt", config: { seam: "step-review" } },
        ] } } },
        { id: "code-review", kind: "prompt", config: { seam: "code-review" } },
      ],
      edges: [],
    } as any;

    /** RUFU-291's row shape: the disposal cleared status/error, Step 1 never reached a terminal status. */
    function strandedCard() {
      return {
        ...task,
        status: null,
        error: null,
        steps: [
          { id: "0", title: "Preflight", status: "done" },
          { id: "1", title: "Implementation", status: "in-progress" },
          { id: "2", title: "Tests", status: "pending" },
        ],
      };
    }

    function strandedStore() {
      return {
        ...fakeStore(),
        // Present so every case can prove this path never moves the card through the store either.
        moveTask: vi.fn(async () => undefined),
        getTaskWorkflowSelection: () => ({ workflowId: "builtin:stepwise-coding", stepIds: [] }),
        getWorkflowDefinition: async () => ({ ir: STEPWISE_IR }),
      } as any;
    }

    const refused = { moved: false, reason: "in-place-recovery", column: "in-progress" };
    const refusalDiagnostics = (store: any) => store.logEntry.mock.calls
      .filter((call: any[]) => String(call[1]).includes("retry-not-dispatched"));

    beforeEach(() => { attemptExecutionRearm.mockReset(); });

    it("routes the refusal to the shared re-arm seam and counts the re-entry as a dispatched attempt", async () => {
      moveTaskToContainedBackwardTarget.mockResolvedValue(refused);
      attemptExecutionRearm.mockResolvedValue({ outcome: "rearmed", detail: "resuming steps#1:step-execute" });
      const store = strandedStore();
      const handlers = engineInternals().buildPlannerRecoveryHandlers(store);

      await expect(handlers.retryStep!(strandedCard(), decision, {} as any)).resolves.toBe(true);

      expect(attemptExecutionRearm).toHaveBeenCalledTimes(1);
      expect(attemptExecutionRearm).toHaveBeenCalledWith(
        expect.objectContaining({ store }),
        expect.objectContaining({
          taskId: "FN-B",
          failedNode: "steps#1:step-execute",
          wipColumn: "in-progress",
          reason: "self-healing-stranded-recovery",
        }),
      );
      // Real re-entry is a dispatched attempt: the budget is consumed and no refusal is announced.
      expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "overseer:intervention" }));
      expect(refusalDiagnostics(store)).toHaveLength(0);
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(moveTaskToContainedBackwardTarget).toHaveBeenCalledTimes(1);
    });

    it("counts a lost seed race as owned re-entry rather than a refusal", async () => {
      moveTaskToContainedBackwardTarget.mockResolvedValue(refused);
      attemptExecutionRearm.mockResolvedValue({ outcome: "already-owned", detail: "an active continuation owns it" });
      const store = strandedStore();
      const handlers = engineInternals().buildPlannerRecoveryHandlers(store);

      await expect(handlers.retryStep!(strandedCard(), decision, {} as any)).resolves.toBe(true);
      expect(refusalDiagnostics(store)).toHaveLength(0);
      expect(store.moveTask).not.toHaveBeenCalled();
    });

    it("keeps FN-429 semantics when the re-arm declines for lack of worktree evidence", async () => {
      moveTaskToContainedBackwardTarget.mockResolvedValue(refused);
      attemptExecutionRearm.mockResolvedValue({ outcome: "no-work-evidence", detail: "worktree proves no commit or diff" });
      const store = strandedStore();
      const handlers = engineInternals().buildPlannerRecoveryHandlers(store);

      const outcomes = [await handlers.retryStep!(strandedCard(), decision, {} as any), await handlers.retryStep!(strandedCard(), decision, {} as any)];

      expect(outcomes).toEqual([false, false]);
      expect(refusalDiagnostics(store)).toHaveLength(1);
      expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();
    });

    it("announces a spent re-arm budget once and consumes no attempt", async () => {
      moveTaskToContainedBackwardTarget.mockResolvedValue(refused);
      attemptExecutionRearm.mockResolvedValue({ outcome: "budget-exhausted", detail: "the terminal re-arm park already stands on the card" });
      const store = strandedStore();
      const handlers = engineInternals().buildPlannerRecoveryHandlers(store);

      const outcomes = [await handlers.retryStep!(strandedCard(), decision, {} as any), await handlers.retryStep!(strandedCard(), decision, {} as any)];

      expect(outcomes).toEqual([false, false]);
      expect(refusalDiagnostics(store)).toHaveLength(1);
      expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
      // The park/notice belongs to the re-arm seam, never to this handler.
      expect(store.moveTask).not.toHaveBeenCalled();
    });

    it("does not re-arm a card whose execution session came back live mid-pass", async () => {
      // FN-8471 stays true on the new path: the live check is re-proved immediately before the re-arm,
      // so a session that appears while containment is being decided still wins.
      let live = false;
      moveTaskToContainedBackwardTarget.mockImplementation(async () => { live = true; return refused; });
      attemptExecutionRearm.mockResolvedValue({ outcome: "rearmed", detail: "must not be reached" });
      const internals = engineInternals();
      internals.runtime = { getExecutor: () => ({ isTaskLiveForOverseerRetry: () => live }) };
      const store = strandedStore();
      const handlers = internals.buildPlannerRecoveryHandlers(store);

      await expect(handlers.retryStep!(strandedCard(), decision, {} as any)).resolves.toBe(false);
      expect(attemptExecutionRearm).not.toHaveBeenCalled();
      expect(refusalDiagnostics(store)).toHaveLength(1);
    });

    it("scopes the re-arm authority to the executor stage", async () => {
      moveTaskToContainedBackwardTarget.mockResolvedValue(refused);
      const store = strandedStore();
      const handlers = engineInternals().buildPlannerRecoveryHandlers(store);

      await expect(handlers.retryStep!(strandedCard(), { ...decision, watchedStage: "merger" }, {} as any)).resolves.toBe(false);
      expect(attemptExecutionRearm).not.toHaveBeenCalled();
      expect(refusalDiagnostics(store)).toHaveLength(1);
    });

    it("leaves a card whose workflow declares no executable step owner as a plain refusal", async () => {
      moveTaskToContainedBackwardTarget.mockResolvedValue(refused);
      attemptExecutionRearm.mockResolvedValue({ outcome: "rearmed", detail: "must not be reached" });
      const store = {
        ...strandedStore(),
        getWorkflowDefinition: async () => ({ ir: {
          version: "v2", columns: [], edges: [],
          nodes: [{ id: "code-review", kind: "prompt", config: { seam: "code-review" } }],
        } }),
      } as any;
      const handlers = engineInternals().buildPlannerRecoveryHandlers(store);
      const card = { ...strandedCard(), steps: [{ id: "0", title: "Preflight", status: "done" }] };

      await expect(handlers.retryStep!(card, decision, {} as any)).resolves.toBe(false);
      expect(attemptExecutionRearm).not.toHaveBeenCalled();
      expect(refusalDiagnostics(store)).toHaveLength(1);
    });
  });
});
