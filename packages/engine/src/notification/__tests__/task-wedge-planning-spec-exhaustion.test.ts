import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";

import {
  classifyTerminalFailureAutoRecoveryForTask,
  describeTaskWedge,
  isPlanningStrandedWedgeRow,
  isTaskProgressing,
  shouldWithholdWedgeAlertForAutoRecovery,
} from "../task-wedge-notification.js";

/*
FNXC:PlanningStrandedRetry 2026-11-10-23:07 (RUFU-575, measured on saneca SANE-282 / SANE-524):
SANE-282 sat in `todo` `queued` with `error: "Specification failed after 3 transient errors: Request
timed out."`, `nextRecoveryAt: null`, `recoveryRetryCount: null`, and a complete durable plan in its
`PROMPT.md`. It produced NO wedge at all, and the reason was a single word: `isTaskProgressing` counted
every `queued` card as progressing, so `describeTaskWedge` returned null at its second line — while the
notification service separately re-confirmed the `queued` state onto the card's History and nobody told.

These cases pin the three properties the delivery half depends on:
1. the row is NOT progressing when it carries the exhausted run's own evidence, and still IS for the
   scheduler's own `queued` stamps and for a live `planning` claim;
2. one reason key across `queued` / `needs-replan` / `failed`, so a drifting row stays one episode;
3. the arm reaches only rows nothing else will revive — the authoring park (`PLANNING_FAILED_EXHAUSTED:`)
   and the deterministic-spec park keep their own arms, and a scheduled recovery still owns the silence.

The RUFU-288 fence test (`task-wedge-planning-fence.test.ts`) is both the shape this copies and the
boundary it must not cross: that arm sits under `describeTaskWedge`'s `status !== "failed"` bail, which is
exactly why it could never describe this population.
*/

/** The verbatim incident sentence as SANE-282 / SANE-524 carry it. */
const SPEC_TIMEOUT_ERROR = "Specification failed after 3 transient errors: Request timed out.";
/** The legacy authoring park prefix — retryable, but generic auto-recovery owns its alert. */
const AUTHORING_PARK_ERROR = "PLANNING_FAILED_EXHAUSTED: specification failed 3 times - last error: Request timed out.";

function planningLaneTask(overrides: Record<string, unknown> = {}): Task {
  return {
    id: "FN-575-WEDGE",
    title: "Card whose planning run exhausted on a provider timeout",
    description: "",
    column: "todo",
    status: "queued",
    error: SPEC_TIMEOUT_ERROR,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-11-09T00:00:00.000Z",
    updatedAt: "2026-11-09T00:00:00.000Z",
    columnMovedAt: "2026-11-09T00:00:00.000Z",
    recoveryRetryCount: null,
    nextRecoveryAt: null,
    workflowStepResults: [],
    ...overrides,
  } as unknown as Task;
}

