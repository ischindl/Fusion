import { describe, expect, it } from "vitest";
import type { Task } from "../types.js";
import type { WorkflowIr, WorkflowIrV2 } from "../workflows/workflow-ir-types.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../workflows/builtin-coding-workflow-ir.js";
import {
  PLANNING_AUTHORING_EXHAUSTION_ERROR_MARKERS,
  PLANNING_EXHAUSTION_ERROR_MARKERS,
  PLANNING_SPEC_TIMEOUT_ERROR_MARKERS,
  buildPlanningStrandedRetryPatch,
  classifyPlanningStrandedRetry,
  taskCarriesPlanningExhaustionEvidence,
  taskCarriesPlanningSpecTimeoutEvidence,
} from "../tasks/planning-stranded-retry.js";

/*
FNXC:PlanningStrandedRetry 2026-11-10 (RUFU-575, measured on saneca SANE-282 / SANE-524):
SANE-282 sat in `todo` with `status: "queued"` and an error reading
`Specification failed after 3 transient errors: Request timed out.`; `fn task retry SANE-282` answered
"is not in a retryable state (status: queued)". SANE-524 sat in the same lane with `needs-replan` and got
the identical refusal. Both were un-recoverable without editing the row.

These tests pin the ONE classification all four Retry verbs consume, so parity between surfaces is proven
here once rather than per surface (the FNXC:StrandedGateRetry precedent). The operator's own requirement —
"cover both shapes in one test" — is the first case below: the `queued` and `needs-replan` incident rows
and the post-FN-9512 `escalated-reseed` row all take the same admitted branch in one assertion.
*/

/** The verbatim incident sentence, as found on SANE-282 / SANE-524. */
const SPEC_TIMEOUT_ERROR = "Specification failed after 3 transient errors: Request timed out.";
/** The legacy in-tree-read park prefix (planning-handoff-recovery.ts still reads it). */
const LEGACY_PARK_ERROR = "PLANNING_FAILED_EXHAUSTED: specification failed 3 times - last error: Request timed out.";

const CODING_IR = BUILTIN_CODING_WORKFLOW_IR as unknown as WorkflowIr;

/**
 * The five incident fixtures of `## Symptom Verification`. Each states its OWN spec state, because the
 * verdict must not depend on it: F1/F2/F3 carry a real durable plan, F4 carries no `PROMPT.md` at all
 * (the normal residue of a timeout), and F5 carries only the bootstrap seed body.
 */
const REAL_PLAN_BODY = "# Task: Fix the lockfile drift\n\n## Steps\n\n- [ ] Step 0: Preflight\n- [ ] Step 1: Reproduce\n";
const SEED_ONLY_BODY = "## Original Description\n\nA card whose specification failed with transient provider errors.\n";

type FixtureSpecState = "real plan" | "absent file" | "seed-only body";

/**
 * Spec bodies carried by each fixture. The classification takes NO spec argument, so these bodies ride on
 * the row as untyped extras — see the dedicated test that proves no future spec-body leg can change a
 * verdict through them.
 */
const FIXTURES: Array<{
  name: string;
  specState: FixtureSpecState;
  row: Record<string, unknown>;
}> = [
  { name: "F1 SANE-282 (queued + incident marker)", specState: "real plan", row: { column: "todo", status: "queued", error: SPEC_TIMEOUT_ERROR } },
  { name: "F2 SANE-524 (needs-replan + incident marker)", specState: "real plan", row: { column: "todo", status: "needs-replan", error: SPEC_TIMEOUT_ERROR } },
  { name: "F3 post-FN-9512 (queued + escalated-reseed, no error)", specState: "real plan", row: { column: "todo", status: "queued", error: null, recoveryDisposition: "escalated-reseed" } },
  { name: "F4 the normal timeout residue (no PROMPT.md on disk)", specState: "absent file", row: { column: "todo", status: "queued", error: SPEC_TIMEOUT_ERROR, promptContent: undefined } },
  { name: "F5 seed-only spec body", specState: "seed-only body", row: { column: "todo", status: "needs-replan", error: SPEC_TIMEOUT_ERROR, promptContent: SEED_ONLY_BODY } },
];

function strandedTask(row: Record<string, unknown> = {}, overrides: Partial<Task> = {}): Task {
  return {
    id: "SANE-282",
    column: "todo",
    status: "queued",
    error: SPEC_TIMEOUT_ERROR,
    steps: [],
    ...row,
    ...overrides,
  } as unknown as Task;
}

