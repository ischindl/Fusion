/*
FNXC:CompleteLaneBoundary 2026-11-08-13:36 (RUFU-349):
A post-merge gate drawn INTO a complete-trait column is an illegal shape, and until this rule it was
authorable at all: the built-ins themselves shipped it, which is how 14 cards came to stand in their
complete column with `post-merge-verification` reporting `failed/REVISE` and 7 more with that gate enabled
and zero result rows (21 of the 23 default-workflow cards that enabled it). Entering such a node moves the
card into the terminal lane BEFORE the verdict exists, and once it is there the finalizer's evidence fences
short-circuit, so a later REVISE is durable but permanently unable to retract the completion.

These tests pin both halves of the save-refuse / load-tolerate decision:

1. authoring the shape is refused at the SAVE seam, naming the node, so the author learns the rule at the
   moment they draw it;
2. LOADING a persisted offender still parses AND still re-saves once repaired, because an operator cannot
   fix a workflow they cannot open. The runtime boundary makes the stale shape inert instead (Step 1
   refuses the forward crossing and runs the node in place), so nothing already on a board is bricked.
3. every shipped built-in satisfies the rule, so it cannot be satisfied only by the shape its author
   happened to test.
*/
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  COMPLETE_COLUMN_POST_MERGE_RULE,
  assertPostMergeNodesNotInCompleteColumn,
  findPostMergeNodesInCompleteColumn,
} from "../workflows/complete-column-post-merge-authoring.js";
import { parseWorkflowIr } from "../workflows/workflow-ir.js";
import { BUILTIN_WORKFLOWS } from "../workflows/builtin-workflows.js";
import type { WorkflowIr } from "../workflows/workflow-ir-types.js";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../__test-utils__/pg-test-harness.js";

/**
 * A minimal graph whose post-merge optional-group sits in `nodeColumn`.
 *
 * `merge-blocker` is deliberately NOT declared on the review column: it triggers an unrelated validator
 * that demands a reachable merge-class node, and that error would mask the rule under test. This rule
 * keys only on the `complete` trait of the TARGET column.
 */
