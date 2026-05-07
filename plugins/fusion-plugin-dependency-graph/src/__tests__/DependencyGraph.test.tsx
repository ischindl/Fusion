import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { DependencyGraph } from "../DependencyGraph";

const fitToGraph = vi.fn();

vi.mock("@fusion/dashboard/app/components/TaskCard", () => ({
  TaskCard: ({ task, onOpenDetail }: { task: Task; onOpenDetail: () => void }) => (
    <button data-testid={`task-${task.id}`} onClick={onOpenDetail}>{task.id}</button>
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

  it("renders positioned nodes and edges for included tasks", () => {
    render(<DependencyGraph tasks={[
      createTask("A", "todo"),
      createTask("B", "in-progress", ["A"]),
    ]} onOpenTaskDetail={vi.fn()} />);

    expect(screen.getByTestId("task-A")).toBeTruthy();
    expect(screen.getByTestId("task-B")).toBeTruthy();
    expect(screen.getAllByTestId("dependency-edge")).toHaveLength(1);
  });

  it("excludes done and archived nodes", () => {
    render(<DependencyGraph tasks={[
      createTask("A", "todo"),
      createTask("B", "done"),
      createTask("C", "archived"),
    ]} onOpenTaskDetail={vi.fn()} />);

    expect(screen.getByTestId("task-A")).toBeTruthy();
    expect(screen.queryByTestId("task-B")).toBeNull();
    expect(screen.queryByTestId("task-C")).toBeNull();
  });

  it("fit-to-screen button triggers fitToGraph", () => {
    render(<DependencyGraph tasks={[createTask("A", "todo")]} onOpenTaskDetail={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Fit to screen" }));
    expect(fitToGraph).toHaveBeenCalled();
  });
});
