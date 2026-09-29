import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { WorkflowStepResult } from "../types.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";
import { queryRunAuditEvents } from "../task-store/async/async-audit.js";
import {
  getTaskMergeBlocker,
  isPreMergeStepsNotRunBlocker,
  PRE_MERGE_STEPS_NOT_RUN_BLOCKER,
} from "../merge/task-merge.js";
import { resolveRequiredPreMergeStepIds } from "../merge/required-pre-merge-steps.js";
import { getRequiredPostMergeEvidenceBlocker } from "../merge/confirmed-merge-reconciliation.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../workflows/builtin-coding-workflow-ir.js";

/*
 * FNXC:ReviewLaneBypass 2026-07-09-00:00:
 * Store-level coverage for FN-7720's bypassFailedPreMergeReviewStep primitive:
 * eligibility gating (in-review, not operator-held, has a failed pre-merge step,
 * mandatory reason), the bypass rewrite (status → skipped + audit metadata,
 * no fabricated verdict), the run-audit/log breadcrumb, and the
 * autoMerge:false human-review contract (blocker cleared, task NOT
 * auto-moved to done).
 *
 * FNXC:PostgresCutover 2026-07-10: ported from upstream's sqlite version to
 * the shared PG harness (the sqlite TaskStore runtime is removed on this
 * branch); assertions are unchanged.
 */

