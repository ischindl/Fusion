---
title: "An anti-spam cap kept in a Map is not a cap: three ordinary events lowered it and one card took 77 copies of one instruction"
date: 2026-11-11
category: reliability
problem_type: reliability
module: "@fusion/engine / @fusion/core"
component: planner overseer / recovery controller / task metadata
tags:
  - planner-oversight
  - steering-comment
  - attempt-budget
  - durable-episode
  - run-audit
  - in-memory-state
  - rufu-259
  - rufu-286
  - rufu-533
  - rufu-547
  - rufu-7577
symptoms:
  - "`fn task comments <id>` shows dozens of byte-identical `[planner-oversight] Stage \"executor\" signal \"stuck\" — injecting steering guidance` lines"
  - "the documented cap of 3 attempts per (task, stage) is exceeded by more than an order of magnitude while the code that declares the cap is unchanged"
  - "the duplicates arrive every 40-90 s at a 45 s poll cadence, i.e. roughly every other tick, for ~20 h"
applies_when: "adding any cap, budget, or cooldown to a lane that is driven by a repeating poll, or reading why a declared attempt limit did not hold"
resolution_type: "moved the budget from process memory to a durable per-reason episode on the card and placed the gate before the dispatch decision"
---

## Symptom

One card (`RUFU-286`) accumulated **77 identical steering comments in ~20 hours** at a
45-second overseer poll cadence, against a documented cap of 3 (`PLANNER_RECOVERY_MAX_ATTEMPTS`).
The first was `1790769420033-cacxye`, the last `1790838739628-6l5zln`, spaced 40-90 s apart. Two
other cards in the same window showed exactly 3 each, so the cap was not globally broken - it was
unreachable for one particular shape of card.

Each duplicate was not free: `addSteeringCommentImpl` writes the unified `comments` array AND
`steeringComments`, and `steeringComments` is what the executor's real-time injection listener
watches. So every duplicate re-entered the prompt of an agent that already held that instruction,
besides rewriting both arrays plus the `search_vector` GIN entries, adding an
intervention-timeline entry and a History line, and consuming log capacity (1 000 rows, overflow
evicted - which is what deleted the earliest evidence of the flood itself).

## Root cause: the cap was a count in a `Map`, and three ordinary events lowered it

`PlannerRecoveryController` kept attempts in `private readonly attempts = new Map<string, number>()`.
A cap that can go back down is not a cap. Three things lowered it, all of them normal production
behaviour, none of them a bug in itself:

1. **A healthy signal deletes the key.** `if (signal === "progressing" || signal === "complete" ||
   signal === "awaiting-human") { this.attempts.delete(key); }`. This is FN-7577 and it is
   *correct* - the card's overseer badge derives from `attemptCount > 0`, so a recovered card must
   stop showing an engagement badge. But it means a card whose signal oscillates never accumulates
   three attempts against one reason.
2. **The key contains the stage**: `attemptKey(task.id, snapshot.stage)`, so a watched-stage change
   starts a fresh budget.
3. **A process restart empties the whole Map** - RUFU-547's general lesson that an in-memory set is
   dead after a restart.

The two guards added after this class was first reported both key on **byte-identical text** and are
both in-process: `PLANNER_OVERSIGHT_GUIDANCE_DEDUPE_MS` (a 30-minute in-memory window) and the
newest-entry equality refusal in `addSteeringCommentImpl`. They absorb the homogeneous case only.
`reasonForSignal` renders `Signal: \`stuck\`` and `Signal: \`blocked\`` for the same underlying stall,
so a card alternating between them produced text that neither guard recognised as a repeat.

Measured against today's `main` in a real `TaskStore` (`planner-overseer-intervention-wiring.test.ts`,
"reproduction: on a flapping card, 18 ticks reach the steering writer 12 times"): 18 ticks, 12
problem ticks, **12 writer calls**. Not "the cap was exceeded" - the cap was never reachable, because
the healthy tick before every problem tick deleted the key.

