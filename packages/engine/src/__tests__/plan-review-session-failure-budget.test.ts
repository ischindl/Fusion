/**
 * FNXC:PlanReplanSessionBudget 2026-09-21-10:45 (RUFU-251):
 * A planner session that dies inside a live Plan Review `REVISE` episode must consume the SAME
 * replan budget the graph consumes — never a second ledger, never a second planning authority, and
 * never a synthesized Plan Review verdict — and exhaustion must park through the existing
 * `plan-review-replan-cap` operator surface.
 */
import { describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore, WorkflowStepResult } from "@fusion/core";
import {
  PLAN_REVIEW_REVISION_KEY,
  chargePlanReviewSessionFailureAttempt,
  emitPlanReviewSessionFailureBudgetAudit,
  evaluatePlanReviewSessionFailureBudget,
  isPlanReviewRevisionEpisode,
} from "../executor/plan-review-session-failure-budget.js";

const planReviewRow = (overrides: Record<string, unknown> = {}) => ({
  workflowStepId: PLAN_REVIEW_REVISION_KEY,
  workflowStepName: "Plan Review",
  status: "failed",
  verdict: "REVISE",
  startedAt: "2026-09-21T00:00:00.000Z",
  completedAt: "2026-09-21T00:01:00.000Z",
  ...overrides,
}) as unknown as WorkflowStepResult;

/** Revision-keyed marker the graph's remediation seam writes; the ledger this budget reuses. */
const graphAttemptMarker = (attempt: number) => ({
  action: `Plan Review requested a plan revision — task stays in 'triage' (attempt ${attempt}/unbounded (absolute cap 8))`,
  outcome: `Revise the step list.\nWorkflow revision key: ${PLAN_REVIEW_REVISION_KEY}`,
  timestamp: "2026-09-21T00:02:00.000Z",
});

