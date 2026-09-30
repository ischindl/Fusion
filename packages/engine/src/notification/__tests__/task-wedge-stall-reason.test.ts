/*
FNXC:TaskWedgeNotifications 2026-09-03-01:35 (RUFU-180):
A review-lane refusal writes no `status`, no `pausedReason`, and no `error`, so the legacy
`describeTaskWedge` status bail classified it as "nothing wrong" and the card never announced
itself. `describeTaskWedgeFromStallReason` maps the already-hydrated stall authority into the
wedge descriptor shape; `describeTaskWedgeWithStall` composes it BEHIND the legacy classifier.

These cases pin both halves of the contract: the three alertable review-lane codes each produce the
locked descriptor, and every other shape stays silent so an existing notification world is never
double-announced. reasonKeys carry the `stall:` prefix so they can never equal `terminal-failed`.
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStallReason, TaskStallReasonCode } from "@fusion/core";
import { classifyTerminalFailureAutoRecoveryForTask, describeTaskWedge, describeTaskWedgeFromStallReason, describeTaskWedgeWithStall, shouldWithholdWedgeAlertForAutoRecovery } from "../task-wedge-notification.js";

vi.mock("../../logger.js", () => ({
  schedulerLog: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "Task title",
    description: "Task desc",
    status: null,
    column: "in-review",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    ...overrides,
  } as Task;
}

function stall(code: TaskStallReasonCode, reason: string): TaskStallReason {
  return { code, reason, observedAt: new Date().toISOString() };
}

const CANONICAL_MERGE_BLOCKER = "task has a pre-merge approval recorded against different content";
const CANONICAL_GATE_PENDING = "task has enabled pre-merge workflow steps that never ran";

describe("describeTaskWedgeFromStallReason", () => {
  it("classifies a merge-blocker stall with the canonical sentence and an actionable next step", () => {
    const descriptor = describeTaskWedgeFromStallReason(task({ stallReason: stall("merge-blocker", CANONICAL_MERGE_BLOCKER) }));

    expect(descriptor).toEqual({
      reasonKey: "stall:merge-blocker",
      reason: CANONICAL_MERGE_BLOCKER,
      action: "Open the card and clear the blocker: re-run the review gate, bypass a failed pre-merge review step, or reset the card to todo.",
    });
  });

  it("classifies a pre-merge-gate-pending stall so a gate that never ran announces itself", () => {
    const descriptor = describeTaskWedgeFromStallReason(task({ stallReason: stall("pre-merge-gate-pending", CANONICAL_GATE_PENDING) }));

    expect(descriptor).toEqual({
      reasonKey: "stall:pre-merge-gate-pending",
      reason: CANONICAL_GATE_PENDING,
      action: "Run the pending review gate from the card, or reset the card to todo so the pipeline runs the gate again.",
    });
  });

  it("classifies a held-human-review stall as the human contract it is", () => {
    const descriptor = describeTaskWedgeFromStallReason(task({
      stallReason: stall("held-human-review", "Waiting on a human: automatic merge processing is withheld for this card, so review completion does not merge it"),
    }));

    expect(descriptor).toEqual({
      reasonKey: "stall:held-human-review",
      reason: "Waiting on a human: automatic merge processing is withheld for this card, so review completion does not merge it",
      action: "Merge the card by hand, or turn automatic merge processing back on.",
    });
  });

  it("keeps every stall reasonKey prefixed so it can never equal the terminal-failed key", () => {
    for (const code of ["merge-blocker", "pre-merge-gate-pending", "held-human-review"] as const) {
      const descriptor = describeTaskWedgeFromStallReason(task({ stallReason: stall(code, `blocker for ${code}`) }));
      expect(descriptor?.reasonKey).toBe(`stall:${code}`);
      expect(descriptor?.reasonKey).not.toBe("terminal-failed");
    }
  });

  it("names the operator's next step in every action and never an internal stall code", () => {
    for (const code of ["merge-blocker", "pre-merge-gate-pending", "held-human-review"] as const) {
      const action = describeTaskWedgeFromStallReason(task({ stallReason: stall(code, "x") }))!.action;
      expect(/reset|re-run|retry|run the pending review gate|merge the card by hand|turn automatic merge processing back on|bypass/i.test(action)).toBe(true);
      for (const internal of ["merge-blocker", "pre-merge-gate-pending", "held-human-review", "dependency-blocker", "stall:"]) {
        expect(action).not.toContain(internal);
      }
    }
  });

  it("stays silent when no stall reason was hydrated onto the read", () => {
    expect(describeTaskWedgeFromStallReason(task())).toBeNull();
  });

  it("stays silent on dependency-blocker: the blocking card announces its own stall", () => {
    expect(describeTaskWedgeFromStallReason(task({
      column: "todo",
      stallReason: stall("dependency-blocker", "task is waiting on 1 unmet dependency"),
    }))).toBeNull();
  });

  /*
  FNXC:ReviewRevisionWait 2026-09-30-07:19 (RUFU-280 code-review remediation, P2):
  `awaiting-review-revision` is visible-but-not-alertable, the same class RUFU-273 established for the
  planning codes: the sentence is the engine reporting work it is doing, and the Review lane already
  reports the revision itself. The `Record` in the notifier makes an undeclared code a TYPE error; this
  is the pair assertion that makes the silence a tested contract instead of a compile-time side effect,
  so a future edit cannot move the code into the alertable set without a test failing here first.
  */
  it("stays silent on awaiting-review-revision: an in-progress correction is nobody's wedge to announce", () => {
    expect(describeTaskWedgeFromStallReason(task({
      stallReason: stall("awaiting-review-revision", "Working through review corrections: unfinished remediation work"),
    }))).toBeNull();
  });

  /*
  FNXC:PlanningAdmissionStall 2026-09-25-17:48 (RUFU-273):
  The planning-lane codes are visible-but-not-alertable. RUFU-273 routes them to the card face and the
  detail banner, never to the mailbox, so this is the pair assertion that makes the design a tested
  contract rather than a comment: the same hydrated field that makes the three review-lane codes
  announce itself must leave every planning code silent. Each sentence is arbitrary here on purpose —
  the classifier must not alert on a planning code no matter what the server sentence says.
  */
  it.each([
    "plan-admission-throttled",
    "plan-lane-ineligible",
    "plan-premise-held",
    "plan-spec-unreadable",
    "plan-recovery-backoff",
    "plan-no-admission",
    "recoverable-work",
  ] as TaskStallReasonCode[])("stays silent for the planning-lane code %s: the card names the cause, the mailbox does not re-ask for a human", (code) => {
    expect(describeTaskWedgeFromStallReason(task({
      column: "hold",
      stallReason: stall(code, "Planning-lane sentence under test."),
    }))).toBeNull();
  });

  it("stays silent for any non-empty string status, which its own notification world already owns", () => {
    for (const status of ["failed", "paused", "merging", "merging-pr", "merged", "reviewing", "landing", "awaiting-approval", "awaiting-user-review", "queued", "stuck-killed", "needs-replan"]) {
      expect(
        describeTaskWedgeFromStallReason(task({
          status: status as Task["status"],
          stallReason: stall("merge-blocker", CANONICAL_MERGE_BLOCKER),
        })),
      ).toBeNull();
    }
  });

  it("treats an empty-string status as the silent population it documents", () => {
    expect(describeTaskWedgeFromStallReason(task({
      status: "" as Task["status"],
      stallReason: stall("merge-blocker", CANONICAL_MERGE_BLOCKER),
    }))).not.toBeNull();
  });

  it("stays silent for a paused or user-paused card, whose awaiting-input world already notifies", () => {
    const stalled = { stallReason: stall("merge-blocker", CANONICAL_MERGE_BLOCKER) };
    expect(describeTaskWedgeFromStallReason(task({ paused: true, ...stalled }))).toBeNull();
    expect(describeTaskWedgeFromStallReason(task({ status: "paused" as Task["status"], ...stalled }))).toBeNull();
    expect(describeTaskWedgeFromStallReason(task({ userPaused: true, ...stalled }))).toBeNull();
  });

  it("stays silent for a progressing card even though the status guard already covers it (defensive)", () => {
    for (const status of ["queued", "planning", "in-progress", "reviewing", "merging", "merging-pr", "merged", "done"]) {
      const progressing = task({ status: status as Task["status"] });
      expect(describeTaskWedgeFromStallReason(progressing)).toBeNull();
    }
  });

  it("fails closed on an unknown future stall code rather than inventing an alert", () => {
    expect(describeTaskWedgeFromStallReason(task({
      stallReason: stall("waiting-on-external-scan" as unknown as TaskStallReasonCode, "some future sentence"),
    }))).toBeNull();
  });

  it("is card-shape agnostic: a workspace-scoped review card classifies the same as a singular one", () => {
    const singular = task({ stallReason: stall("pre-merge-gate-pending", CANONICAL_GATE_PENDING) });
    const workspace = task({
      stallReason: stall("pre-merge-gate-pending", CANONICAL_GATE_PENDING),
      repositoryScope: { repositories: ["apps/a", "services/b"], state: "confirmed" },
    } as Partial<Task>);

    expect(describeTaskWedgeFromStallReason(workspace)).toEqual(describeTaskWedgeFromStallReason(singular));
  });
});

