---
category: workflow-learnings
module: packages/engine/src/triage.ts
tags: [planning, stuck-detector, throttle, retry, pause-release, RUFU-562]
problem_type: logic
applies_when: changing a stuck-kill/requeue path, a planning draft reader, or a pause-reason allow-list, or when a card is parked with STUCK_LOOP_EXHAUSTED
---

# A stuck kill re-queued an unplanned seed as a "resumable draft", and nothing could release the park

## Symptom

21 cards across 5 projects sat in `todo` carrying
`STUCK_LOOP_EXHAUSTED: triage stuck detector killed <ID> 6/6 times without planning completion; task paused
for manual intervention.` Eight appeared in the last 24 hours. The message named no remedy, and no sweep
claimed the shape, so "manual intervention" was the whole story — with no description of what to press.

The throughput cost was larger than the 21 rows. `maxConcurrent=2` is the planning admission cap, and the log
shows a *doomed* card holding one of the two slots for the whole ~61-minute inactivity window while an
eligible sibling waited (`Plan throttled by running-agent cap: eligible=1 [AIWO-148], maxConcurrent=2,
claimed=2, processing=2`). Each stuck card halved planning admission for its project for the length of its own
kill loop.

## The mechanism: two lanes answering two different questions about one artifact

From the production log for `AIWO-150`, in order, in the same pass:

1. `[plan] Plan throttled by running-agent cap …` — the card was idle *because* it was throttled, while still
   holding a planning slot.
2. `[stuck-detector] Killing stuck task AIWO-150 (reason=inactivity, no progress for ~53min …)` — the detector
   read throttle-induced silence as a stuck session.
3. `[plan] AIWO-150 planning recovery skipped — PROMPT.md is still an unplanned seed` — recovery refused to act,
   because its precondition is a *plan* and the artifact was the stub written at creation.
4. `[plan] AIWO-150 killed by stuck detector — requeueing to resume existing PROMPT.md draft (5/6)` — the
   requeue lane asserted the exact opposite.
5. Nothing changed on disk, the card fell silent again, and 2–4 repeated until 6/6 was spent.

The contradiction was not a race. `recoverPlannedTaskFromInterruptedPlanning` asks
`isUnplannedSeedPrompt(...)` — the canonical predicate. `handleStuckAbortRequeue` asked a different, weaker
question of its own: "is the draft file non-empty?" A bootstrap seed is non-empty, so the two lanes disagreed
**deterministically**, and each lane's remedy was the other lane's precondition.

## The fix

One question, one answer. The seed guard went into the single raw draft reader
(`readNonEmptyPromptDraft` in `packages/engine/src/triage.ts`), which calls `isUnplannedSeedPrompt` with the
card's own `id`, `title`, and `description`. A seed-shaped artifact now reads as `undefined`, so the
draft branch becomes unreachable for it and the kill falls through to the cold-retry tail that was always the
correct disposition: budget advanced, status returned to planning-pending, no revision framing, no
resume-existing-draft log line. Three consequences follow mechanically:

- `resolvePlanningRetryHoldStatus` stays correct, because it already treated a seed as awaiting planning.
- The stale stuck-resume log entry can no longer force revision mode, because the consumer keys revision
  framing on the *existing draft*, which is now `undefined`.
- The log line matches the storage state the branch actually writes.

Plus the two halves that make the loop unenterable rather than merely narrower: a killed card arms an
**in-process re-admission cooldown**, so it cannot hand the planning slot straight back to itself; and the
terminal park **names its remedy and can be released by Retry**, so a card that does reach 6/6 is one click
from recovery instead of permanently inadmissible.

## Why the cooldown is in-process, and not a durable `nextRecoveryAt` write

`computeRecoveryDecision`'s durable backoff was the obvious reusable shape and it is wrong here. A future
`nextRecoveryAt` is read as "the recovery lane owns this card" by more than its own scheduler:

- the planning-admission-stall derivation (`packages/engine/src/planning-admission-stall.ts`) treats a future
  recovery-at as recovery-owned and stops naming the card as a planning-admission stall;
- two guards in `packages/engine/src/self-healing.ts` skip their repairs while it is set.

So a planning-scoped throttle would leak into unrelated recovery lanes, and nothing clears the timestamp when
planning succeeds — a card would carry a phantom recovery owner for as long as its plan took to land. The
precedent that fits is the principal-hold admission cooldown: process-local, consulted in `couldBeCandidate`
exactly where that probe already sits (so both eligible filters inherit it), pure backoff function of the kill
count, injectable clock, no timers, no durable write. A restart losing the cooldown is acceptable; a durable
write that outlives its own meaning is not.

## The clear-point rule this fix follows

A park must name the action that releases it, at the seam the operator actually pulls. The stuck-loop park set
`status: "failed"`, so every retry surface already *accepted* the card and already zeroed `stuckKillCount`
through `MANUAL_RETRY_RESET_COUNTER_KEYS` — yet the surfaces whose pause lift comes from
`buildAutoPauseClearPatch` (CLI retry, pi retry tool, the dashboard route's legacy branch) left
`paused: true` in place, and `couldBeCandidate` refuses a paused card outright. **The Retry reset the budget and
reported success while the card stayed permanently inadmissible.** The dashboard's in-place column restart was
the one shape that escaped, because its publication fence clears the pause fields wholesale through
`pauseTask(id, false)` — and that fence owns no allow-list, which is precisely why a list-owning guard must
never be the only door.

The lesson generalises: when you add an engine-authored park, add its pause reason to the retry pause-clear
allow-list in the same change, gated on `userPaused !== true`, and promote the reason literal to a shared
constant so the park site, the allow-list, and the operator notice cannot drift apart. "Failed is retryable"
is not the same statement as "paused is releasable"; they are checked by different code and only one of them
was updated.

## What this shape is *not*

Four neighbouring recovery lanes were read and confirmed not to claim this card, and this fix deliberately adds
no fifth parked shape that would need a sweep: FN-8592 `reconcile-stranded-hold-continuation` needs a real
spec, FN-8923 `reconcile-principal-held-planning` needs an active held triage continuation, RUFU-288
`reconcile-planning-fence-parks` keys on `PLANNING_FENCE_UNAVAILABLE`, and FN-8356 / the RUFU-297 sweeps speak
different pause-reason vocabularies. No new run-audit event was needed either: the running-agent cap remains
the only binding planning-throttle gate (FN-8600), and this change adds no lifecycle move to report.

## Related

- `docs/architecture.md` → "A seed is not a draft" in the stuck-session recovery contract.
- `docs/solutions/workflow-learnings/stale-terminal-planning-failure-survives-wip-entry.md` — the
  clear-point / lane-crossing discipline this fix follows.
- `packages/engine/src/__tests__/triage.test.ts` → the `RUFU-562` describe blocks (draft classification,
  seed cold-retry, cooldown admission boundary, stale-feedback refusal).
- `packages/core/src/__tests__/manual-retry-reset.test.ts`, `packages/cli/src/__tests__/task-retry.test.ts`,
  `packages/dashboard/src/__tests__/routes-task-retry-planning-column.test.ts` — the park release per surface.