function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-2510",
    description: "Bound the plan-replan loop",
    column: "triage",
    status: "needs-replan",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function storeFixture() {
  const logged: Array<{ action: string; outcome?: string }> = [];
  const audits: Array<{ mutationType: string; metadata: Record<string, unknown> }> = [];
  const store = {
    logEntry: vi.fn(async (_id: string, action: string, outcome?: string) => {
      logged.push({ action, outcome });
    }),
    recordRunAuditEvent: vi.fn(async (input: { mutationType: string; metadata: Record<string, unknown> }) => {
      audits.push({ mutationType: input.mutationType, metadata: input.metadata });
    }),
    getTaskWorkflowSelection: vi.fn(() => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
  } as unknown as TaskStore;
  return { store, logged, audits };
}

const settingsFixture = { planReviewReplanCap: 8 } as Settings;

describe("Plan Review session-failure budget (RUFU-251)", () => {
  describe("episode detection", () => {
    it("ignores a card with no Plan Review projection", () => {
      expect(isPlanReviewRevisionEpisode(taskFixture())).toBe(false);
    });

    it("ignores an approving or superseded projection", () => {
      const approved = taskFixture({ workflowStepResults: [planReviewRow({ status: "passed", verdict: "APPROVE" })] });
      const superseded = taskFixture({ workflowStepResults: [planReviewRow({ supersededAt: "2026-09-21T00:03:00.000Z" })] });
      expect(isPlanReviewRevisionEpisode(approved)).toBe(false);
      expect(isPlanReviewRevisionEpisode(superseded)).toBe(false);
    });

    it("recognizes a live unsuperseded REVISE request", () => {
      expect(isPlanReviewRevisionEpisode(taskFixture({ workflowStepResults: [planReviewRow()] }))).toBe(true);
    });
  });

  describe("shared budget arithmetic", () => {
    it("charges nothing outside a live REVISE episode", () => {
      const budget = evaluatePlanReviewSessionFailureBudget(taskFixture(), { cap: 8 });
      expect(budget).toMatchObject({ inRevisionEpisode: false, attemptsConsumed: 0, attempt: 1, exhausted: false });
    });

    it("counts the first session failure as turn one of the ceiling", () => {
      const task = taskFixture({ workflowStepResults: [planReviewRow({ planReviewAttemptCount: 1 })] });
      const budget = evaluatePlanReviewSessionFailureBudget(task, { cap: 8 });
      expect(budget).toMatchObject({ inRevisionEpisode: true, attemptsConsumed: 0, attempt: 1, remaining: 7, exhausted: false });
    });

    it("adds revision-keyed graph markers to the same ledger instead of a parallel count", () => {
      const task = taskFixture({
        workflowStepResults: [planReviewRow({ planReviewAttemptCount: 2 })],
        log: [graphAttemptMarker(1), graphAttemptMarker(2)],
      });
      const budget = evaluatePlanReviewSessionFailureBudget(task, { cap: 8 });
      // Two turns are already spent (the graph granted both REVISE replans), so this is turn three.
      expect(budget).toMatchObject({ attemptsConsumed: 2, attempt: 3, remaining: 5, exhausted: false });
    });

    it("exhausts on the turn past the ceiling the graph enforces", () => {
      const task = taskFixture({
        workflowStepResults: [planReviewRow({ planReviewAttemptCount: 9 })],
        log: Array.from({ length: 8 }, (_unused, index) => graphAttemptMarker(index + 1)),
      });
      const budget = evaluatePlanReviewSessionFailureBudget(task, { cap: 8 });
      expect(budget).toMatchObject({ attemptsConsumed: 8, attempt: 9, remaining: 0, exhausted: true });
    });
  });

  describe("charging", () => {
    it("is a no-op with no marker and no telemetry outside a REVISE episode", async () => {
      const { store, logged, audits } = storeFixture();
      const result = await chargePlanReviewSessionFailureAttempt(
        { store },
        taskFixture(),
        settingsFixture,
        { runContext: undefined },
      );
      expect(result.charged).toBe(false);
      expect(result.budget.inRevisionEpisode).toBe(false);
      expect(logged).toHaveLength(0);
      expect(audits).toHaveLength(0);
    });

    it("writes a revision-keyed attempt marker for a charged turn", async () => {
      const { store, logged, audits } = storeFixture();
      const task = taskFixture({ workflowStepResults: [planReviewRow({ planReviewAttemptCount: 1 })] });
      const result = await chargePlanReviewSessionFailureAttempt(
        { store },
        task,
        settingsFixture,
        { runContext: undefined },
      );
      expect(result.charged).toBe(true);
      expect(logged).toHaveLength(1);
      expect(logged[0]?.action).toMatch(/attempt 1\/8/);
      expect(logged[0]?.outcome).toContain(`Workflow revision key: ${PLAN_REVIEW_REVISION_KEY}`);
      expect(audits[0]?.metadata).toMatchObject({ outcome: "consumed", attempt: 1, cap: 8 });
    });

    it("grants the ceiling its last turn and parks on the turn past it without spending a marker", async () => {
      const lastTurn = taskFixture({
        workflowStepResults: [planReviewRow({ planReviewAttemptCount: 8 })],
        log: Array.from({ length: 7 }, (_unused, index) => graphAttemptMarker(index + 1)),
      });
      const withinBudget = storeFixture();
      const granted = await chargePlanReviewSessionFailureAttempt(
        { store: withinBudget.store },
        lastTurn,
        settingsFixture,
        { runContext: undefined },
      );
      expect(granted.charged).toBe(true);
      expect(granted.budget).toMatchObject({ attempt: 8, exhausted: false });

      const spent = taskFixture({
        workflowStepResults: [planReviewRow({ planReviewAttemptCount: 9 })],
        log: Array.from({ length: 8 }, (_unused, index) => graphAttemptMarker(index + 1)),
      });
      const exhaustedRun = storeFixture();
      const refused = await chargePlanReviewSessionFailureAttempt(
        { store: exhaustedRun.store },
        spent,
        settingsFixture,
        { runContext: undefined },
      );
      expect(refused.charged).toBe(false);
      expect(refused.budget.exhausted).toBe(true);
      expect(exhaustedRun.logged).toHaveLength(0);
      expect(exhaustedRun.audits[0]?.metadata).toMatchObject({ outcome: "exhausted", attempt: 9, cap: 8, remaining: 0 });
    });

    it("keeps run-audit metadata to ids, counts, and fixed outcomes", async () => {
      const { store, audits } = storeFixture();
      const budget = evaluatePlanReviewSessionFailureBudget(taskFixture(), { cap: 8 });
      await emitPlanReviewSessionFailureBudgetAudit(store, {
        taskId: "FN-2510",
        runContext: undefined,
        budget,
        outcome: "spec-complete-recycled",
      });
      const event = audits[0];
      expect(event?.mutationType).toBe("task:plan-replan-session-failure-budget");
      expect(Object.keys(event?.metadata ?? {}).sort()).toEqual(
        ["attempt", "cap", "outcome", "remaining", "revisionKey", "taskId"],
      );
      expect(JSON.stringify(event?.metadata)).not.toMatch(/PROMPT\.md|\/home\/|Error:/);
    });
  });

  /*
  FNXC:RunAudit 2026-09-21-13:20 (FN-9175 convention, RUFU-251):
  Optional telemetry must never become a planning lifecycle dependency, so the sink is driven hostile
  through the PRODUCTION entry point — a rejected, synchronously throwing, or hanging audit sink may
  not swallow the ledger marker or propagate out of the charge.
  */
  describe("hostile audit sink cannot alter the charge", () => {
    const hostileSinks = {
      rejected: () => vi.fn().mockRejectedValue(new Error("audit sink down")),
      synchronousThrow: () => vi.fn(() => { throw new Error("sync boom"); }),
      hanging: () => vi.fn(() => new Promise<void>(() => {})),
    } as const;

    it.each(Object.keys(hostileSinks))("%s sink still records the charged turn and resolves", async (shape) => {
      const key = shape as keyof typeof hostileSinks;
      const logged: string[] = [];
      const store = {
        logEntry: vi.fn(async (_id: string, action: string) => { logged.push(action); }),
        recordRunAuditEvent: hostileSinks[key](),
        getTaskWorkflowSelection: vi.fn(() => undefined),
        getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
      } as unknown as TaskStore;
      const task = taskFixture({ workflowStepResults: [planReviewRow()] });

      const charge = async () => chargePlanReviewSessionFailureAttempt({ store }, task, settingsFixture, { runContext: undefined });
      const outcome = key === "hanging"
        ? await (async () => {
          vi.useFakeTimers();
          try {
            const pending = charge();
            await vi.advanceTimersByTimeAsync(2_100);
            return await pending;
          } finally {
            vi.useRealTimers();
          }
        })()
        : await charge();

      expect(outcome.charged).toBe(true);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("attempt 1/8");
    });
  });
});