function classify(task: Task, ir: WorkflowIr | undefined = CODING_IR, now?: number) {
  return classifyPlanningStrandedRetry({ task, ir, now });
}

describe("taskCarriesPlanningExhaustionEvidence", () => {
  it("recognises the incident sentence and the legacy park prefix from the registered marker list", () => {
    expect(PLANNING_EXHAUSTION_ERROR_MARKERS).toEqual([
      "Specification failed after ",
      "PLANNING_FAILED_EXHAUSTED:",
    ]);
    expect(taskCarriesPlanningExhaustionEvidence({ error: SPEC_TIMEOUT_ERROR, recoveryDisposition: undefined })).toBe(true);
    expect(taskCarriesPlanningExhaustionEvidence({ error: LEGACY_PARK_ERROR, recoveryDisposition: undefined })).toBe(true);
  });

  it("treats the FN-9512 escalated-reseed disposition as evidence on its own, with no error at all", () => {
    expect(taskCarriesPlanningExhaustionEvidence({ error: null, recoveryDisposition: "escalated-reseed" })).toBe(true);
  });

  it("refuses a healthy capacity- or overlap-throttled queued card, which carries neither", () => {
    /* This task's own card logged `queued - maxConcurrent capacity exhausted: used=12/12`; that row is
       the scheduler's, it is progressing, and it must never be swept into this class. */
    expect(taskCarriesPlanningExhaustionEvidence({ error: null, recoveryDisposition: null })).toBe(false);
    expect(taskCarriesPlanningExhaustionEvidence({ error: "maxConcurrent capacity exhausted: used=12/12", recoveryDisposition: undefined })).toBe(false);
  });

  it("does not register a marker nobody has shown (PLANNING_TRANSIENT_EXHAUSTED has no writer, reader, or changelog)", () => {
    expect(taskCarriesPlanningExhaustionEvidence({ error: "PLANNING_TRANSIENT_EXHAUSTED: gave up", recoveryDisposition: null })).toBe(false);
  });

  /*
  FNXC:PlanningStrandedRetry 2026-11-10-23:07 (RUFU-575):
  The two predicates answer DIFFERENT questions and must stay different. Retry admission is the broad
  one (any exhausted planning run re-arms safely); wedge visibility is the narrow one, because a row
  carrying the `PLANNING_FAILED_EXHAUSTED:` authoring park already has a recovery owner - generic
  terminal-failure auto-recovery, which `task-wedge-planning-fence.test.ts` and
  `task-wedge-deterministic-spec.test.ts` both pin on purpose. Alerting there would mute a recovery that
  is actually running, which is RUFU-288's withheld-alert defect inverted. If this test ever goes red
  because someone unified the lists, read those two tests before unifying anything.
  */
  it("splits wedge visibility from retry admission: the authoring park is retryable but not a wedge", () => {
    expect(PLANNING_SPEC_TIMEOUT_ERROR_MARKERS).toEqual(["Specification failed after "]);
    expect(PLANNING_AUTHORING_EXHAUSTION_ERROR_MARKERS).toEqual(["PLANNING_FAILED_EXHAUSTED:"]);

    // Both families are evidence for a Retry.
    expect(taskCarriesPlanningExhaustionEvidence({ error: SPEC_TIMEOUT_ERROR, recoveryDisposition: null })).toBe(true);
    expect(taskCarriesPlanningExhaustionEvidence({ error: LEGACY_PARK_ERROR, recoveryDisposition: null })).toBe(true);

    // Only the marker family with no other claimant is evidence for an alert.
    expect(taskCarriesPlanningSpecTimeoutEvidence({ error: SPEC_TIMEOUT_ERROR, recoveryDisposition: null })).toBe(true);
    expect(taskCarriesPlanningSpecTimeoutEvidence({ error: LEGACY_PARK_ERROR, recoveryDisposition: null })).toBe(false);

    // The post-FN-9512 disposition has no claimant either, so both predicates see it.
    expect(taskCarriesPlanningSpecTimeoutEvidence({ error: null, recoveryDisposition: "escalated-reseed" })).toBe(true);
    expect(taskCarriesPlanningSpecTimeoutEvidence({ error: null, recoveryDisposition: null })).toBe(false);

    // Structural half of the same rule: neither predicate can be handed a spec body, so no surface can
    // re-introduce a `no-durable-spec` leg by passing one. A provider timeout's normal residue IS a
    // missing or seed-only spec, so such a leg would refuse exactly the reported card.
    expect(taskCarriesPlanningExhaustionEvidence.length).toBe(1);
    expect(taskCarriesPlanningSpecTimeoutEvidence.length).toBe(1);
    expect(classifyPlanningStrandedRetry.length).toBe(1);
  });

  /*
  FNXC:ReseedLaneDiscriminator 2026-11-12-14:54 (RUFU-575 code review P0):
  `escalated-reseed` had TWO authors until this pin existed: the planning exits above, and the executor's
  own exhausted-retry reseeds (`reseedExhaustedTransientExecution`, the stale-assistant-continuation exit,
  `non-continuable-session.ts`, `worktree-branch-conflict-handle.ts`, `required-artifact-recovery.ts`, and
  self-healing's branch-conflict reclaim reseed). Those write `status: null`, move the card to its rebound
  lane, and keep the diagnostic until an executor claims the card - during which the scheduler stamps
  `status: "queued"` on it for capacity or overlap admission. The row that comes out is F3 field-for-field,
  so the shared value made a waiting card with an intact spec alert as a dead spec run and answer an
  operator Retry with a fresh planning pass. The execution lane now writes `escalated-execution-reseed`, and
  these two assertions are what keep the lanes from merging back into one word.
  */
  it("does not read the EXECUTION lane's escalated-execution-reseed as planning exhaustion evidence", () => {
    for (const predicate of [taskCarriesPlanningExhaustionEvidence, taskCarriesPlanningSpecTimeoutEvidence]) {
      expect(predicate({ error: null, recoveryDisposition: "escalated-execution-reseed" })).toBe(false);
    }
    // The planning lane's value is still evidence, or F3 stops being admitted.
    expect(taskCarriesPlanningSpecTimeoutEvidence({ error: null, recoveryDisposition: "escalated-reseed" })).toBe(true);
  });

  it("keeps the two reseed values distinct, so a lane cannot borrow the other's recovery semantics", () => {
    /* A string-comparison test is legitimate here because the VALUES are the contract: one shared literal
       across both lanes is precisely the defect, and no behaviour separates them once the queue stamp lands. */
    const planning: Task["recoveryDisposition"] = "escalated-reseed";
    const execution: Task["recoveryDisposition"] = "escalated-execution-reseed";
    expect(execution).not.toBe(planning);
  });
});

