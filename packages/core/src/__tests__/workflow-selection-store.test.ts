import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { WorkflowCompileError } from "../workflow-compiler.js";
import type { WorkflowIr } from "../workflow-ir-types.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

/** Linear workflow with two pre-merge steps. */
function linearIr(): WorkflowIr {
  return {
    version: "v1",
    name: "wf",
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

function branchingIr(): WorkflowIr {
  return {
    version: "v1",
    name: "branchy",
    nodes: [
      { id: "start", kind: "start" },
      { id: "a", kind: "prompt", config: { prompt: "a" } },
      { id: "b", kind: "prompt", config: { prompt: "b" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "a", condition: "success" },
      { from: "a", to: "b", condition: "success" },
      { from: "a", to: "end", condition: "success" },
      { from: "b", to: "end", condition: "success" },
    ],
  };
}

describe("TaskStore workflow selection (U3)", () => {
  const harness = createTaskStoreTestHarness();
  let store: ReturnType<typeof harness.store>;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("selecting a workflow populates enabledWorkflowSteps and records selection", async () => {
    const wf = await store.createWorkflowDefinition({ name: "QA", ir: linearIr() });
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });

    await store.selectTaskWorkflow(task.id, wf.id);

    const detail = await store.getTask(task.id);
    expect(detail.enabledWorkflowSteps).toHaveLength(2);
    const selection = store.getTaskWorkflowSelection(task.id);
    expect(selection?.workflowId).toBe(wf.id);
    expect(selection?.stepIds).toEqual(detail.enabledWorkflowSteps);
  });

  it("compiled steps are hidden from the user-facing step manager listing", async () => {
    const wf = await store.createWorkflowDefinition({ name: "QA", ir: linearIr() });
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
    await store.selectTaskWorkflow(task.id, wf.id);

    expect(await store.listWorkflowSteps()).toHaveLength(0);
    // …but the executor can still resolve them directly.
    const selection = store.getTaskWorkflowSelection(task.id)!;
    expect(await store.getWorkflowStep(selection.stepIds[0])).toBeDefined();
  });

  it("re-selecting replaces prior compiled steps without accumulating orphans", async () => {
    const wfA = await store.createWorkflowDefinition({ name: "A", ir: linearIr() });
    const wfB = await store.createWorkflowDefinition({ name: "B", ir: linearIr() });
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });

    await store.selectTaskWorkflow(task.id, wfA.id);
    const firstIds = store.getTaskWorkflowSelection(task.id)!.stepIds;
    await store.selectTaskWorkflow(task.id, wfB.id);
    const secondIds = store.getTaskWorkflowSelection(task.id)!.stepIds;

    // Old steps are gone, only the new selection's steps remain.
    for (const id of firstIds) {
      expect(await store.getWorkflowStep(id)).toBeUndefined();
    }
    const detail = await store.getTask(task.id);
    expect(detail.enabledWorkflowSteps).toEqual(secondIds);
  });

  it("clearing selection empties enabledWorkflowSteps", async () => {
    const wf = await store.createWorkflowDefinition({ name: "QA", ir: linearIr() });
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
    await store.selectTaskWorkflow(task.id, wf.id);

    await store.clearTaskWorkflowSelection(task.id);
    const detail = await store.getTask(task.id);
    expect(detail.enabledWorkflowSteps ?? []).toHaveLength(0);
    expect(store.getTaskWorkflowSelection(task.id)).toBeUndefined();
  });

  it("rejects selecting a non-linear workflow without writing partial state", async () => {
    const wf = await store.createWorkflowDefinition({ name: "Branchy", ir: branchingIr() });
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });

    await expect(store.selectTaskWorkflow(task.id, wf.id)).rejects.toBeInstanceOf(WorkflowCompileError);
    expect(store.getTaskWorkflowSelection(task.id)).toBeUndefined();
    const detail = await store.getTask(task.id);
    expect(detail.enabledWorkflowSteps ?? []).toHaveLength(0);
  });

  it("force-resurrecting over a tombstoned task purges its prior workflow selection", async () => {
    const wf = await store.createWorkflowDefinition({ name: "QA", ir: linearIr() });
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
    await store.selectTaskWorkflow(task.id, wf.id);
    const priorIds = store.getTaskWorkflowSelection(task.id)!.stepIds;
    expect(priorIds).toHaveLength(2);

    // Soft-delete then physically resurrect the same id; the physical purge of
    // the old tasks row must drop the orphaned selection + its compiled steps.
    await store.deleteTask(task.id);
    await store.createTaskWithReservedId(
      { description: "resurrected", enabledWorkflowSteps: [], forceResurrect: true },
      { taskId: task.id, applyDefaultWorkflowSteps: false },
    );

    expect(store.getTaskWorkflowSelection(task.id)).toBeUndefined();
    for (const id of priorIds) {
      expect(await store.getWorkflowStep(id)).toBeUndefined();
    }
  });

  it("throws when selecting an unknown workflow", async () => {
    const task = await store.createTask({ description: "T", enabledWorkflowSteps: [] });
    await expect(store.selectTaskWorkflow(task.id, "WF-404")).rejects.toThrow(/not found/i);
  });

  it("new tasks inherit the project default workflow", async () => {
    const wf = await store.createWorkflowDefinition({ name: "Default", ir: linearIr() });
    await store.setDefaultWorkflowId(wf.id);

    const task = await store.createTask({ description: "inherits" });
    const detail = await store.getTask(task.id);
    expect(detail.enabledWorkflowSteps).toHaveLength(2);
    expect(store.getTaskWorkflowSelection(task.id)?.workflowId).toBe(wf.id);
  });

  it("explicit enabledWorkflowSteps overrides the project default", async () => {
    const wf = await store.createWorkflowDefinition({ name: "Default", ir: linearIr() });
    await store.setDefaultWorkflowId(wf.id);

    const task = await store.createTask({ description: "override", enabledWorkflowSteps: [] });
    const detail = await store.getTask(task.id);
    expect(detail.enabledWorkflowSteps ?? []).toHaveLength(0);
    expect(store.getTaskWorkflowSelection(task.id)).toBeUndefined();
  });

  it("setDefaultWorkflowId rejects an unknown workflow and clears with null", async () => {
    await expect(store.setDefaultWorkflowId("WF-404")).rejects.toThrow(/not found/i);
    const wf = await store.createWorkflowDefinition({ name: "D", ir: linearIr() });
    await store.setDefaultWorkflowId(wf.id);
    expect(await store.getDefaultWorkflowId()).toBe(wf.id);
    await store.setDefaultWorkflowId(null);
    expect(await store.getDefaultWorkflowId()).toBeUndefined();
  });
});
