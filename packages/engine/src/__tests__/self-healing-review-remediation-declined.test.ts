import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBuiltinWorkflow, type Task, type WorkflowStepResult } from "@fusion/core";
import {
  reviewRemediationDeclineText,
  reviewRemediationNotProducedText,
} from "../executor/review-remediation-refusal-text.js";
import { recoverFailedPreMergeWorkflowStepDetailed, type RecoverFailedPreMergeStepCallOptions } from "../executor/recover-failed-pre-merge-step.js";
import { EMPTY_REVIEW_DIFF_FINGERPRINT } from "../worktree/review-diff-fingerprint.js";
import { SelfHealingManager } from "../self-healing.js";

/*
FNXC:ReviewRemediationDeclineNarration 2026-11-06-16:41 (RUFU-351):
The graph-terminal no-regression guard at the bottom of this file drives the real `TaskExecutor`
sink, so it needs the shared executor mock factory (the same import
`unrun-pre-merge-gate-wedge.test.ts` uses). The side-effect import installs the module mocks the
executor constructor expects; the sweep and helper tests above never construct an executor, so the
mocks stay inert for them.
*/
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

/*
FNXC:ReviewRemediationDeclineNarration 2026-09-27-06:25 (RUFU-351):
RUFU-274 sat blocked in review with a failed Code Review gate and no card-level explanation of why
nothing was scheduled. Forensics (task document `forensics`) showed the revival sweep declined the
card in its candidate filter, so the recovery helper — the only owner that narrated declines — never
ran. These tests own the restored invariant: every declined recovery is either SCHEDULED or NARRATED,
never silent, and one decline produces at most ONE operator-facing sentence.
*/

const failedCodeReview = (over: Partial<WorkflowStepResult> = {}): WorkflowStepResult => ({
  workflowStepId: "WS-CR",
  workflowStepName: "Code Review",
  phase: "pre-merge",
  status: "failed",
  verdict: "REVISE",
  output: "P0: the lockfile drift is not handled.",
  findings: [{ severity: "P0", detail: "The lockfile drift is not handled." }],
  reviewInputFingerprint: "sha256:aaaabbbbccccdddd",
  startedAt: "2026-09-26T10:00:00.000Z",
  completedAt: "2026-09-26T10:05:00.000Z",
  ...over,
});

const declinedTask = (over: Partial<Task> = {}): Task => ({
  id: "RUFU-351",
  title: "Narrate declined review remediation",
  column: "in-review",
  status: null,
  paused: false,
  worktree: "/tmp/rufu-351",
  branch: "fusion/rufu-351",
  steps: [],
  log: [],
  workflowStepResults: [failedCodeReview()],
  postReviewFixCount: 0,
  ...over,
} as Task);

const helperDeps = (task: Task, budget: { unbounded: boolean; max: number; label: string; key: string; attempts: number }) => {
  const store = {
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ autoMerge: true })),
    logEntry: vi.fn(async () => {}),
    updateTask: vi.fn(async () => task),
    recordRunAuditEvent: vi.fn(),
  };
  return {
    store,
    resolveFailedPreMergeWorkflowStepBudget: vi.fn(async () => budget),
    sendTaskBackForFix: vi.fn(async () => {}),
  };
};

describe("review-remediation-refusal-text — characterization of the pre-extraction sentences", () => {
  /*
  FNXC:ReviewRemediationDeclineNarration 2026-09-27-06:25 (RUFU-351):
  These literals are the strings the recovery helper spelled inline before RUFU-351 extracted the
  shared leaf. They are pinned here so the extraction is provably text-preserving: an operator who
  has read one of these sentences reads the same sentence after the move.
  */
  const literals: Record<string, { action: string; outcome: string }> = {
    "operator-task-hold": {
      action: "Failed pre-merge step recovery not scheduled — operator task hold",
      outcome: "Reason: operator-authored task-level auto-merge Off holds failed-step recovery",
    },
    "checkout-unavailable": {
      action: "Failed pre-merge step recovery not scheduled — checkout unavailable",
      outcome: "Step: Code Review\nNo singular worktree or acquired workspace repository worktree is available. "
        + "Retry after restoring the task checkout, or use the privileged review bypass when the failed review is known to be non-blocking.",
    },
    "revision-budget-zero-or-invalid": {
      action: "Failed pre-merge step recovery not scheduled — revision budget zero/invalid",
      outcome: "Step: Code Review\nAttempts: 2\nMax: 0",
    },
    "revision-budget-exhausted": {
      action: "Failed pre-merge step recovery not scheduled — revision budget exhausted",
      outcome: "Step: Code Review\nAttempts: 3\nMax: 3",
    },
  };

  it("renders each narrated decline exactly as the recovery helper spelled it before the extraction", () => {
    expect(reviewRemediationDeclineText("operator-task-hold", {
      stepName: "Code Review",
      reason: "operator-authored task-level auto-merge Off holds failed-step recovery",
    })).toEqual(literals["operator-task-hold"]);
    expect(reviewRemediationDeclineText("checkout-unavailable", { stepName: "Code Review" }))
      .toEqual(literals["checkout-unavailable"]);
    expect(reviewRemediationDeclineText("revision-budget-zero-or-invalid", { stepName: "Code Review", attempts: 2, max: 0 }))
      .toEqual(literals["revision-budget-zero-or-invalid"]);
    expect(reviewRemediationDeclineText("revision-budget-exhausted", { stepName: "Code Review", attempts: 3, max: 3 }))
      .toEqual(literals["revision-budget-exhausted"]);
  });

  it("groups the sweep's un-narrated-decline fallbacks under the refused gate's existing action string", () => {
    expect(reviewRemediationNotProducedText({ stepName: "Code Review", gate: "Code Review", reason: "appender-declined" }))
      .toEqual({
        action: "Failed pre-merge step remediation not produced — card left in review",
        outcome: "Step: Code Review\nGate: Code Review\nReason: appender-declined\n"
          + "This review is not retried until its findings change. Re-run the review after addressing it manually, "
          + "or use the privileged review bypass when the failed review is known to be non-blocking.",
      });
    // An admitted-but-silent skip reads as the same family with a different reason line, never a fourth sentence.
    expect(reviewRemediationDeclineText("skipped-without-narration", { stepName: "Code Review", reason: "skipped" }).action)
      .toBe(reviewRemediationNotProducedText({ stepName: "Code Review", gate: "Code Review", reason: "appender-declined" }).action);
    expect(reviewRemediationDeclineText("recovery-threw", { stepName: "Code Review", reason: "recovery threw" }).action)
      .toBe(reviewRemediationNotProducedText({ stepName: "Code Review", gate: "Code Review", reason: "appender-declined" }).action);
  });
});