pgDescribe("TaskStore.bypassFailedPreMergeReviewStep", () => {
  /*
  FNXC:ReviewLaneBypass 2026-09-03-13:57 (RUFU-179):
  The harness is project-BOUND now because FN-227's completion-lane Patchnode capture (2026-08-28)
  intentionally aborts any move into `done` on a store with no project partition — "An unbound
  writer must fail this transaction instead of manufacturing a legacy project id". The FN-BYP-007
  autoMerge:false test performs exactly such a move (bypass must clear the merge blocker while a
  later MANUAL move to done succeeds), so on the old project-agnostic ("") harness the fixture's
  own move aborted and the test was deterministically red on main. Binding the partition states the
  fixture's real intent (FN-227 behavior, unchanged assertions); every write and read here shares
  one partition, so partition-scoped reads (run-audit, config re-seed) stay consistent.
  */
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_bypass_review",
    projectId: "core-store-bypass-review",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  function failedStep(overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
    return {
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      phase: "pre-merge",
      status: "failed",
      output: "(no feedback captured)",
      verdict: undefined,
      completedAt: "2026-07-09T00:00:00.000Z",
      ...overrides,
    };
  }

  function store() {
    return h.store();
  }

  async function seedInReviewTask(id: string, options: { workflowStepResults?: WorkflowStepResult[]; paused?: boolean; operatorHold?: boolean; workflowId?: string } = {}) {
    await store().createTaskWithReservedId(
      { description: `Task ${id}`, column: "in-review", workflowId: options.workflowId },
      { taskId: id, applyDefaultWorkflowSteps: false },
    );
    await store().updateTask(id, {
      workflowStepResults: options.workflowStepResults ?? null,
      paused: options.paused,
    });
    /*
    FNXC:ReviewLaneBypass 2026-09-10-23:19 (RUFU-218):
    Two pause shapes, because the store now refuses only the second one:
    - `paused: true` alone = an ENGINE PARK (a graph-failure / stall / mission-autopilot sink). The
      Move-Task contract forbids an engine rebound from setting `userPaused`, and `updateTask`
      cannot write that column at all, which is why this plain route IS the engine shape.
    - `operatorHold: true` = the real operator hold, seeded on the REAL write path (`pauseTask` with
      `userPaused: true`, the dashboard's own shape). `updateTask` is unable to produce it, so a
      test that wanted the hold had to fake it — and instead faked the engine park while claiming to
      test the hold.
    */
    if (options.operatorHold) {
      await store().pauseTask(id, true, undefined, { userPaused: true });
    }
    return store().getTask(id);
  }

  it("rewrites the failed step to skipped with bypass audit metadata and no fabricated verdict", async () => {
    await seedInReviewTask("FN-BYP-001", { workflowStepResults: [failedStep()] });

    const updated = await store().bypassFailedPreMergeReviewStep("FN-BYP-001", {
      reason: "Runfusion/Fusion#1946 no-verdict dispatch defect",
      actor: "operator-1",
    });

    const result = updated.workflowStepResults?.[0];
    expect(result?.status).toBe("skipped");
    expect(result?.verdict).toBeUndefined();
    expect(result?.bypassedBy).toBe("operator-1");
    expect(result?.bypassReason).toBe("Runfusion/Fusion#1946 no-verdict dispatch defect");
    expect(result?.bypassedFromStatus).toBe("failed");
    expect(typeof result?.bypassedAt).toBe("string");

    // Audit trail: task log entry recorded.
    const logged = updated.log?.some((entry) => entry.action.includes("Review lane bypassed"));
    expect(logged).toBe(true);
  });

  /*
  FNXC:ReviewBypass 2026-07-29-09:30 (U9):
  The case above asserts `verdict` is undefined against a fixture whose verdict is
  ALREADY undefined, so the assertion is vacuous: deleting `delete bypassed.verdict`
  from store.ts leaves it green. Measured by mutation — NEW-failures=0 across
  store-bypass-review, task-merge-bypass, task-merge and legacy-adoption.

  The invariant only has teeth when the failed step CARRIES a verdict. That is the
  real risk: a reviewer said REVISE, an operator bypasses, and the verdict rides
  forward onto a `skipped` step — so every downstream reader sees a reviewer verdict
  attached to a step no reviewer passed. FN-7720 requires the bypass to clear it and
  preserve the original only in the audit field.
  */
  it("clears a real verdict off the bypassed step and keeps it only as audit history", async () => {
    await seedInReviewTask("FN-BYP-VERDICT", {
      workflowStepResults: [failedStep({ verdict: "REVISE", output: "reviewer asked for changes" })],
    });

    const updated = await store().bypassFailedPreMergeReviewStep("FN-BYP-VERDICT", {
      reason: "operator override after reviewer outage",
      actor: "operator-2",
    });

    const result = updated.workflowStepResults?.[0];
    expect(result?.status).toBe("skipped");
    // The bypass must NOT carry the reviewer's verdict onto the skipped step.
    expect(result?.verdict).toBeUndefined();
    // ...but it must not lose it either: the audit field preserves what was bypassed.
    expect(result?.bypassedFromVerdict).toBe("REVISE");
    expect(result?.bypassedFromStatus).toBe("failed");
    expect(result?.bypassedBy).toBe("operator-2");
  });

  it("refuses to bypass the FN-9372 no-verdict shape when it carries an open finding", async () => {
    await seedInReviewTask("FN-BYP-FINDING", {
      workflowStepResults: [failedStep({
        findings: [{
          id: "fn-9372-unfixed-pipeline-smoke",
          title: "Pipeline smoke remains unfixed",
          body: "The review must be re-run after the smoke fix.",
          severity: "critical",
          resolution: "open",
        }],
      })],
    });

    await expect(store().bypassFailedPreMergeReviewStep("FN-BYP-FINDING", {
      reason: "dispatch defect",
      actor: "operator-1",
    })).rejects.toThrow("failed review has open findings");
    const task = await store().getTask("FN-BYP-FINDING");
    expect(task.workflowStepResults?.[0]?.status).toBe("failed");
    expect(task.workflowStepResults?.[0]?.verdict).toBeUndefined();
    expect(task.workflowStepResults?.[0]?.bypassedBy).toBeUndefined();
  });

  it("records a run-audit event for the bypass", async () => {
    await seedInReviewTask("FN-BYP-002", { workflowStepResults: [failedStep()] });
    await store().bypassFailedPreMergeReviewStep("FN-BYP-002", { reason: "infra failure", actor: "operator-2" });

    // FNXC:PostgresCutover 2026-07-10: getRunAuditEvents is the sync/sqlite
    // reader and intentionally returns [] in backend mode; the authoritative
    // PG read is the async queryRunAuditEvents helper.
    const events = await queryRunAuditEvents(h.layer().db, { taskId: "FN-BYP-002" });
    const bypassEvent = events.find((event) => event.mutationType === "task:bypass-review");
    expect(bypassEvent).toBeDefined();
    expect(bypassEvent?.agentId).toBe("operator-2");
  });

  it("rejects when the task is not in-review", async () => {
    await store().createTaskWithReservedId(
      { description: "todo task", column: "todo" },
      { taskId: "FN-BYP-003", applyDefaultWorkflowSteps: false },
    );
    await expect(
      store().bypassFailedPreMergeReviewStep("FN-BYP-003", { reason: "x", actor: "operator" }),
    ).rejects.toThrow(/must be in 'in-review'/);
  });

  it("rejects when the task carries an operator hold", async () => {
    /*
    FNXC:ReviewLaneBypass 2026-09-10-23:19 (RUFU-218):
    THE FIXED DEFECT, STORE SIDE. This case used to seed `paused: true` through `updateTask` and
    expect refusal — which asserted the bug, because bare `paused` is what an engine rebound writes
    and the Move-Task contract guarantees `userPaused` stays unset on that path. It now seeds the
    real hold via `pauseTask(..., { userPaused: true })`, and the byte-frozen sentence is still the
    answer. The `task is paused` regex is deliberate: the message must not change.
    */
    await seedInReviewTask("FN-BYP-004", { workflowStepResults: [failedStep()], operatorHold: true });
    await expect(
      store().bypassFailedPreMergeReviewStep("FN-BYP-004", { reason: "x", actor: "operator" }),
    ).rejects.toThrow(/Cannot bypass review lane for FN-BYP-004: task is paused/);
  });

  /*
  FNXC:ReviewLaneBypass 2026-09-10-23:19 (RUFU-218):
  AN ENGINE PARK MUST NOT CONFISCATE THE HATCH. This is the RUFU-204 card class: the stall router /
  graph-failure sink wrote bare `paused: true`, no agent runs, no retry is due, and the operator's
  only lever was the gate-confiscated bypass. Three properties are pinned at once, because the
  earlier shape of this bug was a fix that "un-hid" the affordance by unpausing the card — which
  would violate AGENTS.md's Move-Task contract by making an escape hatch resume automation:
  - the bypass ACCEPTS a parked card whose problem is a failed gate;
  - the rewrite carries the full audit metadata and the `task:bypass-review` row still lands;
  - the card is STILL parked afterwards (`paused: true`, `userPaused` unset, `column` unchanged) —
    the bypass mutates the gate row only, and Retry/unpause remains the operator's resume step.
  */
  it("accepts an engine-parked card with a failed gate and leaves the park intact", async () => {
    await seedInReviewTask("FN-BYP-EPARK-FAILED", { workflowStepResults: [failedStep()], paused: true });

    const updated = await store().bypassFailedPreMergeReviewStep("FN-BYP-EPARK-FAILED", {
      reason: "stall-deadlock park; reviewer lane never produced a verdict",
      actor: "operator-parked",
    });

    const result = updated.workflowStepResults?.[0];
    expect(result).toMatchObject({
      status: "skipped",
      bypassedBy: "operator-parked",
      bypassedFromStatus: "failed",
    });
    expect(result?.verdict).toBeUndefined();

    /* Lifecycle containment (acceptance criterion 6): no auto-unpause, no move, no merge. */
    expect(updated.paused).toBe(true);
    expect(updated.userPaused).toBeUndefined();
    expect(updated.column).toBe("in-review");

    const events = await queryRunAuditEvents(h.layer().db, { taskId: "FN-BYP-EPARK-FAILED" });
    expect(events.find((event) => event.mutationType === "task:bypass-review")?.agentId)
      .toBe("operator-parked");

    /* A second operator hold afterwards is still refused: narrowing the pause gate did not soften
       the hold path, it only stopped it from firing on the wrong shape. */
    await store().pauseTask("FN-BYP-EPARK-FAILED", true, undefined, { userPaused: true });
    await expect(
      store().bypassFailedPreMergeReviewStep("FN-BYP-EPARK-FAILED", { reason: "x", actor: "operator" }),
    ).rejects.toThrow(/task is paused/);
  });

  /*
  FNXC:ReviewLaneBypass 2026-09-10-23:19 (RUFU-218):
  Same hatch, other kind: FN-158's unrun required gate on a parked card. The stalled card the board
  actually shows is frequently this shape (the SANE-387 sentence), so the `absent` branch has to
  reach a parked card too, not just the `failed` one.
  */
  it("accepts an engine-parked card whose required gate never ran", async () => {
    await seedInReviewTask("FN-BYP-EPARK-ABSENT", { workflowStepResults: [], workflowId: "builtin:coding", paused: true });
    await store().updateTask("FN-BYP-EPARK-ABSENT", { enabledWorkflowSteps: ["plan-review"] });

    const updated = await store().bypassFailedPreMergeReviewStep("FN-BYP-EPARK-ABSENT", {
      reason: "stall park; the plan-review gate never dispatched",
      actor: "operator-parked-absent",
    });

    expect(updated.workflowStepResults?.find((entry) => entry.workflowStepId === "plan-review"))
      .toMatchObject({
        status: "skipped",
        bypassedFromStatus: "absent",
        bypassedBy: "operator-parked-absent",
      });
    expect(updated.paused).toBe(true);
    expect(updated.column).toBe("in-review");
  });

  /*
  FNXC:ReviewLaneBypass 2026-09-10-23:19 (RUFU-218):
  NARROWING, NOT REMOVING. An engine park is not a ticket past the OTHER gates: a parked card with
  nothing bypassable is still refused for its real reason (no bypassable gate), not for a pause. If
  this ever answers "task is paused" again, the freeze has come back wearing a different message.
  */
  it("still refuses an engine-parked card that has no bypassable gate, for its real reason", async () => {
    await seedInReviewTask("FN-BYP-EPARK-NOGATE", { workflowStepResults: [failedStep({ status: "passed", verdict: "APPROVE" })], paused: true });
    await store().updateTask("FN-BYP-EPARK-NOGATE", { enabledWorkflowSteps: [] });

    await expect(
      store().bypassFailedPreMergeReviewStep("FN-BYP-EPARK-NOGATE", { reason: "x", actor: "operator" }),
    ).rejects.toThrow(/no failed pre-merge review step/);
  });

  it("records a skipped result for an enabled gate that never produced a result", async () => {
    await seedInReviewTask("FN-BYP-ABSENT", { workflowStepResults: [], workflowId: "builtin:coding" });

    const updated = await store().bypassFailedPreMergeReviewStep("FN-BYP-ABSENT", {
      reason: "operator bypass for a resultless required gate",
      actor: "operator-absent",
    });

    const result = updated.workflowStepResults?.find((entry) => entry.workflowStepId === "plan-review");
    expect(result).toMatchObject({
      status: "skipped",
      bypassedFromStatus: "absent",
      bypassedBy: "operator-absent",
    });
    expect(result?.verdict).toBeUndefined();
  });

  /*
  FNXC:ReviewLaneBypass 2026-09-03-12:40 (RUFU-179):
  THE SANE-387 SYMPTOM END TO END. The case above proves the rewrite SHAPE; this one proves the
  operator-visible CONSEQUENCE — the card's merge blocker is the not-run sentence before the bypass
  and gone after it. That direction is the whole defect: the store accepted this bypass since
  FN-158, but no UI surface offered it, so the sentence stayed on the card until an operator typed
  the CLI/HTTP call by hand. `enabledWorkflowSteps: ["plan-review"]` pins the required set to a
  single gate (the explicit list overrides the IR's default-on code-review group), so the assertion
  proves the bypass clears THE blocker rather than merely adding one skipped row beside two others.
  */
  it("clears the not-run merge blocker when the only gate never ran (SANE-387 shape)", async () => {
    await seedInReviewTask("FN-BYP-ABSENT-BLOCK", { workflowStepResults: [], workflowId: "builtin:coding" });
    /*
    "Blocked SOLELY by the unrun gate": the hybrid step storage re-derives plan steps from the
    task's PROMPT.md on every read, so the fixture marks those steps done (the honest review-lane
    shape — implementation finished, plan complete) instead of clearing the array, which would only
    mark the plan "not parsed yet" and re-hydrate pending steps (see FNXC:HybridStepStorage in
    task-update.ts). The explicit enabled list pins the required gate set to plan-review alone.
    */
    const seededTask = await store().getTask("FN-BYP-ABSENT-BLOCK");
    await store().updateTask("FN-BYP-ABSENT-BLOCK", {
      enabledWorkflowSteps: ["plan-review"],
      steps: (seededTask.steps ?? []).map((step) => ({ ...step, status: "done" as const })),
    });

    const before = await store().getTask("FN-BYP-ABSENT-BLOCK");
    // Merge doors resolve the required set exactly this way (moves.ts), so the fixture and the
    // production question use one resolver instead of a hand-copied set that could drift.
    const required = resolveRequiredPreMergeStepIds(BUILTIN_CODING_WORKFLOW_IR, before.enabledWorkflowSteps, before);
    expect([...required]).toEqual(["plan-review"]);

    const beforeBlocker = getTaskMergeBlocker(before, { requiredPreMergeStepIds: required });
    expect(beforeBlocker).toBe(PRE_MERGE_STEPS_NOT_RUN_BLOCKER);

    await store().bypassFailedPreMergeReviewStep("FN-BYP-ABSENT-BLOCK", {
      reason: "gate never dispatched; operator releases the card",
      actor: "operator-block",
    });

    const after = await store().getTask("FN-BYP-ABSENT-BLOCK");
    const afterBlocker = getTaskMergeBlocker(after, { requiredPreMergeStepIds: required });
    expect(afterBlocker).toBeUndefined();
    expect(isPreMergeStepsNotRunBlocker(afterBlocker)).toBe(false);
    // The skipped carrier records the operator decision; it must never read as a reviewer approval.
    const skipped = after.workflowStepResults?.find((entry) => entry.workflowStepId === "plan-review");
    expect(skipped?.verdict).toBeUndefined();
  });

  /*
  FNXC:ReviewLaneBypass 2026-09-03-12:40 (RUFU-179):
  A `pending` result counts as PRESENT for target selection. A gate that is running is not a gate
  that never ran, and offering to skip it mid-flight would let an operator bypass past a review in
  progress — the derivation classifies it as neither kind, so the store refuses with the established
  generic sentence while the FN-8492/STAS-032 resume seam remains the route for a wedged `pending`.
  */
  it("rejects when the only required gate has a pending (in-flight) result", async () => {
    await seedInReviewTask("FN-BYP-PENDING", { workflowStepResults: [], workflowId: "builtin:coding" });
    await store().updateTask("FN-BYP-PENDING", { enabledWorkflowSteps: ["plan-review"] });
    await store().updateTask("FN-BYP-PENDING", {
      workflowStepResults: [{
        workflowStepId: "plan-review",
        workflowStepName: "Plan Review",
        phase: "pre-merge",
        status: "pending",
      }],
    });

    await expect(
      store().bypassFailedPreMergeReviewStep("FN-BYP-PENDING", { reason: "x", actor: "operator" }),
    ).rejects.toThrow(/no failed pre-merge review step/);
  });

  /*
  FNXC:ReviewLaneBypass 2026-09-06-00:47:
  An archived failure remains an audit carrier. FN-9266 preserves its archive provenance and permits
  only the audited operator waiver to satisfy the merge gate.
  */
  it("bypasses a required gate archived by another gate's remediation", async () => {
    const archived = failedStep({
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      status: "skipped",
      reviewKind: "plan",
      remediationArchivedAt: "2026-09-04T19:28:37.579Z",
      remediationArchivedFromStatus: "failed",
    });
    const approvedCodeReview = failedStep({ status: "passed", verdict: "APPROVE", reviewKind: "code" });
    await seedInReviewTask("FN-BYP-ARCHIVED", { workflowStepResults: [archived, approvedCodeReview], workflowId: "builtin:coding" });

    const updated = await store().bypassFailedPreMergeReviewStep("FN-BYP-ARCHIVED", {
      reason: "gate archived as collateral of a code-review remediation",
      actor: "operator-archived",
    });

    const result = updated.workflowStepResults?.find((entry) => entry.workflowStepId === "plan-review");
    expect(result).toMatchObject({
      status: "skipped",
      bypassedBy: "operator-archived",
      bypassedFromStatus: "failed",
    });
    expect(result?.verdict).toBeUndefined();
    expect(result?.remediationArchivedAt).toBe("2026-09-04T19:28:37.579Z");
    expect(result?.remediationArchivedFromStatus).toBe("failed");
  });

  it("rejects when there is no failed or enabled resultless pre-merge step", async () => {
    await seedInReviewTask("FN-BYP-005", { workflowStepResults: [failedStep({ status: "passed" })] });
    await store().updateTask("FN-BYP-005", { enabledWorkflowSteps: [] });
    await expect(
      store().bypassFailedPreMergeReviewStep("FN-BYP-005", { reason: "x", actor: "operator" }),
    ).rejects.toThrow(/no failed pre-merge review step/);
  });

  /*
  FNXC:PostMergeGateOperatorWaiver 2026-09-29-15:49 (RUFU-408):
  THE HUMAN DECISION THE NOTICE PROMISED, ENDED TO END. RUFU-370's mailbox message on a landed card
  reads "either an operator bypass of the gate or a workflow whose post-merge node can run", and the
  first half did not exist: `bypassFailedPreMergeReviewStep` derived its target from PRE-merge gates
  only, so seven merge-CONFIRMED saneca cards in `in-review` were told to use a lever that answered
  `no failed pre-merge review step found` (measured 2026-09-29, 5,319
  task:auto-merge-finalize-post-merge-gate-unreachable rows in one day).

  Asserted on the real builtin:coding IR through the store, in the direction the board actually
  experiences: the post-merge blocker before, the phase-stamped audited carrier after, and the SAME
  resolver answering no blocker. The phase matters — a `skipped` row stamped `pre-merge` would be read
  by `evaluatePreMergeApprovals` as a pre-merge gate result, i.e. a waiver written into the wrong door.
  */
  it("bypasses a required POST-merge gate that never reported and clears the finalization blocker", async () => {
    await seedInReviewTask("FN-BYP-POSTMERGE", {
      workflowStepResults: [
        { workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge", status: "passed", verdict: "APPROVE" },
        { workflowStepId: "code-review", workflowStepName: "Code Review", phase: "pre-merge", status: "passed", verdict: "APPROVE" },
      ],
      workflowId: "builtin:coding",
    });
    const seeded = await store().getTask("FN-BYP-POSTMERGE");
    await store().updateTask("FN-BYP-POSTMERGE", {
      enabledWorkflowSteps: ["plan-review", "code-review", "post-merge-verification"],
      mergeDetails: { commitSha: "0123456789abcdef0123456789abcdef01234567", mergeConfirmed: true },
      steps: (seeded.steps ?? []).map((step) => ({ ...step, status: "done" as const })),
    });

    const before = await store().getTask("FN-BYP-POSTMERGE");
    expect(await getRequiredPostMergeEvidenceBlocker(store(), before))
      .toBe("required post-merge evidence gate 'post-merge-verification' has not reported");

    await store().bypassFailedPreMergeReviewStep("FN-BYP-POSTMERGE", {
      reason: "post-merge gate cannot run for this card shape; operator releases landed work",
      actor: "operator-postmerge",
    });

    const after = await store().getTask("FN-BYP-POSTMERGE");
    const waived = after.workflowStepResults?.find((entry) => entry.workflowStepId === "post-merge-verification");
    expect(waived?.status).toBe("skipped");
    expect(waived?.phase).toBe("post-merge");
    expect(waived?.bypassedBy).toBe("operator-postmerge");
    expect(waived?.bypassedFromStatus).toBe("absent");
    // A waiver is a human decision recorded against the gate, never a reviewer approval.
    expect(waived?.verdict).toBeUndefined();
    expect(await getRequiredPostMergeEvidenceBlocker(store(), after)).toBeUndefined();
  });

  /*
  FNXC:PostMergeGateOperatorWaiver 2026-09-29-15:49 (RUFU-408): NEGATIVE PROOF. The pre-merge gate is
  still the first door: an unrun PRE-merge gate keeps precedence over an unrun post-merge one, so this
  hatch can never be used to step past a review that has not happened.
  */
  it("will not name the post-merge gate while a pre-merge gate is still outstanding", async () => {
    await seedInReviewTask("FN-BYP-POSTMERGE-ORDER", { workflowStepResults: [], workflowId: "builtin:coding" });
    await store().updateTask("FN-BYP-POSTMERGE-ORDER", {
      enabledWorkflowSteps: ["plan-review", "post-merge-verification"],
      mergeDetails: { commitSha: "0123456789abcdef0123456789abcdef01234567", mergeConfirmed: true },
    });

    const updated = await store().bypassFailedPreMergeReviewStep("FN-BYP-POSTMERGE-ORDER", {
      reason: "first bypass releases the pre-merge gate only",
      actor: "operator-order",
    });
    expect(updated.workflowStepResults?.map((entry) => entry.workflowStepId)).toEqual(["plan-review"]);

    // And the post-merge gate is NOT quietly waived as a side effect of that bypass.
    expect(await getRequiredPostMergeEvidenceBlocker(store(), await store().getTask("FN-BYP-POSTMERGE-ORDER")))
      .toBe("required post-merge evidence gate 'post-merge-verification' has not reported");
  });

  /*
  FNXC:PostMergeGateOperatorWaiver 2026-09-29-15:49 (RUFU-408): NEGATIVE PROOF for the merge-proof
  condition. The post-merge gate is not a door until the work lands, so an unlanded card with every
  pre-merge gate approved must still be refused — otherwise the menu item sits beside a healthy Merge
  button and an operator can waive delivery evidence the card has not earned yet.
  */
  it("refuses a post-merge waiver while the card has no durable merge proof", async () => {
    await seedInReviewTask("FN-BYP-POSTMERGE-UNLANDED", {
      workflowStepResults: [
        { workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge", status: "passed", verdict: "APPROVE" },
        { workflowStepId: "code-review", workflowStepName: "Code Review", phase: "pre-merge", status: "passed", verdict: "APPROVE" },
      ],
      workflowId: "builtin:coding",
    });
    await store().updateTask("FN-BYP-POSTMERGE-UNLANDED", {
      enabledWorkflowSteps: ["plan-review", "code-review", "post-merge-verification"],
    });

    await expect(
      store().bypassFailedPreMergeReviewStep("FN-BYP-POSTMERGE-UNLANDED", { reason: "x", actor: "operator" }),
    ).rejects.toThrow(/no failed pre-merge review step/);
  });

  it("rejects a blank reason", async () => {
    await seedInReviewTask("FN-BYP-006", { workflowStepResults: [failedStep()] });
    await expect(
      store().bypassFailedPreMergeReviewStep("FN-BYP-006", { reason: "   ", actor: "operator" }),
    ).rejects.toThrow(/non-empty reason/);
  });

  it("clears the merge blocker but does not force-move an autoMerge:false task to done", async () => {
    await seedInReviewTask("FN-BYP-007", { workflowStepResults: [failedStep()] });
    await store().updateTask("FN-BYP-007", { autoMerge: false });

    await store().bypassFailedPreMergeReviewStep("FN-BYP-007", { reason: "infra failure", actor: "operator" });

    const task = await store().getTask("FN-BYP-007");
    expect(task.column).toBe("in-review");

    // Blocker cleared: a manual move to done is now allowed by the merge gate,
    // but the bypass itself must not have performed that move.
    const moved = await store().moveTask("FN-BYP-007", "done");
    expect(moved.column).toBe("done");
  });

  it("does not re-select a bypassed step for self-healing recovery (status no longer 'failed')", async () => {
    await seedInReviewTask("FN-BYP-008", { workflowStepResults: [failedStep()] });
    const updated = await store().bypassFailedPreMergeReviewStep("FN-BYP-008", { reason: "infra failure", actor: "operator" });

    const latestFailedPreMergeStep = (task: { workflowStepResults?: WorkflowStepResult[] }) =>
      (task.workflowStepResults ?? []).filter((r) => (r.phase || "pre-merge") === "pre-merge" && r.status === "failed")[0];

    expect(latestFailedPreMergeStep(updated)).toBeUndefined();
  });
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-01:10 (PR #2709 review — greptile):
  THE REJECTION MUST NAME THE COLUMN THE CHECK USED. The guard was converted to the resolved review
  lane while the message still said `in-review`, so on a custom board an operator was refused and
  then told to move the card to a column their board does not have — through both the CLI and the
  dashboard, with nothing in the error to reveal the real target.

  That is worse than an unconverted guard. An inert guard fails visibly; this one refuses CORRECTLY
  and then misdirects, so the operator's next three attempts are all wrong for a reason the product
  told them.
  */
  it("accepts a humanReview-ONLY lane, which the singular `.review` excluded", async () => {
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-16:05 (PR #2718 review — greptile):
    `.review` is the single `mergeOrchestration` column, so a board hosting review on a `humanReview`-
    only lane failed this guard — `TaskContextMenu` offered "Bypass failed review" (it asks by ROLE)
    and the store refused it. The operator's only escape from a stranded failed pre-merge step returned
    a conflict.

    The BROAD set is right here because this guard refuses or permits and moves nothing; #2750
    documents why a caller that admits and then MOVES wants the narrow lane instead.
    */
    const definition = await store().createWorkflowDefinition({
      name: "human-review-bypass",
      ir: {
        version: "v2",
        name: "human-review-bypass",
        columns: [
          { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
          { id: "building", name: "Building", traits: [{ trait: "wip" }] },
          { id: "signoff", name: "Sign-off", traits: [{ trait: "human-review" }] },
          { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
        ],
        nodes: [{ id: "start", kind: "start", column: "backlog" }, { id: "end", kind: "end", column: "shipped" }],
        edges: [{ from: "start", to: "end" }],
      },
    } as never);

    await store().createTaskWithReservedId(
      { description: "human-review bypass", column: "signoff", workflowId: definition.id } as never,
      { taskId: "FN-HRB", applyDefaultWorkflowSteps: false },
    );
    await store().updateTask("FN-HRB", { workflowStepResults: [failedStep()] });

    /* Passes the lane guard; any later refusal is a different gate, which is the point. */
    await expect(
      store().bypassFailedPreMergeReviewStep("FN-HRB", { reason: "operator override" } as never),
    ).resolves.toBeDefined();
  });

  it("names the board's OWN review column when refusing a card that is elsewhere", async () => {
    const definition = await store().createWorkflowDefinition({
      name: "renamed-review",
      ir: {
        version: "v2",
        name: "renamed-review",
        columns: [
          { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }, { trait: "hold" }] },
          { id: "building", name: "Building", traits: [{ trait: "wip" }] },
          { id: "validating", name: "Validating", traits: [{ trait: "merge" }] },
          { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
        ],
        nodes: [{ id: "start", kind: "start", column: "backlog" }, { id: "end", kind: "end", column: "shipped" }],
        edges: [{ from: "start", to: "end" }],
      },
    } as never);

    await store().createTaskWithReservedId(
      { description: "renamed board card", column: "building", workflowId: definition.id } as never,
      { taskId: "FN-RENAMED", applyDefaultWorkflowSteps: false },
    );

    await expect(
      store().bypassFailedPreMergeReviewStep("FN-RENAMED", { reason: "operator override" } as never),
    ).rejects.toThrow(/must be in 'validating'/);
  });
});
