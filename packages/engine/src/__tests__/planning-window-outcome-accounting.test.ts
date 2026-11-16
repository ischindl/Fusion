import { describe, expect, it, vi } from "vitest";

import {
  CAPACITY_REFUSAL_DEFER_MS,
  PLANNER_LIVE_CONTINUATION_DEFER_MS,
  PARKED_CONTINUATION_DEFER_MS,
  WORKFLOW_CONTINUATION_POLL_MS,
  drainDuePlanningContinuations,
} from "../runtimes/in-process-runtime.js";
import {
  CLAIM_REFUSAL_DEFER_MS,
  PLANNING_CONTINUATION_ADMISSIONS,
  PLANNING_WINDOW_EXAMINED_ID_CAP,
  WINDOW_OUTCOME_REFRESH_FLOOR_MS,
  createPlanningContinuationAccounting,
  planningAdmissionDeferralMs,
  planningAdmissionLatchesWindow,
  type PlanningWindowOutcome,
} from "../runtimes/planning-continuation-accounting.js";

/*
FNXC:PlanningContinuationDispatch 2026-11-16-16:50 (RUFU-1069):
The accounting module is the single place that decides what a non-dispatched examination OWES: a bound
on the row, a counter, and a record a human can read. This file guards all three, and it is where the
claim "no arm can leave a row due and silent" is actually checked - by enumerating
`PLANNING_CONTINUATION_ADMISSIONS` rather than by listing arms by hand, so a newly added arm that
forgets a bound fails here instead of on an operator's board.

The horizons arrive as the explicit `horizons` argument (this module owns none of them), which is why
this test is the place their RELATIVE correctness is pinned: `in-process-runtime.ts` keeps the
constants and the FNXC text that relates them to `WORKFLOW_CONTINUATION_POLL_MS`, and importing both
sides here is what stops the table and the horizons drifting apart silently.
*/

const HORIZONS = {
  capacityMs: CAPACITY_REFUSAL_DEFER_MS,
  plannerLiveMs: PLANNER_LIVE_CONTINUATION_DEFER_MS,
  parkedMs: PARKED_CONTINUATION_DEFER_MS,
};

