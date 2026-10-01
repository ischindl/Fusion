/*
FNXC:HoldReleaseAttribution 2026-09-10-01:00 (RUFU-209):
Field evidence: sweeps over 151-215-task boards ran 2132-10327 ms with `evaluate` as an anonymous
residual, and the same task's PROMPT.md / work-item list / settings snapshot were re-read by every
consumer of one scheduler pass (readiness gate, stranded diagnostics, the reserveSlot planning-guard
re-check — twice for an ordinary card, three times with a second consumer). This file pins the two
halves of the fix together, on ONE realistic board, so neither can regress without failing the other:

1. Attribution: the sweep summary names the project and every sub-phase bucket, and each measured
   bucket equals the round-trips ACTUALLY performed — asserted three ways at once (the fs PROMPT.md
   read tally, the store-side call spies, and the summary's `reads(...)` counters). A binary clock
   cannot verify bucket magnitudes (every window rounds to 0 ms), so the board sweep runs on a clock
   that advances 1 ms per `now()` call: with one wrapped read per window, `prompt=12ms` IS the twelfth
   read — the bucket stops being an estimate and becomes a count.
2. Memoisation: within one pass every input is read at most once per task id (K consumers of one card
   pay 1 read, not K), the fan-out dependency marker is read once per DISTINCT dependency id — and
   the unsatisfied verdict short-circuit means later dependents don't even touch the next dep — and
   the reserveSlot guard shares the sweep's memo instead of re-reading. Across the pass boundary
   every memo is dead: the second sweep re-reads everything, so no verdict is ever cached between
   passes.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBootstrapPrompt,
  PLAN_REVIEW_GROUP_ID,
  resolveWorkflowIrForTask,
  type Task,
  type TaskStore,
  type WorkflowIr,
} from "@fusion/core";

import {
  evaluateTaskReleaseGate,
  isUnplannedForExecution,
  resetHoldReleaseInstrumentation,
  runHoldReleaseSweep,
  type HoldReleasePass,
} from "../execution/hold-release.js";
import { getPromptPath } from "../execution/spec-staleness.js";
import { schedulerLog } from "../logger.js";

const roots: string[] = [];

/*
Count PROMPT.md reads at the `readFile` seam so every consumer (readiness gate, stranded
diagnostics, reserveSlot guard, evaluateTaskReleaseGate) is tallied without knowing it. The mock is a
pass-through — only the counter is added — so behavior is byte-identical to unmocked fs.
*/
const fsCounts = vi.hoisted(() => ({ promptReads: new Map<string, number>() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const path = typeof args[0] === "string" ? args[0] : String(args[0]);
      if (path.endsWith("/PROMPT.md")) fsCounts.promptReads.set(path, (fsCounts.promptReads.get(path) ?? 0) + 1);
      return actual.readFile(...args);
    },
  };
});

function column(id: string, label: string, trait: string, config: Record<string, unknown> = {}) {
  return { id, label, traits: trait ? [{ trait, config }] : [] };
}

/** hold(release: capacity) → wip(limit) → done; the capacity pool the sweep arbitrates. */
function capacityIr(id: string, wipLimit: number): WorkflowIr {
  return {
    version: "v2",
    id,
    nodes: [],
    edges: [],
    columns: [
      column("hold", "Hold", "hold", { release: "capacity" }),
      column("wip", "WIP", "wip", { limit: wipLimit }),
      column("done", "Done", "complete"),
    ],
  } as unknown as WorkflowIr;
}

/** Same shape but plan-gated: the Plan Review group defaults ON on the hold column. */
const gateIr = {
  version: "v2",
  id: "custom:gate",
  nodes: [
    { id: "start", kind: "start", column: "hold" },
    {
      id: PLAN_REVIEW_GROUP_ID,
      name: "Plan Review",
      kind: "optional-group",
      column: "hold",
      config: { defaultOn: true, template: { nodes: [], edges: [] } },
    },
    { id: "execute", kind: "prompt", column: "wip", config: { prompt: "execute" } },
    { id: "end", kind: "end", column: "done" },
  ],
  edges: [],
  columns: [
    column("hold", "Hold", "hold", { release: "capacity" }),
    column("wip", "WIP", "wip", { limit: 3 }),
    column("done", "Done", "complete"),
  ],
} as unknown as WorkflowIr;

const dependencyIr = {
  version: "v2",
  id: "custom:dep",
  nodes: [],
  edges: [],
  columns: [
    column("waiting", "Waiting", "hold", { release: "dependency" }),
    column("todo", "Todo", ""),
    column("done", "Done", "complete"),
  ],
} as unknown as WorkflowIr;