describe("describeTaskWedgeWithStall", () => {
  it("returns the legacy descriptor byte-identical for a failed card that also carries a stall reason", () => {
    const failed = task({
      status: "failed",
      error: "opaque terminal failure",
      mergeRetries: 5,
      stallReason: stall("merge-blocker", CANONICAL_MERGE_BLOCKER),
    });
    const legacy = describeTaskWedge(failed);

    expect(legacy?.reasonKey).toBe("terminal-failed");
    expect(describeTaskWedgeWithStall(failed)).toEqual(legacy);
  });

  it("keeps the legacy pause descriptor precedence over the stall classifier", () => {
    const paused = task({
      paused: true,
      status: "paused" as Task["status"],
      pausedReason: "branch-conflict-tripwire",
      stallReason: stall("merge-blocker", CANONICAL_MERGE_BLOCKER),
    });

    expect(describeTaskWedgeWithStall(paused)?.reasonKey).toBe("branch-conflict-tripwire");
  });

  it("reaches the stall classifier only for the silent population", () => {
    expect(describeTaskWedge(task({ stallReason: stall("pre-merge-gate-pending", CANONICAL_GATE_PENDING) }))).toBeNull();
    expect(describeTaskWedgeWithStall(task({ stallReason: stall("pre-merge-gate-pending", CANONICAL_GATE_PENDING) }))?.reasonKey).toBe("stall:pre-merge-gate-pending");
  });

  it("stays null for a clean review card so no alert is invented from nothing", () => {
    expect(describeTaskWedgeWithStall(task())).toBeNull();
  });
});

