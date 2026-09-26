---
title: TaskStore boot timeout on large boards — light boot for transient CLI/extension opens
date: 2026-09-26
component: packages/core/src/task-store/lifecycle-ops.ts, packages/cli/src/extension.ts
symptoms:
  - "fn extension TaskStore boot timed out after 30000ms"
  - "the agent permission policy could not be resolved … Failing closed — ask the operator to run this tool"
  - every fn_* tool call denied with deniedFor agent-permission-policy-unavailable on large projects
root_cause: store-open backlog hydrates heavy inline task log payloads (archive reintegration live-page read) in every process, including one-shot CLI tools
resolution_type: code-fix
category: performance
module: task-store
tags: [boot, taskstore, cli, extension, archive-reintegration, patchnode, slim-projection]
problem_type: performance
applies_when: a store open exceeds its boot budget on a project with many/large task records
---

# TaskStore boot timeout on large boards (RUFU-275)

## Symptom

On a large board (saneca: 315 `task.json` mirrors / 30.18 MB, largest 1.9 MB, inline `log`
≈ 90–94 % of each card) every fn-extension tool call — including the recovery levers agents
need when a card is wedged (`fn_task_retry`, `fn_task_logs_read`) — failed with
`agent-permission-policy-unavailable`. The same code on a small board boots in 396 ms.

## Root cause (measured, `boot-backlog-attribution.pg.test.ts`)

`TaskStore.init()` runs a full backlog at every open (`initImpl`,
`packages/core/src/task-store/lifecycle-ops.ts`): id-reservation reconcile → legacy-adoption
census → archive reintegration → forced Patchnode ledger reconcile. The dominant byte cost is
**archive reintegration**: its live-column page reads tasks with `slim: false`, so every SELECT
names the heavy `log` jsonb column (wire-captured via the postgres-js `debug` hook), and the cold
page parses every `archived_tasks.task_json` snapshot in full (25 MB board: 10 197 024 B pulled,
25 ms for the cold page alone on a fast machine; ~2.4 s total on the fixture's ~1/3 scale —
slower host hardware multiplies this past the extension's 30 s budget). The census is a cost in
BOTH currencies, and `slim:true` is not what bounds it: with the derive pass still on, the issued
SELECT enumerates every task column including `log`, so the census pulls the heavy column too and
then pays the per-row UI-signal derivation on top. `derive:false` removes both — 213 ms → 30 ms on
the calibrated fixture, and the wire capture shows the fix-shape SELECT no longer names `log`. The
hydrated rows cannot reveal this: the slim row mapper restores `log` to `[]` in either shape, so
only the issued-SQL capture distinguishes them. The 30 s denial then blamed the permission layer,
not the store open.

## Fix

1. **Light boot** — `initImpl`/`store.init`/`createTaskStoreForBackend` accept
   `skipArchiveReintegrationOnInit` / `skipPatchnodeReconcileOnInit` (defaults false: long-lived
   host boots keep the complete backlog). The transient fn-extension boot and one-shot `fn task`
   commands (which own no host process) boot light; skipped passes self-heal via engine
   maintenance and completion-time writers.
2. **Census shape** — the legacy-adoption census reads `listTasks({slim:true, derive:false,
   includeArchived:false})`; consumers use persisted columns only.
3. **Honest denial** — a store that cannot boot denies agent tools under its own
   `deniedFor: "taskstore-boot-unavailable"` carrying the concrete boot error;
   `agent-permission-policy-unavailable` is reserved for genuine policy-resolution failures.
   Fail-closed semantics are unchanged.

## Boundaries

- `derive:false` is what drops `"log"` from the census SELECT; `slim:true` alone does NOT — with
  derivation on, the statement still enumerates the column. A full-init host boot legitimately keeps
  naming it — the PG fixture pins all four directions (derive-on census names `"log"`, derive-off
  census must not, cold init names `"log"`, light init must not, light boot < 20 s absolute ceiling).
- Light boot is not a migration: reintegrating an archived card on a light-booted CLI still
  runs the same restore path with full hydration for that one card.
- Never assert boot-time ratios in tests — absolute ceilings plus wire-shape assertions only;
  timing ratios are flakes.
