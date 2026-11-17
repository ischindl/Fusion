/*
FNXC:UnclaimedGraphWork 2026-11-17-01:05 (RUFU-1050):
The drain's own sizing constants, in a leaf. They lived in `runtimes/in-process-runtime.ts`, and a
release surface that must answer truthfully about the FIFO window (`execution/hold-release.ts`) cannot
import the runtime: the runtime imports the scheduler, which imports hold-release, so the import would
be a cycle. A leaf is the only shape both sides can reach, and the constants stay ONE cluster because
each is sized RELATIVE to the others — a batch limit without the poll period it rotates over is just a
number. `runtimes/in-process-runtime.ts` re-exports all three so its existing importers are unchanged.

FNXC:ContinuationDrainFairness 2026-10-29-10:55 (RUFU-812):
How long a capacity-refused continuation leaves the due window before it may be tried again.
The batch limit below is deliberately small and the due poll is ordered by task queue rank, so the
only thing that makes the window advance is a refused row leaving the due set. Without a stamp the
refused head is re-listed and re-refused every pass and rows beyond the limit are never read.

FNXC:ContinuationDrainFairness 2026-11-02-19:57 (RUFU-862):
The original 5 s horizon was sized against a wrong rotation model. It cost "ceil(156 / 20) = 8 passes"
of ONE STAMP PER PASS, because the refusal path stamped a single row and stopped; a pass can only
stamp the whole window once the stop becomes a stamp-only continuation (see
`drainDuePlanningContinuations`). With one stamp per pass the window advances one row per poll, so a
full rotation costs `N` polls, not `ceil(N / W)`.

The horizon must outlast one window rotation or the head re-enters before the tail is ever read. One
rotation of a W-wide window at the 2 s continuation poll costs at least W × 2 s = 40 s, so the floor
is 45 s. Measured on the live board the same day: 274 due `kind: "task"` continuations, 256 of them
with a NULL `retryAfter` (never deferred), only ONE row carrying a future one, and RUFU-627 ranked
101st behind a window of 20 — four times outside reach, with `capacity_refused=0` and free executor
capacity. A refused head that stays out for 45 s moves 20 rows per pass instead of one.

The cost is bounded by the wake, not the timer: `dispatch-wakes.ts` treats reservation release as a
wake signal ("returning the last shared slot is the exact moment ANOTHER card becomes runnable"), so
a freed slot re-consults a stamped row immediately. The 2 s interval is a backstop for a lost NOTIFY
(EventDrivenDispatch FN-519), which is why a longer horizon does not become added latency.

FNXC:ContinuationDrainFairness 2026-11-02-20:12 (RUFU-862):
The continuation due poll's own period is named because the horizon above is only correct RELATIVE to
it. Until now it was an inline literal 2 300 lines from the constant that has to outlast it, so the
relationship could not be asserted by anything: a poll that slowed, or a due set that grew, silently
defeated the fairness stamp while every test stayed green.
*/

/**
 * The FIFO due-poll batch size. Named because the starvation the deferral below prevents is a
 * property of this bound, so the two belong in one place. A card ranked past this many rows is
 * `behind-drain-window`: a valid, due, un-deferred row the drain never reads.
 */
export const DUE_PLANNING_CONTINUATION_BATCH_LIMIT = 20;

/** How long a capacity-refused continuation leaves the due window before it may be tried again. */
export const CAPACITY_REFUSAL_DEFER_MS = 45_000;

/** The continuation due poll's own period, which every deferral horizon above is sized against. */
export const WORKFLOW_CONTINUATION_POLL_MS = 2_000;
