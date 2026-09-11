import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { WorkflowStepResult } from "../types.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";
import { queryRunAuditEvents } from "../task-store/async/async-audit.js";
import { archiveTerminalWorkflowStepFailures } from "../workflows/workflow-step-results.js";
import { getTaskMergeBlocker } from "../merge/task-merge.js";

/*
 * FNXC:StepResume 2026-07-24-13:00:
 * Store-level coverage for the resumeWorkflowStep primitive: eligibility gating
 * (in-review or in-progress, step is pending, mandatory reason + stepId), the
 * resume rewrite (status -> failed + audit metadata), the run-audit event/log
 * breadcrumb, and rejection of non-pending steps.
 */

/*
 * FNXC:OperatorEscapeHatch 2026-09-11-14:35 (RUFU-219):
 * THE PAUSE MATRIX for the resume hatch, seeded the same two disciplined ways the bypass store
 * tests use: an ENGINE PARK is plain `updateTask({ paused: true })` — the Move-Task contract
 * forbids an engine rebound from writing `userPaused` and `updateTask` cannot write it, so this
 * is exactly what the park sinks produce; an OPERATOR HOLD needs the real fence,
 * `pauseTask(id, true, undefined, { userPaused: true })`. The hold refuses on BOTH lanes with
 * the byte-frozen sentence, and refuses even on an unrelated column (the pause gate precedes the
 * lane check, so a held card can never trade the pause refusal for the lane refusal). The park
 * is accepted on BOTH lanes and stays parked afterwards — resume mutates only the step-result
 * row (no auto-unpause, no column move). `userPaused` without `paused` is asserted not to be a
 * hold: the predicate is the PAIR, never either flag alone.
 *
 * The gate is also asserted REASON-blind both ways: every engine park class
 * (stall-deadlock, merge-fix, rebound/retry-exhausted, external-block) is accepted, and a hold
 * wearing a park's `pausedReason` is still refused. The narrowing's gate-order consequence is
 * asserted as a twin pair: a held card outside the lanes still gets the PAUSE sentence, while an
 * engine-parked card outside the lanes now falls through to the LANE sentence. Accepted resumes
 * must carry the `task:resume-step` run-audit row with the server-derived actor; refused resumes
 * must write no such row. Acceptance must not clear the merge blocker: the unparked view of the
 * accepted card is still refused by the freshly `failed` carrier (AC3 — resume unsticks the gate
 * for the operator's next decision, it never releases the merge door).
 */

