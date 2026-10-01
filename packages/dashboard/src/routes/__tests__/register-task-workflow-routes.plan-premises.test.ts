// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { Task, TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

const IR = {
  version: "v2", id: "premise-route", name: "Premise route",
  columns: [
    { id: "planning", name: "Planning", traits: [{ trait: "hold", config: { release: "manual" } }] },
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
  ], nodes: [], edges: [],
};

describe("POST /tasks/:id/move plan-premise admission", () => {
  it("fails closed before allocation or movement when workflow resolution is unavailable", async () => {
    const task = {
      id: "FN-375-U", title: "unavailable", description: "unavailable", column: "planning", status: null,
      dependencies: [], steps: [], currentStep: 0, log: [],
      prompt: '# Planned\n\n## Plan Premises\n\n- {"kind":"file-exists","path":"package.json"}\n',
    } as Task;
    const moveTask = vi.fn();
    const moveTaskIf = vi.fn();
    const getSettings = vi.fn(async () => ({}));
    const store = {
      getRootDir: () => process.cwd(),
      getProjectScopedPluginMcpServers: vi.fn(async () => []),
      getTask: vi.fn(async () => task),
      getSettings,
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "premise-route", stepIds: [] })),
      getWorkflowDefinition: vi.fn(async () => { throw new Error("workflow store unavailable"); }),
      moveTask,
      moveTaskIf,
    } as unknown as TaskStore;
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    const response = await REQUEST(app, "POST", `/api/tasks/${task.id}/move`, JSON.stringify({ column: "in-progress", expectedColumn: "planning" }), { "content-type": "application/json" });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ details: { code: "workflow-resolution-unavailable", retryable: true } });
    expect(task).toMatchObject({ column: "planning", status: null });
    expect(getSettings).not.toHaveBeenCalled();
    expect(moveTask).not.toHaveBeenCalled();
    expect(moveTaskIf).not.toHaveBeenCalled();
  });

  it("keeps a stale plan in planning and never allocates or moves", async () => {
    const task = {
      id: "FN-375-R", title: "stale", description: "stale", column: "planning", status: null,
      dependencies: [], steps: [], currentStep: 0, log: [],
      prompt: '# Planned\n\n## Plan Premises\n\n- {"kind":"text-present","path":"package.json","literal":"alphaUpdatesEnabled"}\n',
    } as Task;
    const moveTask = vi.fn();
    const moveTaskIf = vi.fn();
    const logEntry = vi.fn(async (_id: string, message: string) => task.log.push({ timestamp: new Date().toISOString(), message } as never));
    const store = {
      getRootDir: () => process.cwd(),
      getProjectScopedPluginMcpServers: vi.fn(async () => []),
      getTask: vi.fn(async () => task),
      getSettings: vi.fn(async () => ({})),
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "premise-route", stepIds: [] })),
      getWorkflowDefinition: vi.fn(async () => ({ id: "premise-route", ir: IR })),
      getActivePrEntityBySource: vi.fn(async () => null),
      updateTaskAtomic: vi.fn(async (_id: string, mutate: (live: Task) => Partial<Task> | null | Promise<Partial<Task> | null>) => {
        const patch = await mutate(task);
        if (patch) {
          // Mirror the real store's key-preserving sourceMetadataPatch merge (RUFU-246) so the
          // refusal episode persists across gate calls exactly like production.
          const { sourceMetadataPatch, ...rest } = patch as Record<string, unknown> & { sourceMetadataPatch?: Record<string, unknown> };
          if (sourceMetadataPatch) task.sourceMetadata = { ...(task.sourceMetadata ?? {}), ...sourceMetadataPatch };
          Object.assign(task, rest);
        }
        return task;
      }),
      logEntry,
      moveTask,
      moveTaskIf,
    } as unknown as TaskStore;
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    const response = await REQUEST(app, "POST", `/api/tasks/${task.id}/move`, JSON.stringify({ column: "building", expectedColumn: "planning" }), { "content-type": "application/json" });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ details: { code: "plan-premise-stale", retryable: false } });
    /*
    FNXC:PlanPremises 2026-09-16-03:20:
    RUFU-246 ladder: this is the card's FIRST identical refusal, so the card is held with a
    durable episode — no status change here. Only a second identical refusal (same rejection
    identity) would set needs-replan; a third parks failed with the exhaustion sentinel.
    */
    expect(task).toMatchObject({ column: "planning", status: null });
    expect(task.sourceMetadata?.planPremiseRejection).toMatchObject({ refusalCount: 1, escalation: "hold", lastDetail: expect.stringContaining("alphaUpdatesEnabled") });
    expect(logEntry).toHaveBeenCalledWith(task.id, expect.stringContaining("alphaUpdatesEnabled"));
    expect(moveTask).not.toHaveBeenCalled();
    expect(moveTaskIf).not.toHaveBeenCalled();
  });

  /*
  FNXC:PlanPremises 2026-09-16-04:08:
  RUFU-246 Step 4 — a terminally parked card is refused at the manual-move door with the distinct
  non-retryable `plan-premise-exhausted` code, and the refusal is refuse-to-touch: no premise
  re-evaluation, no store write, no episode mutation. The sanctioned lift is Retry, not re-pushing
  the move button.
  */
  it("refuses a manually moved parked card without re-evaluating or mutating the park", async () => {
    const parkDetail = '{"kind":"text-present","path":"package.json","literal":"alphaUpdatesEnabled"} — literal not found in file';
    const task = {
      id: "FN-375-P", title: "parked", description: "parked", column: "planning", status: "failed",
      error: `PLAN PREMISE CONTRACT EXHAUSTED: ${parkDetail} — the same plan premises were refused three times in a row; rewrite the plan against the current code or delete this card.`,
      dependencies: [], steps: [], currentStep: 0, log: [],
      sourceMetadata: { planPremiseRejection: { signature: "sig", refusalCount: 3, lastDetail: parkDetail, lastAt: new Date().toISOString(), escalation: "park", detailHash: "0000000000000000000000000000000000000000000000000000000000000000" } },
      prompt: '# Planned\n\n## Plan Premises\n\n- {"kind":"text-present","path":"package.json","literal":"alphaUpdatesEnabled"}\n',
    } as unknown as Task;
    const moveTask = vi.fn();
    const moveTaskIf = vi.fn();
    const updateTaskAtomic = vi.fn();
    const store = {
      getRootDir: () => process.cwd(),
      getProjectScopedPluginMcpServers: vi.fn(async () => []),
      getTask: vi.fn(async () => task),
      getSettings: vi.fn(async () => ({})),
      getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "premise-route", stepIds: [] })),
      getWorkflowDefinition: vi.fn(async () => ({ id: "premise-route", ir: IR })),
      getActivePrEntityBySource: vi.fn(async () => null),
      updateTaskAtomic,
      logEntry: vi.fn(),
      moveTask,
      moveTaskIf,
    } as unknown as TaskStore;
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));

    const response = await REQUEST(app, "POST", `/api/tasks/${task.id}/move`, JSON.stringify({ column: "building", expectedColumn: "planning" }), { "content-type": "application/json" });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ details: { code: "plan-premise-exhausted", retryable: false } });
    expect(typeof response.body.error).toBe("string");
    expect(String(response.body.error)).toContain("EXHAUSTED");
    // Refuse-to-touch: the terminal park row survives byte-identical, and nothing was written.
    expect(task).toMatchObject({ column: "planning", status: "failed" });
    expect(task.sourceMetadata?.planPremiseRejection).toMatchObject({ refusalCount: 3, escalation: "park" });
    expect(updateTaskAtomic).not.toHaveBeenCalled();
    expect(moveTask).not.toHaveBeenCalled();
    expect(moveTaskIf).not.toHaveBeenCalled();
  });
});
