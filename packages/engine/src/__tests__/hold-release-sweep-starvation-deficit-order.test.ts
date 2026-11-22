/*
FNXC:HoldReleaseArmedPriority 2026-11-22-22:25 (RUFU-1167):
The armed partition must be ordered by the queue deficit the sweep itself authored, so the newest cards -
the fix cards written from a blocked board, which arrival order always parks in the truncated tail - are
reached on the NEXT pass instead of after one round trip over the lane.

Measured need (RunFusion proj_9326d74a133b421a, 2026-11-22): 402 of 448 todo cards carried a real
`sourceMetadata.holdReleaseStarvation` episode, 305 of them at `stallCount >= 100` (max 128). RUFU-1064 -
the card that fixes this very sweep - was refused with "deferred it 114 times without reaching it (928
cards were left unevaluated behind its per-pass budget)".

Every case here runs the SAME board with ONE variable changed, and the assertion is the release itself
(`result.released`) rather than an internal counter. The pass budget is deliberately set so the sweep can
evaluate exactly ONE card, which makes the release a direct read of the evaluation order: a wrong order
cannot release the other card and quietly still pass.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import {
  HOLD_RELEASE_STARVATION_METADATA_KEY,
  PLAN_REVIEW_GROUP_ID,
  clearHoldReleaseStarvationPatch,
} from "@fusion/core";

import { runHoldReleaseSweep, resetHoldReleaseInstrumentation } from "../execution/hold-release.js";
import { schedulerLog } from "../logger.js";

const WF = "custom:starvation-deficit-wf";
/** The older armed card: wins plain queue order, carries no starvation episode. */
const PLAIN_ID = "B-PLAIN";
/** The newer armed card: sorts behind PLAIN_ID by arrival, and is the one the sweep keeps never reaching. */
const STARVED_ID = "C-STARVED";

/** One reservation costs more than the whole pass budget, so exactly ONE card is ever evaluated. */
const REAL_RESERVE_MS = 25;
const BUDGET_MS = 20;

const STARVED_EPISODE = {
  code: "release-sweep-budget-starved",
  lastAt: "2026-11-22T22:00:00.000Z",
  firstAt: "2026-11-21T11:00:00.000Z",
  stallCount: 120,
  unevaluatedCount: 928,
};

function card(id: string, createdAt: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: `Card ${id}`,
    description: "planned card",
    column: "todo",
    status: null,
    projectId: "proj-starvation-deficit-test",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt,
    updatedAt: createdAt,
    columnMovedAt: createdAt,
    prompt: "# Planned\n\n## Mission\nImplement the approved work.\n",
    ...over,
  } as Task;
}

function ir(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    name: "Starvation deficit order",
    columns: [
      { id: "todo", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "In Progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      {
        id: PLAN_REVIEW_GROUP_ID,
        name: "Plan Review",
        kind: "optional-group",
        column: "todo",
        config: { defaultOn: false, template: { nodes: [], edges: [] } },
      },
      { id: "execute", kind: "prompt", column: "in-progress", config: { prompt: "execute" } },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [],
    artifacts: [],
  } as unknown as WorkflowIr;
}

/** The passing Plan Review verdict the arming transition already published for an armed card. */
const SATISFIED_REVIEW = [{
  workflowStepId: PLAN_REVIEW_GROUP_ID,
  workflowStepName: "Plan Review",
  status: "passed" as const,
  completedAt: "2026-11-20T00:00:00.000Z",
}];

function armedCard(id: string, createdAt: string, over: Partial<Task> = {}): Task {
  return card(id, createdAt, {
    approvedPlanFingerprint: `fp-${id}`,
    enabledWorkflowSteps: [PLAN_REVIEW_GROUP_ID],
    workflowStepResults: SATISFIED_REVIEW,
    ...over,
  });
}

function board(overrides: Partial<Record<typeof PLAIN_ID | typeof STARVED_ID, Partial<Task>>> = {}) {
  const fillers = Array.from({ length: 12 }, (_, index) =>
    card(`A-FILL-${String(index + 1).padStart(2, "0")}`, "2026-01-01T00:00:00.000Z"));
  // Arrival order is the whole point: PLAIN_ID is OLDER than STARVED_ID, so queue order prefers PLAIN_ID.
  const plain = armedCard(PLAIN_ID, "2026-02-01T00:00:00.000Z", overrides[PLAIN_ID] ?? {});
  const starved = armedCard(STARVED_ID, "2026-03-01T00:00:00.000Z", overrides[STARVED_ID] ?? {});
  return [plain, starved, ...fillers];
}

