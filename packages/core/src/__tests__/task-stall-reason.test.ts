/**
 * FNXC:TaskStallReason 2026-09-01-15:35 (RUFU-174):
 * Pure-unit coverage for the canonical stall/hold derivation. Pins the determination order
 * (suppressed > terminal > review lane > dependencies), the canonical blocker literals (they are
 * the display contract — do NOT paraphrase them here), and the fail-open contract.
 * The four hydration sites share this helper; read-site parity is proven separately by
 * store-task-stall-reason.pg.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import {
  deriveTaskStallReason,
  HELD_HUMAN_REVIEW_STALL_REASON,
  type TaskStallReasonContext,
} from "../tasks/task-stall-reason.js";
import { PRE_MERGE_STEPS_NOT_RUN_BLOCKER } from "../merge/task-merge.js";
import type { Task, WorkflowStepResult } from "../types.js";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-174",
    projectId: "p1",
    title: "stall fixture",
    description: "",
    status: undefined,
    column: "in-review",
    paused: false,
    priority: "normal",
    createdAt: new Date(NOW - 3_600_000).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    steps: [{ name: "impl", status: "done", completedAt: new Date(NOW).toISOString() }],
    currentStep: 1,
    log: [],
    ...overrides,
  } as unknown as Task;
}

const failedCodeReview: WorkflowStepResult = {
  workflowStepId: "code-review",
  status: "failed",
  startedAt: new Date(NOW - 60_000).toISOString(),
  completedAt: new Date(NOW - 30_000).toISOString(),
  output: "",
  notes: "",
  phase: "pre-merge",
};

function ctx(overrides: Partial<TaskStallReasonContext> = {}): TaskStallReasonContext {
  return { now: NOW, ...overrides };
}

const isoNow = new Date(NOW).toISOString();

describe("deriveTaskStallReason — review lane", () => {
  it("a clean review card with auto-merge allowed is moving: no reason", async () => {
    await expect(deriveTaskStallReason(makeTask(), ctx())).resolves.toBeUndefined();
  });

  it("a failed pre-merge step without resolved gate ids reports the canonical failed-steps blocker", async () => {
    const stall = await deriveTaskStallReason(
      makeTask({ workflowStepResults: [failedCodeReview] }),
      ctx(),
    );
    expect(stall).toEqual({
      code: "merge-blocker",
      reason: "task has failed pre-merge workflow steps",
      observedAt: isoNow,
    });
  });

  it("a failed pre-merge step on an ENABLED gate reports the not-approved blocker (still merge-blocker)", async () => {
    const stall = await deriveTaskStallReason(
      makeTask({ workflowStepResults: [failedCodeReview] }),
      ctx({ requiredPreMergeStepIds: new Set(["code-review"]) }),
    );
    expect(stall?.code).toBe("merge-blocker");
    expect(stall?.reason).toBe(
      "task has enabled pre-merge workflow steps without a current approval (gate 'code-review')",
    );
  });

  it("an enabled pre-merge gate that never ran classifies as pre-merge-gate-pending", async () => {
    const stall = await deriveTaskStallReason(
      makeTask({ workflowStepResults: [] }),
      ctx({ requiredPreMergeStepIds: new Set(["code-review"]) }),
    );
    expect(stall).toEqual({
      code: "pre-merge-gate-pending",
      reason: PRE_MERGE_STEPS_NOT_RUN_BLOCKER,
      observedAt: isoNow,
    });
  });

  /*
  FNXC:LifecycleContainment 2026-09-02-23:20 (retargeted 2026-09-06, merge FN-295):
  RUFU-178 truthful-stall assertion on the `archiveTerminalWorkflowStepFailures` carrier — status
  `skipped` with `remediationArchivedAt` and no bypass/arbitration metadata. RUFU-178 classified it
  not-run; upstream FN-295 replaced that with `not-approved` plus real recovery (collateral restore
  → failed, audited bypass waiver, archived carrier selectable by the operator bypass). The stall now
  names the gate so the overseer still sees an explicit merge-blocker, never a silent "progressing".
  */
  it("a remediation-archived gate carrier reports a gate-named merge-blocker (FN-295 recovery paths)", async () => {
    const archivedCarrier: WorkflowStepResult = {
      workflowStepId: "plan-review",
      status: "skipped",
      startedAt: new Date(NOW - 60_000).toISOString(),
      completedAt: new Date(NOW - 30_000).toISOString(),
      output: "",
      notes: "",
      phase: "pre-merge",
      reviewKind: "plan",
      remediationArchivedAt: new Date(NOW - 10_000).toISOString(),
      remediationArchivedFromStatus: "failed",
    };
    const stall = await deriveTaskStallReason(
      makeTask({ workflowStepResults: [archivedCarrier] }),
      ctx({ requiredPreMergeStepIds: new Set(["plan-review", "code-review"]) }),
    );
    expect(stall).toEqual({
      code: "merge-blocker",
      reason: "task has enabled pre-merge workflow steps without a current approval (gate 'plan-review')",
      observedAt: isoNow,
    });
  });

  it("a paused review card reports the paused merge blocker", async () => {
    const stall = await deriveTaskStallReason(makeTask({ paused: true }), ctx());
    expect(stall?.code).toBe("merge-blocker");
    expect(stall?.reason).toBe("task is paused");
  });

  it("a clean review card with auto-merge processing off is held on a human", async () => {
    const stall = await deriveTaskStallReason(makeTask(), ctx({ autoMergeAllowed: false }));
    expect(stall).toEqual({
      code: "held-human-review",
      reason: HELD_HUMAN_REVIEW_STALL_REASON,
      observedAt: isoNow,
    });
  });

  it("a renamed review lane is judged on its resolved id and never emits the identity sentence", async () => {
    const stall = await deriveTaskStallReason(
      makeTask({ column: "signoff", workflowStepResults: [failedCodeReview] }),
      ctx({ reviewColumns: new Set(["signoff"]) }),
    );
    expect(stall?.code).toBe("merge-blocker");
    expect(stall?.reason).toBe("task has failed pre-merge workflow steps");
    expect(stall?.reason).not.toContain("must be in");
  });

  it("a clean card on a renamed review lane with auto-merge off still surfaces the human hold", async () => {
    const stall = await deriveTaskStallReason(
      makeTask({ column: "signoff" }),
      ctx({ reviewColumns: new Set(["signoff"]), autoMergeAllowed: false }),
    );
    expect(stall?.code).toBe("held-human-review");
  });
});