describe("recoverFailedPreMergeWorkflowStepDetailed — narrated declines keep their exact card text", () => {
  it("narrates an operator-authored auto-merge hold", async () => {
    const task = declinedTask({ autoMerge: false, autoMergeProvenance: "user" });
    const deps = helperDeps(task, { unbounded: false, max: 3, label: "3", key: "pre-merge-optional-step:WS-CR", attempts: 0 });

    await expect(recoverFailedPreMergeWorkflowStepDetailed(deps as never, task)).resolves.toEqual({ kind: "skipped" });

    expect(deps.store.logEntry).toHaveBeenCalledWith(
      "RUFU-351",
      "Failed pre-merge step recovery not scheduled — operator task hold",
      "Reason: operator-authored task-level auto-merge Off holds failed-step recovery",
      undefined,
    );
  });

  it("narrates an unavailable checkout", async () => {
    const task = declinedTask({ worktree: null, branch: null });
    const deps = helperDeps(task, { unbounded: false, max: 3, label: "3", key: "pre-merge-optional-step:WS-CR", attempts: 0 });

    await expect(recoverFailedPreMergeWorkflowStepDetailed(deps as never, task)).resolves.toEqual({ kind: "skipped" });

    expect(deps.store.logEntry).toHaveBeenCalledWith(
      "RUFU-351",
      "Failed pre-merge step recovery not scheduled — checkout unavailable",
      "Step: Code Review\nNo singular worktree or acquired workspace repository worktree is available. "
        + "Retry after restoring the task checkout, or use the privileged review bypass when the failed review is known to be non-blocking.",
      undefined,
    );
  });

  it("narrates a zero/invalid revision budget", async () => {
    const task = declinedTask();
    const deps = helperDeps(task, { unbounded: false, max: 0, label: "0", key: "pre-merge-optional-step:WS-CR", attempts: 2 });

    await expect(recoverFailedPreMergeWorkflowStepDetailed(deps as never, task)).resolves.toEqual({ kind: "skipped" });

    expect(deps.store.logEntry).toHaveBeenCalledWith(
      "RUFU-351",
      "Failed pre-merge step recovery not scheduled — revision budget zero/invalid",
      "Step: Code Review\nAttempts: 2\nMax: 0",
      undefined,
    );
  });

  /*
  FNXC:ReviewRemediationDeclineNarration 2026-09-27-07:14 (RUFU-351):
  "One narrated decline = one audit row" must hold for EVERY owner, not only the revival sweep: the
  retry router and the in-process runtime call this helper directly, so a decline narrated here would
  otherwise be readable on the card yet invisible to `runAuditEvents` queries. The row credits the
  owner that wrote the sentence (`executor`) and carries no prose.
  */
  it("records exactly one decline audit row per narrated decline, and none when nothing was narrated", async () => {
    const held = declinedTask({ autoMerge: false, autoMergeProvenance: "user" });
    const heldDeps = helperDeps(held, { unbounded: false, max: 3, label: "3", key: "pre-merge-optional-step:WS-CR", attempts: 0 });

    await recoverFailedPreMergeWorkflowStepDetailed(heldDeps as never, held);

    const rows = heldDeps.store.recordRunAuditEvent.mock.calls.map(([row]) => row);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agentId: "executor",
      mutationType: "task:review-remediation-declined",
      target: "RUFU-351",
      metadata: { taskId: "RUFU-351", column: "in-review", code: "operator-task-hold", gate: "unknown" },
    });
    // The refusal sentence stays on the card; the row carries only the fixed class and gate.
    expect(JSON.stringify(rows[0])).not.toContain("operator-authored task-level");

    const nothingToRecover = declinedTask({ workflowStepResults: [] });
    const silentDeps = helperDeps(nothingToRecover, { unbounded: false, max: 3, label: "3", key: "pre-merge-optional-step:WS-CR", attempts: 0 });

    await recoverFailedPreMergeWorkflowStepDetailed(silentDeps as never, nothingToRecover);

    expect(silentDeps.store.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("reports a narrated decline into the caller's witness so a caller fallback does not duplicate it", async () => {
    const task = declinedTask();
    const deps = helperDeps(task, { unbounded: false, max: 0, label: "0", key: "pre-merge-optional-step:WS-CR", attempts: 2 });
    const witness = { narrated: false };

    await recoverFailedPreMergeWorkflowStepDetailed(deps as never, task, { narrationWitness: witness });

    expect(witness.narrated).toBe(true);
  });

  it("leaves the witness untouched when no sentence was written", async () => {
    const task = declinedTask({ workflowStepResults: [] });
    const deps = helperDeps(task, { unbounded: false, max: 3, label: "3", key: "pre-merge-optional-step:WS-CR", attempts: 0 });
    const witness = { narrated: false };

    await expect(recoverFailedPreMergeWorkflowStepDetailed(deps as never, task, { narrationWitness: witness }))
      .resolves.toEqual({ kind: "skipped" });

    expect(deps.store.logEntry).not.toHaveBeenCalled();
    expect(witness.narrated).toBe(false);
  });

  /*
  FNXC:ReviewRemediationDeclineNarration 2026-11-06-17:41 (RUFU-351 code review):
  The other half of the delegated-hand-off rule. Marking the witness at hand-offs must be driven by
  whether the owner ACTUALLY narrated, or this task's own symptom returns: a delegated owner that
  refused in silence would silence the caller's fallback too. The convergence ladder's `"declined"`
  arms are that shape — the race where the gate its caller was admitted on cleared under the
  recovery, so the ladder re-reads a live gate, finds none, and writes nothing. The caller must
  still narrate the card.
  */
  it("leaves the witness unmarked when the delegated ladder declined without narrating", async () => {
    const admitted = declinedTask({
      reviewConvergenceStage: 2,
      workflowStepResults: [failedCodeReview({ priorAttempts: [failedCodeReview()] })],
    });
    const deps = helperDeps(admitted, { unbounded: false, max: 3, label: "3", key: "pre-merge-optional-step:WS-CR", attempts: 1 });
    // The ladder re-reads the row for itself; this row says the gate already cleared.
    deps.store.getTask.mockResolvedValue({
      ...admitted,
      workflowStepResults: [failedCodeReview({ status: "passed", verdict: "APPROVE", priorAttempts: undefined })],
    });
    const witness = { narrated: false };

    await expect(recoverFailedPreMergeWorkflowStepDetailed(deps as never, admitted, { narrationWitness: witness }))
      .resolves.toEqual({ kind: "skipped" });

    expect(deps.store.logEntry).not.toHaveBeenCalled();
    expect(witness.narrated).toBe(false);
  });
});

/*
FNXC:ReviewRemediationDeclineNarration 2026-09-27-06:25 (RUFU-351):
Sweep-level harness. The revival sweep is the owner that admitted a card and then delegated, so it is
the only place that can see "I admitted this and nothing was produced". The store below is a real-ish
TaskStore surface (no isWatching, audit sink present) so the sweep runs its true admission path.
*/
const sweepSettings = { autoMerge: true, globalPause: false, enginePaused: false };

const createSweepStore = (task: Task) => {
  const auditRows: Array<Record<string, any>> = [];
  return {
    auditRows,
    task,
    /*
    FNXC:WorkflowBatchCacheEpoch 2026-11-08-00:00 (RUFU-351 merge fixture repair, RUFU-584 seam):
    `SelfHealingManager.batchWorkflowIrCache()`/`batchWorkflowSelectionCache()` read
    `store.workflowDefinitionEpoch()` and `store.workflowSelectionEpoch()` UNGUARDED (RUFU-584,
    `58d561b1c1`), and the revival sweep takes both caches before its first decision, so a reduced
    fake without them died as `TypeError: ... is not a function` inside the sweep's outer catch —
    every candidate silently vanished and each leg asserted zero calls. Same repair precedent as
    `unrun-pre-merge-gate-wedge.test.ts` and `self-healing-stale-overlap-blocker.test.ts`. A constant
    epoch is the honest fake: no case here writes a workflow definition or selection mid-pass, so a
    cache that never invalidates reports exactly what the real store would.
    */
    workflowDefinitionEpoch: vi.fn(() => 0),
    workflowSelectionEpoch: vi.fn(() => 0),
    listTasks: vi.fn(async () => [task]),
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ ...sweepSettings })),
    getConfig: vi.fn(async () => null),
    getProject: vi.fn(async () => null),
    isTaskActive: vi.fn(() => false),
    getWorkflowDefinition: vi.fn(async () => null),
    getTaskWorkflowSelection: vi.fn(() => null),
    getWorkflowEnabledStepIdsForTask: vi.fn(async () => []),
    acquireTaskLock: vi.fn(async () => true),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => patch),
    logEntry: vi.fn(async () => {}),
    recordRunAuditEvent: vi.fn((row: Record<string, any>) => { auditRows.push(row); }),
  };
};