The three candidate causes were separated rather than assumed, because the production data could not
separate them (the measured stream was homogeneous in stage, which argues against the stage-flip
hypothesis, and an engine does not restart every 45 s, which argues against restart for the *cadence*):
each path now has its own isolated regression test, and the flap path is the one that reproduces the
measured cadence from a cold in-memory count.

## Why the fix is not a rate limit on the comment

Three placements were rejected before this one was chosen:

- **Inside `addSteeringComment`.** Wrong place. RUFU-533's lesson is that a cap enforced *inside* an
  atomic write is skipped precisely when that write fails, and a writer that has already been handed
  the instruction is the last party able to refuse it honestly. The fix belongs where the budget is
  reset, not where the text is written.
- **Inside the atomic write of the episode.** Same defect inverted - it couples posting to recording.
  Here `recordDelivery` runs *after* the handler resolves, so a store failure does not consume an
  allowance for a post that never happened, and the cost of that ordering is one extra comment, not 74.
- **A single "current reason" slot.** Measured worse than useless: a card flapping `stuck`/`blocked`
  flips one slot every tick, so every tick looks like a brand-new reason - 24 posts in 24 ticks.
  The budget is therefore keyed **per reason signature**, with other signatures kept alive in an
  LRU-capped `prior` list.

## The seam that holds

| Piece | Location | Role |
|---|---|---|
| Pure arithmetic | `packages/core/src/planner/planner-steering-episode.ts` | `deriveSteeringSignature`, `evaluatePlannerSteeringEpisode`, `applyPlannerSteeringDelivery`. No store, no clock, no I/O, never throws. |
| I/O and the notice | `packages/engine/src/overseer/planner-steering-ledger.ts` | `TaskStorePlannerSteeringLedger`: reads through `store.getTask`, writes through `updateTaskAtomic` at key level, owns the one-shot timeline notice. |
| The gate | `PlannerRecoveryController.tick()` | `evaluate` runs **before** `dispatch()` for `inject_guidance` and `request_targeted_fix` only, and every ledger call is wrapped so a broken budget degrades to "deliver" instead of deciding the tick. |
| Durable record | `task.sourceMetadata.plannerOversightSteering` | digest, count, ISO instants - never the instruction's prose. |

The gate returns `{ ...decision, steeringDeduped: true }` on refusal and the handler is never called,
so no comment, no timeline row, and no attempt charge is made. A refusal writes no lifecycle field:
suppressing a duplicate is not evidence the card recovered, so it must not clear `status`, write
`error`, move a column, or fabricate a gate result - that would let duplicate-suppression erase the
badge telling an operator a planner is engaged.

**The signature is the whole design.** `sha256(action | stage | reasonClass)` where `reasonClass`
collapses whitespace and replaces every **digit run** with one `N`. Reasons interpolate elapsed time
("inactive for over 3h", "41m elapsed"), and RUFU-442's measured failure was exactly "a bound whose
key changed each cycle" - a signature that churned with the clock would restart its budget every
tick and the fix would be a no-op. Digit *runs* collapse to a single `N` so that 9h to 10h does not
change the key either. A genuine reason change (`stuck` to `blocked`, or a stage change) still
re-arms, which is what keeps real help reaching the agent.

## Non-obvious decisions an operator should know

- **`retry_step` and confirmations consult no budget.** `retryStep` already has its own dedupe
  (`plannerLiveRetrySkipLogDedup`) and a live-session skip; `requestConfirmation` is idempotent per
  `(taskId, stage)` via `pendingConfirmations`. Guarding them again would spend the steering
  allowance on paths that post no instruction.
- **An operator Retry deliberately does not clear the episode.** Four other episodes are cleared by
  `buildManualRetryResetPatch`, and each is cleared because leaving it would make the Retry a no-op -
  their owner re-reads the surviving count and re-authors the same park. This episode parks nothing,
  so a Retry is fully effective while it stands, and a rate limit unlike a park has a self-clearing
  clock (at most 6 h). A Retry that re-armed steering is how a retry loop becomes a flood again.
  The first two drafts of this code claimed the opposite in comments; measurement corrected it.