function irWith(nodeColumn: string, phase: string): WorkflowIr {
  return {
    version: "v2",
    name: "authoring-probe",
    columns: [
      { id: "in-progress", name: "In progress", traits: [{ trait: "wip" }] },
      { id: "in-review", name: "In review", traits: [{ trait: "human-review" }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "in-progress" },
      {
        id: "post-merge-verification",
        kind: "optional-group",
        column: nodeColumn,
        config: {
          phase,
          defaultOn: true,
          template: {
            nodes: [
              { id: "pm-entry", kind: "start" },
              { id: "pm-check", kind: "prompt", config: { gateMode: "gate" } },
              { id: "pm-exit", kind: "end" },
            ],
            edges: [
              { from: "pm-entry", to: "pm-check" },
              { from: "pm-check", to: "pm-exit" },
            ],
          },
        },
      },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [
      { from: "start", to: "post-merge-verification" },
      { from: "post-merge-verification", to: "end" },
    ],
  } as unknown as WorkflowIr;
}

/** The same shape with the terminal column renamed: its only claim to being terminal is its TRAIT, which
 *  is exactly what a `done`/`published` name allow-list would have missed. */
function renamedTerminalIr(): WorkflowIr {
  const ir = irWith("shipped", "post-merge") as unknown as Record<string, unknown>;
  ir.columns = [
    { id: "in-review", name: "Review", traits: [{ trait: "human-review" }] },
    { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
  ];
  ir.nodes = [
    { id: "start", kind: "start", column: "in-review" },
    {
      id: "late-check",
      kind: "optional-group",
      column: "shipped",
      config: {
        phase: "post-merge",
        template: {
          nodes: [
            { id: "late-entry", kind: "start" },
            { id: "late-step", kind: "prompt", config: {} },
            { id: "late-exit", kind: "end" },
          ],
          edges: [
            { from: "late-entry", to: "late-step" },
            { from: "late-step", to: "late-exit" },
          ],
        },
      },
    },
  ];
  ir.edges = [{ from: "start", to: "late-check" }];
  return ir as unknown as WorkflowIr;
}

/** Drive the same assertion the store's authoring seam delegates to, rather than a copy of its predicate. */
function assertSavable(ir: WorkflowIr): void {
  assertPostMergeNodesNotInCompleteColumn(ir);
}

describe("a post-merge gate may not be authored into the complete column (RUFU-349)", () => {
  it("names the offending node and column when the shape is authored", () => {
    expect(() => assertSavable(irWith("done", "post-merge"))).toThrow(/post-merge-verification/);
    expect(() => assertSavable(irWith("done", "post-merge"))).toThrow(/'done'/);
    expect(() => assertSavable(irWith("done", "post-merge"))).toThrow(COMPLETE_COLUMN_POST_MERGE_RULE);
  });

  it("accepts the same node in a review lane, which is the shape the built-ins now ship", () => {
    expect(() => assertSavable(irWith("in-review", "post-merge"))).not.toThrow();
  });

  it("accepts a pre-merge gate in the complete column, so the rule is about the phase, not the lane", () => {
    expect(() => assertSavable(irWith("done", "pre-merge"))).not.toThrow();
  });

  it("keys on the complete TRAIT, not on a `done`/`published` column literal", () => {
    const ir = renamedTerminalIr();
    expect(findPostMergeNodesInCompleteColumn(ir).map((hit) => hit.nodeId)).toEqual(["late-check"]);
    expect(() => assertSavable(ir)).toThrow(/late-check/);
  });

  it("still PARSES a persisted offender, because refusing on load would make it unrepairable", () => {
    expect(() => parseWorkflowIr(irWith("done", "post-merge"))).not.toThrow();
  });

  it("is satisfied by every shipped built-in and exported IR", () => {
    for (const workflow of BUILTIN_WORKFLOWS) {
      const ir = typeof workflow.ir === "string" ? parseWorkflowIr(workflow.ir) : workflow.ir;
      if (!ir) continue;
      expect(findPostMergeNodesInCompleteColumn(ir), `${workflow.id} authors the illegal shape`)
        .toEqual([]);
    }
  });
});

/*
FNXC:CompleteLaneBoundary 2026-11-08-13:36 (RUFU-349):
The legs above prove the rule exists; these prove it is WIRED into the save seam. Asserting only the
exported predicate would stay green even if no write path ever called it, which is the shape of a rule
that reads as delivered and protects nothing. These run the real insert and update against the store.
*/
pgDescribe("the save seam refuses the shape end to end (RUFU-349)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_rufu349_auth",
    projectId: "core-rufu349-auth",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("refuses a new custom workflow that draws a post-merge gate into the complete column", async () => {
    await expect(h.store().createWorkflowDefinition({
      name: "offending",
      ir: irWith("done", "post-merge"),
    })).rejects.toThrow(/post-merge-verification/);
  });

  it("refuses the update that introduces the shape and leaves the stored IR untouched", async () => {
    const created = await h.store().createWorkflowDefinition({
      name: "repairable",
      ir: irWith("in-review", "post-merge"),
    });
    expect(created.id).toBeTruthy();

    await expect(h.store().updateWorkflowDefinition(created.id, { ir: irWith("done", "post-merge") }))
      .rejects.toThrow(COMPLETE_COLUMN_POST_MERGE_RULE);

    // A refused write must not have persisted, or the attempt to break the workflow would break it.
    const stored = await h.store().getWorkflowDefinition(created.id);
    expect(findPostMergeNodesInCompleteColumn(parseWorkflowIr(stored!.ir))).toEqual([]);
  });

  it("still loads and re-saves a workflow persisted with the shape by a pre-rule build", async () => {
    const created = await h.store().createWorkflowDefinition({
      name: "legacy-shape",
      ir: irWith("in-review", "post-merge"),
    });
    // Write the offending bytes the way a pre-rule build would have, past the new authoring gate.
    await h.adminSql()`UPDATE project.workflows SET ir = ${JSON.stringify(irWith("done", "post-merge"))} WHERE id = ${created.id}`;

    const loaded = await h.store().getWorkflowDefinition(created.id);
    const loadedIr = parseWorkflowIr(loaded!.ir);
    expect(findPostMergeNodesInCompleteColumn(loadedIr)).toHaveLength(1);

    // And the repair itself saves cleanly, which is the whole point of tolerating the load.
    await expect(
      h.store().updateWorkflowDefinition(created.id, { ir: irWith("in-review", "post-merge") }),
    ).resolves.toBeDefined();
  });
});
