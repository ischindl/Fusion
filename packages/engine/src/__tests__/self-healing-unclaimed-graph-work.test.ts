/*
FNXC:UnclaimedGraphWork 2026-11-17-01:05 (RUFU-1050) — the owning pass's invariants.

The measured shape this file defends: 136 cards resting in `todo` whose planning continuation is
`runnable`, `waitReason: "planning"`, `status` NULL. Nothing released them and nothing failed them; the
release seam simply announced that the plan review "will run" for a row no consumer would take. This pass
is the owner that was missing, and the risk it introduces is bigger than the bug — a sweep that can
"release a planning wait" is one bad predicate away from becoming a second admission lane that moves cards
the hold/release sweep owns alone.

So the negatives carry as much weight as the repairs, and every one is asserted as a ZERO WRITE, not as a
"no crash":
  - a row ranked past the FIFO due page is QUEUED, not starved;
  - a lease that has not yet gone stale belongs to whoever holds it;
  - a live session owns its card absolutely;
  - a human hold, a paused engine, and auto-merge off are all refusals;
  - only planning (hold/intake) and WIP lanes are candidates, addressed by TRAIT, never by a literal id.
And every repair is asserted as a hand-off: the CAS seam for a deferral/lease, `attemptExecutionRearm` for
a step re-entry (never a hand-authored continuation), and `needs-replan` for a plan (never a plan written
here). No test in this file may pass by the pass writing `column`, `paused`, or a continuation row itself.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings, Task, TaskStore, WorkflowIr, WorkflowWorkItem } from "@fusion/core";

const { resolveWorkflowIrForTaskMock, attemptExecutionRearmMock } = vi.hoisted(() => ({
  resolveWorkflowIrForTaskMock: vi.fn(),
  attemptExecutionRearmMock: vi.fn(),
}));
vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  resolveWorkflowIrForTask: resolveWorkflowIrForTaskMock,
}));
vi.mock("../executor/execution-rearm.js", async (importOriginal) => ({
  /*
  FNXC:UnclaimedGraphWork 2026-11-17-02:47 (RUFU-1050 code-review remediation, P0):
  The authority is REAL except for the one function this pass must not actually run. A whole-module stub
  is what hid the defect this file now pins: with every export stubbed, the pass could hand the FOREACH
  CONTAINER id (`steps`) to the re-arm and the suite stayed green, because nothing in the harness applied
  `resolveStepExecuteOwner`'s test (`kind === "prompt" && seam === "step-execute"`) to the value on the
  call. So the module loads itself and only the side-effecting entry point is replaced.
  */
  ...(await importOriginal<typeof import("../executor/execution-rearm.js")>()),
  attemptExecutionRearm: attemptExecutionRearmMock,
}));

import { SelfHealingManager, type SelfHealingOptions } from "../self-healing.js";
import { resolveStepExecuteOwner } from "../executor/execution-rearm.js";
import {
  resetPlanningContinuationDrainProgress,
  notePlanningContinuationDrainProgress,
} from "../workflows/continuation-drain-progress.js";
import { UNCLAIMED_GRAPH_WORK_EPISODE_METADATA_KEY } from "../workflows/unclaimed-graph-work.js";

