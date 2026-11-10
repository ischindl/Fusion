/*
FNXC:CompleteLaneBoundary 2026-11-08-13:36 (RUFU-349):
LOOP CLOSURE. A card whose merge landed but whose post-merge gate never reported is repaired by re-seeding
the gate NODE and letting the graph run it. The re-seed seam looks the node up BY ID
(`merge/post-merge-gate-reseed.ts`: `ir.nodes.find(c => c.id === gateId)`), so it is column-agnostic and my
topology change cannot break its lookup — but a seeded node only ever RUNS if the graph can be dispatched
for the card, and a card sitting in a complete-trait column is terminal: nothing dispatches there. That is
why the original failure was self-concealing, and it is the property these legs pin:

1. every shipped built-in places its post-merge gate in the lane a landed card actually RESTS in — a
   review lane, not the terminal lane — so a seeded gate is reachable by the dispatcher;
2. the re-seed's own node lookup still resolves for the re-homed IRs, so the topology move did not orphan
   the recovery seam that depends on that id;
3. the boundary's structural refusal deliberately EXCLUDES the `end` node, and the store's evidence
   classifier is what refuses a completion without evidence. That division is load-bearing: refusing `end`
   entry structurally would strand every graph that completes through its end node, while allowing the
   store to see the move is what makes a landed-but-unverified card stay in review. Pin the exclusion, or
   the next reader "fixes" it and either bricks completion or reopens the hole.
*/
import { describe, expect, it } from "vitest";
import { parseWorkflowIr } from "@fusion/core";
import { BUILTIN_WORKFLOWS, resolveColumnFlags } from "@fusion/core";
import { POST_MERGE_VERIFICATION_GROUP_ID } from "@fusion/core";
import { isForwardNodeEntryIntoCompleteColumn } from "../workflows/workflow-column-boundary.js";
import { findPostMergeNodesInCompleteColumn } from "@fusion/core";

describe("a re-seeded post-merge gate is reachable where the card waits (RUFU-349)", () => {
  const builtinsWithGate = BUILTIN_WORKFLOWS.filter((workflow) => {
    const ir = typeof workflow.ir === "string" ? parseWorkflowIr(workflow.ir) : workflow.ir;
    return ir?.version === "v2" && ir.nodes.some((node) => node.id === POST_MERGE_VERIFICATION_GROUP_ID);
  });

  it("finds built-ins that actually ship the gate, so this cannot pass vacuously", () => {
    expect(builtinsWithGate.length).toBeGreaterThanOrEqual(8);
  });

  it("places every gate in a review lane and never in the terminal lane", () => {
    for (const workflow of builtinsWithGate) {
      const ir = typeof workflow.ir === "string" ? parseWorkflowIr(workflow.ir) : workflow.ir;
      const node = ir!.nodes.find((candidate) => candidate.id === POST_MERGE_VERIFICATION_GROUP_ID)!;
      const column = ir!.columns.find((candidate) => candidate.id === node.column);
      const flags = column ? resolveColumnFlags(column) : {};
      expect(flags.complete, `${workflow.id} places its post-merge gate in the complete lane`).toBeFalsy();
      expect(
        flags.humanReview === true || flags.mergeBlocker === true,
        `${workflow.id} places its post-merge gate in a lane no landed card rests in`,
      ).toBe(true);
    }
  });

  it("agrees with the authoring rule from the other direction, one list not two opinions", () => {
    // If these two ever disagree, one of them is wrong about what the shipped graphs look like.
    for (const workflow of builtinsWithGate) {
      const ir = typeof workflow.ir === "string" ? parseWorkflowIr(workflow.ir) : workflow.ir;
      expect(findPostMergeNodesInCompleteColumn(ir!), `${workflow.id} is an offender`).toEqual([]);
    }
  });

  it("still resolves the gate node by id, which is the only lookup the re-seed seam performs", () => {
    for (const workflow of builtinsWithGate) {
      const ir = typeof workflow.ir === "string" ? parseWorkflowIr(workflow.ir) : workflow.ir;
      const byId = ir!.nodes.find((candidate) => candidate.id === POST_MERGE_VERIFICATION_GROUP_ID);
      expect(byId, `${workflow.id} orphaned the re-seed lookup`).toBeDefined();
      expect((byId!.config as { phase?: string }).phase).toBe("post-merge");
    }
  });
});

describe("the boundary refuses gate entry structurally and leaves completion to the store (RUFU-349)", () => {
  const at = (over: Record<string, unknown>) => ({
    kind: "optional-group",
    direction: "forward" as const,
    targetComplete: true,
    ...over,
  });

  it("refuses a gate node entering the complete column", () => {
    expect(isForwardNodeEntryIntoCompleteColumn(at({}))).toBe(true);
  });

  it("does NOT refuse the end node, because the store's evidence classifier owns that move", () => {
    /* Refusing `end` here would strand every graph that completes through its end node, including the
       honest approved case. The store's RUFU-406 classifier is the authority that refuses a completion
       whose evidence is missing or refused, and node entry reaches it because node entry carries
       `lifecycleReason: "workflow-graph-node-column"`. */
    expect(isForwardNodeEntryIntoCompleteColumn(at({ kind: "end" }))).toBe(false);
  });

  it("does not refuse a same-column or backward crossing, which is the shape the built-ins now ship", () => {
    expect(isForwardNodeEntryIntoCompleteColumn(at({ targetComplete: false }))).toBe(false);
    expect(isForwardNodeEntryIntoCompleteColumn(at({ direction: "backward" }))).toBe(false);
  });
});
