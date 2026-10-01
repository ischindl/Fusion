---
title: "A task can vanish from the board while its disk mirror and branch stay alive — and nothing reports it"
date: 2026-09-24
category: reliability
problem_type: reliability
module: "@fusion/core / @fusion/engine"
component: task-store / self-healing / task-id-integrity
tags:
  - vanished-task
  - soft-delete-tombstone
  - orphan-reimport
  - run-audit
  - mailbox-alerting
  - branch-cleanup
  - rufu-225
  - rufu-283
symptoms:
  - "a task id resolves on no board read while `.fusion/tasks/<ID>/task.json` is intact"
  - "the task's `fusion/<id>` branch still holds commits that exist on no other ref"
  - "GET /api/health reports taskIdIntegrity.status ok with anomalies: []"
  - "FN-6783 emits no reconcile-orphaned-task-dirs event for the vanished card"
---

## What happened

RUFU-225 disappeared from every board read while its work survived. The operator found the card by
hand and opened RUFU-282 to recover it; RUFU-283 is the attribution and the detector.

The state found on disk (`/home/schindler/git/Fusion/.fusion/tasks/RUFU-225/task.json`, read read-only):

| Evidence | Measured value |
| --- | --- |
| Mirror `mtime` | `2026-09-17T14:08:16.294Z` (≈6.4 days old when found on 2026-09-23) |
| Mirror `column` | `in-review` |
| Mirror `status` | `failed` (`AUTO_MERGE_RETRY_REJECTED: Task has enabled pre-merge workflow steps that never ran: plan-review, code-review`) |
| Mirror gate rows | exactly one: `code-review` → `passed`, verdict `APPROVE_WITH_NOTES`, `reviewKind: code` |
| Mirror `deletedAt` | `null` — the mirror itself never recorded a delete |
| Branch | `refs/heads/fusion/rufu-225` @ `15d85e19e2987816051fb8dd698a5a8a57d7c4a1` |
| Unmerged commits | `git rev-list --count main..refs/heads/fusion/rufu-225` → `3` |
| Remote ref | `remotes/lan/fusion/rufu-225` also present |
| Health probe | `GET /api/health` → `"taskIdIntegrity": { "status": "ok", "anomalies": [], "checkedAt": "2026-09-23T20:18:17.712Z" }` |
| Board read | `fn_task_show` / `fn_task_list` could not resolve the card; the include-deleted list route answered `401 {"error":"Unauthorized"}` and no PostgreSQL credential is reachable from an agent session |

**Verdict (evidence-level).** The row was not on the live board. Whether it was a soft-delete
tombstone or fully absent is **unproven from the agent session** — both routes to that answer are
auth-gated deliberately (`401`, and `~/.fusion` is outside agent containment), and this task is not
authorized to touch live credentials or issue mutating SQL. The two candidates are not equally likely,
and the distinguishing fact is that **both of them are invisible today**.

## Why every existing guard stayed silent

Four guards were in scope at the moment of loss. None of them can see this state.

1. **`detectTaskIdIntegrityAnomalies` is row-only.** It enumerates active/archived duplicates,
   active/archived collisions, id-sequence gaps, and unreserved creates. RUFU-225 has no row to
   disagree with, so the correct-by-construction answer is `status: "ok"`, which is what
   `/api/health` reported the whole time. A board query cannot return a row that is not there;
   every row-derived check is blind to it by definition.

2. **FN-6783's orphan re-import requires a fully absent id and a 7-day window.**
   `reconcileOrphanedTaskDirs` skips a mirror when `taskIdExistsAnywhere` is true
   (`reason: "id-exists-anywhere"`), and its candidate scan excludes directories
   *outside the 2–7 day window*. Measured against RUFU-225: the mirror was 6.4 days old, and a
   tombstone makes `taskIdExistsAnywhere` true. Either fact alone silences the sweep — and the
   silence is `reason: "skipped"`, not an anomaly, so nothing accumulates anywhere.

