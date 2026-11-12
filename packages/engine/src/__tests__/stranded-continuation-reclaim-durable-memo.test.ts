/*
FNXC:StrandedContinuationReclaim 2026-11-11-23:25 (RUFU-547):
Characterization suite for the two durability holes RUFU-263's bound could not close.

The module's contract says "one note per condition, not one per maintenance pass" and re-examines a
sustained hold on a 30-minute -> 2-hour -> 6-hour ladder. Both halves were unenforceable, for two
independent reasons, and the fix must survive each one SEPARATELY:

  1. the announce bound was a process-local `Set`, so an engine restart, a manager recreation, or a
     second manager instance in another process each re-announced the identical line;
  2. the ladder read its previous width out of the work-item row (`retryAfter` minus `updatedAt`),
     while the re-queue write itself nulls `retryAfter` and the re-holding seam
     (`holdPlanReviewNoOpContinuation` -> `replaceActiveTaskWorkflowContinuation`) installs a row with a
     fresh identity and no `retryAfter` at all. The measured width was therefore NaN, and
     `nextDeferralMs(NaN)` answers rung 0 forever.

So every sweep-level test below runs its passes on a FRESH `SelfHealingManager` (the restart mode), and
between passes replaces the row the way the re-holding seam does (new `id`, new `runId`, `retryAfter`
null). A fake that merely echoed its inputs would pass the old tests; this one asserts on the row and
on the card history read back after each pass.

Surface enumeration (the invariant, not the reported repro): the three memo-loss modes (restart,
fresh row identity, the sweep's own `retryAfter: null`), a genuine dead-lease reclaim that must still
clear the deferral, the owned-family suppressions that must write NOTHING, the malformed-episode read,
the FIFO announce cap, the 24 h re-arm, the reveal that must drop the durable condition, and the
episode-write failure that must not lose the re-queue.
*/
import { describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore, WorkflowWorkItem } from "@fusion/core";
import { STRANDED_CONTINUATION_RECLAIM_METADATA_KEY } from "@fusion/core";

const { recordRunAuditEventMock, resolveTaskLifecycleColumnsMock } = vi.hoisted(() => ({
  recordRunAuditEventMock: vi.fn(async () => undefined),
  resolveTaskLifecycleColumnsMock: vi.fn(async () => ({ complete: "done" })),
}));
vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  resolveTaskLifecycleColumns: resolveTaskLifecycleColumnsMock,
  resolveProjectColumnsForRoles: vi.fn(async () => new Set(["in-review"])),
  resolveWorkflowIrForTask: vi.fn(async () => ({ version: "v2", columns: [], nodes: [], edges: [] })),
  resolveColumnFlags: (column: { id: string }) => column.id === "todo" ? ({ countsTowardWip: true }) : ({ mergeBlocker: true }),
  resolveContainedBackwardTargetForTask: vi.fn(async () => "todo"),
}));
vi.mock("../util/run-audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../util/run-audit.js")>()),
  createRunAuditor: vi.fn(() => ({ database: recordRunAuditEventMock })),
}));

import { SelfHealingManager } from "../self-healing.js";
import {
  FILE_SCOPE_HOLD_REASON_PREFIX,
  RECLAIM_DEFERRAL_LADDER_MS,
  STRANDED_RECLAIM_ANNOUNCED_CAP,
  evaluateStrandedContinuationReclaim,
  readStrandedReclaimEpisode,
  strandedReclaimAnnounceSuppression,
  strandedReclaimEpisodeWrite,
} from "../workflows/stranded-continuation-reclaim.js";

const TOP_RUNG = RECLAIM_DEFERRAL_LADDER_MS[RECLAIM_DEFERRAL_LADDER_MS.length - 1]!;
const STALE = 20 * 60_000;
const HOUR = 3_600_000;

const staleIso = (ms = STALE) => new Date(Date.now() - ms).toISOString();