describe("withhold parity for the status-null stall population", () => {
  /*
  FNXC:TaskWedgeNotifications 2026-09-03-03:17 (RUFU-180):
  The auto-recovery withhold machinery was built for failed cards. These cases assert — not assume —
  that the new population does NOT enter it: the terminal-failure classifier keeps answering
  not-generic-terminal-failure for a stall-reasoned status-null card, the withhold predicate returns
  false so the alert is never swallowed, and the failure-lane decision sites stay failed-only.
  */
  it("classifies a stall-reasoned status-null review card as skip / not-generic-terminal-failure, never retry", () => {
    const stalled = task({ stallReason: stall("merge-blocker", CANONICAL_MERGE_BLOCKER) });
    for (const autoRecoveryEnabled of [true, false]) {
      const decision = classifyTerminalFailureAutoRecoveryForTask(stalled, { autoRecoveryEnabled });
      expect(decision).toEqual({ action: "skip", reason: "not-generic-terminal-failure" });
      expect(shouldWithholdWedgeAlertForAutoRecovery(stalled, { autoRecoveryEnabled })).toBe(false);
    }
  });

  it("keeps a failed-status row that ALSO carries a stall reason on the legacy classification path", () => {
    const failedStall = task({
      status: "failed",
      error: "opaque terminal failure",
      mergeRetries: 5,
      stallReason: stall("merge-blocker", CANONICAL_MERGE_BLOCKER),
    });
    // Legacy side of the composition boundary is untouched...
    expect(describeTaskWedge(failedStall)?.reasonKey).toBe("terminal-failed");
    // ...and the composed path returns it byte-identical, so the delivered wedge reason stays the legacy key.
    expect(describeTaskWedgeWithStall(failedStall)).toEqual(describeTaskWedge(failedStall));
    // The failure-lane classifier is stall-blind: the same row WITHOUT the hydrated stall field must
    // classify identically, proving the stall field cannot alter failed-card recovery decisions.
    const bareFailed = task({ status: "failed", error: "opaque terminal failure", mergeRetries: 5 });
    expect(classifyTerminalFailureAutoRecoveryForTask(failedStall, { autoRecoveryEnabled: true, now: 1_700_000_000_000 }))
      .toEqual(classifyTerminalFailureAutoRecoveryForTask(bareFailed, { autoRecoveryEnabled: true, now: 1_700_000_000_000 }));
    expect(classifyTerminalFailureAutoRecoveryForTask(failedStall, { autoRecoveryEnabled: true }))
      .not.toEqual({ action: "skip", reason: "not-generic-terminal-failure" });
  });
});

describe("settings interactions arrive as hydrated shapes only", () => {
  /*
  FNXC:TaskWedgeNotifications 2026-09-03-03:17 (RUFU-180):
  Per-task autoMerge and project settings are consumed at HYDRATION time in core; the engine sees
  only the resulting row. These rows name the provenance of the shapes the matrix above already
  treats: a per-task autoMerge opt-in under a project-autoMerge-off lane never gets a held reason
  stamped, so its review row is exactly the no-stall-reason silent shape.
  */
  it("stays silent for a per-task autoMerge opt-in card whose held-human-review reason never hydrated", () => {
    expect(describeTaskWedgeWithStall(task({ autoMerge: true } as Partial<Task>))).toBeNull();
  });

  it("hydrates project-autoMerge-off holdings as the held-human-review shape the matrix alerts on exactly once", () => {
    const held = task({ stallReason: stall("held-human-review", "auto-merge is held for a human decision while the project keeps review terminal-until-merged") });
    expect(describeTaskWedgeWithStall(held)?.reasonKey).toBe("stall:held-human-review");
    // "Exactly one alert ever" is a CAS property, asserted end-to-end in the sweep harness.
  });
});
