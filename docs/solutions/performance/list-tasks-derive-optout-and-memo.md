---
category: performance
module: packages/core/src/task-store/reads.ts
date: 2026-09-08
problem_type: performance
severity: high
applies_when:
  - "A heap profile attributes tens or hundreds of MB to `listTasksImpl` over a few minutes"
  - "An engine timer (triage poll, scheduler tick, gridlock sweep, lane-role sweep) re-reads the whole board every few seconds"
  - "`task_workflow_selection` or `workflow_prompt_overrides` dominate `pg_stat_activity` even though the overrides table is empty"
  - "A startup/slim list memo returns correct data but costs a full deep clone on every hit"
component: task-store
tags:
  - performance
  - listtasks
  - derive-optout
  - memo
  - gc-churn
  - board-parity
  - listtasksderiveoptout
related_components:
  - task_store
  - engine_scheduler
  - engine_triage
  - engine_gridlock
  - engine_project_engine
---

# `listTasks` derive opt-out and the shared startup memo (RUFU-201)

## Symptom

A 240 s heap profile on a live 22-project instance attributed **281.9 MB of 592.9 MB live allocations**
to `listTasksImpl` — roughly 15% of all CPU, with **~19% of CPU inside the GC**. CPU was dominated by
work that no user could see: for every one of ~1313 rows, the read parsed ~30 jsonb columns *and*
computed nine-plus UI-only board signals, and the startup memo deep-cloned the entire array on every
hit via `JSON.parse(JSON.stringify(...))`. The memo's 2.5 s TTL was shorter than the ≥10 s intervals of
the timers that were paying for it, so those callers paid the derivation cost, then paid the clone
cost, and still never got a memo hit.

The same profile showed the two tables only the derivation block touches: `task_workflow_selection` at
**31.8%** and `workflow_prompt_overrides` at **41.7%** of all in-flight statements — and the overrides
table was **empty**. Every engine tick was querying a table with no rows in it to derive a badge nobody
read.

## Root cause

`listTasks` was written for the dashboard board feed, which renders badges, and it grew one derived
signal after another onto that path (10 in total today). Engine timers were calling the same function
— some of them with `slim: true`, which does **not** skip derivation — because it was the only board
read available. The derivation is the only producer of the selection/overrides reads, so the query load
was pure UI-signal work executed on headless paths.

## The three levers

1. **`derive: false` opt-out** (`ListTasksOptions`, `packages/core/src/task-store/reads.ts`). Skips the
   per-row derivation block *and* its pass-level feeders (settings read, merge-queue set, IR cache,
   selection prefetch, page-local column map). Keeps the SQL fetch, row parsing, the slim
   steps-from-PROMPT.md sync, and the `log: []` output shape. **Omitted means `true`** — the opt-out is
   always caller-opt-in, because the board feed must keep every badge it renders today.
2. **Frozen, shared memo entries.** A memo hit hands out the same frozen array and the same frozen row
   objects instead of deep-cloning. A hit performs zero per-task allocation. Callers that need to mutate
   copy locally — the freeze is deliberate and must not be weakened to satisfy a mutating caller.
3. **Mutation invalidation.** A task lifecycle event or a `task.json` write clears the memo, so
   correctness does not depend on the TTL alone.

## The `derive: false` field contract

An opted-out row carries **none** of these fields — not even as an own property with an `undefined`
value, so a consumer can never mistake "derived and found nothing" for "never derived":

`inReviewStall`, `stalePausedReview`, `inReviewStalled`, `stalePausedTodo`, `ageStaleness`,
`stalledReview`, `retrySummary`, `stallReason`, `reviewBypass`, `timedExecutionMs`.

`column` itself is a **persisted** field and stays present, which is why engine sweeps are safe to
convert. Review/WIP/Hold *lanes* on a custom board are lifecycle-resolved, not persisted; a converted
caller must not take a lane from a row field but resolve it by id with `resolveTaskLifecycleColumns`
(the engine sweeps that already do this are exactly the ones converted here).

## Memo semantics and the staleness ceiling

`TaskStore.STARTUP_SLIM_LIST_MEMO_TTL_MS` is **15 s**. Within one process, a mutation invalidates the
memo immediately, so the TTL is the fallback rather than the primary bound, and it takes two seams to
cover every mutation: the store's own `task:created` / `task:updated` / `task:deleted` listeners, plus
the unconditional invalidation inside `writeTaskJsonFileImpl` that every `task.json` write passes
through. The second seam is what covers `moveTask`, because a move emits `task:moved` — an event the
memo does not listen to — so the artifact write is the invalidator there (the complete-lane move arm
emits `task:updated` as well; a same-column handoff changes no row field and needs no invalidator).

