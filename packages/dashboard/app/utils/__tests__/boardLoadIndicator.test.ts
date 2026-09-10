/*
FNXC:BoardProgressIndicator 2026-09-10-15:24:
The top progress bar swept forever on an idle board because its visibility was derived from `isStale`
alone — an open-ended "rows are unconfirmed" flag that a failed or superseded refresh never clears.
These cases pin the composed rule for every surface that renders the bar (Board, List, the renamed and
Complete lanes, and the mobile board all share this one predicate; none of them differ on it) so a
future loading source cannot silently reintroduce an unbounded animation.
*/
import { describe, it, expect } from "vitest";
import { isBoardBarIndeterminate } from "../boardLoadIndicator";

describe("isBoardBarIndeterminate", () => {
  it("does not sweep for staleness with no request in flight", () => {
    // The reported failure: an idle board whose rows are unconfirmed after a refresh already ended.
    expect(
      isBoardBarIndeterminate({
        projectsLoading: false,
        currentProjectLoading: false,
        isStale: true,
        isBoardRefreshInFlight: false,
      }),
    ).toBe(false);
  });

  it("sweeps only while a board load the operator is waiting on is running", () => {
    expect(
      isBoardBarIndeterminate({
        projectsLoading: false,
        currentProjectLoading: false,
        isStale: true,
        isBoardRefreshInFlight: true,
      }),
    ).toBe(true);
  });

  it("stays silent for a catch-up refresh over rows that are already confirmed", () => {
    // An SSE-reconnect revalidation refreshes rows that are not currently suspect: flashing here would
    // light the bar on every socket resume.
    expect(
      isBoardBarIndeterminate({
        projectsLoading: false,
        currentProjectLoading: false,
        isStale: false,
        isBoardRefreshInFlight: true,
      }),
    ).toBe(false);
  });

  it.each([
    ["the project list", { projectsLoading: true }],
    ["the active project", { currentProjectLoading: true }],
  ])("sweeps while %s is loading, regardless of board freshness", (_label, loading) => {
    expect(
      isBoardBarIndeterminate({
        projectsLoading: false,
        currentProjectLoading: false,
        isStale: false,
        isBoardRefreshInFlight: false,
        ...loading,
      }),
    ).toBe(true);
  });

  it("rests when everything is loaded and confirmed", () => {
    expect(
      isBoardBarIndeterminate({
        projectsLoading: false,
        currentProjectLoading: false,
        isStale: false,
        isBoardRefreshInFlight: false,
      }),
    ).toBe(false);
  });
});
