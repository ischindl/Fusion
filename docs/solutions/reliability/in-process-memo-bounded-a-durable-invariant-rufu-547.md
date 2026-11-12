---
title: "An in-process memo bounded a durable invariant, so a stuck card rewrote its own history forever"
date: 2026-11-12
category: reliability
problem_type: reliability
module: "@fusion/engine, @fusion/core"
component: self-healing / stranded workflow continuation reclaim
tags:
  - self-healing
  - task-history
  - log-bloat
  - durable-episode
  - source-metadata
  - process-local-state
  - deferral-ladder
symptoms:
  - "the newest N lines of a card's History are byte-identical `[recovery]` lines, minutes apart"
  - "a card that has not moved in weeks carries hundreds of one recovery sentence (measured: 877 and 866 lines on two cards, 5,765 lines across 162)"
  - "the same two identical lines land three seconds apart, which one shared `Set` cannot produce"
  - "a documented re-check ladder (30 min, then 2 h, then 6 h) never widens past its first rung"
  - "the cadence looks like the pass interval, not like the ladder"
affected:
  - "packages/engine/src/self-healing.ts"
  - "packages/engine/src/workflows/stranded-continuation-reclaim.ts"
  - "packages/core/src/types/task/task-core.ts"
  - "packages/core/src/tasks/manual-retry-reset.ts"
---

# An in-process memo bounded a durable invariant (RUFU-547)

## The shape, in one sentence

A sweep documented "one note per condition, not one per pass" plus a widening re-check ladder, and bounded both with state that could not survive the very churn the sweep performs: a `private readonly Set<string>` for the note, and a column on the row the sweep itself zeroes for the ladder width.

## How to tell this class from a normal repeat-log bug

Two measurements separate it, and both are cheap:

1. **Identical lines seconds apart.** One `Set` shared by one process cannot produce two identical announces three seconds apart. That reading means there is more than one memo holder (two managers, or a boot pass plus a maintenance pass on a freshly constructed manager), so the bound is process-local. Engine uptime, not wedge age, sets the cadence.
2. **The cadence equals the first rung, forever.** If the ladder's width is read off a value the same code path re-writes (`retryAfter` nulled by the re-queue, or a replacement `INSERT` that omits the column), the prior width arrives as `NaN` and the ladder returns rung 0 on every pass. A ladder that never widens is the signature of a width carried on a row the loop re-creates.

Read the row-derived width before touching the memo. A `NaN` there is the second hole, and it survives a durable memo.

## The fix pattern, and the two identity splits that make it work

Move the ledger to the identity that survives the churn. Here that is the task row's `sourceMetadata`, written through the key-preserving `sourceMetadataPatch` channel so unrelated provenance keys survive. Three splits carry the design:

- **Carrier vs. gate.** `retryAfter` stays the only due gate, because every reader honours it. It is evidence and cadence, never memory. The memory (which conditions already spoke, how wide the ladder climbed) goes on the card.
- **Wedge vs. condition.** The wedge is `(taskId, nodeId)`: it owns the monotonic ladder. The condition is the `(taskId, nodeId, state, blockedReason)` signature: it owns one announce. A `blockedReason` vocabulary flip is one wait wearing a second condition key, so a new condition on a known wedge earns exactly one honest line and must never buy a reset to rung 0. Collapsing these two either re-announces forever or silences genuinely new information.
- **Memo vs. floor.** Keep the in-process `Set` as a strictly additive second source: `alreadyAnnounced = set.has(key) || durableHasCondition`. It can suppress more than the durable episode, never less, so a failed episode write degrades to the old behavior instead of to permanent silence or a flood.

Bound the silence with a re-arm, not forever: a still-stuck wedge gets one more line per 24 h, so the operator keeps a heartbeat and the count stays bounded.

## What must stay unsuppressed

A bound on noise is not a licence to park a card. Three rules kept this from becoming a freeze:

- A wait another seam owns (principal routing, human-merge approval, a live `file-scope:*` blocker, RUFU-285's `converge`) writes **nothing at all** - no `retryAfter` and no episode, because stamping the due gate hides the row from the only writers allowed to release it.
- A genuine reclaim still clears `retryAfter` exactly as before. A deferral is a cadence control, never a visibility control.
- An operator Retry must clear the new key in the same patch that clears its siblings, or the one human remedy for "look at this again now" silently stops working. `buildManualRetryResetPatch` asserts an exact object in its test, so the compiler-free way to miss this is a green build.

## Bookkeeping must never cost a recovery its evidence

The episode write runs after the guarded row transition, never inside it. That cuts both ways, and this task's own fix proves the second direction: a reveal that cleared its episode with `updateTaskAtomic(...).catch(...)` survived a rejecting store but not a store that carries no such method. The synchronous throw landed in the per-item catch and the reveal - which had genuinely happened - lost its event row and its card line. Guard a duck-typed store method with `typeof === "function"` plus `try`, and pick the cheap degradation: losing a ledger costs the next episode its cadence, losing a reveal record costs this reveal the only surfaces an operator can read.

## Test-side traps

- A fake store that echoes its inputs passes every pre-fix test. The harness must apply patches to stateful rows, honor a compare-and-set by returning the row as the other writer left it, and merge `sourceMetadataPatch` at KEY level - otherwise a whole-object overwrite of the episode carrier looks correct.
- Model a restart as a NEW manager instance, or you are testing a `Set` you chose to keep.
- Falsify the guard before trusting it: remove the product guard, watch the new case fail with the exact assertion message, restore it. A bound test that passes on pre-fix code documents nothing.
- Drive the row-replacement shape between passes (new `id`, new `runId`, `retryAfter: null`), because that is what the re-holding seam does and it is the half that made the width `NaN`.
