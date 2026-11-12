// @vitest-environment node

/*
FNXC:PromptWriteIntegrity 2026-11-11-23:58 (RUFU-534):
The shrink guard binds agents, not humans: a person who deliberately shortens a plan keeps that power, and
`PATCH /tasks/:id` is the board's sanctioned operator prompt-edit transport. This is the live tripwire for
that authorization arm - it sends a materially shorter prompt and asserts both that the write succeeds and
that `updateTask` received `promptShrinkAuthorized`. Delete the arm in
`register-task-workflow-routes.ts` and this test goes red, which is the point: an authorization nobody
tests is an authorization that silently disappears at the next refactor.
*/
import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

const TASK_ID = "FN-001";

function createHarness() {
  const task = {
    id: TASK_ID,
    description: "card with a long accepted spec",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  } as any;
  const updateTask = vi.fn(async (_id: string, updates: Record<string, unknown>) => ({ ...task, ...updates }));
  const store = {
    getRootDir: vi.fn(() => process.cwd()),
    getProjectScopedPluginMcpServers: vi.fn(async () => []),
    getTask: vi.fn(async () => task),
    updateTask,
  } as unknown as TaskStore;
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return { app, updateTask };
}

describe("operator prompt edit through PATCH /tasks/:id", () => {
  it("authorizes a deliberately shorter operator spec on the route that carries human intent", async () => {
    const { app, updateTask } = createHarness();
    const shorter = "# Deliberately slimmed plan\n\n## Mission\n\nCut back to the essentials.\n";

    const response = await REQUEST(
      app,
      "PATCH",
      `/api/tasks/${TASK_ID}`,
      JSON.stringify({ prompt: shorter }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(updateTask).toHaveBeenCalled();
    const sent = updateTask.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(sent.prompt).toBe(shorter);
    // The authorization must travel with the prompt, or the store seam refuses the operator's own edit.
    expect(sent.promptShrinkAuthorized).toBe(true);
  });
});
