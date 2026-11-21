// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { redriveLandedPostMergeGate } from "../task-post-merge-redrive.js";

/*
FNXC:ReviewRecovery 2026-11-21-05:01 (RUFU-556):
`task-retry-stage-route.test.ts` is the frozen end-to-end contract for the landed Retry — it already proves
HTTP 200 for a seeded re-drive, the 409 family for `pending`/`held`/`live`, and the fence race. What it
cannot reach is everything BELOW the HTTP surface, and that is what this file owns: the classes that must
return not-applicable so RUFU-599's waiver narrative and the finalizer's zero-row arm are never stolen; the
read-count invariant (an owed card is the only one that pays for a re-observation); the reason-to-409 copy
for refusals the route fixtures never produce; and the terminal/non-terminal wording an operator acts on.
No case here duplicates those three route cases.

The seam is exercised for real rather than mocked: `vi.mock("@fusion/engine")` would make the test assert a
stub's opinions, and every refusal this module reports is only trustworthy if the seam authored it. The
store is the narrow fake the assertions count.
*/

const REDRIVE_IR = {
  version: "v2",
  name: "redrive-route",
  columns: [
    { id: "planning", name: "Planning", traits: [{ trait: "intake" }, { trait: "hold" }] },
    { id: "building", name: "Building", traits: [{ trait: "wip" }] },
    { id: "signoff", name: "Signoff", traits: [{ trait: "merge-blocker" }, { trait: "human-review" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ],
  nodes: [
    { id: "start", kind: "start" },
    { id: "plan", kind: "prompt", column: "planning" },
    { id: "implement", kind: "execute", column: "building" },
    { id: "code-review", kind: "prompt", column: "signoff" },
    {
      id: "post-review",
      kind: "optional-group",
      column: "signoff",
      config: {
        phase: "post-merge",
        defaultOn: true,
        template: { nodes: [{ id: "verify", kind: "prompt", config: { gateMode: "gate" } }], edges: [] },
      },
    },
  ],
  edges: [
    { from: "start", to: "plan" },
    { from: "plan", to: "implement" },
    { from: "implement", to: "code-review" },
    { from: "code-review", to: "post-review" },
  ],
} as unknown as WorkflowIr;

/** An IR whose post-merge gate no longer exists, for the `no-post-merge-node` refusal. */
const NO_POST_MERGE_IR = {
  ...structuredClone(REDRIVE_IR),
  nodes: (structuredClone(REDRIVE_IR) as { nodes: unknown[] }).nodes.slice(0, 4),
} as unknown as WorkflowIr;

function landedRow(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-9001",
    title: "Landed card",
    description: "Already landed",
    column: "signoff",
    autoMerge: true,
    dependencies: [],
    steps: [{ name: "Implement", status: "done" }],
    currentStep: 1,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    mergeDetails: { mergeConfirmed: true, commitSha: "landed-sha", mergedAt: "2026-11-01T00:00:00.000Z" },
    workflowStepResults: [
      { workflowStepId: "code-review", status: "passed", verdict: "APPROVE", phase: "pre-merge" },
      {
        workflowStepId: "post-review",
        status: "failed",
        verdict: "REVISE",
        phase: "post-merge",
        // Minutes old, not 15+: the schedule is deliberately NOT due, so a seed here can only come
        // from the explicit-operator arm.
        completedAt: new Date().toISOString(),
        priorAttempts: [{ workflowStepId: "post-review", status: "failed", verdict: "REVISE" }],
      },
    ],
    ...overrides,
  } as Task;
}

interface FakeStoreOptions {
  /** The row the atomic re-observation sees, when it differs from the row the dispatcher handed in. */
  live?: Task;
  ir?: WorkflowIr;
  settings?: Record<string, unknown>;
  /** Drop the idle-seed capability to model a store that cannot seed at all. */
  withoutSeedCapability?: boolean;
  /** Make the re-observation throw, the hostile-store shape that must still not become a 5xx. */
  failAtomic?: boolean;
  /** Make the History writer absent, the other hostile-store shape. */
  withoutLogEntry?: boolean;
}

function createFakeStore(row: Task, options: FakeStoreOptions = {}) {
  const counts = { getTask: 0, getSettings: 0, getRootDir: 0, updateTaskAtomic: 0 };
  const atomicPatches: unknown[] = [];
  const seeds: Array<Record<string, unknown>> = [];
  const history: string[] = [];

  const store: Record<string, unknown> = {
    getTask: vi.fn(async () => {
      counts.getTask += 1;
      return structuredClone(row);
    }),
    getSettings: vi.fn(async () => {
      counts.getSettings += 1;
      return options.settings ?? { autoMerge: true };
    }),
    // Returning no root keeps the contract resolver's cache key undefined, so it resolves without ever
    // touching the filesystem or `git remote` — the cheap-precondition test asserts this is never called.
    getRootDir: vi.fn(() => {
      counts.getRootDir += 1;
      return undefined as unknown as string;
    }),
    getTaskWorkflowSelection: vi.fn(async () => ({ workflowId: "wf-redrive" })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "wf-redrive" })),
    getWorkflowDefinition: vi.fn(async () => ({
      id: "wf-redrive",
      name: "Redrive",
      ir: options.ir ?? REDRIVE_IR,
    })),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (live: Task) => unknown) => {
      counts.updateTaskAtomic += 1;
      if (options.failAtomic) throw new Error("durable row unreadable");
      const patch = await updater(structuredClone(options.live ?? row));
      atomicPatches.push(patch);
      return structuredClone(options.live ?? row);
    }),
    seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async (input: Record<string, unknown>) => {
      seeds.push(input);
      return { seeded: true };
    }),
    logEntry: vi.fn(async (_id: string, line: string) => {
      history.push(String(line));
    }),
  };
  if (options.withoutSeedCapability) delete store.seedWorkspaceCodeReviewContinuationIfIdle;
  if (options.withoutLogEntry) delete store.logEntry;

  return {
    store: store as unknown as TaskStore,
    counts,
    atomicPatches,
    seeds,
    history,
    refusalLines: () => history.filter((line) => line.startsWith("Retry refused (post-merge-recheck):")),
  };
}

