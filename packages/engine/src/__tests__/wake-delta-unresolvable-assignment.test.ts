/*
FNXC:WakeDeltaPhantomIds 2026-11-05-08:55 (RUFU-455):

THE INVARIANT UNDER TEST: no wake/ranking surface publishes an assignment row that the authoritative
by-id predicate cannot resolve, and every withholding is a durable, ids-only audit record.

The defect this encodes (heartbeat run `run-d5f354ac`, agent `agent-5683bf15`, measured 2026-09-30):
the wake delta named `RUFU-454` and `RUFU-455` as `ready_todo (tier 1)` assignments owned by that
agent while `fn_task_show` answered `Task RUFU-454 not found.` for both, and the operator routed work
against a third id this class of surface named. Nothing in the pre-fix code refused any of it — the
only thing in the way was a comment claiming the read "already reads the live task set".

Why each case below is a case and not coverage padding:

 - The population, not just the rendered section, is what must shrink. `boardStateFrom` is the single
   writer of the compared state, so `assignedRows` and `steeringCommentIds` are asserted, not only the
   agent-facing inventory. A phantom left in `assignedRows` is a phantom the durable `wakeCursor`
   acknowledges, which makes the next tick read it as *unchanged* — the guard failing open in one
   direction is what let a stale phantom persist silently.
 - One presence query per collection, never per row: the rejected design was `getTask()` per row, which
   takes `withTaskLock` and hydrates History/settings/merge-queue/stall state each time (RUFU-201/615/
   627/756). A call-count assertion is the only way to keep that from being re-optimized back in.
 - `storeBound` is the operator's discriminator for the guard's own blind spot, so both truth values are
   asserted against a bound and an unbound layer rather than only the convenient one.
 - The `outcome` vocabulary is exactly two values. There is no `scope-mismatch` arm to assert because
   `Task` carries no project identity — the pg parity suite
   (`packages/core/src/__tests__/postgres/task-assigned-agent-parity.pg.test.ts`) proves a foreign row
   and a missing row are one measurement. A third value would be a claim, not a reading.
 - Fail-open is asserted twice (absent probe, throwing probe). Dropping an agent's REAL assignments
   because a diagnostic probe is unavailable converts a phantom-ID bug into a lost-work bug, and the
   whole withhold path must stay testable against the fakes every existing heartbeat suite uses.
 - No task History line is possible for a withheld id (`logEntry` needs a row), so the absence of one is
   asserted to keep a future author from inventing a fabricated card entry to "improve visibility".
 - Metadata is asserted by exact key set, not containment: the audit store is readable by anything with
   query access, so an owner title or payload excerpt added later must fail loudly.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Task, TaskStore } from "@fusion/core";

vi.mock("../logger.js", async () => {
  const { formatMockError } = await import("./heartbeat-test-helpers.js");
  const quietLogger = () => ({
    log: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });
  return {
    createLogger: vi.fn(() => quietLogger()),
    heartbeatLog: quietLogger(),
    formatError: formatMockError,
  };
});

import { heartbeatLog } from "../logger.js";
import { createInboxMessageStore, createWakeCursor, createWakeSnapshot } from "./heartbeat-test-helpers.js";
import {
  classifyFresherWakeSignal,
  collectBoardSignal,
  collectWakeSignals,
  filterResolvableAssignedTasks,
  hasFresherWakeSignal,
  isIdleLadderEligibleWakeSignal,
  resetWakeDeltaWithholdReportsForTests,
} from "../heartbeat-wake-signals.js";

const AGENT_ID = "agent-5683bf15";
const BOUND_PROJECT = "proj_rufu455";

/** The ids the report named, kept literal so this file reads against the incident. */
const LIVE_ID = "RUFU-454";
const PHANTOM_ABSENT_ID = "RUFU-455";
const PHANTOM_TOMBSTONE_ID = "RUFU-456";

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    column: "todo",
    title: `${id} title`,
    dependencies: [],
    ...over,
  } as unknown as Task;
}

const agent = (): Agent =>
  ({ id: AGENT_ID, name: AGENT_ID, role: "executor", roles: ["executor"], state: "idle" }) as unknown as Agent;

