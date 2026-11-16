import { afterEach, describe, expect, it } from "vitest";
import type { Task, TaskStore, WorkflowWorkItem } from "@fusion/core";

import { projectAdmissionCoordinator } from "../concurrency/concurrency.js";
import { registerPlanningLivenessProbe } from "../agents/planning-liveness.js";
import {
  CAPACITY_REFUSAL_DEFER_MS,
  WORKFLOW_CONTINUATION_POLL_MS,
  createPlanningContinuationDispatcher,
  drainDuePlanningContinuations,
} from "../runtimes/in-process-runtime.js";
import { CLAIM_REFUSAL_DEFER_MS } from "../runtimes/planning-continuation-accounting.js";

/*
FNXC:PlanningContinuationDispatch 2026-11-16-15:20 (RUFU-1069):
The operator boosted five cards, waited six minutes, and watched eight UNBOOSTED cards get claimed
while the five boosted ones stayed `state=runnable, retryAfter=NULL, lease_owner=NULL` across every
~45 s cycle — examined by the pass, never claimed, and with nothing written anywhere a human can
read. The due read is NOT the defect: `listDueWorkflowWorkItems` applies `taskQueueOrderBy()` before
its `LIMIT`, so a boosted row really is rank 1 inside the 20-wide planning window. The defect is
that `admitPlanningContinuation` answers "handled" for arms where it dispatched nothing and wrote
nothing, while `drainDuePlanningContinuations` records a deferral only for the `false` (shared
capacity) arm.

RED-BASELINE DISCIPLINE (RUFU-785 / FN-4298): these cases deliberately do NOT assert "the boosted
card is claimed before older cards" — `taskQueueOrderBy()` already guarantees that on HEAD, so such
a test would be green before the change and is an invalid gate. The red shape asserted here is the
EXAMINED-WITHOUT-A-WRITE class: a row the pass looked at that leaves the pass due and silent. The
boost-first assertions live in `planning-dispatch-queue-order-ratchet.test.ts` and are labelled
there as keep-this-true ratchets.

Each arm is driven through the REAL `createPlanningContinuationDispatcher` over a fake store, so the
test proves the production seam rather than a re-implementation of it.
*/

const PROJECT = "/test/planning-continuation-admission-honesty";
const PASS_1 = Date.parse("2026-11-16T12:35:00.000Z");
const STALE = new Date(PASS_1 - 18 * 24 * 3600_000).toISOString();

/** No refusal may bound a row further out than the shared-capacity rotation horizon. */
const MAX_REFUSAL_BOUND_MS = CAPACITY_REFUSAL_DEFER_MS;

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    title: `Boosted card ${id}`,
    description: "Boosted to rank 1 of the planning due window and never dispatched",
    column: "todo",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: STALE,
    updatedAt: STALE,
    ...patch,
  } as Task;
}

function continuation(taskId: string, id: string, createdAt: string): WorkflowWorkItem {
  return {
    id,
    runId: `run-${id}`,
    taskId,
    nodeId: "plan-review",
    nodeInstanceId: "plan-review",
    kind: "task",
    state: "runnable",
    attempt: 0,
    retryAfter: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    blockedReason: null,
    waitReason: "planning",
    createdAt,
    updatedAt: STALE,
  } as WorkflowWorkItem;
}

/** Which row the fake store refuses to claim, so one arm exercises exactly one branch. */
type ClaimRefusal = (itemId: string) => "accept" | "unchanged" | "no-row";

interface HarnessInput {
  items: WorkflowWorkItem[];
  tasks: Task[];
  /** Defaults to accepting every claim. */
  refuseClaim?: ClaimRefusal;
  /** Task whose planning-lifecycle lock acquisition throws (the RUFU-708/RUFU-550 candidate). */
  lockThrowsForTask?: string;
  maxConcurrent?: number;
  /**
   * The queue order the store's due read would return, as item ids best-first. The fake never
   * re-implements `taskQueueOrderBy()` - a test that needs a boosted head declares the rank it is
   * asserting, and the comparator itself is pinned at the store seam by
   * `workflow-stranded-deferral-horizon.pg.test.ts` plus the queue-order ratchet.
   */
  queueOrder?: string[];
  /** The `limit` the live due read passes, applied AFTER ordering, so a test can hold a backlog wider
   *  than the planning window. */
  windowLimit?: number;
}