describe("redriveLandedPostMergeGate — what must NOT be reached", () => {
  it("returns not-applicable for a card that has no post-merge row at all, reading nothing", async () => {
    const row = landedRow({ workflowStepResults: [{ workflowStepId: "code-review", status: "passed", verdict: "APPROVE", phase: "pre-merge" }] });
    const { store, counts, atomicPatches, history } = createFakeStore(row);

    const result = await redriveLandedPostMergeGate({ store, task: row, ir: REDRIVE_IR });

    expect(result).toEqual({ kind: "not-applicable" });
    // The zero-durable-result arm belongs to the finalizer, self-healing and `fn task reconcile`.
    // An eager arm would also add the extra read that `moveOnSecondRead` fails the route on.
    expect(counts).toEqual({ getTask: 0, getSettings: 0, getRootDir: 0, updateTaskAtomic: 0 });
    expect(atomicPatches).toEqual([]);
    expect(history).toEqual([]);
  });

  it("leaves an operator-waived post-merge gate to RUFU-599's refusal narrative", async () => {
    const row = landedRow({
      workflowStepResults: [
        { workflowStepId: "code-review", status: "passed", verdict: "APPROVE", phase: "pre-merge" },
        {
          workflowStepId: "post-review",
          status: "skipped",
          phase: "post-merge",
          notRunReason: "ci-repository-unresolved",
        },
      ],
    });
    const { store, counts, atomicPatches, history } = createFakeStore(row);

    const result = await redriveLandedPostMergeGate({ store, task: row, ir: REDRIVE_IR });

    expect(result).toEqual({ kind: "not-applicable" });
    expect(counts.updateTaskAtomic).toBe(0);
    expect(history).toEqual([]);
  });

  it("refuses an approved post-merge gate — re-seeding it would overwrite a verdict", async () => {
    const row = landedRow({
      workflowStepResults: [
        { workflowStepId: "code-review", status: "passed", verdict: "APPROVE", phase: "pre-merge" },
        { workflowStepId: "post-review", status: "passed", verdict: "APPROVE", phase: "post-merge", completedAt: new Date().toISOString() },
      ],
    });
    const { store, counts } = createFakeStore(row);

    expect(await redriveLandedPostMergeGate({ store, task: row, ir: REDRIVE_IR })).toEqual({ kind: "not-applicable" });
    expect(counts.updateTaskAtomic).toBe(0);
  });

  it("is not-applicable at entry for a workspace card, which the seam refuses by construction", async () => {
    const row = landedRow({
      workspaceWorktrees: {
        api: { worktreePath: "/workspace/api/.worktrees/fn-9001", branch: "fusion/fn-9001-api", baseCommitSha: "base", landedSha: "landed" },
      },
    });
    const { store, counts, seeds } = createFakeStore(row);

    expect(await redriveLandedPostMergeGate({ store, task: row, ir: REDRIVE_IR })).toEqual({ kind: "not-applicable" });
    expect(counts.updateTaskAtomic).toBe(0);
    expect(seeds).toEqual([]);
  });

  it("re-observes through exactly one fenced call that patches nothing", async () => {
    const row = landedRow();
    const { store, counts, atomicPatches, seeds } = createFakeStore(row);

    const result = await redriveLandedPostMergeGate({ store, task: row, ir: REDRIVE_IR });

    expect(result.kind).toBe("seeded");
    expect(counts.updateTaskAtomic).toBe(1);
    // `null` is the store's "no mutation" answer. A patch here would mean this arm rewrote a card whose
    // landing proof is already durable, which is the destruction the frozen route case forbids.
    expect(atomicPatches).toEqual([null]);
    expect(seeds).toHaveLength(1);
  });
});

