/*
FNXC:CompleteLaneBoundary 2026-11-08-13:36 (RUFU-349 rev 5):
The no-merge completer is the ONE sanctioned mover this task must not disturb, and rev 4's plan
nearly did: it widened the complete-column gate-evidence guard on `workflowMoveSource:
"workflow-graph"`, a token that has FIVE production producers, one of which is exactly this mover.
That mover sends `bypassGuards: true` into `resolveCompleteColumn(ir)` and reduces a refusal to
`executorLog.warn` + `return`, so a widened guard would have stranded a merge-less card in its last
pre-complete lane with nothing on the card and no run-audit row — the same invisible-refusal defect
class (RUFU-318) this task exists to close, recreated on the sanctioned path.

So the exemption is proven here against the REAL store rather than argued from vacuity: a
merge-less `builtin:lead-generation` card with no merge proof and no gate rows still reaches
`converted` and still records `task:workflow-complete-column-advanced`, identically pre- and post-fix.
The guard-key leg lives in `workflow-transition-policy-post-merge-evidence.test.ts`; this file proves
the same discriminator end-to-end through the mover itself.
*/
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { queryRunAuditEvents } from "../../../core/src/task-store/async/async-audit.js";
import { BUILTIN_LEAD_GENERATION_WORKFLOW_IR } from "../../../core/src/workflows/builtin-lead-generation-workflow-ir.js";
import type { TaskDetail } from "@fusion/core";
import { advanceNoMergeWorkflowToCompleteColumn } from "../executor/no-merge-complete-column.js";

/** The exact option shape `advanceNoMergeWorkflowToCompleteColumn` sends. */
const NO_MERGE_OPTION_SHAPE = {
  moveSource: "engine",
  workflowMoveSource: "workflow-graph",
  bypassGuards: true,
  preserveProgress: true,
} as const;

pgDescribe("no-merge complete-column mover is untouched by the RUFU-349 guard widening", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_rufu349_no_merge",
    projectId: "core-rufu349-no-merge-regression",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seedLeadGenerationCard(id: string, column: string): Promise<void> {
    const store = h.store();
    await store.createTaskWithReservedId(
      { description: `no-merge completion ${id}`, column },
      { taskId: id, applyDefaultWorkflowSteps: false },
    );
    await store.selectTaskWorkflow(id, "builtin:lead-generation");
    await store.updateTask(id, { workflowStepResults: [] });
  }

  it("drives a real store move with the mover's exact option shape (shared token, NO lifecycleReason)", async () => {
    await seedLeadGenerationCard("RUFU349-NOMERGE-1", "outreach");

    await expect(
      h.store().moveTask("RUFU349-NOMERGE-1", "converted", {
        ...NO_MERGE_OPTION_SHAPE,
        workflowMoveMetadata: { fromColumn: "outreach", reason: "no-merge-workflow-completed" },
      }),
    ).resolves.toMatchObject({ column: "converted" });
  });

  it("completes a merge-less builtin:lead-generation card and records its own event", async () => {
    await seedLeadGenerationCard("RUFU349-NOMERGE-2", "outreach");
    const store = h.store();
    const task = (await store.getTask("RUFU349-NOMERGE-2")) as TaskDetail;
    expect(task.column).toBe("outreach");

    await advanceNoMergeWorkflowToCompleteColumn(store, task);

    const after = await store.getTask("RUFU349-NOMERGE-2");
    expect(after?.column).toBe("converted");

    // Bounded best-effort emit: RUFU-453 buffers one drain window, so poll rather than read once.
    const found = await vi.waitFor(async () => {
      const rows = await queryRunAuditEvents(h.layer().db, {});
      const hit = rows.find(
        (event) =>
          event.mutationType === "task:workflow-complete-column-advanced"
          && event.taskId === "RUFU349-NOMERGE-2",
      );
      if (!hit) throw new Error("no-merge completion audit row not written yet");
      return hit;
    });
    expect(found.metadata).toMatchObject({ toColumn: "converted", reason: "no-merge-workflow-completed" });
  });

  it("resolves the mover's target from the IR: lead-generation's complete lane is `converted`", () => {
    const complete = BUILTIN_LEAD_GENERATION_WORKFLOW_IR.columns.filter((column) =>
      column.traits.some((trait) => trait.trait === "complete"),
    );
    expect(complete.map((column) => column.id)).toEqual(["converted"]);
  });
});
