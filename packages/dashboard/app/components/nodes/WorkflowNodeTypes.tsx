import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Play, Flag, MessageSquare, Terminal, Shield, GitMerge } from "lucide-react";

/** Node kinds the editor can render. "merge" is the pre/post-merge seam marker. */
export type WorkflowEditorNodeKind = "start" | "end" | "prompt" | "script" | "gate" | "merge";

export interface WorkflowFlowNodeData {
  kind: WorkflowEditorNodeKind;
  label: string;
  /** Mirrors the IR node config (prompt, scriptName, gateMode, model…). */
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

const KIND_ICON: Record<WorkflowEditorNodeKind, typeof Play> = {
  start: Play,
  end: Flag,
  prompt: MessageSquare,
  script: Terminal,
  gate: Shield,
  merge: GitMerge,
};

function NodeShell({ data, kind }: { data: WorkflowFlowNodeData; kind: WorkflowEditorNodeKind }) {
  const Icon = KIND_ICON[kind];
  const showTarget = kind !== "start";
  const showSource = kind !== "end";
  return (
    <div className={`wf-node wf-node-${kind}`} data-testid={`wf-node-${kind}`}>
      {showTarget && <Handle type="target" position={Position.Left} />}
      <span className="wf-node-icon">
        <Icon size={14} aria-hidden />
      </span>
      <span className="wf-node-label">{data.label || kind}</span>
      {kind === "gate" && <span className="wf-node-badge">gate</span>}
      {showSource && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

export const workflowNodeTypes = {
  start: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="start" />,
  end: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="end" />,
  prompt: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="prompt" />,
  script: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="script" />,
  gate: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="gate" />,
  merge: ({ data }: NodeProps) => <NodeShell data={data as WorkflowFlowNodeData} kind="merge" />,
};
