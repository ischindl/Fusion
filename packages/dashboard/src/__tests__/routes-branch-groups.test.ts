// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { BranchGroup, Task, TaskStore } from "@fusion/core";
import { evaluateBranchGroupCompletion } from "@fusion/engine";
import { createApiRoutes } from "../routes.js";
import { request as REQUEST } from "../test-request.js";

function buildTask(id: string, groupId: string, landed: boolean): Task {
  return {
    id,
    description: id,
    column: landed ? "done" : "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    branchContext: { groupId, source: "planning", assignmentMode: "shared" },
    mergeDetails: landed
      ? { mergeConfirmed: true, mergeTargetSource: "branch-group-integration", mergeTargetBranch: "feature/shared" }
      : undefined,
  } as Task;
}

function createStore(group: BranchGroup, tasks: Task[]): TaskStore {
  return {
    getRootDir: vi.fn(() => "/tmp/project"),
    listBranchGroups: vi.fn(() => [group]),
    getBranchGroup: vi.fn((id: string) => (id === group.id ? group : null)),
    listTasksByBranchGroup: vi.fn(async () => tasks),
    setTaskBranchGroup: vi.fn(async () => {}),
    ensureBranchGroupForSource: vi.fn(() => group),
    getTask: vi.fn(async (id: string) => tasks.find((task) => task.id === id) ?? buildTask(id, group.id, false)),
  } as unknown as TaskStore;
}

function buildApp(store: TaskStore, promoteBranchGroup?: ReturnType<typeof vi.fn>) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store, { engine: { promoteBranchGroup } as any }));
  return app;
}

describe("branch group routes", () => {
  let group: BranchGroup;
  let tasks: Task[];

  beforeEach(() => {
    group = {
      id: "BG-1",
      sourceType: "planning",
      sourceId: "PS-1",
      branchName: "feature/shared",
      autoMerge: false,
      prState: "open",
      prNumber: 101,
      prUrl: "https://example/pr/101",
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    tasks = [buildTask("FN-1", group.id, true), buildTask("FN-2", group.id, false)];
  });

  it("lists and shows groups with completion + PR fields", async () => {
    const app = buildApp(createStore(group, tasks));
    const listRes = await REQUEST(app, "GET", "/api/branch-groups");
    expect(listRes.status).toBe(200);
    expect(listRes.body.groups[0].completion).toEqual({ landed: 1, total: 2, complete: false });
    expect(listRes.body.groups[0].prNumber).toBe(101);

    const showRes = await REQUEST(app, "GET", "/api/branch-groups/BG-1");
    expect(showRes.status).toBe(200);
    expect(showRes.body.group.members).toHaveLength(2);
    expect(showRes.body.group.members[0]).toHaveProperty("landed");
  });

  it("returns 404 for unknown group", async () => {
    const app = buildApp(createStore(group, tasks));
    const res = await REQUEST(app, "GET", "/api/branch-groups/BG-404");
    expect(res.status).toBe(404);
  });

  it("assigns and detaches grouped task", async () => {
    const store = createStore(group, tasks);
    const app = buildApp(store);

    let res = await REQUEST(app, "POST", "/api/branch-groups/assign", JSON.stringify({ taskId: "FN-1", groupId: "BG-1" }), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect((store.setTaskBranchGroup as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("FN-1", "BG-1");

    res = await REQUEST(app, "POST", "/api/branch-groups/assign", JSON.stringify({ taskId: "FN-1", groupId: null }), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect((store.setTaskBranchGroup as unknown as ReturnType<typeof vi.fn>)).toHaveBeenLastCalledWith("FN-1", null);
  });

  it("promotes completed groups and rejects incomplete groups", async () => {
    const promoteBranchGroup = vi.fn(async () => ({ prNumber: 202, prUrl: "https://example/pr/202", prState: "open", status: "open" }));
    const completeTasks = [buildTask("FN-1", group.id, true), buildTask("FN-2", group.id, true)];
    let app = buildApp(createStore(group, completeTasks), promoteBranchGroup);
    let res = await REQUEST(app, "POST", "/api/branch-groups/BG-1/promote", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect(promoteBranchGroup).toHaveBeenCalledWith("BG-1");
    expect(res.body.prNumber).toBe(202);

    app = buildApp(createStore(group, tasks), promoteBranchGroup);
    res = await REQUEST(app, "POST", "/api/branch-groups/BG-1/promote", JSON.stringify({}), { "content-type": "application/json" });
    expect(res.status).toBe(400);
  });

  it("route serialization and coordinator agree on landed/complete for the same fixture", async () => {
    // Same fixture exercised through BOTH paths must yield identical results.
    const completeTasks = [buildTask("FN-1", group.id, true), buildTask("FN-2", group.id, true)];
    const mixedTasks = [buildTask("FN-1", group.id, true), buildTask("FN-2", group.id, false)];

    // Coordinator path.
    const completeCoord = evaluateBranchGroupCompletion({ members: completeTasks, group });
    const mixedCoord = evaluateBranchGroupCompletion({ members: mixedTasks, group });
    expect(completeCoord.complete).toBe(true);
    expect(mixedCoord.complete).toBe(false);

    // Route serialization path.
    const completeApp = buildApp(createStore(group, completeTasks));
    const completeRes = await REQUEST(completeApp, "GET", "/api/branch-groups/BG-1");
    expect(completeRes.body.group.completion.complete).toBe(true);

    const mixedApp = buildApp(createStore(group, mixedTasks));
    const mixedRes = await REQUEST(mixedApp, "GET", "/api/branch-groups/BG-1");
    expect(mixedRes.body.group.completion.complete).toBe(false);

    // No divergence between the two gates.
    expect(completeRes.body.group.completion.complete).toBe(completeCoord.complete);
    expect(mixedRes.body.group.completion.complete).toBe(mixedCoord.complete);
  });

  it("creates group on assign when groupId absent", async () => {
    const store = createStore(group, tasks);
    const app = buildApp(store);
    const res = await REQUEST(app, "POST", "/api/branch-groups/assign", JSON.stringify({ taskId: "FN-99", branchName: "feature/cli-onboarding" }), { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect((store.ensureBranchGroupForSource as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});
