import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { Task, WorkflowStepResult } from "../types.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";
import { deriveReviewBypassTarget } from "../merge/review-bypass-target.js";
import { resolveRequiredPostMergeGateIds, getRequiredPostMergeEvidenceBlocker } from "../merge/confirmed-merge-reconciliation.js";
import { resolveRequiredPreMergeStepIds } from "../merge/required-pre-merge-steps.js";
import { resolveWorkflowIrForTask } from "../workflows/workflow-ir-resolver.js";

/*
FNXC:PostMergeGateWaiver 2026-11-14-02:20 (RUFU-599 reproduction 1, RUFU-474):
The REAL-STORE half of the offer == accept invariant for a landed card whose required post-merge gate holds
a verdict-less carrier row. RUFU-474 measured the two sides disagreeing: the merge door refused on
"required post-merge evidence gate 'post-merge-verification' is not approved", its remedy sentence told the
operator to bypass with an audited reason, and `bypassFailedPreMergeReviewStep` answered
"no failed pre-merge review step found" — both of its row targets (`getLatestFailedPreMergeReviewStep`,
`evaluatePreMergeApprovals`) are pre-merge-only, and its only post-merge target was the `absent` class
RUFU-408 added.

This runs the unmocked TaskStore: the derivation the read paths hydrate, the store's own write, and the same
post-merge decision the merge door consults. So both failure modes fail here — an affordance that lights and
then throws, and a write that lands while the door stays shut. The card is the reported shape: builtin:coding,
both pre-merge gates APPROVE, merge confirmed, one `skipped` post-merge carrier naming
`ci-repository-unresolved`.

Project-bound harness partition for the same reason `store-bypass-review.test.ts` states it (FN-227's
completion-lane capture aborts an unbound writer).
*/

