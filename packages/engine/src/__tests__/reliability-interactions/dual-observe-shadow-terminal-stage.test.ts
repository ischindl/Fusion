import { describe, expect, it } from "vitest";
import type { TaskDetail, WorkflowRunObservation } from "@fusion/core";
import {
  BUILTIN_CODING_WORKFLOW_IR,
  buildWorkflowObservationFromTask,
} from "@fusion/core";

import { TaskExecutor } from "../../executor.js";
import { WORKFLOW_INTERPRETER_DUAL_OBSERVE_FLAG } from "../../workflow-parity-observer.js";

// `buildShadowObservation` is private; exercise it via the prototype with a
// minimal `this` that only supplies the store surface the method touches.
const def = { ir: BUILTIN_CODING_WORKFLOW_IR } as const;
const fakeStore = {
  getTaskWorkflowSelection: () => ({ workflowId: "builtin-coding-workflow", stepIds: [] }),
  getWorkflowDefinition: async () => ({ id: "builtin-coding-workflow", ir: BUILTIN_CODING_WORKFLOW_IR }),
};
const settings = {
  experimentalFeatures: {
    workflowGraphExecutor: true,
    [WORKFLOW_INTERPRETER_DUAL_OBSERVE_FLAG]: true,
  },
} as any;

function buildShadow(live: TaskDetail, legacy: WorkflowRunObservation): Promise<WorkflowRunObservation> {
  return (TaskExecutor.prototype as any).buildShadowObservation.call(
    { store: fakeStore },
    live,
    def,
    settings,
    legacy,
  );
}

describe("FN-5768 dual-observe shadow terminal-stage truncation", () => {
  it("stops the shadow walk at review for a healthy in-review task (no phantom merge stage)", async () => {
    const live = {
      id: "FN-IR",
      column: "in-review",
      status: null,
      review: { verdict: "APPROVE" },
      mergeDetails: null,
    } as unknown as TaskDetail;

    const legacy = buildWorkflowObservationFromTask(
      { column: "in-review", status: null, review: { verdict: "APPROVE" }, mergeDetails: null },
      { columnSequence: ["in-progress", "in-review"] },
    );

    const shadow = await buildShadow(live, legacy);

    // The graph walker visits the merge node before invoking its seam, so the
    // raw walk would record ["execute","review","merge"]; truncation at the live
    // terminal stage must drop the phantom merge so it matches the legacy side.
    expect(shadow.stageTransitions).toEqual(["execute", "review"]);
    expect(shadow.stageTransitions).toEqual([...legacy.stageTransitions]);
    expect(shadow.mergeOutcome).toBeNull();
  });

  it("keeps the merge stage for a merged (done) task", async () => {
    const live = {
      id: "FN-DONE",
      column: "done",
      status: null,
      review: { verdict: "APPROVE" },
      mergeDetails: { outcome: "merged" },
    } as unknown as TaskDetail;

    const legacy = buildWorkflowObservationFromTask(
      { column: "done", status: null, review: { verdict: "APPROVE" }, mergeDetails: { outcome: "merged" } },
      { columnSequence: ["in-progress", "in-review", "done"] },
    );

    const shadow = await buildShadow(live, legacy);

    expect(shadow.stageTransitions).toEqual(["execute", "review", "merge"]);
    expect(shadow.mergeOutcome).toBe("merged");
  });

  it("stops at execute for a task still in-progress", async () => {
    const live = {
      id: "FN-WIP",
      column: "in-progress",
      status: null,
      review: null,
      mergeDetails: null,
    } as unknown as TaskDetail;

    const legacy = buildWorkflowObservationFromTask(
      { column: "in-progress", status: null, review: null, mergeDetails: null },
      { columnSequence: ["in-progress"] },
    );

    const shadow = await buildShadow(live, legacy);

    expect(shadow.stageTransitions).toEqual(["execute"]);
  });
});
