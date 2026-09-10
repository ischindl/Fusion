/*
FNXC:HoldReleaseAttribution 2026-09-09-23:25 (RUFU-209):
On a multi-project host the `Hold-release sweep:` summary line printed no project identity, so
when several boards each logged slow sweeps an operator could not tell WHICH board the budget
alarm belonged to, and per-project regression data could not be assembled from the log at all.
Every summary site — slow-warn, budget-truncated warn, release log, and steady-state debug —
must now name the project key the sweep already contends on (the same `sweepProjectKey` the
in-flight skip uses), appended to the historical `Hold-release sweep:` prefix so existing greps
keep matching. Degradation states are part of the contract: a present-but-blank project id maps to the same `__legacy_unscoped__` partition selection reads use, and a compatibility store
without (or throwing from) the accessor gets a stable synthetic `sweep-store:<n>` instance key.
These tests pin those observables per log level, plus a two-project single-process pass proving
each line names its own board. The clock is a test-owned manual counter (never a call-counting
clock) so an added `deps.now()` read anywhere in the sweep can never move which budget path fires.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { runHoldReleaseSweep, resetHoldReleaseInstrumentation } from "../execution/hold-release.js";
import { schedulerLog } from "../logger.js";

const WF = "custom:wf";
const BASE = 1_000_000;

function task(over: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "t",
    description: "",
    column: "todo",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as Task;
}

/** Single hold column with capacity release + a WIP column — the shape that produces summaries. */
function capacityIr(): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: "todo", label: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", label: "In Progress", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", label: "Done", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function storeWith(
  tasks: Task[],
  ir: WorkflowIr,
  settings: Record<string, unknown>,
  projectId: string | undefined | "throw" | "absent" = "proj-attrib",
): TaskStore {
  const selection = { workflowId: WF, stepIds: [] };
  const store = {
    getSettings: vi.fn(async () => settings),
    listTasks: vi.fn(async () => tasks),
    moveTaskIf: vi.fn(async (id: string, column: string) => {
      const cur = tasks.find((t) => t.id === id)!;
      cur.column = column;
      return { task: cur, moved: true };
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir })),
  } as unknown as Record<string, unknown>;
  if (projectId === "throw") {
    store.getWorkflowSettingsProjectId = () => { throw new Error("compat store"); };
  } else if (projectId === "absent") {
    // no accessor at all: pre-compat store
  } else {
    store.getWorkflowSettingsProjectId = () => projectId;
  }
  return store as unknown as TaskStore;
}

/** Manual test-owned clock: the ONLY way time moves is a test writing `clock.t`. */
function manualClock(start = BASE) {
  const clock = { t: start };
  return { clock, now: () => clock.t };
}

/** Capture every schedulerLog sink with its level so each dispatch can be asserted on its own. */
function captureLogLines() {
  const lines: { level: "log" | "warn" | "debug"; msg: string }[] = [];
  for (const level of ["log", "warn", "debug"] as const) {
    vi.spyOn(schedulerLog, level).mockImplementation((msg: unknown) => {
      lines.push({ level, msg: String(msg) });
    });
  }
  return lines;
}

function summaries(lines: { level: string; msg: string }[], level?: string) {
  return lines
    .filter((l) => l.msg.includes("Hold-release sweep:"))
    .filter((l) => level === undefined || l.level === level)
    .map((l) => l.msg);
}

/** The append-only substring contract: project= is inserted, nothing historical was renamed. */
const HISTORICAL_SUBSTRINGS = [
  "Hold-release sweep: ", "prefetch ", "ir-resolve ", "evaluate ", " over ",
  "reads(settings=", "batchSelections=", "definitions=",
] as const;

