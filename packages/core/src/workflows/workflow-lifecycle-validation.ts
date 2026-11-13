import type { WorkflowDefinitionKind } from "./workflow-definition-types.js";
import type { WorkflowIr, WorkflowIrColumn, WorkflowIrEdge, WorkflowIrNode } from "./workflow-ir-types.js";
import { isCompletionSummaryNode } from "./builtin-completion-summary-node.js";
import { findPostMergeNodesInCompleteColumn } from "./complete-column-post-merge-authoring.js";
import { resolveColumnFlags } from "./trait-registry.js";
import { isCompleteColumn } from "./workflow-transition-policy.js";

/**
 * FNXC:WorkflowLifecycle 2026-07-01-00:00:
 * Workflow-owned merge/retry/recovery policy primitives — a terminal,
 * engine-owned region that may branch internally. Formerly exported from the
 * (now-deleted) linear WorkflowStep compiler; the graph interpreter is the sole
 * executor, so this set now lives with its only remaining consumer.
 */
const MERGE_REGION_NODE_KINDS: ReadonlySet<WorkflowIrNode["kind"]> = new Set([
  "merge-gate",
  "merge-attempt",
  "manual-merge-hold",
  "retry-backoff",
  "recovery-router",
  "branch-group-member-integration",
  "branch-group-promotion",
]);

export type WorkflowLifecycleWarningCode =
  | "missing-completion-summary"
  | "missing-merge-region"
  | "unsafe-terminal-before-merge"
  | "optional-group-after-execution"
  | "review-gate-without-failure-route"
  | "write-capable-node-after-code-review"
  /** Mirrors the save-time refusal in `complete-column-post-merge-authoring.ts`. Shares that rule's code
   *  string verbatim (`POST_MERGE_COMPLETE_COLUMN_RULE_CODE`) so an editor surface that keys its copy off
   *  the code needs one literal for both the advisory and the refusal. */
  | "post-merge-node-in-complete-column"
  /** A `parse-steps` failure-class edge enters a NON-terminal node in a complete-trait column. Distinct
   *  from `unsafe-terminal-before-merge` (which scans edges whose target IS the terminal and ignores
   *  non-success conditions) and from `post-merge-node-in-complete-column` (which scans a node's declared
   *  post-merge phase, not the edges arriving in it). */
  | "parse-failure-routes-to-terminal";

export interface WorkflowLifecycleWarning {
  code: WorkflowLifecycleWarningCode;
  nodeId?: string;
  message: string;
}

export interface AnalyzeWorkflowLifecycleOptions {
  kind?: WorkflowDefinitionKind;
}

function isSummaryNode(node: WorkflowIrNode): boolean {
  return isCompletionSummaryNode(node);
}

function isMergeNode(node: WorkflowIrNode): boolean {
  return MERGE_REGION_NODE_KINDS.has(node.kind) || node.config?.seam === "merge";
}

function isExecutionNode(node: WorkflowIrNode): boolean {
  return node.config?.seam === "execute" || node.kind === "foreach" || node.kind === "parse-steps";
}

function isCodeReviewNode(node: WorkflowIrNode): boolean {
  const name = typeof node.config?.name === "string" ? node.config.name : "";
  return node.id === "code-review" || node.config?.reviewKind === "code" || /code review/i.test(name);
}

/*
FNXC:ParseFailureRouting 2026-11-12-23:55 (RUFU-501):
The two outcomes a `parse-steps` node can fail with are a failure CLASS, not one bucket: `failure` is the
generic route and `outcome:<reason>` is the route an author gives a named refusal (`outcome:parse-error`,
`outcome:invalid-plan-dependency`). Success, the no-steps outcome, and an untagged edge are routings and never
carry a refusal, so the classifier is a closed set of exemptions rather than a list of known failure tags -
an author's custom `outcome:` tag is a named non-success exit and reads as one.
*/
function isFailureClassEdge(edge: WorkflowIrEdge): boolean {
  const condition = String(edge.condition ?? "");
  if (condition === "failure") return true;
  if (!condition.startsWith("outcome:")) return false;
  return condition !== "outcome:success" && condition !== "outcome:no-steps";
}

function isWriteCapableNode(node: WorkflowIrNode): boolean {
  const config = node.config ?? {};
  const executor = typeof config.executor === "string" ? config.executor : "model";
  return node.kind === "code" || node.kind === "script" || config.toolMode === "coding"
    || executor === "cli-agent" || (executor === "cli" && typeof config.cliCommand === "string" && config.cliCommand.trim().length > 0)
    || (typeof config.scriptName === "string" && config.scriptName.trim().length > 0);
}

