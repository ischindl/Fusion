/*
FNXC:ApprovalRefusalCarrier 2026-11-21-14:30 (RUFU-1097):
WHAT A GATE REFUSAL HAS TO SAY ABOUT ITSELF, AND WHAT IT MUST NEVER DO.

RUFU-718 sat `in-review` with `plan-review` = `passed` (an accepted terminal `CLOSE_NO_OP` close) and
Code Review carrying an audited FN-7720 operator bypass. `fn task reconcile` answered the bare token
`workflow-approval-blocked` on every retry and wrote nothing durable. Two facts were missing from that token,
and the operator needs both: WHICH gate the authority refused, and WHAT ROW that authority selected. A
refusal that cannot say "the gate reported `passed` and I still do not read that as approval" leaves the
operator unable to tell a missing review from a lane that refuses the answer a review already gave.

This file pins the report seam. It deliberately decides nothing:
  - it reads the gate id from the merge door's own blocker sentence and the carrier from the canonical
    admission decision, so no parallel gate logic exists here to drift;
  - it writes no column, no status, no step-result row — the two invariants asserted below;
  - the three-way authority split (may-execute `isPlanReviewSatisfied` / may-land
    `evaluatePreMergeApprovals` / may-resume-past `isGateReleased`) is REPORTED, never adjudicated here.

Surface enumeration: the engine reconciliation seam shared by `fn task reconcile` (manual) and the
self-healing absent-branch sweep (automatic), plus the CLI sentence rendered from the same detail
(`packages/cli/src/__tests__/task-reconcile-approval-carrier.test.ts`). No desktop/mobile UI renders this
refusal; the board's History line is the second surface and is asserted here.
*/
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { buildPreMergeGateApprovalBlocker, type Settings, type Task, type TaskStore, type WorkflowStepResult } from "@fusion/core";
import { SelfHealingManager, landedReviewReconcileLogMarker, resolvePreMergeGateApprovalDetail } from "../self-healing.js";

const BOTH_GATES = ["plan-review", "code-review"];
const PLAN_CLOSE_NOTES = "NO-OP: the guard this card asks for already ships on main";

function row(stepId: string, overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    workflowStepId: stepId,
    workflowStepName: stepId,
    phase: "pre-merge",
    status: "passed",
    completedAt: "2026-11-11T15:25:00.000Z",
    ...overrides,
  } as WorkflowStepResult;
}

/** FN-8841's authored close: the plan gate, passed, `CLOSE_NO_OP`, and the sentinel that legalised it. */
const planClose = (overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult =>
  row("plan-review", { reviewKind: "plan", verdict: "CLOSE_NO_OP", notes: PLAN_CLOSE_NOTES, ...overrides });

/** RUFU-718's second gate: `skipped` carrying an audited FN-7720 operator waiver. */
const bypassedCodeReview = (): WorkflowStepResult => row("code-review", {
  reviewKind: "code",
  status: "skipped",
  bypassedBy: "dashboard-operator",
  bypassedAt: "2026-11-11T14:18:18.000Z",
  bypassReason: "no-op close; nothing to review",
});

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-1097",
    title: "Reconcile me",
    description: "",
    column: "in-review",
    branch: "fusion/rufu-1097",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    mergeDetails: {},
    enabledWorkflowSteps: BOTH_GATES,
    workflowStepResults: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as unknown as Task;
}

function storeWithTask(task: Task) {
  const tasks = new Map<string, Task>([[task.id, task]]);
  const updateTask = vi.fn(async (id: string, patch: Partial<Task>) => {
    const next = { ...tasks.get(id)!, ...patch } as Task;
    tasks.set(id, next);
    return next;
  });
  const updateTaskAtomic = vi.fn(async (id: string, updater: (current: Task) => Partial<Task> | null) => {
    const current = tasks.get(id)!;
    const patch = updater(current);
    if (!patch) return null;
    const next = { ...current, ...patch } as Task;
    tasks.set(id, next);
    return next;
  });
  const moveTask = vi.fn(async (id: string, column: string) => {
    const next = { ...tasks.get(id)!, column } as Task;
    tasks.set(id, next);
    return next;
  });
  const moveTaskIf = vi.fn(async (id: string) => ({ moved: false, task: tasks.get(id)! }));
  const store = Object.assign(new EventEmitter(), {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false } as Settings)),
    getTask: vi.fn(async (id: string) => tasks.get(id)),
    listTasks: vi.fn(async () => [...tasks.values()]),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: BOTH_GATES })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: BOTH_GATES })),
    updateTask,
    updateTaskAtomic,
    moveTask,
    moveTaskIf,
    // The real logEntry appends; the sweep's once-per-reason dedup reads it back.
    logEntry: vi.fn(async (id: string, action: string) => {
      const current = tasks.get(id);
      if (!current) return;
      tasks.set(id, { ...current, log: [...(current.log ?? []), { action }] } as Task);
    }),
    recordRunAuditEvent: vi.fn(async () => undefined),
  }) as unknown as TaskStore & EventEmitter;
  return { store, tasks, updateTask, updateTaskAtomic, moveTask, moveTaskIf };
}