const NOW = Date.parse("2026-11-17T00:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
/** Older than the 5-minute staleness floor. */
const STALE_AGO = 6 * 60_000;
/** A POSITIVE measurement that the pump is behind (the leaf is global, so each test owns its value). */
const PUMP_BEHIND_MS = 5 * 60_000;

/** Lanes addressed by trait, so a board whose WIP lane is called `wip` behaves identically. */
const IR = {
  version: "v2", name: "unclaimed-graph-work-test",
  columns: [
    { id: "todo", name: "Todo", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
    { id: "in-progress", name: "WIP", traits: [{ trait: "wip" }] },
    { id: "in-review", name: "Review", traits: [{ trait: "review" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ],
  nodes: [
    { id: "plan", kind: "prompt", config: { seam: "plan" } },
    { id: "plan-review", kind: "prompt", config: { seam: "plan-review" } },
    { id: "execute", kind: "prompt", config: { seam: "execute" } },
    // Mirrors the real IR shape: the template lives INSIDE `config`, and a step-execute owner is a
    // `prompt` node whose seam is `step-execute` — the exact test `resolveStepExecuteOwner` applies.
    {
      id: "steps", kind: "foreach", maxReworkCycles: 3,
      config: { seam: "foreach", template: { nodes: [{ id: "step-execute", kind: "prompt", config: { seam: "step-execute" } }] } },
    },
  ],
} as unknown as WorkflowIr;

/** A non-planning, non-WIP board: the pass must find nothing to examine at all. */
const NO_LANES_IR = {
  version: "v2", name: "unclaimed-no-lanes",
  columns: [
    { id: "review", name: "Review", traits: [{ trait: "review" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ],
  nodes: [],
} as unknown as WorkflowIr;

interface HarnessOptions {
  taskOverrides?: Partial<Task>;
  items?: WorkflowWorkItem[];
  /** Ids the FIFO due page returned. `null` models a store whose due read is unavailable. */
  dueIds?: string[] | null;
  settings?: Partial<Settings>;
  ir?: WorkflowIr;
  /** How long ago the drain last progressed; `null` = this process never observed it. */
  pumpAgeMs?: number | null;
  rearmOutcome?: string;
  promptContent?: string | null;
  isTaskActive?: (taskId: string) => boolean;
  /** Rows the card's audit tail answers with — the terminal-record probe's only input. */
  terminalAuditRows?: Array<Record<string, unknown>>;
}

interface Harness {
  task: Task;
  store: TaskStore;
  manager: SelfHealingManager;
  auditRows: Array<Record<string, unknown>>;
  transitions: Array<{ id: string; state: string; patch: Record<string, unknown> }>;
  historyLines: string[];
  /** Read AFTER the run: the kick bridge increments it through a captured closure. */
  redriveKicks: number;
  taskWrites: Array<Record<string, unknown>>;
}

/** Disposable spec directories, one per harness, removed after each test. */
const tempDirs: string[] = [];

function harness(opts: HarnessOptions = {}): Harness {
  const {
    taskOverrides = {}, items = [planningRow()], dueIds = ["WI-1"],
    settings = {}, ir = IR, pumpAgeMs = PUMP_BEHIND_MS, rearmOutcome = "rearmed",
    promptContent = "# Real spec\n\nsteps and acceptance criteria",
    isTaskActive,
    terminalAuditRows = [],
  } = opts;

  const task = {
    id: "RUFU-1050", title: "Fix unclaimed graph work", description: "",
    column: "todo", status: null, error: null, paused: false, userPaused: false,
    dependencies: [], steps: [], currentStep: 0, log: [], workflowStepResults: [],
    sourceMetadata: {}, createdAt: iso(2 * 60 * 60_000), updatedAt: iso(STALE_AGO), columnMovedAt: iso(STALE_AGO),
    ...taskOverrides,
  } as unknown as Task;
  const rows = [task];

  // The pass reads PROMPT.md to decide whether a replan has anything to plan FROM, so the harness gives it
  // a real (tiny, disposable) spec directory rather than mocking the reader away.
  const tasksDir = mkdtempSync(join(tmpdir(), "rufu-1050-spec-"));
  if (promptContent !== null) {
    mkdirSync(join(tasksDir, "RUFU-1050"), { recursive: true });
    writeFileSync(join(tasksDir, "RUFU-1050", "PROMPT.md"), promptContent, "utf8");
  }
  tempDirs.push(tasksDir);

  const auditRows: Array<Record<string, unknown>> = [];
  const transitions: Harness["transitions"] = [];
  const historyLines: string[] = [];
  const taskWrites: Array<Record<string, unknown>> = [];
  let redriveKicks = 0;

  const store = {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, autoMerge: true, ...settings } as Settings)),
    listTasks: vi.fn(async () => rows),
    getTask: vi.fn(async (id: string) => rows.find((row) => row.id === id)),
    updateTaskAtomic: vi.fn(async (id: string, patch: (current: Task) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) return undefined;
      const write = await patch(row);
      if (write) {
        taskWrites.push(write);
        if (write.sourceMetadataPatch) {
          row.sourceMetadata = { ...(row.sourceMetadata ?? {}), ...(write.sourceMetadataPatch as Record<string, unknown>) };
        }
        for (const [key, value] of Object.entries(write)) {
          if (key !== "sourceMetadataPatch") (row as unknown as Record<string, unknown>)[key] = value;
        }
      }
      return row;
    }),
    listWorkflowWorkItemsForTask: vi.fn(async () => items),
    listDueWorkflowWorkItems: vi.fn(async () => (dueIds === null ? (() => { throw new Error("due read unavailable"); })() : dueIds.map((id) => ({ id })))),
    transitionWorkflowWorkItem: vi.fn(async (id: string, state: string, patch: Record<string, unknown>) => {
      transitions.push({ id, state, patch });
      const settled = items.find((item) => item.id === id);
      return { ...(settled ?? { id }), state: patch.expectedState === settled?.state ? state : "running" } as WorkflowWorkItem;
    }),
    logEntry: vi.fn(async (_id: string, message: string) => { historyLines.push(message); }),
    logEntryOnce: vi.fn(async (_id: string, input: { action: string }) => { historyLines.push(input.action); return true; }),
    getTaskWorkflowSelection: vi.fn(async () => null),
    getTasksDir: vi.fn(() => tasksDir),
    recordRunAuditEvent: vi.fn(async (row: Record<string, unknown>) => { auditRows.push(row); }),
    /*
    FNXC:UnclaimedGraphWork 2026-11-17-02:47 (RUFU-1050 code-review remediation, P1-1):
    The card's own audit tail, which is what the terminal-record probe reads. Empty by default: RUFU-1044's
    measured shape is a dead row with NO terminal audit row anywhere, and a harness that answered "there is
    a record" by default would hide the exact repair this pass exists to make. `terminalAuditRows` feeds the
    positive case instead of a mocked probe, so the decision is taken on a real read.
    */
    getRunAuditEventsAsync: vi.fn(async () => terminalAuditRows),
    withPlanningLifecycleLock: vi.fn(async (_id: string, callback: () => Promise<unknown>) => callback()),
  } as unknown as TaskStore;

  resolveWorkflowIrForTaskMock.mockResolvedValue(ir);
  attemptExecutionRearmMock.mockResolvedValue({ outcome: rearmOutcome, detail: "stubbed" });

  const options = {
    rootDir: "/repo",
    isTaskActive,
    onUnclaimedGraphWorkRedrive: () => { redriveKicks += 1; },
  } as unknown as SelfHealingOptions;

  if (pumpAgeMs === null) resetPlanningContinuationDrainProgress();
  else notePlanningContinuationDrainProgress(NOW - pumpAgeMs);

  const manager = new SelfHealingManager(store, options);

  return {
    task, store, manager, auditRows, transitions, historyLines, taskWrites,
    // The bridge captured the counter by closure, so expose it through a getter: a snapshot taken here
    // would still read 0 after the run kicked twice.
    get redriveKicks() { return redriveKicks; },
  } as unknown as Harness;
}

/** Shape A: the armed planning wait the 136 cards carry. */
function planningRow(overrides: Partial<WorkflowWorkItem> = {}): WorkflowWorkItem {
  return {
    id: "WI-1", runId: "RUN-1", taskId: "RUFU-1050", nodeId: "plan-review", kind: "task",
    state: "runnable", attempt: 0, retryAfter: null, deferredSince: null,
    leaseOwner: null, leaseExpiresAt: null, lastError: null, blockedReason: null,
    stableWorkflowRunId: "RUN-1", continuationSequence: 1, waitReason: "planning",
    sourceColumn: "todo", targetColumn: "in-progress", irHash: null,
    principalAgentId: null, workflowRole: "triage", authorityKind: "role-pool", nodeInstanceId: null,
    createdAt: iso(2 * 60 * 60_000), updatedAt: iso(STALE_AGO),
    ...overrides,
  } as unknown as WorkflowWorkItem;
}

/** Shape B/C: a terminalized row with no attempt and no wait reason. */
function terminalRow(overrides: Partial<WorkflowWorkItem> = {}): WorkflowWorkItem {
  return planningRow({ state: "failed", waitReason: null, nodeId: "execute", nodeInstanceId: null, ...overrides });
}

function passRows(auditRows: Array<Record<string, unknown>>) {
  return auditRows.filter((row) => String(row.mutationType).startsWith("task:reconcile-unclaimed-graph-work"));
}

/** The acted half of the pair: a repair this pass handed to its authority. */
function repairRows(auditRows: Array<Record<string, unknown>>) {
  return auditRows.filter((row) => row.mutationType === "task:reconcile-unclaimed-graph-work");
}

/**
 * FNXC:UnclaimedGraphWork 2026-11-17-02:47 (RUFU-1050 code-review remediation, P1-2): the withheld half.
 * Before this pair existed, `passRows` was the only reader and a withheld card produced nothing at all,
 * which is the reporting hole the review measured (136 cards, zero rows, zero History lines).
 */
function withheldRows(auditRows: Array<Record<string, unknown>>) {
  return auditRows.filter((row) => row.mutationType === "task:reconcile-unclaimed-graph-work-no-action");
}

/** Writes that touch anything besides this pass's own episode key — i.e. an actual repair attempt. */
function repairWrites(writes: Array<Record<string, unknown>>) {
  return writes.filter((write) => !write.sourceMetadataPatch);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  resolveWorkflowIrForTaskMock.mockReset();
  attemptExecutionRearmMock.mockReset();
  resolveWorkflowIrForTaskMock.mockResolvedValue(IR);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetPlanningContinuationDrainProgress();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("reconcileUnclaimedGraphWork — the repairs", () => {
  it("redrives a starved planning wait through the CAS seam and kicks the drain", async () => {
    const h = harness();

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.redriven).toBe(1);
    expect(h.transitions).toHaveLength(1);
    expect(h.transitions[0]).toMatchObject({ id: "WI-1", state: "runnable" });
    // The CAS shape is the whole safety story: expectedState makes losing the race the ordinary outcome.
    expect(h.transitions[0].patch).toMatchObject({ expectedState: "runnable", retryAfter: null, leaseExpiresAt: null });
    // A claimable row is not a claimed one; without the kick the repair waits a full poll interval.
    expect(h.redriveKicks).toBe(1);
  });

  it("writes the episode at KEY level and never touches a lifecycle field", async () => {
    const h = harness();
    h.task.sourceMetadata = { duplicateOf: "RUFU-0001" };

    await h.manager.reconcileUnclaimedGraphWork();

    const episodeWrites = h.taskWrites.filter((write) => write.sourceMetadataPatch);
    expect(episodeWrites.length).toBeGreaterThan(0);
    for (const write of episodeWrites) {
      expect(Object.keys(write)).toEqual(["sourceMetadataPatch"]);
      expect(Object.keys(write.sourceMetadataPatch as object)).toEqual([UNCLAIMED_GRAPH_WORK_EPISODE_METADATA_KEY]);
    }
    expect(h.task.sourceMetadata).toMatchObject({ duplicateOf: "RUFU-0001" });
    // The pass owns no lane authority: no column, no pause, no status.
    for (const write of h.taskWrites) {
      expect(write).not.toHaveProperty("column");
      expect(write).not.toHaveProperty("paused");
      expect(write).not.toHaveProperty("userPaused");
    }
  });

  it("records the repair with ids/counts/fixed enums and a History line naming the next actor", async () => {
    const h = harness();

    await h.manager.reconcileUnclaimedGraphWork();

    const [row] = passRows(h.auditRows);
    expect(row).toBeDefined();
    expect(row!.agentId).toBe("self-healing");
    const metadata = row!.metadata as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual([
      "action", "code", "column", "itemId", "nodeSeam", "outcome", "owner", "redriveCount", "taskId",
    ]);
    expect(metadata.code).toBe("due-unclaimed");
    expect(metadata.action).toBe("redrive");
    expect(metadata.outcome).toBe("repaired");
    // Never a sentence, a path, or a diff.
    for (const value of Object.values(metadata)) {
      expect(typeof value === "number" || typeof value === "boolean" || value === null || typeof value === "string").toBe(true);
      if (typeof value === "string") expect(value.length).toBeLessThan(64);
    }
    expect(h.historyLines.join("\n")).toMatch(/\[unclaimed-graph-work\]/);
    expect(h.historyLines.join("\n")).not.toMatch(/will run/);
  });

  it("hands a WIP-lane terminal step row to attemptExecutionRearm and never seeds a continuation itself", async () => {
    const h = harness({
      taskOverrides: { column: "in-progress" },
      items: [planningRow({ sourceColumn: "in-progress", state: "failed", waitReason: null, nodeId: "steps", nodeInstanceId: "steps#1:step-execute" })],
    });

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.rearmed).toBe(1);
    expect(attemptExecutionRearmMock).toHaveBeenCalledTimes(1);
    const [deps, input] = attemptExecutionRearmMock.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(input).toMatchObject({ taskId: "RUFU-1050", failedNode: "steps#1:step-execute", wipColumn: "in-progress", reason: "self-healing-stranded-recovery" });
    // The reason must come from the closed audit vocabulary, never an invented one.
    expect(deps).toHaveProperty("hasLiveExecutionSurface");
    // A hand-authored re-entry would bypass the worktree proof and the bounded ladder.
    expect(h.transitions).toHaveLength(0);
  });

  /*
  FNXC:UnclaimedGraphWork 2026-11-17-02:47 (RUFU-1050 code-review remediation, P0):
  The assertion above pins a STRING, which is how the wrong identity shipped in the first place. This one
  asks the RE-ENTRY AUTHORITY ITSELF (unmocked, through the importOriginal-spread module) whether the value
  on the call is a node it may install. The container `steps` is `kind: "foreach"`, so it answers null —
  which is precisely the `not-eligible` the pass was answering itself every pass while the RUFU-1044 card
  sat unowned. A mocked authority cannot hide that again, because there is no mock here to hide it.
  */
  it("hands the re-arm an identity the real step-owner authority accepts, not the foreach container", async () => {
    const h = harness({
      taskOverrides: { column: "in-progress" },
      items: [planningRow({ sourceColumn: "in-progress", state: "failed", waitReason: null, nodeId: "steps", nodeInstanceId: "steps#1:step-execute" })],
    });

    await h.manager.reconcileUnclaimedGraphWork();

    const [, input] = attemptExecutionRearmMock.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    const handed = String(input.failedNode);
    expect(await resolveStepExecuteOwner(h.store, h.task, handed)).toBe("steps#1:step-execute");
    // The regression itself, asserted as its own fact: the container id is not an owner.
    expect(await resolveStepExecuteOwner(h.store, h.task, "steps")).toBeNull();
  });

  it("does not count a re-arm the authority refused as a repair", async () => {
    const h = harness({
      taskOverrides: { column: "in-progress" },
      items: [planningRow({ sourceColumn: "in-progress", state: "failed", waitReason: null, nodeId: "steps", nodeInstanceId: "steps#1:step-execute" })],
      rearmOutcome: "no-work-evidence",
    });

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.rearmed).toBe(0);
    expect(outcome.redriven).toBe(0);
    expect(outcome.replanned).toBe(0);
  });

  /*
  FNXC:UnclaimedGraphWork 2026-11-17-03:30 (RUFU-1050 code-review remediation, P1-2 honesty follow-up):
  The refusal must be ANSWERABLE, not merely uncounted. Two things were wrong before: the acted row said
  `outcome: "repaired"` for a hand-off the authority had just refused, and the only true statement about it
  (`re-arm for X @ steps#1:step-execute answered no-work-evidence`) lived in the engine log, which has no
  board surface. So a reviewer asking "why is this card still in WIP?" got a durable row claiming a repair,
  and the truth only if someone happened to grep the daemon log for the pass. Now the row carries the
  refusal and the card carries the authority's own token.
  */
  it("records the re-arm refusal honestly instead of claiming a repair", async () => {
    const h = harness({
      taskOverrides: { column: "in-progress" },
      items: [planningRow({ sourceColumn: "in-progress", state: "failed", waitReason: null, nodeId: "steps", nodeInstanceId: "steps#1:step-execute" })],
      rearmOutcome: "no-work-evidence",
    });

    await h.manager.reconcileUnclaimedGraphWork();

    const [row] = repairRows(h.auditRows);
    const metadata = row?.metadata as Record<string, unknown>;
    expect(metadata?.action).toBe("rearm");
    expect(metadata?.outcome).toBe("authority-refused");
    // Prose, paths, and error text still never enter the row — the token is the authority's own enum value.
    expect(Object.keys(metadata!).sort()).toEqual([
      "action", "code", "column", "itemId", "nodeSeam", "outcome", "owner", "redriveCount", "taskId",
    ]);
    const history = h.historyLines.join("\n");
    expect(history).toMatch(/\[unclaimed-graph-work\]/);
    expect(history).toContain("no-work-evidence");
    expect(history).not.toMatch(/will run/);
  });

  it("signals needs-replan for a terminal planning-lane row that has a durable spec", async () => {
    const h = harness({ items: [terminalRow({ nodeId: "plan-review" })] });

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.replanned).toBe(1);
    expect(h.task.status).toBe("needs-replan");
    expect(h.taskWrites.some((write) => write.status === "needs-replan")).toBe(true);
  });

  /*
  FNXC:UnclaimedGraphWork 2026-11-17-02:47 (RUFU-1050 code-review remediation, P1-1):
  The deadlock this restriction ends. `planAdmissionStall` (RUFU-273) is written by the planning-admission
  sweep and `wipAdmissionStall` (RUFU-393) by hold admission; both are DIAGNOSTICS — RUFU-393 states its own
  episode "is a state record that refuses nothing" — and neither is looking at the card's graph row. Counting
  them as durable recovery records meant a card blocked from *planning* could never get its *dead execution
  row* repaired, because each pass read the other lane's badge as "somebody already owns this". The two
  sweeps waiting on each other, with nothing able to act, is the hole, not the badge.
  */
  it("replans a terminal planning-lane row whose only other record is another sweep's admission stall", async () => {
    const h = harness({ items: [terminalRow({ nodeId: "plan-review" })] });
    h.task.sourceMetadata = {
      planAdmissionStall: { code: "plan-admission-throttled", firstAt: iso(60 * 60_000), ageMs: 60 * 60_000, signature: "sweep:gate:pool" },
      wipAdmissionStall: { stallCode: "wip-admission-throttled", firstAt: iso(60 * 60_000), stallCount: 40 },
    };

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.replanned).toBe(1);
    expect(outcome.withheld).toBe(0);
    expect(h.task.status).toBe("needs-replan");
  });

  /*
  FNXC:UnclaimedGraphWork 2026-11-17-02:47 (RUFU-1050 code-review remediation, P1-1):
  The other half of dropping the proxy. An error sentence the pass cannot attribute to THIS row is not a
  record of it: a card carrying an old merge-conflict sentence and a dead planning row used to withhold on
  `terminal-recorded` forever, because the test was "is `task.error` non-empty". The named exhaustion
  sentences still withhold (the next test), because those DO name the dead row's own terminal decision.
  */
  it("does not read an unrelated error sentence as a record of this dead row", async () => {
    const h = harness({
      items: [terminalRow({ nodeId: "plan-review" })],
      taskOverrides: { status: null, error: "MERGE_CONFLICT: the branch has conflicts with main" },
    });

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.replanned).toBe(1);
    expect(withheldRows(h.auditRows).filter((row) => (row.metadata as Record<string, unknown>).code === "terminal-recorded")).toHaveLength(0);
  });

  it("still withholds when the error names this row's own terminal exhaustion", async () => {
    const h = harness({
      items: [terminalRow({ nodeId: "plan-review" })],
      taskOverrides: { status: null, error: "EXECUTION_REARM_EXHAUSTED: re-arm budget spent at steps#1:step-execute" },
    });

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.replanned).toBe(0);
    expect(withheldRows(h.auditRows).filter((row) => (row.metadata as Record<string, unknown>).code === "terminal-recorded")).toHaveLength(1);
  });

  /*
  FNXC:UnclaimedGraphWork 2026-11-17-02:47 (RUFU-1050 code-review remediation, P1-1):
  The record is READ, not proxied: this is the positive control for the store probe. The row is a real
  `task:execution-rearm-exhausted` answer from the card's own audit tail, which is the only kind of
  evidence that can say "a bounded authority already spent its budget on this exact node".
  */
  it("withholds a terminal row whose own audit tail records a terminal graph failure", async () => {
    const h = harness({
      items: [terminalRow({ nodeId: "plan-review" })],
      terminalAuditRows: [{ mutationType: "task:execution-rearm-exhausted" }],
    });

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.replanned).toBe(0);
    const [row] = withheldRows(h.auditRows);
    expect((row?.metadata as Record<string, unknown>)?.code).toBe("terminal-recorded");
  });

  it("names a terminal planning-lane row with no spec instead of signalling a replan with nothing to plan", async () => {
    const h = harness({ items: [terminalRow({ nodeId: "plan-review" })], promptContent: null });

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.named).toBe(1);
    expect(outcome.replanned).toBe(0);
    expect(h.taskWrites.some((write) => "status" in write)).toBe(false);
    expect(h.historyLines.join("\n")).toMatch(/Nothing will dispatch it automatically/);
  });
});