describe("planning admission rule table", () => {
  it("names a bound for every arm that is not already armed elsewhere", () => {
    // `dispatched` writes its own next state through settlement, and the skip arms are armed by
    // `resolveParkedContinuationDeferral` before the drain ever asks. Every other arm must answer.
    // `dispatched` writes its own next state through settlement; the two wait arms are armed by
    // `resolveParkedContinuationDeferral` before the drain ever asks; and `skipped-orphan` leaves the
    // due set by cancellation, so arming it would fight the cancel. Every other arm must answer.
    const unarmed = new Set(["dispatched", "skipped-paused", "skipped-approval-required", "skipped-orphan"]);
    for (const arm of PLANNING_CONTINUATION_ADMISSIONS) {
      const bound = planningAdmissionDeferralMs(arm, HORIZONS);
      if (unarmed.has(arm)) {
        expect(bound, `${arm} must not be armed twice in one pass`).toBeNull();
      } else {
        expect(bound, `${arm} must bound its own row`).toBeTypeOf("number");
        expect(bound, `${arm} must bound it into the future`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps every bound ahead of the poll that would otherwise re-examine the row", () => {
    // The whole point of a bound is that the next 2 s pass does NOT re-read this row. A bound at or
    // below the poll interval is not a bound, it is the original starvation shape.
    for (const arm of PLANNING_CONTINUATION_ADMISSIONS) {
      const bound = planningAdmissionDeferralMs(arm, HORIZONS);
      if (bound !== null) {
        expect(bound, `${arm} must outlast one poll`).toBeGreaterThan(WORKFLOW_CONTINUATION_POLL_MS);
      }
    }
  });

  it("sizes the refusal horizons against the existing ones rather than inventing a third scale", () => {
    // A shared-capacity refusal is true for the whole window, so it must outlast a rotation. A
    // per-row refusal is transient, so it must be shorter than the capacity wait and no longer than
    // the other transient wait. `skipped-orphan` answers 0 (never armed) rather than null because
    // the drain cancels that row out of the due set entirely.
    expect(CLAIM_REFUSAL_DEFER_MS).toBe(PLANNER_LIVE_CONTINUATION_DEFER_MS);
    expect(CLAIM_REFUSAL_DEFER_MS).toBeLessThan(CAPACITY_REFUSAL_DEFER_MS);
    expect(CAPACITY_REFUSAL_DEFER_MS).toBeLessThan(PARKED_CONTINUATION_DEFER_MS);
    expect(planningAdmissionDeferralMs("skipped-orphan", HORIZONS)).toBeNull();
  });

  it("latches the window only for the one arm that is a property of the window", () => {
    for (const arm of PLANNING_CONTINUATION_ADMISSIONS) {
      expect(planningAdmissionLatchesWindow(arm), `${arm}`).toBe(arm === "deferred-capacity");
    }
  });
});

function row(id: string, taskId: string) {
  return {
    id,
    taskId,
    state: "runnable" as const,
    retryAfter: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    createdAt: "2026-11-10T00:00:00.000Z",
  };
}

interface WindowHarness {
  rows: ReturnType<typeof row>[];
  emits: PlanningWindowOutcome[];
  histories: Array<{ taskId: string; action: string; dedupeKey: string }>;
  run(outcomeForItem: (itemId: string) => string): Promise<void>;
}

/** A drain driving `drainDuePlanningContinuations` over a hand-built accounting instance. */
function makeWindowHarness(itemCount: number, sink: {
  emitAudit?: (event: { metadata: PlanningWindowOutcome }) => unknown;
  logEntryOnce?: (taskId: string, input: { action: string }) => Promise<unknown>;
  nowMs?: () => number;
}): WindowHarness {
  const rows = Array.from({ length: itemCount }, (_, index) => row(`wi-${index}`, `FN-${index}`));
  const emits: PlanningWindowOutcome[] = [];
  const histories: WindowHarness["histories"] = [];
  const accounting = createPlanningContinuationAccounting({
    nowMs: sink.nowMs ?? (() => PASS),
    emitAudit: sink.emitAudit ?? ((event) => {
      emits.push(event.metadata);
      return Promise.resolve();
    }),
    logEntryOnce: sink.logEntryOnce ?? ((taskId, input) => {
      histories.push({ taskId, action: input.action, dedupeKey: input.dedupeKey });
      return Promise.resolve();
    }),
  });
  return {
    rows,
    emits,
    histories,
    run: async (outcomeForItem) => {
      await drainDuePlanningContinuations({
        listDue: async () => rows.map((r) => ({ ...r })) as never,
        getTask: async (taskId) => ({ id: taskId, column: "todo", status: null }) as never,
        cancelOrphan: async () => undefined,
        defer: async () => undefined,
        isPlannerLive: () => false,
        accounting,
        windowLimit: itemCount,
        dispatch: ((_task: never, item: { id: string }) => outcomeForItem(item.id)) as never,
        nowMs: sink.nowMs ?? (() => PASS),
        warn: () => undefined,
      });
    },
  };
}

const PASS = Date.parse("2026-11-16T12:35:00.000Z");

describe("a stalled planning window is recorded", () => {
  it("emits nothing when the window dispatched at least one row", async () => {
    const h = makeWindowHarness(3, {});
    await h.run((id) => (id === "wi-1" ? "dispatched" : "refused-claim"));
    expect(h.emits).toEqual([]);
  });

  it("emits once with every refusal counted when nothing dispatched", async () => {
    const h = makeWindowHarness(4, {});
    const outcomes: Record<string, string> = {
      "wi-0": "refused-claim",
      "wi-1": "refused-superseded",
      "wi-2": "deferred-planner-live",
      "wi-3": "errored",
    };
    await h.run((id) => outcomes[id]!);

    expect(h.emits).toHaveLength(1);
    const account = h.emits[0]!;
    expect(account).toMatchObject({
      limit: 4,
      examinedCount: 4,
      dispatchedCount: 0,
      claimRefusedCount: 1,
      supersededCount: 1,
      plannerLiveDeferredCount: 1,
      throwCount: 1,
      windowHeadItemId: "wi-0",
      windowHeadTaskId: "FN-0",
      dueSetTruncated: true,
    });
    expect(account.examinedTaskIds).toEqual(["FN-0", "FN-1", "FN-2", "FN-3"]);
  });

  it("keeps the metadata to its declared key set", async () => {
    // The audit row is an operator-facing contract; a silently added key is an undocumented one.
    const h = makeWindowHarness(1, {});
    await h.run(() => "refused-claim");
    expect(Object.keys(h.emits[0]!).sort()).toEqual([
      "approvalSkipCount",
      "capacityDeferredCount",
      "claimRefusedCount",
      "dispatchedCount",
      "dueSetTruncated",
      "examinedCount",
      "examinedTaskIds",
      "inFlightLeakCount",
      "limit",
      "orphanCount",
      "pausedSkipCount",
      "plannerLiveDeferredCount",
      "supersededCount",
      "throwCount",
      "windowHeadItemId",
      "windowHeadTaskId",
    ].sort());
  });

  it("caps the examined ids it names without capping the count it reports", async () => {
    const h = makeWindowHarness(PLANNING_WINDOW_EXAMINED_ID_CAP + 5, {});
    await h.run(() => "refused-claim");
    expect(h.emits[0]!.examinedTaskIds).toHaveLength(PLANNING_WINDOW_EXAMINED_ID_CAP);
    expect(h.emits[0]!.examinedCount).toBe(PLANNING_WINDOW_EXAMINED_ID_CAP + 5);
  });

  it("names the reason on the card, and names it once per reason", async () => {
    const h = makeWindowHarness(2, {});
    await h.run((id) => (id === "wi-0" ? "refused-claim" : "skipped-paused"));
    expect(h.histories.map((entry) => entry.dedupeKey)).toEqual([
      "planning-window-outcome:refused-claim",
      "planning-window-outcome:skipped-paused",
    ]);
    expect(h.histories.every((entry) => entry.action.length > 0)).toBe(true);
  });

  it("writes no History line for a row it dispatched", async () => {
    const h = makeWindowHarness(1, {});
    await h.run(() => "dispatched");
    expect(h.histories).toEqual([]);
  });
});

describe("the stalled-window record is bounded", () => {
  it("re-emits at most once per refresh floor for the same window head", async () => {
    let now = PASS;
    const h = makeWindowHarness(2, { nowMs: () => now });
    await h.run(() => "refused-claim");
    // The pass runs every 2 s. Without a floor this is ~43 200 rows/day for one wedged window.
    for (let pass = 0; pass < 8; pass += 1) {
      now += WORKFLOW_CONTINUATION_POLL_MS;
      await h.run(() => "refused-claim");
    }
    expect(h.emits).toHaveLength(1);

    now += WINDOW_OUTCOME_REFRESH_FLOOR_MS;
    await h.run(() => "refused-claim");
    expect(h.emits, "the floor must expire rather than mute the class forever").toHaveLength(2);
  });

  it("bounds the stalled-window class once per floor even when the window head rotates", async () => {
    /*
    FNXC:PlanningContinuationDispatch 2026-11-16-20:52 (RUFU-1069 code review P0):
    A head-keyed floor is not a bound. The drain arms EVERY examined non-dispatch row, so the armed head
    is out of the due set on the next pass and `items[0]` is a different card - measured at the shape
    this card was filed for (219 due rows, whole window refusing) that is roughly one emit per 20 rows
    examined, ~880 rows/hour, which is RUFU-442's "a bound whose key changes each cycle" restated. The
    rotation is applied here by hand so the case does not also depend on the arm; the live 2 s cadence
    is stepped so the pass count matches a real stall rather than a single instant.
    */
    const rows = [row("wi-a", "FN-A"), row("wi-b", "FN-B"), row("wi-c", "FN-C")];
    const emits: PlanningWindowOutcome[] = [];
    let now = PASS;
    const accounting = createPlanningContinuationAccounting({
      nowMs: () => now,
      emitAudit: (event) => {
        emits.push(event.metadata);
        return Promise.resolve();
      },
      logEntryOnce: async () => undefined,
    });
    const pass = async (items: typeof rows) => {
      await drainDuePlanningContinuations({
        listDue: async () => items.map((r) => ({ ...r })) as never,
        getTask: async (taskId) => ({ id: taskId, column: "todo", status: null }) as never,
        cancelOrphan: async () => undefined,
        defer: async () => undefined,
        isPlannerLive: () => false,
        accounting,
        windowLimit: 20,
        dispatch: (() => "refused-claim") as never,
        nowMs: () => now,
        warn: () => undefined,
      });
    };
    for (let passIndex = 0; passIndex < 12; passIndex += 1) {
      const offset = passIndex % rows.length;
      await pass([...rows.slice(offset), ...rows.slice(0, offset)]);
      now += WORKFLOW_CONTINUATION_POLL_MS;
    }
    expect(emits, "a rotating head must not unlock a second row per rotation").toHaveLength(1);

    now += WINDOW_OUTCOME_REFRESH_FLOOR_MS;
    await pass(rows);
    expect(emits, "the class still re-announces when the floor expires").toHaveLength(2);
    expect(emits.map((e) => e.windowHeadItemId), "the head ids describe the recorded pass only")
      .toEqual(["wi-a", "wi-a"]);
  });

  it("attributes the window account to a card so retention can collect it", async () => {
    /*
    FNXC:RunAudit 2026-11-16-20:52 (RUFU-1069 code review P1):
    `pruneOperationalLogsAsync` deletes run-audit rows through their `task_id`, so a taskless row is
    immortal - `store:open` needed an explicit bounded retention exception for exactly that reason
    (RUFU-344). The account therefore names the window head's card as its own taskId, and a summary
    that can name no card writes nothing rather than writing an uncollectable row.
    */
    const events: Array<{ taskId?: string; target: string; metadata: PlanningWindowOutcome }> = [];
    const accounting = createPlanningContinuationAccounting({
      nowMs: () => PASS,
      emitAudit: (event) => {
        events.push(event);
        return Promise.resolve();
      },
      logEntryOnce: async () => undefined,
    });
    const rows = [row("wi-a", "FN-A"), row("wi-b", "FN-B")];
    await drainDuePlanningContinuations({
      listDue: async () => rows.map((r) => ({ ...r })) as never,
      getTask: async (taskId) => ({ id: taskId, column: "todo", status: null }) as never,
      cancelOrphan: async () => undefined,
      defer: async () => undefined,
      isPlannerLive: () => false,
      accounting,
      windowLimit: 20,
      dispatch: (() => "refused-claim") as never,
      nowMs: () => PASS,
      warn: () => undefined,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.taskId, "the row must be collectable through the card it describes")
      .toBe("FN-A");
    expect(events[0]!.target).toBe("FN-A");
    expect(events[0]!.metadata.windowHeadItemId, "the item id stays as metadata").toBe("wi-a");

    const unowned: string[] = [];
    const bare = createPlanningContinuationAccounting({
      nowMs: () => PASS,
      emitAudit: () => { unowned.push("row"); return Promise.resolve(); },
      logEntryOnce: async () => undefined,
    });
    await bare.observe("wi-x", "FN-X", "refused-claim");
    await bare.finish({
      limit: 1,
      dueSetTruncated: false,
      windowHeadTaskId: null,
      windowHeadItemId: null,
    });
    expect(unowned, "an unattributable row is a leak, not a record").toEqual([]);
  });

  it("counts each pass separately even though the emission floor is shared", async () => {
    let now = PASS;
    const h = makeWindowHarness(3, { nowMs: () => now });
    await h.run(() => "refused-claim");
    now += WINDOW_OUTCOME_REFRESH_FLOOR_MS;
    await h.run(() => "refused-claim");
    expect(h.emits.map((e) => e.examinedCount)).toEqual([3, 3]);
    expect(h.emits.map((e) => e.claimRefusedCount)).toEqual([3, 3]);
  });
});

describe("a hostile accounting sink cannot cost a dispatch", () => {
  const hostile: Array<[string, () => unknown]> = [
    ["absent", () => undefined],
    ["throwing", () => { throw new Error("audit store unreachable"); }],
    ["rejecting", () => Promise.reject(new Error("audit store unreachable"))],
    ["hanging", () => new Promise(() => {})],
  ];

  for (const [name, makeSink] of hostile) {
    it(`still bounds every row and dispatches the window when the ${name} sink ${name === "hanging" ? "never settles" : "fails"}`, async () => {
      // RUFU-9175's rule: telemetry is never a lifecycle dependency. Absent, throwing, rejecting and
      // never-settling sinks all have to leave the pass doing its actual job. The hang case is why
      // the History write is raced against a deadline instead of merely awaited.
      const armed: string[] = [];
      const accounting = createPlanningContinuationAccounting({
        nowMs: () => PASS,
        emitAudit: makeSink as never,
        logEntryOnce: makeSink as never,
        sinkTimeoutMs: 25,
      });
      const rows = [row("wi-0", "FN-0"), row("wi-1", "FN-1")];
      const executed: string[] = [];
      await drainDuePlanningContinuations({
        listDue: async () => rows.map((r) => ({ ...r })) as never,
        getTask: async (taskId) => ({ id: taskId, column: "todo", status: null }) as never,
        cancelOrphan: async () => undefined,
        defer: async ({ itemId }) => { armed.push(itemId); },
        isPlannerLive: () => false,
        accounting,
        windowLimit: 20,
        dispatch: ((_task: never, item: { id: string }) => {
          executed.push(item.id);
          return item.id === "wi-0" ? "refused-claim" : "dispatched";
        }) as never,
        nowMs: () => PASS,
        warn: () => undefined,
      });

      expect(executed).toEqual(["wi-0", "wi-1"]);
      expect(armed, "the refused row still gets its bound").toEqual(["wi-0"]);
    });
  }

  it("does not hold up the next row's dispatch waiting for one card's History write", async () => {
    /*
    FNXC:PlanningContinuationDispatch 2026-11-16-20:52 (RUFU-1069 code review P2):
    `logEntryOnce` opens a transaction and takes the per-task advisory lock. Awaiting it inline put one
    store round-trip per examined row inside a pass meant to run every 2 s, so a contended store seam
    re-created, in the accounting path, the starvation this card removes from the dispatch path (the
    RUFU-453 lesson: best-effort telemetry never sits on the owning lane's critical path). The write is
    therefore started detached and flushed once at the end of the pass. The ordering is the proof, and
    it is causal rather than a timing guess: an inline await cannot produce a later row's dispatch
    before the earlier write settles.
    */
    const order: string[] = [];
    const accounting = createPlanningContinuationAccounting({
      nowMs: () => PASS,
      emitAudit: () => undefined,
      logEntryOnce: async (taskId) => {
        order.push(`history:${taskId}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push(`history-settled:${taskId}`);
      },
      sinkTimeoutMs: 500,
    });
    const rows = [row("wi-0", "FN-0"), row("wi-1", "FN-1"), row("wi-2", "FN-2")];
    await drainDuePlanningContinuations({
      listDue: async () => rows.map((r) => ({ ...r })) as never,
      getTask: async (taskId) => ({ id: taskId, column: "todo", status: null }) as never,
      cancelOrphan: async () => undefined,
      defer: async () => undefined,
      isPlannerLive: () => false,
      accounting,
      windowLimit: 20,
      dispatch: ((_task: never, item: { id: string }) => {
        order.push(`dispatch:${item.id}`);
        return item.id === "wi-1" ? "dispatched" : "refused-claim";
      }) as never,
      nowMs: () => PASS,
      warn: () => undefined,
    });

    expect(order.filter((entry) => entry.startsWith("dispatch:")), "the whole window was dispatched")
      .toEqual(["dispatch:wi-0", "dispatch:wi-1", "dispatch:wi-2"]);
    expect(
      order.indexOf("history-settled:FN-0") > order.indexOf("dispatch:wi-2"),
      `the first card's write must still have been outstanding when the last row dispatched: ${order.join(", ")}`,
    ).toBe(true);
  });

  it("survives a store with no logEntryOnce seam at all", async () => {
    // Duck-typed partial stores are the normal shape on the admission path; the accounting must not
    // require a seam the store may not have.
    const accounting = createPlanningContinuationAccounting({ nowMs: () => PASS });
    await expect(accounting.observe("wi-0", "FN-0", "refused-claim")).resolves.toBeUndefined();
    await expect(accounting.finish({
      limit: 1,
      dueSetTruncated: false,
      windowHeadTaskId: "FN-0",
      windowHeadItemId: "wi-0",
    })).resolves.toBeUndefined();
  });

  it("keeps counting when the History write is deduped by the store", async () => {
    const logEntryOnce = vi.fn(async () => false);
    const accounting = createPlanningContinuationAccounting({
      nowMs: () => PASS,
      logEntryOnce,
      emitAudit: () => undefined,
    });
    await accounting.observe("wi-0", "FN-0", "refused-claim");
    await accounting.observe("wi-0", "FN-0", "refused-claim");
    expect(logEntryOnce).toHaveBeenCalledTimes(2);
    const account = accounting.snapshot({
      limit: 2,
      dueSetTruncated: false,
      windowHeadTaskId: "FN-0",
      windowHeadItemId: "wi-0",
    });
    expect(account).toMatchObject({ examinedCount: 2, claimRefusedCount: 2, dispatchedCount: 0 });
  });
});