function buildOutgoing(edges: readonly WorkflowIrEdge[]): Map<string, WorkflowIrEdge[]> {
  const outgoing = new Map<string, WorkflowIrEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }
  return outgoing;
}

function reachableBefore(
  startId: string,
  targetId: string,
  outgoing: Map<string, WorkflowIrEdge[]>,
): Set<string> {
  const reachable = new Set<string>();
  const queue = [startId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (id === targetId || reachable.has(id)) continue;
    reachable.add(id);
    for (const edge of outgoing.get(id) ?? []) {
      if (edge.kind === "rework" || reachable.has(edge.to)) continue;
      queue.push(edge.to);
    }
  }
  return reachable;
}

/*
FNXC:WorkflowLifecycleValidation 2026-06-29-11:47:
Custom workflow authors need lifecycle-specific guidance without turning every
advanced graph into a hard parse failure. Emit warnings for missing summary,
missing merge proof regions, unsafe terminal paths, misplaced optional gates, review
gates with no failure route, and a `parse-steps` refusal edge routed into a
complete-trait column; engine/store merge-proof guards remain the hard invariant
that prevents unsafe done.

FNXC:CompleteLaneBoundary 2026-11-08-15:16 (RUFU-349, Code Review finding P2):
That closing sentence was no longer the whole truth: a card could stand in `done` over a required
post-merge gate with zero result rows while every merge-proof guard below stayed silent, because none of
them consulted POST-MERGE gate EVIDENCE — the RUFU-349 measurement was 21 such cards. The invariant is now
held in three places, and this analyzer is the earliest of them: an ADVISORY here (before the save), the
save-time refusal (`assertPostMergeNodesNotInCompleteColumn`), and the runtime boundary that makes an
already-persisted offender inert. Advisory rather than a parse failure, per the rule above: a graph drawn
this way before the rule existed must stay loadable so an operator can open it and repair it.
*/
export function analyzeWorkflowLifecycle(
  ir: WorkflowIr,
  options: AnalyzeWorkflowLifecycleOptions = {},
): WorkflowLifecycleWarning[] {
  if (options.kind === "fragment") return [];
  const warnings: WorkflowLifecycleWarning[] = [];
  const nodes = ir.nodes;
  const outgoing = buildOutgoing(ir.edges);
  const hasSummary = nodes.some(isSummaryNode);
  const mergeNodeIds = new Set(nodes.filter(isMergeNode).map((node) => node.id));
  const endNode = nodes.find((node) => node.kind === "end");
  const startId = nodes.find((node) => node.kind === "start")?.id ?? "start";

  if (!hasSummary) {
    warnings.push({
      code: "missing-completion-summary",
      message: "Full task workflows should include a completion-summary node before review, merge, or done.",
    });
  }

  if (mergeNodeIds.size === 0) {
    warnings.push({
      code: "missing-merge-region",
      message: "Full task workflows should include a merge region so done is backed by merge proof.",
    });
  }

  if (endNode && mergeNodeIds.size > 0) {
    const beforeEnd = reachableBefore(startId, endNode.id, outgoing);
    const mergeReachableBeforeEnd = [...mergeNodeIds].some((id) => beforeEnd.has(id));
    for (const edge of ir.edges) {
      if (edge.to !== endNode.id) continue;
      if (edge.condition !== undefined && edge.condition !== "success") continue;
      if (mergeNodeIds.has(edge.from)) continue;
      if (!mergeReachableBeforeEnd || beforeEnd.has(edge.from)) {
        warnings.push({
          code: "unsafe-terminal-before-merge",
          nodeId: edge.from,
          message: `Node '${edge.from}' can terminate the workflow before a merge-proof region.`,
        });
      }
    }
  }

  const executionNodeIds = new Set(nodes.filter(isExecutionNode).map((node) => node.id));
  for (const node of nodes) {
    if (node.kind !== "optional-group") continue;
    const groupName = typeof node.config?.name === "string" ? node.config.name : node.id;
    const beforeGroup = reachableBefore(
      startId,
      node.id,
      outgoing,
    );
    const isPlanReview = node.id === "plan-review" || /plan review/i.test(groupName);
    if (isPlanReview && [...executionNodeIds].some((id) => beforeGroup.has(id))) {
      warnings.push({
        code: "optional-group-after-execution",
        nodeId: node.id,
        message: "Plan Review should be ordered before parse/execution so rejected plans cannot start work.",
      });
    }

    const template = node.config?.template;
    const templateNodes = template && typeof template === "object" && Array.isArray((template as { nodes?: unknown }).nodes)
      ? (template as { nodes: WorkflowIrNode[] }).nodes
      : [];
    const hasGateStep = templateNodes.some((inner) => inner.config?.gateMode === "gate");
    const isPostMergeGate = node.config?.phase === "post-merge";
    const hasFailureRoute = (outgoing.get(node.id) ?? []).some((edge) =>
      edge.condition === "failure" || String(edge.condition ?? "").startsWith("outcome:"),
    );
    if (hasGateStep && !hasFailureRoute && !isPostMergeGate) {
      warnings.push({
        code: "review-gate-without-failure-route",
        nodeId: node.id,
        message: `Review gate '${node.id}' should declare a failure/remediation route so blocking findings cannot fall through silently.`,
      });
    }
  }

  for (const reviewNode of nodes.filter(isCodeReviewNode)) {
    const afterReview = reachableBefore(reviewNode.id, "__never__", outgoing);
    for (const node of nodes.filter(isWriteCapableNode)) {
      if (node.id === reviewNode.id || !afterReview.has(node.id)) continue;
      warnings.push({
        code: "write-capable-node-after-code-review",
        nodeId: node.id,
        message: `Write-capable node '${node.id}' follows Code Review '${reviewNode.id}'. Move it before review or add an explicit re-review route.`,
      });
    }
  }

  /*
  FNXC:CompleteLaneBoundary 2026-11-08-15:16 (RUFU-349, Code Review finding P2):
  The editor must see the illegal shape before the save, not as a refusal after it. The hit list comes from
  the SAME predicate the save-time assertion uses, so an advisory that drifts from the refusal would teach
  authors to distrust both.
  */
  /*
  FNXC:ParseFailureRouting 2026-11-12-23:55 (RUFU-501):
  A plan the step parser refuses is a WRITER failure with a known repair (re-plan), so a graph that routes it
  into a complete-trait column does two wrong things at once: the card reaches the terminal lane over an
  unreadable plan, and node entry wrote that column under `bypassGuards: true`, so nothing downstream can
  retract it - the same irreversibility RUFU-349 refused for post-merge gates, reached here through an edge
  rather than a `config.phase`. The graph terminal is excluded explicitly: completion legitimately lands
  there, and KTD-1 makes it inert as a column destination, so a warning that fired on every built-in would
  train authors to ignore it (measured: every shipped built-in whose parse node has failure edges targets
  only the terminal). Advisory, per the module rule - a graph drawn this way before the rule must stay
  loadable so an author can repair it.
  */
  const completeColumns = new Set(
    ((ir as { columns?: WorkflowIrColumn[] }).columns ?? [])
      .filter((column) => isCompleteColumn(resolveColumnFlags(column)))
      .map((column) => column.id),
  );
  if (completeColumns.size > 0) {
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    for (const source of nodes.filter((node) => node.kind === "parse-steps")) {
      for (const edge of outgoing.get(source.id) ?? []) {
        if (!isFailureClassEdge(edge)) continue;
        const target = nodesById.get(edge.to);
        // The graph terminal is the designed sink for a parse failure: inert as a column destination (KTD-1).
        if (!target || target.kind === "end" || target.kind === "start") continue;
        if (!target.column || !completeColumns.has(target.column)) continue;
        warnings.push({
          code: "parse-failure-routes-to-terminal",
          nodeId: source.id,
          message: `Parse node '${source.id}' routes its ${String(edge.condition)} refusal into non-terminal node '${target.id}' in complete-trait column '${target.column}'. Entering that node moves the card into the terminal lane over a plan that never parsed, and nothing downstream can retract it. Route the refusal to the lane holding planning or Plan Review so the plan is repaired, or to the graph terminal.`,
        });
      }
    }
  }

  for (const hit of findPostMergeNodesInCompleteColumn(ir)) {
    warnings.push({
      code: "post-merge-node-in-complete-column",
      nodeId: hit.nodeId,
      message: `Node '${hit.nodeId}' declares config.phase "post-merge" inside complete-trait column '${hit.column}'. Entering it would move the card into the terminal lane before the gate reports, and nothing downstream can retract that — saving this workflow is refused. Move the node into the review column holding the merge seam.`,
    });
  }

  return warnings;
}
