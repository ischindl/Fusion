import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import type { WorkflowDefinition } from "@fusion/core";
import { irToFlow, flowToIr, emptyWorkflowIr, emptyWorkflowLayout } from "../workflow-flow-mapping";

vi.mock("../../api", () => ({
  fetchWorkflows: vi.fn(),
  createWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
  compileWorkflow: vi.fn(),
}));

import { fetchWorkflows } from "../../api";
import { WorkflowNodeEditor } from "../WorkflowNodeEditor";

function def(): WorkflowDefinition {
  return {
    id: "WF-001",
    name: "QA",
    description: "",
    ir: {
      version: "v1",
      name: "QA",
      nodes: [
        { id: "start", kind: "start" },
        { id: "lint", kind: "gate", config: { name: "Lint", scriptName: "lint", gateMode: "gate" } },
        { id: "merge", kind: "prompt", config: { seam: "merge", name: "Merge boundary" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "lint", condition: "success" },
        { from: "lint", to: "merge", condition: "success" },
        { from: "merge", to: "end", condition: "success" },
      ],
    },
    layout: { start: { x: 0, y: 0 }, lint: { x: 120, y: 0 }, merge: { x: 240, y: 0 }, end: { x: 360, y: 0 } },
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
}

describe("workflow-flow-mapping", () => {
  it("round-trips IR through flow and back, preserving structure and layout", () => {
    const original = def();
    const flow = irToFlow(original);
    expect(flow.nodes).toHaveLength(4);
    expect(flow.nodes.find((n) => n.id === "lint")?.type).toBe("gate");
    expect(flow.nodes.find((n) => n.id === "merge")?.type).toBe("merge");
    expect(flow.nodes.find((n) => n.id === "start")?.position).toEqual({ x: 0, y: 0 });

    const { ir, layout } = flowToIr(original.name, flow.nodes, flow.edges);
    expect(ir.nodes.map((n) => n.id)).toEqual(["start", "lint", "merge", "end"]);
    // merge marker maps back to a prompt node carrying the seam config.
    const mergeNode = ir.nodes.find((n) => n.id === "merge");
    expect(mergeNode?.kind).toBe("prompt");
    expect(mergeNode?.config?.seam).toBe("merge");
    expect(ir.edges).toHaveLength(3);
    expect(layout.lint).toEqual({ x: 120, y: 0 });
  });

  it("emptyWorkflowIr seeds a connected start→end graph", () => {
    const ir = emptyWorkflowIr("New");
    expect(ir.nodes.map((n) => n.kind)).toEqual(["start", "end"]);
    expect(ir.edges).toEqual([{ from: "start", to: "end", condition: "success" }]);
    expect(emptyWorkflowLayout().start).toBeDefined();
  });
});

describe("WorkflowNodeEditor", () => {
  beforeEach(() => {
    vi.mocked(fetchWorkflows).mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the empty state when there are no workflows (no canvas)", async () => {
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    expect(await screen.findByText("Workflows")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/No workflows yet/i)).toBeInTheDocument());
    expect(screen.getByText(/Select or create a workflow/i)).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    const { container } = render(<WorkflowNodeEditor isOpen={false} onClose={() => {}} addToast={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
