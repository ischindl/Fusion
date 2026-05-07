import type { Task } from "@fusion/core";

const INCLUDED_COLUMNS = new Set<Task["column"]>(["triage", "todo", "in-progress", "in-review"]);

export function filterGraphTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => INCLUDED_COLUMNS.has(task.column));
}