describe("redriveLandedPostMergeGate — refusal mapping", () => {
  it.each([
    ["operator-held", { row: () => landedRow({ userPaused: true, paused: true }) }],
    ["checkout-lease", { row: () => landedRow({ checkoutRunId: "owner-run", checkoutLeaseRenewedAt: new Date().toISOString() }) }],
    ["gate-not-resumable", { row: () => landedRow({ workflowStepResults: [
      { workflowStepId: "code-review", status: "passed", verdict: "APPROVE", phase: "pre-merge" },
      { workflowStepId: "post-review", status: "pending", phase: "post-merge" },
    ] }) }],
    ["auto-merge-off", { row: () => landedRow({ autoMerge: false }), settings: { autoMerge: false } }],
  ] as const)("refuses %s naming the reason code, its remedy, and one History line", async (reason, fixture) => {
    const row = fixture.row();
    const { store, counts, seeds, history, refusalLines } = createFakeStore(row, { settings: fixture.settings });

    const result = await redriveLandedPostMergeGate({ store, task: row, ir: REDRIVE_IR });

    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason).toBe(reason);
    expect(result.message).toContain(reason);
    expect(result.message).toContain("Nothing was changed on this card");
    expect(seeds).toEqual([]);
    expect(refusalLines()).toHaveLength(1);
    expect(history).toHaveLength(1);
    // A refusal must never cost more than the one re-observation either.
    expect(counts.getSettings <= 1).toBe(true);
  });

  it("marks a terminal refusal as unhelpful-to-retry instead of inviting another click", async () => {
    const row = landedRow();
    const { store, seeds, refusalLines } = createFakeStore(row, { withoutSeedCapability: true });

    const result = await redriveLandedPostMergeGate({ store, task: row, ir: REDRIVE_IR });

    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason).toBe("unsupported-store");
    expect(result.message).toContain("unsupported-store");
    expect(result.message).toContain("Another Retry cannot produce this evidence");
    expect(seeds).toEqual([]);
    expect(refusalLines()).toHaveLength(1);
  });

  it("refuses rather than seeds when the card's stored workflow no longer declares the owed gate", async () => {
    const row = landedRow();
    const { store, seeds, refusalLines } = createFakeStore(row, { ir: NO_POST_MERGE_IR });

    const result = await redriveLandedPostMergeGate({ store, task: row, ir: REDRIVE_IR });

    // The dispatcher resolved an IR that still names the gate, but the seam re-resolves the card's own
    // workflow and its requirement check runs on THAT. A gate the stored workflow no longer declares is
    // therefore not owed, and the seam refuses on the requirement rather than seeding a node that only
    // existed in the caller's snapshot — which is why this arm never authors a seed input of its own.
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason).toBe("gate-not-resumable");
    expect(seeds).toEqual([]);
    expect(refusalLines()).toHaveLength(1);
  });

  it("still answers a refusal when the durable row and the History writer both fail", async () => {
    const row = landedRow();
    const { store, refusalLines, history } = createFakeStore(row, { failAtomic: true, withoutLogEntry: true });

    const result = await redriveLandedPostMergeGate({ store, task: row, ir: REDRIVE_IR });

    // The two hostile-store shapes that used to be the 500: neither may escape as a throw.
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason).toBe("durable-read-unavailable");
    expect(result.message).toContain("durable-read-unavailable");
    expect(history).toEqual([]);
    expect(refusalLines()).toEqual([]);
  });

  it("keeps the refusal copy free of a forked terminality rule for a retryable hold", async () => {
    const row = landedRow({ userPaused: true, paused: true });
    const { store } = createFakeStore(row);

    const result = await redriveLandedPostMergeGate({ store, task: row, ir: REDRIVE_IR });

    expect(result.kind === "refused" && result.message).toContain("A later Retry may succeed");
  });
});