/** The RUFU-208 shape: `held`, no reason anyone owns, older than the grace window. */
function wedgedRow(overrides: Partial<WorkflowWorkItem> = {}): WorkflowWorkItem {
  return {
    id: "wi-547", runId: "run-547", taskId: "RUFU-208", nodeId: "plan-review", kind: "task",
    state: "held", attempt: 0,
    retryAfter: null, leaseOwner: null, leaseExpiresAt: null, lastError: null, blockedReason: null,
    deferredSince: null,
    createdAt: staleIso(), updatedAt: staleIso(),
    ...overrides,
  } as unknown as WorkflowWorkItem;
}

interface HarnessOptions {
  /** Extra cards the sweep may resolve (a live file-scope holder). */
  extraTasks?: Task[];
  /** Make the durable episode write fail, to prove it cannot block the recovery. */
  episodeWriteFails?: boolean;
  /** Seed the card's unrelated `sourceMetadata` so a key-level write can be proven not to clobber it. */
  seedSourceMetadata?: Record<string, unknown>;
  /** Model a store that does not carry the task-row writer at all (a duck-typed or reduced fake). */
  taskWriterMissing?: boolean;
}

/**
 * Stateful store: transitions apply their patch to the row, and `updateTaskAtomic` merges
 * `sourceMetadataPatch` at KEY level exactly like the real store, so a whole-object overwrite of the
 * episode carrier fails here instead of passing on a mock.
 */
function harness(rows: WorkflowWorkItem[], options: HarnessOptions = {}) {
  const live = rows.map((row) => ({ ...row }));
  const logged: string[] = [];
  const episodeWrites: Array<Record<string, unknown>> = [];
  const task = {
    id: "RUFU-208", title: "wedged card", description: "", column: "todo",
    dependencies: [], steps: [], currentStep: 0, log: [],
    sourceMetadata: { duplicateOfTaskIds: ["RUFU-001"], ...(options.seedSourceMetadata ?? {}) },
    createdAt: staleIso(), updatedAt: staleIso(),
  } as unknown as Task;
  const store = {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false } as Settings)),
    listDueWorkflowWorkItems: vi.fn(async () => live.map((row) => ({ ...row }))),
    getTask: vi.fn(async (id: string) => (id === task.id
      ? task
      : options.extraTasks?.find((entry) => entry.id === id))),
    transitionWorkflowWorkItem: vi.fn(async (id: string, state: string, patch: Record<string, unknown>) => {
      const row = live.find((entry) => entry.id === id);
      if (!row) throw new Error(`unknown work item ${id}`);
      if (patch.expectedState !== row.state) return { ...row };
      const { expectedState, expectedLeaseOwner, ...written } = patch;
      void expectedState; void expectedLeaseOwner;
      Object.assign(row, written, { state });
      return { ...row };
    }),
    /* FNXC:StrandedContinuationReclaim 2026-11-12-10:14 (RUFU-547): omittable, because a store that lacks
       the task-row writer is a shape the sweep must survive, not one only this fake can invent. */
    ...(options.taskWriterMissing ? {} : {
      updateTaskAtomic: vi.fn(async (_id: string, updater: (live: Task) => Record<string, unknown> | null) => {
        const patch = updater(task);
        if (!patch) return task;
        if (options.episodeWriteFails) throw new Error("episode sink down");
        const { sourceMetadataPatch, ...rest } = patch as { sourceMetadataPatch?: Record<string, unknown> };
        Object.assign(task, rest);
        if (sourceMetadataPatch !== undefined) {
          task.sourceMetadata = { ...(task.sourceMetadata ?? {}), ...sourceMetadataPatch };
        }
        if (sourceMetadataPatch) episodeWrites.push(sourceMetadataPatch);
        return task;
      }),
    }),
    logEntry: vi.fn(async (_id: string, message: string) => { logged.push(message); }),
    recordRunAuditEvent: recordRunAuditEventMock,
    getRootDir: vi.fn(() => "/repo"),
    getTasksDir: vi.fn(() => ""),
  } as unknown as TaskStore;
  /* One `SelfHealingManager` instance stands for one engine process: its memos are process-local, so the
     restart the characterization claims has to be modelled as a NEW instance, not assumed per pass. */
  let manager = new SelfHealingManager(store, { rootDir: "/repo" });
  return {
    task,
    store,
    logged,
    episodeWrites,
    readRow: () => ({ ...live[0] }),
    /** Simulate an engine restart: a fresh manager, so every process-local memo starts empty. */
    restart: () => { manager = new SelfHealingManager(store, { rootDir: "/repo" }); },
    pass: async () => {
      await manager.reconcileStrandedWorkflowContinuations();
      return live[0];
    },
    /** How the re-holding seam replaces the row: new identity, no deferral carried over. */
    rehold: (overrides: Partial<WorkflowWorkItem> = {}) => {
      const previous = live[0];
      live[0] = {
        ...previous,
        id: `wi-${Math.random().toString(36).slice(2, 8)}`,
        runId: `run-${Math.random().toString(36).slice(2, 8)}`,
        state: "held",
        retryAfter: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        deferredSince: null,
        createdAt: staleIso(),
        updatedAt: staleIso(),
        ...overrides,
      };
      return live[0];
    },
  };
}

