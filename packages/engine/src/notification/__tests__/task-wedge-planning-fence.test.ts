import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";

import { PLANNING_FENCE_PARK_ERROR_PREFIX } from "../../planning-handoff-recovery.js";
import {
  classifyTerminalFailureAutoRecoveryForTask,
  describeTaskRecoveryOwner,
  describeTaskWedge,
  shouldWithholdWedgeAlertForAutoRecovery,
} from "../task-wedge-notification.js";

/*
FNXC:PlanningFenceRecovery 2026-10-02-02:05 (RUFU-288):
RUFU-287 exhausted its planning retries against a `workflow-principal-fence-unavailable` refusal and
then read to the operator as an ordinary terminal failure. Two consequences were measured for the
same shape in RUFU-276: the wedge text said nothing about what was actually unavailable, and — because
`classifyTerminalFailureAutoRecoveryForTask` derives `isGenericTerminalFailure` from this descriptor's
reason key — auto-recovery claimed the card, so the wedge alert was withheld for a retry that could
never advance a planning spec.

Both stranded shapes are pinned: the named park this build writes, and the pre-fix
`PLANNING_FAILED_EXHAUSTED … last error: workflow-principal-fence-unavailable:triage` row the incident
actually produced. The genuine authoring exhaustion stays in the generic lane, which is what makes the
fence assertion non-vacuous rather than a matcher that accepts every planning failure.
*/

function planningTask(overrides: Record<string, unknown> = {}): Task {
  return {
    id: "FN-288-WEDGE",
    title: "Plan a card whose planning fence refused",
    description: "",
    column: "todo",
    status: "failed",
    error: `${PLANNING_FENCE_PARK_ERROR_PREFIX} durable planning handoff refused by the workflow-principal fence (role=triage) — planning lifecycle lock unavailable: Planning lifecycle lock acquisition timed out after 5000ms — 3 attempts exhausted. Self-healing re-probes this card (reconcile-planning-fence-park); retry forces one now.`,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    columnMovedAt: "2026-10-01T00:00:00.000Z",
    recoveryRetryCount: null,
    nextRecoveryAt: null,
    planningFailure: {
      principalFence: {
        role: "triage",
        requirement: "lock-transport",
        detail: "Planning lifecycle lock acquisition timed out after 5000ms",
        firstAt: "2026-10-01T00:00:00.000Z",
        at: "2026-10-01T00:00:00.000Z",
        attempt: 3,
      },
    },
    workflowStepResults: [],
    ...overrides,
  } as unknown as Task;
}

/** The exact stranded row RUFU-287 carried: pre-fix exhaustion sentence, no fence marker at all. */
function legacyFencePark(overrides: Record<string, unknown> = {}): Task {
  return planningTask({
    error: "PLANNING_FAILED_EXHAUSTED: specification failed 3 times — last error: workflow-principal-fence-unavailable:triage",
    planningFailure: null,
    ...overrides,
  });
}

describe("planning-fence wedge descriptor (RUFU-288)", () => {
  it("names the unavailable requirement and the recovery owner for an exhausted fence park", () => {
    const wedge = describeTaskWedge(planningTask());

    expect(wedge?.reasonKey).toBe("planning-fence-unavailable");
    expect(wedge?.reason).toContain("planning lifecycle lock");
    expect(wedge?.action).toContain("reconcile-planning-fence-park");
    // The exhausted park nulls its counters precisely so this alert can fire.
    expect(describeTaskRecoveryOwner(planningTask())).toBeNull();
  });

  it("says what could not be consulted when the refusal carried no cause", () => {
    const bare = planningTask({
      planningFailure: {
        principalFence: {
          role: "triage",
          requirement: "cause-unknown",
          detail: null,
          firstAt: "2026-10-01T00:00:00.000Z",
          at: "2026-10-01T00:00:00.000Z",
          attempt: 3,
        },
      },
    });

    const wedge = describeTaskWedge(bare);
    expect(wedge?.reasonKey).toBe("planning-fence-unavailable");
    expect(wedge?.reason).toContain("could not be consulted and carried no cause");
  });

  it("names the fence for the pre-fix stranded row even though it carries no marker", () => {
    const wedge = describeTaskWedge(legacyFencePark());

    // The pre-fix rewrap carried no cause, so the honest sentence is the fence itself — never a
    // guess at a requirement the row cannot prove.
    expect(wedge?.reasonKey).toBe("planning-fence-unavailable");
    expect(wedge?.reason).toContain("could not be consulted and carried no cause");
    expect(wedge?.action).toContain("reconcile-planning-fence-park");
  });

  it("recovers the named requirement from a pre-fix sentence that carried its cause", () => {
    const withCause = legacyFencePark({
      error: "PLANNING_FAILED_EXHAUSTED: specification failed 3 times — last error: workflow-principal-fence-unavailable:triage (Planning lifecycle lock acquisition timed out after 5000ms)",
    });

    expect(describeTaskWedge(withCause)?.reason).toContain("planning lifecycle lock");
  });

  it("stays silent while a scheduled planning retry still owns the card", () => {
    const owned = planningTask({
      status: null,
      error: null,
      recoveryRetryCount: 2,
      nextRecoveryAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });

    expect(describeTaskWedge(owned)).toBeNull();
    expect(describeTaskRecoveryOwner(owned)).not.toBeNull();
  });

  it("is never claimed as a generic terminal failure by automatic recovery", () => {
    const task = planningTask();

    expect(classifyTerminalFailureAutoRecoveryForTask(task, { autoRecoveryEnabled: true }))
      .toEqual({ action: "skip", reason: "not-generic-terminal-failure" });
    // The operator alert must therefore be delivered, not withheld for a recovery that never comes.
    expect(shouldWithholdWedgeAlertForAutoRecovery(task, { autoRecoveryEnabled: true })).toBe(false);
  });

  it("leaves a genuine authoring exhaustion in the generic terminal-failure lane", () => {
    const authoring = planningTask({
      error: "PLANNING_FAILED_EXHAUSTED: specification failed 3 times — last error: Planner left the spec unchanged",
      planningFailure: null,
    });

    expect(describeTaskWedge(authoring)?.reasonKey).toBe("terminal-failed");
    expect(describeTaskWedge(authoring)?.reason).toBe("The task entered a terminal failed state and needs operator intervention.");
    expect(describeTaskWedge(authoring)?.action).toBe("Inspect the task error, fix the underlying issue, then retry or reset to todo.");
    expect(classifyTerminalFailureAutoRecoveryForTask(authoring, { autoRecoveryEnabled: true }))
      .toEqual({ action: "retry", attempt: 1 });
    expect(shouldWithholdWedgeAlertForAutoRecovery(authoring, { autoRecoveryEnabled: true })).toBe(true);
  });

  it("keeps retained fence evidence inert once the card has moved on", () => {
    // A re-queued card keeps its episode evidence; only the park sentence makes the wedge fire.
    const requeued = planningTask({ status: "needs-replan", error: null });
    expect(describeTaskWedge(requeued)?.reasonKey).not.toBe("planning-fence-unavailable");

    // A fence sentence inside unrelated prose is not a park: the prefixes are what select.
    const prose = planningTask({
      error: "Execution failed while writing notes about workflow-principal-fence-unavailable:triage",
      planningFailure: null,
    });
    expect(describeTaskWedge(prose)?.reasonKey).toBe("terminal-failed");
  });
});
