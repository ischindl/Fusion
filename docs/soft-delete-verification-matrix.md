# Soft-delete verification matrix

**Purpose:** Single source of truth for closing the FN-5105 / FN-5135 / FN-5137 / FN-5139 / FN-5140 / FN-5141 / FN-5142 / FN-5143 soft-delete stream.

**Success metric:** 0 reproducible cases where a soft-deleted task is runnable in scheduler / executor / merger / triage or visible in active dashboard queues after refresh or engine tick.

**Gate rule:** Every matrix row is GREEN or has a linked follow-up FN task before the stream is closed.

## Scenario matrix

| Scenario | Pre-state | API (REST) | Scheduler / Executor | Merger | Triage | Dashboard (SSE + initial load) | Agent logs | Documents | Owning FN |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1. Soft-delete a `triage` task with no `PROMPT.md` yet | Live `triage` row; task dir may exist without spec | `DELETE /api/tasks/:id` soft-deletes; later live readers 404 / omit; forensic store access still sees `deletedAt` row | Not dispatchable; auto-claim snapshots exclude it; executor entry points refuse if manually targeted | N/A | Active/queued triage must not re-open it after refresh; active abort is **blocked by FN-5142** | SSE `task:deleted` removes it; reload keeps it absent from board/ListView/TodoView | Preserved until FN-5143 lands | No documents expected; document APIs still treat parent as absent once FN-5140 lands | FN-5105 / FN-5135 / FN-5137 / FN-5142 |
| 2. Soft-delete a `todo` task with dependencies pointing AT it | Live `todo`; other live tasks depend on it | Delete is 409 `TASK_HAS_DEPENDENTS` unless caller opts into `removeDependencyReferences`; retry succeeds and returns soft-deleted task | Deleted task is never redispatched; rewritten dependents clear blocker residue (`dependencies`, `blockedBy`, `status`) and keep running as live tasks | N/A | N/A | SSE removes deleted card; dependents reflect rewritten dependency state on refresh | Preserved until FN-5143 | Hidden from live readers once FN-5140 lands | FN-5105 / FN-5137 / FN-5566 (re-land FN-5446) |
| 3. Soft-delete a `todo` task with lineage children | Live `todo`; `sourceParentTaskId` children exist | Current contract is 409 with lineage child IDs, then retry with `removeLineageReferences=true`; route/UI wiring is **pending FN-5139** | Deleted parent never dispatches; rewritten children remain live | N/A | N/A | Delete UI must surface confirm-retry flow once FN-5139 lands | Preserved until FN-5143 | Hidden from live readers once FN-5140 lands | FN-5139 |
| 4. Soft-delete an `in-progress` task with an active executor session | Live `in-progress`; executor owns active session | Delete succeeds; task vanishes from live readers immediately | Entry guards already refuse reruns; active-session abort / dispose is **pending FN-5142** | N/A | N/A | SSE removes card; reload does not re-seed it into active queues | Preserved until FN-5143 | Hidden from live readers once FN-5140 lands | FN-5137 / FN-5142 |
| 5. Soft-delete an `in-progress` task with an active workflow-step session and reviewer subagent | Live `in-progress`; workflow step child session exists | Delete succeeds; no public recovery/undelete flag | New execution attempts refuse; workflow-step + reviewer abort/cleanup is **pending FN-5142** | N/A | N/A | SSE removes card; reload stays clean | Preserved until FN-5143 | Hidden from live readers once FN-5140 lands | FN-5142 |
| 6. Soft-delete an `in-review` task that is currently being merged | Live `in-review`; active merge session in flight | Delete succeeds; live readers omit afterward | Scheduler must not requeue it | Active merge abort, queue removal, and controller cleanup are **pending FN-5142** | N/A | SSE removes card; reload keeps it absent | Preserved until FN-5143 | Hidden from live readers once FN-5140 lands | FN-5142 |
| 7. Soft-delete an `in-review` task queued for merge but not yet active | Live `in-review`; merge queued only | Delete succeeds; row stays for forensics only | Scheduler/executor must not pick it up again | Merge queue must filter it out; pending FN-5142 covers deterministic abort/filter assertions | N/A | SSE removes card; reload keeps it absent | Preserved until FN-5143 | Hidden from live readers once FN-5140 lands | FN-5137 / FN-5142 |
| 8. Soft-delete a `done` task with retained agent logs and saved task documents | Live `done`; has task docs + agent logs | Delete succeeds; live task readers omit afterward; forensic reads still allowed internally | Not runnable after any engine tick or restart | N/A | N/A | SSE removes card; refresh does not show it in board/ListView/TodoView | `agent-log.jsonl` file is preserved, but `getAgentLogs*` / `getAgentLogCount` return zero once `deletedAt` is set | `/api/documents` and per-task docs must disappear while DB rows remain; **pending FN-5140** | FN-5140 / FN-5143 |
| 10. Soft-delete a task that is checked out by an agent (`checkedOutBy` set) | Live task with lease / checkout metadata | Delete succeeds; linked agent task references clear with delete | Soft-deleted checked-out task must not be auto-claimed or executed after refresh/tick; extra deterministic coverage filed as **FN-5195** | If merge-owned, FN-5142 owns active merge abort details | If triage-owned, FN-5142 owns active triage abort details | SSE removes card; refresh must not show stale checked-out task | Preserved until FN-5143 | Hidden from live readers once FN-5140 lands | FN-5137 / FN-5195 |
| 11. Retry-exhausted `in-review` blocker is soft-deleted (`mergeRetries >= 3`) | Row remains in `tasks` with `deletedAt` set; downstream live tasks may still reference blocker in `dependencies`/`blockedBy` | Default task readers still hide it; opt-in surfaces expose it (`GET /api/tasks/exhausted-in-review?includeDeleted=true`, `GET /api/tasks/:id?includeDeleted=true`, `fn_task_show` fallback, `fn_task_list includeDeleted`) | Deadlock/stuck-merge/in-review-stall scans must exclude soft-deleted rows via `listTasks` (`ACTIVE_TASKS_WHERE`), plus per-sweep `task.deletedAt` guards as belt-and-suspenders | No merge-state mutation; blocker remains terminal unless explicit operator action | N/A | ReliabilityView panel explicitly lists hidden exhausted blockers + blocked dependents; main board stays unchanged | Existing logs preserved | Documents readable via opt-in task-detail fetch; no automatic restore | FN-5513 / FN-5528 |
| 12. Soft-delete a task with a singular Fusion worktree | Persisted, Git-registered `task.worktree`, clean or dirty | Delete response completes after the database transaction and event publication, without waiting for Git | `SelfHealingManager` removes the uniquely owned worktree asynchronously; startup and maintenance retry after crash or transient failure | Active or pending merge defers removal | Active planning/execution/session registration defers removal | No visual difference; desktop and mobile use the same delete endpoint | Existing logs remain forensic | Existing documents remain hidden under the tombstone contract | FN-309 |
| 13. Soft-delete a multi-repository task | Persisted `task.workspaceWorktrees`, optionally under a modern coordinator | Each repository target is independent; one failure does not roll back deletion or successful sibling cleanup | Registered, contained, uniquely owned children are removed and the empty modern coordinator is removed only after all children converge | Active or pending repository landing defers cleanup | Active workspace execution or planning defers cleanup | No visual difference | Existing logs remain forensic | Existing documents remain hidden | FN-309 |
| 14. Redeliver or restart after a committed soft-delete | Tombstone retains singular/workspace paths; local event may be lost or observed more than once | No second delete side effect is required | Observed outbox delivery, startup, and periodic maintenance invoke the same idempotent reconciler; an absent path is pruned and treated as converged | No merge proof is fabricated | No task is moved, resumed, or resurrected | Board remains deleted throughout | Unchanged | Unchanged | FN-309 |
| 15. Soft-delete with unsafe worktree ownership | External/root/unregistered/ambiguous/shared path, or a live session/process/merge | Delete still commits; filesystem safety is independent of API success | Cleanup fails closed and retries only when ownership or liveness can later be proved safe | Merge liveness is a hard veto | Executor, planner, workflow-step, agent/CLI registrations are hard vetoes | No visual difference | Warning remains operational, not task resurrection | Unchanged | FN-309 |

