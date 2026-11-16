import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Task, WorkflowWorkItem } from "@fusion/core";

import { drainDuePlanningContinuations } from "../runtimes/in-process-runtime.js";

/*
FNXC:PlanningContinuationDispatch 2026-11-16-17:10 (RUFU-1069):
KEEP-THIS-TRUE RATCHET, NOT A RED TEST. The operator's report read "the dispatch pass sorts by a
different comparator", and the measurement that refuted it is recorded in this card's discrimination
document: `listDueWorkflowWorkItems` renders `taskQueueOrderBy()` BEFORE its `LIMIT`, so an
operator-boosted card really is rank 1 inside the 20-wide planning window on HEAD. There is therefore
no boost endpoint to unbind and no red baseline to reproduce - a test asserting "the boosted card is
claimed before older cards" would have been green before this card existed, which makes it an invalid
gate on its own.

What this file pins instead is the two ways that guarantee could silently rot, both checkable without a
database, because either failure looks identical from the board:

1. The `LIMIT` may be applied BEFORE the ordering. The window is 20 rows; ordering after truncation
   would keep a boosted card outside the first 20 by creation invisible forever.
2. A second comparator may appear downstream. The engine half is the drain re-sorting its window; a
   local `.sort(...)` inside the pass would outrank the store's queue rank with an arrival order and
   reproduce the operator's symptom while leaving the store's read correct.

The store's end-to-end behaviour over real rows belongs to the `.pg` lane that owns the due predicate
(`workflow-stranded-deferral-horizon.pg.test.ts`). This environment has no reachable PostgreSQL, so that
lane SKIPS here and these are the executable half - which is why the ordering claim is asserted on the
comparator's own declaration and on the code construct, not on a fake store's re-implementation of the
predicate. `task-attention-cost-bound.test.ts` stays the authority on the generated ORDER BY bytes.
*/

/** Slice one exported function's body out of a source file by brace matching. */
function functionBody(sourceText: string, signature: string): string {
  const start = sourceText.indexOf(signature);
  expect(start, `${signature} must exist`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = sourceText.indexOf("{", start); i < sourceText.length; i += 1) {
    if (sourceText[i] === "{") depth += 1;
    else if (sourceText[i] === "}") {
      depth -= 1;
      if (depth === 0) return sourceText.slice(start, i + 1);
    }
  }
  throw new Error(`${signature} body never closed`);
}

/** Slice from a declaration to the next top-level declaration (parameter lists hold object literals). */
function declarationSlice(sourceText: string, signature: string): string {
  const start = sourceText.indexOf(signature);
  expect(start, `${signature} must exist`).toBeGreaterThan(-1);
  const next = sourceText.indexOf("\nexport ", start + 1);
  return next === -1 ? sourceText.slice(start) : sourceText.slice(start, next);
}

const readSource = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

interface WindowHarness {
  asked: string[];
  armed: string[];
  run(outcome: (taskId: string) => string): Promise<void>;
}

/** A drain over a hand-built window whose order stands in for the store's queue rank. */
function makeWindow(taskIds: string[]): WindowHarness {
  const items = taskIds.map((taskId, index) => ({
    id: `wi-${taskId}`,
    taskId,
    nodeId: "plan-review",
    nodeInstanceId: "plan-review",
    runId: `run-${taskId}`,
    kind: "task" as const,
    state: "runnable" as const,
    attempt: 0,
    retryAfter: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    // Deliberately in the OPPOSITE order to the queue rank handed back, so a local re-sort by
    // creation time is observable rather than coincidentally correct.
    createdAt: new Date(
      Date.parse("2026-11-10T00:00:00.000Z") - index * 24 * 3600_000,
    ).toISOString(),
    updatedAt: "2026-11-10T00:00:00.000Z",
  })) as WorkflowWorkItem[];
  const tasks = new Map(
    items.map((item) => [item.taskId, { id: item.taskId, column: "todo", status: null } as Task]),
  );
  const asked: string[] = [];
  const armed: string[] = [];
  return {
    asked,
    armed,
    run: async (outcome) => {
      await drainDuePlanningContinuations({
        listDue: async () => items.map((item) => ({ ...item })),
        getTask: async (taskId) => tasks.get(taskId),
        cancelOrphan: async () => undefined,
        defer: async ({ itemId }) => { armed.push(itemId); },
        isPlannerLive: () => false,
        windowLimit: 20,
        dispatch: ((task: Task) => {
          asked.push(task.id);
          return outcome(task.id);
        }) as never,
        nowMs: () => Date.parse("2026-11-16T12:35:00.000Z"),
        warn: () => undefined,
      });
    },
  };
}

