---
category: logic-errors
module: "@fusion/core task-store reads, task-log projections"
date: 2026-11-21
problem_type: logic_error
component: task-log-envelope
severity: high
task: RUFU-636
applies_when:
  - "Adding a derivation served from `tasks.log_recent` or `project.task_log_rollup`"
  - "Proving a compact summary 'complete' and planning for a reader to consult that proof"
  - "Falling back from a projection column to `project.task_log_entries` (or any side table) to repair an answer"
  - "Comparing a `timestamp` column against a bound, or trusting `entry_count` to describe a History"
  - "Measuring how many statements a read pass costs via `pg_stat_database`"
tags:
  - task-log
  - projection
  - sufficiency-proof
  - fallback
  - read-cost
---

# A proof nobody reads, and the repair that was worse than the defect

RUFU-615 shipped an envelope that states whether it can prove its own answer (`provablyComplete`, derived
from `unparseableCount` and two newest-dropped markers). RUFU-636's census found the flag computed in four
resolvers and consulted in **zero** readers, while RUFU-312 had meanwhile made every list read log-free — so
the board derived its stall badges from an envelope nobody proved. Fixing "the reader ignores the flag" by
adding a fallback is where the three non-obvious invariants below live. Each one turned a correct-looking
repair into a **worse answer than the card already had**.

## 1. A hydrated-empty collection is not an empty one

`pgRowToTaskRow` hydrates an absent `log` to `[]`, and the file says so: on a log-free row `task.log` is
"indistinguishable from an empty history". So the intuitive repair — `mergeTaskLogViews(row.log ?? [], entries)`
— merges a hydration artifact with a side-table read. If the side read comes back empty, the merged view is
empty, and a card whose envelope counted 16 churn matches now shows **no badge at all**: the fallback replaced
an understated number with a missing one. The shipped rule is that a gated row's badges derive from the
fetched entries **alone**, that `row.log ?? []` may never feed a derivation on a log-free row, and that a
side read returning nothing is `side-history-absent` — a refusal, never an answer.

Corollary that surprised the first draft: `const logLoaded = pgRow.log !== undefined` must keep naming the
**raw-row** fact. Carry the gate outcome in its own local; overwriting `logLoaded` is how a repaired row
starts claiming the SELECT carried a column it never asked for.

## 2. `entry_count` is not a completeness witness, so a newest-only freshness proof is not a proof

The envelope has two authors. `appendTaskLogEntries` derives the rollup over the **merged** legacy+side view
(`merged: mergeTaskLogViews(legacy ?? [], side, cap)`) while storing `entryCount: input.sideCount` — a count
of side rows describing a view that was never only side rows. And the only path that copies legacy arrays across,
`catchUpLegacyTaskLogEntries`, filters `>= backfilledAt` and stops at 200 tasks per pass. Both mechanisms let
an envelope name an in-window History line `project.task_log_entries` never received.

Consequence, and this is the trap: the natural completeness proof — "some entries came back, and the newest is
at least as new as the envelope's `latestAt`" — **passes** such a row. The window holds a line newer than
anything the author saw while missing the *older* in-window line the author counted, so deriving from it
produces a `matchCount` **lower** than the envelope's. A proof must therefore check set membership, not
freshness: the returned window has to contain **every timestamp the picked envelope itself names** inside the
horizon (proof 4, `sideHoldsNamedTimestamps`). `entryCount` never enters that comparison in either direction.

## 3. Text ordering and parsed instants disagree, so a scoping rule written as an OR withholds nothing

`task_log_entries.timestamp` is `text`: the bound is a lexicographic comparison and the built bound is
`new Date(horizonMs).toISOString()`. Legacy rows carry stamps that are valid to `Date.parse` but sort
differently (`-05:00`, space-separated). Two rules follow, and Step 4 caught the first one written wrong:

- **Requiring** a named stamp was first written as "parses inside the horizon **OR** sorts at/after the
  bound". For a stamp that parses as *unparseable* and sorts below the bound, both halves fail, so the
  exemption read "nothing required" and the gate repaired a card whose History it could not reproduce. The
  shipped exemption is the conjunction of two **negative** proofs — the stamp parses AND is older than the
  horizon AND sorts below the bound. An unparseable stamp is never provably old, so it always withholds.
- A stamp whose UTC instant is in-window but whose raw text sorts below the ISO bound cannot be returned by
  that read. Such a row is withheld (`side-missing-named-timestamp`) rather than repaired from a window that
  could not hold the line — the undercount, wearing a green badge.

## 4. Not everything a fallback could touch should be served by it

`computeTimedExecutionMs` sums `N ms` figures out of `[timing]` entry **text** and reads no timestamp, so it
needs the whole History: a horizon-bounded fetch cannot answer it, and a stored `timing_total_ms` is exact.
Leaving `timedExecutionMs` on the stored column is both cheaper and more accurate — a fallback that "helpfully"
recomputed every derived figure would have shipped a smaller wrong number. When a fallback is added, ask per
derivation whether a bounded read can be *lossless* for it.

## Measurement pitfall: counting statements with `pg_stat_database`

The cost claim is "at most one extra `task_log_entries` statement per pass". `pg_stat_database.xact_commit`
reported **+0** across a pass that demonstrably ran the fallback — batching makes it the wrong instrument.
The shipped test wraps `readTaskLogEntriesBatch` itself (returned counts plus call count), which measures the
seam that actually makes the claim. A transaction/statement counter is only evidence when the pass cannot
possibly batch.

## Surfaces this touches

Gate: `gateLogFreeEnvelopeRows` + `announceWithheldHistory` in `packages/core/src/task-store/reads.ts`
(both log-free sites: `listTasksImpl`, `hydrateSearchTaskRows`). Rules: `taskLogEnvelopeProves`,
`sufficiencyProves`, `horizonFromServedWindows`, `taskLogHistoryReadBound`, `sideHoldsNamedTimestamps`,
`withholdReasonForGatedRow` in `packages/core/src/task-store/task-log-projections.ts`. Tests:
`packages/core/src/task-store/__tests__/task-log-recent-sufficiency.test.ts` and
`packages/core/src/__tests__/postgres/task-log-recent-sufficiency.pg.test.ts`. Census:
`scripts/census-log-recent-sufficiency.mjs`. Contract prose: `docs/storage.md` → "Derived task-log projection
columns"; the invariant bullet in `docs/architecture.md` → "List-loaded rows still carry `log` by default".
