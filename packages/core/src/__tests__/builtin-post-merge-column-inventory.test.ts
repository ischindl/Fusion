/*
FNXC:CompleteLaneBoundary 2026-11-08-13:36 (RUFU-349):
A required post-merge gate authored INSIDE a complete-trait column is the shape that let 21 cards
reach `done` while the gate reported `failed/REVISE` or had no result row at all: the graph's
node-entry column-boundary move writes the node's column BEFORE any verdict exists, and once the
card stands in the complete lane the finalizer's evidence fences short-circuit, so nothing notices
and a later REVISE can never retract the move.

This inventory is the authoritative offender enumeration for the topology step: it enumerates EVERY
built-in workflow definition plus every exported built-in IR (the inline spectrum builder and the
named IR files are separate authoring surfaces, and only one of them was ever read when this was
first misdiagnosed), and asserts no node carrying `config.phase: "post-merge"` sits in a column
whose trait flags carry `complete`. `end` is exempt: it is a graph terminal, never a mover (KTD-1),
so an `end` node authored in the complete column moves nothing.

The assertion is written against the `complete` TRAIT rather than a column-name literal because
complete columns are named per workflow (`done`, `published`, `converted`) — a name allow-list would
miss the marketing board's `published` lane, which is exactly one of the measured offenders.
*/
import { describe, expect, it } from "vitest";

import { BUILTIN_WORKFLOWS } from "../workflows/builtin-workflows.js";
import { BUILTIN_BRAINSTORMING_WORKFLOW_IR } from "../workflows/builtin-brainstorming-workflow-ir.js";
import { BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR } from "../workflows/builtin-coding-ideas-v2-workflow-ir.js";
import { BUILTIN_CODING_IDEAS_WORKFLOW_IR } from "../workflows/builtin-coding-ideas-workflow-ir.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../workflows/builtin-coding-workflow-ir.js";
import { BUILTIN_LEAD_GENERATION_WORKFLOW_IR } from "../workflows/builtin-lead-generation-workflow-ir.js";
import { BUILTIN_MARKETING_WORKFLOW_IR } from "../workflows/builtin-marketing-workflow-ir.js";
import { BUILTIN_PR_WORKFLOW_IR } from "../workflows/builtin-pr-workflow-ir.js";
import { BUILTIN_STEPWISE_CODING_WORKFLOW_IR } from "../workflows/builtin-stepwise-coding-workflow-ir.js";
import { BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR } from "../workflows/builtin-stepwise-final-review-coding-workflow-ir.js";
import { isCompleteColumn, resolveColumnFlags } from "../index.js";
import type { WorkflowIr, WorkflowIrNode } from "../workflows/workflow-ir-types.js";

/** One row per (workflow, offending node): the shape this inventory forbids. */
interface Offender {
  workflow: string;
  nodeId: string;
  column: string;
}

/** Every built-in IR reachable through either authoring surface, keyed by a stable label. */
const BUILTIN_IRS: ReadonlyArray<{ label: string; ir: WorkflowIr }> = [
  ...BUILTIN_WORKFLOWS.map((definition) => ({ label: definition.id, ir: definition.ir })),
  { label: "ir:builtin:brainstorming", ir: BUILTIN_BRAINSTORMING_WORKFLOW_IR },
  { label: "ir:builtin:coding-ideas-v2", ir: BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR },
  { label: "ir:builtin:coding-ideas", ir: BUILTIN_CODING_IDEAS_WORKFLOW_IR },
  { label: "ir:builtin:coding", ir: BUILTIN_CODING_WORKFLOW_IR },
  { label: "ir:builtin:lead-generation", ir: BUILTIN_LEAD_GENERATION_WORKFLOW_IR },
  { label: "ir:builtin:marketing", ir: BUILTIN_MARKETING_WORKFLOW_IR },
  { label: "ir:builtin:pr-workflow", ir: BUILTIN_PR_WORKFLOW_IR },
  { label: "ir:builtin:stepwise-coding", ir: BUILTIN_STEPWISE_CODING_WORKFLOW_IR },
  { label: "ir:builtin:stepwise-final-review-coding", ir: BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR },
];

function postMergeNodesInCompleteColumn(ir: WorkflowIr): string[] {
  return ir.nodes
    .filter((node: WorkflowIrNode) => node.config?.phase === "post-merge" && node.kind !== "end")
    .filter((node) => {
      const column = ir.columns.find((candidate) => candidate.id === node.column);
      return column !== undefined && isCompleteColumn(resolveColumnFlags(column));
    })
    .map((node) => `${node.id} @ ${node.column}`);
}

describe("built-in post-merge gate column inventory (RUFU-349)", () => {
  it("enumerates a non-empty built-in set, so the scan cannot pass by vacuity", () => {
    expect(BUILTIN_IRS.length).toBeGreaterThanOrEqual(13);
    // The merge-bearing built-ins must be present, or this file proves nothing about them.
    const labels = new Set(BUILTIN_IRS.map(({ label }) => label));
    expect(labels.has("builtin:coding")).toBe(true);
    expect(labels.has("builtin:marketing")).toBe(true);
    expect(labels.has("builtin:stepwise-coding")).toBe(true);
  });

  it("places no phase:post-merge node in a complete-trait column", () => {
    const offenders: Offender[] = [];
    for (const { label, ir } of BUILTIN_IRS) {
      for (const entry of postMergeNodesInCompleteColumn(ir)) {
        const [nodeId, column] = entry.split(" @ ");
        offenders.push({ workflow: label, nodeId: nodeId!, column: column! });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never authors a post-merge node in the per-workflow complete column name", () => {
    // Complementary to the trait assertion above: the literal names the measured offenders used.
    // Asserting both keeps a trait-registry regression from silently blanking the primary check.
    const completeColumnNames = new Set(["done", "published", "converted"]);
    const offenders: string[] = [];
    for (const { label, ir } of BUILTIN_IRS) {
      for (const node of ir.nodes) {
        if (node.config?.phase !== "post-merge" || node.kind === "end") continue;
        if (completeColumnNames.has(node.column ?? "")) offenders.push(`${label}: ${node.id} @ ${node.column}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("leaves builtin:lead-generation a no-merge no-gate workflow (the exemption leg is real)", () => {
    // The no-merge mover's no-regression leg depends on this: a merge-less IR with NO post-merge
    // node must be completing through `advanceNoMergeWorkflowToCompleteColumn` untouched.
    const ir = BUILTIN_LEAD_GENERATION_WORKFLOW_IR;
    expect(ir.nodes.some((node) => node.config?.phase === "post-merge")).toBe(false);
    expect(ir.nodes.some((node) => node.kind === "merge-attempt" || node.kind === "merge-gate")).toBe(false);
    expect(postMergeNodesInCompleteColumn(ir)).toEqual([]);
  });
});
