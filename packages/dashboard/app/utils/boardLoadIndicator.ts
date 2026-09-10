/*
FNXC:BoardProgressIndicator 2026-09-10-15:24:
The top progress bar is an INDETERMINATE activity indicator: a sweeping animation that promises work
is happening right now. It must therefore be driven by an in-flight request, never by an open-ended
data-freshness flag. `isStale` in `useTasks` is cleared only when a fetch confirms the rows
(`setIsStale(false)`), and it survives a failed revalidation, a superseded request that returns early,
and every browser-resume re-arm — so binding the animation to it alone left the bar sweeping forever
on a board that was merely idle-but-unconfirmed, which is what the operator saw as "the progress bar
runs forever" with no work occurring.

The rule encoded here: staleness WITHOUT a live request is not progress. Unconfirmed data still has
to be reported (the rows stay on screen and `isStale` / `lastRefreshErrorAt` stay available for a
distinct stale-data affordance), but it is not progress-bar material.

This is the single composition point for the flag so every surface — Board, List, Complete lanes, and
the mobile board, none of which differ on this rule — answers from one predicate. Add new loading
sources here, not inside `TopProgressBar`.
*/

/** The loading inputs that can make the top progress bar indeterminate. */
export interface BoardLoadIndicatorInput {
  /** The project list is loading. */
  projectsLoading: boolean;
  /** The active project's metadata is loading. */
  currentProjectLoading: boolean;
  /** Board rows are not confirmed by the server. */
  isStale: boolean;
  /** A board revalidation request is currently in flight. */
  isBoardRefreshInFlight: boolean;
}

/**
 * True only while the board is waiting on a request the operator is actually waiting for.
 *
 * A board refresh that runs while the rows are already server-confirmed (an SSE reconnect catch-up)
 * stays silent by design: it re-validates data that is not currently shown as suspect, so surfacing
 * it would flash the bar on every socket resume.
 */
export function isBoardBarIndeterminate({
  projectsLoading,
  currentProjectLoading,
  isStale,
  isBoardRefreshInFlight,
}: BoardLoadIndicatorInput): boolean {
  return projectsLoading || currentProjectLoading || (isStale && isBoardRefreshInFlight);
}
