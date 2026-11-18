/*
FNXC:BoardLaneReadCost 2026-11-18-06:35 (RUFU-479) — the board's read set equals the board's visible lanes.

The measured failure this pins: a board load that costs 22-31 s fires 42 requests inside one second, and
the whole-project page (`GET /tasks/page?limit=100`) is the floor of that cost at 8.79-10.79 s per call
while a settings read on the same server answers in 5 ms. The lane-head read is the shape whose cost is
proportional to the work in view, so the count of lane reads, and the absence of an unscoped read, is the
number that has to be assertable rather than observed in a browser trace.

These cases run against the scope builder directly (no render), because every one of them is a property of
the list the builder returns, and rendering the board would only re-test React.
*/
import { describe, expect, it } from "vitest";
import {
  buildBoardLaneScopes,
  hasBoardLaneScope,
  laneQueueScopeForColumn,
  type BoardLaneColumn,
} from "../api/client/board-request-scope";

/** The operator's five-column board: capture, backlog, work, review, finished. */
const DESKTOP_VOCABULARY: BoardLaneColumn[] = [
  { id: "backlog", flags: { intake: true, manualIntake: true } },
  { id: "todo", flags: {} },
  { id: "in-progress", flags: { countsTowardWip: true } },
  { id: "in-review", flags: { countsTowardWip: true, humanReview: true } },
  { id: "done", flags: { complete: true } },
];

const lanesOf = (scopes: ReturnType<typeof buildBoardLaneScopes>) => scopes.flatMap((scope) => [...scope.columns]);

describe("buildBoardLaneScopes (RUFU-479)", () => {
  it("a five-column desktop board reads the four lanes it renders and nothing else", () => {
    const scopes = buildBoardLaneScopes(DESKTOP_VOCABULARY);
    expect(lanesOf(scopes)).toEqual(["backlog", "todo", "in-progress", "in-review"]);
    // One scope per lane, never one request per card, and never a request the board cannot display.
    expect(scopes).toHaveLength(4);
    expect(scopes.every((scope) => scope.columns.length === 1)).toBe(true);
  });

  it("reads no unscoped page: every scope names columns", () => {
    for (const scope of buildBoardLaneScopes(DESKTOP_VOCABULARY)) {
      expect(scope.columns.length, `scope "${scope.key}" names no column`).toBeGreaterThan(0);
    }
  });

  it("mobile reads exactly the one column in view, and a covered board reads none", () => {
    // A phone shows one column of the same vocabulary: one lane read, zero for the four off screen.
    expect(lanesOf(buildBoardLaneScopes(DESKTOP_VOCABULARY, { visibleColumnIds: ["in-progress"] })))
      .toEqual(["in-progress"]);
    // A panel covering the board (a detail overlay, a drawer at full height) adds zero lane reads; it must
    // not silently widen the set back to the whole vocabulary.
    expect(buildBoardLaneScopes(DESKTOP_VOCABULARY, { visibleColumnIds: [] })).toEqual([]);
  });

  it("a visible-column claim can never add a lane the vocabulary does not publish", () => {
    // A caller that names the terminal lane, or a lane that does not exist, gets nothing extra: narrowing
    // is an intersection, never a union.
    expect(lanesOf(buildBoardLaneScopes(DESKTOP_VOCABULARY, { visibleColumnIds: ["done", "ghost-lane"] })))
      .toEqual([]);
  });

  it("excludes a column the operator hid from the board surface", () => {
    const vocabulary: BoardLaneColumn[] = [
      ...DESKTOP_VOCABULARY,
      { id: "archive-draft", flags: { hiddenFromBoard: true } },
    ];
    expect(lanesOf(buildBoardLaneScopes(vocabulary))).not.toContain("archive-draft");
  });

  it("excludes the terminal lane, whose feed the bounded Done read already owns", () => {
    // The Done range is what dominates a long-lived project's table; a lane-head read there would be a
    // second, differently-ordered read of the same cards.
    expect(lanesOf(buildBoardLaneScopes(DESKTOP_VOCABULARY))).not.toContain("done");
  });

  it("issues no intake read for a workflow whose vocabulary has no manual-capture lane", () => {
    const noIntake: BoardLaneColumn[] = [
      { id: "todo", flags: {} },
      { id: "in-progress", flags: { countsTowardWip: true } },
    ];
    const scopes = buildBoardLaneScopes(noIntake);
    expect(scopes.map((scope) => scope.order)).not.toContain("intake");
    expect(lanesOf(scopes)).toEqual(["todo", "in-progress"]);
  });

  it("is stable for the same vocabulary, so a re-render cannot re-read every lane head", () => {
    // `useTaskQueuePages` derives its refetch identity from a signature over these scopes; an unstable
    // order here would refetch every lane on each parent render.
    const first = JSON.stringify(buildBoardLaneScopes(DESKTOP_VOCABULARY));
    const second = JSON.stringify(buildBoardLaneScopes([...DESKTOP_VOCABULARY].reverse().slice().reverse()));
    expect(second).toBe(first);
    expect(JSON.stringify(buildBoardLaneScopes(undefined))).toBe("[]");
  });

  it("keeps the review claim on the lanes the traits call review and off the ones they do not", () => {
    const scopes = buildBoardLaneScopes(DESKTOP_VOCABULARY);
    expect(scopes.find((scope) => scope.key === "in-review")?.reviewScope).toBe(true);
    expect(scopes.find((scope) => scope.key === "todo")?.reviewScope).toBeUndefined();
    // Manual capture stays newest-first even though its traits could be read as review-adjacent.
    expect(scopes.find((scope) => scope.key === "backlog")).toMatchObject({ order: "intake" });
  });
});

describe("hasBoardLaneScope (RUFU-479)", () => {
  it("answers no for a lane the view does not read, so an out-of-view SSE patch starts no read", () => {
    const scopes = buildBoardLaneScopes(DESKTOP_VOCABULARY, { visibleColumnIds: ["in-progress"] });
    expect(hasBoardLaneScope(scopes, "in-progress")).toBe(true);
    expect(hasBoardLaneScope(scopes, "todo")).toBe(false);
    expect(hasBoardLaneScope(scopes, "done")).toBe(false);
  });
});

describe("laneQueueScopeForColumn is now reachable from its one owner", () => {
  it("answers the working-lane order from the shared module the hook re-exports", async () => {
    const fromHook = await import("../hooks/useTaskQueuePages");
    expect(fromHook.laneQueueScopeForColumn).toBe(laneQueueScopeForColumn);
  });
});
