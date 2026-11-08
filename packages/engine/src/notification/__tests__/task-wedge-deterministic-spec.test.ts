import { describe, expect, it } from "vitest";
import { DETERMINISTIC_SPEC_REJECTION_METADATA_KEY, type Task } from "@fusion/core";

import {
  buildDeterministicSpecExhaustedError,
  DETERMINISTIC_SPEC_VALIDATION_EXHAUSTED,
} from "../../healing/deterministic-spec-rejection.js";
import {
  classifyTerminalFailureAutoRecoveryForTask,
  describeTaskRecoveryOwner,
  describeTaskWedge,
  shouldWithholdWedgeAlertForAutoRecovery,
} from "../task-wedge-notification.js";

/*
FNXC:DeterministicSpecRejection 2026-11-08-04:20 (RUFU-485):
RUFU-482's card was parked by a deterministic checker and described to its operator as an ordinary
terminal failure. Both halves of that cost are what this file pins, and they are the same two halves
RUFU-276 measured for the not-run gate and RUFU-288 for the fence:

- the generic `terminal-failed` copy says "inspect the task error" and names no remedy, while the actual
  remedy is one deleted sentence in this card's own spec;
- `classifyTerminalFailureAutoRecoveryForTask` derives `isGenericTerminalFailure` from this descriptor's
  reason key, so a generic classification hands the card to automatic recovery, which can only re-run a
  planner that regenerates the identical refused text - and `shouldWithholdWedgeAlertForAutoRecovery`
  then suppresses the one message that would have named the spec edit.

The negative cases carry the weight: the re-seed ceiling (RUFU-768) and a genuine authoring exhaustion
MUST stay generic, because for those a retry really is the next move. A matcher that classified every
planning failure specially would satisfy the first assertion and destroy the signal.
*/

const DIAGNOSTIC = "REVISE — Dangling task-document references in PROMPT.md:\n- .fusion/tasks/FN-4850/notes/retry-branch-audit.md";

function parkedTask(overrides: Record<string, unknown> = {}): Task {
  return {
    id: "FN-4850-WEDGE",
    title: "Stop the planner rejecting its own deterministic output",
    description: "",
    column: "todo",
    status: "failed",
    error: buildDeterministicSpecExhaustedError({ attempts: 2, diagnostic: DIAGNOSTIC }),
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-11-08T00:00:00.000Z",
    updatedAt: "2026-11-08T00:00:00.000Z",
    columnMovedAt: "2026-11-08T00:00:00.000Z",
    recoveryRetryCount: null,
    nextRecoveryAt: null,
    sourceMetadata: {
      [DETERMINISTIC_SPEC_REJECTION_METADATA_KEY]: {
        rejectionIdentity: "ident",
        specFingerprint: "fp",
        rejectionCount: 2,
        escalation: "park",
        firstAt: "2026-11-08T00:00:00.000Z",
        lastAt: "2026-11-08T00:00:00.000Z",
        parkedAt: "2026-11-08T00:00:00.000Z",
      },
    },
    workflowStepResults: [],
    ...overrides,
  } as unknown as Task;
}

describe("deterministic-spec wedge descriptor (RUFU-485)", () => {
  it("names the condition and the reachable remedies instead of terminal-failed", () => {
    const wedge = describeTaskWedge(parkedTask());

    expect(wedge?.reasonKey).toBe("deterministic-spec-validation-exhausted");
    expect(wedge?.reason).toContain("same deterministic defect was refused twice");
    // Every remedy the copy offers is one a human or the assigned lane can actually take. The copy
    // FN-9512 retired gated a retry on adjusting the prompt or the model, a lever no lane here holds,
    // and none of that phrasing may reappear through this descriptor.
    expect(wedge?.action).toContain("PROMPT.md");
    expect(wedge?.action).toContain("reconcile-deterministic-spec-rejection-park");
    expect(wedge?.action).toContain("retry forces one now");
    // The exhausted park nulls both counters precisely so this alert can fire.
    expect(describeTaskRecoveryOwner(parkedTask())).toBeNull();
  });

  it("is never claimed as a generic terminal failure, so the alert is delivered", () => {
    const task = parkedTask();

    expect(classifyTerminalFailureAutoRecoveryForTask(task, { autoRecoveryEnabled: true }))
      .toEqual({ action: "skip", reason: "not-generic-terminal-failure" });
    expect(shouldWithholdWedgeAlertForAutoRecovery(task, { autoRecoveryEnabled: true })).toBe(false);
  });

  it("stays silent while a scheduled planning retry still owns the card", () => {
    // The veto the generic fallback already applied is preserved: a card with live counters has an owner,
    // and this alert is only for the counters-null park nothing else will move.
    const owned = parkedTask({
      recoveryRetryCount: 1,
      nextRecoveryAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });

    expect(describeTaskWedge(owned)).toBeNull();
    expect(describeTaskRecoveryOwner(owned)).not.toBeNull();
  });

  it("ends the wedge episode when the owner sweep re-queues the card", () => {
    // The repair clears status/error, so the alert is gone because the condition is gone - not because a
    // withholding rule swallowed a real wedge. The retained episode is evidence, not a wedge.
    const repaired = parkedTask({ status: "needs-replan", error: null });

    expect(describeTaskWedge(repaired)).toBeNull();
  });

  it("selects on the sentinel prefix only, never on prose that quotes it", () => {
    const quoted = parkedTask({
      error: `Execution failed while writing notes mentioning ${DETERMINISTIC_SPEC_VALIDATION_EXHAUSTED}`,
    });

    expect(describeTaskWedge(quoted)?.reasonKey).toBe("terminal-failed");
  });

  it("leaves a genuine authoring exhaustion in the generic terminal-failure lane", () => {
    const authoring = parkedTask({
      error: "PLANNING_FAILED_EXHAUSTED: specification failed 3 times — last error: Planner left the spec unchanged",
      sourceMetadata: {},
    });

    const wedge = describeTaskWedge(authoring);
    expect(wedge?.reasonKey).toBe("terminal-failed");
    // For an authoring exhaustion a retry really is the next move, so auto-recovery keeps claiming it.
    // That is what makes the sentinel case above a distinction rather than a blanket rule over every
    // planning failure.
    expect(classifyTerminalFailureAutoRecoveryForTask(authoring, { autoRecoveryEnabled: true }))
      .toEqual({ action: "retry", attempt: 1 });
    expect(shouldWithholdWedgeAlertForAutoRecovery(authoring, { autoRecoveryEnabled: true })).toBe(true);
  });

  it("does not absorb the RUFU-768 re-seed ceiling park", () => {
    const reseedCeiling = parkedTask({
      error: "PLANNING_RESEED_CYCLE_EXHAUSTED: planning re-seed ceiling reached (3 cycles) — each cycle re-planned and re-failed before Plan Review.",
      sourceMetadata: {},
    });

    // The ceiling is the honest disposition for a DRIFTING failure (each cycle produced a different
    // refusal), so this lane must not describe it. Which specific descriptor it does land on is a separate
    // pre-existing matter: the long-standing loose `(?:exhaust|limit).*review` arm above catches this
    // sentence on the words "EXHAUSTED ... Plan Review" and calls it review-retry-exhausted. Widening or
    // tightening that arm is outside this card - RUFU-768's own contract is that the ceiling stays
    // distinguishable from a deterministic refusal, which is what is asserted here.
    const wedge = describeTaskWedge(reseedCeiling);
    expect(wedge?.reasonKey).not.toBe("deterministic-spec-validation-exhausted");
    expect(wedge?.action ?? "").not.toContain("reconcile-deterministic-spec-rejection-park");
  });
});