interface Harness {
  rows: Map<string, WorkflowWorkItem>;
  stamps: Array<{ itemId: string; expectedState: string; retryAfter: string }>;
  store: TaskStore;
  nowMs(): number;
  setNow(value: number): void;
  listDue(): Promise<WorkflowWorkItem[]>;
  run(input: {
    execute?: (task: Task) => Promise<void>;
    isPlannerLive?: (taskId: string) => boolean;
  }): Promise<{ executed: string[] }>;
}

/**
 * A fake store plus the drain's dependency wiring, mirroring the runtime's adapters:
 * `defer` is the same CAS transition the runtime performs, and `listDue` applies the
 * same due predicate (`retryAfter <= now`, lease expired) the store applies.
 */
function makeHarness(input: HarnessInput): Harness {
  const rows = new Map(input.items.map((item) => [item.id, { ...item }]));
  const tasks = new Map(input.tasks.map((row) => [row.id, row]));
  const stamps: Harness["stamps"] = [];
  let nowMs = PASS_1;
  const refuse = input.refuseClaim ?? (() => "accept" as const);

  const transition: TaskStore["transitionWorkflowWorkItem"] = async (id, state, patch = {}) => {
    const row = rows.get(id);
    if (!row) throw new Error(`unknown work item ${id}`);
    // The refusal hook is scoped to the `running` CLAIM, not to every write on the row: refusing a
    // same-state deferral too would make the fake reject the very bookkeeping under test, and the
    // arm would fail for a reason that does not exist in production.
    const isClaim = state === "running";
    /*
    FNXC:PlanningContinuationDispatch 2026-11-16-20:52 (RUFU-1069):
    The refusal hook is consulted ONCE per claim. A caller that counts attempts (the criterion-4 case
    below refuses the head for its first N claims) must count claims, and consulting the hook twice for
    one CAS would count one refusal twice and silently halve the horizon under test.
    */
    const refusal = isClaim ? refuse(id) : "accept";
    if (patch.expectedState && row.state !== patch.expectedState) return { ...row };
    if (patch.expectedLeaseOwner !== undefined && row.leaseOwner !== patch.expectedLeaseOwner) {
      return { ...row };
    }
    if (isClaim && refusal === "no-row") {
      // A store that answers with no row: `transitionWorkflowWorkItem` is typed
      // non-null, so this is the duck-typed-partial-store shape the code must survive.
      return undefined as unknown as WorkflowWorkItem;
    }
    const next: WorkflowWorkItem = {
      ...row,
      state,
      ...(patch.leaseOwner !== undefined ? { leaseOwner: patch.leaseOwner } : {}),
      ...(patch.leaseExpiresAt !== undefined ? { leaseExpiresAt: patch.leaseExpiresAt } : {}),
      ...(patch.retryAfter !== undefined ? { retryAfter: patch.retryAfter } : {}),
      ...(patch.blockedReason !== undefined ? { blockedReason: patch.blockedReason } : {}),
      ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
    };
    if (isClaim && refusal === "unchanged") return { ...row };
    rows.set(id, next);
    return { ...next };
  };

  const store = {
    getSettings: async () => ({
      maxConcurrent: input.maxConcurrent ?? 12,
      maxWorktrees: 9,
      worktreeLimitEnabled: true,
    }),
    listTasks: async () => input.tasks,
    getTask: async (taskId: string) => tasks.get(taskId),
    getWorkflowWorkItem: async (itemId: string) => {
      const row = rows.get(itemId);
      return row ? { ...row } : null;
    },
    getTaskWorkflowSelection: () => undefined,
    getTaskWorkflowSelectionAsync: async () => undefined,
    getWorkflowDefinition: async () => undefined,
    logEntry: async () => undefined,
    logEntryOnce: async () => true,
    transitionWorkflowWorkItem: transition,
    ...(input.lockThrowsForTask
      ? {
        withPlanningLifecycleLock: async <T>(taskId: string, fn: () => Promise<T>): Promise<T> => {
          if (taskId === input.lockThrowsForTask) {
            throw new Error("pg_advisory_lock grant timed out");
          }
          return await fn();
        },
      }
      : {}),
  } as unknown as TaskStore;

  const harness: Harness = {
    rows,
    stamps,
    store,
    nowMs: () => nowMs,
    setNow(value) {
      nowMs = value;
    },
    // Mirrors `listDueWorkflowWorkItems`: due means a past `retryAfter` and an expired lease, ordered
    // by the declared queue rank (or by `createdAt` when the test declares no order), then truncated to
    // the window the live read would have taken.
    listDue: async () => {
      const due = [...rows.values()].filter((row) => (row.state === "runnable" || row.state === "retrying")
        && (row.retryAfter === null || Date.parse(row.retryAfter) <= nowMs)
        && (row.leaseExpiresAt === null || Date.parse(row.leaseExpiresAt) <= nowMs));
      if (input.queueOrder) {
        const rank = new Map(input.queueOrder.map((id, index) => [id, index]));
        due.sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER)
          - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
      } else {
        due.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      }
      const window = input.windowLimit === undefined ? due : due.slice(0, input.windowLimit);
      return window.map((row) => ({ ...row }));
    },
    run: async ({ execute, isPlannerLive }) => {
      // A row that reached `execute` was dispatched. The row state cannot carry that
      // proof: settlement returns a finished run to `runnable` with a cleared lease,
      // so a synchronously-settling `execute` leaves the row exactly as it was found.
      const executed: string[] = [];
      const dispatch = createPlanningContinuationDispatcher({
        store,
        projectId: PROJECT,
        execute: (row) => {
          executed.push(row.id);
          return (execute ?? (async () => {}))(row);
        },
        isPlannerLive,
      });
      await drainDuePlanningContinuations({
        listDue: harness.listDue,
        getTask: async (taskId) => tasks.get(taskId),
        resolveTerminalColumns: async () => new Set(["done"]),
        isPlannerLive,
        cancelOrphan: async () => undefined,
        defer: async ({ itemId, expectedState, retryAfter }) => {
          const row = rows.get(itemId);
          if (!row || row.state !== expectedState) return;
          await transition(itemId, expectedState, { expectedState, retryAfter });
          stamps.push({ itemId, expectedState, retryAfter });
        },
        dispatch,
        nowMs: harness.nowMs,
        warn: () => undefined,
      });
      return { executed };
    },
  };
  return harness;
}