## ID reservation invariant

| Scenario set | Invariant | Evidence owner |
| --- | --- | --- |
| 1-8,10 | Soft-delete never frees the task ID. The `tasks` row persists with `deletedAt` set and allocators continue scanning all rows, so the ID is not reusable. | FN-5105 / FN-5128 |
| Re-delete of an already soft-deleted task | Second delete is a no-op: same `deletedAt`, no fresh event, ID still reserved. | FN-5127 / FN-5128 |

## Coverage gaps

| Scenario # | Layer | Existing coverage (file:line) | Gap | Proposed test file target | Owning FN |
| --- | --- | --- | --- | --- | --- |
| 1,4,7,10 | Scheduler invalidation on `task:deleted` | `packages/engine/src/__tests__/scheduler-auto-claim-invalidation.test.ts:31` | GREEN | — | FN-5137 |
| 1,4,7,10 | Executor `execute()` refusal of soft-deleted task | `packages/engine/src/__tests__/executor-soft-delete-guard.test.ts:50` | GREEN | — | FN-5137 |
| 4,5 | In-flight executor / workflow-step / reviewer abort on `task:deleted` | Entry-guard coverage only; no active-session abort assertion | Missing deterministic abort + dispose assertions | `packages/engine/src/__tests__/executor-soft-delete-abort.test.ts` and `packages/engine/src/__tests__/reliability-interactions/soft-delete-in-flight-abort.test.ts` | FN-5142 |
| 6,7 | In-flight merge abort / merge queue filtering | No deterministic merge-abort assertion in current corpus | Missing active merge abort + queued merge filtering coverage | `packages/engine/src/__tests__/project-engine-soft-delete-merge-abort.test.ts` | FN-5142 |
| 1,10 | Triage abort on `task:deleted` | No deterministic triage abort assertion in current corpus | Missing active triage session + subagent abort coverage | `packages/engine/src/__tests__/triage-soft-delete-abort.test.ts` | FN-5142 |
| 11 | Deadlock/stuck-merge/in-review-stall scan exclusion for soft-deleted exhausted blockers | Added in this task | GREEN — defensive sweep guards + script `WHERE deletedAt IS NULL` backstop | `packages/engine/src/__tests__/reliability-interactions/soft-delete-deadlock-scan-exclusion.test.ts`, `scripts/__tests__/recover-stale-blocked-by.test.mjs` | FN-5528 |
| 2,11 | Soft-delete blocker residue + legacy column drift reconciliation (`deletedAt` + non-sentinel column) | Added in this task | GREEN — in-transaction blocker cleanup, periodic/startup column-drift reconciler, and audit mutation `task:soft-delete-column-reconciled` | `packages/engine/src/__tests__/reliability-interactions/soft-delete-blocker-residue.test.ts`, `packages/core/src/__tests__/store-delete-task-blocker-residue.test.ts` | FN-5566 (re-land FN-5446) |
| 8 | Preserved `agent-log.jsonl` file is hidden from live readers after soft-delete | `packages/core/src/__tests__/soft-delete-agent-logs.test.ts` | GREEN — read APIs return zero while the on-disk file remains available for forensics | — | FN-5143 / FN-5911 |
| 8 | `/api/documents` and per-task docs exclude soft-deleted parents | No dedicated soft-delete document visibility assertion today | Missing store + route coverage | `packages/core/src/__tests__/task-documents.test.ts` and `packages/dashboard/src/__tests__/routes-tasks.test.ts` | FN-5140 |
| 3 | Lineage-unlink 409 flow through API + UI | Store lineage guards are covered; route/UI flow is not | Missing 409 payload + confirm-retry UX coverage | `packages/dashboard/src/__tests__/routes-tasks-ops.test.ts`, `packages/dashboard/app/utils/__tests__/taskDelete.test.ts`, `packages/dashboard/app/components/__tests__/TaskCard.test.tsx`, `packages/dashboard/app/components/__tests__/TaskDetailModal.responsive-and-dependencies.test.tsx`, `packages/dashboard/app/components/__tests__/ListView.test.tsx` | FN-5139 |
| Stream-wide | `fn_task_delete` tool / skill terminology | `packages/cli/src/__tests__/extension.test.ts:258` (pi-extension description pin, FN-5141) + `packages/engine/src/__tests__/agent-tools-task-delete-caller-attribution.test.ts` and `packages/engine/src/__tests__/agent-tools-task-delete-caller-attribution.pg.test.ts` (chat-lane copy: `Deleted <id>` success, refusal surfaced verbatim) | GREEN — tool-surface wording is asserted on both agent-tool lanes; a chat delete can no longer come back as a false `cannot delete itself` refusal | — | FN-5141 / RUFU-236 |
| Stream-wide | Chat-lane delete caller attribution (the chat lane used to stamp the target id as the caller, so the self-delete guard refused every chat delete and any surviving row persisted `api-unattributed`) | `packages/engine/src/__tests__/agent-tools-task-delete-caller-attribution.test.ts` (emitted `auditContext`: `agentId: "chat"`, `callerKind: "agent-tool"`, no own `taskId` key, operator notice copy) + `packages/engine/src/__tests__/agent-tools-task-delete-caller-attribution.pg.test.ts` (real store: delete succeeds, card leaves live readers, persisted `task:deleted` metadata is `callerKind: "agent-tool"` / `callerTaskId: null`, dependency refusal still surfaces) | GREEN — guard itself stays pinned by `packages/core/src/__tests__/postgres/store-self-delete-guard.pg.test.ts`, which still refuses a genuine self-delete | — | RUFU-236 |
| 1,4,6,7,8 | Dashboard SSE + reload deleted-task filtering | `packages/dashboard/src/__tests__/sse-task-deleted-payload.test.ts:5`; `packages/dashboard/app/hooks/__tests__/useTasks.test.ts:1124`; `packages/dashboard/app/hooks/__tests__/useTasks.test.ts:1147`; `packages/dashboard/app/hooks/__tests__/useTasks.test.ts:1255` | GREEN | — | FN-5135 |
| 4,10 | Cross-layer delete-during-execution / refresh convergence | No single composition backstop before this task | Added in this task | `packages/engine/src/__tests__/reliability-interactions/soft-delete-end-to-end.test.ts` | FN-5153 |
| 10 | Checked-out-task soft-delete composition | Entry guards exist, but no coverage focused on checked-out deleted tasks | New follow-up filed | `packages/core/src/__tests__/soft-delete-tasks.test.ts` and `packages/engine/src/__tests__/auto-claim-snapshot-soft-delete.test.ts` | FN-5195 |
| 1-8,10-11 | Every projected row states its lifecycle (`live` / `deleted` / `archived`) at the HTTP boundary, in every arm: default, column-scoped, `excludeDone`, `q`-searched, both page arms, forensic | `packages/dashboard/src/__tests__/routes-tasks-lifecycle-projection.test.ts`, `packages/core/src/__tests__/task-lifecycle-projection.test.ts` | GREEN — stamped after the store call, so it survives every row shape (`excludeLog`, `fields`, board-feed); a `deletedAt`-falsy filter can no longer read a tombstone as alive | — | RUFU-583 |
| 1-8 | Default board read provably carries no non-live row | `packages/dashboard/src/__tests__/routes-tasks-lifecycle-projection.test.ts` (asserts every row `lifecycle === "live"`), `packages/core/src/__tests__/postgres/task-list-lifecycle-projection.pg.test.ts` | GREEN — the exclusion is now an assertion, not an accident of the lane predicate | — | RUFU-583 |
| 11 | `?includeDeleted=1` reaches the tombstone on a real store (real `store.deleteTask`, then real `listTasks`) | `packages/core/src/__tests__/postgres/task-list-lifecycle-projection.pg.test.ts` | GREEN — the implicit sentinel-lane exclusion is relaxed for a forensic read only; historical lanes and an explicit `excludeColumns` arm stay excluded, and live/forensic reads never share a memo entry (`packages/core/src/__tests__/postgres/list-tasks-derive-optout.pg.test.ts`) | — | RUFU-583 |
| 1-8 | Single route decides "did my delete take?" in ONE request: `404` + `details.code: TASK_SOFT_DELETED` + timestamp, or forensic `200`; a never-existed id stays a plain `404` | `packages/dashboard/src/__tests__/routes-tasks-lifecycle-projection.test.ts` | GREEN — one route, one request; a probe fault falls back to the plain `404`, never a `500` | — | RUFU-583 |
| 2,3 | A refused delete is reported at delete time (`409` + structured code) while the row demonstrably stays live and listed | `packages/dashboard/src/__tests__/routes-task-delete-nonblocking.test.ts` | GREEN — `TASK_HAS_DEPENDENTS` / `TASK_HAS_LINEAGE_CHILDREN`; the refusal can no longer surface later only as a list-vs-single mismatch | — | RUFU-583 |
| 12-15 | Singular/workspace worktree cleanup, duplicate observed delivery, restart replay, ownership and liveness vetoes | Real Git plus production `SelfHealingManager` listener/reconciler coverage | GREEN — directory and `git worktree list --porcelain` converge; tombstone remains; repeated delivery is harmless | `packages/engine/src/__tests__/self-healing-deleted-task-worktree-cleanup.test.ts`, `packages/engine/src/__tests__/self-healing-workspace.test.ts`, `packages/engine/src/__tests__/reliability-interactions/soft-delete-in-flight-abort.test.ts` | FN-309 |

