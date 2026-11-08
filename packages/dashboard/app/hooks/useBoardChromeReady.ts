/*
FNXC:BoardBootRequestSet 2026-11-08-03:34 (RUFU-493):
One authority for "the board's own reads have finished, so background chrome may now read".

`App` mounts consumers that exist only to decorate the board — the capacity-risk banner's agent stats,
and until this change an eager `/api/agents` + `/api/agents/stats` pair. The client caps concurrent reads
at `MAX_CONCURRENT_READS = 4`, and on the deployed board the unbounded board payload took 22.0 s while
`/api/agents/stats` took 11.8 s, so a read issued at mount was not merely late, it occupied one of the
four slots the board payload needed. Deferring it behind the board's own completion costs the chrome
nothing (it is a dismissible banner, not the reason the page exists) and returns those slots.

The condition is a STATE, not a delay: a settled board read is observed, never waited for on a timer.
That is deliberate — a timer-based deferral is a race the operator's machine loses on a cold cache, and
it cannot be asserted without reading a clock, which is the class of assertion this task forbids.


FNXC:BoardBootRequestSet 2026-11-08-05:40 (RUFU-493 code review, P1):
The single consumer is `App`'s boot-path agents call, which opens only on BOTH clauses:
`enabled: boardChromeReady && capacityRiskBannerEnabled === true`, where `boardChromeReady` is this hook over
`useTasks`' `lastFetchTimeMs`. The setting clause is what decides a default deployment — the flag is `false`
in `DEFAULT_PROJECT_SETTINGS` — and the board clause is what keeps a read from taking one of the four
concurrent-read slots the board payload itself needs. A note here once described that wiring as shipped while
`App` still called `useAgents(projectId)` ungated; the requirement now stands where it can be honoured, and
`board-boot-request-set.test.tsx` fails if the call site in `App.tsx` stops matching it.
*/
export function useBoardChromeReady(boardReadSettledAt: number | undefined): boolean {
  return boardReadSettledAt !== undefined;
}