function managerWithStubs(store: TaskStore) {
  const manager = new SelfHealingManager(store, { rootDir: "/repo" });
  Object.assign(manager, {
    isBranchTipMisboundToTask: vi.fn(async () => ({ misbound: false, branchMissing: true, branchTip: "", landed: null })),
    hasUnlandedTaskOwnedContent: vi.fn(async () => false),
    resolveSelfHealingMergeTarget: vi.fn(async () => ({ branch: "main" })),
    recordSelfHealingBranchGroupMemberLanding: vi.fn(async () => undefined),
    moveToCompleteLaneAfterLandedCleanup: vi.fn(async (task: Task, completeLane: string) => ({ ...task, column: completeLane })),
    emitTaskMerged: vi.fn(),
    reconcileCompletedTask: vi.fn(async () => undefined),
  });
  return manager;
}

function refusalLines(task: Task | undefined): string[] {
  return (task?.log ?? [])
    .map((entry) => (typeof entry.action === "string" ? entry.action : ""))
    .filter((line) => line.includes("[landed-review reconcile:"));
}

const reconcile = (manager: SelfHealingManager, id = "RUFU-1097", source: "manual" | "self-healing" = "manual") =>
  manager.reconcileLandedReviewTask(id, { source, requireAutoMergeEligible: false });

describe("RUFU-718 reproduction — the refusal names the gate AND quotes its carrier", () => {
  /*
  FNXC:ApprovalRefusalCarrier 2026-11-21-14:30 (RUFU-1097):
  What the operator SEES of that carrier is asserted against the pure renderer in
  `packages/cli/src/__tests__/task-reconcile-approval-carrier.test.ts`. This package must not import
  `@runfusion/fusion` — the CLI depends on the engine, never the reverse — so the seam here asserts the
  structured detail the renderer is handed, which is the half the engine owns.
  */
  it("names plan-review and its passed status when the plan gate reported a close this lane will not accept", async () => {
    /*
    The carrier half is the load-bearing assertion. A close WITHOUT a leading sentinel is a `passed` row the
    merge door genuinely refuses, so it reaches this arm with the same shape RUFU-718's card presented: the
    gate says `passed`, the door says `not-approved`. Asserting only "the refusal names plan-review" would be
    satisfied by any gate-named refusal and would prove nothing about the contradiction the operator must see.
    */
    const unsigned = planClose({ notes: "the reviewer thinks this looks like a no-op" });
    const { store, tasks } = storeWithTask(baseTask({
      workflowStepResults: [unsigned, bypassedCodeReview()],
    }));

    const result = await reconcile(managerWithStubs(store));

    expect(result).toMatchObject({
      outcome: "ineligible",
      reason: "workflow-approval-blocked",
      approvalDetail: { gateId: "plan-review", gateState: "not-approved", gateStatus: "passed", gateVerdict: "CLOSE_NO_OP" },
    });
    // The History line names the gate too — run-audit metadata is not readable from any board surface.
    const lines = refusalLines(tasks.get("RUFU-1097"));
    expect(lines).toHaveLength(1);
    expect(lines[0]!).toContain("for gate 'plan-review'");
    const detail = (result as { approvalDetail?: { gateStatus?: string; gateVerdict?: string } }).approvalDetail;
    expect(detail?.gateStatus).toBe("passed");
    expect(detail?.gateVerdict).toBe("CLOSE_NO_OP");
  });

  it("no longer refuses RUFU-718's actual pair on the approval arm at all", async () => {
    /*
    Step 1's win, shown from the reconcile seam rather than from the door: with the sentinel present the
    accepted close IS approval, so this card must get past `workflow-approval-blocked` and reach the landing
    arms. Written as the negative of the reproduction so a future widening of the close identity that also
    broke this arm could not slip past a test that only asserts the refusal text.
    */
    const { store } = storeWithTask(baseTask({
      workflowStepResults: [planClose(), bypassedCodeReview()],
    }));

    const result = await reconcile(managerWithStubs(store));

    expect(result).not.toMatchObject({ reason: "workflow-approval-blocked" });
  });

  it("writes no refusal line for a card that reaches the landing arms", async () => {
    const { store, tasks } = storeWithTask(baseTask({
      workflowStepResults: [planClose(), bypassedCodeReview()],
    }));

    await reconcile(managerWithStubs(store));

    expect(refusalLines(tasks.get("RUFU-1097"))).toEqual([]);
  });
});

