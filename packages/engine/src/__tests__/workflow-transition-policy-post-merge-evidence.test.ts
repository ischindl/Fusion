/*
FNXC:CompleteLaneBoundary 2026-11-08-13:36 (RUFU-349):
The store seam now applies its ALREADY-SHIPPED complete-column gate-evidence classifier to node-entry
moves as well, even under `bypassGuards: true`. RUFU-406 built that classifier and mounted it on
operator intent only, so the graph's node-entry mover — which sends `bypassGuards: true` — walked
straight past it. This is the matrix that mount decision has to satisfy, driven against the real store
rather than a mock, because every leg below is a question about which MOVER may cross and mocks answer
only the question the author asked.

THE KEY IS `lifecycleReason: "workflow-graph-node-column"`, not `workflowMoveSource: "workflow-graph"`.
The earlier revision of this plan keyed the arm on the latter and asserted that token names node entry
exclusively; it does not. Five production movers send it, and one of them —
`advanceNoMergeWorkflowToCompleteColumn` — completes a merge-less workflow into its own Done column
under `bypassGuards: true` and reduces a refusal to a process-log warn, so keying on the shared token
would have silently stranded exactly the mover the plan declared exempt. `lifecycleReason` with that
value has exactly ONE production producer (`workflow-column-boundary-hooks.ts`), which is what makes the
other four movers exempt by measurement rather than by a special case.

Post-merge semantics come from the shipped classifier and are NOT re-derived here: a post-merge gate
refuses on a durable negative report ONLY. An absent or honestly-not-run post-merge row never refuses,
because a card that has not merged yet simply has no post-merge evidence, and refusing the move into the
lane where that evidence is produced would be circular.
*/
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail, WorkflowStepResult } from "@fusion/core";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { CompleteColumnGateEvidenceRejectionError } from "../../../core/src/workflows/complete-column-gate-evidence.js";

/** The exact option shape node entry sends: guard bypass plus the single-producer reason. */
const NODE_ENTRY_MOVE = {
  moveSource: "engine",
  lifecycleReason: "workflow-graph-node-column",
  workflowMoveSource: "workflow-graph",
  bypassGuards: true,
  preserveProgress: true,
} as const;

/** A durable negative post-merge report — the only post-merge state the shipped classifier refuses on. */
const postMergeRevise = (): WorkflowStepResult => ({
  workflowStepId: "post-merge-verification",
  workflowStepName: "Post-merge verification",
  phase: "post-merge",
  status: "failed",
  verdict: "REVISE",
  verdictRequired: true,
  completedAt: "2026-11-08T00:00:00.000Z",
});

const postMergeApprove = (): WorkflowStepResult => ({
  workflowStepId: "post-merge-verification",
  workflowStepName: "Post-merge verification",
  phase: "post-merge",
  status: "passed",
  verdict: "APPROVE",
  reviewInputFingerprint: "sha256:post-merge-fingerprint",
  completedAt: "2026-11-08T00:00:00.000Z",
});