describe("deriveTaskStallReason — suppression, terminal, and precedence", () => {
  it("suppression wins over every branch, including a hard merge blocker", async () => {
    await expect(
      deriveTaskStallReason(
        makeTask({ workflowStepResults: [failedCodeReview] }),
        ctx({ suppressed: true }),
      ),
    ).resolves.toBeUndefined();
  });

  it("terminal done/archived cards have no reason even with a live blocking dependency", async () => {
    const resolveDependency = vi.fn(async () => ({ id: "DEP-1", column: "in-progress" }));
    for (const column of ["done", "archived"]) {
      await expect(
        deriveTaskStallReason(
          makeTask({ column, blockedBy: "DEP-1" }),
          ctx({ resolveDependency }),
        ),
      ).resolves.toBeUndefined();
    }
    expect(resolveDependency).not.toHaveBeenCalled();
  });

  it("a resolved custom complete lane counts as terminal", async () => {
    await expect(
      deriveTaskStallReason(
        makeTask({ column: "shipgate" }),
        ctx({ lifecycleColumns: { intake: undefined, hold: undefined, wip: undefined, review: undefined, complete: "shipgate", archived: "archived" } }),
      ),
    ).resolves.toBeUndefined();
  });

  it("the review lane outranks the dependency branch", async () => {
    const stall = await deriveTaskStallReason(
      makeTask({ workflowStepResults: [failedCodeReview], blockedBy: "DEP-1" }),
      ctx({ resolveDependency: async () => ({ id: "DEP-1", column: "in-progress" }) }),
    );
    expect(stall?.code).toBe("merge-blocker");
  });
});