describe("the carrier is derived, never invented", () => {
  const required = new Set(BOTH_GATES);

  it("answers a plain rejected review with its own status and verdict", () => {
    const detail = resolvePreMergeGateApprovalDetail(
      { workflowStepResults: [row("plan-review", { reviewKind: "plan", verdict: "REVISE" })], repositoryScope: null },
      required,
      buildPreMergeGateApprovalBlocker("plan-review"),
    );
    expect(detail).toEqual({ gateId: "plan-review", gateState: "not-approved", gateStatus: "passed", gateVerdict: "REVISE" });
  });

  it("reports no carrier when the gate has no row, and no detail at all when the blocker names no gate", () => {
    // A blocker that is not the gate-named form must not grow keys: an absent key means "names no gate".
    expect(resolvePreMergeGateApprovalDetail(
      { workflowStepResults: [], repositoryScope: null },
      required,
      "task has incomplete steps",
    )).toBeUndefined();
    // A gate-named blocker whose gate this authority no longer refuses is a race, and a stale claim is worse than none.
    expect(resolvePreMergeGateApprovalDetail(
      { workflowStepResults: [row("plan-review", { reviewKind: "plan", verdict: "APPROVE" })], repositoryScope: null },
      required,
      buildPreMergeGateApprovalBlocker("plan-review"),
    )).toBeUndefined();
  });

  it("carries a superseded row's own status without inventing a supersession field", () => {
    const detail = resolvePreMergeGateApprovalDetail(
      {
        workflowStepResults: [planClose({ supersededAt: "2026-11-12T09:00:00.000Z" })],
        repositoryScope: null,
      },
      required,
      buildPreMergeGateApprovalBlocker("plan-review"),
    );
    expect(detail).toEqual({ gateId: "plan-review", gateState: "not-approved", gateStatus: "passed", gateVerdict: "CLOSE_NO_OP" });
  });
});

describe("no fabricated approval and no lifecycle backward move", () => {
  const shapes: Array<[string, () => WorkflowStepResult[]]> = [
    ["plan gate closed, code gate never ran", () => [planClose()]],
    ["both required gates approve", () => [planClose(), row("code-review", { reviewKind: "code", verdict: "APPROVE" })]],
    ["code review rejected", () => [planClose(), row("code-review", { reviewKind: "code", status: "failed", verdict: "REVISE" })]],
  ];

  it.each(shapes)("refuses or proceeds identically and performs no column write: %s", async (_label, results) => {
    const task = baseTask({ workflowStepResults: results() });
    const { store, tasks, updateTask, updateTaskAtomic, moveTask, moveTaskIf } = storeWithTask(task);
    const before = tasks.get(task.id)!;

    const result = await reconcile(managerWithStubs(store));

    // Lifecycle containment: no move, in either direction, ever.
    expect(moveTask).not.toHaveBeenCalled();
    expect(moveTaskIf).not.toHaveBeenCalled();
    // A refusal is a refusal: the approval arm never authored or rewrote a step-result row.
    for (const patch of [...updateTask.mock.calls, ...updateTaskAtomic.mock.calls.map((call) => call[1])]) {
      expect(Object.keys(patch as object)).not.toContain("workflowStepResults");
      expect((patch as Record<string, unknown>)["column"]).toBeUndefined();
    }
    if (result.outcome === "ineligible" && result.reason === "workflow-approval-blocked") {
      expect(tasks.get(task.id)!.column).toBe(before.column);
      expect(tasks.get(task.id)!.workflowStepResults).toEqual(before.workflowStepResults);
    }
  });

  it("records one deduplicated History line per (card, reason) for the automatic sweep", async () => {
    const { store, tasks } = storeWithTask(baseTask({
      workflowStepResults: [planClose({ notes: "prose with no sentinel" }), bypassedCodeReview()],
    }));
    const manager = managerWithStubs(store);

    await reconcile(manager, "RUFU-1097", "self-healing");
    await reconcile(manager, "RUFU-1097", "self-healing");

    expect(refusalLines(tasks.get("RUFU-1097"))).toHaveLength(1);
  });

  it("lets a manual reconcile record its own line every time — an operator asking why earns a fresh answer", async () => {
    const { store, tasks } = storeWithTask(baseTask({
      workflowStepResults: [planClose({ notes: "prose with no sentinel" }), bypassedCodeReview()],
    }));
    const manager = managerWithStubs(store);

    await reconcile(manager);
    await reconcile(manager);

    expect(refusalLines(tasks.get("RUFU-1097"))).toHaveLength(2);
  });

  it("names the gate in the marker exactly as landedReviewReconcileLogMarker spells it", async () => {
    const { store, tasks } = storeWithTask(baseTask({
      workflowStepResults: [row("plan-review", { reviewKind: "plan", status: "failed", verdict: "REVISE" }), bypassedCodeReview()],
    }));

    await reconcile(managerWithStubs(store));

    const lines = refusalLines(tasks.get("RUFU-1097"));
    expect(lines[0]!.startsWith(`${landedReviewReconcileLogMarker("workflow-approval-blocked")} `)).toBe(true);
  });
});