describe("classifyPlanningStrandedRetry", () => {
  it("admits the `queued` incident row, the `needs-replan` incident row, and the post-FN-9512 row on the SAME branch", () => {
    /* The operator's "cover both shapes in one test". One assertion over all three proves the
       classification cannot drift into treating one of them as somebody else's lane. */
    const shapes: Array<{ label: string; task: Task }> = [
      { label: "queued + incident marker (SANE-282)", task: strandedTask() },
      { label: "needs-replan + incident marker (SANE-524)", task: strandedTask({ status: "needs-replan" }) },
      { label: "queued + escalated-reseed (post-FN-9512)", task: strandedTask({ error: null, recoveryDisposition: "escalated-reseed" }) },
    ];
    for (const shape of shapes) {
      expect(classify(shape.task), shape.label).toEqual({ kind: "planning-stranded" });
    }
  });

  it("admits every stranded fixture whatever its spec state is — a real plan, no file at all, or a seed-only body", () => {
    /* The load-bearing pin of the whole task. A provider timeout's NORMAL residue is a missing or
       seed-only spec, and triage's own `PROMPT.md remained missing after ...` exit escalates exactly
       that shape to a fresh planning pass. If a future author adds a `no-durable-spec` refusal leg that
       reads the body, these three verdicts stop being identical and this file goes red BY ITSELF, while
       every surface test could still pass. */
    const bodies: Record<FixtureSpecState, string | undefined> = {
      "real plan": REAL_PLAN_BODY,
      "absent file": undefined,
      "seed-only body": SEED_ONLY_BODY,
    };
    for (const fixture of FIXTURES) {
      const verdicts = (Object.keys(bodies) as FixtureSpecState[]).map((state) => {
        const row = { ...fixture.row, promptContent: bodies[state], promptExists: bodies[state] !== undefined };
        return JSON.stringify(classify(strandedTask(row)));
      });
      expect(new Set(verdicts).size, `${fixture.name} (${fixture.specState}) must be spec-state-blind`).toBe(1);
      expect(JSON.parse(verdicts[0])).toEqual({ kind: "planning-stranded" });
    }
  });

  it("accepts the legacy PLANNING_FAILED_EXHAUSTED park, whose rows still exist on real boards", () => {
    expect(classify(strandedTask({ status: "failed", error: LEGACY_PARK_ERROR }))).toEqual({ kind: "planning-stranded" });
    expect(classify(strandedTask({ status: "stuck-killed", error: LEGACY_PARK_ERROR }))).toEqual({ kind: "planning-stranded" });
  });

  it("resolves the planning lane by trait role and graph placement, not by the literal `todo`", () => {
    const renamed = {
      ...BUILTIN_CODING_WORKFLOW_IR,
      columns: (BUILTIN_CODING_WORKFLOW_IR as unknown as WorkflowIrV2).columns.map((column) =>
        column.id === "todo" ? { ...column, id: "queue" } : column,
      ),
      nodes: (BUILTIN_CODING_WORKFLOW_IR as unknown as WorkflowIrV2).nodes.map((node) =>
        "column" in node && node.column === "todo" ? { ...node, column: "queue" } : node,
      ),
    } as unknown as typeof BUILTIN_CODING_WORKFLOW_IR;

    expect(classify(strandedTask({ column: "queue" }), renamed as unknown as WorkflowIr)).toEqual({ kind: "planning-stranded" });
  });

  // ── One test per refusal leg, each with a fixture that breaks if the leg is removed ──

  it("refuses a legitimate capacity/overlap-throttled queued card (`no-planning-exhaustion-evidence`)", () => {
    /* Removing this leg would make EVERY queued card non-progressing and non-retryable-by-this-class,
       i.e. the global reclassification the task forbids. */
    expect(classify(strandedTask({ error: null } as Partial<Task>)))
      .toEqual({ kind: "not-planning-stranded", reason: "no-planning-exhaustion-evidence" });
  });

  it("refuses an EXECUTION-reseeded card the scheduler queued for a slot, while the planning reseed row stays admitted", () => {
    /* The collision the P0 named, at the classification: the executor's reseed patch plus the scheduler's
       `status: "queued"` stamp produces a row that shares planning column, `queued`, `error: null` and a
       nulled `nextRecoveryAt` with F3. Only the disposition value separates them, and it separates them in
       the honest direction - the waiting card's spec, steps and lane are intact, so a Retry that re-planned
       it would destroy finished work under the operator's normal gesture. `execution-reseed-not-planning-
       stranded.test.ts` drives the same two writers for real instead of hand-building this row. */
    const executionReseedQueued = strandedTask({ error: null, recoveryDisposition: "escalated-execution-reseed", recoveryRetryCount: null, nextRecoveryAt: null });
    expect(classify(executionReseedQueued))
      .toEqual({ kind: "not-planning-stranded", reason: "no-planning-exhaustion-evidence" });
    // F3 - the same row authored by the PLANNING lane - must stay admitted or the fix is a regression.
    expect(classify(strandedTask({ error: null, recoveryDisposition: "escalated-reseed" })))
      .toEqual({ kind: "planning-stranded" });
  });

  it("never treats `planning` as stranded — that is the live planner claim", () => {
    expect(classify(strandedTask({ status: "planning" } as Partial<Task>)))
      .toEqual({ kind: "not-planning-stranded", reason: "status-owned-by-another-lane" });
  });

  it("refuses statuses that belong to a terminal or awaiting-human lane", () => {
    for (const status of ["done", "merged", "awaiting-approval", "reviewing", null] as const) {
      expect(classify(strandedTask({ status } as Partial<Task>)), String(status))
        .toEqual({ kind: "not-planning-stranded", reason: "status-owned-by-another-lane" });
    }
  });

  it("refuses the same sentence carried by a card outside its planning column (`not-planning-column`)", () => {
    /* WIP/review own their recovery, and the dashboard's destructive branch must stay the only answer
       for a card that legitimately sits past planning. */
    expect(classify(strandedTask({ column: "in-progress" } as Partial<Task>)))
      .toEqual({ kind: "not-planning-stranded", reason: "not-planning-column" });
    expect(classify(strandedTask({ column: "in-review" } as Partial<Task>)))
      .toEqual({ kind: "not-planning-stranded", reason: "not-planning-column" });
    expect(classify(strandedTask({ column: "done" } as Partial<Task>)))
      .toEqual({ kind: "not-planning-stranded", reason: "not-planning-column" });
    /* `triage` carries the intake trait but the coding workflow places no planning node there — the
       trait alone must not be enough, or this class would claim cards that never planned there. */
    expect(classify(strandedTask({ column: "triage", status: "needs-replan" } as Partial<Task>)))
      .toEqual({ kind: "not-planning-stranded", reason: "not-planning-column" });
  });

  it("refuses an operator or engine hold (`operator-held`), whatever the pause spelling", () => {
    expect(classify(strandedTask({}, { userPaused: true } as Partial<Task>)))
      .toEqual({ kind: "not-planning-stranded", reason: "operator-held" });
    expect(classify(strandedTask({}, { paused: true, pausedReason: "duplicate-decision-required" } as Partial<Task>)))
      .toEqual({ kind: "not-planning-stranded", reason: "operator-held" });
  });

  it("refuses while a scheduled recovery owns the next attempt (`recovery-scheduled`)", () => {
    const now = Date.parse("2026-11-10T00:00:00.000Z");
    expect(classify(strandedTask({}, { nextRecoveryAt: "2026-11-10T00:10:00.000Z" } as Partial<Task>), CODING_IR, now))
      .toEqual({ kind: "not-planning-stranded", reason: "recovery-scheduled" });
    /* A PAST window is not an owner — refusing on it is how a card strands again after the timer fired. */
    expect(classify(strandedTask({}, { nextRecoveryAt: "2026-11-09T23:50:00.000Z" } as Partial<Task>), CODING_IR, now))
      .toEqual({ kind: "planning-stranded" });
  });

  it("refuses an IR that cannot answer the placement question (`no-column-model`)", () => {
    expect(classify(strandedTask(), { version: "v1", nodes: [] } as unknown as WorkflowIr))
      .toEqual({ kind: "not-planning-stranded", reason: "no-column-model" });
    expect(classifyPlanningStrandedRetry({ task: strandedTask(), ir: undefined }))
      .toEqual({ kind: "not-planning-stranded", reason: "no-column-model" });
  });

  it("refuses a card standing in a column the workflow does not declare (`unknown-column`)", () => {
    expect(classify(strandedTask({ column: "recycling-bin" } as Partial<Task>)))
      .toEqual({ kind: "not-planning-stranded", reason: "unknown-column" });
  });
});