/** Deferral width the sweep just stamped, in ms, measured from the row. */
function stampedWidth(row: WorkflowWorkItem): number {
  expect(row.retryAfter, "the pass stamped a deferral").not.toBeNull();
  return new Date(row.retryAfter!).getTime() - Date.now();
}

function emitted(type?: string): Array<{ type: string; metadata: Record<string, unknown> }> {
  return recordRunAuditEventMock.mock.calls
    .map(([row]) => row as unknown as { type?: string; metadata?: Record<string, unknown> })
    .filter((row) => typeof row.type === "string" && row.type.startsWith("workflowWorkItem:reconcile-stranded"))
    .map((row) => ({ type: row.type!, metadata: row.metadata ?? {} }))
    .filter((row) => type === undefined || row.type === type);
}

describe("reconcileStrandedWorkflowContinuations - the announce bound survives every memo-loss mode (RUFU-547)", () => {
  it("announces once, then stays silent across a restart, a fresh row identity, and its own retryAfter clear", async () => {
    recordRunAuditEventMock.mockClear();
    const h = harness([wedgedRow()]);

    // Pass 1: the wedge is new, so the recovery and its one note both happen.
    await h.pass();
    expect(h.logged.filter((line) => line.includes("[recovery]"))).toHaveLength(1);
    const episode = readStrandedReclaimEpisode(h.task.sourceMetadata);
    expect(episode, "the announce left a durable witness").toBeTruthy();
    expect(episode!.nodeId).toBe("plan-review");
    expect(episode!.announcedConditions).toHaveLength(1);

    // Pass 2: NEW manager (restart) AND a row replaced with fresh identity by the re-holding seam.
    h.restart();
    h.rehold();
    await h.pass();
    expect(h.logged.filter((line) => line.includes("[recovery]")), "restart + fresh identity must not re-announce")
      .toHaveLength(1);

    // Pass 3 and 4: same again. Today this is the ~38-minute drumbeat.
    h.restart();
    h.rehold();
    await h.pass();
    h.restart();
    h.rehold();
    await h.pass();
    expect(h.logged.filter((line) => line.includes("[recovery]")))
      .toHaveLength(1);
    expect(readStrandedReclaimEpisode(h.task.sourceMetadata)!.announcedConditions.map((entry) => entry.key),
      "the deferral passes must carry the announce ledger, not rewrite it")
      .toEqual(["RUFU-208|plan-review|held|<none>"]);
  });

  it("widens the ladder on every observation even though no row ever carries the previous width", async () => {
    recordRunAuditEventMock.mockClear();
    const h = harness([wedgedRow()]);
    await h.pass(); // announce + re-queue, no deferral yet

    const widths: number[] = [];
    for (let pass = 0; pass < 4; pass += 1) {
      h.restart();
      h.rehold(); // fresh identity, retryAfter null: the row holds no width at all
      const row = await h.pass();
      widths.push(stampedWidth(row));
    }

    expect(widths[0], "first deferral takes rung 0").toBeGreaterThanOrEqual(RECLAIM_DEFERRAL_LADDER_MS[0]! - 5_000);
    expect(widths[1], "the second observation must be strictly wider").toBeGreaterThan(widths[0]!);
    expect(widths[2], "and so is the third").toBeGreaterThan(widths[1]!);
    expect(widths[3], "the ladder clamps at its tail, it does not grow past it").toBeLessThanOrEqual(TOP_RUNG + 5_000);
  });

  it("records the reached width durably, and a new condition key on the same wedge never lowers it", async () => {
    recordRunAuditEventMock.mockClear();
    const h = harness([wedgedRow()]);
    await h.pass();                      // announce + re-queue
    h.restart();
    h.rehold();
    await h.pass();                      // first deferral: rung 0, now durable
    const reached = readStrandedReclaimEpisode(h.task.sourceMetadata)!.deferralWidthMs;
    expect(reached).toBeGreaterThanOrEqual(RECLAIM_DEFERRAL_LADDER_MS[0]! - 5_000);

    // The re-holding seam flips the reason vocabulary: the same physical wait, a new condition key.
    // It earns its one line (a changed reason IS new information) but it must not buy a fresh ladder.
    h.restart();
    h.rehold({ blockedReason: "plan-review-close-no-op" });
    await h.pass();
    expect(h.logged.filter((line) => line.includes("[recovery]")), "one line for the genuinely new condition")
      .toHaveLength(2);
    const afterFlip = readStrandedReclaimEpisode(h.task.sourceMetadata)!;
    expect(afterFlip.nodeId, "the same node is the same wedge").toBe("plan-review");
    expect(afterFlip.deferralWidthMs, "the wedge high-water never shrinks").toBeGreaterThanOrEqual(reached);

    h.restart();
    h.rehold({ blockedReason: null });
    await h.pass();
    expect(h.logged.filter((line) => line.includes("[recovery]")), "the original condition stays announced")
      .toHaveLength(2);
    expect(readStrandedReclaimEpisode(h.task.sourceMetadata)!.deferralWidthMs, "and the ladder keeps climbing")
      .toBeGreaterThan(afterFlip.deferralWidthMs);
  });

  it("leaves unrelated sourceMetadata keys standing (key-level write only)", async () => {
    const h = harness([wedgedRow()], { seedSourceMetadata: { handoffFrom: { projectId: "p" } } });
    await h.pass();
    expect(h.task.sourceMetadata).toMatchObject({
      duplicateOfTaskIds: ["RUFU-001"],
      handoffFrom: { projectId: "p" },
    });
    expect(h.task.sourceMetadata![STRANDED_CONTINUATION_RECLAIM_METADATA_KEY]).toBeTruthy();
  });

  it("degrades to the in-process memo when the durable episode write fails, and never loses the re-queue", async () => {
    recordRunAuditEventMock.mockClear();
    const h = harness([wedgedRow()], { episodeWriteFails: true });
    const first = await h.pass();
    expect(first.state, "a failed bookkeeping write must not lose the recovery").toBe("runnable");
    expect(h.logged.filter((line) => line.includes("[recovery]"))).toHaveLength(1);
    expect(readStrandedReclaimEpisode(h.task.sourceMetadata)).toBeNull();

    // Same manager, so the in-process Set is the only bound left: still one line, not two.
    h.rehold();
    await h.pass();
    expect(h.logged.filter((line) => line.includes("[recovery]"))).toHaveLength(1);
  });

  it("writes nothing at all for a wait another seam owns - no line, no row write, no episode", async () => {
    recordRunAuditEventMock.mockClear();
    const holder = {
      id: "RUFU-257", title: "holder", description: "", column: "in-progress",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: staleIso(), updatedAt: staleIso(),
    } as unknown as Task;
    for (const ownedReason of [
      "workflow-principal-abc",
      "workflow-named-principal-abc",
      "workflow-role-pool-abc",
      "workflow-human-merge-approval#sig",
      `${FILE_SCOPE_HOLD_REASON_PREFIX}RUFU-257`,
    ]) {
      const h = harness([wedgedRow({ blockedReason: ownedReason })], { extraTasks: [holder] });
      if (ownedReason.startsWith(FILE_SCOPE_HOLD_REASON_PREFIX)) {
        Object.assign(h.task, { overlapBlockedBy: "RUFU-257" });
      }
      const before = h.readRow();
      await h.pass();
      expect(h.logged, `${ownedReason} wrote a card line`).toHaveLength(0);
      expect(h.episodeWrites, `${ownedReason} wrote the episode`).toHaveLength(0);
      expect(h.task.sourceMetadata![STRANDED_CONTINUATION_RECLAIM_METADATA_KEY], `${ownedReason} left an episode`).toBeUndefined();
      expect(h.readRow().retryAfter, `${ownedReason} hid a row its owner must still see`).toBe(before.retryAfter);
      expect(h.readRow().state).toBe(before.state);
    }
    expect(emitted(), "an owned wait writes no event row either").toHaveLength(0);
  });

  it("still clears the deferral on a genuine reclaim, and only announces once across a restart", async () => {
    recordRunAuditEventMock.mockClear();
    const h = harness([wedgedRow({
      state: "running", blockedReason: null,
      leaseOwner: "executor:RUFU-208", leaseExpiresAt: null,
    })]);
    const first = await h.pass();
    expect(first.state).toBe("runnable");
    expect(first.retryAfter, "a real reclaim never leaves a future-looking gate behind").toBeNull();
    expect(h.logged.filter((line) => line.includes("[recovery]"))).toHaveLength(1);

    // The same dead-lease shape returns, on a fresh manager with a fresh row.
    h.restart();
    h.rehold({ state: "running", leaseOwner: "executor:RUFU-208" });
    const again = await h.pass();
    expect(again.state, "the reclaim itself is never suppressed - only the repeated line is").toBe("runnable");
    expect(h.logged.filter((line) => line.includes("[recovery]")), "the dead-lease line is bounded too")
      .toHaveLength(1);
  });

  it("carries the ladder width and the suppression source on the event rows it already writes", async () => {
    recordRunAuditEventMock.mockClear();
    const h = harness([wedgedRow()]);
    await h.pass();
    const requeued = emitted("workflowWorkItem:reconcile-stranded-requeued");
    expect(requeued).toHaveLength(1);
    expect(requeued[0]!.metadata).toMatchObject({ announceSuppressedBy: "none", deferralWidthMs: 0 });

    h.restart();
    h.rehold();
    await h.pass();
    const noAction = emitted("workflowWorkItem:reconcile-stranded-no-action");
    expect(noAction.length, "the sustained pass records its finding once").toBeGreaterThan(0);
    expect(noAction[0]!.metadata.announceSuppressedBy, "the line was held back by the durable episode")
      .toBe("durable-episode");
    expect(Number(noAction[0]!.metadata.deferralWidthMs))
      .toBeGreaterThanOrEqual(RECLAIM_DEFERRAL_LADDER_MS[0]! - 5_000);
  });

  it("lets a note older than the re-arm bound speak exactly once more, without touching the row", async () => {
    recordRunAuditEventMock.mockClear();
    const h = harness([wedgedRow()]);
    await h.pass();
    h.restart();
    h.rehold();
    await h.pass(); // one deferral, so the re-arm has a ladder to report

    // Age the durable announce stamp past the re-arm bound: the wedge is still stuck a day later.
    const aged = readStrandedReclaimEpisode(h.task.sourceMetadata)!;
    aged.announcedConditions = aged.announcedConditions.map((entry) => ({ ...entry, at: staleIso(25 * HOUR) }));
    h.task.sourceMetadata = {
      ...(h.task.sourceMetadata as Record<string, unknown>),
      [STRANDED_CONTINUATION_RECLAIM_METADATA_KEY]: aged,
    };
    h.restart();
    h.rehold();
    const row = await h.pass();
    expect(row.state, "a re-armed note is a sentence, not a row transition").toBe("held");
    expect(h.logged.filter((line) => line.includes("still stranded")), "one honest re-arm line")
      .toHaveLength(1);
    const refreshed = readStrandedReclaimEpisode(h.task.sourceMetadata)!;
    expect(Date.now() - Date.parse(refreshed.announcedConditions[0]!.at), "the re-arm refreshed its own stamp")
      .toBeLessThan(60_000);
    expect(refreshed.deferralWidthMs, "and the ladder it reports is the one still in force")
      .toBeGreaterThanOrEqual(aged.deferralWidthMs);
  });

  it("writes the announce ledger and its width only through the key-preserving patch channel", async () => {
    recordRunAuditEventMock.mockClear();
    const h = harness([wedgedRow()]);
    await h.pass();
    const keys = h.episodeWrites.flatMap((patch) => Object.keys(patch));
    expect(keys.every((key) => key === STRANDED_CONTINUATION_RECLAIM_METADATA_KEY),
      "no other sourceMetadata key is ever in a patch this sweep sends")
      .toBe(true);
  });

  /*
  FNXC:StrandedContinuationReclaim 2026-11-12-10:14 (RUFU-547):
  The invariant this guards is asymmetric: a lost EPISODE write costs the next episode its cadence, while a
  lost REVEAL record costs this reveal its evidence. The first durable-memo version wrote the reveal's clear as
  `updateTaskAtomic(...).catch(...)`, which absorbs a rejection but not a store that simply has no such method
  — that threw out of the branch and took the reveal's event row and card line with it (measured: the row was
  revealed, `reconcile-stranded-revealed` was absent). Both degraded-writer shapes must still deliver the pair.
  */
  it("a reveal keeps its event row and card line when the task-row writer is missing or throws", async () => {
    for (const mode of ["missing", "throwing"] as const) {
      recordRunAuditEventMock.mockClear();
      const h = harness(
        [wedgedRow({ deferredSince: staleIso(8 * 24 * HOUR), blockedReason: "dependency:RUFU-196" })],
        { taskWriterMissing: mode === "missing", episodeWriteFails: mode === "throwing" },
      );
      Object.assign(h.task, { blockedBy: "RUFU-196" });

      const row = await h.pass();

      expect(row.retryAfter, `${mode} writer: the reveal still opens the due-gate`).toBeNull();
      expect(row.deferredSince, `${mode} writer: the reveal still clears the anchor`).toBeNull();
      expect(emitted("workflowWorkItem:reconcile-stranded-revealed"), `${mode} writer: the event row still lands`)
        .toHaveLength(1);
      expect(h.logged.filter((line) => line.includes("deferral revealed")), `${mode} writer: the card line still lands`)
        .toHaveLength(1);
    }
  });

  it("drops the durable condition on a reveal, so the next episode can speak again", async () => {
    recordRunAuditEventMock.mockClear();
    const h = harness([wedgedRow()]);
    await h.pass();
    h.restart();
    h.rehold();
    await h.pass(); // one deferral, so the reveal has an episode to end
    h.restart();
    h.rehold({ deferredSince: staleIso(8 * 24 * HOUR), blockedReason: "dependency:RUFU-196" });
    Object.assign(h.task, { blockedBy: "RUFU-196" });
    const revealed = await h.pass();
    expect(revealed.retryAfter, "the reveal cleared the ladder").toBeNull();
    expect(readStrandedReclaimEpisode(h.task.sourceMetadata), "the episode went with the deferral").toBeNull();
    expect(h.task.sourceMetadata).toMatchObject({ duplicateOfTaskIds: ["RUFU-001"] });
  });
});

