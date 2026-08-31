import { describe, expect, it, vi } from "vitest";
import type { Task, WorkflowStepResult } from "@fusion/core";

import { recoverFailedPreMergeWorkflowStepDetailed } from "../executor/recover-failed-pre-merge-step.js";
import { claimRemediationAttempt } from "../executor/claim-review-remediation-attempt.js";
import { SelfHealingManager } from "../self-healing.js";

/*
FNXC:LifecycleContainment 2026-08-30-13:36:
FN-267 admission claim is only a concurrency fence if it TRAVELS with the recovery it authorized.
The sweep previously called the legacy boolean delegate and then released unconditionally, so a
genuine refusal cleared its own claim and was re-narrated on every five-minute sweep — the exact
unbounded loop this task exists to close — while a newer review round could be remediated from a
stale snapshot with nothing to stop it.

These cases drive the REAL sweep (`recoverReviewTasksWithFailedPreMergeSteps`) against the REAL
claim helpers, and the supersession case drives the real recovery, so the interleaving is
production's rather than a restatement of the helper's unit contract.
*/

function failedReviewRow(): Task {
  return {
    id: "FN-267-claim",
    title: "Claim threading",
    description: "A failed Code Review round awaiting remediation.",
    column: "in-review",
    worktree: "/tmp/fn-267-claim",
    dependencies: [],
    steps: [],
    currentStep: 0,
    status: null,
    paused: false,
    autoMerge: true,
    reviewConvergenceStage: 0,
    log: [],
    createdAt: "2026-08-30T09:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
    workflowStepResults: [{
      workflowStepId: "code-review",
      workflowStepName: "Code Review",
      phase: "pre-merge",
      status: "failed",
      verdict: "REVISE",
      reviewKind: "code",
      reviewInputFingerprint: "round-one",
      startedAt: "2026-08-30T10:00:00.000Z",
      completedAt: "2026-08-30T10:01:00.000Z",
      findings: [{
        id: "critical-claim-not-threaded",
        severity: "critical",
        filePath: "packages/engine/src/self-healing.ts",
        line: 9489,
        title: "Claim is not threaded through recovery",
        body: "Thread the descriptor through the real recovery path.",
      }],
    }],
  } as unknown as Task;
}

function sweepStore(row: Task) {
  const entries: { action: string; outcome?: string }[] = [];
  /* Ordered trail of the two durable acts a refusal performs, so their ORDER can be asserted. */
  const trail: string[] = [];
  return {
    entries,
    trail,
    getSettings: vi.fn(async () => ({ autoMerge: true, globalPause: false, enginePaused: false, maxPostReviewFixes: 3 })),
    listTasks: vi.fn(async () => [row]),
    getTask: vi.fn(async () => row),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(row, patch)),
    logEntry: vi.fn(async (_id: string, action: string, outcome?: string) => {
      entries.push({ action, outcome });
      if (action.includes("remediation not produced")) trail.push("refusal-explained");
    }),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getWorkflowDefinition: vi.fn(async () => undefined),
    /*
    The cross-process seam the coupled refusal prefers: ONE advisory-locked transaction carrying the
    marker and the entry. The fake mirrors its contract — a compute returning null applies nothing.
    */
    updateWorkflowStepResultsWithLogFenced: vi.fn(async (
      _id: string,
      compute: (current: Task) => { workflowStepResults: WorkflowStepResult[]; logEntry: { timestamp: string; action: string; outcome?: string } } | null,
    ) => {
      const patch = compute(row);
      if (!patch) return { applied: false as const, reason: "refused" as const };
      if (patch.workflowStepResults.some((result) => result.remediationRefusedReason)) trail.push("refusal-stamped");
      entries.push({ action: patch.logEntry.action, outcome: patch.logEntry.outcome });
      if (patch.logEntry.action.includes("remediation not produced")) trail.push("refusal-explained");
      row.workflowStepResults = patch.workflowStepResults;
      row.log = [...(row.log ?? []), patch.logEntry];
      return { applied: true as const, task: row };
    }),
    /* Fallback seam for stores without the fenced writer. */
    updateTaskAtomic: vi.fn(async (_id: string, updater: (current: Task) => Partial<Task> | null) => {
      const patch = updater(row);
      if (!patch) return row;
      if (patch.workflowStepResults?.some((result) => result.remediationRefusedReason)) trail.push("refusal-stamped");
      for (const appended of (patch.log ?? []).slice((row.log ?? []).length)) {
        entries.push({ action: appended.action, outcome: appended.outcome });
        if (appended.action.includes("remediation not produced")) trail.push("refusal-explained");
      }
      Object.assign(row, patch);
      return row;
    }),
    updateWorkflowStepResultsFenced: vi.fn(async (
      _id: string,
      compute: (current: Task) => { workflowStepResults: WorkflowStepResult[] } | null,
    ) => {
      const patch = compute(row);
      if (!patch) return { applied: false as const, reason: "refused" as const };
      if (patch.workflowStepResults.some((result) => result.remediationRefusedReason)) trail.push("refusal-stamped");
      row.workflowStepResults = patch.workflowStepResults;
      return { applied: true as const, task: row };
    }),
  };
}

