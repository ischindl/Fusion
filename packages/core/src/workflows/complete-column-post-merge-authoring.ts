import type { WorkflowIr, WorkflowIrColumn, WorkflowIrNode } from "./workflow-ir-types.js";
import { WorkflowIrError } from "./workflow-ir.js";
import { resolveColumnFlags } from "./trait-registry.js";
import { isCompleteColumn } from "./workflow-transition-policy.js";

/*
FNXC:CompleteLaneBoundary 2026-11-08-13:36 (RUFU-349):
Authoring rule: a node carrying `config.phase: "post-merge"` may not be drawn onto a `complete`-trait
column.

Why the shape is illegal rather than merely untidy: graph node entry writes the node's column to move
the card there, under `bypassGuards: true`, so the write lands BEFORE the gate has produced a verdict.
Once the card stands in the complete lane the merge finalizer's evidence fences short-circuit and a
re-seed cannot reach it, because re-dispatch stops short of that lane — so a later `REVISE` is durable
but permanently unable to retract the completion. Measured 2026-09-27 across `.fusion/tasks`: 14 cards in
their complete column carrying a `failed` `post-merge-verification` row plus 7 more with the gate enabled
and zero result rows, 21 of the 23 default-workflow cards that enabled it.

SAVE-time refusal, LOAD-time tolerance. This assertion runs only on the authoring seam
(`store.assertWorkflowIrTraitsValid`, reached by workflow create and workflow update), never inside
`parseWorkflowIr`. A custom workflow drawn this way before the rule existed is on a board today, and a
parse-time throw would make it unreadable — which would break workflow resolution, capacity counting, and
the very re-homing path an operator would use to repair it. An already-persisted offender is made INERT
instead of fatal by the runtime boundary, which refuses the forward crossing into the complete column and
runs the node in place (Step 1), recording `task:column-entry-refused-complete-column` so the advice
lands on the card and in the audit store rather than in a process log nobody reads.
*/

/** The rule sentence, exported so the refusal text and its test cannot drift apart. */
export const COMPLETE_COLUMN_POST_MERGE_RULE =
  "a post-merge gate may not sit in a complete-trait column";

export interface PostMergeCompleteColumnHit {
  nodeId: string;
  column: string;
}

/** Top-level nodes authored with `config.phase: "post-merge"` that sit in a complete-trait column.
 *  Template children are deliberately not scanned: they inherit the container's column and carry no
 *  `column` of their own, so the container is where the shape is authored. */
export function findPostMergeNodesInCompleteColumn(ir: WorkflowIr): PostMergeCompleteColumnHit[] {
  const completeColumns = new Set(
    ((ir as { columns?: WorkflowIrColumn[] }).columns ?? [])
      .filter((column) => isCompleteColumn(resolveColumnFlags(column)))
      .map((column) => column.id),
  );
  if (completeColumns.size === 0) return [];

  const hits: PostMergeCompleteColumnHit[] = [];
  for (const node of (ir.nodes ?? []) as WorkflowIrNode[]) {
    if (!node.column || !completeColumns.has(node.column)) continue;
    const phase = (node.config as { phase?: unknown } | undefined)?.phase;
    if (phase === "post-merge") hits.push({ nodeId: node.id, column: node.column });
  }
  return hits;
}

/** Deterministic refusal sentence naming every offending node. */
export function describePostMergeCompleteColumnViolations(hits: readonly PostMergeCompleteColumnHit[]): string {
  const list = hits.map((hit) => `'${hit.nodeId}' (column '${hit.column}')`).join(", ");
  return (
    `Invalid workflow: ${list} declares config.phase "post-merge" inside a complete-trait column, and `
    + `${COMPLETE_COLUMN_POST_MERGE_RULE}: entering that node would move the card into the terminal lane `
    + `before the gate reports, and nothing downstream can retract it. Move the node into a review column `
    + `(the lane holding the merge seam) so it runs in place and merge-confirmed finalization performs the `
    + `crossing into the complete column.`
  );
}

/** Stable machine-readable reason code for the authoring refusal. Surfaces key their own copy of the advice
 *  off THIS code rather than off the sentence, so rewording the sentence cannot orphan a 4xx handler. */
export const POST_MERGE_COMPLETE_COLUMN_RULE_CODE = "post-merge-node-in-complete-column";

/*
FNXC:CompleteLaneBoundary 2026-11-08-15:16 (RUFU-349, Code Review finding P1):
The assertion used to throw a plain `Error`, and the workflow routes map only `WorkflowIrError` and
`ColumnTraitValidationError` to 4xx — everything else falls through to the generic 500. So the one refusal
this seam exists to give the author as actionable advice arrived as "internal server error": the editor's
message, the CLI's exit text, and the operator's whole understanding of the shape were wrong, because a 500
says the server broke rather than the graph is illegal. The defect was invisible to the unit tests because
they assert the THROW, and a bare `Error` satisfies any `toThrow`.

It is a `WorkflowIrError` subclass rather than a fresh base class on purpose: every surface that already
maps IR validity to 4xx — the create and update routes, the CLI, the validate route — keeps answering 4xx
by `instanceof` with no new branch, while the added `code`/`offenders` fields let a surface that wants
structure name the node and the column without parsing prose (the same shape RUFU-406 gave
`CompleteColumnGateEvidenceRejectionError.gateFindings`). Deleting the shape is not an option: the rule must
stay a refusal, and a refusal that reports as a crash is the RUFU-318 invisible-refusal defect wearing a
status code.
*/
export class PostMergeCompleteColumnAuthoringError extends WorkflowIrError {
  /** Always `POST_MERGE_COMPLETE_COLUMN_RULE_CODE`. */
  readonly code: typeof POST_MERGE_COMPLETE_COLUMN_RULE_CODE = POST_MERGE_COMPLETE_COLUMN_RULE_CODE;
  /** Every offending node and the complete-trait column it was drawn into. */
  readonly offenders: readonly PostMergeCompleteColumnHit[];

  constructor(message: string, offenders: readonly PostMergeCompleteColumnHit[]) {
    super(message);
    this.name = "PostMergeCompleteColumnAuthoringError";
    this.offenders = offenders;
  }
}

/** Authoring-time assertion. Throws on the illegal shape; silent when the IR is clean or declares no
 *  complete column at all. */
export function assertPostMergeNodesNotInCompleteColumn(ir: WorkflowIr): void {
  const hits = findPostMergeNodesInCompleteColumn(ir);
  if (hits.length === 0) return;
  throw new PostMergeCompleteColumnAuthoringError(describePostMergeCompleteColumnViolations(hits), hits);
}
