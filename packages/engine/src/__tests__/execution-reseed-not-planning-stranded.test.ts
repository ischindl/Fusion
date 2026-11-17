import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { BUILTIN_CODING_WORKFLOW_IR, classifyPlanningStrandedRetry, resolveReboundTarget, type WorkflowIr } from "@fusion/core";
import { reseedExhaustedTransientExecution } from "../executor/run-implementation.js";
import { reseedExhaustedBranchConflict } from "../executor/worktree-branch-conflict-handle.js";
import { describeTaskWedge, isTaskProgressing } from "../notification/task-wedge-notification.js";

/*
FNXC:ReseedLaneDiscriminator 2026-11-12-14:54 (RUFU-575 code review P0):
The RUFU-575 classification reads `recoveryDisposition` as "the planning run gave up on this card". That
was only true once the value named its author, and this file is the proof, built from the REAL producers
rather than from a hand-written fixture (every pre-existing control in the suite set
`recoveryDisposition: null`, so none of them could see the collision).

The sequence a stranded card actually walks is:
1. the executor's exhausted-retry recovery reseeds it — `status: null`, error and cadence cleared, the
   reseed diagnostic left on the row — and moves it to the workflow's rebound lane;
2. `resolveReboundTarget` answers hold, then intake, then the first column — and on a trait-declared board
   the hold/intake column IS the lane the planner works in, so the rebound lands a card carrying the
   reseed diagnostic in a planning lane;
3. the scheduler then stamps the waiting status and touches nothing else: capacity/admission refusal
   writes `status: "queued"` (`scheduler.ts`, beside `formatConcurrencyLimitReason`), and dependency/lease
   overlap queueing writes `status: "queued"` plus `overlapBlockedBy` (`transitionQueuedEpisode`).
The value survives until an executor claims the card, so for the whole wait the row carries planning
column + `queued` + `error: null` + a nulled `nextRecoveryAt` — every field the planning-stranded retry
classification and the `planning-spec-exhausted` wedge arm read. If the value also said "planning", a card
whose spec, steps and lane are intact alerts as a dead spec run and, on an operator Retry, gets
`status: "needs-replan"` — a fresh planning pass over finished work — where the honest answer is a refusal
naming `queued`. That is the RUFU-372/RUFU-300 failure shape (capacity waits announcing as failures)
re-committed through an ambiguous diagnostic, which is why the execution lane now writes
`escalated-execution-reseed` and the planning lane keeps `escalated-reseed`.

The controls are the other half of the proof: the same two writers, with the PLANNING value in the same
slot, must still be visible to the wedge and still be admitted for Retry — otherwise this file would only
prove that nothing is stranded.
*/

/** The planning column of the built-in board, resolved the way the engine resolves it. */
const REBOUND_COLUMN = resolveReboundTarget(BUILTIN_CODING_WORKFLOW_IR as WorkflowIr) ?? "todo";
const IR = BUILTIN_CODING_WORKFLOW_IR as unknown as WorkflowIr;
/** The verbatim incident sentence, used only for the planning-lane control's non-ambiguity. */
const SPEC_TIMEOUT_ERROR = "Specification failed after 3 transient errors: Request timed out.";

function strandedCard(overrides: Partial<Task> = {}): Task {
  return {
    id: "SANE-900",
    title: "Card whose execution recovery reseeded it",
    description: "",
    column: "in-progress",
    status: "failed",
    error: "Transient executor failure after 3 retries",
    dependencies: [],
    steps: [{ name: "Preflight", status: "done" }],
    currentStep: 1,
    log: [],
    worktree: "/tmp/worktree",
    branch: "fusion/sane-900",
    sessionFile: "/tmp/session.jsonl",
    recoveryRetryCount: 3,
    nextRecoveryAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-11-09T00:00:00.000Z",
    updatedAt: "2026-11-09T00:00:00.000Z",
    workflowStepResults: [],
    ...overrides,
  } as unknown as Task;
}

/**
 * A store that behaves like the row: an atomic patch is applied to the live card, a plain update merges.
 * Nothing is hand-written into the card after the producers run — the assertions read what the real
 * writers left behind.
 */
function makeRowStore(task: Task) {
  const store = {
    getTask: vi.fn(async () => ({ ...task })),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
      Object.assign(task, patch);
      return { ...task };
    }),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (live: Task) => Partial<Task> | null) => {
      const patch = updater({ ...task });
      if (!patch) return null;
      Object.assign(task, patch);
      return { ...task };
    }),
    moveTask: vi.fn(async (_id: string, column: string) => {
      task.column = column;
    }),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
  };
  return store as unknown as TaskStore & Record<string, ReturnType<typeof vi.fn>>;
}