describe("buildPlanningStrandedRetryPatch", () => {
  it("is the non-destructive re-arm and names nothing outside its six keys", () => {
    const patch = buildPlanningStrandedRetryPatch({ column: "todo", status: "queued" });
    expect(Object.keys(patch).sort()).toEqual([
      "error",
      "nextRecoveryAt",
      "planningFailure",
      "recoveryDisposition",
      "recoveryRetryCount",
      "status",
    ]);
    expect(patch.status).toBe("needs-replan");
    expect(patch.error).toBeNull();
    expect(patch.recoveryDisposition).toBeNull();
  });

  it("names none of the fields whose preservation is the point of the class", () => {
    /* A spec/lane/worktree key appearing here would make the retry destructive no matter what the
       surface does, and on the board that is exactly what the accepted shape used to be. */
    const forbidden = [
      "column", "steps", "currentStep", "promptContent", "worktree", "branch", "branchWriteOrigin",
      "baseBranch", "baseCommitSha", "sessionFile", "blockedBy", "overlapBlockedBy", "mergeRetries",
      "approvedPlanFingerprint", "workflowStepResults", "title", "description",
    ];
    const keys = Object.keys(buildPlanningStrandedRetryPatch({ column: "todo", status: "queued" }));
    for (const field of forbidden) {
      expect(keys, `patch must not name ${field}`).not.toContain(field);
    }
  });

  it("writes needs-replan rather than null, because that is what makes triage re-admit the card", () => {
    /* `needs-replan` is in AWAITING_PLANNING_STATUSES and is what triage's todo rediscovery consumes; a
       null status names no owner and is how the card became a dead end in the first place. */
    expect(buildPlanningStrandedRetryPatch({ column: "todo", status: "queued" }).status).toBe("needs-replan");
  });
});