describe("reconcileUnclaimedGraphWork — the withholdings", () => {
  it("records a row ranked past the FIFO due page as a withhold and writes no repair", async () => {
    // The 136-card shape is queued, not starved; clearing its retryAfter would let it skip the queue.
    const h = harness({ dueIds: [] });

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.examined).toBe(1);
    expect(outcome.withheld).toBe(1);
    expect(h.transitions).toHaveLength(0);
    // FNXC:UnclaimedGraphWork 2026-11-17-02:47 (RUFU-1050 remediation, P1-2): this assertion used to be
    // `taskWrites`/`passRows` both zero, i.e. the suite PINNED the reporting hole. A withhold must still
    // write no repair and no lifecycle field; what it now owes is the paired record.
    expect(repairWrites(h.taskWrites)).toHaveLength(0);
    expect(repairRows(h.auditRows)).toHaveLength(0);
    const [row] = withheldRows(h.auditRows);
    expect(row).toBeDefined();
    const metadata = row!.metadata as Record<string, unknown>;
    expect(metadata.code).toBe("behind-drain-window");
    expect(metadata.action).toBe("none");
    expect(metadata.outcome).toBe("withheld");
    expect(metadata.owner).toBe("drain-window");
    expect(h.historyLines.join("\n")).toMatch(/\[unclaimed-graph-work\]/);
  });

  /*
  FNXC:UnclaimedGraphWork 2026-11-17-02:47 (RUFU-1050 code-review remediation, P1-2):
  The bound is the card's own durable episode, so a sustained stall announces once per window rather than
  once per pass — and, unlike an in-process key, once per window rather than once per BOOT. Both halves
  matter on the measured board: 136 cards on a 2-minute maintenance cadence is ~4 000 rows a day unbounded.
  */
  it("announces a sustained withhold once per window, not once per pass", async () => {
    const h = harness({ dueIds: [] });

    await h.manager.reconcileUnclaimedGraphWork();
    expect(withheldRows(h.auditRows)).toHaveLength(1);

    // Second pass on the same card, same code, inside the window: the episode now carries the report stamp.
    await h.manager.reconcileUnclaimedGraphWork();

    expect(withheldRows(h.auditRows)).toHaveLength(1);
    expect(h.historyLines.filter((line) => line.includes("[unclaimed-graph-work]"))).toHaveLength(1);
  });

  it("announces again once the re-announcement window has passed, keeping the wait's original age", async () => {
    const h = harness({ dueIds: [] });
    const firstAt = iso(3 * 60 * 60_000);
    h.task.sourceMetadata = {
      // An episode reported more than the 6 h floor ago — a stale episode (no stamp at all) is treated the
      // same way, so an upgraded board reports its existing stalls instead of inheriting silence.
      [UNCLAIMED_GRAPH_WORK_EPISODE_METADATA_KEY]: {
        code: "behind-drain-window", firstAt, signature: "unclaimed-graph-work|behind-drain-window|WI-1|runnable|plan-review",
        redriveCount: 0, lastAction: "none", lastReportedAt: iso(7 * 60 * 60_000),
      },
    };

    await h.manager.reconcileUnclaimedGraphWork();

    expect(withheldRows(h.auditRows)).toHaveLength(1);
    const episode = (h.task.sourceMetadata as Record<string, Record<string, unknown>>)[UNCLAIMED_GRAPH_WORK_EPISODE_METADATA_KEY];
    // Re-announcing must not reset the clock on the wait itself.
    expect(episode.firstAt).toBe(firstAt);
  });

  it("keeps healthy work out of the audit store entirely", async () => {
    // A row five minutes old is not yet a finding, and a card a human is holding is a decision, not a
    // stall. RUFU-273/RUFU-372 both measured what happens when a sweep announces these anyway: the store
    // fills with healthy cards and the stall stops being findable.
    const young = harness({ items: [planningRow({ updatedAt: iso(60_000) })] });
    const youngOutcome = await young.manager.reconcileUnclaimedGraphWork();
    const paused = harness({ taskOverrides: { userPaused: true } });
    const pausedOutcome = await paused.manager.reconcileUnclaimedGraphWork();

    expect(youngOutcome.withheld).toBe(1);
    expect(withheldRows(young.auditRows)).toHaveLength(0);
    expect(young.taskWrites).toHaveLength(0);
    expect(pausedOutcome.withheld).toBe(1);
    expect(withheldRows(paused.auditRows)).toHaveLength(0);
    expect(paused.taskWrites).toHaveLength(0);
  });

  it("leaves a young deferral to the wake seams", async () => {
    const h = harness({ items: [planningRow({ state: "retrying", retryAfter: iso(-45_000) })] });

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.withheld).toBe(1);
    expect(h.transitions).toHaveLength(0);
    expect(repairWrites(h.taskWrites)).toHaveLength(0);
  });

  it("does not steal a lease that has not gone stale", async () => {
    const h = harness({ items: [planningRow({ leaseOwner: "node-1", leaseExpiresAt: iso(-10 * 60_000) })] });

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.withheld).toBe(1);
    expect(h.transitions).toHaveLength(0);
    expect(repairWrites(h.taskWrites)).toHaveLength(0);
  });

  it("clears a lease whose row has been untouched past the lease-stale horizon", async () => {
    const h = harness({
      items: [planningRow({ leaseOwner: "node-1", leaseExpiresAt: iso(-40 * 60_000), updatedAt: iso(45 * 60_000) })],
    });

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.redriven).toBe(1);
    expect(h.transitions[0].patch).toMatchObject({ leaseExpiresAt: null });
  });

  it("refuses absolutely while a session is live on the card", async () => {
    const h = harness({ isTaskActive: () => true });

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.withheld).toBe(1);
    expect(outcome.redriven).toBe(0);
    expect(h.transitions).toHaveLength(0);
    expect(h.taskWrites).toHaveLength(0);
    // A live session is healthy work, so it earns not even the withheld record.
    expect(withheldRows(h.auditRows)).toHaveLength(0);
  });

  it("refuses while a human holds the card", async () => {
    const h = harness({ taskOverrides: { userPaused: true } });

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.withheld).toBe(1);
    expect(h.taskWrites).toHaveLength(0);
  });

  it("does not signal a replan out from under a planning session in flight", async () => {
    const h = harness({ items: [terminalRow({ nodeId: "plan-review" })], isTaskActive: () => true });

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.replanned).toBe(0);
    expect(h.taskWrites.some((write) => "status" in write)).toBe(false);
  });

  it("does not treat an unobserved drain as starvation", async () => {
    // A CLI one-shot has never run the pump. Silence is not evidence of a stall.
    const h = harness({ pumpAgeMs: null });

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.withheld).toBe(1);
    expect(h.transitions).toHaveLength(0);
  });

  it("skips a card whose IR resolves no planning or WIP lane", async () => {
    const h = harness({ ir: NO_LANES_IR });

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.examined).toBe(0);
    expect(h.store.listWorkflowWorkItemsForTask).not.toHaveBeenCalled();
  });

  it("skips a card standing in a lane that is neither planning nor WIP", async () => {
    const h = harness({ taskOverrides: { column: "in-review" } });

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.examined).toBe(0);
  });

  it("returns without touching the board while the engine is paused", async () => {
    const h = harness({ settings: { enginePaused: true } });

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.examined).toBe(0);
    expect(h.store.listTasks).not.toHaveBeenCalled();
  });

  it("ignores a healthy card whose planning row the drain reached moments ago", async () => {
    const h = harness({ pumpAgeMs: 1_000 });

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.examined).toBe(1);
    expect(outcome.withheld).toBe(1);
    expect(h.transitions).toHaveLength(0);
  });
});