/** Step 3 of the walk: the scheduler's capacity stamp, verbatim from its call site. */
async function stampCapacityQueued(store: TaskStore, taskId: string) {
  await store.updateTask(taskId, { status: "queued" });
}

/** Step 3's sibling: the dependency/lease-overlap queue write, verbatim from the legacy-store branch. */
async function stampOverlapQueued(store: TaskStore, taskId: string) {
  await store.updateTask(taskId, { status: "queued", blockedBy: null, overlapBlockedBy: "SANE-901" });
}

describe("an execution-lane reseed is not planning-stranded, even after the scheduler queues it", () => {
  it("rebounds a card into the planning lane and keeps it progressing, wedged-free, and refused by every Retry verb", async () => {
    const task = strandedCard();
    const store = makeRowStore(task);

    const reseeded = await reseedExhaustedTransientExecution(
      {
        store,
        getRunContextFor: () => undefined,
        markGraphExecuteSelfRequeued: vi.fn(),
      } as unknown as Parameters<typeof reseedExhaustedTransientExecution>[0],
      task,
      async () => REBOUND_COLUMN,
    );

    expect(reseeded).toBe(true);
    expect(task.column).toBe(REBOUND_COLUMN);
    expect(task.status).toBeNull();
    // The writer under test: the EXECUTION lane's own value, not the planning lane's.
    expect(task.recoveryDisposition).toBe("escalated-execution-reseed");

    await stampCapacityQueued(store, task.id);

    // The row is now the F3 shape on everything except the diagnostic's author.
    expect({ column: task.column, status: task.status, error: task.error, nextRecoveryAt: task.nextRecoveryAt })
      .toEqual({ column: REBOUND_COLUMN, status: "queued", error: null, nextRecoveryAt: null });

    // (a) the wedge layer keeps its silence: no alert for a card waiting for a slot with an intact spec.
    expect(isTaskProgressing(task)).toBe(true);
    expect(describeTaskWedge(task)).toBeNull();

    // (b) every Retry verb refuses, because all four consume this one classification and name the real
    //     status in their refusal. `no-planning-exhaustion-evidence` — not `not-planning-column` — is the
    //     assertion that also proves the rebound target really is a planning lane, i.e. that a status-list
    //     guard could never have caught this.
    expect(classifyPlanningStrandedRetry({ task, ir: IR }))
      .toEqual({ kind: "not-planning-stranded", reason: "no-planning-exhaustion-evidence" });

    // (c) the queue fields the scheduler owns are untouched by the reseed.
    expect(task.overlapBlockedBy ?? null).toBeNull();
    expect(task.steps).toHaveLength(1);
  });

  it("keeps that verdict through the dependency/overlap queue write too", async () => {
    const task = strandedCard({ column: REBOUND_COLUMN, status: null, error: null, recoveryDisposition: "escalated-execution-reseed", recoveryRetryCount: null, nextRecoveryAt: null });
    const store = makeRowStore(task);

    await stampOverlapQueued(store, task.id);

    expect(task.status).toBe("queued");
    expect(task.overlapBlockedBy).toBe("SANE-901");
    expect(isTaskProgressing(task)).toBe(true);
    expect(describeTaskWedge(task)).toBeNull();
    expect(classifyPlanningStrandedRetry({ task, ir: IR }))
      .toEqual({ kind: "not-planning-stranded", reason: "no-planning-exhaustion-evidence" });
  });

  it("covers the branch-conflict reseed the same way, because it keeps the card in its current lane", async () => {
    /* This writer does NOT move the card, and self-healing's sibling variant takes candidates from the
       hold lane as well as WIP/review, so the card can already be standing in the planning lane when the
       reseed lands. That is the shape worth pinning: the refusal must then come from the evidence leg, not
       from the lane, or the lane guard would be doing a job it cannot do. */
    const task = strandedCard({ column: REBOUND_COLUMN, status: "failed", branch: "fusion/sane-900", worktree: "/tmp/worktree" });
    const store = makeRowStore(task);

    const reseeded = await reseedExhaustedBranchConflict(
      { store, getRunContextFor: () => undefined } as unknown as Parameters<typeof reseedExhaustedBranchConflict>[0],
      task,
    );

    expect(reseeded).toBe(true);
    expect(task.column).toBe(REBOUND_COLUMN);
    expect(task.recoveryDisposition).toBe("escalated-execution-reseed");
    await stampCapacityQueued(store, task.id);
    expect(isTaskProgressing(task)).toBe(true);
    expect(describeTaskWedge(task)).toBeNull();
    expect(classifyPlanningStrandedRetry({ task, ir: IR }))
      .toEqual({ kind: "not-planning-stranded", reason: "no-planning-exhaustion-evidence" });
  });

  it("still treats the PLANNING lane's reseed in the same slot as stranded (the control that keeps F3 alive)", async () => {
    /* Same lane, same status, same nulled error and cadence — the ONLY difference is which lane authored
       the diagnostic. If this case ever goes red, the discriminator was widened past its meaning and
       SANE-282's population is un-retryable again. */
    const planningAuthored = strandedCard({
      column: REBOUND_COLUMN,
      status: "queued",
      error: null,
      recoveryRetryCount: null,
      nextRecoveryAt: null,
      recoveryDisposition: "escalated-reseed",
    });

    expect(isTaskProgressing(planningAuthored)).toBe(false);
    expect(describeTaskWedge(planningAuthored)?.reasonKey).toBe("planning-spec-exhausted");
    expect(classifyPlanningStrandedRetry({ task: planningAuthored, ir: IR }))
      .toEqual({ kind: "planning-stranded", via: "planning-exhaustion-evidence" });

    // And the incident sentence itself is unambiguous evidence on either predicate. A card whose scheduled
    // retry still owns it stays silent (the recovery-owner veto), so this row has its cadence cleared too.
    const incident = strandedCard({
      column: REBOUND_COLUMN,
      status: "queued",
      error: SPEC_TIMEOUT_ERROR,
      recoveryDisposition: undefined,
      recoveryRetryCount: null,
      nextRecoveryAt: null,
    });
    expect(describeTaskWedge(incident)?.reasonKey).toBe("planning-spec-exhausted");
  });
});