const claimOf = (row: Task) => row.workflowStepResults?.[0] as WorkflowStepResult;
const revivalEntries = (store: ReturnType<typeof sweepStore>) =>
  store.entries.filter((entry) => entry.action.startsWith("Auto-reviving in-review task"));
const refusalEntries = (store: ReturnType<typeof sweepStore>) =>
  store.entries.filter((entry) => entry.action === "Failed pre-merge step remediation not produced — card left in review");

describe("FN-267 the sweep's admission claim fences the recovery it authorized", () => {
  it("retains a refused claim, explains it once, and never re-admits the unchanged review", async () => {
    const row = failedReviewRow();
    const store = sweepStore(row);
    const recoverFailedPreMergeStepDetailed = vi.fn(async () => ({
      kind: "refused" as const, reason: "no-actionable-findings" as const, gate: "Code Review",
    }));
    const manager = new SelfHealingManager(store as never, {
      rootDir: "/tmp/fn-267-claim",
      recoverFailedPreMergeStep: vi.fn(async () => true),
      recoverFailedPreMergeStepDetailed,
    } as never);

    try {
      await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);

      // The recovery ran INSIDE the claim it was admitted under.
      expect(recoverFailedPreMergeStepDetailed).toHaveBeenCalledTimes(1);
      expect(recoverFailedPreMergeStepDetailed.mock.calls[0]![1]).toEqual({
        claim: {
          workflowStepId: "code-review",
          signature: expect.any(String),
          owner: expect.stringMatching(/^self-healing:/),
        },
      });
      // A refusal RETAINS its claim; releasing it is what re-opened the loop.
      expect(claimOf(row).remediationRefusedReason).toBe("no-actionable-findings");
      expect(claimOf(row).remediationAttemptOwner).toEqual(expect.stringMatching(/^self-healing:/));
      expect(revivalEntries(store)).toHaveLength(1);
      expect(refusalEntries(store)).toHaveLength(1);
      expect(refusalEntries(store)[0]!.outcome).toContain("Reason: no-actionable-findings");
      /*
      The explanation is written while ownership still validates, BEFORE the refusal is stamped.
      Stamping first leaves the narration outside any ownership check — a superseded runner could
      then explain an obsolete round — and the fence cannot cover it afterwards, because a stamped
      refusal no longer classifies as owned.
      */
      /*
      Both effects come from ONE mutation, so no supersession window can separate the marker that
      suppresses future attempts from the entry that explains the card. Asserting the single atomic
      call is the point; their order inside it is incidental.
      */
      expect([...store.trail].sort()).toEqual(["refusal-explained", "refusal-stamped"]);
      expect(store.updateWorkflowStepResultsWithLogFenced).toHaveBeenCalledTimes(1);
      const consumedBudget = row.postReviewFixCount;

      // Second sweep over the SAME unchanged review: refused before any attempt, narration, or increment.
      await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);
      expect(recoverFailedPreMergeStepDetailed).toHaveBeenCalledTimes(1);
      expect(revivalEntries(store)).toHaveLength(1);
      expect(refusalEntries(store)).toHaveLength(1);
      expect(row.postReviewFixCount).toBe(consumedBudget);
    } finally {
      manager.stop();
    }
  });

  it("writes neither marker nor explanation when the round is superseded at the mutation boundary", async () => {
    const row = failedReviewRow();
    const store = sweepStore(row);
    /*
    The hostile interleaving the fence alone could not close: the round changes INSIDE the atomic
    mutation boundary, after the runner decided to refuse. Because ownership is validated in the
    same mutation that writes both effects, neither lands.
    */
    const supersedeAtBoundary = () => {
      row.workflowStepResults = [{
        ...claimOf(row),
        reviewInputFingerprint: "round-two-boundary",
        findings: [{
          id: "critical-boundary", severity: "critical", title: "Newer at the boundary",
          body: "Different feedback.", filePath: "packages/engine/src/self-healing.ts",
        }],
      }] as WorkflowStepResult[];
    };
    const originalFenced = store.updateWorkflowStepResultsWithLogFenced;
    store.updateWorkflowStepResultsWithLogFenced = vi.fn(async (id: string, compute: Parameters<typeof originalFenced>[1]) => {
      /* A second engine replaces the round inside the transaction boundary, before the compute reads. */
      if (claimOf(row).remediationAttemptOwner) supersedeAtBoundary();
      return originalFenced(id, compute);
    }) as typeof store.updateWorkflowStepResultsWithLogFenced;

    const recoverFailedPreMergeStepDetailed = vi.fn(async () => ({
      kind: "refused" as const, reason: "no-actionable-findings" as const, gate: "Code Review",
    }));
    const manager = new SelfHealingManager(store as never, {
      rootDir: "/tmp/fn-267-claim",
      recoverFailedPreMergeStep: vi.fn(async () => true),
      recoverFailedPreMergeStepDetailed,
    } as never);

    try {
      await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);

      expect(refusalEntries(store)).toHaveLength(0);
      expect(claimOf(row).remediationRefusedReason).toBeUndefined();
      expect(store.trail).toEqual([]);
    } finally {
      manager.stop();
    }
  });

  it("writes no refusal explanation when the round is superseded before the refusal write", async () => {
    const row = failedReviewRow();
    const store = sweepStore(row);
    /* The newer round lands after the recovery refuses and before the explanation is written. */
    const recoverFailedPreMergeStepDetailed = vi.fn(async () => {
      row.workflowStepResults = [{
        ...claimOf(row),
        reviewInputFingerprint: "round-two",
        findings: [{
          id: "critical-newer", severity: "critical", title: "Newer round",
          body: "Different feedback.", filePath: "packages/engine/src/self-healing.ts",
        }],
      }] as WorkflowStepResult[];
      return { kind: "refused" as const, reason: "no-actionable-findings" as const, gate: "Code Review" };
    });
    const manager = new SelfHealingManager(store as never, {
      rootDir: "/tmp/fn-267-claim",
      recoverFailedPreMergeStep: vi.fn(async () => true),
      recoverFailedPreMergeStepDetailed,
    } as never);

    try {
      await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);

      // No stale explanation, and the newer round carries no refusal it never earned.
      expect(refusalEntries(store)).toHaveLength(0);
      expect(claimOf(row).remediationRefusedReason).toBeUndefined();
    } finally {
      manager.stop();
    }
  });

  it("skips a retained refusal at the candidate filter, before any claim attempt", async () => {
    const row = failedReviewRow();
    const store = sweepStore(row);
    const recoverFailedPreMergeStepDetailed = vi.fn(async () => ({
      kind: "refused" as const, reason: "no-actionable-findings" as const, gate: "Code Review",
    }));
    const manager = new SelfHealingManager(store as never, {
      rootDir: "/tmp/fn-267-claim",
      recoverFailedPreMergeStep: vi.fn(async () => true),
      recoverFailedPreMergeStepDetailed,
    } as never);

    try {
      await manager.recoverReviewTasksWithFailedPreMergeSteps();
      expect(claimOf(row).remediationRefusedReason).toBe("no-actionable-findings");
      const fencedWritesAfterFirstSweep = store.updateWorkflowStepResultsFenced.mock.calls.length;

      // The refused round is excluded BEFORE admission: no claim CAS is even attempted.
      await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);
      expect(store.updateWorkflowStepResultsFenced.mock.calls.length).toBe(fencedWritesAfterFirstSweep);
      expect(revivalEntries(store)).toHaveLength(1);

      // A changed review input is re-admitted, so the filter cannot strand the card.
      row.workflowStepResults = [{
        ...claimOf(row),
        reviewInputFingerprint: "round-two",
        findings: [{
          id: "critical-second", severity: "critical", title: "Newer",
          body: "Different feedback.", filePath: "packages/engine/src/self-healing.ts",
        }],
      }] as WorkflowStepResult[];
      await manager.recoverReviewTasksWithFailedPreMergeSteps();
      expect(store.updateWorkflowStepResultsFenced.mock.calls.length).toBeGreaterThan(fencedWritesAfterFirstSweep);
      expect(revivalEntries(store)).toHaveLength(2);
    } finally {
      manager.stop();
    }
  });

  it("re-admits the card once the review round actually changes", async () => {
    const row = failedReviewRow();
    const store = sweepStore(row);
    const recoverFailedPreMergeStepDetailed = vi.fn(async () => ({
      kind: "refused" as const, reason: "no-actionable-findings" as const, gate: "Code Review",
    }));
    const manager = new SelfHealingManager(store as never, {
      rootDir: "/tmp/fn-267-claim",
      recoverFailedPreMergeStep: vi.fn(async () => true),
      recoverFailedPreMergeStepDetailed,
    } as never);

    try {
      await manager.recoverReviewTasksWithFailedPreMergeSteps();
      expect(recoverFailedPreMergeStepDetailed).toHaveBeenCalledTimes(1);

      // A genuinely new review round: new input, so the durable refusal must not silence it.
      row.workflowStepResults = [{
        ...claimOf(row),
        reviewInputFingerprint: "round-two",
        findings: [{
          id: "critical-second-round",
          severity: "critical",
          filePath: "packages/engine/src/self-healing.ts",
          line: 1,
          title: "A newer finding",
          body: "Different feedback.",
        }],
      }] as WorkflowStepResult[];

      await manager.recoverReviewTasksWithFailedPreMergeSteps();
      expect(recoverFailedPreMergeStepDetailed).toHaveBeenCalledTimes(2);
      expect(revivalEntries(store)).toHaveLength(2);
    } finally {
      manager.stop();
    }
  });

  it("releases the claim after a scheduled hand-off so a later round is admitted", async () => {
    const row = failedReviewRow();
    const store = sweepStore(row);
    const manager = new SelfHealingManager(store as never, {
      rootDir: "/tmp/fn-267-claim",
      recoverFailedPreMergeStep: vi.fn(async () => true),
      recoverFailedPreMergeStepDetailed: vi.fn(async () => ({ kind: "scheduled" as const })),
    } as never);

    try {
      await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(1);
      expect(claimOf(row).remediationAttemptOwner).toBeUndefined();
      expect(claimOf(row).remediationRefusedReason).toBeUndefined();
      expect(refusalEntries(store)).toHaveLength(0);
    } finally {
      manager.stop();
    }
  });

  it("narrates no refusal when a newer round lands before a claimed recovery's refusal branch", async () => {
    /*
    The claimed recovery reaches a REFUSAL branch (an invalid revision budget) rather than a
    hand-off. Those branches narrate on the task, so they must be fenced too: the entry target check
    passed, and the newer round lands before the refusal is written. The card keeps its worktree so
    the sweep's own candidate filter still admits it — without that, recovery never runs and the case
    would prove nothing.
    */
    const row = failedReviewRow();
    const store = sweepStore(row);
    const sendTaskBackForFix = vi.fn(async () => undefined);

    const recoverFailedPreMergeStepDetailed = vi.fn(async (task: Task, options: { claim: { workflowStepId: string; signature: string; owner: string } }) =>
      recoverFailedPreMergeWorkflowStepDetailed({
        store: store as never,
        getRunContextFor: () => undefined,
        resolveFailedPreMergeWorkflowStepBudget: vi.fn(async () => ({
          unbounded: false, max: 0, label: "0", key: "code-review", attempts: 0,
        })),
        sendTaskBackForFix,
      } as never, task, options));

    // A newer round replaces the claimed one while the recovery reads settings.
    store.getSettings.mockImplementation(async () => {
      if (claimOf(row).remediationAttemptOwner) {
        row.workflowStepResults = [{
          ...claimOf(row),
          reviewInputFingerprint: "round-two",
          findings: [{
            id: "critical-newer", severity: "critical", title: "Newer round",
            body: "Different feedback.", filePath: "packages/engine/src/self-healing.ts",
          }],
        }] as WorkflowStepResult[];
      }
      return { autoMerge: true, globalPause: false, enginePaused: false, maxPostReviewFixes: 3 };
    });

    const manager = new SelfHealingManager(store as never, {
      rootDir: "/tmp/fn-267-claim",
      recoverFailedPreMergeStep: vi.fn(async () => true),
      recoverFailedPreMergeStepDetailed,
    } as never);

    try {
      await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);

      // The budget refusal was never attributed to the newer round.
      expect(store.entries.filter((entry) => entry.action.includes("revision budget zero/invalid"))).toHaveLength(0);
      expect(sendTaskBackForFix).not.toHaveBeenCalled();
      expect(refusalEntries(store)).toHaveLength(0);
      expect(claimOf(row).remediationRefusedReason).toBeUndefined();
    } finally {
      manager.stop();
    }
  });

  it("goes silent when a newer review round replaces the claimed one mid-attempt", async () => {
    const row = failedReviewRow();
    const store = sweepStore(row);
    const appendReviewRemediationSteps = vi.fn(async () => "appended" as const);
    const sendTaskBackForFix = vi.fn(async () => undefined);
    const addTaskComment = vi.fn(async () => undefined);
    const moveTask = vi.fn(async () => row);

    // The real recovery, driven under the sweep's real claim. A newer review round lands after the
    // claim-scoped target check and before the pre-hand-off re-assert.
    const recoverFailedPreMergeStepDetailed = vi.fn(async (task: Task, options: { claim: { workflowStepId: string; signature: string; owner: string } }) =>
      recoverFailedPreMergeWorkflowStepDetailed({
        store: { ...store, addTaskComment, moveTask } as never,
        getRunContextFor: () => undefined,
        resolveFailedPreMergeWorkflowStepBudget: vi.fn(async () => {
          row.workflowStepResults = [{
            ...claimOf(row),
            reviewInputFingerprint: "round-two",
            findings: [{
              id: "critical-overtook-the-runner",
              severity: "critical",
              filePath: "packages/engine/src/self-healing.ts",
              line: 2,
              title: "A newer round landed",
              body: "The in-flight attempt no longer owns this review.",
            }],
          }] as WorkflowStepResult[];
          return { unbounded: true, max: Infinity, label: "unbounded", key: "code-review", attempts: 0 };
        }),
        appendReviewRemediationSteps,
        sendTaskBackForFix,
      } as never, task, options));

    const manager = new SelfHealingManager(store as never, {
      rootDir: "/tmp/fn-267-claim",
      recoverFailedPreMergeStep: vi.fn(async () => true),
      recoverFailedPreMergeStepDetailed,
    } as never);

    try {
      await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);

      // Nothing belonging to the newer round was remediated, moved, or commented on.
      expect(appendReviewRemediationSteps).not.toHaveBeenCalled();
      expect(sendTaskBackForFix).not.toHaveBeenCalled();
      expect(addTaskComment).not.toHaveBeenCalled();
      expect(moveTask).not.toHaveBeenCalled();
      // The overtaken runner neither condemned nor cleared the newer round.
      expect(claimOf(row).remediationRefusedReason).toBeUndefined();
      expect(refusalEntries(store)).toHaveLength(0);
      // Its own admission artifacts stand: one attempt was genuinely started and is counted.
      expect(revivalEntries(store)).toHaveLength(1);
      expect(row.postReviewFixCount).toBe(1);
    } finally {
      manager.stop();
    }
  });
});

