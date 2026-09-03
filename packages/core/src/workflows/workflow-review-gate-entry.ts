/*
FNXC:LifecycleContainment 2026-09-02-22:41:
RUFU-178: entering a review gate must never move the card backward out of its lane. The column
boundary already enforces this (backward review-gate entries are taken IN PLACE instead of moving,
because a REVISE from the gate re-enters the same lane the card already stands in — the move would
be a rank-decreasing violation for no benefit). The FN-9243 unrun-gate re-seed needs the identical
decision so the continuation it writes never names a column the card will not stand in (a plan-review
node lives in the planning lane; a review-lane card seeded with targetColumn "todo" described a
position it never occupied). One shared authority — this module — answers both questions so the
boundary and the re-seed can never drift.
*/
import type { WorkflowIr, WorkflowIrNode, WorkflowIrV2 } from "./workflow-ir-types.js";
import { classifyLifecycleDirection, classifyLifecycleRole } from "./workflow-lifecycle-direction.js";
import { resolveColumnFlags } from "./trait-registry.js";

/**
 * The review-gate node kinds: an `optional-group` (e.g. Plan Review, Security Review) or a
 * `step-review` verdict gate. These are the nodes whose rejection routes the card back INTO the
 * gate, so their column entry is lifecycle-contained even when the node's declared column sits at
 * a lower lifecycle rank than the card's current column.
 */
export function isReviewGateNode(node: Pick<WorkflowIrNode, "kind">): boolean {
  return node.kind === "optional-group" || node.kind === "step-review";
}

export interface ReviewGateEntryClamp {
  /** Column the card will actually stand in after entering the node (clamped to fromColumn on a backward review-gate entry). */
  toColumn: string | undefined;
  /** True when a review-gate entry was clamped in place instead of moving the card backward. */
  clamped: boolean;
  /** Classified direction of the unclamped node-column entry ("unknown" when either side has no classifiable lifecycle role). */
  direction: ReturnType<typeof classifyLifecycleDirection>;
}

/**
 * Classify a node entry against the card's current column and clamp it in place when entering a
 * review gate would move the card backward. Same-column or columnless entries, non-review-gate
 * nodes, and entries whose roles cannot both be classified (e.g. custom columns without lifecycle
 * traits) are returned unclamped — conservative, matching the boundary's existing rule.
 */
export function clampReviewGateEntry(
  ir: WorkflowIr,
  node: Pick<WorkflowIrNode, "kind" | "column">,
  fromColumn: string,
): ReviewGateEntryClamp {
  const toColumn = node.column;
  const pass = { toColumn, clamped: false } as const;
  if (!isReviewGateNode(node) || toColumn === undefined || toColumn === fromColumn) {
    return { ...pass, direction: "unknown" };
  }
  const columns = (ir as WorkflowIrV2).columns;
  const flagsFor = (columnId: string) => {
    const col = Array.isArray(columns) ? columns.find((c) => c.id === columnId) : undefined;
    return col ? resolveColumnFlags(col) : {};
  };
  const direction = classifyLifecycleDirection(
    classifyLifecycleRole(flagsFor(fromColumn)),
    classifyLifecycleRole(flagsFor(toColumn)),
  );
  if (direction === "backward") return { toColumn: fromColumn, clamped: true, direction };
  return { ...pass, direction };
}