const manualIr = {
  version: "v2",
  id: "custom:manual",
  nodes: [],
  edges: [],
  columns: [
    column("hold", "Hold", "hold", { release: "manual" }),
    column("wip", "WIP", "WIP", { limit: 4 }),
    column("done", "Done", "complete"),
  ],
} as unknown as WorkflowIr;

const IR_BY_WORKFLOW: Record<string, WorkflowIr> = {
  "custom:open": capacityIr("custom:open", 3),
  "custom:roomy": capacityIr("custom:roomy", 4),
  "custom:seeds": capacityIr("custom:seeds", 3),
  "custom:gate": gateIr,
  "custom:dep": dependencyIr,
  "custom:manual": manualIr,
};

const PLANNED_PROMPT = "# Planned\n\n## Mission\nImplement the approved work.\n";

interface Card {
  id: string;
  wf: string;
  column: string;
  createdAt: string;
  seed?: boolean;
  dependencies?: string[];
}

function seedTask(card: Card): Task {
  return {
    id: card.id,
    title: `Card ${card.id}`,
    description: `Description for ${card.id}`,
    column: card.column,
    status: null,
    dependencies: card.dependencies ?? [],
    steps: [],
    currentStep: 0,
    log: [],
    paused: false,
    userPaused: false,
    createdAt: card.createdAt,
    updatedAt: card.createdAt,
    columnMovedAt: card.createdAt,
  } as Task;
}

/**
 * The realistic board: ≥150 cards touching every release-decision branch, ordered by `createdAt`
 * so the evaluation order (priority → age → id) is deterministic. Capacity pools are per-workflow,
 * which is what makes each tier's outcome independent:
 *  - R-1..R-4 (custom:roomy, limit 4): planned releases — the tier whose `reserveSlot` guard must
 *    reuse the sweep's PROMPT.md memo instead of re-reading (RUFU-209 pass threading).
 *  - R-5..R-8: same pool after it fills → downstream-full BEFORE readiness (zero prompt reads).
 *  - SEED-1..3 (custom:seeds): bootstrap-prompt cards → readiness reads once, diagnostics reuses it.
 *  - G-1..5 (custom:gate): plan-gate refusal reads the work-item list (never the prompt) in the
 *    gate, then diagnostics reads the prompt — the second consumer.
 *  - W-1..6 (custom:dep): SIX cards sharing the SAME two unfinished dependencies — fan-in where
 *    short-circuit-on-first-unsatisfied plus the verdict memo collapse 12 edges into ONE marker
 *    read (X-1's); X-2 is never even consulted.
 *  - M-1: manual-only. BUSY-1..3 statically fill custom:open so the O-1..O-133 padding tier is
 *    downstream-full without consuming any readiness reads (the pre-check runs before the prompt).
 */
function buildBigBoard(): Card[] {
  const cards: Card[] = [];
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  let index = 0;
  const add = (id: string, wf: string, cardColumn: string, extra: Partial<Card> = {}): void => {
    cards.push({ id, wf, column: cardColumn, createdAt: new Date(base + (index += 1) * 1000).toISOString(), ...extra });
  };
  for (let i = 1; i <= 8; i += 1) add(`R-${i}`, "custom:roomy", "hold");
  for (let i = 1; i <= 3; i += 1) add(`SEED-${i}`, "custom:seeds", "hold", { seed: true });
  for (let i = 1; i <= 5; i += 1) add(`G-${i}`, "custom:gate", "hold");
  for (let i = 1; i <= 6; i += 1) add(`W-${i}`, "custom:dep", "waiting", { dependencies: ["X-1", "X-2"] });
  add("X-1", "custom:dep", "todo");
  add("X-2", "custom:dep", "todo");
  add("M-1", "custom:manual", "hold");
  for (let i = 1; i <= 3; i += 1) add(`BUSY-${i}`, "custom:open", "wip");
  for (let i = 1; i <= 133; i += 1) add(`O-${i}`, "custom:open", "hold");
  return cards;
}

