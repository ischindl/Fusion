import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { useGraphData } from "../useGraphData";

function createTask(id: string, dependencies: string[] = []): Task {
  return {
    id,
    description: id,
    column: "todo",
    dependencies,
    steps: [],
    currentStep: 0,
    log: [],
  } as Task;
}

describe("useGraphData", () => {
  it("returns empty graph for empty tasks", () => {
    const { result } = renderHook(() => useGraphData([]));
    expect(result.current).toEqual({ nodes: [], edges: [] });
  });

  it("creates node for single task with no deps", () => {
    const { result } = renderHook(() => useGraphData([createTask("A")]));
    expect(result.current.nodes.map((node) => node.task.id)).toEqual(["A"]);
    expect(result.current.edges).toEqual([]);
  });

  it("creates edges in dependent-to-dependency direction for chain", () => {
    const tasks = [createTask("A", ["B"]), createTask("B", ["C"]), createTask("C")];
    const { result } = renderHook(() => useGraphData(tasks));
    expect(result.current.edges).toEqual([
      { source: "A", target: "B" },
      { source: "B", target: "C" },
    ]);
  });

  it("creates diamond dependency edges", () => {
    const tasks = [
      createTask("A", ["B", "C"]),
      createTask("B", ["D"]),
      createTask("C", ["D"]),
      createTask("D"),
    ];
    const { result } = renderHook(() => useGraphData(tasks));
    expect(result.current.edges).toEqual([
      { source: "A", target: "B" },
      { source: "A", target: "C" },
      { source: "B", target: "D" },
      { source: "C", target: "D" },
    ]);
  });

  it("drops orphan dependency references", () => {
    const { result } = renderHook(() => useGraphData([createTask("A", ["Z"]), createTask("B", ["A"])]));
    expect(result.current.edges).toEqual([{ source: "B", target: "A" }]);
  });

  it("supports disconnected subgraphs", () => {
    const tasks = [createTask("A", ["B"]), createTask("B"), createTask("X", ["Y"]), createTask("Y")];
    const { result } = renderHook(() => useGraphData(tasks));
    expect(result.current.edges).toEqual([
      { source: "A", target: "B" },
      { source: "X", target: "Y" },
    ]);
  });
});
