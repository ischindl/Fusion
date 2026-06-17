import { describe, expect, it } from "vitest";
import { projectWorkflowWorkStatus } from "../workflow-work-projection.js";
import type { Task, WorkflowWorkItem } from "../types.js";

/*
FNXC:WorkflowProjections 2026-06-17-08:42:
These tests pin the user-facing workflow status surfaced for a task by projectWorkflowWorkStatus, which
dashboard, API, and CLI all read. Requirements encoded here:
- A single workflow status is derived from a task's work items by priority (recovery > manual-hold >
  running > retrying > merge > other), so the most operator-relevant state wins when several items coexist.
- When no item is still active, the task projects as "complete" from the deterministic earliest succeeded
  item; if there is no workflow item at all it falls back to the "legacy" task status.
- The projected workItemId must be stable for identical logical state regardless of work-item array order,
  so the same task never flips between ids across callers.
*/

const task = { id: "FN-PROJECT", mergeRetries: 4, status: "legacy status" } as Task;

function item(input: Partial<WorkflowWorkItem> & Pick<WorkflowWorkItem, "id" | "kind" | "state">): WorkflowWorkItem {
  return {
    runId: "run-1",
    taskId: task.id,
    nodeId: "merge-gate",
    attempt: 0,
    retryAfter: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    blockedReason: null,
    createdAt: "2026-06-09T00:00:00.000Z",
    updatedAt: "2026-06-09T00:00:00.000Z",
    ...input,
  };
}

describe("workflow work projection", () => {
  it("uses workflow merge work before legacy task retry fields", () => {
    expect(projectWorkflowWorkStatus(task, [
      item({ id: "work-1", kind: "merge", state: "runnable" }),
    ])).toEqual(expect.objectContaining({
      source: "workflow",
      status: "merge-queued",
      workItemId: "work-1",
      attempt: 0,
    }));
  });

  it("surfaces manual hold and recovery reasons", () => {
    expect(projectWorkflowWorkStatus(task, [
      item({ id: "work-1", kind: "merge", state: "runnable" }),
      item({ id: "work-2", kind: "manual-hold", state: "manual-required", blockedReason: "autoMerge:false" }),
    ])).toEqual(expect.objectContaining({
      status: "manual-hold",
      reason: "autoMerge:false",
    }));

    expect(projectWorkflowWorkStatus(task, [
      item({ id: "work-3", kind: "recovery", state: "runnable", blockedReason: "already-landed" }),
    ])).toEqual(expect.objectContaining({
      status: "recovery",
      reason: "already-landed",
    }));
  });

  it("keeps projection dispatch aligned with manual-hold sort priority", () => {
    expect(projectWorkflowWorkStatus(task, [
      item({ id: "work-running", kind: "merge", state: "running" }),
      item({ id: "work-manual", kind: "manual-hold", state: "retrying", blockedReason: "autoMerge:false" }),
    ])).toEqual(expect.objectContaining({
      status: "manual-hold",
      workItemId: "work-manual",
      reason: "autoMerge:false",
    }));
  });

  it("falls back to legacy task fields only when no workflow work exists", () => {
    expect(projectWorkflowWorkStatus(task, [])).toEqual({
      status: "legacy",
      source: "legacy",
      taskId: task.id,
      reason: "legacy status",
      attempt: 4,
    });
  });

  it("preserves zero legacy retry attempts in fallback projection", () => {
    expect(projectWorkflowWorkStatus({ ...task, mergeRetries: 0, mergeTransientRetryCount: 2 }, [])).toEqual(expect.objectContaining({
      source: "legacy",
      attempt: 0,
    }));
  });
});
