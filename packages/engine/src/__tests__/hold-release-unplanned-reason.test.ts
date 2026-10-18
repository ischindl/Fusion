/*
FNXC:ExecutionAdmissionReason 2026-10-18-09:20 (RUFU-718):
`evaluateUnplannedForExecution` already returns a closed reason, but every release refusal published
only the wire code `unplanned-for-execution`, so an operator dragging a planned card out of Todo read
one generic sentence for six different conditions — and the explicit move that looked like the remedy
was the one path that armed nothing. These cases hold the fixed contract on the decision seam itself:

  (a) a genuinely planned card is admitted;
  (b) every remaining refusal carries the reason `evaluateUnplannedForExecution` computed plus a
      non-empty `detail` naming that cause and the operator's next action;
  (c) a `plan-review-pending` refusal arms the existing sanctioned Plan Review seam, so the refusal is
      never ownerless and a second identical call cannot repeat the same ownerless refusal;
  (d) nothing on the refusal path waives the gate: no move, no status clear for a real request, and no
      synthesised approving `workflowStepResults` row (FN-245's no-force contract).

Harness shape is reused from `hold-release-awaiting-planning.test.ts` (in-memory store + a tmp
PROMPT.md), with no real network, no polling, and no timers to wait on.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBootstrapPrompt,
  PLAN_REVIEW_GROUP_ID,
  type Task,
  type TaskStore,
  type WorkflowIr,
  type WorkflowWorkItem,
} from "@fusion/core";

import {
  admitTaskToWip,
  evaluateUnplannedForExecution,
  promoteHeldTask,
  releaseHeldTaskByEvent,
} from "../execution/hold-release.js";
import { getPromptPath } from "../execution/spec-staleness.js";

const WORKFLOW_ID = "custom:rufu-718";

/** The pre-fix ownerless sentence. It must stop appearing anywhere a closed reason exists. */
const LEGACY_GENERIC_UNPLANNED_SENTENCE = "This task isn't ready for execution yet — planning or plan review is still outstanding.";

/** A planned card whose plan states no repository facts, so the premise gate is vacuously satisfied. */
const PLANNED_PROMPT = "# Planned\n\n## Mission\nShip the admission-reason fix.\n\n## Steps\n\n- 1. Carry the reason.\n";

function workflow(
  release: "capacity" | "external-event" = "capacity",
  withPlanReview = true,
): WorkflowIr {
  return {
    version: "v2",
    id: WORKFLOW_ID,
    name: "RUFU-718 admission reason",
    columns: [
      { id: "todo", name: "Planning", traits: [{ trait: "hold", config: { release } }] },
      { id: "in-progress", name: "In Progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      ...(withPlanReview
        ? [{
            id: PLAN_REVIEW_GROUP_ID,
            name: "Plan Review",
            kind: "optional-group" as const,
            column: "todo",
            config: { defaultOn: true, template: { nodes: [], edges: [] } },
          }]
        : []),
      { id: "execute", kind: "prompt", column: "in-progress", config: { prompt: "execute" } },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [],
  } as WorkflowIr;
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-718",
    title: "A ready card cannot leave todo",
    description: "Move this card into in-progress",
    column: "todo",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
    columnMovedAt: "2026-10-17T00:00:00.000Z",
    ...overrides,
  } as Task;
}

/**
 * The reported live state: `todo`, a real (non-seed) PROMPT.md, `plan-review` enabled, zero
 * `plan-review` result rows, no capacity work item, not paused.
 */
function reportedCard(overrides: Partial<Task> = {}): Task {
  return task({
    approvedPlanFingerprint: "97a89ca8c84c61ec000000000000000000000000000000000000000000000000",
    enabledWorkflowSteps: ["plan-review", "code-review", "post-merge-verification"],
    workflowStepResults: [],
    ...overrides,
  });
}

interface FixtureOptions {
  ir?: WorkflowIr;
  prompt?: string;
  workItems?: WorkflowWorkItem[];
}