describe("deriveTaskStallReason — dependency branch", () => {
  it("a live non-terminal blockedBy reports the canonical dependency blocker", async () => {
    const stall = await deriveTaskStallReason(
      makeTask({ column: "todo", blockedBy: "DEP-1" }),
      ctx({ resolveDependency: async (id) => ({ id, column: "in-progress" }) }),
    );
    expect(stall).toEqual({
      code: "dependency-blocker",
      reason: "task is blocked by DEP-1",
      observedAt: isoNow,
    });
  });

  it("a stale blockedBy whose target is missing never lies about a blocker", async () => {
    await expect(
      deriveTaskStallReason(
        makeTask({ column: "todo", blockedBy: "DEP-GONE" }),
        ctx({ resolveDependency: async () => null }),
      ),
    ).resolves.toBeUndefined();
  });

  it("without a resolver, an asserted blockedBy stays unverified and silent", async () => {
    await expect(
      deriveTaskStallReason(makeTask({ column: "todo", blockedBy: "DEP-1" }), ctx()),
    ).resolves.toBeUndefined();
  });

  it("a terminal blockedBy clears and the dependencies list is then judged", async () => {
    const stall = await deriveTaskStallReason(
      makeTask({ column: "todo", blockedBy: "DEP-DONE", dependencies: ["DEP-WIP"] }),
      ctx({
        resolveDependency: async (id) =>
          id === "DEP-DONE" ? { id, column: "done" } : { id, column: "in-progress" },
      }),
    );
    expect(stall?.code).toBe("dependency-blocker");
    expect(stall?.reason).toBe("task has unresolved dependencies: DEP-WIP");
  });

  it("dependencies are satisfied by the legacy review/complete literals", async () => {
    await expect(
      deriveTaskStallReason(
        makeTask({ column: "todo", dependencies: ["DEP-REV", "DEP-DONE"] }),
        ctx({
          resolveDependency: async (id) =>
            id === "DEP-REV" ? { id, column: "in-review" } : { id, column: "done" },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("resolved satisfaction lanes judge the dependency on its OWN board vocabulary", async () => {
    const satisfactionColumnsByTaskId = new Map([
      ["DEP-X", { terminal: new Set(["shipgate", "archived"]), review: new Set(["qa"]) }],
    ]);
    // Finished in the dependency's renamed complete lane → satisfied despite no literal "done".
    await expect(
      deriveTaskStallReason(
        makeTask({ column: "todo", dependencies: ["DEP-X"] }),
        ctx({
          satisfactionColumnsByTaskId,
          resolveDependency: async (id) => ({ id, column: "shipgate" }),
        }),
      ),
    ).resolves.toBeUndefined();
    // Still WIP on that board → unresolved.
    const stall = await deriveTaskStallReason(
      makeTask({ column: "todo", dependencies: ["DEP-X"] }),
      ctx({
        satisfactionColumnsByTaskId,
        resolveDependency: async (id) => ({ id, column: "build" }),
      }),
    );
    expect(stall?.reason).toBe("task has unresolved dependencies: DEP-X");
  });

  it("a missing dependency in the declared list counts unresolved (completion-gate parity)", async () => {
    const stall = await deriveTaskStallReason(
      makeTask({ column: "todo", dependencies: ["DEP-POOF"] }),
      ctx({ resolveDependency: async () => null }),
    );
    expect(stall?.reason).toBe("task has unresolved dependencies: DEP-POOF");
  });

  it("cards without any reference never invoke the resolver", async () => {
    const resolveDependency = vi.fn(async () => null);
    await expect(
      deriveTaskStallReason(makeTask({ column: "todo" }), ctx({ resolveDependency })),
    ).resolves.toBeUndefined();
    expect(resolveDependency).not.toHaveBeenCalled();
  });

  it("a throwing resolver fails open: the read survives without a reason", async () => {
    await expect(
      deriveTaskStallReason(
        makeTask({ column: "todo", blockedBy: "DEP-1" }),
        ctx({
          resolveDependency: async () => {
            throw new Error("resolver exploded");
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("a non-review card never receives the review identity sentence", async () => {
    const stall = await deriveTaskStallReason(
      makeTask({ column: "hold", blockedBy: "DEP-1" }),
      ctx({ resolveDependency: async (id) => ({ id, column: "in-progress" }) }),
    );
    expect(stall?.code).toBe("dependency-blocker");
    expect(stall?.reason).not.toContain("must be in");
  });
});
