import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "@fusion/core";
import { irToFlow, flowToIr } from "../workflow-flow-mapping";

function makeDef(ir: WorkflowDefinition["ir"]): WorkflowDefinition {
  return {
    id: "WF-001",
    name: ir.name,
    description: "",
    ir,
    layout: {},
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

describe("workflow-flow-mapping name preservation", () => {
  it("does not inject synthetic names for unnamed start/end/merge nodes on round-trip", () => {
    const ir: WorkflowDefinition["ir"] = {
      version: "v1",
      name: "wf",
      nodes: [
        { id: "start", kind: "start" },
        { id: "n1", kind: "prompt", config: { prompt: "do work" } },
        { id: "m1", kind: "prompt", config: { seam: "merge" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "n1", condition: "success" },
        { from: "n1", to: "m1", condition: "success" },
        { from: "m1", to: "end", condition: "success" },
      ],
    };

    const { nodes, edges } = irToFlow(makeDef(ir));
    const { ir: out } = flowToIr("wf", nodes, edges);

    const byId = Object.fromEntries(out.nodes.map((n) => [n.id, n]));
    // start/end carry no config or a config without an injected name
    expect(byId.start.config?.name).toBeUndefined();
    expect(byId.end.config?.name).toBeUndefined();
    // merge boundary keeps its seam but does not gain a synthetic "Merge boundary" name
    expect(byId.m1.config?.seam).toBe("merge");
    expect(byId.m1.config?.name).toBeUndefined();
    // an unnamed prompt node keeps no synthetic id-as-name
    expect(byId.n1.config?.name).toBeUndefined();
    expect(byId.n1.config?.prompt).toBe("do work");
  });

  it("preserves an explicit node name across round-trips", () => {
    const ir: WorkflowDefinition["ir"] = {
      version: "v1",
      name: "wf",
      nodes: [
        { id: "start", kind: "start" },
        { id: "n1", kind: "prompt", config: { name: "Implement", prompt: "do work" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "n1", condition: "success" },
        { from: "n1", to: "end", condition: "success" },
      ],
    };

    const { nodes, edges } = irToFlow(makeDef(ir));
    const { ir: out } = flowToIr("wf", nodes, edges);
    const n1 = out.nodes.find((n) => n.id === "n1");
    expect(n1?.config?.name).toBe("Implement");
  });

  it("persists a user-entered label as the node name", () => {
    const ir: WorkflowDefinition["ir"] = {
      version: "v1",
      name: "wf",
      nodes: [
        { id: "start", kind: "start" },
        { id: "n1", kind: "prompt", config: { prompt: "do work" } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "n1", condition: "success" },
        { from: "n1", to: "end", condition: "success" },
      ],
    };

    const { nodes, edges } = irToFlow(makeDef(ir));
    // Simulate the editor renaming the node via its label input.
    const renamed = nodes.map((n) =>
      n.id === "n1" ? { ...n, data: { ...n.data, label: "Build feature" } } : n,
    );
    const { ir: out } = flowToIr("wf", renamed, edges);
    const n1 = out.nodes.find((n) => n.id === "n1");
    expect(n1?.config?.name).toBe("Build feature");
  });
});