describe("reconcileUnclaimedGraphWork — the redrive budget", () => {
  it("stops redriving once the budget is spent and names the outcome instead", async () => {
    const h = harness();
    h.task.sourceMetadata = {
      [UNCLAIMED_GRAPH_WORK_EPISODE_METADATA_KEY]: {
        code: "due-unclaimed",
        firstAt: iso(3 * 60 * 60_000),
        signature: "unclaimed-graph-work|due-unclaimed|WI-1|runnable|plan-review",
        redriveCount: 3,
      },
    };

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.redriven).toBe(0);
    expect(h.transitions).toHaveLength(0);
    // A spent budget still has to be seen: the record is the deliverable once repair is off the table.
    expect(passRows(h.auditRows)).toHaveLength(1);
    const named = passRows(h.auditRows)[0].metadata as Record<string, unknown>;
    expect(named.action).toBe("name-terminal");
    // `name-terminal` fixes nothing, so the row may not claim it did: `announced` is the honest disposition.
    expect(named.outcome).toBe("announced");
  });

  it("names a spent-budget outcome once per window, not once per maintenance pass", async () => {
    /*
    FNXC:UnclaimedGraphWork 2026-11-17-02:47 (RUFU-1050 code-review remediation, P1-2):
    `name-terminal` writes no repair, so it is the one ACTION whose emission is pure announcement — and
    announcement on a maintenance cadence is a flood (one row per card per pass, forever, for a card whose
    remedy is a human). The bound rides the same durable episode as the withholdings do.
    */
    const h = harness();
    h.task.sourceMetadata = {
      [UNCLAIMED_GRAPH_WORK_EPISODE_METADATA_KEY]: {
        code: "due-unclaimed", firstAt: iso(3 * 60 * 60_000),
        signature: "unclaimed-graph-work|due-unclaimed|WI-1|runnable|plan-review",
        redriveCount: 3, lastAction: "name-terminal", lastReportedAt: iso(60_000),
      },
    };

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.named).toBe(0);
    expect(outcome.withheld).toBe(1);
    expect(repairRows(h.auditRows)).toHaveLength(0);
    expect(h.taskWrites).toHaveLength(0);
  });

  it("preserves firstAt across a same-code repeat and restarts it when the shape changes", async () => {
    const h = harness();
    const firstAt = iso(3 * 60 * 60_000);
    h.task.sourceMetadata = {
      [UNCLAIMED_GRAPH_WORK_EPISODE_METADATA_KEY]: { code: "due-unclaimed", firstAt, signature: "unclaimed-graph-work|due-unclaimed|WI-1|runnable|plan-review", redriveCount: 1 },
    };

    await h.manager.reconcileUnclaimedGraphWork();

    const episode = (h.task.sourceMetadata as Record<string, Record<string, unknown>>)[UNCLAIMED_GRAPH_WORK_EPISODE_METADATA_KEY];
    // A repeat must not reset the clock on the WAIT, or the 136-card stall would read as five minutes old forever.
    expect(episode.firstAt).toBe(firstAt);
    expect(episode.redriveCount).toBe(2);
  });
});