3. **`taskIdExistsAnywhere` cannot name the state it saw.** One boolean covers live row, tombstone,
   and archive snapshot. That is precisely the primitive FN-6783 needed to *attribute* its own skip
   and did not have. The new `TaskStore.resolveTaskIdPresence[ForIds]` returns
   `{ rowExistsAnywhere, liveRowExists, tombstoned, tombstonedAt, inArchive }` and is the authority
   the detector uses (`packages/core/src/__tests__/postgres/vanished-task-presence.pg.test.ts` pins
   the distinction against the real backend).

4. **The resurrection purge was unaudited and deleted children first.** The pre-`allowResurrection`
   shape (`git show b611163623:packages/core/src/task-store/task-id-integrity.ts`) purged
   `task_workflow_selection` and the materialized `workflow_steps` children, then hard-deleted the
   parent with no audit row. So the path that could legitimately consume RUFU-225's id left no trace
   of having done so, and a mid-way failure left a gutted tombstone that still reserved the id and
   looked like an intentional soft-delete. A purge that had run would have erased the very
   discriminant this forensics question turns on.

**Do not read the missing purge audit row as an exoneration.** The deployed build predates this task, so
`task:row-purged-for-resurrection` did not exist when RUFU-225 disappeared — its absence on the live
instance says nothing about whether a purge ran. The timeline makes that concrete: `allowResurrection`
(and with it the physical tombstone purge) landed in FN-229 (`b611163623`, *remove dual-source tombstone
ledger and resurrect hard-deleted tasks*), which is merged into `main` **and** into this branch, while the
audit row is RUFU-283 work that cannot exist in the running daemon. FN-295 (`d3204c1eeb`, *remove task
archiving*) then deleted the archiving path, which had been the other caller of the delete family, leaving
the resurrection purge as the only visible-to-nothing remover of a `tasks` row. What is still true is
narrower than it first looked: no code in this repo sets `allowResurrection: true`, so every remaining
writer is operator-initiated (`fn task delete --allow-resurrection`, its HTTP twin, a pi extension, or
hand-run SQL). The identity of the writer stays unidentified; this change makes it impossible for the next
one to be silent.

## Why the branch survived

Branch cleanup is deliberately loss-averse, and that is the only reason any work is left to salvage:

- `scanOrphanedBranches` (`packages/engine/src/worktree/worktree-pool.ts`) lists every local
  `fusion/*` branch and subtracts the branches of **live** tasks (`store.listTasks({ slim: true,
  includeArchived: false })`, minus the merger-managed lanes). RUFU-225 has no row, so its branch is
  offered to the cleaner as an orphan — attribution cannot protect a card the board cannot see.
- What saved it is the next guard: `cleanupOrphanedBranches` (`packages/engine/src/self-healing.ts`)
  `continue`s on any candidate whose `uniqueCommitCount > 0`, counted by `inspectOrphanedBranch` as
  `git rev-list --count <branch> --not main`. RUFU-225 measures **3**, so it is skipped and never
  reaches `git branch -d`. The prune that does happen records `branch:orphan-prune` with the tip sha.
- The step is also cadence-gated (`maintenancePaused || !gitWorktreeChurnDue`), so it does not run on
  every tick — but on this host `main` is 2013 commits ahead of `origin/main`, which makes the churn
  gate due, so the survival above is the unmerged-count guard doing its job, not the gate hiding it.
- The one path that *does* remove it deliberately is the resurrection purge:
  `deleteTask(id, { allowResurrection: true })` → `cleanupTaskBranchForHardDelete` with
  `strategy: "force"` and `allowBranchCleanup: true` — no merge test at all.
- The one path that does remove it is the resurrection purge:
  `deleteTask(id, { allowResurrection: true })` → `cleanupTaskBranchForHardDelete` with
  `strategy: "force"` and `allowBranchCleanup: true`.

## Residual risk after this change

