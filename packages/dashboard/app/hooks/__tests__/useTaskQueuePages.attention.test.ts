/*
FNXC:BoardOrdering 2026-11-13-10:37 (RUFU-526):
The client half of asking for attention, and the seam that decides WHICH lane asks.

The board's default sort lives in core and the SQL order lives in core, but neither of them can put a
card on the first screen unless the lane request that fills the lane asks for the ranked order. That
request is what these cases pin, because everything downstream of a wrong choice here is invisible: a
lane that never asks gets creation-ascending rows, and the one failed card among two hundred idle ones
is simply not in the payload to sort.

Three things had to be pinned rather than assumed:
- the mapping from a column's traits to the order it asks for, including the two lanes that do NOT ask
  for `attention`;
- that the review claim rides on the request at all, since without it the required-gate tier is off by
  design and a card blocked behind a failed gate ranks as idle;
- that the claim is part of the SCOPE identity, so a lane whose claim flips refetches instead of
  replaying a cursor the server is about to reject for belonging to a different order.
*/
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { Task } from "@fusion/core";

const fetchTaskQueuePage = vi.fn();
vi.mock("../../api", () => ({
  get fetchTaskQueuePage() {
    return fetchTaskQueuePage;
  },
}));

const { useTaskQueuePages, laneQueueScopeForColumn } = await import("../useTaskQueuePages");
type TaskQueueScope = import("../useTaskQueuePages").TaskQueueScope;

function makeTask(id: string, column: string): Task {
  return {
    id,
    title: id,
    description: "",
    column,
    dependencies: [],
    createdAt: "2026-11-13T10:00:00.000Z",
    updatedAt: "2026-11-13T10:00:00.000Z",
  } as Task;
}

const page = (...tasks: Task[]) => ({ tasks, total: tasks.length, hasMore: false, nextCursor: null });

describe("laneQueueScopeForColumn", () => {
  it("asks a working lane for the attention order", () => {
    expect(laneQueueScopeForColumn("in-progress", { countsTowardWip: true })).toEqual({
      key: "in-progress",
      columns: ["in-progress"],
      order: "attention",
    });
  });

  /*
  The two lanes that must NOT ask. A manual-capture lane has nothing on the ladder - no failure, no gate,
  no wait - and its ranking rule is newest-first so the operator can triage the pile. It keeps `intake`
  even when its traits say review, because a capture lane has no pre-merge gate to be blocked on and a
  claim there would be a claim about a thing that does not exist.
  */
  it("leaves manual capture on the intake order", () => {
    expect(laneQueueScopeForColumn("ideas", { manualIntake: true })).toEqual({
      key: "ideas",
      columns: ["ideas"],
      order: "intake",
    });
    expect(laneQueueScopeForColumn("backlog", { manualIntake: true, mergeBlocker: true }).order).toBe("intake");
    expect(laneQueueScopeForColumn("backlog", { manualIntake: true, mergeBlocker: true }).reviewScope).toBeUndefined();
  });

  it("never asks for queue, which is the order the engine dispatches on", () => {
    /*
    The dispatcher's order must not acquire a ranking opinion, so no lane asks for it any more - not a
    working lane, not a capture lane, and not a lane whose traits failed to resolve. A flagless column is
    the degraded window every other lane question has to survive, and it now lands on `attention` rather
    than on the dispatcher's order, which is the safer of the two answers.
    */
    const lanes: Array<[string, { manualIntake?: boolean; mergeBlocker?: boolean; countsTowardWip?: boolean } | undefined]> = [
      ["todo", { countsTowardWip: true }],
      ["in-progress", { countsTowardWip: true }],
      ["in-review", { mergeBlocker: true }],
      ["ideas", { manualIntake: true }],
      ["backlog", { manualIntake: true }],
      ["todo", undefined],
      ["in-review", undefined],
      ["ideas", undefined],
    ];
    const asked = new Set(lanes.map(([column, flags]) => laneQueueScopeForColumn(column, flags).order));
    expect(asked.has("queue")).toBe(false);
    expect(asked).toEqual(new Set(["attention", "intake"]));
    expect(laneQueueScopeForColumn("ideas", undefined).order).toBe("attention");
  });

  /*
  The claim follows the TRAITS, both of them, and falls back to the legacy review id when a column's
  traits did not resolve - the same degraded answer every other dashboard question about "is this
  review" gives. A lane that is not review claims nothing, so a backlog is never ranked by gates it has
  not reached: that is the over-rank direction the ladder forbids, and it is decided here.
  */
  it("claims the required-gate tier only for a review lane", () => {
    expect(laneQueueScopeForColumn("in-review", { mergeBlocker: true }).reviewScope).toBe(true);
    expect(laneQueueScopeForColumn("await-review", { humanReview: true }).reviewScope).toBe(true);
    expect(laneQueueScopeForColumn("in-review", undefined).reviewScope).toBe(true);
    expect(laneQueueScopeForColumn("quality-check", undefined).reviewScope).toBeUndefined();
    expect(laneQueueScopeForColumn("todo", { intake: true }).reviewScope).toBeUndefined();
    expect(laneQueueScopeForColumn("in-progress", { countsTowardWip: true }).reviewScope).toBeUndefined();
  });
});

