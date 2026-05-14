import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { TodoAgingSummary } from "../TodoAgingSummary";

const createTask = (overrides: Partial<Task> = {}): Task =>
  ({
    id: "FN-001",
    description: "Test task",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    columnMovedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }) as Task;

describe("TodoAgingSummary", () => {
  it("renders three chips with bucket counts", () => {
    const now = new Date("2026-04-04T12:00:00Z").getTime();
    const tasks = [
      createTask({ id: "FN-1", columnMovedAt: new Date(now - 1000).toISOString() }),
      createTask({ id: "FN-2", columnMovedAt: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString() }),
      createTask({ id: "FN-3", columnMovedAt: new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString() }),
    ];

    render(<TodoAgingSummary tasks={tasks} activeBucket={null} onSelectBucket={() => undefined} dataAsOfMs={now} />);

    expect(screen.getByTestId("todo-aging-chip-fresh")).toHaveTextContent("0–7d1");
    expect(screen.getByTestId("todo-aging-chip-aging")).toHaveTextContent("8–30d1");
    expect(screen.getByTestId("todo-aging-chip-stale")).toHaveTextContent("31+d1");
  });

  it("returns null when there are zero todo tasks", () => {
    const { container } = render(
      <TodoAgingSummary
        tasks={[createTask({ column: "done" })]}
        activeBucket={null}
        onSelectBucket={() => undefined}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("clicking chips toggles bucket selection", () => {
    const onSelectBucket = vi.fn();
    const now = Date.now();
    const tasks = [createTask({ columnMovedAt: new Date(now - 35 * 24 * 60 * 60 * 1000).toISOString() })];

    render(<TodoAgingSummary tasks={tasks} activeBucket={"stale"} onSelectBucket={onSelectBucket} dataAsOfMs={now} />);

    fireEvent.click(screen.getByTestId("todo-aging-chip-aging"));
    expect(onSelectBucket).toHaveBeenCalledWith("aging");

    fireEvent.click(screen.getByTestId("todo-aging-chip-stale"));
    expect(onSelectBucket).toHaveBeenCalledWith(null);
  });

  it("sets aria-pressed based on active bucket", () => {
    const now = Date.now();
    const tasks = [createTask({ columnMovedAt: new Date(now - 35 * 24 * 60 * 60 * 1000).toISOString() })];

    render(<TodoAgingSummary tasks={tasks} activeBucket={"stale"} onSelectBucket={() => undefined} dataAsOfMs={now} />);

    expect(screen.getByTestId("todo-aging-chip-fresh")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("todo-aging-chip-aging")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("todo-aging-chip-stale")).toHaveAttribute("aria-pressed", "true");
  });
});
