---
category: architecture
module: overlap-wait-synchronization
tags: [overlap, lifecycle-columns, scheduler, self-healing, vocabulary-degradation]
problem_type: logic_error
applies_when: A card stays `todo` with `status="queued"` and an `overlapBlockedBy` whose predecessor is already Done/merged, and every repair pass reports success while changing nothing — whether the predecessor's lane vocabulary cannot be resolved at all, or the predecessor rests in a second lane that also declares the `complete` trait.
---

# A released overlap wait freezes forever when the predecessor's lanes cannot be resolved

## Symptom and cause

A predecessor releases its overlap episode — the card's History records `Overlap wait released behind <id>`, the episode reaches `phase="ready"`, its receipt is acknowledged — and the victim is never picked up again. It sits in `todo` with `status="queued"`, still naming the finished predecessor in `overlapBlockedBy`, its stale `worktree` untouched. The automatic sweep runs against it every cycle and returns success. Nothing is logged as an error, so the row looks like a slow queue rather than a permanent loss. Measured live: three days, with two automatic re-queues and no operator touch.

The release is not the step that clears anything. `completeTaskOverlapWait` records that the predecessor let go; clearing `overlapBlockedBy` and the paired `status="queued"` belongs to `reconcileTaskOverlapWaits`, which asks one question per predecessor: *is that predecessor finished?*

That question was answered from a set built as `lanes?.complete ? [lanes.complete] : []`, where `lanes` came from `resolveTaskLifecycleColumns`. Empty then has **three** meanings and only one of them is the truth:

- the board declares lifecycle traits and names no complete lane — genuinely finished nowhere;
- the graph is column-less (`version: "v1"`) — `columnsOf` yields zero columns and resolution answers "no vocabulary";
- the board is the **synthesized** face `resolveLifecycleColumns` documents — a v1 graph upgraded to v2 whose columns carry `traits: []`, meaning "placement only".

In the last two, an empty set is not an answer about the board, it is the absence of one. So a card resting in `done` was never recognised as complete: no release reason, no episode cancel, no marker clear — **on every pass, silently**.

Meanwhile the scheduler asked the same question through a different authority. `classifyFileScopeLease` calls `isTerminalColumnRole(flags, column)`, which keeps the legacy `columnId === "done"` floor for exactly this degraded state (and `column-roles.ts` names that floor deliberately: "the degraded mode, named once … rather than an inline id comparison repeated per call site"). On an unresolvable vocabulary the two authorities split: the scheduler would not dispatch the waiter because the predecessor's lane was terminal, while the reconciler refused to release it because it could not tell which lane that was.

Both fields the release left behind are admission gates in `scheduler.ts` — `overlapBlockedBy` feeds `overlapBlockedTaskIds` and the claim-time re-check, `status="queued"` makes the card non-claimable — so the card was not merely mislabelled. It was permanently unclaimable.

## Fix

Fix the invariant where the answer is produced, not at the one call site that happened to hurt:

- `resolveTaskCompleteColumns(store, taskId, cache?, selectionCache?)` in `packages/core/src/workflows/workflow-lifecycle-traits.ts` returns the board's complete lanes **with** the floor: a board that declares lifecycle traits is answered honestly (**every** lane it marks complete — the empty set only when it names none); a trait-less, column-less, or unreadable board falls back to the legacy complete id. Semantics mirror the sibling `resolveTaskImplementationColumns`, which already documented that pair — "for consumers whose otherwise is a permanent hold rather than a visible failure."

  The first draft of that resolver returned `resolveLifecycleColumns(ir)?.complete ? [complete] : []`, and that was the same defect one layer down. `resolveLifecycleColumns` is **first-match-per-role** and `columnsWithFlag` documents why: a board may declare several lanes per role, so first-match is a placement answer. The release decision is a membership question — `completeColumns.has(blocker.column)` — and on a board with two complete lanes a predecessor resting in the second one produced no reason again, on every pass, silently. Membership now goes through `columnsWithFlag(ir, "complete")`. The rule to carry forward: **pick the reader by the shape of the question** — placement takes `resolveLifecycleColumns`, membership takes `columnsWithFlag`, and the two disagree exactly where a board declares a role more than once.
- `LEGACY_COMPLETE_COLUMN_ID` is exported from `packages/core/src/column-roles.ts` and consumed by that fallback, so the resolver floor and the role predicate's fallback are one greppable pair instead of two literals that can drift.
- `reconcileTaskOverlapWaits` now builds its `completeById` from the resolver. The release decision and the scheduler's lease classification can no longer disagree.

