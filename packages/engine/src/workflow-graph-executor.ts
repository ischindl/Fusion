import type { Settings, TaskDetail, WorkflowIr, WorkflowIrEdge, WorkflowIrNode } from "@fusion/core";
import { BUILTIN_CODING_WORKFLOW_IR, WorkflowIrError, isExperimentalFeatureEnabled } from "@fusion/core";

import {
  createDefaultNodeHandlers,
  createNoopLegacySeams,
  type WorkflowCustomNodeRunner,
  type WorkflowLegacySeams,
} from "./workflow-node-handlers.js";

export type WorkflowNodeOutcome = "success" | "failure";

export interface WorkflowNodeResult {
  outcome: WorkflowNodeOutcome;
  value?: string;
  contextPatch?: Record<string, unknown>;
}

export interface WorkflowNodeExecutionContext {
  task: TaskDetail;
  settings: Pick<Settings, "experimentalFeatures"> | undefined;
  context: Record<string, unknown>;
}

export type WorkflowNodeHandler = (node: WorkflowIrNode, context: WorkflowNodeExecutionContext) => Promise<WorkflowNodeResult>;

export interface WorkflowGraphExecutorDeps {
  handlers?: Partial<Record<WorkflowIrNode["kind"], WorkflowNodeHandler>>;
  seams?: WorkflowLegacySeams;
  /** Executes custom (non-seam) prompt/script/gate nodes. */
  runCustomNode?: WorkflowCustomNodeRunner;
  maxRetriesPerNode?: number;
}

export interface WorkflowGraphExecutorResult {
  executed: boolean;
  outcome: WorkflowNodeOutcome;
  context: Record<string, unknown>;
  visitedNodeIds: string[];
}

const TERMINAL_FAILURE: WorkflowGraphExecutorResult = {
  executed: false,
  outcome: "failure",
  context: {},
  visitedNodeIds: [],
};

export class WorkflowGraphExecutor {
  private readonly maxRetriesPerNode: number;

  private readonly handlers: Partial<Record<WorkflowIrNode["kind"], WorkflowNodeHandler>>;

  public constructor(private readonly deps: WorkflowGraphExecutorDeps) {
    this.maxRetriesPerNode = Math.max(1, Math.floor(deps.maxRetriesPerNode ?? 2));
    this.handlers = {
      ...createDefaultNodeHandlers(deps.seams ?? createNoopLegacySeams(), deps.runCustomNode),
      ...(deps.handlers ?? {}),
    };
  }

  public async run(
    task: TaskDetail,
    settings: Pick<Settings, "experimentalFeatures"> | undefined,
    ir: WorkflowIr = BUILTIN_CODING_WORKFLOW_IR,
  ): Promise<WorkflowGraphExecutorResult> {
    if (!isExperimentalFeatureEnabled(settings, "workflowGraphExecutor")) {
      return TERMINAL_FAILURE;
    }

    const startNode = ir.nodes.find((node) => node.kind === "start");
    if (!startNode) throw new WorkflowIrError("Workflow IR missing start node");

    const nodeMap = new Map(ir.nodes.map((node) => [node.id, node]));
    const outgoingMap = new Map<string, WorkflowIrEdge[]>();
    for (const edge of ir.edges) {
      if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) {
        throw new WorkflowIrError(`Workflow IR edge references unknown node: ${edge.from} -> ${edge.to}`);
      }
      const list = outgoingMap.get(edge.from) ?? [];
      list.push(edge);
      outgoingMap.set(edge.from, list);
    }

    const context: Record<string, unknown> = {};
    const visitedNodeIds: string[] = [];
    const inStack = new Set<string>();

    const walk = async (nodeId: string): Promise<WorkflowNodeResult> => {
      const node = nodeMap.get(nodeId);
      if (!node) throw new WorkflowIrError(`Unknown workflow node: ${nodeId}`);
      if (inStack.has(nodeId)) throw new WorkflowIrError(`Cycle detected at node: ${nodeId}`);
      inStack.add(nodeId);
      visitedNodeIds.push(nodeId);

      try {
        if (node.kind === "start") {
          return await traverseChildren(node, { outcome: "success" });
        }
        if (node.kind === "end") {
          return { outcome: "success" };
        }

        const result = await this.executeNodeWithRetries(node, task, settings, context);
        if (result.contextPatch) Object.assign(context, result.contextPatch);
        context[`node:${node.id}:outcome`] = result.outcome;
        if (result.value !== undefined) context[`node:${node.id}:value`] = result.value;

        return await traverseChildren(node, result);
      } finally {
        inStack.delete(nodeId);
      }
    };

    const traverseChildren = async (node: WorkflowIrNode, sourceResult: WorkflowNodeResult): Promise<WorkflowNodeResult> => {
      const edges = outgoingMap.get(node.id) ?? [];
      if (edges.length === 0) {
        return sourceResult;
      }

      const matching = edges.filter((edge) => this.shouldTraverseEdge(edge, sourceResult));
      if (matching.length === 0) {
        return sourceResult;
      }

      let aggregate: WorkflowNodeResult = sourceResult;
      for (const edge of matching.sort((a, b) => a.to.localeCompare(b.to))) {
        const target = nodeMap.get(edge.to);
        if (target?.kind === "end") {
          aggregate = sourceResult;
          continue;
        }
        const child = await walk(edge.to);
        if (child.outcome === "failure") {
          aggregate = child;
          break;
        }
        aggregate = child;
      }
      return aggregate;
    };

    const terminal = await walk(startNode.id);
    return {
      executed: true,
      outcome: terminal.outcome,
      context,
      visitedNodeIds,
    };
  }

  private shouldTraverseEdge(edge: WorkflowIrEdge, sourceResult: WorkflowNodeResult): boolean {
    if (!edge.condition) return sourceResult.outcome === "success";
    if (edge.condition === "success") return sourceResult.outcome === "success";
    if (edge.condition === "failure") return sourceResult.outcome === "failure";
    if (edge.condition.startsWith("outcome:")) {
      return sourceResult.value === edge.condition.slice("outcome:".length);
    }
    throw new WorkflowIrError(`Unsupported edge condition: ${edge.condition}`);
  }

  private async executeNodeWithRetries(
    node: WorkflowIrNode,
    task: TaskDetail,
    settings: Pick<Settings, "experimentalFeatures"> | undefined,
    context: Record<string, unknown>,
  ): Promise<WorkflowNodeResult> {
    const handler = this.handlers[node.kind];
    if (!handler) {
      throw new WorkflowIrError(`No handler registered for node kind: ${node.kind}`);
    }

    // Per-node override: config.maxRetries beats the executor-wide default.
    const configured = Number(node.config?.maxRetries);
    const maxAttempts = Number.isFinite(configured) && configured >= 1
      ? Math.min(10, Math.floor(configured))
      : this.maxRetriesPerNode;

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await handler(node, { task, settings, context });
      } catch (error) {
        lastError = error;
      }
    }

    return {
      outcome: "failure",
      value: "exception",
      contextPatch: {
        [`node:${node.id}:error`]: lastError instanceof Error ? lastError.message : String(lastError),
      },
    };
  }
}
