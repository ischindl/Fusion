import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { DependencyGraph } from "../DependencyGraph";

const fitToGraph = vi.fn();

vi.mock("@fusion/dashboard/app/components/TaskCard", () => ({
  TaskCard: ({ task, onOpenDetail, disableDrag }: { task: Task; onOpenDetail: (task: Task) => void; disableDrag?: boolean }) => (
    <button data-testid={`task-${task.id}`} draggable={!disableDrag} onClick={() => onOpenDetail(task)}>{task.id}</button>
  ),
}));

vi.mock("../useGraphInteraction", () => ({
  useGraphInteraction: () => ({
    transform: "translate(0px, 0px) scale(1)",
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    fitToGraph,
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(),
    onWheelZoom: vi.fn(),
  }),
}));

function createTask(id: string, column: Task["column"], dependencies: string[] = []): Task {
  return { id, description: id, column, dependencies, steps: [], currentStep: 0, log: [] } as Task;
}

describe("DependencyGraph", () => {
  beforeEach(() => {
    fitToGraph.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders empty state for empty list", () => {
    render(<DependencyGraph tasks={[]} onOpenTaskDetail={vi.fn()} />);
    expect(screen.getByText(/No active tasks/i)).toBeTruthy();
  });

  it("renders graph task nodes at layout coordinates and edges", () => {
    const { container } = render(<DependencyGraph tasks={[
      createTask("A", "todo"),
      createTask("B", "in-progress", ["A"]),
    ]} onOpenTaskDetail={vi.fn()} />);

    expect(screen.getByTestId("graph-task-node-A")).toBeTruthy();
    expect(screen.getByTestId("graph-task-node-B")).toBeTruthy();
    expect(container.querySelector(".dependency-graph__nodes-layer")).toBeTruthy();
    expect(screen.getAllByTestId("dependency-edge")).toHaveLength(1);

    const nodeAStyle = screen.getByTestId("graph-task-node-A").getAttribute("style") ?? "";
    const nodeBStyle = screen.getByTestId("graph-task-node-B").getAttribute("style") ?? "";
    expect(nodeAStyle).toContain("left:");
    expect(nodeAStyle).toContain("top:");
    expect(nodeBStyle).toContain("left:");
    expect(nodeBStyle).toContain("top:");
  });

  it("excludes done and archived nodes", () => {
    render(<DependencyGraph tasks={[
      createTask("A", "todo"),
      createTask("B", "done"),
      createTask("C", "archived"),
    ]} onOpenTaskDetail={vi.fn()} />);

    expect(screen.getByTestId("graph-task-node-A")).toBeTruthy();
    expect(screen.queryByTestId("graph-task-node-B")).toBeNull();
    expect(screen.queryByTestId("graph-task-node-C")).toBeNull();
  });

  it("renders embedded cards with native dragging disabled", () => {
    render(<DependencyGraph tasks={[createTask("A", "in-progress")]} onOpenTaskDetail={vi.fn()} />);
    expect(screen.getByTestId("task-A").getAttribute("draggable")).toBe("false");
  });

  it("clicking a card triggers onOpenDetail", () => {
    const onOpenDetail = vi.fn();
    render(<DependencyGraph tasks={[createTask("A", "in-progress")]} onOpenDetail={onOpenDetail} />);
    fireEvent.click(screen.getByTestId("task-A"));
    expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({ id: "A" }));
  });

  it("fit-to-screen button triggers fitToGraph", () => {
    render(<DependencyGraph tasks={[createTask("A", "todo")]} onOpenTaskDetail={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Fit to screen" }));
    expect(fitToGraph).toHaveBeenCalled();
  });
});