## Release-blocking checks

- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm --filter @fusion/dashboard test:browser-smoke`
- Every scenario-matrix row is GREEN or has a linked follow-up FN task before the FN closing that row merges
- `packages/engine/src/__tests__/reliability-interactions/soft-delete-end-to-end.test.ts` is fully un-skipped before the stream is declared closed
- Manual smoke once on the live dashboard at port 4040: delete one `todo`, one `in-progress`, and one `in-review` task; refresh; confirm none reappear in any board column, ListView, or TodoView; confirm no SSE flicker re-adds the card
- `node scripts/audit-squash-merge.mjs <sha>` remains unaffected by any task in this stream

## Forensic access escape hatch

Forensic access has two layers, and since RUFU-583 the public one is no longer a silent option.

Internal (unchanged):

- `readTaskFromDb(id, { includeDeleted: true })` in `packages/core/src/store.ts`
- direct SQL against `tasks` and `task_documents`, plus on-disk reads of `.fusion/tasks/{ID}/agent-log.jsonl`

Public (RUFU-583): `?includeDeleted=1` on `GET /api/tasks`, `GET /api/tasks/page`, and `GET /api/tasks/:id`
really returns tombstones now. It used to be accepted and answer `[]` on a real store: a soft delete stamps
`column: "archived"` beside `deletedAt`, and a read with no explicit lane constraint gets an implicit
`excludeColumn: "archived"`, which dropped the tombstone on the lane predicate before `includeDeleted` ever
reached the live-row filter. The relaxation is narrow by contract: it removes that implicit sentinel-lane
exclusion **only** for a forensic read, so a forensic payload stays "live board union tombstones" and never
merges the historical lane or an explicit `excludeColumns` arm.

Every projected row states its own state, so a consumer never has to keep an id set of tombstones: the
`lifecycle` field is `live`, `deleted`, or `archived`, derived once by `deriveTaskLifecycle` /
`withTaskLifecycle` in `packages/core/src/task-store/lifecycle-projection.ts` and stamped at the HTTP boundary
(never inside `rowToTask`, which would leak the field into every store consumer and into persisted shapes).
`GET /api/tasks/:id` settles "did my delete take?" in one request: either `404` with
`details.code: "TASK_SOFT_DELETED"` and the `deletedAt` timestamp, or — when the caller asked forensically —
`200` with the tombstone self-marked `deleted`. A never-existed id stays a plain `404` with no such code, so
the code names a tombstone and nothing else.

<!-- FNXC:TombstoneLifecycleProjection 2026-11-17-18:06 (RUFU-583): this section's closing sentence ("No public API flag exposes deleted-task forensics today") was falsified by the card that fixed forensic reachability; the flag existed but silently returned nothing, which is the same trap wearing a different name. -->

## Out of scope

- Undelete UX / restore-from-trash flow — file a new FN if requested
- Hard-delete UI — file a new FN if requested
- Mission / feature / slice soft-delete — those entities do not use `deletedAt` today; file a new FN if requested
- Agent / node / secret soft-delete — file a new FN if requested

## Notes

- FN-5496: `task:deleted` now triggers immediate scheduler-side downstream `blockedBy` reconciliation for `todo`/`in-progress` dependents, and stale-blockedBy self-healing logs now discriminate soft-deleted blockers with `soft-deleted at ...` reasons.
- Store-level soft-delete invariants live in `packages/core/src/store.ts` (`ACTIVE_TASKS_WHERE`, `deleteTask`, `readTaskFromDb(..., { includeDeleted: true })`) and `packages/core/src/__tests__/soft-delete-tasks.test.ts`.
- Cross-reference `docs/storage.md` for the persisted-row model; FN-5140 and FN-5143 own the storage-doc deltas for document and agent-log visibility.