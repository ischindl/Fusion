---
category: workflow-learnings
module: packages/core/src/workflows/default-workflow-hooks.ts
tags: [lifecycle, planning-failure, task-store, lane-crossings, stale-state, RUFU-228]
problem_type: state-invariant
applies_when: adding or auditing a lane crossing, or when a card shows a red error band after the failure already recovered
---

# A stale terminal planning failure survives the forward planning → WIP crossing

## Symptom

An operator saw one card as **two stacked cards** on the board (RUFU-225): the live WIP card plus a
red `.card-error` band quoting `PLANNING_FAILED_EXHAUSTED: specification failed 3 times …`. The card
had already recovered — plan review had passed (`verdict: APPROVE`) and the graph boundary had
advanced it `todo → in-progress` — yet it still rendered as failed.

The band is not a UI bug. `TaskCard.tsx` renders `.card-error` on `isFailed && task.error`, and
`isFailed` is `!isDoneColumn && task.status === "failed" && !hasPendingRecovery`. The band was a
faithful render of a **persisted row that still carried the failure it had already recovered from**.

## Root cause

The store had three transient-failure clear points and the forward crossing was none of them:

- **reopen → planning** (`applyResetOnEntryEffects`, triggered by `isReopenIntoPlanning`),
- **review entry** (`applyInReviewEnterEffects`),
- **Done entry** (`clearDoneTransientFieldsImpl`).

A card advanced from a planning lane **into the WIP lane** by a graph-owned boundary move hit none
of these, so triage's terminal park (`status: "failed"` + the exhausted error) persisted. Because
`task.error` is last-failure-wins transient state — RUFU-225's own error row was later overwritten
by an unrelated branch-conflict error — surviving a crossing is corruption, not history: the card
then displayed *someone else's* failure forever.

## The invariant

**The complete set of transient-failure (`status`/`error`) clear points is four lane crossings:
reopen → planning, review entry, Done, and forward planning → WIP** (`applyStalePlanningFailureClearEffects`).
Anything outside these four crossings must not clear.

The forward clear is gated to exactly its subject:

- forward crossing **from a planning-role lane** (intake/hold via `planningColumnsOf`) **into a
  WIP-role lane** (via `inRole(..., lifecycleColumnSets?.wip, ...)` — role, never a column literal;
  an empty resolved set is the answer and never falls back to the legacy `in-progress` name),
- only when `task.status === "failed"` (terminal — `needs-replan`/`planning`/null are
  planning-owned signals triage still reads),
- never under `preserveStatus: true` (plan-approval rebound and friends keep exact semantics),
- clears **only** `status` + `error`; triage/self-healing own `recoveryRetryCount`/`nextRecoveryAt`,
  pause fields, steps, and worktrees.

Placement: it rides the existing `reset-on-entry` `onEnter` adapter registration, because
`applyDefaultWorkflowMoveEffects`' `toRun` list resolves registered trait ids on **every** move —
role self-gating, not trait declaration, bounds it. This is the same mechanism `applyReopenFieldClears`
relies on to fire on moves where `reset-on-entry` is not declared.

## Why blanket-clearing on WIP entry was rejected

A card may legitimately be **in-progress while carrying the error its retry is about** (mid-retry
`in-progress` moves must preserve it), a `needs-replan` crossing is not a recovered failure, and
review-lane entry must retain the failure the merge gate blocks on. A blanket clear would erase live
failure signals to fix a stale-state display — the same trap as appeasing a flaky test: the cheapest
change that makes the symptom vanish is the one that destroys the signal.

## How to reproduce

Store seam (no engine needed), mirroring
`packages/core/src/__tests__/postgres/wip-entry-stale-planning-failure-clear.pg.test.ts`:

1. Create a task in `todo`; write `status: "failed"` + a `PLANNING_FAILED_EXHAUSTED: …` error.
2. `moveTask(id, "in-progress", { moveSource: "engine", lifecycleReason: "workflow-graph-node-column", workflowMoveSource: "workflow-graph", bypassGuards: true, preserveProgress: true })`.
3. Pre-fix: re-read shows `status === "failed"` and the error intact (red band persists).
   Post-fix: both cleared, `task:moved` provenance unaffected.

Pure in-memory equivalent: `packages/core/src/__tests__/default-workflow-hooks.test.ts`
("stale planning-failure clear …" describe). Render shape: the RUFU-228 describe in
`packages/dashboard/app/components/__tests__/TaskCard.test.tsx`.

## Sweep lesson

The behavior change owned one far-field assertion:
`packages/core/src/__tests__/reopen-semantics-by-role.test.ts` used a seeded `status: "failed"` as an
incidental "not a reopen" marker on a renamed-board `backlog → building` move. Update such markers to
the *new truth plus the real discriminator* — there, surviving `workflowStepResults`/`branch`/`summary`
is what actually proves the reopen effects did not fire; the failed status is now correctly cleared
by the forward clear.