describe("planning-exhaustion wedge descriptor (RUFU-575)", () => {
  it("treats the stranded `queued` row as NOT progressing, unlike every other `queued` card", () => {
    // The incident row: an exhausted spec run sits on `queued` with nothing scheduled behind it.
    expect(isTaskProgressing(planningLaneTask())).toBe(false);
    // The scheduler's own `queued` stamps (capacity / overlap / the FN-7926 completed-blocked park) carry
    // no exhaustion evidence and stay progressing — this task's own card logged
    // `queued - maxConcurrent capacity exhausted: used=12/12` and must never become a wedge.
    expect(isTaskProgressing(planningLaneTask({ error: "maxConcurrent capacity exhausted: used=12/12" }))).toBe(true);
    expect(isTaskProgressing(planningLaneTask({ error: null }))).toBe(true);
    // A live planner claim is never stranded.
    expect(isTaskProgressing(planningLaneTask({ status: "planning" }))).toBe(true);
  });

  it("names the stranded `queued` row with a descriptor whose action is the Retry verb", () => {
    const wedge = describeTaskWedge(planningLaneTask());
    expect(wedge).not.toBeNull();
    expect(wedge!.reasonKey).toBe("planning-spec-exhausted");
    // The reason says what happened, so the operator is not sent to read the row (RUFU-288's cost).
    expect(wedge!.reason).toMatch(/planning run exhausted/i);
    // The action names the exact verb, so the operator does not Retry into the destructive branch again.
    expect(wedge!.action).toMatch(/Retry/);
    expect(wedge!.action).toMatch(/fn task retry/);
  });

  it("describes the same sentence at every status the incident left rows in, under one episode identity", () => {
    const described = ["queued", "needs-replan", "failed", "stuck-killed"].map((status) => {
      const wedge = describeTaskWedge(planningLaneTask({ status }));
      expect(wedge, `status ${status} must be described`).not.toBeNull();
      return `${wedge!.reasonKey}|${wedge!.reason}|${wedge!.action}`;
    });

    // One row drifting between these statuses must not churn into a run of separate alerts.
    expect(new Set(described).size).toBe(1);
  });

  it("reaches the escalated-reseed shape FN-9512 leaves behind, with no error sentence at all", () => {
    const wedge = describeTaskWedge(planningLaneTask({ error: null, recoveryDisposition: "escalated-reseed" }));
    expect(wedge).not.toBeNull();
    expect(wedge!.reasonKey).toBe("planning-spec-exhausted");
  });

  /*
  FNXC:ReseedLaneDiscriminator 2026-11-12-15:15 (RUFU-575 code review P0):
  The row the EXECUTOR leaves behind, in this lane and with this status. The executor's exhausted-retry
  reseed clears `status`, `error` and the cadence, moves the card to its rebound lane - which on a
  trait-declared board is the planning column - and the scheduler then stamps `queued` on the waiting row,
  because the reseed diagnostic is only cleared when an executor actually claims the card. Every field
  this arm read was therefore identical to the accepted case above, and the alert fired on a card whose
  spec, steps and lane were intact and whose only condition is "waiting for a slot" - the RUFU-372/RUFU-300
  failure shape (capacity waits announcing as failures) re-committed through an ambiguous diagnostic.
  The lane split is what makes this row silent again, and this case is the only place in the wedge suite
  that can see the difference: every other fixture here sets `recoveryDisposition: null` or the planning
  value, so none of them could have caught the collision.
  */
  it("keeps its silence for an execution-lane reseed the scheduler queued in the same lane", () => {
    const executionReseeded = planningLaneTask({
      error: null,
      recoveryRetryCount: null,
      nextRecoveryAt: null,
      recoveryDisposition: "escalated-execution-reseed",
    });

    expect(isTaskProgressing(executionReseeded)).toBe(true);
    expect(isPlanningStrandedWedgeRow(executionReseeded)).toBe(false);
    expect(describeTaskWedge(executionReseeded)).toBeNull();

    // And the classification-level twin of the same field swap, so a widened predicate is caught here too.
    expect(isPlanningStrandedWedgeRow(planningLaneTask({ error: null, recoveryDisposition: "escalated-reseed" }))).toBe(true);
  });

  it("says nothing while a scheduled recovery owns the next attempt, and again once that budget is spent", () => {
    expect(describeTaskWedge(planningLaneTask({ nextRecoveryAt: "2099-01-01T00:00:00.000Z", recoveryRetryCount: 1 }))).toBeNull();
    // An exhausted park nulls both counters precisely so this alert can fire.
    expect(describeTaskWedge(planningLaneTask({ nextRecoveryAt: null, recoveryRetryCount: null }))).not.toBeNull();
  });

  it("holds its silence for an operator or engine pause", () => {
    expect(describeTaskWedge(planningLaneTask({ paused: true }))).toBeNull();
    expect(describeTaskWedge(planningLaneTask({ userPaused: true }))).toBeNull();
    expect(describeTaskWedge(planningLaneTask({ status: "paused" }))).toBeNull();
  });

  it("leaves the authoring-park population in the generic terminal-failure lane it has today", () => {
    /* `task-wedge-planning-fence.test.ts` and `task-wedge-deterministic-spec.test.ts` both pin that a
       genuine authoring exhaustion stays `terminal-failed` WITH automatic recovery claiming it. The new
       arm selects the same `PLANNING_FAILED_EXHAUSTED:` prefix through the broad evidence marker list, so
       without the two ownership guards it placed above, this is the assertion that breaks first. */
    const authoringPark = planningLaneTask({ status: "failed", error: AUTHORING_PARK_ERROR });
    expect(describeTaskWedge(authoringPark)!.reasonKey).toBe("terminal-failed");
    expect(classifyTerminalFailureAutoRecoveryForTask(authoringPark, { autoRecoveryEnabled: true }))
      .toEqual({ action: "retry", attempt: 1 });
    expect(shouldWithholdWedgeAlertForAutoRecovery(authoringPark, { autoRecoveryEnabled: true })).toBe(true);
  });

  it("does not hand automatic recovery a card it cannot advance", () => {
    for (const status of ["queued", "needs-replan", "failed"]) {
      const task = planningLaneTask({ status });
      expect(classifyTerminalFailureAutoRecoveryForTask(task, { autoRecoveryEnabled: true }))
        .toEqual({ action: "skip", reason: "not-generic-terminal-failure" });
      expect(shouldWithholdWedgeAlertForAutoRecovery(task, { autoRecoveryEnabled: true })).toBe(false);
      expect(describeTaskWedge(task)).not.toBeNull();
    }
  });

  it("decides from the row alone: neither entry point can be handed a spec body", () => {
    /* Admission never reads `PROMPT.md` (the operator's stated constraint). The structural half of that
       promise is that neither entry point takes a second argument, so no caller can pass a spec; the
       behavioral half — a real plan, a seed-only body, and no file at all all re-arm — is proven against
       the real filesystem in packages/dashboard/src/routes/__tests__/
       register-task-workflow-routes.planning-stranded-retry.test.ts and
       packages/cli/src/__tests__/task-retry.test.ts. */
    expect(describeTaskWedge.length).toBe(1);
    expect(isPlanningStrandedWedgeRow.length).toBe(1);
  });
});
