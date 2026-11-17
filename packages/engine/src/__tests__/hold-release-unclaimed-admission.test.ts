/*
FNXC:UnclaimedGraphWork 2026-11-17-01:05 (RUFU-1050):
The release seam's sentence is the operator's only evidence about a card they just tried to move, and
until now `bailed: "active-continuation"` answered EVERY such card with

  " Plan Review is already queued for this card and will run; the card releases itself once it reports
   a passing verdict."

That sentence is true for exactly one data state — a row the drain will consume on its next pass. It is
false for a row whose `retryAfter` is in the future, false for a row ranked past the 20-wide FIFO due
window, and false for a lease-held row. `readyAtCapacityBoundary` — the one gate that could have
noticed — reads `waitReason === "capacity"`, so a `waitReason: "planning"` row never reaches it and the
promise was never checked against the row it named.

These cases pin BOTH halves of the contract, because only replacing the sentence with a worse promise
would be the same bug in a new costume:
  - starved shapes: the word "released"/"will run" is gone, the CODE names the shape, and the NEXT
    ACTOR names who moves the card;
  - the genuinely armed and reachable row: the pre-fix sentence survives BYTE FOR BYTE.

Harness shape is reused from `hold-release-unplanned-reason.test.ts` (in-memory store + a tmp
PROMPT.md); no real network, no polling, no timers to wait on.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLAN_REVIEW_GROUP_ID,
  type Task,
  type TaskStore,
  type WorkflowIr,
  type WorkflowWorkItem,
} from "@fusion/core";

import { promoteHeldTask, unclaimedPlanningWaitDetail } from "../execution/hold-release.js";
import { getPromptPath } from "../execution/spec-staleness.js";
import {
  notePlanningContinuationDrainProgress,
  resetPlanningContinuationDrainProgress,
} from "../workflows/continuation-drain-progress.js";
import { DUE_PLANNING_CONTINUATION_BATCH_LIMIT } from "../workflows/continuation-drain-constants.js";
import {
  UNCLAIMED_GRAPH_WORK_DEFERRAL_REPEAT_MS,
  type UnclaimedGraphWorkDecision,
} from "../workflows/unclaimed-graph-work.js";

const WORKFLOW_ID = "custom:rufu-1050";
const NOW = Date.now();
const AGED = new Date(NOW - 60 * 60_000).toISOString();

/** The pre-fix promise. It must survive exactly one shape and vanish from every starved one. */
const PRE_FIX_SENTENCE = " Plan Review is already queued for this card and will run; the card releases itself once it reports a passing verdict.";

const PLANNED_PROMPT = "# Planned\n\n## Mission\nShip the honest admission sentence.\n\n## Steps\n\n- 1. Name the next actor.\n";

function workflowIr(): WorkflowIr {
  return {
    version: "v2",
    id: WORKFLOW_ID,
    name: "RUFU-1050 unclaimed admission",
    columns: [
      { id: "todo", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "In Progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "in-review", name: "Review", traits: [{ trait: "review" }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      {
        id: PLAN_REVIEW_GROUP_ID,
        name: "Plan Review",
        kind: "optional-group",
        column: "todo",
        config: { defaultOn: true, template: { nodes: [], edges: [] } },
      },
      { id: "execute", kind: "prompt", column: "in-progress", config: { prompt: "execute" } },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [],
  } as unknown as WorkflowIr;
}

function item(overrides: Partial<WorkflowWorkItem> = {}): WorkflowWorkItem {
  return {
    id: "WI-1",
    runId: "RUN-1",
    taskId: "RUFU-1050",
    nodeId: PLAN_REVIEW_GROUP_ID,
    kind: "task",
    state: "runnable",
    attempt: 0,
    retryAfter: null,
    deferredSince: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    blockedReason: null,
    stableWorkflowRunId: "RUN-1",
    continuationSequence: 1,
    waitReason: "planning",
    sourceColumn: "todo",
    targetColumn: "in-progress",
    irHash: null,
    principalAgentId: null,
    workflowRole: "triage",
    authorityKind: "role-pool",
    nodeInstanceId: null,
    createdAt: AGED,
    updatedAt: AGED,
    ...overrides,
  } as WorkflowWorkItem;
}

function card(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-1050",
    title: "A deferred card cannot leave todo",
    description: "Move this card into in-progress",
    column: "todo",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    approvedPlanFingerprint: "97a89ca8c84c61ec000000000000000000000000000000000000000000000000",
    enabledWorkflowSteps: ["plan-review", "code-review"],
    workflowStepResults: [],
    createdAt: AGED,
    updatedAt: AGED,
    columnMovedAt: AGED,
    ...overrides,
  } as Task;
}

interface Fixture {
  store: TaskStore;
  current: Task;
  workItems: WorkflowWorkItem[];
}

/**
 * @param duePageIds the ids the drain's due page actually returns, or null to omit the reader the way
 *        a narrow store does. A full-length page that omits the card's row is how "behind the FIFO
 *        window" is measured — by the consumer's own filter, not by a guess about it.
 */