- **Reflog expiry.** Once `fusion/rufu-225` is gone, recovery drops to the disk mirror plus any
  surviving worktree, and the reflog (`gc.reflogExpire`, commonly 90 days) is the outer bound. The
  detector's `row-missing-branch-missing` reason exists to say exactly this out loud.
- **A purge still destroys the discriminant.** This change makes the purge audited and fail-closed; it
  does not make the deleted work recoverable. The notice's salvage hint tells the operator to salvage
  commits *before* resurrecting.
- **Archive snapshots are excluded from detection, on purpose.** An archived card whose mirror and
  branch survive is normal history, and the classifier returns no finding for `inArchive`. If archive
  retention ever starts deleting branches, that exclusion needs re-examining.
- **The sweep cannot repair.** There is no honest way to reconstruct lane state, gate history, or a
  review verdict from a directory; auto-recreating rows would fabricate state and mis-merge.

## What was changed (RUFU-283)

- **Detector**: `reconcile-vanished-task-dirs` in self-healing maintenance batch 1, cadence-gated with
  `cleanup-orphans`. Disk is the authority for what existed; the row and the branch explain what
  happened. One `task:vanished-approved-work` row plus one idempotent operator mailbox notice per
  `(taskId, reason, 6 h window)` bucket. Report-only: no column, status, step, or branch write.
- **Age floor 15 minutes** (`VANISHED_WORK_MIN_MIRROR_AGE_MS`), not FN-6783's 7 days: RUFU-225 sat
  unnoticed for six days, and the long window is the defect, not the safeguard. It still absorbs the
  create-in-flight race that the 7-day bound was protecting.
- **Probe bound 50 per sweep**; anything past it is reported as `state-unresolved` rather than
  dropped, and a missing ref is *never* read as "0 unmerged commits" (`rev-parse --verify` first —
  `rev-list --count <missing-ref>` exits 0 with `0`).
- **Purge hardening**: the audit row (`task:row-purged-for-resurrection`) and the parent delete share
  one transaction; a failed audit write raises `TombstonePurgeUnauditedError` and the tombstone stays
  intact. The child purge moved after the commit and is best-effort, which is safe only because
  `workflow_steps` and `task_workflow_selection` declare no foreign key to `tasks`.

## Symptom acceptance (measured, not asserted)

The original condition was re-created against the live artifacts and the detector reported it. The live
mirror was copied into a temp sandbox and backdated (the live tree was never written), the branch probe
ran real read-only `git` in the live repo, and audit + mailbox were captured instead of written:

| Assertion | Result |
| --- | --- |
| Reason classified | `row-missing-branch-unmerged` |
| Unmerged commits (real probe) | `3` |
| `gateApproved` from the mirror's single gate row | `true` (`code-review:passed:APPROVE_WITH_NOTES`) |
| Last known column from the mirror | `in-review` |
| Run-audit row | `mutationType: task:vanished-approved-work`, `target: task:RUFU-225`, `agentId: self-healing` |
| Mailbox notice | key `system:vanished-work:RUFU-225:row-missing-branch-unmerged:<bucket>`, body carries `git log main..fusion/rufu-225 --oneline` |
| Control — same mirror with a live board row | `findings: 0`, `alerted: 0` |
| Mirror age at measurement | 6.48 days (`mtime 2026-09-17T14:08:16.294Z`) — inside FN-6783's 2–7 day window, which is why that sweep never claimed it |

The control is the part that matters: the file on disk is not what trips the detector, the absence of a
board row is. This ran in-process against the deployed build's *artifacts*; the deployed daemon still
predates this change, so its first production sweep happens after the operator restarts Fusion.

## Salvage

Recovery of RUFU-225's commits is **RUFU-282's** job, not this document's. The pointers it needs:

```bash
git log main..fusion/rufu-225 --oneline    # the 3 commits at risk
git branch --contains 15d85e19e2987816051fb8dd698a5a8a57d7c4a1
```

Do not resurrect the id (`deleteTask(id, { allowResurrection: true })`) before salvaging — that path
hard-deletes the tombstone *and* the branch.