async function makeFixture(initial: Task, options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "fusion-rufu-718-"));
  roots.push(root);
  const tasksDir = join(root, "tasks");
  await mkdir(join(tasksDir, initial.id), { recursive: true });
  await writeFile(getPromptPath(tasksDir, initial.id), options.prompt ?? PLANNED_PROMPT, "utf8");

  const ir = options.ir ?? workflow();
  const workItems = [...(options.workItems ?? [])];
  const current = initial;
  const selection = { workflowId: WORKFLOW_ID, stepIds: [] };

  const activeTaskContinuations = () => workItems.filter(
    (item) => item.kind === "task" && ["runnable", "running", "held", "retrying"].includes(item.state),
  );
  const install = (input: WorkflowWorkItemUpsertLike): WorkflowWorkItem => {
    const created: WorkflowWorkItem = {
      id: input.id ?? `wi-${workItems.length + 1}`,
      runId: input.runId,
      taskId: input.taskId,
      nodeId: input.nodeId,
      kind: "task",
      state: "runnable",
      attempt: 0,
      retryAfter: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      blockedReason: null,
      stableWorkflowRunId: input.stableWorkflowRunId ?? null,
      continuationSequence: input.continuationSequence ?? null,
      waitReason: input.waitReason ?? null,
      sourceColumn: input.sourceColumn ?? null,
      targetColumn: input.targetColumn ?? null,
      irHash: input.irHash ?? null,
      principalAgentId: null,
      workflowRole: null,
      authorityKind: null,
      nodeInstanceId: null,
      createdAt: "2026-10-18T00:00:00.000Z",
      updatedAt: "2026-10-18T00:00:00.000Z",
    };
    workItems.push(created);
    return created;
  };

  const checkAndRecordUnplannedExecutionBlock = vi.fn(async () => true);
  const moveTaskIf = vi.fn(async (
    _id: string,
    target: string,
    predicate: (live: Task) => boolean | Promise<boolean>,
  ) => {
    if (!await predicate(current)) return { task: current, moved: false };
    current.column = target as Task["column"];
    return { task: current, moved: true };
  });
  const updateTask = vi.fn(async (_id: string, patch: Partial<Task>) => {
    Object.assign(current, patch);
    return current;
  });
  /** Mirrors the real conditional writer: one active task continuation wins, the rest refuse. */
  const seedStrandedPlanReviewContinuation = vi.fn(async (input: WorkflowWorkItemUpsertLike) => {
    if (activeTaskContinuations().length > 0) return { seeded: false as const, reason: "active-continuation" as const };
    const item = install(input);
    return { seeded: true as const, workItemId: item.id };
  });
  const replaceActiveTaskWorkflowContinuation = vi.fn(async (input: WorkflowWorkItemUpsertLike) => install(input));

  const store = {
    getSettings: vi.fn(async () => ({ maxConcurrent: 4, autoMerge: true })),
    listTasks: vi.fn(async () => [current]),
    getTask: vi.fn(async () => current),
    getTasksDir: () => tasksDir,
    getRootDir: () => root,
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir })),
    listWorkflowWorkItemsForTask: vi.fn(async () => [...workItems]),
    seedStrandedPlanReviewContinuation,
    replaceActiveTaskWorkflowContinuation,
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    checkAndRecordUnplannedExecutionBlock,
    moveTaskIf,
    updateTask,
    updateTaskAtomic: vi.fn(async (_id: string, mutate: (live: Task) => Partial<Task> | null | Promise<Partial<Task> | null>) => {
      const patch = await mutate(current);
      if (patch) Object.assign(current, patch);
      return current;
    }),
    logEntry: vi.fn(async (_id: string, message: string) => {
      current.log.push({ timestamp: "2026-10-18T00:00:00.000Z", message } as Task["log"][number]);
    }),
    recordRunAuditEvent: vi.fn(async () => undefined),
  } as unknown as TaskStore;

  return {
    store,
    current,
    ir,
    workItems,
    moveTaskIf,
    updateTask,
    updateTaskAtomic: store.updateTaskAtomic as ReturnType<typeof vi.fn>,
    logEntry: store.logEntry as ReturnType<typeof vi.fn>,
    seedStrandedPlanReviewContinuation,
    checkAndRecordUnplannedExecutionBlock,
  };
}