describe("stranded reclaim episode primitives - malformed input never fabricates a rung (RUFU-547)", () => {
  it("reads only a well-formed episode and refuses every partial shape", () => {
    expect(readStrandedReclaimEpisode(undefined)).toBeNull();
    expect(readStrandedReclaimEpisode(null)).toBeNull();
    expect(readStrandedReclaimEpisode({})).toBeNull();
    expect(readStrandedReclaimEpisode({ strandedContinuationReclaim: "yes" })).toBeNull();
    expect(readStrandedReclaimEpisode({ strandedContinuationReclaim: {} })).toBeNull();
    expect(readStrandedReclaimEpisode({
      strandedContinuationReclaim: { signature: "s", nodeId: "n", deferralWidthMs: "30", announcedConditions: [], lastAt: "x" },
    })).toBeNull();
    expect(readStrandedReclaimEpisode({
      strandedContinuationReclaim: { signature: "s", nodeId: "n", deferralWidthMs: -1, announcedConditions: [], lastAt: "x" },
    })).toBeNull();
    expect(readStrandedReclaimEpisode({
      strandedContinuationReclaim: { signature: "s", nodeId: "n", deferralWidthMs: 0, announcedConditions: [{ key: 1 }], lastAt: "x" },
    })).toBeNull();
    // A foreign writer's episode is not ours to read.
    expect(readStrandedReclaimEpisode({
      strandedContinuationReclaim: { signature: "someone-else:episode", nodeId: "n", deferralWidthMs: 0, announcedConditions: [], lastAt: new Date().toISOString() },
    })).toBeNull();
    expect(readStrandedReclaimEpisode({
      strandedContinuationReclaim: { signature: "self-healing:stranded-reclaim:plan-review", nodeId: "plan-review", deferralWidthMs: 0, announcedConditions: [], lastAt: new Date().toISOString() },
    })).toMatchObject({ nodeId: "plan-review" });
  });

  it("caps the announced ledger and never lets a new condition key lower the wedge width", () => {
    const nodeId = "plan-review";
    let episode = strandedReclaimEpisodeWrite({
      existing: null, nodeId, conditionKey: "k0", announced: true, deferralWidthMs: 0, now: Date.now(),
    });
    for (let i = 1; i <= STRANDED_RECLAIM_ANNOUNCED_CAP + 3; i += 1) {
      episode = strandedReclaimEpisodeWrite({
        existing: episode, nodeId, conditionKey: `k${i}`, announced: true, deferralWidthMs: 0, now: Date.now(),
      });
    }
    expect(episode.announcedConditions.length).toBeLessThanOrEqual(STRANDED_RECLAIM_ANNOUNCED_CAP);
    expect(episode.announcedConditions.map((entry) => entry.key).includes("k0"), "the FIFO drops the oldest")
      .toBe(false);

    const widened = strandedReclaimEpisodeWrite({
      existing: episode, nodeId, conditionKey: "k-late", announced: false,
      deferralWidthMs: RECLAIM_DEFERRAL_LADDER_MS[1]!, now: Date.now(),
    });
    const lowered = strandedReclaimEpisodeWrite({
      existing: widened, nodeId, conditionKey: "k-newer", announced: false, deferralWidthMs: 0, now: Date.now(),
    });
    expect(lowered.deferralWidthMs, "a pass that wrote no deferral cannot shrink the high-water")
      .toBe(widened.deferralWidthMs);

    const otherWedge = strandedReclaimEpisodeWrite({
      existing: widened, nodeId: "implementation", conditionKey: "k-other", announced: true,
      deferralWidthMs: 0, now: Date.now(),
    });
    expect(otherWedge.deferralWidthMs, "a different node is a different wedge").toBe(0);
    expect(otherWedge.announcedConditions).toHaveLength(1);
  });

  it("names which half of the bound held the line back, and re-arms after a day", () => {
    const now = Date.now();
    const nodeId = "plan-review";
    const key = "RUFU-208|plan-review|held|<none>";
    const episode = strandedReclaimEpisodeWrite({
      existing: null, nodeId, conditionKey: key, announced: true, deferralWidthMs: 0, now,
    });

    expect(strandedReclaimAnnounceSuppression({ existing: episode, nodeId, conditionKey: key, inProcessAnnounced: false, now }))
      .toMatchObject({ suppressed: true, suppressedBy: "durable-episode", reArm: false });
    expect(strandedReclaimAnnounceSuppression({ existing: episode, nodeId, conditionKey: key, inProcessAnnounced: true, now }))
      .toMatchObject({ suppressed: true, suppressedBy: "in-process-memo" });
    expect(strandedReclaimAnnounceSuppression({ existing: episode, nodeId, conditionKey: "other|node", inProcessAnnounced: false, now }))
      .toMatchObject({ suppressed: false, suppressedBy: "none" });
    expect(strandedReclaimAnnounceSuppression({ existing: null, nodeId, conditionKey: key, inProcessAnnounced: false, now }))
      .toMatchObject({ suppressed: false, suppressedBy: "none" });

    const aged = strandedReclaimAnnounceSuppression({
      existing: episode, nodeId, conditionKey: key, inProcessAnnounced: false,
      now: now + 25 * HOUR,
    });
    expect(aged, "the wedge stays visible at a bounded cadence rather than going silent forever")
      .toMatchObject({ suppressed: false, reArm: true });

    // An unparseable announce stamp must not silence the card forever.
    const corrupt = { ...episode, announcedConditions: [{ key, at: "not-a-date" }] };
    expect(strandedReclaimAnnounceSuppression({ existing: corrupt, nodeId, conditionKey: key, inProcessAnnounced: false, now }))
      .toMatchObject({ suppressed: false });
  });

  it("advances the ladder off the durable width when the row carries none", () => {
    const now = Date.now();
    const row = {
      state: "held", kind: "task", leaseExpiresAt: null, leaseOwner: null, blockedReason: null,
      taskId: "RUFU-208", nodeId: "plan-review", retryAfter: null, deferredSince: null,
    } as const;
    const base = {
      item: row, taskMissing: false, taskTerminal: false, taskPaused: false, live: false,
      enginePaused: false, stalenessMs: STALE, graceMs: 10 * 60_000, now,
      alreadyAnnounced: true,
    };
    const first = evaluateStrandedContinuationReclaim({ ...base, durableDeferralWidthMs: 0 });
    const second = evaluateStrandedContinuationReclaim({ ...base, durableDeferralWidthMs: RECLAIM_DEFERRAL_LADDER_MS[0]! });
    const top = evaluateStrandedContinuationReclaim({ ...base, durableDeferralWidthMs: TOP_RUNG });
    if (first.action !== "defer" || second.action !== "defer" || top.action !== "defer") {
      throw new Error(`expected three deferrals, got ${first.action}/${second.action}/${top.action}`);
    }
    expect(first.deferralWidthMs).toBe(RECLAIM_DEFERRAL_LADDER_MS[0]);
    expect(second.deferralWidthMs).toBe(RECLAIM_DEFERRAL_LADDER_MS[1]);
    expect(top.deferralWidthMs).toBe(TOP_RUNG);
    expect(top).toMatchObject({ sustained: true });
  });

  it("never lets the durable width override a WIDER row-derived width", () => {
    const now = Date.now();
    const stoppedAt = now - STALE;
    const verdict = evaluateStrandedContinuationReclaim({
      item: {
        state: "held", kind: "task", leaseExpiresAt: null, leaseOwner: null, blockedReason: null,
        taskId: "RUFU-208", nodeId: "plan-review",
        retryAfter: new Date(stoppedAt + TOP_RUNG).toISOString(), deferredSince: null,
      },
      taskMissing: false, taskTerminal: false, taskPaused: false, live: false,
      enginePaused: false, stalenessMs: STALE, graceMs: 10 * 60_000, now,
      alreadyAnnounced: true,
      durableDeferralWidthMs: RECLAIM_DEFERRAL_LADDER_MS[0]!,
    });
    expect(verdict.action).toBe("defer");
    if (verdict.action !== "defer") return;
    expect(verdict.deferralWidthMs, "the row is still the wider witness").toBe(TOP_RUNG);
  });
});