/** A row the pass looked at and did not dispatch owes a bound, and nothing else. */
function expectBounded(harness: Harness, itemId: string, reason: string): void {
  const row = harness.rows.get(itemId)!;
  expect(row.retryAfter, reason).not.toBeNull();
  const bound = Date.parse(row.retryAfter!);
  expect(bound, `${reason}: a deferral must be in the future`).toBeGreaterThan(PASS_1);
  expect(
    bound - PASS_1,
    `${reason}: the bound may not exceed the rotation horizon it is sized against`,
  ).toBeLessThanOrEqual(MAX_REFUSAL_BOUND_MS);
}

const reservations: string[] = [];
let unregisterProbe: (() => void) | undefined;

afterEach(async () => {
  await Promise.resolve();
  while (reservations.length > 0) {
    projectAdmissionCoordinator.releaseReservation(reservations.pop()!);
  }
  unregisterProbe?.();
  unregisterProbe = undefined;
});

describe("a due planning continuation the pass examines is never left silent", () => {
  it("arm (a) bounds the second due row of a task whose in-memory run was never released", async () => {
    // A task owns one top-level slot, so a second due row for the same task hits
    // `planningContinuationRuns.has(runKey)`. A DUE row is by definition unleased, so
    // a held run key behind it means the in-memory set leaked — not the healthy
    // in-flight case. At HEAD that arm returns "handled" and writes nothing.
    const taskId = "RUFU-1044";
    reservations.push(taskId);
    const head = continuation(taskId, "wi-head", STALE);
    const duplicate = continuation(taskId, "wi-duplicate", new Date(PASS_1 - 60 * 3600_000).toISOString());
    const harness = makeHarness({ items: [head, duplicate], tasks: [task(taskId)] });

    let releaseRun!: () => void;
    const neverSettles = new Promise<void>((resolve) => { releaseRun = resolve; });
    try {
      const { executed } = await harness.run({ execute: () => neverSettles });

      expect(executed, "the head was dispatched").toEqual([taskId]);
      expectBounded(harness, duplicate.id, "the examined duplicate carries a bound");
      expect(harness.stamps.map((stamp) => stamp.itemId), "and exactly that row was stamped")
        .toContain(duplicate.id);
    } finally {
      releaseRun();
      await Promise.resolve();
      await Promise.resolve();
    }
  });

  it("arm (b) bounds a same-slot hand-off whose claim was refused", async () => {
    // The already-active fast path calls `dispatchPlanningContinuationIfCurrent` and
    // DISCARDS its result, then answers "handled" for every reason it can return false
    // for. Refusing only the head's claim makes that discard reachable.
    const taskId = "RUFU-1050";
    const behindId = "RUFU-1053";
    reservations.push(taskId, behindId);
    unregisterProbe = registerPlanningLivenessProbe((candidate) => candidate === taskId);
    const head = continuation(taskId, "wi-slot", STALE);
    const behind = continuation(behindId, "wi-behind", new Date(PASS_1 - 3600_000).toISOString());
    const harness = makeHarness({
      items: [head, behind],
      // `status: "planning"` plus the liveness probe is the proven already-active shape.
      tasks: [task(taskId, { status: "planning" }), task(behindId)],
      refuseClaim: (itemId) => (itemId === head.id ? "unchanged" : "accept"),
    });

    const { executed } = await harness.run({ execute: async () => {} });

    expectBounded(harness, head.id, "the refused same-slot hand-off carries a bound");
    expect(executed, "the younger row was still dispatched").toContain(behindId);
    expect(executed, "while the refused row itself never ran").not.toContain(taskId);
  });

  it("arm (c1) bounds a row whose running-claim CAS lost inside the coordinator", async () => {
    // `start()` records a refusal and `admitPlanningContinuation` folds it into
    // `plannerOrContinuationSuperseded`, which answers "handled" with no write of its own.
    const taskId = "RUFU-1054";
    const behindId = "RUFU-1058";
    reservations.push(taskId, behindId);
    const head = continuation(taskId, "wi-cas", STALE);
    const behind = continuation(behindId, "wi-behind", new Date(PASS_1 - 3600_000).toISOString());
    const harness = makeHarness({
      items: [head, behind],
      tasks: [task(taskId), task(behindId)],
      refuseClaim: (itemId) => (itemId === head.id ? "unchanged" : "accept"),
    });

    const { executed } = await harness.run({ execute: async () => {} });

    expectBounded(harness, head.id, "the lost CAS carries a bound");
    expect(executed, "and the coordinator still reached the next row").toContain(behindId);
  });

  it("arm (c2) bounds a row whose claim transition answered with no row at all", async () => {
    // The transition is typed non-null but is reached through a duck-typed partial
    // store. At HEAD the null answer throws out of the whole pass, so the head is
    // unbounded AND the younger row is never examined.
    const taskId = "RUFU-726";
    const behindId = "RUFU-731";
    reservations.push(taskId, behindId);
    const head = continuation(taskId, "wi-norow", STALE);
    const behind = continuation(behindId, "wi-behind", new Date(PASS_1 - 3600_000).toISOString());
    const harness = makeHarness({
      items: [head, behind],
      tasks: [task(taskId), task(behindId)],
      refuseClaim: (itemId) => (itemId === head.id ? "no-row" : "accept"),
    });

    const { executed } = await harness.run({ execute: async () => {} });

    expectBounded(harness, head.id, "the no-row claim carries a bound");
    expect(executed, "and a broken head cannot strand the rest").toContain(behindId);
  });

  it("arm (d) bounds a row whose dispatch threw, without ending the pass", async () => {
    // The planning-lifecycle advisory-lock timeout is the known production candidate
    // (RUFU-708/RUFU-550). At HEAD the drain awaits `deps.dispatch` with no per-item
    // catch, so one throw aborts the pass and every row behind it stays silent.
    const taskId = "RUFU-732";
    const behindId = "RUFU-734";
    reservations.push(taskId, behindId);
    const head = continuation(taskId, "wi-throw", STALE);
    const behind = continuation(behindId, "wi-behind", new Date(PASS_1 - 3600_000).toISOString());
    const harness = makeHarness({
      items: [head, behind],
      tasks: [task(taskId), task(behindId)],
      lockThrowsForTask: taskId,
    });

    // The pass resolving at all is the assertion: a pass must never end early because
    // one row failed.
    const { executed } = await harness.run({ execute: async () => {} });

    expectBounded(harness, head.id, "the throwing row carries a bound");
    expect(executed, "and the rest of the window is still dispatched").toContain(behindId);
  });

  it("a throwing task lookup still cancels the orphan and continues (keep-this-true ratchet)", async () => {
    // FN-8470/FN-8471 already moved getTask failures to a cancel. This is NOT red on
    // HEAD: it is pinned here so the new per-item guard cannot quietly turn a proven
    // orphan cancel into a silent refusal.
    const deadId = "RUFU-735";
    const liveId = "RUFU-736";
    reservations.push(liveId);
    const dead = continuation(deadId, "wi-orphan", STALE);
    const live = continuation(liveId, "wi-live", new Date(PASS_1 - 3600_000).toISOString());
    const cancelled: string[] = [];
    const executed: string[] = [];
    const harness = makeHarness({ items: [dead, live], tasks: [task(liveId)] });
    const dispatch = createPlanningContinuationDispatcher({
      store: harness.store,
      projectId: PROJECT,
      execute: async (row) => {
        executed.push(row.id);
      },
    });

    await drainDuePlanningContinuations({
      listDue: harness.listDue,
      getTask: async (taskId) => {
        if (taskId === deadId) throw new Error("archive snapshot missing");
        return task(taskId);
      },
      cancelOrphan: async (item) => { cancelled.push(item.id); },
      defer: async () => undefined,
      dispatch,
      nowMs: harness.nowMs,
      warn: () => undefined,
    });

    expect(cancelled).toEqual([dead.id]);
    expect(executed).toEqual([liveId]);
    /*
    The assertion that makes this a ratchet rather than a shrug. `execute` returns a promise the
    dispatcher awaits, and the pass now converts ANY throw in that chain into a bounded `errored`
    row, so `executed` alone would still be green while the live row was refused-and-stamped. A
    dispatched row owes no deferral, which is the contract the rest of this file asserts in reverse.
    */
    expect(harness.stamps, "the live row was dispatched, not bounded as a refusal").toEqual([]);
  });

  it("criterion 4: a boosted card reaches the planner inside two minutes past a 219-row backlog", async () => {
    /*
    FNXC:PlanningContinuationDispatch 2026-11-16-20:52 (RUFU-1069):
    Acceptance criterion 4 - "a card created today with an armed plan-review work item is dispatched
    within two minutes even with 200+ older due rows" - carried on stepped virtual time instead of a
    live board. Two claims, kept apart on purpose:

    * The RANK that puts the boosted card at the head of the 20-wide window is a premise here, not this
      case's gate: `taskQueueOrderBy()` already ordered it that way before this card, and the comparator
      is pinned at the store seam by `workflow-stranded-deferral-horizon.pg.test.ts`. The fake is HANDED
      that order (`queueOrder`) rather than re-deriving a second comparator.
    * What is red on the pre-fix shape is the mechanism, asserted twice: every examined row left a
      dispatch or a durable bound (pre-fix the head was examined every poll and wrote nothing), and the
      dispatch came `HEAD_REFUSALS` refusal horizons later, not one horizon per poll. A head that is
      never bounded is re-examined every `WORKFLOW_CONTINUATION_POLL_MS` forever, which is how the
      operator's own ~11-day rotation estimate at 219 due rows became the real answer.
    */
    const boostedId = "RUFU-1053";
    const BACKLOG_ROWS = 219;
    const WINDOW = 20;
    const HEAD_REFUSALS = 5;
    const OPERATOR_BUDGET_MS = 120_000;

    const boosted = continuation(boostedId, "wi-boosted", new Date(PASS_1 - 60_000).toISOString());
    const backlog = Array.from({ length: BACKLOG_ROWS }, (_, index) => continuation(
      `RUFU-backlog-${index}`,
      `wi-old-${index}`,
      // 18 days old, like the saneca backlog, and each row a second older than the one before it.
      new Date(PASS_1 - (18 * 24 * 3600_000) - index * 1_000).toISOString(),
    ));
    const items = [boosted, ...backlog];
    const tasks = items.map((item) => task(String(item.taskId)));
    reservations.push(...tasks.map((row) => row.id));
    const itemByTask = new Map(items.map((item) => [String(item.taskId), item]));

    let headClaims = 0;
    const harness = makeHarness({
      items,
      tasks,
      // The queue order the store read would return: the boost first, then the FIFO backlog.
      queueOrder: items.map((item) => item.id),
      windowLimit: WINDOW,
      // The project cap is not the limit under probe; the window must be admitted whole.
      maxConcurrent: 64,
      refuseClaim: (itemId) => {
        if (itemId !== boosted.id) return "accept";
        headClaims += 1;
        return headClaims <= HEAD_REFUSALS ? "unchanged" : "accept";
      },
    });

    const executed: string[] = [];
    let boostedDispatchedAt: number | null = null;
    let passes = 0;
    // The live cadence, bounded well past the operator's budget so a regression reports "never" rather
    // than hanging the suite.
    for (let elapsed = 0; elapsed <= 4 * OPERATOR_BUDGET_MS && boostedDispatchedAt === null; elapsed += WORKFLOW_CONTINUATION_POLL_MS) {
      passes += 1;
      harness.setNow(PASS_1 + elapsed);
      const examined = await harness.listDue();
      const stampsBefore = harness.stamps.length;
      const { executed: executedThisPass } = await harness.run({
        execute: async (row) => {
          executed.push(row.id);
          if (row.id === boostedId) boostedDispatchedAt = harness.nowMs();
          // A dispatched row is no longer this pass's work: its plan-review item leaves the due set for
          // its verdict, which is what lets a backlog rotate at all. `settlePlanningContinuationDispatch`
          // is CAS-guarded on `expectedState: "running"`, so holding the row here is not re-armed.
          const item = itemByTask.get(row.id);
          const current = item ? harness.rows.get(item.id) : undefined;
          if (current) harness.rows.set(item.id, { ...current, state: "held" });
        },
      });
      const stamped = harness.stamps.slice(stampsBefore);
      for (const row of examined) {
        expect(
          executedThisPass.includes(String(row.taskId)) || stamped.some((stamp) => stamp.itemId === row.id),
          `pass ${passes} examined ${row.id} (task ${row.taskId}) and left it due, unleased, and unrecorded`,
        ).toBe(true);
      }
    }

    const dispatchedAt = boostedDispatchedAt;
    expect(dispatchedAt, `the boosted card never reached the planner in ${passes} passes`).not.toBeNull();
    const waitedMs = (dispatchedAt as number) - PASS_1;
    expect(waitedMs, "the operator's two-minute budget").toBeLessThanOrEqual(OPERATOR_BUDGET_MS);
    // The mechanism, not the coincidence: five refusals must have cost five refusal horizons.
    expect(waitedMs, "every refusal armed its own bound instead of leaving the row due and silent")
      .toBeGreaterThanOrEqual(HEAD_REFUSALS * CLAIM_REFUSAL_DEFER_MS);
    expect(waitedMs, "and the wait is a refusal horizon, not a capacity rotation")
      .toBeLessThan(HEAD_REFUSALS * CAPACITY_REFUSAL_DEFER_MS);
    expect(executed.filter((id) => id !== boostedId), "the boost must not starve the older backlog")
      .toHaveLength(BACKLOG_ROWS);
  });
});