type WorkflowWorkItemUpsertLike = {
  id?: string;
  runId: string;
  taskId: string;
  nodeId: string;
  stableWorkflowRunId?: string | null;
  continuationSequence?: number | null;
  waitReason?: "planning" | "capacity" | null;
  sourceColumn?: string | null;
  targetColumn?: string | null;
  irHash?: string | null;
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const userMove = { moveSource: "user" as const };

describe("unplanned admission: a genuinely planned card is admitted", () => {
  it("releases the reported card once a passing Plan Review result exists", async () => {
    const planned = reportedCard({
      workflowStepResults: [{
        workflowStepId: PLAN_REVIEW_GROUP_ID,
        workflowStepName: "Plan Review",
        status: "passed",
        completedAt: "2026-10-17T00:00:00.000Z",
      }],
    });
    const fixture = await makeFixture(planned);

    const admission = await admitTaskToWip(
      fixture.store, { now: () => Date.now() }, planned, "in-progress", fixture.ir, userMove,
    );

    expect(admission.released).toBe(true);
    expect(fixture.current.column).toBe("in-progress");
    expect(fixture.checkAndRecordUnplannedExecutionBlock).not.toHaveBeenCalled();
  });
});

describe("unplanned admission: every refusal names the reason it computed", () => {
  /** Each row is the minimal durable state that makes `evaluateUnplannedForExecution` return `reason`. */
  const cases: Array<{ reason: string; build: () => { task: Task; prompt?: string; withPlanReview?: boolean } }> = [
    { reason: "plan-review-pending", build: () => ({ task: reportedCard() }) },
    {
      // FN-408's armed card keeps the Plan Review wait first, so this row carries a passing review.
      reason: "human-plan-approval-pending",
      build: () => ({
        task: reportedCard({
          workflowStepResults: [{
            workflowStepId: PLAN_REVIEW_GROUP_ID,
            workflowStepName: "Plan Review",
            status: "passed",
            completedAt: "2026-10-17T00:00:00.000Z",
          }],
          humanPlanApproval: { enabled: true, armedAt: "2026-10-17T00:00:00.000Z" } as never,
        }),
      }),
    },
    {
      // A live planner session keeps this a real refusal (see the dead-claim cases below).
      reason: "planning-status",
      build: () => ({ task: reportedCard({ status: "planning", workflowStepResults: [] }), withPlanReview: false }),
    },
    {
      reason: "needs-replan",
      build: () => ({ task: reportedCard({ status: "needs-replan", workflowStepResults: [] }), withPlanReview: false }),
    },
    {
      reason: "duplicate-prompt",
      build: () => ({ task: reportedCard({ title: "DUPLICATE: FN-12", workflowStepResults: [] }), withPlanReview: false }),
    },
    {
      reason: "seed-prompt",
      build: () => {
        const seedCard = reportedCard({ workflowStepResults: [] });
        return {
          task: seedCard,
          prompt: buildBootstrapPrompt(seedCard.id, seedCard.title, seedCard.description),
          withPlanReview: false,
        };
      },
    },
  ];

  it.each(cases)("$reason refuses with that reason plus actionable detail", async ({ reason, build }) => {
    const { task: card, prompt, withPlanReview = true } = build();
    const fixture = await makeFixture(card, { prompt, ir: workflow("capacity", withPlanReview) });
    const isPlanningStatusLive = reason === "planning-status";

    const admission = await admitTaskToWip(
      fixture.store,
      // The planning-status row is the live-planner shape: a planner session owns the card.
      { now: () => Date.now(), ...(isPlanningStatusLive ? { isTaskActive: () => true } : {}) },
      card,
      "in-progress",
      fixture.ir,
      userMove,
    );

    expect(admission.released).toBe(false);
    if (admission.released) return;
    const expected = await evaluateUnplannedForExecution(fixture.store, card, fixture.ir);
    expect(expected.unplanned).toBe(true);
    expect(admission.rejection).toBe("unplanned-for-execution");
    expect(admission.reason).toBe(reason);
    expect(expected.reason).toBe(reason);
    expect(typeof admission.detail).toBe("string");
    expect((admission.detail ?? "").trim().length).toBeGreaterThan(0);
    expect(admission.detail).not.toBe(LEGACY_GENERIC_UNPLANNED_SENTENCE);
    // The detail must name THIS cause, not the shared umbrella sentence.
    expect((admission.detail ?? "").toLowerCase()).toContain(expectCauseWord(reason));

    // No-waiver invariant: a refusal never moves the card and never fabricates gate evidence.
    expect(fixture.moveTaskIf).not.toHaveBeenCalled();
    expect(fixture.current.column).toBe("todo");
    expect(fixture.current.workflowStepResults ?? []).toEqual(card.workflowStepResults ?? []);
    /*
    FNXC:ExecutionAdmissionReason 2026-10-18-09:55 (RUFU-718):
    These four reasons are real requests, not stale claims, so the deliverable is named copy plus
    PROOF that the pre-existing recovery owner still owns the card. Ownership here is negative and
    observable: an explicit refusal that neither writes the row nor arms a continuation leaves
    FN-8592 / FN-8923 / RUFU-273 / RUFU-288 and triage's own sweeps as the only writers. That is the
    load-bearing half of the rule that a refusal may INVOKE an existing seam but must not fork a
    second owner. (`plan-review-pending` is the one reason the explicit path may arm, and it owns a
    separate case below.)
    */
    if (
      reason === "needs-replan"
      || reason === "human-plan-approval-pending"
      || reason === "duplicate-prompt"
      || reason === "seed-prompt"
    ) {
      expect(fixture.updateTask).not.toHaveBeenCalled();
      expect(fixture.updateTaskAtomic).not.toHaveBeenCalled();
      expect(fixture.workItems).toHaveLength(0);
      expect(fixture.seedStrandedPlanReviewContinuation).not.toHaveBeenCalled();
    }
    if (reason === "needs-replan" || reason === "human-plan-approval-pending") {
      expect(fixture.current.status).toBe(card.status);
    }
  });

  it("keeps the wire rejection code unchanged so no surface gains a new code", async () => {
    const card = reportedCard();
    const fixture = await makeFixture(card);

    const admission = await admitTaskToWip(
      fixture.store, { now: () => Date.now() }, card, "in-progress", fixture.ir, userMove,
    );

    expect(admission.released).toBe(false);
    expect(Object.keys(admission).sort()).toEqual(["detail", "reason", "rejection", "released"]);
  });
});

describe("unplanned admission: promote and event release cannot lose the reason", () => {
  it("promoteHeldTask reports the same reason and detail as the move surface", async () => {
    const card = reportedCard({ status: "needs-replan", workflowStepResults: [] });
    const fixture = await makeFixture(card, { ir: workflow("capacity", false) });

    const outcome = await promoteHeldTask(fixture.store, card.id);

    expect(outcome.released).toBe(false);
    expect(outcome.rejection).toBe("unplanned-for-execution");
    expect(outcome.reason).toBe("needs-replan");
    expect((outcome.detail ?? "").toLowerCase()).toContain("replan");
    expect(fixture.moveTaskIf).not.toHaveBeenCalled();
    expect(fixture.current.status).toBe("needs-replan");
  });

  it("releaseHeldTaskByEvent reports the same reason and detail as the move surface", async () => {
    const card = reportedCard({ workflowStepResults: [] });
    const fixture = await makeFixture(card, { ir: workflow("external-event") });

    const outcome = await releaseHeldTaskByEvent(fixture.store, card.id, "webhook");

    expect(outcome.released).toBe(false);
    expect(outcome.rejection).toBe("unplanned-for-execution");
    expect(outcome.reason).toBe("plan-review-pending");
    expect((outcome.detail ?? "").toLowerCase()).toContain("plan review");
    expect(fixture.moveTaskIf).not.toHaveBeenCalled();
  });
});

describe("unplanned admission: a refusal leaves a durable recovery owner", () => {
  it("arms Plan Review once, and a second identical call names the armed owner instead of repeating an ownerless refusal", async () => {
    const card = reportedCard();
    const fixture = await makeFixture(card);

    const first = await admitTaskToWip(
      fixture.store, { now: () => Date.now() }, card, "in-progress", fixture.ir, userMove,
    );
    expect(first.released).toBe(false);
    if (first.released) return;
    expect(first.reason).toBe("plan-review-pending");
    expect((first.detail ?? "").toLowerCase()).toContain("queued");

    // Durable owner, observable through the store's work items.
    expect(fixture.workItems).toHaveLength(1);
    expect(fixture.workItems[0]).toMatchObject({
      taskId: card.id,
      nodeId: PLAN_REVIEW_GROUP_ID,
      kind: "task",
      state: "runnable",
      waitReason: "planning",
      sourceColumn: "todo",
    });

    const second = await admitTaskToWip(
      fixture.store, { now: () => Date.now() }, card, "in-progress", fixture.ir, userMove,
    );
    expect(second.released).toBe(false);
    if (second.released) return;
    expect(second.reason).toBe("plan-review-pending");
    // Still an owner: the copy names the queued Plan Review rather than a bare "not ready".
    expect((second.detail ?? "").toLowerCase()).toContain("queued");
    // The seam is idempotent: its advisory pre-check sees the runnable continuation the first call
    // installed, so exactly one durable write ever happens.
    expect(fixture.workItems).toHaveLength(1);
    expect(fixture.seedStrandedPlanReviewContinuation).toHaveBeenCalledTimes(1);
  });

  it("does not claim a queue it did not create when the sanctioned seam bails on an operator park", async () => {
    const card = reportedCard({ userPaused: true });
    const fixture = await makeFixture(card);

    const admission = await admitTaskToWip(
      fixture.store, { now: () => Date.now() }, card, "in-progress", fixture.ir, userMove,
    );

    expect(admission.released).toBe(false);
    if (admission.released) return;
    expect(admission.reason).toBe("plan-review-pending");
    expect((admission.detail ?? "").toLowerCase()).toContain("paused");
    expect((admission.detail ?? "")).not.toContain("queued");
    expect(fixture.workItems).toHaveLength(0);
  });

  it("leaves the automatic (non-explicit) release path unarmed so FN-8592 keeps its single owner", async () => {
    const card = reportedCard();
    const fixture = await makeFixture(card);

    const admission = await admitTaskToWip(
      fixture.store, { now: () => Date.now() }, card, "in-progress", fixture.ir,
    );

    expect(admission.released).toBe(false);
    expect(fixture.workItems).toHaveLength(0);
    expect(fixture.seedStrandedPlanReviewContinuation).not.toHaveBeenCalled();
  });
});

describe("unplanned admission: the stale planning claim", () => {
  it("clears a dead planner claim and continues the same release when the plan is complete", async () => {
    const card = reportedCard({ status: "planning", workflowStepResults: [] });
    const fixture = await makeFixture(card, { ir: workflow("capacity", false) });

    const admission = await admitTaskToWip(
      fixture.store, { now: () => Date.now() }, card, "in-progress", fixture.ir, userMove,
    );

    expect(admission.released).toBe(true);
    expect(fixture.current.status).toBeNull();
    expect(fixture.current.column).toBe("in-progress");
    expect(fixture.logEntry).toHaveBeenCalledWith(
      card.id,
      expect.stringContaining("stale planning"),
    );
  });

  it("keeps refusing a dead planner claim when clearing it would still leave the card unplanned", async () => {
    const card = reportedCard({ status: "planning", workflowStepResults: [] });
    const fixture = await makeFixture(card, {
      ir: workflow("capacity", false),
      prompt: buildBootstrapPrompt(card.id, card.title, card.description),
    });

    const admission = await admitTaskToWip(
      fixture.store, { now: () => Date.now() }, card, "in-progress", fixture.ir, userMove,
    );

    expect(admission.released).toBe(false);
    if (admission.released) return;
    expect(admission.reason).toBe("planning-status");
    expect((admission.detail ?? "").toLowerCase()).toContain("planning");
    // The claim stays for its owner: this path only clears a claim that is the sole blocker.
    expect(fixture.current.status).toBe("planning");
    expect(fixture.updateTask).not.toHaveBeenCalled();
    expect(fixture.moveTaskIf).not.toHaveBeenCalled();
  });

  it("never clears a claim a live planner session owns", async () => {
    const card = reportedCard({ status: "planning", workflowStepResults: [] });
    const fixture = await makeFixture(card, { ir: workflow("capacity", false) });

    const admission = await admitTaskToWip(
      fixture.store, { now: () => Date.now(), isTaskActive: () => true }, card, "in-progress", fixture.ir, userMove,
    );

    expect(admission.released).toBe(false);
    if (admission.released) return;
    expect(admission.reason).toBe("planning-status");
    expect(fixture.current.status).toBe("planning");
    expect(fixture.updateTask).not.toHaveBeenCalled();
  });
});

/** The cause word each reason's copy must contain — the operator-readable name of the gate. */
function expectCauseWord(reason: string): string {
  switch (reason) {
    case "plan-review-pending": return "plan review";
    case "human-plan-approval-pending": return "approval";
    case "planning-status": return "planner";
    case "needs-replan": return "replan";
    case "duplicate-prompt": return "duplicate";
    case "seed-prompt": return "seed";
    default: throw new Error(`unhandled reason ${reason}`);
  }
}