/*
FNXC:LifecycleContainment 2026-08-30-19:52:
FN-270 regression: a Code Review REVISE left the card blocked with no fix steps, no claim marker,
and ZERO remediation entries on its timeline. Cause: every declined admission collapsed to `held`,
and both callers treat `held` as "another writer owns the story, stay quiet". A claim that could not
be written has no such writer, so the card went mute — the stranding this protocol exists to remove.
*/
describe("FN-270 an unwritable claim never mutes the card", () => {
  it("reports an unwritable claim as unavailable instead of held", async () => {
    const row = failedReviewRow();
    const store = sweepStore(row);
    /* The fenced writer accepts the call but loses the write: nobody ends up owning the round. */
    store.updateWorkflowStepResultsFenced = vi.fn(async () => ({ applied: false as const, reason: "write-lost" as never }));

    const admission = await claimRemediationAttempt(store as never, row.id, claimOf(row), "test", row);

    expect(admission.kind).toBe("unavailable");
  });

  it("still distinguishes the three outcomes that DO have an owner", async () => {
    const row = failedReviewRow();
    const store = sweepStore(row);
    const held = await claimRemediationAttempt(store as never, row.id, claimOf(row), "test", row);
    expect(held.kind).toBe("claimed");

    // A second runner over the same live claim: the first owner speaks, so this one is silent.
    expect((await claimRemediationAttempt(store as never, row.id, claimOf(row), "test", row)).kind).toBe("held");

    // A durable refusal already explained once.
    row.workflowStepResults = [{ ...claimOf(row), remediationAttemptOwner: undefined, remediationRefusedReason: "no-actionable-findings" }] as WorkflowStepResult[];
    expect((await claimRemediationAttempt(store as never, row.id, claimOf(row), "test", row)).kind).toBe("refused");
  });

  it("revives the card and explains itself when the claim cannot be written", async () => {
    const row = failedReviewRow();
    const store = sweepStore(row);
    store.updateWorkflowStepResultsFenced = vi.fn(async () => ({ applied: false as const, reason: "write-lost" as never }));
    delete (store as { updateTaskAtomic?: unknown }).updateTaskAtomic;
    const recoverFailedPreMergeStepDetailed = vi.fn(async () => ({ kind: "scheduled" as const }));
    const manager = new SelfHealingManager(store as never, {
      rootDir: "/tmp/fn-270-claim",
      recoverFailedPreMergeStep: vi.fn(async () => true),
      recoverFailedPreMergeStepDetailed,
    } as never);

    try {
      // The card is revived rather than skipped...
      await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(1);
      // ...and the timeline says why it ran unfenced, instead of showing nothing at all.
      expect(store.entries.filter((entry) => entry.action.includes("Remediation claim unavailable"))).toHaveLength(1);
      expect(revivalEntries(store)).toHaveLength(1);
    } finally {
      manager.stop();
    }
  });
});