interface FakeStoreOptions {
  /** Rows `getTasksByAssignedAgent` hands the surface — the population under guard. */
  assigned: Task[];
  /** Presence rows. Omitted ids read as `absent`; a non-null `deletedAt` reads as a tombstone. */
  presence?: Array<{ id: string; deletedAt: string | null }>;
  /** Omit entirely to exercise the fail-open path. */
  probe?: boolean;
  /** Make the presence probe reject, to exercise the fail-open-on-failure path. */
  probeThrows?: boolean;
  /** An empty `projectId` is the project-agnostic layer that makes `taskProjectScope` a no-op. */
  projectId?: string;
}

function fakeStore(options: FakeStoreOptions) {
  const getTasksByAssignedAgent = vi.fn(async () => options.assigned);
  const getTaskPresence = vi.fn(async (ids: string[]) =>
    (options.presence ?? []).filter((row) => ids.includes(row.id)),
  );
  const recordRunAuditEvent = vi.fn(async () => undefined);

  const store = {
    getTasksByAssignedAgent,
    recordRunAuditEvent,
    logEntry: vi.fn(async () => undefined),
    asyncLayer: { projectId: options.projectId ?? BOUND_PROJECT },
    ...(options.probe === false
      ? {}
      : { getTaskPresence: options.probeThrows ? vi.fn(async () => { throw new Error("probe down"); }) : getTaskPresence }),
    // Auto-claim is irrelevant here and is disabled by passing no snapshot manager, so these stay unused.
    getAutoClaimCandidates: vi.fn(async () => []),
  } as unknown as TaskStore;

  return { store, getTasksByAssignedAgent, getTaskPresence, recordRunAuditEvent };
}

/** Every row the guard should have kept, in the shape `boardStateFrom` writes them. */
function assignedRows(store: ReturnType<typeof fakeStore>["store"], a: Agent = agent()) {
  return collectBoardSignal({ taskStore: store, agent: a });
}

const ALL_PRESENT = [
  { id: LIVE_ID, deletedAt: null },
  { id: PHANTOM_ABSENT_ID, deletedAt: null },
  { id: PHANTOM_TOMBSTONE_ID, deletedAt: null },
];

