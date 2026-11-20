import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { WorkflowStepResult } from "../types.js";
import {
  getTaskMergeBlocker,
  isPreMergeGateFailedBlocker,
} from "../merge/task-merge.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";

/*
FNXC:ReviewVerdictAdvance 2026-09-17-12:45 (RUFU-225, salvaged by RUFU-294):
The forward store move is the second door a delivered APPROVE must pass: `moveTask(in-review → done)`
consults `getTaskMergeBlocker` before completing. An approved required gate plus any additional
failed pre-merge row resolves to the failed-pre-merge family — the third refusal reason — and the
move must refuse on exactly that condition. Removal of that row must let the same move complete,
which proves the refusal was caused by that row and not by an unrelated earlier guard.
Neither move site passes a merge-content descriptor, so a passed Code Review APPROVE is approved
regardless of fingerprint here; only the failed non-required row refuses.

FNXC:MergeBlockerReasons 2026-10-15-16:55 (RUFU-294 salvage adaptation):
Upstream `fb6cffe876` asserted the refusal BYTE-EXACT (`Cannot move <id> to 'done': task has failed
pre-merge workflow steps`). `merge-blocker-reason-coupling.test.ts` states the rule this satisfies
instead: the sentence may be reworded freely, the rule may not drift from the door that enforces it.
Main already proves why — the review → complete refusal now has two containers, the in-lock
transition-policy preflight (quoted `to 'done'`, detail from `evaluateTransitionInvariants`) and the
unquoted container that closes the merge-blocker read, so the literal a patch-identity test pinned had
already changed shape. Nothing here types a refusal sentence: the test asks the SAME authority the door
asks (`getTaskMergeBlocker`), asserts it classifies the card as the failed-pre-merge family through the
authority's own predicate, and asserts the thrown message CARRIES that authority-returned reason.
Wording drift then cannot false-fail this file, while a move door that stopped honoring the blocker
still fails it.

The harness is project-bound because an unbound writer aborts the Patchnode transaction on any move
into `done` (FN-227) — this file performs a real move into `done`.

FNXC:ReviewVerdictAdvance 2026-11-20-22:05 (RUFU-739 is the card that actually delivered this file):
RUFU-294 closed three times without this file ever reaching `main`; the only copy lived in the git
object `62804b4340a3ac40e7d1e94216782e1d75b168d3`, reachable through `lan/fusion/rufu-293` and three
`refs/backup/*` refs, with no branch of its own. RUFU-739 recovered it from that object and owns it
now. The two line-number citations the salvage carried for the move containers were dropped rather
than re-verified: the file anchors on the preflight phase and on the container's shape, which is what
survives a renumber. Because `pgDescribe` degrades the whole suite to skipped when PostgreSQL is
unreachable, an executed (not skipped) case count is the delivery proof for this file — see
`docs/solutions/reliability/vanished-task-directory-rufu-225.md` for why presence alone never was.
*/

pgDescribe("forward move in-review → done refuses the failed-pre-merge condition", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "rufu739_move_refusal",
    projectId: "proj_rufu739",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  function approvedCodeReview(): WorkflowStepResult {
    return {
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      phase: "pre-merge",
      status: "passed",
      reviewKind: "code",
      verdict: "APPROVE",
      reviewInputFingerprint: "fp-current",
      completedAt: "2026-09-15T00:00:00.000Z",
    };
  }

  /** Failed NON-required pre-merge row: the gate is not enabled, so approvals still approve the
   *  required set and only the failed-row scan can refuse — the exact third reason. */
  function failedExtraRow(): WorkflowStepResult {
    return {
      workflowStepId: "browser-verification",
      workflowStepName: "Browser Verification",
      phase: "pre-merge",
      status: "failed",
      output: "screen recordings unavailable",
      completedAt: "2026-09-15T00:00:00.000Z",
    };
  }

  async function seedApprovedReviewCard(id: string, results: WorkflowStepResult[]) {
    await h.store().createTaskWithReservedId(
      { description: `Task ${id}`, column: "in-review" },
      { taskId: id, applyDefaultWorkflowSteps: false },
    );
    await h.store().updateTask(id, {
      enabledWorkflowSteps: ["code-review"],
      workflowStepResults: results,
      // A card that reached the review lane finished what it planned. Creating INTO `in-review`
      // seeds the default board steps as `pending`, and "task has incomplete steps" is checked
      // BEFORE the pre-merge row scan, so the fixture states the terminal step state a review-lane
      // card really has instead of inheriting a template's pending steps.
      steps: (((await h.store().getTask(id))?.steps) ?? []).map((step) => ({ ...step, status: "done" as const })),
    });
  }

  it("refuses while the failed pre-merge row exists, carrying the blocker authority's own reason", async () => {
    const id = "FN-R739-1";
    await seedApprovedReviewCard(id, [approvedCodeReview(), failedExtraRow()]);

    // The door's own verdict on the durable row, before the move asks it.
    const live = await h.store().getTask(id);
    expect(live).toBeTruthy();
    const blocker = getTaskMergeBlocker(live!);
    expect(blocker).toBeDefined();
    expect(isPreMergeGateFailedBlocker(blocker as string)).toBe(true);

    const refusal = await h.store().moveTask(id, "done").then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(refusal).toBeInstanceOf(Error);
    // Coupling, not wording: the refusal carries what the authority said, whichever container words it.
    expect(refusal!.message).toContain(blocker as string);
    // The card did not advance: deferral leaves the lane alone.
    expect((await h.store().getTask(id))!.column).toBe("in-review");
  });

  it("completes the same move on the same card once that row is gone (non-vacuity)", async () => {
    const id = "FN-R739-2";
    await seedApprovedReviewCard(id, [approvedCodeReview(), failedExtraRow()]);
    expect(getTaskMergeBlocker((await h.store().getTask(id))!)).toBeDefined();

    await h.store().updateTask(id, { workflowStepResults: [approvedCodeReview()] });
    expect(getTaskMergeBlocker((await h.store().getTask(id))!)).toBeUndefined();

    const moved = await h.store().moveTask(id, "done");
    expect(moved.column).toBe("done");
  });
});