describe("useTaskQueuePages with the attention order", () => {
  beforeEach(() => {
    fetchTaskQueuePage.mockReset();
  });

  it("carries the order and the review claim on the request that fills each lane", async () => {
    fetchTaskQueuePage.mockImplementation(async (_projectId: string, options: { columns: readonly string[] }) =>
      page(makeTask(options.columns[0] === "in-review" ? "FN-2" : "FN-1", options.columns[0]!)));

    const scopes: TaskQueueScope[] = [
      laneQueueScopeForColumn("todo", { intake: true }),
      laneQueueScopeForColumn("in-review", { mergeBlocker: true }),
    ];
    const { result } = renderHook(() => useTaskQueuePages("p-1", scopes, { limit: 50 }));

    await waitFor(() => expect(result.current.tasks.length).toBe(2));
    expect(fetchTaskQueuePage).toHaveBeenCalledWith(
      "p-1",
      expect.objectContaining({ columns: ["todo"], order: "attention", limit: 50 }),
    );
    // The review lane is the only one whose request carries the claim, and it carries it as a boolean
    // the route turns back into a claim the server then confirms or refuses.
    const reviewCall = fetchTaskQueuePage.mock.calls.find(
      (call: unknown[]) => (call[1] as { columns: string[] }).columns[0] === "in-review",
    );
    expect(reviewCall?.[1]).toEqual(expect.objectContaining({ order: "attention", reviewScope: true }));
    const todoCall = fetchTaskQueuePage.mock.calls.find(
      (call: unknown[]) => (call[1] as { columns: string[] }).columns[0] === "todo",
    );
    expect(todoCall?.[1]).not.toHaveProperty("reviewScope");
  });

  it("refetches a lane whose review claim flips instead of replaying a foreign cursor", async () => {
    fetchTaskQueuePage.mockImplementation(async (_projectId: string, options: { columns: readonly string[] }) =>
      page(makeTask("FN-1", options.columns[0]!)));

    const withoutClaim: TaskQueueScope = { key: "in-review", columns: ["in-review"], order: "attention" };
    const withClaim: TaskQueueScope = { key: "in-review", columns: ["in-review"], order: "attention", reviewScope: true };

    const { result, rerender } = renderHook(
      ({ scopes }: { scopes: TaskQueueScope[] }) => useTaskQueuePages("p-1", scopes, { limit: 10 }),
      { initialProps: { scopes: [withoutClaim] } },
    );
    await waitFor(() => expect(fetchTaskQueuePage).toHaveBeenCalledTimes(1));
    rerender({ scopes: [{ ...withoutClaim }] });
    expect(fetchTaskQueuePage).toHaveBeenCalledTimes(1);
    rerender({ scopes: [withClaim] });
    await waitFor(() => expect(fetchTaskQueuePage).toHaveBeenCalledTimes(2));
    expect(fetchTaskQueuePage.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ reviewScope: true }));
    // A parent re-render with an equivalent claim still must not re-request: the claim is identity, not
    // an array reference.
    rerender({ scopes: [{ ...withClaim }] });
    expect(fetchTaskQueuePage).toHaveBeenCalledTimes(2);
    expect(result.current.tasks.map((task) => task.id)).toEqual(["FN-1"]);
  });
});