function storeFor(tasks: Task[]) {
  const selection = { workflowId: WF, stepIds: [] };
  const store = {
    getSettings: vi.fn(async () => ({ maxConcurrent: 10 })),
    listTasks: vi.fn(async () => tasks),
    moveTaskIf: vi.fn(async (id: string, column: string) => {
      const cur = tasks.find((t) => t.id === id)!;
      cur.column = column;
      return { task: cur, moved: true };
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    updateTask: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir: ir() })),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    // Both candidates are armed, so the armed partition - not the queue - is what decides who is first.
    listActiveTaskContinuationTaskIds: vi.fn(async (ids: readonly string[]) =>
      new Set(ids.filter((id) => id === PLAIN_ID || id === STARVED_ID))),
  } as unknown as TaskStore & Record<string, unknown>;
  return store;
}

function clock(startMs = 1_000_000) {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function depsFor(tk: ReturnType<typeof clock>) {
  return {
    now: tk.now,
    budgetMs: BUDGET_MS,
    // Any candidate can win its slot; the discriminating variable is only WHO the pass asks first.
    reserveSlot: async (_candidate: Task) => {
      tk.advance(REAL_RESERVE_MS);
      return { release: async () => undefined };
    },
  };
}

describe("hold/release sweep: the armed partition is ordered by its own starvation deficit", () => {
  beforeEach(() => {
    resetHoldReleaseInstrumentation();
    vi.restoreAllMocks();
    vi.spyOn(schedulerLog, "log").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "warn").mockImplementation(() => {});
    vi.spyOn(schedulerLog, "debug").mockImplementation(() => {});
  });

  /** A pass whose budget is smaller than one reservation cost evaluates exactly one card. */
  async function releasedCard(tasks: Task[]) {
    const tk = clock();
    const store = storeFor(tasks);
    const result = await runHoldReleaseSweep(store, depsFor(tk) as never);
    expect(result.budgetTruncated).toBe(true);
    expect(result.released).toHaveLength(1);
    return { result, store };
  }

  it("AC1 reaches the more-starved armed card first, though it is the NEWER one", async () => {
    const tasks = board({ [STARVED_ID]: { sourceMetadata: { [HOLD_RELEASE_STARVATION_METADATA_KEY]: STARVED_EPISODE } } });
    // Premise: plain arrival order would ask PLAIN_ID first. The fix must contradict it.
    expect(tasks[0]!.id).toBe(PLAIN_ID);

    const { result } = await releasedCard(tasks);

    expect(result.released).toEqual([STARVED_ID]);
  });

  it("AC2 keeps the pre-change order when no armed card carries a deficit (no-regression)", async () => {
    const { result } = await releasedCard(board());

    expect(result.released).toEqual([PLAIN_ID]);
  });

  it("AC3 drains itself: the pass that evaluated the starved card cleared its episode, so the next pass is queue-ordered again", async () => {
    const starvedMetadata = { [HOLD_RELEASE_STARVATION_METADATA_KEY]: STARVED_EPISODE };
    const firstTasks = board({ [STARVED_ID]: { sourceMetadata: starvedMetadata } });
    const first = await releasedCard(firstTasks);
    expect(first.result.released).toEqual([STARVED_ID]);

    // The clear is the contract that bounds this partition. Assert the sweep PERFORMED it on the card it
    // evaluated, rather than only asserting what a hand-edited next fixture does with it.
    const clearKey = Object.keys(clearHoldReleaseStarvationPatch())[0]!;
    const clearedIds = first.store.updateTask.mock.calls
      .filter((call) => {
        const patch = (call[1] as { sourceMetadataPatch?: Record<string, unknown> } | undefined)?.sourceMetadataPatch;
        return patch && Object.prototype.hasOwnProperty.call(patch, clearKey);
      })
      .map((call) => String(call[0]));
    expect(clearedIds).toContain(STARVED_ID);

    // Second pass on the board as the clear leaves it: with the deficit gone, arrival order governs again.
    const secondTasks = board({ [STARVED_ID]: { sourceMetadata: {} } });
    const second = await releasedCard(secondTasks);
    expect(second.result.released).toEqual([PLAIN_ID]);
  });

  it("AC4 a malformed episode degrades to no deficit and never throws the sweep", async () => {
    // The three shapes measured in production: a JSON `null` under the key, a non-object, and a count
    // that is not a number. Key existence alone is NOT an episode (measured 417 vs 402 rows).
    for (const malformed of [
      null,
      "release-sweep-budget-starved",
      { code: "release-sweep-budget-starved", lastAt: "x", firstAt: "y", stallCount: "120" },
    ]) {
      resetHoldReleaseInstrumentation();
      const tasks = board({ [STARVED_ID]: { sourceMetadata: { [HOLD_RELEASE_STARVATION_METADATA_KEY]: malformed } } });
      const { result } = await releasedCard(tasks);
      expect(result.released).toEqual([PLAIN_ID]);
    }
  });
});
