import type { Node as FlowNode, Edge as FlowEdge } from "@xyflow/react";
import type { WorkflowIr, WorkflowDefinition } from "@fusion/core";
import type { WorkflowFlowNodeData, WorkflowEditorNodeKind } from "./nodes/WorkflowNodeTypes";

/** Resolve the editor node "type" for an IR node (merge seam → "merge"). */
function editorKind(node: WorkflowIr["nodes"][number]): WorkflowEditorNodeKind {
  const seam = node.config?.seam;
  if (seam === "merge") return "merge";
  return node.kind;
}

function nodeLabel(node: WorkflowIr["nodes"][number]): string {
  const name = node.config?.name;
  if (typeof name === "string" && name.trim()) return name;
  if (node.config?.seam === "merge") return "Merge boundary";
  return node.id;
}

/** Build React Flow nodes/edges from a stored workflow definition. */
export function irToFlow(def: WorkflowDefinition): {
  nodes: FlowNode<WorkflowFlowNodeData>[];
  edges: FlowEdge[];
} {
  const nodes = def.ir.nodes.map((node, index): FlowNode<WorkflowFlowNodeData> => {
    const pos = def.layout?.[node.id];
    const kind = editorKind(node);
    return {
      id: node.id,
      type: kind,
      position: pos ?? { x: 80 + index * 180, y: 120 },
      data: { kind, label: nodeLabel(node), config: { ...(node.config ?? {}) } },
      deletable: node.kind !== "start" && node.kind !== "end",
    };
  });

  const edges = def.ir.edges.map((edge, index): FlowEdge => {
    const condition = edge.condition ?? "success";
    return {
      id: `e-${edge.from}-${edge.to}-${index}`,
      source: edge.from,
      target: edge.to,
      label: condition,
      data: { condition },
    };
  });

  return { nodes, edges };
}

/** Project React Flow nodes/edges back into a WorkflowIr plus a layout map. */
export function flowToIr(
  name: string,
  nodes: FlowNode<WorkflowFlowNodeData>[],
  edges: FlowEdge[],
): { ir: WorkflowIr; layout: Record<string, { x: number; y: number }> } {
  const irNodes: WorkflowIr["nodes"] = nodes.map((node) => {
    const data = node.data;
    const config: Record<string, unknown> = { ...(data.config ?? {}) };
    // `irToFlow` synthesizes display labels for unnamed nodes (matching the
    // fallback below), so only persist a label that the user actually set —
    // otherwise saving an untouched workflow injects synthetic names like
    // "start"/"end"/"Merge boundary" and breaks IR round-trips.
    const fallbackLabel = data.kind === "merge" ? "Merge boundary" : node.id;
    if (
      data.kind !== "start" &&
      data.kind !== "end" &&
      data.label &&
      data.label !== fallbackLabel
    ) {
      config.name = data.label;
    } else {
      delete config.name;
    }
    if (data.kind === "merge") {
      config.seam = "merge";
      return { id: node.id, kind: "prompt", config };
    }
    return { id: node.id, kind: data.kind, config: Object.keys(config).length ? config : undefined };
  });

  const irEdges: WorkflowIr["edges"] = edges.map((edge) => {
    const condition = (edge.data?.condition as string | undefined) ?? "success";
    return { from: edge.source, to: edge.target, condition };
  });

  const layout = nodes.reduce<Record<string, { x: number; y: number }>>((acc, node) => {
    acc[node.id] = { x: Math.round(node.position.x), y: Math.round(node.position.y) };
    return acc;
  }, {});

  return { ir: { version: "v1", name, nodes: irNodes, edges: irEdges }, layout };
}

/** Seed graph for a brand-new workflow: start → end with room to insert steps. */
export function emptyWorkflowIr(name: string): WorkflowIr {
  return {
    version: "v1",
    name,
    nodes: [
      { id: "start", kind: "start" },
      { id: "end", kind: "end" },
    ],
    edges: [{ from: "start", to: "end", condition: "success" }],
  };
}

export function emptyWorkflowLayout(): Record<string, { x: number; y: number }> {
  return { start: { x: 80, y: 140 }, end: { x: 460, y: 140 } };
}