pgDescribe("complete-column gate evidence applies to node-entry moves (RUFU-349)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_rufu349_store_arm",
    projectId: "core-rufu349-store-arm",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seed(id: string, rows: WorkflowStepResult[] | null, column = "in-progress"): Promise<void> {
    await h.store().createTaskWithReservedId(
      {
        description: `node-entry evidence ${id}`,
        column,
        enabledWorkflowSteps: ["plan-review", "code-review", "post-merge-verification"],
      },
      { taskId: id, applyDefaultWorkflowSteps: false },
    );
    await h.store().updateTask(id, { workflowStepResults: rows });
  }

  /** Approve every required PRE-merge gate so only the post-merge lane can refuse. */
  const preMergeClean = (): WorkflowStepResult[] => [
    {
      workflowStepId: "plan-review",
      workflowStepName: "Plan Review",
      status: "passed",
      verdict: "APPROVE",
      reviewInputFingerprint: "sha256:plan-fingerprint",
      completedAt: "2026-11-08T00:00:00.000Z",
    },
    {
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      status: "passed",
      verdict: "APPROVE",
      reviewInputFingerprint: "sha256:code-fingerprint",
      completedAt: "2026-11-08T00:00:00.000Z",
    },
  ];

  async function refusalOf(id: string): Promise<unknown> {
    return h.store()
      .moveTask(id, "done", NODE_ENTRY_MOVE)
      .then(() => null, (caught: unknown) => caught as Error);
  }

  it("refuses a node-entry move whose post-merge gate reported REVISE", async () => {
    await seed("RUFU349-ARM-REVISE", [...preMergeClean(), postMergeRevise()]);

    const error = await refusalOf("RUFU349-ARM-REVISE");

    // Pre-fix this move SUCCEEDED: the arm was bound to operator intent and non-bypassed moves, so a
    // durable negative verdict rode a bypassed graph move straight into the terminal lane.
    expect(error).toBeInstanceOf(CompleteColumnGateEvidenceRejectionError);
    expect((error as CompleteColumnGateEvidenceRejectionError).gateFindings.map((f) => f.gateId))
      .toEqual(["post-merge-verification"]);
    expect((error as CompleteColumnGateEvidenceRejectionError).gateFindings[0]?.lane).toBe("post-merge");
    const after = await h.store().getTask("RUFU349-ARM-REVISE");
    expect(after?.column).toBe("in-progress");
  });

  it("refuses a node-entry move whose required pre-merge gate reported nothing", async () => {
    await seed("RUFU349-ARM-MISSING", [
      {
        workflowStepId: "plan-review",
        workflowStepName: "Plan Review",
        status: "passed",
        verdict: "APPROVE",
        reviewInputFingerprint: "sha256:plan-fingerprint",
        completedAt: "2026-11-08T00:00:00.000Z",
      },
      postMergeApprove(),
    ]);

    const error = await refusalOf("RUFU349-ARM-MISSING");
    expect(error).toBeInstanceOf(CompleteColumnGateEvidenceRejectionError);
    expect((error as CompleteColumnGateEvidenceRejectionError).gateFindings.map((f) => f.gateId))
      .toEqual(["code-review"]);
  });

  it("lets a node-entry move through once the post-merge gate approved", async () => {
    await seed("RUFU349-ARM-APPROVED", [...preMergeClean(), postMergeApprove()]);

    await expect(h.store().moveTask("RUFU349-ARM-APPROVED", "done", NODE_ENTRY_MOVE))
      .resolves.toMatchObject({ column: "done" });
  });

  it("honours an audited operator waiver, which is a decision rather than an absence", async () => {
    await seed("RUFU349-ARM-WAIVED", [
      ...preMergeClean(),
      {
        ...postMergeRevise(),
        status: "skipped",
        verdict: undefined,
        bypassedBy: "operator@example.com",
        bypassedAt: "2026-11-08T01:00:00.000Z",
        bypassReason: "operator accepted the residual risk",
      } as unknown as WorkflowStepResult,
    ]);

    await expect(h.store().moveTask("RUFU349-ARM-WAIVED", "done", NODE_ENTRY_MOVE))
      .resolves.toMatchObject({ column: "done" });
  });

  it("does not refuse an honest absence of post-merge evidence, which is the classifier's own rule", async () => {
    // No post-merge row at all: `missing` never refuses on the post-merge lane, because that evidence
    // is produced after the crossing. Widening the arm must not silently import a stricter post-merge
    // rule than the merge door itself enforces.
    await seed("RUFU349-ARM-NOTRUN", preMergeClean());

    await expect(h.store().moveTask("RUFU349-ARM-NOTRUN", "done", NODE_ENTRY_MOVE))
      .resolves.toMatchObject({ column: "done" });
  });

  it("reaches for the shipped refusal, so the sentence and history echo are the RUFU-406 ones", async () => {
    await seed("RUFU349-ARM-SENTENCE", [...preMergeClean(), postMergeRevise()]);

    const error = (await refusalOf("RUFU349-ARM-SENTENCE")) as Error;
    expect(error.message).toContain("post-merge-verification");
    expect(error.message).toContain("Required workflow gate evidence is missing");

    await vi.waitFor(async () => {
      const after = await h.store().getTask("RUFU349-ARM-SENTENCE");
      expect(
        after?.log?.some((entry) => (entry.action ?? "").includes("post-merge-verification") && entry.outcome === "refused"),
      ).toBe(true);
    });
  });

  it("leaves the four OTHER shared-token movers untouched — the widening is reason-keyed, not token-keyed", async () => {
    /* Each shape below is one of the four remaining production producers of
       `workflowMoveSource: "workflow-graph"`, replayed with its own options. All four carry a refusing
       post-merge row: the point is that they must still land, because the arm keys on the reason the
       node-entry mover alone sends. */
    const shapes: Record<string, Record<string, unknown>> = {
      // executor/no-merge-complete-column.ts
      "no-merge-completer": {
        moveSource: "engine",
        workflowMoveSource: "workflow-graph",
        bypassGuards: true,
        preserveProgress: true,
      },
      // executor/workflow-merge-boundary.ts
      "merge-boundary": {
        moveSource: "engine",
        workflowMoveSource: "workflow-graph",
        bypassGuards: true,
      },
      // executor/create-authoritative-workflow-primitives.ts (transitionTask)
      "transition-task": {
        moveSource: "engine",
        workflowMoveSource: "workflow-graph",
      },
      // executor/route-graph-failure-to-execution-resume.ts (boundary recovery)
      "boundary-recovery": {
        moveSource: "engine",
        workflowMoveSource: "workflow-graph",
        bypassGuards: true,
        preserveProgress: true,
      },
    };

    let index = 0;
    for (const [name, options] of Object.entries(shapes)) {
      const id = `RUFU349-EXEMPT-${index}`;
      index += 1;
      await seed(id, [...preMergeClean(), postMergeRevise()]);
      await expect(h.store().moveTask(id, "done", options as never), `${name} must stay exempt`)
        .resolves.toMatchObject({ column: "done" });
    }
  });

  it("does not newly refuse an option-less engine move, which never sends the reason", async () => {
    await seed("RUFU349-EXEMPT-BLIND", [...preMergeClean(), postMergeRevise()]);

    await expect(h.store().moveTask("RUFU349-EXEMPT-BLIND", "done", { moveSource: "engine", bypassGuards: true }))
      .resolves.toMatchObject({ column: "done" });
  });

  it("keeps RUFU-406's operator-intent arm exactly as it was", async () => {
    await seed("RUFU349-ARM-USER", [...preMergeClean(), postMergeRevise()]);

    await expect(h.store().moveTask("RUFU349-ARM-USER", "done", { moveSource: "user" }))
      .rejects.toBeInstanceOf(CompleteColumnGateEvidenceRejectionError);
    const after = await h.store().getTask("RUFU349-ARM-USER");
    expect(after?.column).toBe("in-progress");
  });

  it("never lets the new arm disturb a card that is already where it belongs", async () => {
    await seed("RUFU349-ARM-IDEMPOTENT", [...preMergeClean(), postMergeRevise()], "done");

    const task = (await h.store().getTask("RUFU349-ARM-IDEMPOTENT")) as TaskDetail;
    expect(task.column).toBe("done");
    // A same-column move is not a crossing; it must not become a refusal that erases the card's state.
    await expect(h.store().moveTask("RUFU349-ARM-IDEMPOTENT", "done", NODE_ENTRY_MOVE)).resolves.toBeDefined();
  });
});