describe("reconcileUnclaimedGraphWork — failure containment", () => {
  it("does not count a CAS that lost the race as a repair", async () => {
    const h = harness();
    (h.store.transitionWorkflowWorkItem as ReturnType<typeof vi.fn>).mockImplementation(async (id: string, _state: string, patch: Record<string, unknown>) => ({
      id, state: patch.expectedState === "runnable" ? "running" : "runnable",
    }));

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.redriven).toBe(0);
    expect(h.redriveKicks).toBe(0);
  });

  it("still redrives when no wake bridge is wired", async () => {
    const h = harness();
    // Model an integration that never wired the kick, exactly like the option `releaseExecutorWorktreeOwnership`
    // that was declared and silently no-opped.
    (h.manager as unknown as { options: Record<string, unknown> }).options.onUnclaimedGraphWorkRedrive = undefined;

    const outcome = await h.manager.reconcileUnclaimedGraphWork();

    expect(outcome.redriven).toBe(1);
  });

  it("survives a store whose due-page read throws", async () => {
    const h = harness({ dueIds: null });

    await expect(h.manager.reconcileUnclaimedGraphWork()).resolves.toMatchObject({ examined: 1 });
    // Unreachable page ⇒ no window verdict, and the row is not silently released past a queue nobody measured.
    expect(h.transitions).toHaveLength(0);
  });

  it("is registered as a pass in both startup recovery and maintenance batch 1", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../self-healing.ts", import.meta.url), "utf8"));
    const registrations = source.split("\n").filter((line) => line.includes('name: "reconcile-unclaimed-graph-work"'));
    expect(registrations).toHaveLength(2);
  });
});