pgDescribe("TaskStore.resumeWorkflowStep", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_resume_step",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  function pendingStep(overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
    return {
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      phase: "pre-merge",
      source: "optional-group",
      status: "pending",
      startedAt: "2026-07-17T16:10:10.052Z",
      ...overrides,
    };
  }

  function store() {
    return h.store();
  }

  async function seedInReviewTask(
    id: string,
    options: {
      workflowStepResults?: WorkflowStepResult[];
      paused?: boolean;
      pausedReason?: string;
      column?: string;
    } = {},
  ) {
    const column = options.column ?? "in-review";
    await store().createTaskWithReservedId(
      { description: `Task ${id}`, column },
      { taskId: id, applyDefaultWorkflowSteps: false },
    );
    await store().updateTask(id, {
      workflowStepResults: options.workflowStepResults ?? null,
      paused: options.paused,
      pausedReason: options.pausedReason,
    });
    return store().getTask(id);
  }

  it("transitions a pending step to failed with audit metadata", async () => {
    await seedInReviewTask("FN-RES-001", { workflowStepResults: [pendingStep()] });

    const updated = await store().resumeWorkflowStep("FN-RES-001", {
      stepId: "code-review",
      reason: "Runfusion/Fusion#1946 no-verdict dispatch defect",
      actor: "operator-1",
    });

    const result = updated.workflowStepResults?.[0];
    expect(result?.status).toBe("failed");
    expect(result?.completedAt).toBeDefined();
    expect(result?.resumedBy).toBe("operator-1");
    expect(result?.resumeReason).toBe("Runfusion/Fusion#1946 no-verdict dispatch defect");
    expect(result?.resumedFromStatus).toBe("pending");
    expect(typeof result?.resumedAt).toBe("string");

    // Audit trail: task log entry recorded.
    const logged = updated.log?.some((entry) => entry.action.includes("Workflow step resumed"));
    expect(logged).toBe(true);
  });

  it("records a run-audit event for the resume", async () => {
    await seedInReviewTask("FN-RES-002", { workflowStepResults: [pendingStep()] });
    await store().resumeWorkflowStep("FN-RES-002", {
      stepId: "code-review",
      reason: "infra failure",
      actor: "operator-2",
    });

    const events = await queryRunAuditEvents(h.layer().db, { taskId: "FN-RES-002" });
    const resumeEvent = events.find((event) => event.mutationType === "task:resume-step");
    expect(resumeEvent).toBeDefined();
    expect(resumeEvent?.agentId).toBe("operator-2");
  });

  it("rejects when the step is not pending", async () => {
    await seedInReviewTask("FN-RES-003", {
      workflowStepResults: [pendingStep({ status: "passed" })],
    });
    await expect(
      store().resumeWorkflowStep("FN-RES-003", {
        stepId: "code-review",
        reason: "x",
        actor: "operator",
      }),
    ).rejects.toThrow(/only pending steps can be resumed/);
  });

  it("points an archived failure carrier at bypass without rewriting its history", async () => {
    const archived = archiveTerminalWorkflowStepFailures([
      pendingStep({ status: "failed", completedAt: "2026-09-02T00:00:00.000Z" }),
    ], "2026-09-03T00:00:00.000Z")![0]!;
    await seedInReviewTask("FN-RES-003A", { workflowStepResults: [archived] });

    await expect(store().resumeWorkflowStep("FN-RES-003A", {
      stepId: "code-review", reason: "x", actor: "operator",
    })).rejects.toThrow(/archived remediation carrier.*fn_task_bypass_review/);
    expect((await store().getTask("FN-RES-003A")).workflowStepResults?.[0]).toMatchObject({
      status: "skipped", remediationArchivedAt: "2026-09-03T00:00:00.000Z", remediationArchivedFromStatus: "failed",
    });
  });

  it("rejects when the step is not found as a pending pre-merge step", async () => {
    await seedInReviewTask("FN-RES-004", { workflowStepResults: [] });
    await expect(
      store().resumeWorkflowStep("FN-RES-004", {
        stepId: "non-existent-step",
        reason: "x",
        actor: "operator",
      }),
    ).rejects.toThrow(/not found as a pending pre-merge step/);
  });

  it("rejects resuming a post-merge step (pre-merge boundary, FNXC:StepResume)", async () => {
    await seedInReviewTask("FN-RES-004B", {
      workflowStepResults: [pendingStep({ workflowStepId: "post-deploy", workflowStepName: "Post Deploy", phase: "post-merge" })],
    });
    await expect(
      store().resumeWorkflowStep("FN-RES-004B", {
        stepId: "post-deploy",
        reason: "x",
        actor: "operator",
      }),
    ).rejects.toThrow(/not found as a pending pre-merge step/);
  });

  it("rejects a blank reason", async () => {
    await seedInReviewTask("FN-RES-005", { workflowStepResults: [pendingStep()] });
    await expect(
      store().resumeWorkflowStep("FN-RES-005", {
        stepId: "code-review",
        reason: "   ",
        actor: "operator",
      }),
    ).rejects.toThrow(/non-empty reason/);
  });

  it("rejects a blank stepId", async () => {
    await seedInReviewTask("FN-RES-006", { workflowStepResults: [pendingStep()] });
    await expect(
      store().resumeWorkflowStep("FN-RES-006", {
        stepId: "",
        reason: "x",
        actor: "operator",
      }),
    ).rejects.toThrow(/non-empty stepId/);
  });

  it("rejects when the task is not in-review or in-progress", async () => {
    await seedInReviewTask("FN-RES-007", {
      workflowStepResults: [pendingStep()],
      column: "todo",
    });
    await expect(
      store().resumeWorkflowStep("FN-RES-007", {
        stepId: "code-review",
        reason: "x",
        actor: "operator",
      }),
    ).rejects.toThrow(/task is in 'todo', must be in .* or a WIP/);
  });

  it("works on tasks in in-progress column", async () => {
    await seedInReviewTask("FN-RES-008", {
      workflowStepResults: [pendingStep()],
      column: "in-progress",
    });

    const updated = await store().resumeWorkflowStep("FN-RES-008", {
      stepId: "code-review",
      reason: "stuck pending step in execution",
      actor: "operator-3",
    });

    const result = updated.workflowStepResults?.[0];
    expect(result?.status).toBe("failed");
    expect(result?.resumedBy).toBe("operator-3");
    expect(result?.resumedFromStatus).toBe("pending");
  });

  it("preserves existing pending step properties after resume", async () => {
    await seedInReviewTask("FN-RES-009", {
      workflowStepResults: [
        pendingStep({ source: "optional-group", startedAt: "2026-07-17T16:10:10.052Z" }),
      ],
    });

    const updated = await store().resumeWorkflowStep("FN-RES-009", {
      stepId: "code-review",
      reason: "dispatch callback never received",
      actor: "operator",
    });

    const result = updated.workflowStepResults?.[0];
    expect(result?.workflowStepId).toBe("code-review");
    expect(result?.workflowStepName).toBe("Code Review");
    expect(result?.phase).toBe("pre-merge");
    expect(result?.source).toBe("optional-group");
    expect(result?.startedAt).toBe("2026-07-17T16:10:10.052Z");
    expect(result?.status).toBe("failed");
    expect(result?.resumedFromStatus).toBe("pending");
  });

  it("clears lease ownership on the resumed step result (FNXC:StepResume lease cleanup)", async () => {
    await seedInReviewTask("FN-RES-010", {
      workflowStepResults: [
        pendingStep({ leaseOwner: "agent-reviewer-1", leaseNodeId: "review-1" }),
      ],
    });

    const updated = await store().resumeWorkflowStep("FN-RES-010", {
      stepId: "code-review",
      reason: "lease owner never completed the verdict callback",
      actor: "operator",
    });

    const result = updated.workflowStepResults?.[0];
    expect(result?.status).toBe("failed");
    // A terminal 'failed' result must not carry the stale dispatch lease forward.
    expect(result?.leaseOwner).toBeUndefined();
    expect(result?.leaseNodeId).toBeUndefined();
  });

  /*
   * FNXC:OperatorEscapeHatch 2026-09-11-14:35 (RUFU-219):
   * The four pause-shape cases below ARE the behavior change: before RUFU-219 the store refused
   * the first two and accepted nothing about the third/fourth. `seedInReviewTask`'s `paused: true`
   * goes through `updateTask`, which cannot write `userPaused` — so the seeded row is the exact
   * shape of every engine park sink (`{ paused: true }`, reason or no reason).
   */
  async function expectByteFrozenPauseRefusal(id: string): Promise<void> {
    // Byte-frozen: built independently of the store so a production-side edit to the sentence
    // (or a widened gate that leaks a DIFFERENT refusal) fails this assertion, not silently passes.
    const frozen = `Cannot resume workflow step for ${id}: task is paused`;
    await expect(
      store().resumeWorkflowStep(id, {
        stepId: "code-review",
        reason: "x",
        actor: "operator",
      }),
    ).rejects.toThrowError(new Error(frozen));
  }

  it("accepts an engine-parked card in the review lane and keeps it parked", async () => {
    // The exact Symptom-Verification seed: `paused: true` plus an engine `pausedReason`, no
    // `userPaused`. The fixture asserts its own shape so a fixture drift can never masquerade
    // as a production change.
    await seedInReviewTask("FN-RES-011", {
      workflowStepResults: [pendingStep()],
      paused: true,
      pausedReason: "in-review-stall-deadlock",
    });
    const seeded = await store().getTask("FN-RES-011");
    expect(seeded.paused).toBe(true);
    expect(seeded.userPaused).toBeUndefined();
    expect(seeded.pausedReason).toBe("in-review-stall-deadlock");

    const updated = await store().resumeWorkflowStep("FN-RES-011", {
      stepId: "code-review",
      reason: "stall-deadlock park wedged the verdict callback",
      actor: "operator",
    });

    const result = updated.workflowStepResults?.[0];
    expect(result?.status).toBe("failed");
    expect(result?.resumedFromStatus).toBe("pending");
    // In-place resume: the park is NOT lifted and the card is NOT moved — lifecycle containment.
    expect(updated.paused).toBe(true);
    expect(updated.pausedReason).toBe("in-review-stall-deadlock");
    expect(updated.userPaused).toBeUndefined();
    expect(updated.column).toBe("in-review");

    // AC1: the accepted resume carries the `task:resume-step` run-audit row, actor server-derived
    // (the store records the caller's actor verbatim; the CLI layer derives `cli-operator`).
    const events = await queryRunAuditEvents(h.layer().db, { taskId: "FN-RES-011" });
    const resumeEvent = events.find((event) => event.mutationType === "task:resume-step");
    expect(resumeEvent).toBeDefined();
    expect(resumeEvent?.agentId).toBe("operator");

    // AC3: acceptance never releases the merge door. While parked, the pause itself is the
    // blocker; and the unparked view must still be refused by the freshly `failed` carrier —
    // resume flips the wedge into the next operator decision (bypass or rework), not a merge.
    expect(getTaskMergeBlocker(updated, {})).toBe("task is paused");
    expect(getTaskMergeBlocker({ ...updated, paused: false }, {})).toBe(
      "task has failed pre-merge workflow steps",
    );
  });

  it("accepts an engine-parked card in the WIP lane (outright refused before RUFU-219)", async () => {
    // WIP-lane twin wearing a DIFFERENT park class (retry-exhausted budget park) — before
    // RUFU-219 the bare `paused` gate fired before lane resolution, so this card had no path.
    await seedInReviewTask("FN-RES-012", {
      workflowStepResults: [pendingStep()],
      paused: true,
      pausedReason: "token_budget_exceeded",
      column: "in-progress",
    });

    const updated = await store().resumeWorkflowStep("FN-RES-012", {
      stepId: "code-review",
      reason: "graph-failure park mid-execution wedged the gate",
      actor: "operator",
    });

    expect(updated.workflowStepResults?.[0]?.status).toBe("failed");
    expect(updated.paused).toBe(true);
    expect(updated.pausedReason).toBe("token_budget_exceeded");
    expect(updated.column).toBe("in-progress");
  });

  it("refuses an operator hold in the review lane with the byte-frozen sentence, reason-blind", async () => {
    await seedInReviewTask("FN-RES-013", { workflowStepResults: [pendingStep()] });
    // The hold wears an engine park's reason: the predicate reads only the PAIR of flags, so a
    // stall-deadlock `pausedReason` must not launder a human hold back into an accepted park.
    await store().pauseTask("FN-RES-013", true, undefined, {
      userPaused: true,
      pausedReason: "in-review-stall-deadlock",
    });
    const held = await store().getTask("FN-RES-013");
    expect(held.paused).toBe(true);
    expect(held.userPaused).toBe(true);
    expect(held.pausedReason).toBe("in-review-stall-deadlock");

    await expectByteFrozenPauseRefusal("FN-RES-013");

    // Refusal mutates nothing: neither the wedged step nor an audit row.
    expect((await store().getTask("FN-RES-013")).workflowStepResults?.[0]?.status).toBe("pending");
    const events = await queryRunAuditEvents(h.layer().db, { taskId: "FN-RES-013" });
    expect(events.some((event) => event.mutationType === "task:resume-step")).toBe(false);
  });

  it("refuses an operator hold in the WIP lane with the byte-frozen sentence", async () => {
    await seedInReviewTask("FN-RES-014", {
      workflowStepResults: [pendingStep()],
      column: "in-progress",
    });
    await store().pauseTask("FN-RES-014", true, undefined, { userPaused: true });

    await expectByteFrozenPauseRefusal("FN-RES-014");

    const events = await queryRunAuditEvents(h.layer().db, { taskId: "FN-RES-014" });
    expect(events.some((event) => event.mutationType === "task:resume-step")).toBe(false);
  });

  it("refuses an operator hold before the lane check even on an unrelated column", async () => {
    await seedInReviewTask("FN-RES-015", {
      workflowStepResults: [pendingStep()],
      column: "todo",
    });
    await store().pauseTask("FN-RES-015", true, undefined, { userPaused: true });

    // The held card gets the PAUSE sentence, never the lane sentence — gate order proof:
    // a held card cannot trade the hold refusal for the (weaker) lane refusal by sitting oddly.
    await expectByteFrozenPauseRefusal("FN-RES-015");
  });

  it("does not treat userPaused without paused as a hold (the predicate is the pair)", async () => {
    await seedInReviewTask("FN-RES-016", { workflowStepResults: [pendingStep()] });
    await store().pauseTask("FN-RES-016", true, undefined, { userPaused: true });
    // Clear ONLY the pause latch: `paused` goes falsy while `user_paused` stays. The fixture
    // asserts its own shape — if updateTask ever learns to clear userPaused too, this test names it.
    await store().updateTask("FN-RES-016", { paused: false });
    const fixture = await store().getTask("FN-RES-016");
    expect(fixture.paused).toBeFalsy();
    expect(fixture.userPaused).toBe(true);

    const updated = await store().resumeWorkflowStep("FN-RES-016", {
      stepId: "code-review",
      reason: "latch cleared, only the stale userPaused flag remains",
      actor: "operator",
    });
    expect(updated.workflowStepResults?.[0]?.status).toBe("failed");
  });

  it("accepts every engine park class — the pause gate never reads pausedReason", async () => {
    // Surface Enumeration's park-class variety. `in-review-stall-deadlock` (FN-RES-011) and
    // `token_budget_exceeded` (FN-RES-012) are already covered per lane; the rest of the
    // minimum set runs here so the predicate's reason-blindness is asserted, not assumed.
    const parkClasses = [
      "merge-deadlock-detected",
      "branch-conflict-unrecoverable",
      "dispatch-oscillation",
      "non-retryable-provider-error",
      "external-block",
    ];
    let index = 0;
    for (const pausedReason of parkClasses) {
      const id = `FN-RES-017-${++index}`;
      await seedInReviewTask(id, {
        workflowStepResults: [pendingStep()],
        paused: true,
        pausedReason,
      });
      const updated = await store().resumeWorkflowStep(id, {
        stepId: "code-review",
        reason: "RUFU-219: park classes must not gate the resume hatch",
        actor: "operator",
      });
      expect(updated.workflowStepResults?.[0]?.status, `park class ${pausedReason}`).toBe("failed");
      expect(updated.pausedReason, `park class ${pausedReason}`).toBe(pausedReason);
    }
  });

  it("surfaces the lane refusal (not the pause refusal) for an engine-parked card outside review/WIP", async () => {
    await seedInReviewTask("FN-RES-018", {
      workflowStepResults: [pendingStep()],
      paused: true,
      column: "todo",
    });
    // Intentional narrowing, asserted as the twin of FN-RES-015: an engine park falls through
    // the pause gate and the LANE sentence wins; a human hold (FN-RES-015) still gets the PAUSE
    // sentence from the same column. Together they pin the gate order under the new predicate.
    await expect(
      store().resumeWorkflowStep("FN-RES-018", {
        stepId: "code-review",
        reason: "x",
        actor: "operator",
      }),
    ).rejects.toThrow(/task is in 'todo', must be in .* or a WIP/);
    // The refusal is a refusal: the wedged step is untouched.
    expect((await store().getTask("FN-RES-018")).workflowStepResults?.[0]?.status).toBe("pending");
  });
});