describe("hold-release sweep project attribution", () => {
  beforeEach(() => {
    resetHoldReleaseInstrumentation();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the project on the slow-sweep warn line (>= SLOW_SWEEP_WARN_MS, under budget)", async () => {
    const lines = captureLogLines();
    // Capacity is full, so nothing releases: warn is ONLY explainable by the slow-sweep dispatch.
    const held = task({ id: "H", column: "todo" });
    const occupant = task({ id: "O", column: "in-progress" });
    const store = storeWith([held, occupant], capacityIr(), { maxConcurrent: 1 });
    const { clock, now } = manualClock();
    // Time advances during the board read, past the 2000ms warn threshold but under the budget.
    (store.listTasks as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      clock.t = BASE + 2_500;
      return [held, occupant];
    });

    const result = await runHoldReleaseSweep(store, { now });

    const line = summaries(lines, "warn")[0];
    expect(line).toBeDefined();
    expect(line).toContain("Hold-release sweep: project=proj-attrib:");
    expect(line).toContain("sweep exceeded");
    expect(line).not.toContain("budget-truncated");
    for (const sub of HISTORICAL_SUBSTRINGS) expect(line).toContain(sub);
    expect(result.released).toEqual([]);
  });

  it("names the project on the budget-truncated preamble warn, with the overrun attributed", async () => {
    const lines = captureLogLines();
    const held = task({ id: "H", column: "todo" });
    const store = storeWith([held], capacityIr(), { maxConcurrent: 5 });
    const { clock, now } = manualClock();
    // Trip the tiny budget inside the preamble so logPreambleTruncation owns the line.
    (store.listTasks as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      clock.t = BASE + 50;
      return [held];
    });

    const result = await runHoldReleaseSweep(store, { now, budgetMs: 10 });

    expect(result).toMatchObject({ budgetTruncated: true });
    const line = summaries(lines, "warn")[0];
    expect(line).toContain("project=proj-attrib");
    expect(line).toContain("budget-truncated");
    expect(line).toContain("budgetOverrunMs=40");
    expect(line).toContain("unattributed=");
  });

  it("names the project on the release-line sweep summary (log level)", async () => {
    const lines = captureLogLines();
    const held = task({ id: "H", column: "todo" });
    const store = storeWith([held], capacityIr(), { maxConcurrent: 2 });
    const { now } = manualClock();

    const result = await runHoldReleaseSweep(store, { now });
    expect(result.released).toEqual(["H"]);

    const line = summaries(lines, "log")[0];
    expect(line).toBeDefined();
    expect(line).toContain("Hold-release sweep: project=proj-attrib:");
    expect(line).toContain("released=1");
  });

  it("names the project on the quiet steady-state debug line", async () => {
    const lines = captureLogLines();
    const held = task({ id: "H", column: "todo" });
    const occupant = task({ id: "O", column: "in-progress" });
    const store = storeWith([held, occupant], capacityIr(), { maxConcurrent: 1 });
    const { now } = manualClock();

    await runHoldReleaseSweep(store, { now });

    const line = summaries(lines, "debug")[0];
    expect(line).toBeDefined();
    expect(line).toContain("Hold-release sweep: project=proj-attrib:");
  });

  it("attributes each project's own line when two projects sweep in one process", async () => {
    const lines = captureLogLines();
    const alphaTasks = [task({ id: "A-1", column: "todo" }), task({ id: "A-2", column: "todo" }), task({ id: "A-3", column: "todo" })];
    const betaTasks = [
      task({ id: "B-1", column: "todo" }), task({ id: "B-2", column: "todo" }), task({ id: "B-3", column: "todo" }),
      task({ id: "B-4", column: "todo" }), task({ id: "B-5", column: "todo" }),
    ];
    const alpha = storeWith(alphaTasks, capacityIr(), { maxConcurrent: 5 }, "alpha-board");
    const beta = storeWith(betaTasks, capacityIr(), { maxConcurrent: 5 }, "beta-board");
    const { now } = manualClock();

    await runHoldReleaseSweep(alpha, { now });
    await runHoldReleaseSweep(beta, { now });

    const all = summaries(lines);
    expect(all).toHaveLength(2);
    const alphaLine = all.find((l) => l.includes("project=alpha-board"));
    const betaLine = all.find((l) => l.includes("project=beta-board"));
    expect(alphaLine).toBeDefined();
    expect(betaLine).toBeDefined();
    // A line never carries the other board's identity...
    expect(alphaLine).not.toContain("beta-board");
    expect(betaLine).not.toContain("alpha-board");
    // ...and each line's own counts match its own board, so it cannot be mis-attributed by luck.
    expect(alphaLine).toContain("over 3 tasks");
    expect(alphaLine).toContain("scanned=3");
    expect(betaLine).toContain("over 5 tasks");
    expect(betaLine).toContain("scanned=5");
  });

  it("maps a present-but-blank project id to the legacy-unscoped partition", async () => {
    const lines = captureLogLines();
    const store = storeWith([task({ id: "H", column: "todo" })], capacityIr(), { maxConcurrent: 5 }, "   ");
    const { now } = manualClock();

    await runHoldReleaseSweep(store, { now });

    expect(summaries(lines)[0]).toContain("project=__legacy_unscoped__");
  });

  it("gives compatibility stores a stable synthetic key and never throws on a throwing accessor", async () => {
    const lines = captureLogLines();
    const store = storeWith([task({ id: "H", column: "todo" })], capacityIr(), { maxConcurrent: 5 }, "absent");
    const { now } = manualClock();

    await runHoldReleaseSweep(store, { now });
    const first = summaries(lines)[0];
    expect(first).toMatch(/project=sweep-store:\d+/);

    lines.length = 0;
    await runHoldReleaseSweep(store, { now: manualClock(BASE * 2).now });
    const second = summaries(lines)[0];
    // Same store => same synthetic key: two sweeps of one board must grep as one project.
    expect(second.match(/project=[\w:-]+/)![0]).toBe(first.match(/project=[\w:-]+/)![0]);

    // A throwing accessor degrades the same way instead of failing the sweep.
    const throwing = storeWith([task({ id: "H2", column: "todo" })], capacityIr(), { maxConcurrent: 5 }, "throw");
    lines.length = 0;
    await expect(runHoldReleaseSweep(throwing, { now: manualClock(BASE * 3).now })).resolves.toBeDefined();
    expect(summaries(lines)[0]).toMatch(/project=sweep-store:\d+/);
  });

  it("names the identical project key on the concurrent same-project skip line", async () => {
    const lines = captureLogLines();
    const held = task({ id: "H", column: "todo" });
    const store = storeWith([held], capacityIr(), { maxConcurrent: 5 }, "proj-attrib");
    let releaseRead: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
    (store.listTasks as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await gate;
      return [held];
    });
    const { now } = manualClock();

    const first = runHoldReleaseSweep(store, { now });
    const second = await runHoldReleaseSweep(store, { now }); // races the in-flight sweep
    expect(second).toMatchObject({ skippedConcurrent: true });

    releaseRead();
    await first;

    const skipLine = lines.find((l) => l.msg.includes("another sweep is active"));
    expect(skipLine).toBeDefined();
    const summary = summaries(lines).find((l) => l.includes("project="))!;
    expect(summary).toContain("project=proj-attrib");
    // The skip line and the summary line carry the identical key spelling, so one grep finds both.
    const key = summary.match(/project=([\w-]+)/)![1];
    expect(skipLine!.msg).toContain(key);
    expect(key).toBe("proj-attrib");
  });
});