describe("wake-delta assignment guard (RUFU-455)", () => {
  /*
  The withhold report is deliberately bounded to one row per (agentId, taskId, outcome) PER PROCESS, so a
  suite that re-uses one id across cases must start each case with a fresh episode register — otherwise a
  later case asserting an emission would be asserting a suppression it caused itself.
  */
  beforeEach(() => resetWakeDeltaWithholdReportsForTests());

  describe("withholding reaches every published surface", () => {
    it("drops an absent id and a tombstone from the compared board state", async () => {
      const { store } = fakeStore({
        assigned: [task(LIVE_ID), task(PHANTOM_ABSENT_ID), task(PHANTOM_TOMBSTONE_ID)],
        presence: [
          { id: LIVE_ID, deletedAt: null },
          { id: PHANTOM_TOMBSTONE_ID, deletedAt: "2026-09-30T21:00:00.000Z" },
        ],
      });

      const board = await assignedRows(store);

      expect(board.assignedRows).toEqual([`${LIVE_ID}:todo`]);
    });

    it("drops the phantom's steering ids too, so the durable wake cursor cannot ack one", async () => {
      /*
      The cursor is written from this same population. Had only the rendered section been filtered, the
      cursor would carry `steer-phantom`, the next tick would compare it as known, and the phantom would
      be acknowledged work rather than a withheld row.
      */
      const { store } = fakeStore({
        assigned: [
          task(LIVE_ID, { steeringComments: [{ id: "steer-live" } as never] }),
          task(PHANTOM_ABSENT_ID, { steeringComments: [{ id: "steer-phantom" } as never] }),
        ],
        presence: [{ id: LIVE_ID, deletedAt: null }],
      });

      const board = await assignedRows(store);

      expect(board.steeringCommentIds).toEqual(["steer-live"]);
      expect(board.steeringCommentIds).not.toContain("steer-phantom");
    });

    it("withholds on the multi-signal path too, not only the board-only path", async () => {
      const { store } = fakeStore({
        assigned: [task(LIVE_ID), task(PHANTOM_ABSENT_ID)],
        presence: [{ id: LIVE_ID, deletedAt: null }],
      });

      const snapshot = await collectWakeSignals({
        taskStore: store,
        agent: agent(),
        messageStore: createInboxMessageStore() as never,
      } as never);

      expect(snapshot.boardState.assignedRows).toEqual([`${LIVE_ID}:todo`]);
    });
  });

  describe("a phantom cannot decide whether the tick dispatches", () => {
    /*
    FNXC:WakeDeltaPhantomIds 2026-11-05-09:25 (RUFU-455):
    The gate is the publish an agent never sees and the one that costs the most: a delta classified
    `board-assignment` forces a FULL session, because `isIdleLadderEligibleWakeSignal` permits only
    `board-candidates` to be deferred or answered by the compact pre-flight. So a phantom that reached
    `assignedRows` did not merely display badly — it burned a session on an id the agent could not open,
    which is precisely what run `run-d5f354ac` did. The control case below is what keeps this suite from
    going vacuous: it asserts the UNWITHHELD population flips the gate, so a guard that stopped
    withholding would fail here rather than pass silently.
    */
    it("classifies a withheld-only delta as no signal against a cursor that never saw the id", async () => {
      const { store } = fakeStore({
        assigned: [task(LIVE_ID), task(PHANTOM_ABSENT_ID)],
        presence: [{ id: LIVE_ID, deletedAt: null }],
      });
      const board = await assignedRows(store);
      const cursor = createWakeCursor({ assignedRows: [`${LIVE_ID}:todo`] });
      const snapshot = createWakeSnapshot({
        assignedRows: board.assignedRows,
        steeringCommentIds: board.steeringCommentIds,
      });

      expect(classifyFresherWakeSignal(cursor, snapshot)).toBe("none");
      expect(hasFresherWakeSignal(cursor, snapshot)).toBe(false);
    });

    it("control: the same population WITHOUT withholding is a full-session assignment delta", () => {
      const cursor = createWakeCursor({ assignedRows: [`${LIVE_ID}:todo`] });
      const unguarded = createWakeSnapshot({
        assignedRows: [`${LIVE_ID}:todo`, `${PHANTOM_ABSENT_ID}:todo`],
      });

      expect(classifyFresherWakeSignal(cursor, unguarded)).toBe("board-assignment");
      expect(hasFresherWakeSignal(cursor, unguarded)).toBe(true);
      expect(isIdleLadderEligibleWakeSignal("board-assignment")).toBe(false);
    });

    it("keeps a real steering wake dispatching when every other assigned row is withheld", async () => {
      /*
      Withholding must not mute a legitimate signal. The live row's steering comment still classifies as
      `board-content` and still dispatches, while the withheld sibling's comment contributes nothing — the
      guard removes rows as a set and leaves the surviving rows' own signals intact.
      */
      const { store } = fakeStore({
        assigned: [
          task(LIVE_ID, { steeringComments: [{ id: "steer-live" } as never] }),
          task(PHANTOM_ABSENT_ID, { steeringComments: [{ id: "steer-phantom" } as never] }),
        ],
        presence: [{ id: LIVE_ID, deletedAt: null }],
      });
      const board = await assignedRows(store);
      const cursor = createWakeCursor({ assignedRows: [`${LIVE_ID}:todo`] });
      const snapshot = createWakeSnapshot({
        assignedRows: board.assignedRows,
        steeringCommentIds: board.steeringCommentIds,
      });

      expect(classifyFresherWakeSignal(cursor, snapshot)).toBe("board-content");
      expect(hasFresherWakeSignal(cursor, snapshot)).toBe(true);
    });
  });

  describe("one presence query per collection, never per row", () => {
    it("probes once for a three-row population and passes the whole id set", async () => {
      const { store, getTaskPresence } = fakeStore({
        assigned: [task(LIVE_ID), task(PHANTOM_ABSENT_ID), task(PHANTOM_TOMBSTONE_ID)],
        presence: ALL_PRESENT,
      });

      await assignedRows(store);

      expect(getTaskPresence).toHaveBeenCalledTimes(1);
      expect(getTaskPresence).toHaveBeenCalledWith([LIVE_ID, PHANTOM_ABSENT_ID, PHANTOM_TOMBSTONE_ID]);
    });

    it("probes once for the multi-signal collection as well", async () => {
      const { store, getTaskPresence } = fakeStore({
        assigned: [task(LIVE_ID), task(PHANTOM_ABSENT_ID), task(PHANTOM_TOMBSTONE_ID)],
        presence: ALL_PRESENT,
      });

      await collectWakeSignals({
        taskStore: store,
        agent: agent(),
        messageStore: createInboxMessageStore() as never,
      } as never);

      expect(getTaskPresence).toHaveBeenCalledTimes(1);
    });

    it("issues no probe at all for an empty population", async () => {
      const { store, getTaskPresence } = fakeStore({ assigned: [], presence: [] });

      await assignedRows(store);

      expect(getTaskPresence).not.toHaveBeenCalled();
    });
  });

  describe("the withholding is one durable ids-only audit record per row", () => {
    /** The closed metadata contract, asserted as set equality so a payload excerpt cannot be added quietly. */
    const METADATA_KEYS = ["agentId", "outcome", "source", "storeBound", "taskId", "withheldCount"];

    function withTwoWithheld() {
      return fakeStore({
        assigned: [task(LIVE_ID), task(PHANTOM_ABSENT_ID), task(PHANTOM_TOMBSTONE_ID)],
        presence: [
          { id: LIVE_ID, deletedAt: null },
          { id: PHANTOM_TOMBSTONE_ID, deletedAt: "2026-09-30T21:00:00.000Z" },
        ],
      });
    }

    it("emits one row per withheld id, under the declared mutation type", async () => {
      const { store, recordRunAuditEvent } = withTwoWithheld();

      await assignedRows(store);
      // The seam is fire-and-forget; await the microtask queue it settles on.
      await new Promise((resolve) => setImmediate(resolve));

      expect(recordRunAuditEvent).toHaveBeenCalledTimes(2);
      for (const call of recordRunAuditEvent.mock.calls) {
        expect(call[0]).toMatchObject({
          agentId: AGENT_ID,
          domain: "database",
          mutationType: "task:wake-delta-unresolvable-assignment",
        });
      }
    });

    it("distinguishes 'absent' from 'tombstone' and names the source lane", async () => {
      const { store, recordRunAuditEvent } = withTwoWithheld();

      await assignedRows(store);
      await new Promise((resolve) => setImmediate(resolve));

      const rows = recordRunAuditEvent.mock.calls.map((call) => call[0] as { target: string; metadata: Record<string, unknown> });
      expect(rows.find((r) => r.target === PHANTOM_ABSENT_ID)!.metadata).toMatchObject({
        outcome: "absent",
        source: "wake-delta",
      });
      expect(rows.find((r) => r.target === PHANTOM_TOMBSTONE_ID)!.metadata).toMatchObject({
        outcome: "tombstone",
        source: "wake-delta",
      });
    });

    it("carries EXACTLY the documented metadata keys — no title, no payload, no error prose", async () => {
      const { store, recordRunAuditEvent } = withTwoWithheld();

      await assignedRows(store);
      await new Promise((resolve) => setImmediate(resolve));

      expect(recordRunAuditEvent).toHaveBeenCalled();
      for (const call of recordRunAuditEvent.mock.calls) {
        const metadata = (call[0] as { metadata: Record<string, unknown> }).metadata;
        expect(Object.keys(metadata).sort()).toEqual(METADATA_KEYS);
      }
    });

    it("reports the count of rows withheld in this collection alongside each row", async () => {
      const { store, recordRunAuditEvent } = withTwoWithheld();

      await assignedRows(store);
      await new Promise((resolve) => setImmediate(resolve));

      for (const call of recordRunAuditEvent.mock.calls) {
        expect((call[0] as { metadata: { withheldCount: number } }).metadata.withheldCount).toBe(2);
      }
    });

    it("reports one episode once, not once per collection, while still withholding every time", async () => {
      /*
      FNXC:WakeDeltaPhantomIds 2026-11-05-23:20 (RUFU-455):
      `filterResolvableAssignedTasks` runs on every population collection — the wake gate, the ack writer's
      `collectBoardSignal`, the inventory read, and the idle pre-flight — so an unbounded emit wrote 2-3
      identical rows per heartbeat tick for one phantom, indistinguishable from 2-3 withhold episodes and
      unprunable by retention, which reaches run-audit rows only through a `tasks` row the withheld id does
      not have. The bound may suppress the REPORT and never the WITHHOLDING, which is why the repeat
      collections re-assert the population as well as the row count.
      */
      const { store, recordRunAuditEvent } = withTwoWithheld();

      const first = await assignedRows(store);
      const second = await assignedRows(store);
      await collectWakeSignals({
        taskStore: store,
        agent: agent(),
        messageStore: createInboxMessageStore() as never,
      } as never);
      await new Promise((resolve) => setImmediate(resolve));

      expect(recordRunAuditEvent).toHaveBeenCalledTimes(2);
      expect(second.assignedRows).toEqual(first.assignedRows);
      expect(second.assignedRows).not.toContain(`${PHANTOM_ABSENT_ID}:todo`);
    });

    it("gives a distinct outcome for the same id its own report", async () => {
      /*
      The bound keys on (agentId, taskId, outcome), not on the id alone: an id first sighted as a tombstone
      and later sighted as simply absent is a different measurement needing a different remedy, and
      collapsing the two would hide the transition behind the first report.
      */
      const tombstone = fakeStore({
        assigned: [task(PHANTOM_ABSENT_ID)],
        presence: [{ id: PHANTOM_ABSENT_ID, deletedAt: "2026-09-30T21:00:00.000Z" }],
      });
      await assignedRows(tombstone.store);
      await new Promise((resolve) => setImmediate(resolve));
      expect(tombstone.recordRunAuditEvent).toHaveBeenCalledTimes(1);

      const absentNow = fakeStore({ assigned: [task(PHANTOM_ABSENT_ID)], presence: [] });
      await assignedRows(absentNow.store);
      await new Promise((resolve) => setImmediate(resolve));
      expect(absentNow.recordRunAuditEvent).toHaveBeenCalledTimes(1);
      expect((absentNow.recordRunAuditEvent.mock.calls[0]![0] as { metadata: { outcome: string } }).metadata.outcome)
        .toBe("absent");
    });

    it("writes nothing when every row resolves", async () => {
      const { store, recordRunAuditEvent } = fakeStore({
        assigned: [task(LIVE_ID)],
        presence: [{ id: LIVE_ID, deletedAt: null }],
      });

      await assignedRows(store);
      await new Promise((resolve) => setImmediate(resolve));

      expect(recordRunAuditEvent).not.toHaveBeenCalled();
    });
  });

  describe("storeBound reports the guard's own blind spot", () => {
    it("is true on the per-project instance the heartbeat runs on", async () => {
      const { store, recordRunAuditEvent } = fakeStore({
        assigned: [task(PHANTOM_ABSENT_ID)],
        presence: [],
        projectId: BOUND_PROJECT,
      });

      await assignedRows(store);
      await new Promise((resolve) => setImmediate(resolve));

      expect((recordRunAuditEvent.mock.calls[0]![0] as { metadata: { storeBound: boolean } }).metadata.storeBound).toBe(true);
    });

    it("is false on a project-agnostic layer, which is where a cross-project phantom survives this guard", async () => {
      /*
      On an unbound layer `taskProjectScope` no-ops, so the list read and the presence read span every
      project on the shared cluster and agree with each other by construction. The row therefore cannot
      withhold a cross-project phantom; `storeBound: false` is what tells the operator the binding, not
      the read shape, is the cause. This case exists so that boolean is a measurement and not a guess.
      */
      const foreignRow = task(PHANTOM_ABSENT_ID);
      const { store, recordRunAuditEvent } = fakeStore({
        assigned: [foreignRow],
        // The unbound read resolves it: both reads see the foreign partition.
        presence: [{ id: PHANTOM_ABSENT_ID, deletedAt: null }],
        projectId: "",
      });

      const board = await assignedRows(store);
      await new Promise((resolve) => setImmediate(resolve));

      expect(board.assignedRows).toEqual([`${PHANTOM_ABSENT_ID}:todo`]);
      expect(recordRunAuditEvent).not.toHaveBeenCalled();

      // And the same store WITH a probe but no binding still reports the binding honestly when it does withhold.
      const withheld = fakeStore({ assigned: [task(PHANTOM_ABSENT_ID)], presence: [], projectId: "" });
      await assignedRows(withheld.store);
      await new Promise((resolve) => setImmediate(resolve));
      expect(
        (withheld.recordRunAuditEvent.mock.calls[0]![0] as { metadata: { storeBound: boolean } }).metadata.storeBound,
      ).toBe(false);
    });
  });

  describe("fail-open: a missing or broken probe never costs an agent its real work", () => {
    it("publishes the full population when the store has no presence probe", async () => {
      const { store, recordRunAuditEvent } = fakeStore({
        assigned: [task(LIVE_ID), task(PHANTOM_ABSENT_ID)],
        presence: [{ id: LIVE_ID, deletedAt: null }],
        probe: false,
      });

      const board = await assignedRows(store);
      await new Promise((resolve) => setImmediate(resolve));

      expect(board.assignedRows).toEqual([`${LIVE_ID}:todo`, `${PHANTOM_ABSENT_ID}:todo`]);
      expect(recordRunAuditEvent).not.toHaveBeenCalled();
    });

    it("publishes the full population when the probe rejects, and says so on the agent's lane log", async () => {
      const { store } = fakeStore({
        assigned: [task(LIVE_ID)],
        presence: [{ id: LIVE_ID, deletedAt: null }],
        probeThrows: true,
      });

      const board = await assignedRows(store);

      expect(board.assignedRows).toEqual([`${LIVE_ID}:todo`]);
      expect(vi.mocked(heartbeatLog.warn)).toHaveBeenCalledWith(expect.stringContaining("presence probe failed"));
    });
  });

  describe("a hostile audit sink cannot alter the withholding it reports", () => {
    /*
    FN-9175's requirement for a new emitter is behavioral, not structural: absent, throwing, rejecting,
    hanging, and late-settling sinks must all leave the owning branch identical. That matters doubly here
    because the emission is fire-and-forget (`void emitBoundedRunAudit(...)`) on a heartbeat cadence — if
    the seam's bound ever failed to contain a stalled sink, telemetry would gate whether an agent gets
    woken at all. Each case therefore asserts BOTH directions: the phantom stays withheld, the resolvable
    row still publishes, and the collection still resolves.
    */
    const population = () => [task(LIVE_ID), task(PHANTOM_ABSENT_ID)];
    const resolves = [{ id: LIVE_ID, deletedAt: null }];

    function storeWithSink(sink: unknown) {
      const base = fakeStore({ assigned: population(), presence: resolves });
      (base.store as unknown as { recordRunAuditEvent: unknown }).recordRunAuditEvent = sink;
      return base;
    }

    async function expectUnchangedUnder(sink: unknown) {
      const board = await assignedRows(storeWithSink(sink).store);
      expect(board.assignedRows).toEqual([`${LIVE_ID}:todo`]);
    }

    it("withholds identically when the sink is absent", async () => {
      await expectUnchangedUnder(undefined);
    });

    it("withholds identically when the sink throws synchronously", async () => {
      await expectUnchangedUnder(() => { throw new Error("sink exploded"); });
    });

    it("withholds identically when the sink rejects", async () => {
      await expectUnchangedUnder(async () => { throw new Error("sink rejected"); });
    });

    it("withholds identically when the sink never settles", async () => {
      await expectUnchangedUnder(() => new Promise(() => undefined));
    });

    it("withholds identically when the sink settles late, after the collection resolved", async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      await expectUnchangedUnder(async () => { await gate; });
      release();
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  describe("the guard leaves the shared read intact for its three non-publishing consumers", () => {
    it("does not mutate the array the store returned", async () => {
      /*
      `deleteAgent`'s reassignment guard, `resumeAgent`'s paused cascade, and the dashboard resume
      auto-unpause lane read the same core method and must keep their rows. The guard returns a new
      array; mutating its input would silently blind all three through aliasing.
      */
      const assigned = [task(LIVE_ID), task(PHANTOM_ABSENT_ID)];
      const { store } = fakeStore({ assigned, presence: [{ id: LIVE_ID, deletedAt: null }] });

      await filterResolvableAssignedTasks(store, AGENT_ID, assigned);

      expect(assigned.map((t) => t.id)).toEqual([LIVE_ID, PHANTOM_ABSENT_ID]);
    });

    it("returns the same rows for a population that all resolves", async () => {
      const assigned = [task(LIVE_ID), task(PHANTOM_TOMBSTONE_ID)];
      const { store } = fakeStore({ assigned, presence: ALL_PRESENT });

      const kept = await filterResolvableAssignedTasks(store, AGENT_ID, assigned);

      expect(kept).toHaveLength(2);
    });

    it("writes no task History line for a withheld id", async () => {
      /*
      `logEntry` needs a row to carry the entry, and the withheld id is precisely a row that does not
      exist. The operator-visible notices are the audit row plus the lane log; a fabricated card entry
      would be worse than none.
      */
      const { store } = fakeStore({ assigned: [task(PHANTOM_ABSENT_ID)], presence: [] });

      await assignedRows(store);
      await new Promise((resolve) => setImmediate(resolve));

      const logEntry = (store as unknown as { logEntry: { mock: { calls: unknown[][] } } }).logEntry;
      expect(logEntry.mock.calls).toHaveLength(0);
    });
  });
});
