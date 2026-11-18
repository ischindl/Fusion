/*
FNXC:BoardLaneReadScope 2026-11-18-06:40 (RUFU-479) — one lane in view means one lane read.

This is the read-count half of the idle-board-cost claim, and it belongs at the hook that ISSUES the lane
reads rather than in the component that hands it a scope list: the measured board burst (42 requests inside
one second, the whole-project page costing 8.79-10.79 s each) is a count-and-frequency problem, and a count
asserted against a render is a count that can only be re-checked by a browser trace.

Four properties are pinned, because each one has been the failure at some point:
  * one request per scope, and exactly that many - no per-card fan-out, no duplicate per lane;
  * a view whose visible set shrinks stops reading the lanes it lost, and aborts what it had in flight;
  * a parent re-render with an unchanged scope list issues nothing new (the signature is the identity);
  * a view that is not on screen (`enabled: false`, the keep-alive case) issues zero reads at all.
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

const { useTaskQueuePages } = await import("../useTaskQueuePages");
const { buildBoardLaneScopes } = await import("../../api/client/board-request-scope");
type BoardLaneColumn = import("../../api/client/board-request-scope").BoardLaneColumn;

function makeTask(id: string, column: string): Task {
  return {
    id,
    title: id,
    description: "",
    column,
    dependencies: [],
    createdAt: "2026-11-18T06:00:00.000Z",
    updatedAt: "2026-11-18T06:00:00.000Z",
  } as Task;
}

const page = (...tasks: Task[]) => ({ tasks, total: tasks.length, hasMore: false, nextCursor: null });

const VOCABULARY: BoardLaneColumn[] = [
  { id: "backlog", flags: { intake: true, manualIntake: true } },
  { id: "todo", flags: {} },
  { id: "in-progress", flags: { countsTowardWip: true } },
  { id: "in-review", flags: { countsTowardWip: true, humanReview: true } },
  { id: "done", flags: { complete: true } },
];

/** The columns each recorded request named, in call order. */
function requestedColumns(): string[] {
  return fetchTaskQueuePage.mock.calls.map((call) => String((call[1] as { columns: string[] }).columns.join("+")));
}

beforeEach(() => {
  fetchTaskQueuePage.mockReset();
  fetchTaskQueuePage.mockImplementation(async (_projectId: string, request: { columns: string[] }) =>
    page(makeTask(request.columns[0]!, request.columns[0]!)),
  );
});

describe("useTaskQueuePages read scope (RUFU-479)", () => {
  it("issues exactly one read per visible lane and no unscoped read", async () => {
    const scopes = buildBoardLaneScopes(VOCABULARY);
    const { result } = renderHook(() => useTaskQueuePages("project-a", scopes, { limit: 50 }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchTaskQueuePage).toHaveBeenCalledTimes(scopes.length);
    expect(requestedColumns().sort()).toEqual(["backlog", "in-progress", "in-review", "todo"]);
    // An unscoped read would name zero columns; the lane reader is the only shape this hook may use.
    expect(requestedColumns().every((columns) => columns.length > 0)).toBe(true);
  });

  it("reads one lane on a phone and stops reading the four it lost when the view narrows", async () => {
    const wide = buildBoardLaneScopes(VOCABULARY);
    const narrow = buildBoardLaneScopes(VOCABULARY, { visibleColumnIds: ["in-progress"] });

    const { rerender } = renderHook(
      ({ scopes }: { scopes: typeof wide }) => useTaskQueuePages("project-a", scopes, { limit: 50 }),
      { initialProps: { scopes: wide } },
    );
    await waitFor(() => expect(fetchTaskQueuePage).toHaveBeenCalledTimes(wide.length));

    fetchTaskQueuePage.mockClear();
    rerender({ scopes: narrow });
    await waitFor(() => expect(fetchTaskQueuePage).toHaveBeenCalledTimes(1));
    expect(requestedColumns()).toEqual(["in-progress"]);
  });

  it("issues nothing on a re-render whose scopes are the same lanes in the same order", async () => {
    const scopes = buildBoardLaneScopes(VOCABULARY);
    const { rerender } = renderHook(
      ({ scopes: list }: { scopes: typeof scopes }) => useTaskQueuePages("project-a", list, { limit: 50 }),
      { initialProps: { scopes } },
    );
    await waitFor(() => expect(fetchTaskQueuePage).toHaveBeenCalledTimes(scopes.length));

    // A fresh array identity over identical lanes is the ordinary parent re-render. The signature, not the
    // reference, is the refetch identity, so this must be silent.
    fetchTaskQueuePage.mockClear();
    rerender({ scopes: buildBoardLaneScopes(VOCABULARY) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchTaskQueuePage).not.toHaveBeenCalled();
  });

  it("reads nothing for a view that is kept alive but off screen", async () => {
    const { result } = renderHook(() =>
      useTaskQueuePages("project-a", buildBoardLaneScopes(VOCABULARY), { enabled: false }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchTaskQueuePage).not.toHaveBeenCalled();
    expect(result.current.tasks).toEqual([]);
  });

  it("reads nothing while the vocabulary is unknown, instead of guessing a lane list", async () => {
    const { result } = renderHook(() => useTaskQueuePages("project-a", [], { limit: 50 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchTaskQueuePage).not.toHaveBeenCalled();
  });
});
