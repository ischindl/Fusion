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
  readPlanAdmissionStallEpisode,
  PLAN_ADMISSION_THROTTLED_STALL_REASON,
  PLAN_LANE_INELIGIBLE_STALL_REASON,
  PLAN_NO_ADMISSION_STALL_REASON,
  PLAN_PREMISE_HELD_STALL_REASON,
  PLAN_RECOVERY_BACKOFF_STALL_REASON,
  PLAN_SPEC_UNREADABLE_STALL_REASON,
  RECOVERABLE_WORK_STALL_REASON,
  /* FNXC:HoldReleaseArmedPriority 2026-11-21-06:55 (RUFU-807 Step 3): the vocabulary of the third
   * planning-lane episode, asserted through the same derivation the board reads. */
  HOLD_RELEASE_STARVED_STALL_REASON,
  HOLD_RELEASE_STARVATION_REFRESH_FLOOR_MS,
  clearHoldReleaseStarvationPatch,
  holdReleaseStarvationWrite,
  readHoldReleaseStarvationEpisode,
  type TaskStallReasonContext,
} from "../tasks/task-stall-reason.js";
import { PRE_MERGE_STEPS_NOT_RUN_BLOCKER, STALE_CONTENT_APPROVAL_BLOCKER } from "../merge/task-merge.js";
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
  FNXC:TaskStallReason 2026-09-22-23:36 (RUFU-276, AC3):
  The RUFU-225 wedge reaches the review-lane arm as the blocking-status composition
  `task is marked 'failed': AUTO_MERGE_RETRY_REJECTED: Cannot merge <id>: <canonical sentence>`,
  because the failed status outranks the not-run arm inside `getTaskMergeBlocker`. The wrap-aware
  classifier must name that spelling `pre-merge-gate-pending` — the class the engine can repair —
  while the composed park prose never becomes the display reason, and every OTHER embedded refusal
  (stale-content, generic) must keep the generic `merge-blocker` code so their existing owners
  (`classifyStaleContentPark`, operator inspection) stay intact.
  */
  it("names the failed-status retry-rejection wrapper of the not-run refusal", async () => {
    const stall = await deriveTaskStallReason(
      makeTask({
        status: "failed",
        error: `AUTO_MERGE_RETRY_REJECTED: Cannot merge RUFU-174: ${PRE_MERGE_STEPS_NOT_RUN_BLOCKER}`,
      }),
      ctx({ requiredPreMergeStepIds: new Set(["plan-review", "code-review"]) }),
    );
    expect(stall).toEqual({
      code: "pre-merge-gate-pending",
      reason: PRE_MERGE_STEPS_NOT_RUN_BLOCKER,
      observedAt: isoNow,
    });
  });

  it("a failed park wrapping a stale-content refusal keeps the generic merge-blocker code", async () => {
    const stall = await deriveTaskStallReason(
      makeTask({
        status: "failed",
        error: `AUTO_MERGE_RETRY_REJECTED: Cannot merge RUFU-174: ${STALE_CONTENT_APPROVAL_BLOCKER}`,
      }),
      ctx({ requiredPreMergeStepIds: new Set(["code-review"]) }),
    );
    expect(stall?.code).toBe("merge-blocker");
    expect(stall?.reason).toBe(
      `task is marked 'failed': AUTO_MERGE_RETRY_REJECTED: Cannot merge RUFU-174: ${STALE_CONTENT_APPROVAL_BLOCKER}`,
    );
  });

  it("a failed park wrapping a generic refusal keeps the composed merge-blocker reason verbatim", async () => {
    const stall = await deriveTaskStallReason(
      makeTask({
        status: "failed",
        error: "AUTO_MERGE_RETRY_REJECTED: merge worktree disappeared",
      }),
      ctx({ requiredPreMergeStepIds: new Set(["code-review"]) }),
    );
    expect(stall?.code).toBe("merge-blocker");
    expect(stall?.reason).toBe("task is marked 'failed': AUTO_MERGE_RETRY_REJECTED: merge worktree disappeared");
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

/*
FNXC:PlanningAdmissionStall 2026-09-25-17:48 (RUFU-273):
Planning-lane coverage. The reported failure this branch answers is an aged card in the planning lane
with `status: null` and `paused: false` that reported NOTHING, so the assertions come in pairs: the
card names its gate, or a card that must stay silent stays silent. The silent set is what keeps the
chip honest, so it is covered as densely as the naming set.
*/
const PLANNING_LANES = new Set(["hold", "todo"]);

function planningTask(overrides: Partial<Task> = {}): Task {
  return makeTask({ column: "hold", status: undefined, paused: false, ...overrides });
}

function planningCtx(overrides: Partial<TaskStallReasonContext> = {}): TaskStallReasonContext {
  return ctx({ planningColumns: PLANNING_LANES, ...overrides });
}

function episode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    planAdmissionStall: {
      code: "plan-admission-throttled",
      lastAt: new Date(NOW - 60_000).toISOString(),
      firstAt: new Date(NOW - 86_400_000).toISOString(),
      stallCount: 3,
      ...overrides,
    },
  };
}