/*
FNXC:UnclaimedGraphWork 2026-11-17-12:05 (RUFU-1050 code-review remediation, F-4):
The review asked for the cost of ONE pass, because the reader could otherwise only estimate it. The cost
of this pass is board-size-proportional by construction, and the number is:

  one getSettings + one FIFO due-page read + one `listTasks` page + ONE batched selection read per page
  + 2 reads per card (getTask + listWorkflowWorkItemsForTask) for a card INSIDE a planning/WIP lane
  + 1 read per card (getTask only) for a card OUTSIDE one, since the lane filter runs before the row read
  + 0 further reads for a healthy card: the two-field pre-filter rejects it before any classification,
    episode write, terminal-record read or audit row.

A wall-clock figure for the reference board is deliberately NOT asserted here: opening a store against the
operator's database applies schema, and no non-blocking perf note is worth that risk. What is pinned is the
READ COUNT, which is the thing that stays true across machines and the thing a future edit can only raise
by editing this test. It is a ratchet: adding a per-card read to the pass fails it, which is the point.
*/
describe("reconcileUnclaimedGraphWork - the cost of one pass is a pinned read budget", () => {
  /** A healthy board: cards in `todo`, rows armed, no unclaimed shape anywhere. */
  function healthyBoard(size: number) {
    const rows = Array.from({ length: size }, (_unused, index) => ({
      id: `RUFU-${1000 + index}`, column: "todo", status: null, paused: false, deletedAt: null,
      sourceMetadata: {}, createdAt: iso(3 * 60_000), updatedAt: iso(3 * 60_000), columnMovedAt: iso(3 * 60_000),
    } as unknown as Task));
    // Armed and waiting, but NOT this pass's shape: no planning wait, and no terminal step row.
    const items = [{ ...planningRow(), waitReason: null, updatedAt: iso(3 * 60_000) }] as unknown as WorkflowWorkItem[];
    const calls: Record<string, number> = {
      getSettings: 0, listTasks: 0, getTask: 0, getTaskWorkflowSelection: 0,
      getTaskWorkflowSelectionsAsync: 0,
      listWorkflowWorkItemsForTask: 0, listDueWorkflowWorkItems: 0,
    };
    const counted = <T extends (...args: never[]) => unknown>(name: keyof typeof calls, fn: T) =>
      vi.fn(async (...args: Parameters<T>) => { calls[name] += 1; return fn(...args); });
    const store = {
      getSettings: counted("getSettings", async () => ({ globalPause: false, enginePaused: false, autoMerge: true } as Settings)),
      // One page: fewer rows than the 500 limit is what ends the walk.
      listTasks: counted("listTasks", async () => rows),
      getTask: counted("getTask", async (id: string) => rows.find((row) => row.id === id)),
      getTaskWorkflowSelection: counted("getTaskWorkflowSelection", async () => null),
      // The batched seam is what the real store offers, so `prefetchWorkflowSelections` takes ONE read for
      // a whole page. A mock without it would measure a shape production never runs.
      getTaskWorkflowSelectionsAsync: counted("getTaskWorkflowSelectionsAsync", async (ids: string[]) => new Map(ids.map((id) => [id, undefined]))),
      listWorkflowWorkItemsForTask: counted("listWorkflowWorkItemsForTask", async () => items),
      listDueWorkflowWorkItems: counted("listDueWorkflowWorkItems", async () => []),
      updateTaskAtomic: vi.fn(async () => undefined),
      transitionWorkflowWorkItem: vi.fn(async () => undefined),
      recordRunAuditEvent: vi.fn(async () => undefined),
      getTasksDir: vi.fn(() => "/nonexistent"),
    } as unknown as TaskStore;
    return { rows, store, calls };
  }

  it("walks a 25-card board on 2 reads per card plus one batched page read, and writes nothing", async () => {
    const { store, calls } = healthyBoard(25);
    resolveWorkflowIrForTaskMock.mockClear();
    const manager = new SelfHealingManager(store, { rootDir: "/repo", isTaskActive: () => false } as unknown as SelfHealingOptions);

    const outcome = await manager.reconcileUnclaimedGraphWork();

    // `examined` counts cards that CARRY one of the two shapes, not cards walked: a healthy board examines
    // nothing, and that is the assertion a reader should trust — the board was still paid for in reads.
    expect(outcome).toMatchObject({ examined: 0, redriven: 0, rearmed: 0, replanned: 0, named: 0, withheld: 0 });
    expect(calls).toEqual({
      getSettings: 1, listTasks: 1, getTask: 25, getTaskWorkflowSelection: 0,
      getTaskWorkflowSelectionsAsync: 1,
      listWorkflowWorkItemsForTask: 25, listDueWorkflowWorkItems: 1,
    });
    // The IR resolver is entered once per candidate card BY DESIGN and answers from the caches the caller
    // owns (selection prefetched in one batch, IR cached per workflow id), so entering it is not a store
    // read. Counting resolver entries would measure the mock, not the cost; the `calls` map above is the
    // cost, and it stays flat per page rather than per card for the selection read.
    expect(store.getTaskWorkflowSelectionsAsync).toHaveBeenCalledTimes(1);
    // A healthy board is silent, and silence here means zero writes rather than zero crashes. It also
    // touches no file: the PROMPT.md read sits behind the shape test, so spec reads are bounded by the
    // candidate count rather than the board size.
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(store.transitionWorkflowWorkItem).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("spares the item read for a card whose lane the pass cannot own", async () => {
    const { store, calls } = healthyBoard(12);
    resolveWorkflowIrForTaskMock.mockClear();
    resolveWorkflowIrForTaskMock.mockResolvedValue(NO_LANES_IR);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", isTaskActive: () => false } as unknown as SelfHealingOptions);

    await manager.reconcileUnclaimedGraphWork();

    // Lane membership is answered from the IR before any row read, so an unowned lane costs no item read.
    expect(calls.listWorkflowWorkItemsForTask).toBe(0);
    expect(calls.getTask).toBe(12);
    expect(calls.getTaskWorkflowSelectionsAsync).toBe(1);
  });
});