async function makeFixture(initial: Task, workItems: WorkflowWorkItem[], duePageIds: string[] | null): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "fusion-rufu-1050-"));
  roots.push(root);
  const tasksDir = join(root, "tasks");
  await mkdir(join(tasksDir, initial.id), { recursive: true });
  await writeFile(getPromptPath(tasksDir, initial.id), PLANNED_PROMPT, "utf8");

  const ir = workflowIr();
  const selection = { workflowId: WORKFLOW_ID, stepIds: [] };
  const items = [...workItems];
  const store = {
    getSettings: vi.fn(async () => ({ maxConcurrent: 4, autoMerge: true })),
    getTask: vi.fn(async () => initial),
    getTasksDir: () => tasksDir,
    getRootDir: () => root,
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir })),
    listWorkflowWorkItemsForTask: vi.fn(async () => [...items]),
    listDueWorkflowWorkItems: duePageIds === null ? undefined : vi.fn(async () => duePageIds.map((id) => item({ id }))),
    // The seam's own arming seam: an ACTIVE row already exists in every case below except where the
    // fixture says otherwise, so it bails `active-continuation` exactly as production does.
    seedStrandedPlanReviewContinuation: vi.fn(async () => ({ seeded: false as const, reason: "active-continuation" as const })),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    checkAndRecordUnplannedExecutionBlock: vi.fn(async () => true),
    updateTask: vi.fn(async () => initial),
    updateTaskAtomic: vi.fn(async () => initial),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
  } as unknown as TaskStore;
  return { store, current: initial, workItems: items };
}

const roots: string[] = [];

afterEach(async () => {
  resetPlanningContinuationDrainProgress();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("promoteHeldTask — the admission sentence for an unclaimed planning wait", () => {
  it("stops promising a run for a row whose deferral has repeated past every published horizon", async () => {
    const { store } = await makeFixture(card(), [
      item({
        state: "retrying",
        retryAfter: new Date(NOW + 45_000).toISOString(),
        deferredSince: new Date(NOW - UNCLAIMED_GRAPH_WORK_DEFERRAL_REPEAT_MS - 5_000).toISOString(),
      }),
    ], null);

    const result = await promoteHeldTask(store, "RUFU-1050");

    expect(result.released).toBe(false);
    expect(result.reason).toBe("plan-review-pending");
    const detail = result.detail ?? "";
    expect(detail).not.toContain("and will run");
    expect(detail).not.toContain(PRE_FIX_SENTENCE);
    expect(detail).toContain("nothing will dispatch it");
    // Names the code's cause and the next actor, in that order.
    expect(detail).toContain("retry deferral");
    expect(detail).toContain("unclaimed-graph-work reconciliation pass");
  });

  it("names the FIFO due window when the row is valid but the drain never reads that far", async () => {
    const behind = Array.from({ length: DUE_PLANNING_CONTINUATION_BATCH_LIMIT }, (_unused, index) => `WI-other-${index}`);
    const { store } = await makeFixture(card(), [item({ id: "WI-ours" })], behind);

    const result = await promoteHeldTask(store, "RUFU-1050");

    const detail = result.detail ?? "";
    expect(detail).not.toContain("and will run");
    expect(detail).toContain("FIFO");
    expect(detail).toContain(String(DUE_PLANNING_CONTINUATION_BATCH_LIMIT));
    expect(detail).toContain("continuation drain's fairness rotation");
  });

  it("keeps the pre-fix sentence byte-for-byte for a row the drain reached and recently consumed", async () => {
    // The drain ran a second ago and the row is inside its page: "will run" is a true sentence, and
    // rewriting it would be the same over-correction in the other direction.
    notePlanningContinuationDrainProgress(NOW);
    const { store } = await makeFixture(card(), [item()], ["WI-1"]);

    const result = await promoteHeldTask(store, "RUFU-1050");

    expect((result.detail ?? "").endsWith(PRE_FIX_SENTENCE)).toBe(true);
  });

  it("treats an unobservable drain as no evidence, not as proof of starvation", async () => {
    // A process that never ran the pump (a CLI one-shot, a narrow harness) must not have every
    // admission sentence rewritten on the strength of a missing measurement.
    resetPlanningContinuationDrainProgress();
    const { store } = await makeFixture(card(), [item()], ["WI-1"]);

    const result = await promoteHeldTask(store, "RUFU-1050");

    expect((result.detail ?? "").endsWith(PRE_FIX_SENTENCE)).toBe(true);
  });
});

describe("unclaimedPlanningWaitDetail — one sentence per starved code", () => {
  const decision = (code: UnclaimedGraphWorkDecision["code"], owner: UnclaimedGraphWorkDecision["owner"]): UnclaimedGraphWorkDecision => ({
    action: "redrive",
    code,
    owner,
    retryAfterMs: 1_000,
    stalenessMs: 60_000,
  });

  it.each([
    ["due-unclaimed", "this-pass"],
    ["deferred-repeating", "this-pass"],
    ["lease-held", "this-pass"],
    ["behind-drain-window", "drain-window"],
    ["terminal-node-orphan", "execution-rearm"],
    ["terminal-recorded", "operator"],
  ] as const)("names the cause and the next actor for %s", (code, owner) => {
    const detail = unclaimedPlanningWaitDetail(decision(code, owner));
    expect(detail).not.toBeNull();
    expect(detail).toContain("nothing will dispatch it");
    expect(detail!.length).toBeGreaterThan(" Plan Review is already queued for this card, but nothing will dispatch it: . The card stays put, and the next actor is .".length);
    expect(detail).not.toMatch(/released|will run/);
  });

  it("says nothing for a code that has an owner, because the existing wording is then honest", () => {
    for (const code of ["owned-elsewhere", "slot-held", "not-aged", "operator-held", "live-session", "auto-merge-off", "not-planning-lane"] as const) {
      expect(unclaimedPlanningWaitDetail(decision(code, "operator"))).toBeNull();
    }
    expect(unclaimedPlanningWaitDetail(undefined)).toBeNull();
  });

  it("does not mention a release, a scheduled run, or Plan Review being queued as if it were actionable", () => {
    // The three forbidden promises, asserted against the only sentence the seam may print instead.
    const detail = unclaimedPlanningWaitDetail(decision("terminal-node-orphan", "triage")) ?? "";
    expect(detail).toContain("The card stays put");
    expect(detail).toContain("planner, reached through a replan admission");
  });
});