const declineRows = (store: ReturnType<typeof createSweepStore>) =>
  store.auditRows.filter((row) => row.mutationType === "task:review-remediation-declined");

describe("recoverReviewTasksWithFailedPreMergeSteps — declined remediation is narrated, never mute", () => {
  it("narrates a decline the recovery owner reported without its own card sentence", async () => {
    // Red before RUFU-351: this arm wrote only an engine log line, the exact silence RUFU-274 died of.
    const store = createSweepStore(declinedTask());
    const manager = new SelfHealingManager(store as never, {
      rootDir: "/tmp/rufu-351",
      recoverFailedPreMergeStep: vi.fn(async () => false),
      recoverFailedPreMergeStepDetailed: vi.fn(async () => ({ kind: "skipped" as const })),
    });

    await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);

    expect(store.logEntry).toHaveBeenCalledWith(
      "RUFU-351",
      "Failed pre-merge step remediation not produced — card left in review",
      expect.stringContaining("The recovery owner declined without a card-level explanation"),
    );
    expect(declineRows(store)).toHaveLength(1);
    expect(declineRows(store)[0]).toEqual(expect.objectContaining({
      agentId: "self-healing",
      target: "RUFU-351",
      metadata: expect.objectContaining({ taskId: "RUFU-351", code: "skipped-without-narration", gate: "WS-CR" }),
    }));
  });

  it("writes at most one decline sentence when the recovery owner already narrated its own", async () => {
    const store = createSweepStore(declinedTask());
    const manager = new SelfHealingManager(store as never, {
      rootDir: "/tmp/rufu-351",
      recoverFailedPreMergeStep: vi.fn(async () => false),
      recoverFailedPreMergeStepDetailed: vi.fn(async (_task, options) => {
        // Stand in for the helper's own narrated decline (checkout/hold/budget), witness included.
        options?.narrationWitness && (options.narrationWitness.narrated = true);
        return { kind: "skipped" as const };
      }),
    });

    await manager.recoverReviewTasksWithFailedPreMergeSteps();

    expect(store.logEntry).not.toHaveBeenCalled();
    expect(declineRows(store)).toHaveLength(0);
  });

  it("narrates an unavailable checkout that kept the helper from ever running", async () => {
    const store = createSweepStore(declinedTask({ worktree: null, branch: null }));
    const recoverDetailed = vi.fn(async () => ({ kind: "skipped" as const }));
    const manager = new SelfHealingManager(store as never, {
      rootDir: "/tmp/rufu-351",
      recoverFailedPreMergeStep: vi.fn(async () => false),
      recoverFailedPreMergeStepDetailed: recoverDetailed,
    });

    await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);

    expect(recoverDetailed).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "RUFU-351",
      "Failed pre-merge step recovery not scheduled — checkout unavailable",
      expect.stringContaining("Retry after restoring the task checkout"),
    );
    // An unbounded budget must never reach the card as `Max: Infinity`.
    expect(store.logEntry.mock.calls[0][2]).not.toContain("Infinity");
    expect(declineRows(store)[0]?.metadata).toEqual(expect.objectContaining({ code: "checkout-unavailable", gate: "WS-CR" }));
  });

  it("narrates a zero or invalid revision budget resolved from workflow settings", async () => {
    const store = createSweepStore(declinedTask());
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ ...sweepSettings, maxPostReviewFixes: 0 });
    const recoverDetailed = vi.fn(async () => ({ kind: "skipped" as const }));
    const manager = new SelfHealingManager(store as never, {
      rootDir: "/tmp/rufu-351",
      recoverFailedPreMergeStep: vi.fn(async () => false),
      recoverFailedPreMergeStepDetailed: recoverDetailed,
    });

    await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);

    expect(recoverDetailed).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "RUFU-351",
      "Failed pre-merge step recovery not scheduled — revision budget zero/invalid",
      expect.stringContaining("Max: 0"),
    );
    expect(declineRows(store)[0]?.metadata).toEqual(expect.objectContaining({ code: "revision-budget-zero-or-invalid" }));
  });

  it("narrates a recovery owner that threw before producing an outcome", async () => {
    const store = createSweepStore(declinedTask());
    const manager = new SelfHealingManager(store as never, {
      rootDir: "/tmp/rufu-351",
      recoverFailedPreMergeStep: vi.fn(async () => false),
      recoverFailedPreMergeStepDetailed: vi.fn(async () => { throw new Error("synthetic recovery crash"); }),
    });

    // The sweep must swallow the crash exactly as before — the narration is additive.
    await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);

    expect(store.logEntry).toHaveBeenCalledWith(
      "RUFU-351",
      "Failed pre-merge step remediation not produced — card left in review",
      expect.stringContaining("The recovery owner threw before producing an outcome"),
    );
    // The exception sentence stays in the engine log; the card never carries it.
    expect(store.logEntry.mock.calls[0][2]).not.toContain("synthetic recovery crash");
    expect(declineRows(store)[0]?.metadata).toEqual(expect.objectContaining({ code: "recovery-threw" }));
  });

  /*
  FNXC:ReviewRemediationDeclineNarration 2026-11-06-16:41 (RUFU-351):
  The deduplication half of the invariant for the THROW class. A recovery that narrates its own
  decline and THEN unwinds must leave exactly one sentence on the card. This row is the only thing
  that catches a second `const narrationWitness` reappearing inside the `try`: the inner object was
  the one handed to the helper, while the `catch` resolved the outer declaration nothing ever set,
  so the guard read as "nothing was narrated" on every throw and the card got a duplicate line.
  */
  it("writes no second sentence when a recovery narrated its decline and then threw", async () => {
    const store = createSweepStore(declinedTask());
    const manager = new SelfHealingManager(store as never, {
      rootDir: "/tmp/rufu-351",
      recoverFailedPreMergeStep: vi.fn(async () => false),
      recoverFailedPreMergeStepDetailed: vi.fn(async (_task, options) => {
        // Stand in for a narrated decline (checkout/hold/budget) that crashes on the way out.
        await store.logEntry("RUFU-351", "Failed pre-merge step recovery not scheduled — checkout unavailable", "Step: Code Review");
        options?.narrationWitness && (options.narrationWitness.narrated = true);
        throw new Error("synthetic crash after narrating");
      }),
    });

    await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);

    // Exactly the recovery owner's own line survives; the sweep adds nothing.
    expect(store.logEntry).toHaveBeenCalledTimes(1);
    expect(declineRows(store)).toHaveLength(0);
  });

  /*
  FNXC:ReviewRemediationDeclineNarration 2026-11-06-16:41 (RUFU-351):
  The verdict-less pre-pass owns a failed gate with no verdict — its recovery is a fresh GATE RUN,
  and it narrates that itself (`[pre-merge] Self-healing re-seeded the failed no-verdict review
  gate.`). This sweep must not stack a remediation-decline sentence on top of that explanation.
  */
  it("stays silent for a verdict-less failed gate the re-seed pre-pass owns", async () => {
    const codingIr = getBuiltinWorkflow("builtin:coding")!.ir;
    const verdictless = declinedTask({
      enabledWorkflowSteps: ["code-review"],
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        status: "failed",
        reviewKind: "code",
        // No verdict: the reviewer dispatch died, so no findings exist to remediate.
        startedAt: "2026-09-26T10:00:00.000Z",
        completedAt: "2026-09-26T10:05:00.000Z",
      }],
    });
    const store = createSweepStore(verdictless);
    (store.getWorkflowDefinition as ReturnType<typeof vi.fn>).mockResolvedValue({ ir: codingIr });
    (store.listWorkflowDefinitions ?? vi.fn()).mockResolvedValue?.([{ ir: codingIr }]);
    (store.getTaskWorkflowSelection as ReturnType<typeof vi.fn>)
      .mockReturnValue({ workflowId: "builtin:coding", stepIds: ["code-review"] });
    const recoverDetailed = vi.fn(async () => ({ kind: "skipped" as const }));
    const reseedOwner = vi.fn(async () => "rerouted");
    const manager = new SelfHealingManager(store as never, {
      rootDir: "/tmp/rufu-351",
      recoverFailedPreMergeStep: vi.fn(async () => false),
      recoverFailedPreMergeStepDetailed: recoverDetailed,
      rerouteFailedNoVerdictPreMergeReview: reseedOwner,
    });

    await manager.recoverReviewTasksWithFailedPreMergeSteps();

    // The pre-pass owned it, and its own durable line is what the operator reads.
    expect(reseedOwner).toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "RUFU-351",
      expect.stringContaining("re-seeded the failed no-verdict review gate"),
    );
    // This sweep contributes nothing: no decline sentence, no audit row, no delegated recovery.
    expect(store.logEntry.mock.calls.filter((call) => String(call[1]).startsWith("Failed pre-merge step")))
      .toHaveLength(0);
    expect(recoverDetailed).not.toHaveBeenCalled();
    expect(declineRows(store)).toHaveLength(0);
  });

  it("stays silent for a superseded probe — a newer round owns the row", async () => {
    const store = createSweepStore(declinedTask());
    const manager = new SelfHealingManager(store as never, {
      rootDir: "/tmp/rufu-351",
      recoverFailedPreMergeStep: vi.fn(async () => false),
      recoverFailedPreMergeStepDetailed: vi.fn(async () => ({ kind: "superseded" as const })),
    });

    await manager.recoverReviewTasksWithFailedPreMergeSteps();

    expect(store.logEntry).not.toHaveBeenCalled();
    expect(declineRows(store)).toHaveLength(0);
  });

  it("stays silent for classes another owner narrates", async () => {
    // Paused card: the pause badge is the operator-facing explanation.
    const pausedStore = createSweepStore(declinedTask({ paused: true }));
    const pausedManager = new SelfHealingManager(pausedStore as never, {
      rootDir: "/tmp/rufu-351",
      recoverFailedPreMergeStep: vi.fn(async () => false),
      recoverFailedPreMergeStepDetailed: vi.fn(async () => ({ kind: "skipped" as const })),
    });
    await expect(pausedManager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);
    expect(pausedStore.logEntry).not.toHaveBeenCalled();
    expect(declineRows(pausedStore)).toHaveLength(0);

    // Exhausted budget at convergence stage 3: the ladder already parked the card with its own notice.
    const ladderTask = declinedTask({
      reviewConvergenceStage: 3,
      postReviewFixCount: 1,
      // One durable attempt on the Code Review episode: max 1 (settings) reached, stage 3 escalated.
      log: [{
        timestamp: new Date().toISOString(),
        action: "Auto-reviving in-review task with failed pre-merge workflow step (attempt 1/1)",
        outcome: "Step: Code Review",
      }],
    } as Partial<Task>);
    const ladderStore = createSweepStore(ladderTask);
    (ladderStore.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ ...sweepSettings, maxPostReviewFixes: 1 });
    const ladderManager = new SelfHealingManager(ladderStore as never, {
      rootDir: "/tmp/rufu-351",
      recoverFailedPreMergeStep: vi.fn(async () => false),
      recoverFailedPreMergeStepDetailed: vi.fn(async () => ({ kind: "skipped" as const })),
    });
    await expect(ladderManager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);
    expect(ladderStore.logEntry).not.toHaveBeenCalled();
    expect(declineRows(ladderStore)).toHaveLength(0);
  });

  it("narrates without moving the card or touching any stall, suppression, or status field", async () => {
    /*
    FNXC:ReviewRemediationDeclineNarration 2026-09-27-06:25 (RUFU-351):
    Lifecycle containment is a hard acceptance criterion: the narration is an ADDITION to a card that
    stays in its review lane. The stall badge stays the authority on why the card cannot merge — this
    sweep's sentence explains why remediation was not scheduled, which is a different question, so the
    narration must not write task fields at all.
    */
    const store = createSweepStore(declinedTask({ worktree: null, branch: null }));
    const manager = new SelfHealingManager(store as never, {
      rootDir: "/tmp/rufu-351",
      recoverFailedPreMergeStep: vi.fn(async () => false),
      recoverFailedPreMergeStepDetailed: vi.fn(async () => ({ kind: "skipped" as const })),
    });

    await manager.recoverReviewTasksWithFailedPreMergeSteps();

    expect(store.updateTask).not.toHaveBeenCalled();
    for (const call of store.logEntry.mock.calls) {
      expect(call[1]).toContain("Failed pre-merge step");
    }
  });

  it("emits one decline row per narrated decline across sweeps, and none for a scheduled round", async () => {
    const store = createSweepStore(declinedTask({ worktree: null, branch: null }));
    const manager = new SelfHealingManager(store as never, {
      rootDir: "/tmp/rufu-351",
      recoverFailedPreMergeStep: vi.fn(async () => false),
      recoverFailedPreMergeStepDetailed: vi.fn(async () => ({ kind: "skipped" as const })),
    });

    await manager.recoverReviewTasksWithFailedPreMergeSteps();
    await manager.recoverReviewTasksWithFailedPreMergeSteps();
    expect(declineRows(store)).toHaveLength(2);
    expect(store.logEntry).toHaveBeenCalledTimes(2);

    const scheduledStore = createSweepStore(declinedTask());
    const scheduledManager = new SelfHealingManager(scheduledStore as never, {
      rootDir: "/tmp/rufu-351",
      recoverFailedPreMergeStep: vi.fn(async () => true),
      recoverFailedPreMergeStepDetailed: vi.fn(async () => ({ kind: "scheduled" as const, producer: "named" as const })),
    });

    await expect(scheduledManager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(1);
    expect(declineRows(scheduledStore)).toHaveLength(0);
    expect(scheduledStore.logEntry).not.toHaveBeenCalled();
  });

  it("still emits the audit row when the card log rejects", async () => {
    const store = createSweepStore(declinedTask({ worktree: null, branch: null }));
    (store.logEntry as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("card log unavailable"));
    const manager = new SelfHealingManager(store as never, {
      rootDir: "/tmp/rufu-351",
      recoverFailedPreMergeStep: vi.fn(async () => false),
      recoverFailedPreMergeStepDetailed: vi.fn(async () => ({ kind: "skipped" as const })),
    });

    await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);

    expect(declineRows(store)).toHaveLength(1);
  });

  /*
  FNXC:ReviewRemediationDeclineNarration 2026-11-06-17:41 (RUFU-351 code review):
  The cases below drive the REAL recovery helper through the REAL sweep. Every anti-duplication case
  above substitutes a fake recovery, so none of them could catch a hand-off the helper itself forgets
  to mark. Two delegated owners write their own durable card sentence and then hand back `skipped`:
  the empty-review close (`No reviewable content — terminal park recorded for <step>`) and the
  convergence ladder's human-escalation rungs. An unmarked witness made the sweep append its own
  "remediation not produced — card left in review" line plus a `skipped-without-narration` audit row
  on top of the owner's true sentence — two operator lines for one decline, the second one false on
  both counts, and a code whose documented meaning is "we do not know why".
  */
  const realHelperFor = (
    store: ReturnType<typeof createSweepStore>,
    budget: { unbounded: boolean; max: number; label: string; key: string; attempts: number },
    extra: Record<string, unknown> = {},
  ) => vi.fn(async (task: Task, options?: RecoverFailedPreMergeStepCallOptions) =>
    recoverFailedPreMergeWorkflowStepDetailed({
      store,
      getRunContextFor: () => undefined,
      resolveFailedPreMergeWorkflowStepBudget: vi.fn(async () => budget),
      sendTaskBackForFix: vi.fn(async () => undefined),
      ...extra,
    } as never, task, options));

  const sweepFor = (
    store: ReturnType<typeof createSweepStore>,
    recoverDetailed: ReturnType<typeof realHelperFor>,
  ) => new SelfHealingManager(store as never, {
    rootDir: "/tmp/rufu-351",
    // The detailed lane is what production always wires (`in-process-runtime.ts`); the boolean stub
    // stays present only so a mis-wired test cannot silently fall back to the witness-less path.
    recoverFailedPreMergeStep: vi.fn(async () => false),
    recoverFailedPreMergeStepDetailed: recoverDetailed,
  });

  const narratedActions = (store: ReturnType<typeof createSweepStore>) =>
    store.logEntry.mock.calls.map((call) => String(call[1]));

  it("leaves the empty-review terminal park as the card's only sentence (real helper, pre-producer close)", async () => {
    // FN-267's definite-empty Code Review REVISE, the shape this sweep admits on purpose.
    const store = createSweepStore(declinedTask({
      workflowStepResults: [failedCodeReview({
        reviewKind: "code",
        reviewInputFingerprint: EMPTY_REVIEW_DIFF_FINGERPRINT,
        findings: [],
      })],
    }));

    await expect(sweepFor(store, realHelperFor(store, {
      unbounded: false, max: 3, label: "3", key: "pre-merge-optional-step:WS-CR", attempts: 1,
    })).recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);

    // Exactly one operator-facing line, and it is the close's own park sentence naming the gate.
    expect(narratedActions(store)).toEqual(["No reviewable content — terminal park recorded for Code Review"]);
    // The decline the ladder explained is not "we do not know why": no fallback row either.
    expect(declineRows(store)).toHaveLength(0);
  });

  it("marks the witness for the empty-review close that runs after the producer declines", async () => {
    const store = createSweepStore(declinedTask({
      workflowStepResults: [failedCodeReview({
        reviewKind: "code",
        reviewInputFingerprint: EMPTY_REVIEW_DIFF_FINGERPRINT,
        findings: [],
      })],
    }));

    await expect(sweepFor(store, realHelperFor(store, {
      unbounded: false, max: 3, label: "3", key: "pre-merge-optional-step:WS-CR", attempts: 1,
    }, { appendReviewRemediationSteps: vi.fn(async () => "released-no-actionable-findings") }))
      .recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);

    expect(narratedActions(store)).toEqual(["No reviewable content — terminal park recorded for Code Review"]);
    expect(declineRows(store)).toHaveLength(0);
  });

  it("leaves the convergence ladder's human-escalation notice as the card's only sentence (real helper)", async () => {
    // A repeat-unchanged Code Review REVISE already at convergence stage 2: the next ladder rung is
    // the human one, which parks the card `awaiting-approval` after narrating its own line.
    const store = createSweepStore(declinedTask({
      reviewConvergenceStage: 2,
      workflowStepResults: [failedCodeReview({ priorAttempts: [failedCodeReview()] })],
    }));
    const recoverDetailed = realHelperFor(store, {
      unbounded: false, max: 3, label: "3", key: "pre-merge-optional-step:WS-CR", attempts: 1,
    });

    await expect(sweepFor(store, recoverDetailed).recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);

    // The delegated recovery really ran and really handed off to the ladder.
    expect(recoverDetailed).toHaveBeenCalledTimes(1);
    expect(narratedActions(store)).toEqual(["Review convergence exhausted — awaiting operator action"]);
    expect(declineRows(store)).toHaveLength(0);
  });

  /*
  FNXC:ReviewRemediationDeclineNarration 2026-11-06-17:41 (RUFU-351 code review):
  The converse half of the hand-off rule is pinned in `recover-failed-pre-merge-step.ts`: only a
  hand-off whose owner provably narrated marks the witness. The ladder's `"declined"` arms (pause,
  auto-merge hold, lost gate race, failed rung) write nothing, so they must stay unmarked — a
  suppression driven by another owner's silence is this task's own symptom. The unmarked path is
  pinned above (`leaves the witness untouched when no sentence was written`) and by the sweep case
  that narrates a mute `skipped`; every ladder arm reachable in this harness narrates or escalates.
  */
});

