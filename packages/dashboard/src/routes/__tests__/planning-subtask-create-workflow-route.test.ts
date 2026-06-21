// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "@fusion/core";
import type { WorkflowIr } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

type PlanningSession = {
  summary: {
    title: string;
    description: string;
    suggestedSize: "S" | "M" | "L";
    priority: "normal";
    suggestedDependencies: string[];
    keyDeliverables: string[];
  };
  initialPlan: string;
  history: Array<{ role: string; content: string }>;
};

type SubtaskSession = {
  initialDescription: string;
  autoMerge?: boolean;
};

const planningSessions = new Map<string, PlanningSession>();
const subtaskSessions = new Map<string, SubtaskSession>();

vi.mock("../../planning.js", () => ({
  getSession: (id: string) => planningSessions.get(id),
  getSummary: (id: string) => planningSessions.get(id)?.summary,
  releaseSession: vi.fn(),
  cleanupSession: vi.fn(),
  formatInterviewQA: vi.fn(() => ""),
  mergePlanningSubtaskDrafts: vi.fn((_sessionId: string, subtasks: unknown[]) => subtasks),
}));

vi.mock("../../subtask-breakdown.js", () => ({
  getSubtaskSession: (id: string) => subtaskSessions.get(id),
  cleanupSubtaskSession: vi.fn(),
}));

function linearIr(name: string): WorkflowIr {
  return {
    version: "v1",
    name,
    nodes: [
      { id: "start", kind: "start" },
      { id: "lint", kind: "gate", config: { name: "Lint", scriptName: "lint" } },
      { id: "spec", kind: "prompt", config: { name: "Spec", prompt: "check" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "lint", condition: "success" },
      { from: "lint", to: "spec", condition: "success" },
      { from: "spec", to: "end", condition: "success" },
    ],
  };
}

function seedPlanningSession(id: string, title = "Planned task"): void {
  planningSessions.set(id, {
    summary: {
      title,
      description: `${title} description`,
      suggestedSize: "M",
      priority: "normal",
      suggestedDependencies: [],
      keyDeliverables: [],
    },
    initialPlan: title,
    history: [],
  });
}

describe("planning and subtask create routes workflowId", () => {
  let store: TaskStore;
  let rootDir: string;
  let globalDir: string;
  let app: express.Express;

  beforeEach(async () => {
    planningSessions.clear();
    subtaskSessions.clear();
    rootDir = mkdtempSync(join(tmpdir(), "planning-subtask-wf-root-"));
    globalDir = mkdtempSync(join(tmpdir(), "planning-subtask-wf-global-"));
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();

    app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
  });

  afterEach(() => {
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown) =>
    REQUEST(app, "POST", path, JSON.stringify(body), { "content-type": "application/json" });

  it("POST /planning/create-task assigns the supplied workflowId", async () => {
    const wf = await store.createWorkflowDefinition({ name: "Planning QA", ir: linearIr("planning-qa") });
    seedPlanningSession("plan-single", "Single planning task");

    const res = await post("/api/planning/create-task", { sessionId: "plan-single", workflowId: wf.id });

    expect(res.status).toBe(201);
    expect(store.getTaskWorkflowSelection((res.body as { id: string }).id)?.workflowId).toBe(wf.id);
  });

  it("POST /planning/create-tasks assigns the supplied workflowId to every created task", async () => {
    const wf = await store.createWorkflowDefinition({ name: "Planning multi QA", ir: linearIr("planning-multi-qa") });
    seedPlanningSession("plan-multi", "Multi planning task");

    const res = await post("/api/planning/create-tasks", {
      planningSessionId: "plan-multi",
      workflowId: wf.id,
      subtasks: [
        { id: "tmp-1", title: "First child", description: "First child description" },
        { id: "tmp-2", title: "Second child", description: "Second child description" },
      ],
    });

    expect(res.status).toBe(201);
    const tasks = (res.body as { tasks: Array<{ id: string }> }).tasks;
    expect(tasks).toHaveLength(2);
    expect(tasks.map((task) => store.getTaskWorkflowSelection(task.id)?.workflowId)).toEqual([wf.id, wf.id]);
  });

  it("POST /subtasks/create-tasks assigns the supplied workflowId to every created child", async () => {
    const wf = await store.createWorkflowDefinition({ name: "Subtask QA", ir: linearIr("subtask-qa") });
    subtaskSessions.set("subtask-session", { initialDescription: "Break this down" });

    const res = await post("/api/subtasks/create-tasks", {
      sessionId: "subtask-session",
      workflowId: wf.id,
      subtasks: [
        { tempId: "tmp-1", title: "First split", description: "First split description" },
        { tempId: "tmp-2", title: "Second split", description: "Second split description" },
      ],
    });

    expect(res.status).toBe(201);
    const tasks = (res.body as { tasks: Array<{ id: string }> }).tasks;
    expect(tasks).toHaveLength(2);
    expect(tasks.map((task) => store.getTaskWorkflowSelection(task.id)?.workflowId)).toEqual([wf.id, wf.id]);
  });

  it("omitting workflowId preserves default-workflow inheritance", async () => {
    const wf = await store.createWorkflowDefinition({ name: "Default QA", ir: linearIr("default-qa") });
    await store.setDefaultWorkflowId(wf.id);
    seedPlanningSession("plan-default", "Default inherited task");

    const res = await post("/api/planning/create-task", { sessionId: "plan-default" });

    expect(res.status).toBe(201);
    expect(store.getTaskWorkflowSelection((res.body as { id: string }).id)?.workflowId).toBe(wf.id);
  });

  it("unknown workflowId returns a 4xx instead of a 500 for all create routes", async () => {
    seedPlanningSession("plan-bad-single", "Bad single");
    seedPlanningSession("plan-bad-multi", "Bad multi");
    subtaskSessions.set("subtask-bad", { initialDescription: "Bad subtask" });

    const requests = [
      post("/api/planning/create-task", { sessionId: "plan-bad-single", workflowId: "WF-404" }),
      post("/api/planning/create-tasks", {
        planningSessionId: "plan-bad-multi",
        workflowId: "WF-404",
        subtasks: [{ id: "tmp-1", title: "Bad child", description: "Bad child description" }],
      }),
      post("/api/subtasks/create-tasks", {
        sessionId: "subtask-bad",
        workflowId: "WF-404",
        subtasks: [{ tempId: "tmp-1", title: "Bad split", description: "Bad split description" }],
      }),
    ];

    for (const res of await Promise.all(requests)) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
  });
});