Fail-closed is preserved on purpose: the empty set survives for boards that genuinely declare traits without a complete lane, so a predecessor still mid-flight keeps holding the wait. The floor is not a global "assume done".

## Symptom verification and surfaces

`packages/core/src/__tests__/postgres/overlap-wait-clear-unresolved-vocabulary.pg.test.ts` seeds the frozen exemplar through the real seams — `transitionQueuedEpisode` for the marker and status stamp, `claimTaskOverlapWait` plus `completeTaskOverlapWait` with a delivery receipt for the `Overlap wait released behind …` history line — and asserts the invariant, not one repro:

- control: a board that resolves clears both fields;
- trait-less board: **red before the fix** (`clearedBlockerIds: []`, sweep returned `0`), green after;
- the automatic `reconcileReleasedOverlapWaits` sweep clears the card with no operator repair of the frozen row;
- a `reset` predecessor on an unresolvable board still clears both, so a future "always fall back" shortcut cannot quietly replace the reset/deleted dispositions;
- fail-closed pairing: an unresolved vocabulary must not release a predecessor still in `in-progress` (this case is also red under a naive blanket fallback);
- differential renamed lane: with the complete column named `shipped`, only reading the vocabulary clears — proving the floor is not a bare `"done"` literal;
- second complete lane: the board declares `done` **and** `shipped-secondary`, and the predecessor rests in the second one — **red under first-match** (`clearedBlockerIds: []`), green under membership;
- a soft-deleted predecessor on an unresolvable board clears, so the non-complete dispositions survive even where no lane can be named.

Ownership of the two reporting/plan faces the freeze also degraded, stated rather than duplicated here: backlog-pressure candidate membership is pinned in `packages/engine/src/__tests__/backlog-pressure-reporter.test.ts`, which now carries both halves — a row carrying `overlapBlockedBy` + `status="queued"` is excluded from candidates, and clearing **both** fields returns the same id to the set (a repair clearing only one half stays red there); planner claim admission and plan-admission stall retraction read `overlapBlockedBy` alone, and that gate is `RUFU-330`/`RUFU-273` owned, so nothing is restated in this file.

Surfaces checked: `overlapPredecessorRelease` reasons (`complete`, `reset`, `deleted`, `missing`), the store reconcile and the engine sweep entry points, the scheduler's terminal predicate as the authority being aligned to, and every other `?.complete` reader — the remaining consumers already floor with `?? "done"` at move-target sites, so this seam was the sole outlier. `RUFU-330` owns `scheduler-overlap-starvation.test.ts` and `file-scope-continuation-wait.test.ts`; admission on the scheduler side is not duplicated here.

## Manual repair is not the fix

The live exemplar (`RUFU-254`) was deliberately left untouched. Patching its row by hand would have replaced a real bug with a one-card workaround and left the next release on a degraded board frozen the same way.

As of delivery, `RUFU-254` is **no longer on the board** (`fn_task_show` → not found, no `.fusion/tasks/RUFU-254/task.json` mirror), so that criterion can no longer be demonstrated on the original row — stated plainly rather than claimed about a card that is gone (review finding F2).

What the repair does guarantee, and what the criterion reduces to, is the seam the exemplar was on: the automatic `reconcileReleasedOverlapWaits` pass clears a frozen row with **no operator touch** — asserted directly in the pg matrix, with the exemplar's exact field shape (`overlapBlockedBy` + `status="queued"` + a released episode) seeded through the real seams. Any future victim on a degraded board, in any complete lane, is released by that same pass.

See the sibling note [`overlap-wait-abandoned-predecessor-recovery.md`](overlap-wait-abandoned-predecessor-recovery.md) for the complementary case — a predecessor whose execution was abandoned before it delivered anything. That one asks *what must this wait still be paid with*; this one asks *how does the reconciler know the wait may be paid at all*.

### Pre-existing failures observed at baseline

These were verified red at the base commit with the changed files reverted, and are unrelated to this change: `store-overlap-repair-lanes-resolved.test.ts` (5 failed — the same five `repairOverlapBlocker` dormant-holder cases fail with the working tree stashed), `self-healing-overlap-release-wake.test.ts` (1 failed: `clearStaleBlockedBy does not wake anything while the overlap blocker is preserved`, also red stashed), `file-scope-continuation-wait.test.ts` (3 failed, `RUFU-330`'s owned bundle), `self-healing.test.ts` (60 failed — the failing test set is byte-identical with and without this change), plus the `check:line-count` and `check:move-target-literals` static budgets (neither names a file this change touches).