/*
FNXC:ReviewRemediationDeclineNarration 2026-11-06-16:41 (RUFU-351):
Symptom Verification test 4 — a NO-REGRESSION GUARD, explicitly NOT symptom proof. Forensics (the
`forensics` task document) showed the graph-terminal leg had ALREADY narrated RUFU-274 durably at
03:52:51Z, which is precisely why RUFU-351 added no narration there: a second sentence for one
condition is the defect the repository names in `handle-graph-failure.ts` ("a second park message
here would be the duplicate operator noise this task exists to remove"). Because that premise lives
in code this task does not touch, it is pinned here: if a future edit drops or doubles the
graph-leg sentence, this row goes red. It must not be read as proof that the incident was mute.
*/
describe("graph-terminal decline — no-regression guard (not symptom proof)", () => {
  beforeEach(() => resetExecutorMocks());

  const codingIr = getBuiltinWorkflow("builtin:coding")!.ir;

  /** RUFU-274's durable row exactly as forensics measured it against the live board. */
  const incidentTask = (): Task => ({
    id: "RUFU-274",
    title: "Incident victim card (read-only evidence for RUFU-351)",
    description: "",
    column: "in-review",
    status: null,
    error: null,
    paused: false,
    autoMerge: true,
    worktree: "/tmp/rufu-274",
    branch: "fusion/rufu-274",
    dependencies: [],
    steps: [{ name: "Implement", status: "done" }],
    currentStep: 0,
    log: [],
    graphResumeRetryCount: 1,
    mergeRetries: 0,
    recoveryRetryCount: 0,
    taskSessionRetryCount: 0,
    enabledWorkflowSteps: ["code-review"],
    workflowStepResults: [
      { workflowStepId: "plan-review", workflowStepName: "Plan Review", status: "passed", reviewKind: "plan", verdict: "APPROVE" },
      {
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        status: "failed",
        reviewKind: "code",
        verdict: "REVISE",
        output: "P0: the tests do not drive any production lane.",
        findings: [{ severity: "P0", detail: "The tests do not drive any production lane." }],
        reviewInputFingerprint: "sha256:1e379e0458352446b9e2d717b371a1d272890a0a",
        startedAt: "2026-09-27T03:39:18.810Z",
        completedAt: "2026-09-27T03:52:24.308Z",
      },
    ],
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-27T03:52:24.308Z",
  } as Task);

  const graphLegStore = (task: Task) => ({
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ autoMerge: true })),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: ["code-review"] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: ["code-review"] })),
    getWorkflowDefinition: vi.fn(async (id: string) => (id === "builtin:coding" ? { ir: codingIr } : undefined)),
    listWorkflowDefinitions: vi.fn(async () => [{ ir: codingIr }]),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    updateTaskAtomic: vi.fn(async (_id: string, reduce: (t: Task) => Partial<Task> | null) => {
      const patch = reduce(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
  });

  it("NO-REGRESSION GUARD: the graph-terminal park still narrates the declined remediation exactly once", async () => {
    const live = incidentTask();
    const store = Object.assign(createMockStore(), graphLegStore(live));
    store.getTask.mockResolvedValue(live);
    const executor = new TaskExecutor(store, "/tmp/rufu-274");
    vi.spyOn(executor as any, "routeRetryableRemediationGraphFailureToPreMergeFix").mockResolvedValue(false);
    vi.spyOn(executor as any, "routeGraphFailureToExecutionResume").mockResolvedValue(false);
    // The remediation producer declines: this fall-through is what the durable park exists for.
    vi.spyOn(executor as any, "requestPreMergeOptionalStepFix").mockResolvedValue(false);

    await (executor as any).handleGraphFailure(live, {
      disposition: "failed",
      outcome: "failure",
      reason: "remediation-not-scheduled",
      visitedNodeIds: ["code-review"],
      context: { "node:code-review:outcome": "failure", "node:code-review:value": "remediation-not-scheduled" },
    });

    const narrated = (store.logEntry.mock.calls as Array<[string, string | undefined]>)
      .filter(([, action]) => typeof action === "string" && action.includes("Code Review"));
    expect(narrated).toHaveLength(1);
    expect(narrated[0][1]).toContain("remediation was not scheduled");
    // The graph leg keeps ITS sentence: the sweep family's sentences must not appear on this path.
    expect(narrated[0][1]).not.toContain("recovery not scheduled");
    expect(narrated[0][1]).not.toContain("remediation not produced");
  });
});