describe("planning dispatch reads the same queue order the board shows", () => {
  it("keeps the boost the leading term of the shared queue comparator", () => {
    // The FIRST ORDER BY term is the one a LIMIT truncation can never recover from, so the boost has
    // to stay the leading expression. `drizzle-orm` is not a dependency of this package, so the term
    // order is read off the comparator's own declaration; the generated bytes are pinned in core.
    const terms = functionBody(
      readSource("../../../core/src/task-store/task-queue-order-ops.ts"),
      "export function taskQueueOrderBy(): SQL[] {",
    );
    const boostAt = terms.indexOf("QUEUE_BOOST_SEQUENCE");
    expect(boostAt, "the comparator must order by the boost").toBeGreaterThan(-1);
    expect(
      boostAt,
      "the boost must lead, ahead of any creation-date term",
    ).toBeLessThan(terms.indexOf("tasks.createdAt"));
  });

  it("applies the queue order before the window's LIMIT, not after it", () => {
    const read = declarationSlice(
      readSource("../../../core/src/task-store/async/async-workflow-workitems.ts"),
      "export async function listDueWorkflowWorkItems(",
    );
    const ordered = read.indexOf("...taskQueueOrderBy()");
    const limited = read.indexOf("query.limit(");
    expect(ordered, "the due read must order by the shared queue rank").toBeGreaterThan(-1);
    expect(limited, "the due read must keep its window LIMIT").toBeGreaterThan(-1);
    expect(ordered, "the ordering must precede the LIMIT").toBeLessThan(limited);
  });

  it("gives the planning drain no comparator of its own", () => {
    const body = functionBody(
      readSource("../runtimes/in-process-runtime.ts"),
      "export async function drainDuePlanningContinuations(",
    );
    // The store's queue rank is the only order this pass may honour. A local sort would silently
    // outrank a boosted card and look, from the board, exactly like the defect this card removed.
    expect(body).not.toMatch(/\.sort\(/);
    expect(body).not.toMatch(/\.toSorted\(/);
  });

  it("asks in the order the store returned the window, never in an order of its own", async () => {
    // The executable half. The rows arrive in queue rank while their creation times run the other way,
    // so a local re-sort - by creation time, by id, by anything - goes red on this assertion.
    const h = makeWindow(["FN-BOOSTED", "FN-OLD-1", "FN-OLD-2"]);
    await h.run(() => "dispatched");
    expect(h.asked).toEqual(["FN-BOOSTED", "FN-OLD-1", "FN-OLD-2"]);
    expect(h.armed, "a dispatched row is never armed").toEqual([]);
  });

  it("dispatches nothing further and bounds every remaining row after one shared-capacity refusal", async () => {
    /*
    RUFU-862's whole-window latch restated as a queue-rank guarantee, and the contract this card keeps:
    a capacity refusal is a property of the WINDOW, so the rows behind it are never dispatched again on
    that pass - but they are still STAMPED, because a row left with a NULL `retryAfter` is re-listed in
    the next 20-wide window and re-starves the tail. Three arms, three bounds, one dispatch attempt.
    */
    const h = makeWindow(["FN-BOOSTED", "FN-OLD-1", "FN-OLD-2"]);
    await h.run(() => "deferred-capacity");
    expect(h.asked).toEqual(["FN-BOOSTED"]);
    expect(h.armed).toEqual(["wi-FN-BOOSTED", "wi-FN-OLD-1", "wi-FN-OLD-2"]);
  });

  it("bounds a refused head without stopping the pass from reaching the rows behind it", async () => {
    // The inverse case, and the one the operator's board was showing: a per-row refusal is NOT a
    // property of the window, so it must not latch. The head gets its own bound and the rows behind it
    // still get their turn at admission in the SAME pass.
    const h = makeWindow(["FN-BOOSTED", "FN-OLD-1", "FN-OLD-2"]);
    await h.run((taskId) => (taskId === "FN-BOOSTED" ? "refused-claim" : "dispatched"));
    expect(h.asked).toEqual(["FN-BOOSTED", "FN-OLD-1", "FN-OLD-2"]);
    expect(h.armed).toEqual(["wi-FN-BOOSTED"]);
  });
});