pgDescribe("bypassFailedPreMergeReviewStep — the post-merge waiver the door's remedy names", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_bypass_post_merge",
    projectId: "core-store-bypass-post-merge",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  const POST_MERGE_ID = "post-merge-verification";

  function approvedPreMergeRows(): WorkflowStepResult[] {
    return [
      {
        workflowStepId: "plan-review",
        workflowStepName: "Plan Review",
        phase: "pre-merge",
        status: "passed",
        verdict: "APPROVE",
        completedAt: "2026-11-11T00:00:00.000Z",
      },
      {
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        status: "passed",
        verdict: "APPROVE",
        completedAt: "2026-11-11T01:00:00.000Z",
      },
    ];
  }

  function notRunPostMergeRow(): WorkflowStepResult {
    return {
      workflowStepId: POST_MERGE_ID,
      workflowStepName: "Post-merge verification",
      phase: "post-merge",
      status: "skipped",
      notRunReason: "ci-repository-unresolved",
      output: "post-merge verification refused: ci-repository-unresolved",
      completedAt: "2026-11-11T02:00:00.000Z",
    };
  }

  async function seedLandedCard(id: string, overrides: Partial<Task> = {}): Promise<Task> {
    const created = await h.store().createTaskWithReservedId(
      { description: `Landed card ${id}`, column: "in-review", workflowId: "builtin:coding" },
      { taskId: id, applyDefaultWorkflowSteps: false },
    );
    await h.store().updateTask(id, {
      enabledWorkflowSteps: ["plan-review", "code-review", POST_MERGE_ID],
      mergeDetails: {
        ...created.mergeDetails,
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        mergeConfirmed: true,
      },
      workflowStepResults: [...approvedPreMergeRows(), notRunPostMergeRow()],
      ...overrides,
    });
    return (await h.store().getTask(id))!;
  }

  async function requiredSets(task: Task) {
    const ir = await resolveWorkflowIrForTask(h.store(), task.id);
    return {
      pre: new Set(resolveRequiredPreMergeStepIds(ir, task.enabledWorkflowSteps, task)),
      post: new Set(resolveRequiredPostMergeGateIds(task, ir)),
    };
  }

  it("opens the merge door for a landed card whose post-merge gate holds a verdict-less carrier", async () => {
    const before = await seedLandedCard("FN-599-001");
    const { pre, post } = await requiredSets(before);
    expect([...post]).toEqual([POST_MERGE_ID]);

    // The door refuses, on the sentence that promises the waiver.
    expect(await getRequiredPostMergeEvidenceBlocker(h.store(), before)).toContain(POST_MERGE_ID);

    // The derivation the dashboard hydrates names the gate that sentence describes.
    expect(deriveReviewBypassTarget(before, pre, new Set(["in-review"]), post))
      .toMatchObject({ workflowStepId: POST_MERGE_ID, phase: "post-merge" });

    const after = await h.store().bypassFailedPreMergeReviewStep("FN-599-001", {
      reason: "board has no CI reporter; operator accepts the landed content without post-merge evidence",
      actor: "operator-rufu599",
    });

    // Exactly one row for that gate - never an appended second row the decision refuses as `duplicate`.
    const rows = (after.workflowStepResults ?? []).filter((row) => row.workflowStepId === POST_MERGE_ID);
    expect(rows).toHaveLength(1);
    const [waived] = rows;
    expect(waived.status).toBe("skipped");
    expect(waived.phase).toBe("post-merge");
    expect(waived.bypassedBy).toBe("operator-rufu599");
    expect(typeof waived.bypassedAt).toBe("string");
    expect(waived.bypassReason).toContain("no CI reporter");
    expect(waived.bypassedFromStatus).toBe("skipped");
    // FN-7720: an audited waiver never fabricates a reviewer verdict.
    expect(waived.verdict).toBeUndefined();

    // The approved gates are untouched, byte for byte.
    expect(after.workflowStepResults?.filter((row) => row.workflowStepId !== POST_MERGE_ID))
      .toEqual(approvedPreMergeRows());

    // And the door the merge consults now opens.
    expect(await getRequiredPostMergeEvidenceBlocker(h.store(), after)).toBeUndefined();

    // One bypass is one decision: the waived row is this gate's terminal state, not a re-offer.
    await expect(h.store().bypassFailedPreMergeReviewStep("FN-599-001", {
      reason: "second attempt",
      actor: "operator-rufu599",
    })).rejects.toThrow(/no failed pre-merge review step found/);
  });

  it("still refuses the waiver for an unlanded card whose post-merge gate holds the same row", async () => {
    const seeded = await seedLandedCard("FN-599-002");
    await h.store().updateTask("FN-599-002", {
      mergeDetails: { ...seeded.mergeDetails, mergeConfirmed: false },
    });
    const task = (await h.store().getTask("FN-599-002"))!;
    const { pre, post } = await requiredSets(task);

    expect(deriveReviewBypassTarget(task, pre, new Set(["in-review"]), post)).toBeUndefined();
    await expect(h.store().bypassFailedPreMergeReviewStep("FN-599-002", {
      reason: "premature waiver",
      actor: "operator-rufu599",
    })).rejects.toThrow(/no failed pre-merge review step found/);

    // The refusal wrote nothing: the carrier row stands as the engine's to re-seed.
    const row = (task.workflowStepResults ?? []).find((entry) => entry.workflowStepId === POST_MERGE_ID);
    expect(row?.bypassedBy).toBeUndefined();
  });

  it("never waives a post-merge row that carries an authored verdict", async () => {
    const seeded = await seedLandedCard("FN-599-003");
    await h.store().updateTask("FN-599-003", {
      workflowStepResults: [
        ...approvedPreMergeRows(),
        { ...notRunPostMergeRow(), verdict: "REVISE", notRunReason: undefined },
      ],
    });
    const task = (await h.store().getTask("FN-599-003"))!;
    const { pre, post } = await requiredSets(task);

    expect(deriveReviewBypassTarget(task, pre, new Set(["in-review"]), post)).toBeUndefined();
    await expect(h.store().bypassFailedPreMergeReviewStep("FN-599-003", {
      reason: "overrule a reviewer",
      actor: "operator-rufu599",
    })).rejects.toThrow(/no failed pre-merge review step found/);
  });
});