describe("redriveLandedPostMergeGate — the fenced snapshot is the card", () => {
  it("returns not-applicable when landing proof is gone on the live row", async () => {
    const row = landedRow();
    const lost = structuredClone(row) as Task;
    delete lost.mergeDetails;
    const { store, seeds, history } = createFakeStore(row, { live: lost });

    const result = await redriveLandedPostMergeGate({ store, task: row, ir: REDRIVE_IR });

    // Not landed after all: today's behavior stands, and no 409 naming `no-merge-proof` is invented
    // for a card that never merged.
    expect(result).toEqual({ kind: "not-applicable" });
    expect(seeds).toEqual([]);
    expect(history).toEqual([]);
  });

  it("reaches the seam when landing proof appears on the live row after being absent", async () => {
    const row = landedRow();
    const unlanded = structuredClone(row) as Task;
    delete unlanded.mergeDetails;
    const { store, seeds } = createFakeStore(row, { live: row });

    const result = await redriveLandedPostMergeGate({ store, task: unlanded, ir: REDRIVE_IR });

    expect(result.kind).toBe("seeded");
    expect(seeds).toHaveLength(1);
  });

  it("seeds through the explicit-operator arm while the rejected-evidence schedule is still closed", async () => {
    const row = landedRow();
    const { store, seeds, history, refusalLines } = createFakeStore(row);

    const result = await redriveLandedPostMergeGate({ store, task: row, ir: REDRIVE_IR });

    expect(result.kind).toBe("seeded");
    if (result.kind !== "seeded") return;
    expect(result.workflowStepId).toBe("post-review");
    expect(seeds[0]).toMatchObject({ taskId: row.id, nodeId: "post-review", state: "runnable" });
    // One narrator only: the seam already wrote the sentence its own budget counts, so this authority
    // adds nothing. Two lines for one click is what the one-narrator doctrine forbids.
    expect(refusalLines()).toEqual([]);
    expect(history).toHaveLength(1);
    expect(history[0]).toContain("Rechecking rejected evidence");
  });
});