/*
FNXC:HoldReleaseArmedPriority 2026-11-21-06:55 (RUFU-807 Step 3):
The starvation fixture, in the same shape as `episode()` above. Its defaults are the NOMINATING shape — a
streak long enough to badge without relying on the clock — so a precedence test that never touches
`stallCount` is testing precedence and not a threshold.
*/
function starvationEpisode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    holdReleaseStarvation: {
      code: "release-sweep-budget-starved",
      lastAt: new Date(NOW - 60_000).toISOString(),
      firstAt: new Date(NOW - 40 * 60_000).toISOString(),
      stallCount: 4,
      ...overrides,
    },
  };
}

const EPISODE_SENTENCES = {
  "plan-admission-throttled": PLAN_ADMISSION_THROTTLED_STALL_REASON,
  "plan-lane-ineligible": PLAN_LANE_INELIGIBLE_STALL_REASON,
  "plan-spec-unreadable": PLAN_SPEC_UNREADABLE_STALL_REASON,
  "plan-no-admission": PLAN_NO_ADMISSION_STALL_REASON,
  "recoverable-work": RECOVERABLE_WORK_STALL_REASON,
} as const;

describe("deriveTaskStallReason — planning admission lane", () => {
  it.each(Object.entries(EPISODE_SENTENCES))("episode code %s maps 1:1 onto its exported sentence", async (code, sentence) => {
    const stall = await deriveTaskStallReason(
      planningTask({ sourceMetadata: episode({ code }) }),
      planningCtx(),
    );
    expect(stall).toEqual({ code, reason: sentence, observedAt: isoNow });
    // Planning copy must never borrow delivery vocabulary.
    expect(stall!.reason.toLowerCase()).not.toContain("merge");
  });

  it("a plan-premise episode outranks an admission episode naming a different gate", async () => {
    const stall = await deriveTaskStallReason(
      planningTask({
        sourceMetadata: {
          ...episode({ code: "plan-admission-throttled" }),
          planPremiseRejection: { signature: "abc", refusalCount: 1 },
        },
      }),
      planningCtx(),
    );
    expect(stall).toEqual({ code: "plan-premise-held", reason: PLAN_PREMISE_HELD_STALL_REASON, observedAt: isoNow });
  });

  it("a future nextRecoveryAt names the recovery backoff when no episode was written", async () => {
    const stall = await deriveTaskStallReason(
      planningTask({ nextRecoveryAt: new Date(NOW + 600_000).toISOString() }),
      planningCtx(),
    );
    expect(stall).toEqual({ code: "plan-recovery-backoff", reason: PLAN_RECOVERY_BACKOFF_STALL_REASON, observedAt: isoNow });
  });

  it("a past or unparseable nextRecoveryAt names nothing", async () => {
    await expect(
      deriveTaskStallReason(planningTask({ nextRecoveryAt: new Date(NOW - 1).toISOString() }), planningCtx()),
    ).resolves.toBeUndefined();
    await expect(
      deriveTaskStallReason(planningTask({ nextRecoveryAt: "not-a-date" }), planningCtx()),
    ).resolves.toBeUndefined();
  });

  it("an aged card with nothing written anywhere stays silent — residual codes are written, not invented", async () => {
    await expect(deriveTaskStallReason(planningTask(), planningCtx())).resolves.toBeUndefined();
  });

  it.each([
    ["engine pause", { paused: true }],
    ["operator pause", { userPaused: true }],
    ["queued dispatch transient", { status: "queued" }],
    ["live planning status", { status: "planning" }],
  ])("%s is in the silent set", async (_label, overrides) => {
    await expect(
      deriveTaskStallReason(
        planningTask({ ...overrides, sourceMetadata: episode({ code: "plan-no-admission" }) }),
        planningCtx(),
      ),
    ).resolves.toBeUndefined();
  });

  it("an empty status is treated as absent, not as a live status", async () => {
    const stall = await deriveTaskStallReason(
      planningTask({ status: "" as Task["status"], sourceMetadata: episode({ code: "plan-no-admission" }) }),
      planningCtx(),
    );
    expect(stall?.code).toBe("plan-no-admission");
  });

  it("a card outside its workflow's planning lane receives no planning code", async () => {
    await expect(
      deriveTaskStallReason(
        makeTask({ column: "in-review", sourceMetadata: episode({ code: "plan-no-admission" }) }),
        planningCtx(),
      ),
    ).resolves.toBeUndefined();
  });

  it("an unresolved planning lane never guesses from the legacy todo literal", async () => {
    await expect(
      deriveTaskStallReason(planningTask({ sourceMetadata: episode({ code: "plan-no-admission" }) }), ctx()),
    ).resolves.toBeUndefined();
    await expect(
      deriveTaskStallReason(
        planningTask({ sourceMetadata: episode({ code: "plan-no-admission" }) }),
        ctx({ planningColumns: new Set<string>() }),
      ),
    ).resolves.toBeUndefined();
  });

  it("a live dependency outranks every planning answer", async () => {
    const stall = await deriveTaskStallReason(
      planningTask({ dependencies: ["DEP-1"], sourceMetadata: episode({ code: "plan-no-admission" }) }),
      planningCtx({ resolveDependency: async (id) => ({ id, column: "in-progress" }) }),
    );
    expect(stall?.code).toBe("dependency-blocker");
  });

  it("a dependency that resolves into a terminal lane is proven clear, so the planning answer comes through", async () => {
    const stall = await deriveTaskStallReason(
      planningTask({ dependencies: ["DEP-1"], sourceMetadata: episode({ code: "plan-admission-throttled" }) }),
      planningCtx({
        resolveDependency: async (id) => ({ id, column: "done" }),
        satisfactionColumnsByTaskId: new Map([
          ["DEP-1", { terminal: new Set(["done"]), review: new Set(["in-review"]) }],
        ]),
      }),
    );
    expect(stall?.code).toBe("plan-admission-throttled");
  });

  it("a throwing dependency probe fails open instead of falling through to a planning code", async () => {
    await expect(
      deriveTaskStallReason(
        planningTask({ dependencies: ["DEP-1"], sourceMetadata: episode({ code: "plan-no-admission" }) }),
        planningCtx({
          resolveDependency: async () => {
            throw new Error("resolver exploded");
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("suppression wins over the planning lane", async () => {
    await expect(
      deriveTaskStallReason(
        planningTask({ sourceMetadata: episode({ code: "plan-no-admission" }) }),
        planningCtx({ suppressed: true }),
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["null episode", { planAdmissionStall: null }],
    ["array episode", { planAdmissionStall: ["plan-no-admission"] }],
    ["bare string episode", { planAdmissionStall: "plan-no-admission" }],
    ["code outside the union", { planAdmissionStall: { code: "totally-made-up", lastAt: isoNow, firstAt: isoNow, stallCount: 1 } }],
    ["missing timestamps", { planAdmissionStall: { code: "plan-no-admission", stallCount: 1 } }],
    ["non-numeric stallCount", { planAdmissionStall: { code: "plan-no-admission", lastAt: isoNow, firstAt: isoNow, stallCount: "3" } }],
  ])("a malformed stored episode (%s) is treated as no episode at all", async (_label, sourceMetadata) => {
    await expect(deriveTaskStallReason(planningTask({ sourceMetadata }), planningCtx())).resolves.toBeUndefined();
  });

  it("readPlanAdmissionStallEpisode accepts a well-formed episode carrying the optional fields", () => {
    const read = readPlanAdmissionStallEpisode(
      episode({ code: "recoverable-work", signature: "sha256:x", ageMs: 123, uniqueCommitCount: 2 }),
    );
    expect(read?.code).toBe("recoverable-work");
    expect(read?.uniqueCommitCount).toBe(2);
  });

  it("readPlanAdmissionStallEpisode reads no episode from absent or unrelated metadata", () => {
    expect(readPlanAdmissionStallEpisode(undefined)).toBeUndefined();
    expect(readPlanAdmissionStallEpisode({ duplicateOfTaskIds: ["A-1"] })).toBeUndefined();
  });

  /*
  FNXC:HoldReleaseArmedPriority 2026-11-21-06:55 (RUFU-807 Step 3):
  The precedence contract for the third episode that can live in this lane. Each case names one pair that
  could otherwise be reported interchangeably, because the three claims mean different remedies: a premise
  episode names a contract the card must fix, a planning-admission episode names a planner that is busy, a
  WIP-admission episode names a column at its limit, and this one names a sweep whose budget died before it
  reached the card. Collapse any pair and the operator is sent to a knob that is not stuck — the RUFU-393
  defect class, which was created exactly by labelling a WIP refusal as a planning stall.
  */
  describe("hold-release starvation episode", () => {
    it("names a card deferred past the streak threshold, well inside the hour floor", async () => {
      const stall = await deriveTaskStallReason(
        planningTask({ sourceMetadata: starvationEpisode({ stallCount: 3, firstAt: new Date(NOW - 5 * 60_000).toISOString() }) }),
        planningCtx(),
      );
      expect(stall?.code).toBe("release-sweep-budget-starved");
      expect(stall?.reason).toBe(HOLD_RELEASE_STARVED_STALL_REASON);
      // The wait reported is the real elapsed time, not the threshold that tripped the badge.
      expect(stall?.waitedMs).toBe(5 * 60_000);
    });

    it("stays silent on a single deferral — one truncated pass is ordinary scheduling", async () => {
      await expect(
        deriveTaskStallReason(
          planningTask({ sourceMetadata: starvationEpisode({ stallCount: 1, firstAt: new Date(NOW - 5 * 60_000).toISOString() }) }),
          planningCtx(),
        ),
      ).resolves.toBeUndefined();
    });

    it("names a card past the hour floor even on its first recorded deferral", async () => {
      const stall = await deriveTaskStallReason(
        planningTask({ sourceMetadata: starvationEpisode({ stallCount: 1, firstAt: new Date(NOW - 61 * 60_000).toISOString() }) }),
        planningCtx(),
      );
      expect(stall?.code).toBe("release-sweep-budget-starved");
      expect(stall?.waitedMs).toBe(61 * 60_000);
    });

    it("an admission episode does not mask starvation", async () => {
      // The card was PLANNED (that is how it got a continuation), so a leftover planning throttle
      // describes a gate it is no longer behind.
      const stall = await deriveTaskStallReason(
        planningTask({ sourceMetadata: { ...episode({ code: "plan-admission-throttled" }), ...starvationEpisode() } }),
        planningCtx(),
      );
      expect(stall?.code).toBe("release-sweep-budget-starved");
    });

    it("a premise episode still outranks it — a named contract violation names a fix", async () => {
      const stall = await deriveTaskStallReason(
        planningTask({
          sourceMetadata: {
            ...starvationEpisode(),
            planPremiseRejection: { signature: "abc", refusalCount: 1 },
          },
        }),
        planningCtx(),
      );
      expect(stall?.code).toBe("plan-premise-held");
    });

    it("a live WIP-admission episode outranks it — the outer arm keeps its precedence", async () => {
      // The sweep REACHED this card and refused it for a pool reason: that is the truer statement, and
      // the outer WIP-before-planning order is what guarantees it, not the inner order added here.
      // Aged past the WIP arm's own escalation floor on purpose — an episode still inside that floor
      // declines to speak at all, which would make this test prove nothing about precedence.
      const stall = await deriveTaskStallReason(
        planningTask({
          sourceMetadata: {
            ...starvationEpisode(),
            wipAdmissionStall: {
              code: "column-capacity",
              nodeId: "wip",
              signature: "s",
              fromColumn: "hold",
              toColumn: "in-progress",
              lastAt: new Date(NOW - 2 * 3_600_000).toISOString(),
              firstAt: new Date(NOW - 2 * 3_600_000).toISOString(),
              stallCount: 2,
            },
          },
        }),
        planningCtx(),
      );
      expect(stall?.code).toBe("wip-admission-throttled");
    });

    it("a card that left the planning lane claims nothing, badge present or not", async () => {
      await expect(
        deriveTaskStallReason(makeTask({ column: "in-progress", sourceMetadata: starvationEpisode() }), ctx()),
      ).resolves.toBeUndefined();
    });

    it.each([
      ["array", { holdReleaseStarvation: ["release-sweep-budget-starved"] }],
      ["bare string", { holdReleaseStarvation: "release-sweep-budget-starved" }],
      ["code outside the union", starvationEpisode({ code: "totally-made-up" })],
      ["missing timestamps", { holdReleaseStarvation: { code: "release-sweep-budget-starved", stallCount: 3 } }],
      ["non-numeric stallCount", starvationEpisode({ stallCount: "3" })],
    ] as const)("a malformed stored starvation episode (%s) reads as no episode", async (_label, sourceMetadata) => {
      await expect(deriveTaskStallReason(planningTask({ sourceMetadata }), planningCtx())).resolves.toBeUndefined();
    });

    it("reads a well-formed episode carrying its optional forensic fields, and nothing from unrelated metadata", () => {
      const read = readHoldReleaseStarvationEpisode(
        starvationEpisode({ unevaluatedCount: 700, oldestDeferredAgeMs: 7_186_192 }),
      );
      expect(read?.code).toBe("release-sweep-budget-starved");
      expect(read?.oldestDeferredAgeMs).toBe(7_186_192);
      expect(readHoldReleaseStarvationEpisode(undefined)).toBeUndefined();
      expect(readHoldReleaseStarvationEpisode({ duplicateOfTaskIds: ["A-1"] })).toBeUndefined();
    });

    it("bounds a sustained episode to the refresh floor and resets the count on a different code", () => {
      const first = holdReleaseStarvationWrite(undefined, { code: "release-sweep-budget-starved", unevaluatedCount: 10 }, NOW);
      expect(first?.stallCount).toBe(1);
      // Inside the floor of the same episode: no write, so one sustained starvation cannot stamp the row
      // at the poll rate (RUFU-393's 16 536-row storm is the counterexample).
      expect(holdReleaseStarvationWrite(first, { code: "release-sweep-budget-starved" }, NOW + 60_000)).toBeUndefined();
      const refreshed = holdReleaseStarvationWrite(first, { code: "release-sweep-budget-starved" }, NOW + HOLD_RELEASE_STARVATION_REFRESH_FLOOR_MS + 1);
      expect(refreshed?.stallCount).toBe(2);
      // `firstAt` is preserved across a refresh so the operator sees how long the starvation has run,
      // not when it was last seen (RUFU-273's rule, adopted verbatim).
      expect(refreshed?.firstAt).toBe(first?.firstAt);
      // A fresh observation with NO prior episode always writes: a sustained floor must never swallow the
      // first naming of a newly starved card.
      expect(holdReleaseStarvationWrite(undefined, { code: "release-sweep-budget-starved" }, NOW + 3_600_000)?.stallCount).toBe(1);
    });

    it("clears at the key level so every other provenance key on the carrier survives", () => {
      expect(clearHoldReleaseStarvationPatch()).toEqual({ holdReleaseStarvation: null });
    });
  });
});
