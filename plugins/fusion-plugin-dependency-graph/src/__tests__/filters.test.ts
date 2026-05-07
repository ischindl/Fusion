import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { filterGraphTasks } from "../filters";

function createTask(id: string, column: Task["column"], dependencies: string[] = []): Task {
  return {
    id,
    description: `Task ${id}`,
    column,
    dependencies,
    steps: [],
    currentStep: 0,
    log: [],
  } as Task;
}

describe("filterGraphTasks", () => {
  it("returns empty for empty input", () => {
    expect(filterGraphTasks([])).toEqual([]);
  });

  it("includes triage/todo/in-progress/in-review and excludes done/archived", () => {
    const tasks = [
      createTask("FN-1", "triage"),
      createTask("FN-2", "todo"),
      createTask("FN-3", "in-progress"),
      createTask("FN-4", "in-review"),
      createTask("FN-5", "done"),
      createTask("FN-6", "archived"),
    ];

    expect(filterGraphTasks(tasks).map((task) => task.id)).toEqual(["FN-1", "FN-2", "FN-3", "FN-4"]);
  });

  it("returns empty when only excluded columns are present", () => {
    const tasks = [createTask("FN-1", "done"), createTask("FN-2", "archived")];

    expect(filterGraphTasks(tasks)).toEqual([]);
  });

  it("keeps included tasks even when dependencies reference excluded tasks", () => {
    const tasks = [
      createTask("FN-1", "done"),
      createTask("FN-2", "todo", ["FN-1"]),
      createTask("FN-3", "in-review", ["FN-2", "FN-1"]),
      createTask("FN-4", "archived", ["FN-2"]),
    ];

    expect(filterGraphTasks(tasks).map((task) => task.id)).toEqual(["FN-2", "FN-3"]);
  });
});