/*
FNXC:ReseedLaneDiscriminator 2026-11-12-14:54 (RUFU-575):
The behavioural cases above cover the two exported execution reseeds. This scan is what keeps the other
writers honest: it asserts, per file, WHICH lane's reseed value it is allowed to author. A test over source
structure rather than behaviour is justified here for the same reason the engine's other call-site scans are
(see `engine-no-blocking-shellout`, `legacy-tombstones`): the fact under test IS "who may write this value",
and a future writer in an execution file would otherwise re-create a row this file cannot distinguish from a
planning card until somebody alerts on a healthy card again. Comments are stripped first, so an explanatory
note can never satisfy the scan — only an executable write can.
*/
const RESEED_VALUE_WRITERS: Array<{ file: string; values: string[] }> = [
  { file: "packages/engine/src/triage.ts", values: ["escalated-reseed"] },
  { file: "packages/engine/src/scheduler.ts", values: ["escalated-reseed"] },
  // Both lanes legitimately reseed from self-healing: the planning-handoff transport loss and the branch-conflict reclaim.
  { file: "packages/engine/src/self-healing.ts", values: ["escalated-reseed", "escalated-execution-reseed"] },
  { file: "packages/engine/src/executor/run-implementation.ts", values: ["escalated-execution-reseed"] },
  { file: "packages/engine/src/executor/non-continuable-session.ts", values: ["escalated-execution-reseed"] },
  { file: "packages/engine/src/executor/worktree-branch-conflict-handle.ts", values: ["escalated-execution-reseed"] },
  { file: "packages/engine/src/executor/required-artifact-recovery.ts", values: ["escalated-execution-reseed"] },
];

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** Every `recoveryDisposition: "<literal>"` write in the engine's production source. */
function collectReseedWrites(): Array<{ file: string; values: string[] }> {
  const found: string[] = [];
  (function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__tests__" || entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) found.push(full);
    }
  })(join(REPO_ROOT, "packages/engine/src"));

  const re = /recoveryDisposition:\s*"(pending|verification-pending|escalated-reseed|escalated-execution-reseed)"/g;
  const rows: Array<{ file: string; values: string[] }> = [];
  for (const abs of found) {
    const rel = abs.slice(REPO_ROOT.length + 1).split("\\").join("/");
    const values = [...new Set([...stripComments(readFileSync(abs, "utf8")).matchAll(re)].map((m) => m[1]))];
    if (values.length > 0) rows.push({ file: rel, values: values.sort() });
  }
  return rows.sort((a, b) => a.file.localeCompare(b.file));
}

describe("reseed-value call-site allowlist", () => {
  it("names every production writer of a reseed disposition, with the lane each is allowed to author", () => {
    const writes = collectReseedWrites();
    // Guard against a silently empty sweep.
    expect(writes.length).toBeGreaterThanOrEqual(RESEED_VALUE_WRITERS.length);
    expect(writes).toEqual([...RESEED_VALUE_WRITERS].sort((a, b) => a.file.localeCompare(b.file)).map((row) => ({ ...row, values: [...row.values].sort() })));
  });

  it("keeps the execution lane's writers from ever authoring the planning value", () => {
    const writes = collectReseedWrites();
    const offenders = writes
      .filter((row) => row.file.startsWith("packages/engine/src/executor/"))
      .filter((row) => row.values.includes("escalated-reseed"));
    expect(offenders).toEqual([]);
  });
});