async function makeBoardStore(cards: Card[]) {
  const root = await mkdtemp(join(tmpdir(), "fusion-rufu-209-eval-"));
  roots.push(root);
  const tasksDir = join(root, "tasks");
  const tasks = cards.map(seedTask);
  for (const card of cards) {
    const dir = join(tasksDir, card.id);
    await mkdir(dir, { recursive: true });
    const task = tasks.find((item) => item.id === card.id)!;
    await writeFile(
      getPromptPath(tasksDir, card.id),
      card.seed ? buildBootstrapPrompt(task.id, task.title, task.description) : PLANNED_PROMPT,
      "utf8",
    );
  }

  const live = new Map(tasks.map((item) => [item.id, item]));
  const selections = new Map(
    tasks.map((item) => {
      const card = cards.find((c) => c.id === item.id)!;
      return [item.id, { workflowId: card.wf, stepIds: [] }] as const;
    }),
  );
  // The list hands out the LIVE row objects so an in-sweep release moves the row the occupancy
  // counter reads next — simulating, in evaluation order, what production arbitrates inside the move
  // transaction. The release SET is identical either way; only the hold reason's spelling differs.
  const listTasks = vi.fn(async () => tasks.slice());

  const store = {
    getWorkflowSettingsProjectId: () => "proj-rufu-209-eval",
    getRootDir: () => root,
    getTasksDir: () => tasksDir,
    on: vi.fn(),
    getSettings: vi.fn(async () => ({ maxConcurrent: 4, autoMerge: true })),
    listTasks,
    getTask: vi.fn(async (id: string) => live.get(id) ?? null),
    getTaskWorkflowSelection: vi.fn((id: string) => selections.get(id)),
    getTaskWorkflowSelectionAsync: vi.fn(async (id: string) => selections.get(id)),
    getTaskWorkflowSelectionsAsync: vi.fn(async (ids: string[]) =>
      new Map(ids.flatMap((id) => {
        const selection = selections.get(id);
        return selection ? [[id, selection] as const] : [];
      }))),
    getWorkflowDefinition: vi.fn(async (workflowId: string) => ({ ir: IR_BY_WORKFLOW[workflowId] })),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    checkAndRecordUnplannedExecutionBlock: vi.fn(async () => true),
    recordRunAuditEvent: vi.fn(async () => undefined),
    moveTaskIf: vi.fn(async (id: string, target: string, predicate?: (liveRow: Task) => boolean) => {
      const task = live.get(id)!;
      if (predicate && !predicate(task)) return { task, moved: false };
      task.column = target;
      return { task, moved: true };
    }),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const task = live.get(id)!;
      Object.assign(task, patch);
      return task;
    }),
  } as unknown as TaskStore;

  /*
  The scheduler's real `reserveSlot` resolves the task IR from pass-shared caches and re-checks
  `isUnplannedForExecution` with the sweep's pass (scheduler.ts). Mirror it so the guard's memo hit
  is exercised through the same seam production uses.
  */
  const reserveCalls: Array<{ taskId: string; pass: HoldReleasePass | undefined }> = [];
  const reserveIrCache = new Map<string, WorkflowIr>();
  const reserveSlot = async (task: Task, _target: string, pass?: HoldReleasePass) => {
    reserveCalls.push({ taskId: task.id, pass });
    const ir = await resolveWorkflowIrForTask(
      store as Parameters<typeof resolveWorkflowIrForTask>[0],
      task.id,
      reserveIrCache,
      selections as unknown as Parameters<typeof resolveWorkflowIrForTask>[3],
    );
    if (await isUnplannedForExecution(store, task, ir, pass)) return null;
    return { release: () => {} };
  };

  const fsPromptReads = (): number =>
    [...fsCounts.promptReads.values()].reduce((sum, count) => sum + count, 0);

  return { store, listTasks, reserveCalls, reserveSlot, fsPromptReads, tasksDir, live };
}

function captureLogLines() {
  const lines: { level: "log" | "warn" | "debug"; msg: string }[] = [];
  for (const level of ["log", "warn", "debug"] as const) {
    vi.spyOn(schedulerLog, level).mockImplementation((msg: unknown) => {
      lines.push({ level, msg: String(msg) });
    });
  }
  return lines;
}

function summaries(lines: { msg: string }[]): string[] {
  return lines.filter((line) => line.msg.includes("Hold-release sweep:")).map((line) => line.msg);
}

/** 1 ms per `now()` call: every wrapped store read is exactly one clock tick, so a bucket's ms IS
 * its read count and a bucket can no longer hide time it never performed I/O for. */
function monotonicMsClock(): () => number {
  let t = 1_760_000_000_000;
  return () => (t += 1);
}