- **`clear()` and oversight level `"off"` do not clear it either.** It is an anti-spam record, not
  engagement state, and `clear()` is called by the poll sweep every time a task leaves the in-flight
  set - clearing there would reopen the flood on the next re-entry.
- **A refusal still speaks once.** One `overseer:intervention` row (`outcome: "skipped"`) and one
  History line per exhausted instruction, stamped by `noticeRecordedAt` inside the same
  advisory-locked write so two racing overseers cannot both announce. Never one per suppressed tick,
  never zero: the card must answer "why did the overseer stop talking?". The row's action follows the
  refused producer (`inject-guidance`, or `request-fix` for a targeted fix) and its attempt badge
  carries the spent budget, so the timeline says which of the two producers ran dry.
- **The slot rule has ONE owner.** An exhausted instruction can sit in the episode's active slot or in
  its `prior` list, and only the active slot carries the notice stamp, so stamping a refusal has to
  promote the refused entry and re-derive the survivors. `withPlannerSteeringNotice` owns that
  arithmetic and the engine ledger passes the signature it is announcing instead of recomputing the
  survivor list - the first draft kept a second copy of the rule in the ledger under a comment saying
  the two must agree, which is drift waiting to happen.
- **Fail-open is the only degradation, and it is wrapped at the caller seam.** Each ledger call
  (`evaluate`, `recordDelivery`, `recordSuppression`) is wrapped inside `PlannerRecoveryController.tick()`,
  not only inside the ledger. `tick`'s single outer catch turns any escaped throw into a `null` return,
  which reads as "no decision was computed" rather than "the budget was unavailable, delivering anyway",
  so a budget that throws outright must not reach it. The ledger absorbs its own store faults one level
  down; the caller-side wrap is what makes fail-open a property of the seam rather than of one
  implementation, and the `warn` it writes is the only trace, because a fail-open delivery deliberately
  leaves no row. Absence of the record is never read as "already delivered". An absent ledger makes
  the whole path byte-identical to the pre-fix behaviour, which is why no existing unit test needed
  rewriting.

## Measured correction to the task's own premise

The spec priced every duplicate at an RUFU-259 inbox delivery and a wake of the assignee. That is
not what the code does: `deliverTaskCommentFromStore` is reached from the CLI, the dashboard routes,
and Planner Chat - the human comment/steering write paths - and **never** from
`addSteeringCommentImpl`, which is what the overseer uses. The real per-duplicate cost is two durable
array rows (one of them re-entering the executor's prompt), a `task:updated` broadcast, and a History
line. The test asserts the corrected fact - zero delivery rows for a delivered tick and zero for a
refused one - rather than a delivery-ratio assertion that would have been vacuously false.

## Tests that pin it

`packages/engine/src/__tests__/planner-overseer-intervention-wiring.test.ts` (real `TaskStore`):
reproduction at 12 writer calls; the fix bound; survival across a fresh controller **and** a fresh
ledger; a healthy-signal flap that cannot refill a spent budget *while asserting the in-memory count
is zero* (the assertion that names the cause rather than the fix); `clear()`; a genuinely different
instruction still delivered, with the new budget reading `deliveredCount === 1`; once-only
self-explanation; the silent-refusal lifecycle guarantee; both durable arrays bounded; the corrected
per-duplicate cost; two overseers on one store sharing one allowance; and the SECOND producer
(`request_targeted_fix`) bounded across fresh controllers even though every wave posts a distinct
comment string, with its notice filed under `request-fix`.
`packages/core/src/__tests__/planner-steering-episode.test.ts` covers the pure arithmetic including
the hourly-churn signature stability, the corrupt-input fail-open, and the notice-promotion rule (a
refusal against a `prior` budget promotes it without duplicating or dropping the survivor).
`packages/engine/src/__tests__/planner-recovery-controller.test.ts` pins the gate POSITION (the ledger
answers before any handler runs), that BOTH steering producers are refused by a spent budget, that a
refusal charges no attempt, and that each ledger call failing degrades only its own bookkeeping - the
gate delivers anyway with one `warn`, and a failed `recordDelivery` never un-books a comment the agent
already received.