The memo key carries every dimension that changes the **result shape** — archive scope (`all`/`active`),
column filter, `columns`, `excludeColumns`, `sort`, derived vs raw (`derive`), and live vs forensic
(`includeDeleted` → `live`/`deleted`). A snapshot is never handed to a caller whose requested shape
differs from the one that filled the entry. Soft deletion stamps the historical `archived` sentinel
column, so an `active`-scope read already hides tombstones through the column filter; the reads where
`includeDeleted` genuinely changes the payload are `includeArchived: true` ones (admin/forensic
surfaces, e.g. `?includeDeleted=true`), where only the live-row filter separates the two. Sharing one
entry across that pair would hand a board read a tombstone-bearing snapshot, or starve a forensic read
of the rows it asked for, for up to one TTL. Both fill orders are pinned by
`packages/core/src/__tests__/postgres/list-tasks-derive-optout.pg.test.ts`.

**Across processes there are no events** — a second engine/dashboard process writing the same database
can leave this process serving a snapshot up to 15 s stale. That is the accepted trade-off: every
converted caller is a timer that already tolerates a one-tick-old board, and the alternative (a shorter
TTL) reintroduces the miss storm that made the memo useless. A converted caller that cannot tolerate
15 s of staleness must pass `startupMemo: false` and keep its own fresh read.

`startupMemo: false` remains deliberate on the scheduler's two tick reads for exactly that cross-process
reason — not because in-process mutations can go unseen. They cannot: `updateTask` clears the memo through
the `task:updated` listener, and `moveTask` clears it through the `task.json` write seam; both arms are
pinned by tests. What no in-process mechanism can observe is a write from **another** process, and this
tick read gates `todo → in-progress` graduation, where a card a peer process already moved would mean a
double dispatch. That read therefore keeps its guaranteed-fresh read instead of inheriting the ceiling.

## Converted call sites and their field-read audit

Every conversion names the fields its consumers read inside its own `FNXC:ListTasksDeriveOptOut` comment.
The rule for accepting a conversion: no field any consumer reads may be one of the ten derived signals.

| Site | Consumers read | Note |
| --- | --- | --- |
| `triage.ts` admission-provider refresh | id, column, status, paused/userPaused, priority, dependencies | planning admission |
| `triage.ts` per-column sweep | id, column, status, priority, createdAt | planning sweep |
| `triage.ts` poll/discovery read | id, column, status, paused, dependencies | `discoverReadyPlanningTasks` |
| `scheduler.ts` both tick reads | id, column, status, paused, priority, dependencies | `startupMemo: false` retained: the graduation gate will not inherit the cross-process ceiling described above |
| `healing/gridlock-detector.ts` sweep | id, column, paused, nextRecoveryAt, sliceId, worktree, workspaceWorktrees, dependencies, deletedAt, noCommitsExpected, sourceMetadata, priority, createdAt | settings come from the sweep's own `getSettings()` call, so the derivation block's internal fast read is not needed |
| `project-engine.ts` `listTasksInLaneRoles` | id, column, status, paused, prInfo, reviewState, steps, workflowStepResults, enabledWorkflowSteps, mergeRetries, mergeDetails, log, autoMerge(+provenance), branchContext, repositoryScope, updatedAt | stays **non-slim**: `canMergeTask` → `hasAutoHealableVerificationBufferFailure` reads `task.log`, and slim sets `log: []` |

The gridlock sweep additionally resolved every card's lifecycle **twice per pass** (once per
classification loop). Each uncached resolution re-issued a live workflow-selection read and re-ran
non-memoized column resolution, so a pass of N cards cost 2N of them. Both loops now share one eagerly
built, id-keyed map — which also removed a way for the two loops to disagree when a selection write
landed between them.

## Verification

`packages/core/src/__tests__/postgres/list-tasks-derive-optout.pg.test.ts` pins the contract against a
seeded PostgreSQL store: zero derivation-boundary calls and zero selection reads under
`derive: false`, non-zero and unchanged under the default options, reference-identical frozen rows on a
memo hit that additionally issues zero further derivation reads, and memo invalidation inside the TTL by
both arms — the `task:updated` event and a lane move — so neither the TTL nor a single invalidation seam
is load-bearing on its own. The tests assert state changes within the TTL window and never sleep or
poll, so the whole file runs in seconds.

Local run (the harness needs a PostgreSQL it may create databases in — the dev box's `localhost:5432`
role is `admin-ddl-denied`, so use the dedicated test server):

```bash
export FUSION_PG_TEST_URL_BASE=postgresql://localhost:25432
pnpm pg:test:up -- --port 25432
pnpm --filter @fusion/core exec vitest run \
  src/__tests__/postgres/list-tasks-derive-optout.pg.test.ts --silent=passed-only --reporter=dot
pnpm pg:test:down -- --port 25432
```

Note: a skipped `pgDescribe` block is **not** PostgreSQL verification evidence — see `docs/testing.md`.

## Do not

- Do not default `derive` to `false`, and do not convert a dashboard/API board-feed caller. Board parity
  is the hard constraint.
- Do not unfreeze memo rows to silence a `TypeError` from a mutating caller.
- Do not add a caller to the converted set without writing its field-read audit in its own FNXC comment.