describe("hold-release sweep evaluate attribution (RUFU-209)", () => {
  beforeEach(() => {
    resetHoldReleaseInstrumentation();
    vi.restoreAllMocks();
    fsCounts.promptReads.clear();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  });

  it("attributes every evaluate sub-phase to the reads actually performed, on one project-named line", async () => {
    const board = await makeBoardStore(buildBigBoard());
    const lines = captureLogLines();
    const result = await runHoldReleaseSweep(board.store, {
      now: monotonicMsClock(),
      reserveSlot: board.reserveSlot,
      isTaskActive: () => false,
    });

    const printed = summaries(lines);
    expect(printed).toHaveLength(1);
    const line = printed[0]!;

    // Step 1's project identity rides the same line the buckets live on.
    expect(line).toContain("Hold-release sweep: project=proj-rufu-209-eval:");

    // Each bucket equals the round-trips actually performed under the 1 ms/read clock:
    // 12 PROMPT.md reads (4 released + 3 seed + 5 gate-card diagnostics), 8 work-item lists
    // (3 seed diagnostics + 5 plan gates), and ONE handoff marker: the first dependent's X-1 read
    // fails, short-circuit stops before X-2, and the other five dependents hit the verdict memo.
    expect(line).toContain("prompt=12ms");
    expect(line).toContain("workitem=8ms");
    expect(line).toContain("handoff=1ms");
    // The honest read tally agrees with the buckets, and the settings prefetch was the only one.
    expect(line).toContain("handoffMarkers=1, prompts=12, workItems=8, evalSettings=0");
    // The residual reconciles `evaluate` instead of vanishing.
    expect(line).toMatch(/unattributed=\d+ms/);

    /*
    FNXC:PlanPremises 2026-09-16-05:35:
    The plan-premise gate (RUFU-145/RUFU-246) is a deliberate second consumer of PROMPT.md: each of
    the 4 released cards adds TWO live unattributed fs reads (pre-move check + live under-lock
    recheck — the release check must never consume the pass memo, because its verdict must reflect
    the filesystem at transaction time). File-system truth is therefore the 12 memo-attributed reads
    PLUS these 8 gate reads; the `prompts=12` bucket still counts only the attributed read phase.
    */
    // File-system truth matches the attributed bucket plus the premise gate's live release-door
    // reads — the fs tally is what would climb the moment a read-phase consumer bypasses the memo.
    expect(board.fsPromptReads()).toBe(20);
    expect(board.store.listWorkflowWorkItemsForTask).toHaveBeenCalledTimes(8);
    expect(board.store.getCompletionHandoffAcceptedMarker).toHaveBeenCalledTimes(1);
    expect(board.store.getSettings).toHaveBeenCalledTimes(1);

    // The scheduler-provided reservation re-checks planning through the SWEEP's pass, and sees a
    // memo that is already warm (the readiness gate ran first). Without pass threading each of these
    // four guards would add its own PROMPT.md read (12 → 16).
    expect(board.reserveCalls.map((call) => call.taskId).sort()).toEqual(["R-1", "R-2", "R-3", "R-4"]);
    const firstPass = board.reserveCalls[0]!.pass;
    expect(firstPass).toBeDefined();
    expect(board.reserveCalls.every((call) => call.pass === firstPass)).toBe(true);
    for (const call of board.reserveCalls) expect(call.pass!.promptMemo.size).toBeGreaterThan(0);

    // Release decisions are the ones this board deserves — attribution changed none of them.
    expect([...result.released].sort()).toEqual(["R-1", "R-2", "R-3", "R-4"]);
    const byReason = (reason: string) => result.held.filter((held) => held.reason === reason).length;
    expect(byReason("downstream-full")).toBe(137); // O-1..133 + R-5..8
    expect(byReason("awaiting-planning:seed-prompt")).toBe(3);
    expect(byReason("awaiting-planning:plan-review-pending")).toBe(5);
    expect(byReason("deps-unsatisfied")).toBe(6);
    expect(byReason("manual-only")).toBe(1);
    expect(result.held).toHaveLength(152);
    expect(result.budgetTruncated).toBeUndefined();
  });

  it("treats every memo as dead at the pass boundary: a second sweep re-reads every input", async () => {
    const board = await makeBoardStore(buildBigBoard());
    const lines = captureLogLines();
    const clock = monotonicMsClock();
    const deps = () => ({ now: clock, reserveSlot: board.reserveSlot, isTaskActive: () => false });

    const first = await runHoldReleaseSweep(board.store, deps());
    const second = await runHoldReleaseSweep(board.store, deps());
    expect(first.released).toHaveLength(4);

    const printed = summaries(lines);
    expect(printed).toHaveLength(2);
    expect(printed[0]!).toContain("prompts=12");
    // Second pass: R-1..4 now occupy the roomy pool, so the whole R tier is downstream-full and
    // unread; only the 3 seeds + 5 gate cards read again — a per-pass cache would print prompts=0.
    expect(printed[1]!).toContain("prompt=8ms");
    expect(printed[1]!).toContain("handoffMarkers=1, prompts=8, workItems=8, evalSettings=0");
    expect(printed[1]!).toContain("released=0");
    expect(second.released).toHaveLength(0);

    // Cumulative file-system / store tallies double per pass — nothing carried across. FS truth =
    // pass 1 (12 attributed + 8 premise-gate live reads over 4 releases) + pass 2 (8 re-reads, 0
    // releases, so zero gate reads).
    expect(board.fsPromptReads()).toBe(28);
    expect(board.store.listWorkflowWorkItemsForTask).toHaveBeenCalledTimes(16);
    expect(board.store.getCompletionHandoffAcceptedMarker).toHaveBeenCalledTimes(2);
    expect(board.store.getSettings).toHaveBeenCalledTimes(2);
  });

  it("evaluateTaskReleaseGate re-reads PROMPT.md per request — board enrichment never sees a stale memo", async () => {
    const board = await makeBoardStore([
      { id: "SEED-1", wf: "custom:seeds", column: "hold", createdAt: "2026-01-01T00:00:01.000Z", seed: true },
    ]);
    const task = board.live.get("SEED-1")!;
    const ir = IR_BY_WORKFLOW["custom:seeds"]!;

    const before = board.fsPromptReads();
    const seeded = await evaluateTaskReleaseGate(board.store, task, { ir });
    expect(seeded).toMatchObject({
      promoteBlocked: true,
      unplannedForExecution: true,
      reason: "seed-prompt",
      releaseTargetColumn: "wip",
    });
    expect(board.fsPromptReads() - before).toBe(1);

    // Flip the input the memo would have frozen: a re-read must flip the verdict, which is only
    // possible if no cross-request cache exists.
    await writeFile(getPromptPath(board.tasksDir, "SEED-1"), PLANNED_PROMPT, "utf8");
    const planned = await evaluateTaskReleaseGate(board.store, task, { ir });
    expect(planned).toMatchObject({ promoteBlocked: false, unplannedForExecution: false, reason: null });
    expect(board.fsPromptReads() - before).toBe(2);
  });

  it("without a pass each caller pays its own read (the memo is opt-in, not ambient)", async () => {
    const board = await makeBoardStore([
      { id: "SEED-1", wf: "custom:seeds", column: "hold", createdAt: "2026-01-01T00:00:01.000Z", seed: true },
    ]);
    const task = board.live.get("SEED-1")!;
    const ir = IR_BY_WORKFLOW["custom:seeds"]!;

    const before = board.fsPromptReads();
    await expect(isUnplannedForExecution(board.store, task, ir)).resolves.toBe(true);
    await expect(isUnplannedForExecution(board.store, task, ir)).resolves.toBe(true);
    expect(board.fsPromptReads() - before).toBe(2);
  });

  it("prints every named bucket on the preamble truncation path, not just the full sweep", async () => {
    const board = await makeBoardStore([
      { id: "SEED-1", wf: "custom:seeds", column: "hold", createdAt: "2026-01-01T00:00:01.000Z", seed: true },
    ]);
    const lines = captureLogLines();
    // The documented two-value shape: first read 0, every later read 20 — the budget (10 ms) can
    // only be crossed between reads, so every wrapped leaf records 0 ms.
    let clock = 0;
    const result = await runHoldReleaseSweep(board.store, {
      now: () => (clock += 1) === 1 ? 0 : 20,
      budgetMs: 10,
    });

    expect(result.budgetTruncated).toBe(true);
    const printed = summaries(lines);
    expect(printed).toHaveLength(1);
    expect(printed[0]!).toContain("budget-truncated unevaluated=0");
    expect(printed[0]!).toContain(
      "(release-config=0ms, dependency=0ms, readiness=0ms, issue-release=0ms, prompt=0ms, unplanned=0ms, workitem=0ms, handoff=0ms, slot=0ms, unattributed=0ms)",
    );
    expect(printed[0]!).toContain("reads(settings=1");
    expect(board.fsPromptReads()).toBe(0);
    expect(board.store.getSettings).toHaveBeenCalledTimes(1);
  });
});
