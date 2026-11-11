/*
FNXC:AbandonedPlanningClaim 2026-11-06-04:40 (RUFU-470) — Step 4: the reclaim owner's invariants.

RUFU-467 froze for 73 minutes in `status:"planning"` with its planner turn already silenced at a
completed tool result, and no sweep in the engine could see it: triage's poll sweep is suppressed while
the processor's `processing` claim is held, re-discovery refuses while any planner claim is held, and
`evictStaleProcessing` — the only thing that releases the claim — refuses whenever a session handle is
retained. Three owners, each waiting on the other. This file pins the fourth owner that breaks the
deadlock, plus the boundaries that keep it from becoming a second execution lane.

Everything is in-memory fakes under fake timers: no real AI, no real worktree, no real agent log, no
real clock. The real `getTaskPlanningOrExecutionLivenessSignal` and the real `emitBoundedRunAudit` seam
are exercised (a mocked seam would test the wrong code), while `resolveWorkflowIrForTask` and
`getAgentLogs` are replaced so lane resolution and session silence are table-driven.

The non-vacuity rule governs every negative here: each refusal is asserted as a ZERO WRITE, and each
aged-card test is paired with the same harness under the bound, where the sweep must be silent. A
candidacy predicate that excludes everything passes every negative and reclaims nothing, which is the
exact shape of the bug being fixed.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentLogEntry, Settings, Task, TaskStore, WorkflowWorkItem } from "@fusion/core";

const { resolveWorkflowIrForTaskMock } = vi.hoisted(() => ({
  resolveWorkflowIrForTaskMock: vi.fn(),
}));
vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  resolveWorkflowIrForTask: resolveWorkflowIrForTaskMock,
}));

import { SelfHealingManager, type SelfHealingOptions } from "../self-healing.js";
import { TriageProcessor } from "../triage.js";

const HOUR = 60 * 60_000;

/** A planning lane addressed by TRAIT, not by a literal `todo`/`triage` id. */
const HOLD_IR = {
  version: "v2", name: "abandoned-planning-test",
  columns: [
    { id: "todo", name: "Todo", traits: [{ trait: "intake" }, { trait: "hold", config: { release: "capacity" } }] },
    { id: "in-progress", name: "WIP", traits: [{ trait: "wip" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ],
  nodes: [],
} as never;

/**
 * TWO SEPARATE planning faces, each carrying exactly one of the two traits that make a lane planning:
 * a pure `intake` column and a pure `hold` column. The RUFU-467 reproduction only ever exercised one
 * face, so this is the IR that proves candidacy keys on lane TRAITS rather than on the reported column.
 */
const TWO_FACE_IR = {
  version: "v2", name: "abandoned-planning-test-two-face",
  columns: [
    { id: "backlog", name: "Backlog", traits: [{ trait: "intake" }] },
    { id: "on-hold", name: "On Hold", traits: [{ trait: "hold", config: { release: "capacity" } }] },
    { id: "wip", name: "WIP", traits: [{ trait: "wip" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ],
  nodes: [],
} as never;

const NON_PLANNING_IR = {
  version: "v2", name: "abandoned-planning-test-non-planning",
  columns: [
    { id: "review", name: "Review", traits: [{ trait: "review" }] },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ],
  nodes: [],
} as never;

interface HarnessOptions {
  /** How long the planner's claim has been held. */
  claimAgeMs?: number;
  /** How long the planner-lane agent log has been silent. */
  sessionSilenceMs?: number;
  /** Replace the last-activity reader entirely (null = the seam is unwired). */
  lastActivityReader?: (() => Promise<number | undefined>) | null;
  releaseImpl?: (taskId: string) => Promise<unknown>;
  /** Omit the processor claim altogether (an explicit `undefined` age would hit the default). */
  noClaim?: boolean;
  /** Leave the release seam unwired, as an integration that never wired triage would be. */
  noRelease?: boolean;
  taskOverrides?: Partial<Task>;
  /**
   * Clone the aged shape into one extra card per listed column, so a test can put the same abandoned
   * planner on a SECOND planning face (a separate `hold` column beside a separate `intake` column)
   * instead of only the face the RUFU-467 reproduction used.
   */
  siblingColumns?: string[];
  items?: WorkflowWorkItem[];
  settings?: Partial<Settings>;
  ir?: never;
  isTaskActive?: (taskId: string) => boolean;
}

function harness(opts: HarnessOptions = {}) {
  const {
    claimAgeMs = 70 * MINUTE_SILENCE, sessionSilenceMs = 65 * MINUTE_SILENCE,
    lastActivityReader, releaseImpl, noClaim = false, noRelease = false,
    taskOverrides = {}, items = [], settings = {},
    ir = HOLD_IR, isTaskActive, siblingColumns = [],
  } = opts;
  const task = {
    id: "RUFU-470", title: "Reclaim abandoned planning sessions", description: "",
    column: "todo", status: "planning", dependencies: [], steps: [], currentStep: 0, log: [],
    createdAt: iso(3 * HOUR), updatedAt: iso(MINUTE_SILENCE), columnMovedAt: iso(3 * HOUR),
    workflowStepResults: [], ...taskOverrides,
  } as unknown as Task;

  const releaseCalls: string[] = [];
  const auditRows: Array<Record<string, unknown>> = [];
  // Same aged shape on every listed sibling column: one card per planning face, same claim age and the
  // same planner silence, so a sweep that only reads one face shows up as a shortfall of repairs.
  const siblings = siblingColumns.map((column, index) => ({
    ...task,
    id: `${task.id}-FACE-${index + 1}`,
    column,
  })) as Task[];
  const rows = [task, ...siblings];
  const allIds = rows.map((row) => row.id);
  const claimAges = noClaim
    ? new Map<string, number>()
    : new Map(allIds.map((id) => [id, Date.now() - claimAgeMs]));
  const planningIds = noClaim ? new Set<string>() : new Set(allIds);

  const store = {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false, autoMerge: true, ...settings } as Settings)),
    listTasks: vi.fn(async () => rows),
    getTask: vi.fn(async (id: string) => rows.find((row) => row.id === id)),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const row = rows.find((candidate) => candidate.id === id);
      return row ? Object.assign(row, patch) : undefined;
    }),
    listWorkflowWorkItemsForTask: vi.fn(async () => items),
    logEntry: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(async () => null),
    getAgentLogs: vi.fn(async (id: string) => [
      { taskId: id, agentId: "planner", timestamp: iso(sessionSilenceMs), type: "tool_result", toolName: "task_document_read" },
    ] as AgentLogEntry[]),
    recordRunAuditEvent: vi.fn(async (row: Record<string, unknown>) => { auditRows.push(row); }),
    withPlanningLifecycleLock: vi.fn(async (_id: string, callback: () => Promise<unknown>) => callback()),
  } as unknown as TaskStore;

  resolveWorkflowIrForTaskMock.mockResolvedValue(ir);

  const options: Partial<SelfHealingOptions> = {
    rootDir: "/repo",
    isTaskActive,
    getPlanningTaskIds: () => planningIds,
    getPlanningClaimStartedAt: () => claimAges,
  };
  if (!noRelease) {
    options.releaseAbandonedPlanningClaim = releaseImpl ?? (async (taskId: string) => {
      releaseCalls.push(taskId);
      return { taskId, verdict: "released", releasedEntryCount: 1, terminatedSessionCount: 1 };
    });
  }
  if (lastActivityReader !== null) {
    options.getPlanningSessionLastActivityAt = lastActivityReader
      ?? (async (id: string) => {
        const rows = (await store.getAgentLogs(id, { tail: 5_000 })) as AgentLogEntry[];
        return rows.length ? Date.parse(rows[rows.length - 1].timestamp as string) : undefined;
      });
  }

  return {
    task, rows, siblings, store, auditRows, releaseCalls,
    manager: new SelfHealingManager(store, options as SelfHealingOptions),
    auditTypes: () => auditRows.map((row) => String(row.mutationType)),
    lastWrite: () => store.updateTask.mock.calls.at(-1)?.[1] as Partial<Task> | undefined,
  };
}

const MINUTE_SILENCE = 60_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

/** Rows the sweep itself wrote, ignoring any other lane's rows. */
function reclaimRows(rows: Array<Record<string, unknown>>) {
  return rows.filter((row) => String(row.mutationType).startsWith("task:reconcile-abandoned-planning"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T04:20:00Z"));
  resolveWorkflowIrForTaskMock.mockReset();
});
afterEach(() => { vi.useRealTimers(); });

describe("reconcileAbandonedPlanningSessions — the reclaim", () => {
  it("terminates the dead turn, releases the claim, and signals needs-replan", async () => {
    const { task, manager, store, releaseCalls, lastWrite } = harness();

    await expect(manager.reconcileAbandonedPlanningSessions()).resolves.toBe(1);

    expect(releaseCalls).toEqual([task.id]);
    expect(lastWrite()).toEqual({ status: "needs-replan" });
    expect(task.status).toBe("needs-replan");
    // AC2: the honest-blocked vocabulary stays the execution lane's alone.
    expect(store.updateTask.mock.calls.every(([, patch]) => !("pauseAborted" in (patch as object)))).toBe(true);
    expect(store.updateTask.mock.calls.every(([, patch]) => !("paused" in (patch as object)))).toBe(true);
  });

  it("records the reclaim with ids/counts/fixed enums only and a History line", async () => {
    const { manager, auditRows, store } = harness();

    await manager.reconcileAbandonedPlanningSessions();

    const [row] = reclaimRows(auditRows);
    expect(row).toBeDefined();
    expect(row!.mutationType).toBe("task:reconcile-abandoned-planning");
    expect(row!.agentId).toBe("self-healing");
    const metadata = row!.metadata as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual([
      "ceilingMs", "claimAgeMs", "column", "outcome", "sessionSilenceMs", "taskId", "terminatedSessionCount",
    ]);
    expect(metadata.outcome).toBe("reclaimed");
    expect(metadata.reason).toBeUndefined();
    expect(metadata.claimAgeMs).toBe(70 * MINUTE_SILENCE);
    expect(metadata.terminatedSessionCount).toBe(1);
    expect(store.logEntry).toHaveBeenCalledWith(
      "RUFU-470",
      expect.stringContaining("planner turn abandoned"),
    );
  });

  it("marks or repairs and never erases: only a status write and a History line mutate the card", async () => {
    const { manager, store, task } = harness();
    const before = structuredClone(task.workflowStepResults);

    await manager.reconcileAbandonedPlanningSessions();

    // Step-result rows, continuations, columns, and worktree metadata are untouched: the repair is a
    // status write plus an appended entry, never a deletion of durable evidence (FN-8492).
    expect(store.updateTask).toHaveBeenCalledTimes(1);
    expect(store.updateTask.mock.calls[0]![1]).toEqual({ status: "needs-replan" });
    expect(task.column).toBe("todo");
    expect(task.workflowStepResults).toEqual(before);
    expect(Object.keys(store).filter((key) => /delete|remove|clear/i.test(key))).toEqual([]);
  });

  it("runs the whole repair inside the same planning lifecycle lock triage's claim path takes", async () => {
    const { manager, store } = harness();

    await manager.reconcileAbandonedPlanningSessions();

    expect(store.withPlanningLifecycleLock).toHaveBeenCalledWith(
      "RUFU-470", expect.any(Function), { holderLabel: "sweep" },
    );
  });

  it("reclaims the pinned shape an unpinned aged card is refused for — the pin is what makes it ours", async () => {
    const pinned = harness();
    await expect(pinned.manager.reconcileAbandonedPlanningSessions()).resolves.toBe(1);

    // Same card, same age, no processor claim: triage's own poll sweep owns that shape within one poll.
    const unpinned = harness({ noClaim: true });
    await expect(unpinned.manager.reconcileAbandonedPlanningSessions()).resolves.toBe(0);
    expect(unpinned.releaseCalls).toEqual([]);
    expect(unpinned.store.updateTask).not.toHaveBeenCalled();
    const [row] = reclaimRows(unpinned.auditRows);
    expect(row!.mutationType).toBe("task:reconcile-abandoned-planning-session-no-action");
    expect((row!.metadata as Record<string, unknown>).reason).toBe("triage-owned-unpinned");
  });

  it("reclaims the abandonment on EVERY planning face, not only the face the repro reported", async () => {
    /*
    AC3's general invariant. The sweep reads lane membership through `resolveColumnFlags` on the card's
    own resolved column, so the identical dead turn sitting on a second planning column must be reclaimed
    too. A sibling card per face — one on the pure `intake` column, one on the pure `hold` column, same
    claim age, same session silence — is what turns a single-column fix into a visible shortfall if the
    candidacy ever narrows back to one column id.
    */
    const local = harness({ ir: TWO_FACE_IR, taskOverrides: { column: "backlog" }, siblingColumns: ["on-hold"] });

    await expect(local.manager.reconcileAbandonedPlanningSessions()).resolves.toBe(2);

    expect([...local.releaseCalls].sort()).toEqual(["RUFU-470", "RUFU-470-FACE-1"]);
    for (const row of [local.task, ...local.siblings]) {
      expect(row.status, row.id).toBe("needs-replan");
    }
    expect(reclaimRows(local.auditRows)).toHaveLength(2);
    expect(reclaimRows(local.auditRows).every((row) => (row.metadata as Record<string, unknown>).outcome === "reclaimed")).toBe(true);
  });

  it("is silent and inert below either bound (the non-vacuity twin of every refusal above)", async () => {
    const youngClaim = harness({ claimAgeMs: 10 * MINUTE_SILENCE });
    await expect(youngClaim.manager.reconcileAbandonedPlanningSessions()).resolves.toBe(0);
    expect(youngClaim.auditRows).toEqual([]);
    expect(youngClaim.store.updateTask).not.toHaveBeenCalled();

    const stillStreaming = harness({ sessionSilenceMs: 5 * MINUTE_SILENCE });
    await expect(stillStreaming.manager.reconcileAbandonedPlanningSessions()).resolves.toBe(0);
    expect(stillStreaming.auditRows).toEqual([]);
    expect(stillStreaming.releaseCalls).toEqual([]);

    // And the same harness past both bounds is reclaimed — proof the two refusals were the bound, not
    // a candidacy predicate that excludes everything.
    const aged = harness();
    await expect(aged.manager.reconcileAbandonedPlanningSessions()).resolves.toBe(1);
  });
});

describe("reconcileAbandonedPlanningSessions — the liveness boundary", () => {
  it("refuses a card whose FN-8492 triple leg is positive (the triple stays absolute)", async () => {
    const { manager, store, releaseCalls, auditRows } = harness({ isTaskActive: () => true });

    await expect(manager.reconcileAbandonedPlanningSessions()).resolves.toBe(0);

    expect(releaseCalls).toEqual([]);
    expect(store.updateTask).not.toHaveBeenCalled();
    const [row] = reclaimRows(auditRows);
    expect(row!.mutationType).toBe("task:reconcile-abandoned-planning-session-no-action");
    expect((row!.metadata as Record<string, unknown>).reason).toBe("live-session");
  });

  it("refuses while ANY active continuation exists, and ignores a terminal one", async () => {
    /*
    The spec named `pending`; `pending` is not a `WorkflowWorkItemState` at all — the vocabulary is
    runnable | running | held | retrying | manual-required | succeeded | failed | cancelled |
    exhausted, and ACTIVE_WORKFLOW_WORK_ITEM_STATES is exactly the first four. The test iterates that
    real active set rather than a guessed one, and adds a terminal row to prove the filter is the state
    and not merely "a row exists".
    */
    for (const state of ["runnable", "running", "held", "retrying"] as const) {
      const items = [{
        id: "wi-1", taskId: "RUFU-470", runId: "r-1", nodeId: "plan", kind: "task",
        state, workflowRole: "triage", createdAt: iso(HOUR), updatedAt: iso(MINUTE_SILENCE),
      } as unknown as WorkflowWorkItem];
      const local = harness({ items });

      await expect(local.manager.reconcileAbandonedPlanningSessions()).resolves.toBe(0);

      expect(local.releaseCalls, `state=${state}`).toEqual([]);
      expect(local.store.updateTask, `state=${state}`).not.toHaveBeenCalled();
      const [row] = reclaimRows(local.auditRows);
      expect((row!.metadata as Record<string, unknown>).reason, `state=${state}`).toBe("continuation-active");
    }

    // A finished continuation claims nothing, so the card stays a candidate.
    const terminal = harness({ items: [{
      id: "wi-1", taskId: "RUFU-470", runId: "r-1", nodeId: "plan", kind: "task",
      state: "succeeded", workflowRole: "triage", createdAt: iso(HOUR), updatedAt: iso(MINUTE_SILENCE),
    } as unknown as WorkflowWorkItem] });
    await expect(terminal.manager.reconcileAbandonedPlanningSessions()).resolves.toBe(1);
  });

  it("refuses when the release seam reports a finalize or subagent leg (FN-1312)", async () => {
    const { manager, store, auditRows } = harness({
      releaseImpl: async () => ({ taskId: "RUFU-470", verdict: "retained-live", reason: "finalize-in-flight" }),
    });

    await expect(manager.reconcileAbandonedPlanningSessions()).resolves.toBe(0);

    expect(store.updateTask).not.toHaveBeenCalled();
    const [row] = reclaimRows(auditRows);
    expect((row!.metadata as Record<string, unknown>).reason).toBe("finalize-in-flight");
  });

  it("refuses when the release seam cannot prove the turn cancelled, mutating nothing", async () => {
    const { manager, store, auditRows } = harness({
      releaseImpl: async () => ({ taskId: "RUFU-470", verdict: "retained-live", reason: "abort-unproven", releasedEntryCount: 0, terminatedSessionCount: 0 }),
    });

    await expect(manager.reconcileAbandonedPlanningSessions()).resolves.toBe(0);

    expect(store.updateTask).not.toHaveBeenCalled();
    expect((reclaimRows(auditRows)[0]!.metadata as Record<string, unknown>).reason).toBe("abort-unproven");
  });

  it("stands down when the aborted turn re-drove the card itself inside the settle window", async () => {
    // The release succeeds, but the card's status has moved on by the time the signal would be written:
    // the turn's own stuck-requeue handler is a legitimate competing re-drive owner, so the sweep writes
    // nothing rather than clearing a claim it just re-acquired.
    const local = harness({
      releaseImpl: async (taskId: string) => {
        local.task.status = "queued";
        return { taskId, verdict: "released", releasedEntryCount: 1, terminatedSessionCount: 1 };
      },
    });

    await expect(local.manager.reconcileAbandonedPlanningSessions()).resolves.toBe(0);

    expect(local.lastWrite()).toBeUndefined();
    expect(local.store.updateTask).not.toHaveBeenCalled();
    const [row] = reclaimRows(local.auditRows);
    const metadata = row!.metadata as Record<string, unknown>;
    expect(metadata.reason).toBe("race-lost");
    // The termination IS reported even though the signal was withheld — the turn really was cancelled.
    expect(metadata.terminatedSessionCount).toBe(1);
  });

  it("re-applies every candidacy gate under the lock and loses the race cleanly", async () => {
    const local = harness();
    // A live planner's operator pauses the card between the scan and the write.
    local.store.getTask = vi.fn(async () => ({ ...local.task, paused: true }) as unknown as Task) as never;

    await expect(local.manager.reconcileAbandonedPlanningSessions()).resolves.toBe(0);

    expect(local.releaseCalls).toEqual([]);
    expect(local.store.updateTask).not.toHaveBeenCalled();
    expect((reclaimRows(local.auditRows)[0]!.metadata as Record<string, unknown>).reason).toBe("race-lost");
  });
});

describe("reconcileAbandonedPlanningSessions — declines, pauses, and cadence", () => {
  it("declines the whole pass when the release seam or a required reader is unwired, using no substitute", async () => {
    /*
    `evictStaleTriageProcessing` is NOT an acceptable fallback for this population: its deletes are
    guarded by the very retention check this population is defined by failing. An unwired seam is
    therefore a silent decline with zero store traffic, never a partial repair.
    */
    const noRelease = harness({ noRelease: true });
    await expect(noRelease.manager.reconcileAbandonedPlanningSessions()).resolves.toBe(0);
    expect(noRelease.store.updateTask).not.toHaveBeenCalled();
    expect(noRelease.auditRows).toEqual([]);

    // No silence reader at all -> the premise is unmeasurable -> the pass declines, not guesses.
    const noReader = harness({ lastActivityReader: null });
    await expect(noReader.manager.reconcileAbandonedPlanningSessions()).resolves.toBe(0);
    expect(noReader.store.updateTask).not.toHaveBeenCalled();
    expect(noReader.auditRows).toEqual([]);

    // No claim-age reader either -> the ceiling cannot be measured -> decline.
    const noClaimAge = harness();
    const bare = new SelfHealingManager(noClaimAge.store as TaskStore, {
      rootDir: "/repo",
      getPlanningTaskIds: () => new Set(["RUFU-470"]),
      getPlanningSessionLastActivityAt: async () => Date.now() - 2 * HOUR,
      releaseAbandonedPlanningClaim: async () => ({ verdict: "released", releasedEntryCount: 1, terminatedSessionCount: 1 }),
    } as SelfHealingOptions);
    await expect(bare.reconcileAbandonedPlanningSessions()).resolves.toBe(0);
    expect(noClaimAge.store.updateTask).not.toHaveBeenCalled();
    expect(noClaimAge.auditRows).toEqual([]);
  });

  it("refuses on unprovable silence (an absent reader result is a refusal, never a reclaim)", async () => {
    const { manager, store, auditRows } = harness({ lastActivityReader: async () => undefined });

    await expect(manager.reconcileAbandonedPlanningSessions()).resolves.toBe(0);

    expect(store.updateTask).not.toHaveBeenCalled();
    expect((reclaimRows(auditRows)[0]!.metadata as Record<string, unknown>).reason).toBe("premise-held");
  });

  it("skips entirely under global or engine pause", async () => {
    for (const pause of [{ globalPause: true }, { enginePaused: true }]) {
      const local = harness({ settings: pause });

      await expect(local.manager.reconcileAbandonedPlanningSessions()).resolves.toBe(0);

      expect(local.releaseCalls, JSON.stringify(pause)).toEqual([]);
      expect(local.store.updateTask, JSON.stringify(pause)).not.toHaveBeenCalled();
      expect(local.auditRows, JSON.stringify(pause)).toEqual([]);
    }
  });

  it("refuses an operator-paused card and a human-merge-held card without touching either", async () => {
    const paused = harness({ taskOverrides: { paused: true, pausedReason: "operator-hold" } });
    await expect(paused.manager.reconcileAbandonedPlanningSessions()).resolves.toBe(0);
    expect(paused.store.updateTask).not.toHaveBeenCalled();
    expect((reclaimRows(paused.auditRows)[0]!.metadata as Record<string, unknown>).reason).toBe("paused");

    const humanMerge = harness({ settings: { autoMerge: false } });
    await expect(humanMerge.manager.reconcileAbandonedPlanningSessions()).resolves.toBe(0);
    expect(humanMerge.store.updateTask).not.toHaveBeenCalled();
    expect((reclaimRows(humanMerge.auditRows)[0]!.metadata as Record<string, unknown>).reason).toBe("human-review-deferred");
  });

  it("is trait-driven on the lane, so an aged card outside a planning lane is refused", async () => {
    const local = harness({ ir: NON_PLANNING_IR, taskOverrides: { column: "review" } });

    await expect(local.manager.reconcileAbandonedPlanningSessions()).resolves.toBe(0);

    expect(local.releaseCalls).toEqual([]);
    expect(local.store.updateTask).not.toHaveBeenCalled();
    expect((reclaimRows(local.auditRows)[0]!.metadata as Record<string, unknown>).reason).toBe("premise-held");
  });

  it("skips silently for every card that is not in the abandoned shape at all", async () => {
    for (const status of [undefined, "needs-replan", "failed", "queued"] as const) {
      const local = harness({ taskOverrides: { status } });

      await expect(local.manager.reconcileAbandonedPlanningSessions()).resolves.toBe(0);

      expect(local.auditRows, String(status)).toEqual([]);
      expect(local.store.updateTask, String(status)).not.toHaveBeenCalled();
    }
  });

  it("deduplicates a sustained refusal to one row per (card, reason) and re-arms after a reclaim", async () => {
    const local = harness({ isTaskActive: () => true });

    await local.manager.reconcileAbandonedPlanningSessions();
    await local.manager.reconcileAbandonedPlanningSessions();
    await local.manager.reconcileAbandonedPlanningSessions();

    expect(reclaimRows(local.auditRows)).toHaveLength(1);
  });

  it("is registered in BOTH startup recovery and the task-recovery maintenance batch", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(new URL("../self-healing.ts", import.meta.url), "utf8");
    const startup = source.indexOf("name: \"reconcile-orphaned-pending-step-results\"");
    const batch1 = source.indexOf("const batch1Fns");
    const batch2 = source.indexOf("const batch2Fns");
    const registrations = [...source.matchAll(/name: "reconcile-abandoned-planning-sessions"/g)].map((m) => m.index);

    expect(batch1).toBeGreaterThan(-1);
    expect(batch2).toBeGreaterThan(-1);
    expect(registrations).toHaveLength(2);
    // Startup registration: after the start of the startup list, before batch 1 is even declared.
    expect(registrations[0]!).toBeGreaterThan(startup);
    expect(registrations[0]!).toBeLessThan(batch1);
    // Maintenance registration lives in batch 2 (`Task recovery`), never batch 1 (`housekeeping ... cleanup only`).
    expect(registrations[1]!).toBeGreaterThan(batch2);
    // The named anchor is the pass it must share a cadence with.
    const anchor = source.indexOf("name: \"reconcile-planning-admission-stall\", fn: () => this.reconcilePlanningAdmissionStalls(maintenanceSurfacing())");
    expect(anchor).toBeGreaterThan(-1);
    expect(Math.abs(anchor - registrations[1]!)).toBeLessThan(2_500);
  });
});

describe("reconcileAbandonedPlanningSessions — the reclaim is consumable", () => {
  /*
  The whole point of the reclaim, asserted as an observable pair against the REAL TriageProcessor rather
  than a mirror of its predicate. RUFU-467's card received a `needs-replan` write at some point and was
  still never planned, because `hasLivePlanningWork` was true — the deadlock only breaks once the claim
  is released. A test asserting only "status is needs-replan" would have passed on RUFU-467.

  One task object is shared by every reader (the sweep's scan, the sweep's re-read, the processor's
  discovery leg, and `updateTask`), and the processor's own `processing` / `processingSince` /
  `activeSessions` state is seeded directly, so any before/after difference is attributable to the
  release and to nothing else.
  */
  function consumableHarness(abortImpl?: (task: Task, processor: TriageProcessor) => unknown) {
    const task = {
      id: "RUFU-470", title: "Reclaim abandoned planning sessions", description: "",
      column: "todo", status: "planning", dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: iso(3 * HOUR), updatedAt: iso(HOUR), columnMovedAt: iso(3 * HOUR),
      workflowStepResults: [],
    } as unknown as Task;

    const store = {
      getProject: () => ({ id: "p1", name: "p", repoPath: ".", workflowIds: ["wf"], defaultWorkflowId: "wf" }),
      getProjectSettings: async () => ({}),
      listProjects: async () => [],
      getTasksByColumn: async () => [],
      getTasksByColumns: async () => [],
      getTasksByColumnsWithActiveWorkflow: async () => [],
      getTasksByStatus: (_p: unknown, statuses: string[]) =>
        statuses.includes("planning") ? [task] : [],
      getTaskWorkflowSelectionAsync: async () => "wf",
      getWorkflowIrByPublicId: async () => HOLD_IR,
      getTask: async () => task,
      listTasks: async () => [task],
      listWorkflowWorkItemsForTask: async () => [],
      getSettings: async () => ({ globalPause: false, enginePaused: false, autoMerge: true, testMode: false }),
      updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => { Object.assign(task, patch); }),
      moveTask: vi.fn(async () => undefined),
      logEntry: vi.fn(async () => undefined),
      recordRunAuditEvent: vi.fn(async () => undefined),
      on: () => undefined,
      off: () => undefined,
      withPlanningLifecycleLock: async (_id: string, cb: () => Promise<unknown>) => cb(),
    } as unknown as TaskStore;

    resolveWorkflowIrForTaskMock.mockResolvedValue(HOLD_IR);
    const processor = new TriageProcessor(store);
    const internals = processor as unknown as {
      processing: Set<string>;
      processingSince: Map<string, number>;
      activeSessions: Map<string, unknown>;
    };
    // The abandoned shape: claimed, claimed past the ceiling, turn handle retained, `status:"planning"`.
    internals.processing.add(task.id);
    internals.processingSince.set(task.id, Date.now() - 70 * MINUTE_SILENCE);
    // Production's handle is an AgentSession: `abort()` is a FUNCTION, `dispose()` detaches it. An
    // AbortController-shaped `abort` property would be a dispose-only handle, which the seam refuses.
    internals.activeSessions.set(task.id, {
      sessionId: "planner-turn",
      abort: () => abortImpl?.(task, processor),
      dispose: () => undefined,
    });

    // The getter the runtime wires the sweep to — this proves the seam is wired, not merely correct.
    expect(processor.getPlanningClaimStartedAt().get(task.id)).toBe(internals.processingSince.get(task.id));

    const manager = new SelfHealingManager(store, {
      rootDir: ".",
      getPlanningTaskIds: () => processor.getPlanningTaskIds(),
      getPlanningClaimStartedAt: () => processor.getPlanningClaimStartedAt(),
      getPlanningSessionLastActivityAt: async () => Date.now() - 65 * MINUTE_SILENCE,
      releaseAbandonedPlanningClaim: (taskId) => processor.releaseAbandonedPlanningClaim(taskId, { liveness: undefined }),
    } as SelfHealingOptions);

    /** The private predicate the poll and the coordinator share, driven directly so this exercises
     * re-discovery alone and not the poll sweep that would also clear the status (the shape RUFU-467
     * never reached). */
    const rediscovery = (tasks: Task[]) => (processor as unknown as {
      discoverReadyPlanningTasks: (allTasks: Task[], now: number) => Promise<Task[]>;
    }).discoverReadyPlanningTasks(tasks, Date.now());

    return { task, store, processor, manager, internals, rediscovery };
  }

  it("re-discovery refuses the aged card while the claim is held, and admits it after the sweep reclaims it", async () => {
    const local = consumableHarness();

    // BEFORE: the claim is held, so re-discovery refuses the card even though the lane admits it.
    await expect(local.rediscovery([structuredClone(local.task)])).resolves.toEqual([]);

    await expect(local.manager.reconcileAbandonedPlanningSessions()).resolves.toBe(1);

    // AFTER: the signal alone was never enough on RUFU-467 — the release is what makes it consumable.
    expect(local.task.status).toBe("needs-replan");
    expect(local.processor.getPlanningTaskIds().has(local.task.id)).toBe(false);
    expect(local.processor.getPlanningClaimStartedAt().size).toBe(0);
    await expect(local.rediscovery([structuredClone(local.task)])).resolves.toEqual([local.task]);
  });

  it("stands down when a competing re-drive owner stamps the card during the settle window", async () => {
    /*
    The settle window's reason for existing. A cancelled turn's catch branch reaches
    `handleStuckAbortRequeue`, which re-drives the card itself; if any such owner ran, the card is
    already re-driven, and a `needs-replan` write from this sweep on top of it would be a second owner
    stamping the same card — while clearing a claim it just re-acquired would be worse. So the sweep
    must write NOTHING and the card must carry the OTHER owner's state, not the sweep's.

    The competing write is driven from the handle's own `abort()`, which is where production observes the
    cancellation, and its promise is returned so the seam's bounded await covers it — the same ordering
    the real catch branch produces relative to the release. It writes through the shared store rather
    than by hand-mutating the object, so the sweep's post-settle re-read is what decides.

    DEVIATION recorded for the PR: the spec asked this test to invoke the private
    `handleStuckAbortRequeue` directly. Driving it needs `resolvePlannerLanesForTaskAsync`, a
    `readNonEmptyPlanningDraft` filesystem read, and the finalize/recover lanes — a fake of most of
    triage — and against a narrow in-memory store its promise REJECTS, which routes the seam to the
    abort-unproven refusal instead of the stand-down path under test. The invariant the spec named (the
    sweep must neither stamp over nor clear a live re-drive owner) is asserted here over the same
    observable transition.
    */
    let competitorRan = false;
    let writesByCompetitor = -1;
    const local = consumableHarness((task, processor) => {
      competitorRan = true;
      void processor;
      return local.store.updateTask(task.id, { status: "needs-replan" } as Partial<Task>).then(() => {
        writesByCompetitor = local.store.updateTask.mock.calls.length;
      });
    });

    await expect(local.manager.reconcileAbandonedPlanningSessions()).resolves.toBe(0);

    // (1) a competing re-drive owner stamped the card, and (2) the sweep added no write on top of it.
    expect(competitorRan).toBe(true);
    expect(writesByCompetitor).toBe(1);
    expect(local.task.status).toBe("needs-replan");
    expect(local.store.updateTask.mock.calls).toHaveLength(writesByCompetitor);
    // The release still completed, so the other owner's signal is actually consumable.
    expect(local.processor.getPlanningTaskIds().has(local.task.id)).toBe(false);
  });
});

