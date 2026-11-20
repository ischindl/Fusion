---
title: "A self-healing git sweep must prove its project root is a repository before it spawns git"
date: 2026-11-20
category: reliability
problem_type: reliability
module: "@fusion/engine"
component: self-healing / repo-root-probe
resolution_type: code_fix
tags:
  - self-healing
  - git
  - worktree
  - workspace
  - run-audit
  - durable-diagnostics
  - lifecycle-containment
symptoms:
  - "daemon logs `Stale active branch reclaim sweep failed: Command failed: git branch --list 'fusion/*'` once per maintenance pass, forever"
  - "the same log carries `fatal: not a git repository (or any parent up to mount point /)` plus `GIT_DISCOVERY_ACROSS_FILESYSTEM not set`"
  - "`Worktree prune failed: Command failed: git worktree prune` appears with the same cause"
  - "the sweep's own success line never appears (`Reclaimed <n> stale active fusion branch(es) with no usable worktree`)"
  - "a finished card keeps a stale `worktree`/`branch` pointer and `Branch fusion/<id> is already checked out` has no automatic reclaim path"
  - "'nothing to reclaim' and 'cannot look at all' produce identical evidence on the board"
applies_when:
  - "adding or changing any self-healing sweep that uses `this.options.rootDir` as the git working directory"
  - "a registered project root is a workspace folder whose members are repositories, not a repository itself"
  - "a sweep's whole body sits inside one `try` with a broad catch that returns 0"
---

## The measured shape (RUFU-804)

One continuous production daemon era (pid 4051354 on :4040, boot 2026-10-28 09:31:39Z, 473,765 lines read
at 11:04Z, era continuity proven by health `uptime` 5,443 s against process `etimes` 5,457 s):

- `Stale active branch reclaim sweep failed: Command failed: git branch --list 'fusion/*'` — **7 times**,
  which is exactly one per sweep invocation (startup plus one per 15-minute maintenance pass).
- The sweep's success line `Reclaimed <n> stale active fusion branch(es) with no usable worktree` —
  **0 times**. The corroboration matters: the bare substring `Reclaimed` matches 21 lines in the same era,
  all belonging to two *other* sweeps, so the log surface is readable and the needle is not form-dead.
- `Worktree prune failed: Command failed: git worktree prune` — **2 times**, same cause.

Reproduced with a control rather than inferred: `git branch --list 'fusion/*'` and `git worktree prune` both
fail with `fatal: not a git repository (or any parent up to mount point /)` at the workspace root
`saneca-ws`, and both succeed in the member directory `saneca-ws/lager-manager`. The failing root is
therefore a **folder that holds repositories without being one itself** — a legitimate and permanent
registration shape, not a broken checkout.

## Why the failure was invisible rather than merely noisy

`reclaimStaleActiveBranches` put its entire per-card loop inside one `try`, its first git call passed
`cwd: this.options.rootDir`, and the catch logged one sentence and returned `0`. The abort therefore
happened **before any candidate was examined**, so a pass that could not look wrote no
`stale-active-branch-reclaim` History line and no `branch:stale-active-reclaim` run-audit row — the same
evidence set as a healthy pass that found nothing to do. The operator could read "the sweep is unhappy" only
as a console line, and a reviewer reading the card could not tell the two states apart at all.

The asymmetry is that the lesson had already been learned once in the same file: the merge-metadata
reconciler carries `FNXC:Workspace 2026-06-22-14:10` saying it "assumes ONE git repo at
`this.options.rootDir`" and that "for a workspace task that root is NON-git", so it skips workspace
candidates before any git call. That guard is a per-sweep *skip*, and the precondition was never propagated
to the sweeps that own the project root as their working directory.

## The invariant

**A self-healing pass may not spawn git against a project root it has not proven to be a repository.** The
proof is one bounded probe per pass, and the verdict is a value, not an exception:

- `packages/engine/src/self-healing/repo-root-probe.ts` — the ONE probe for the family. It reuses
  `detectGitRepository` from `packages/engine/src/worktree/worktree-pool.ts`; the error classifier there is
  module-private and `detectGitRepository` already returns its classified verdicts, so reusing that function
  **is** reusing the classifier. A parallel probe or an exported classifier is a regression of this fix.
- **Existence before detection.** The shared classifier maps a missing working directory to
  `ENOENT` → `git-missing`, i.e. "the git binary is missing" — a false claim about the host's toolchain that
  sends the operator to reinstall git instead of to fix the project registration. The probe checks the path
  first and returns its own `missing-root` verdict, so the two stay distinguishable and no git child is
  spawned for a path that cannot exist. Only a proven `ENOENT` says missing: an unstatable path for any
  other reason falls through to the git-derived verdict rather than being *reported* as absent.
- **No memo.** No module-level or static cache of the verdict; a memo would keep refusing (or keep allowing)
  across a repair the manager never re-reads. The cost is one probe spawn per pass.
- **The refusal is surfaced, three ways, and none of them may be dropped to quiet the log**: one durable card
  History line per affected card per six-hour window (`logDiagnosticOnce`, the RUFU-643 seam), one
  ids/counts/enums-only `worktree:repo-root-refused` run-audit row whose `target` is the fixed sentinel
  `project-repo-root`, and one repeat-suppressed daemon sentence. The sentence is the only place the path may
  appear, and it is the last statement in the surfacing helper, so the path has no route into the audit call.
- **The bound is durable, not in-process.** Supervised dashboard restarts defeat in-memory gates; the
  per-card once-seam is what survives them. The in-process latch exists only to bound the *zero-candidate*
  row (the prune pass owns no card set) and re-arms on a pass that proves the root.
- **Lifecycle containment.** A refused pass moves no lane, writes no `status`/`error`, pauses nothing, and
  introduces no stall-reason or approval-hold reason code. The card's stale pointer is preserved exactly as
  it was; the only card write is the bounded diagnostic line, which must not reopen the card's liveness clock.

## Adoption path for another root-git sweep

The whole job at a new call site is one line after the pass's own pause/eligibility early returns:

```ts
if (!await this.proveRepoRootOrRefuse("<sweep-id>", () => this.cardsHoldingRepoPointers())) return 0;
```

Add the sweep id to `RepoRootRefusalSweep` and it inherits the refusal row, the durable per-card bound, and
the repeat-suppressed sentence. Two rules when adopting it:

1. Gate **above every arm** of the pass. A worktrunk backend call is still a git spawn for that pass, so a
   sweep with two arms that gates only the native one keeps throwing the sentence it was measured for.
2. Enumerate the per-card set from **task rows**, never from git — deriving the affected cards by asking git
   would be the very command the gate refuses.

## Per-sweep verdict across the family (criterion 4)

`grep -c 'cwd: this.options.rootDir' packages/engine/src/self-healing.ts` counts the whole shared-precondition
family. Every site carries a verdict; only the two measured sweeps are gated here.

| Sweep / helper | Root-git usage | Verdict |
|---|---|---|
| `cleanupInterruptedMergeArtifacts` | branch delete | deliberately unchanged — per-card cleanup, already try/caught per card; follow-up task |
| `reclaimPrConflicts` | worktree prune, branch delete | deliberately unchanged — same defect class; follow-up task |
| `reclaimSelfOwnedBranchConflicts` | several | deliberately unchanged — RUFU-717's neighbourhood; follow-up task |
| `inspectOrphanedBranch` | branch/tip inspection | gated transitively — reachable only from the gated reclaim pass |
| `reclaimStaleActiveBranches` | branch `--list`, per-card status, branch delete, worktree prune | **GATED** (this change) |
| `clearCompletionBranchIfSubsumed` | rev-parse verify | verify only — already covered by the workspace done-metadata guard |
| `reconcileInReviewBranchRebind` | branch/rev inspection | deliberately unchanged — per-card try/catch; follow-up task |
| `recoverApprovedStrandedAiMergeCommit` | rev-parse, status, merge | deliberately unchanged — a mutating merge path that must not be silently skipped; follow-up task |
| `hasRecoverableGitWork` | status probes | deliberately unchanged — its failure arm already means "preserve" |
| `pruneWorktrees` | worktrunk prune, native prune | **GATED** (this change) |
| `cleanupOrphans` / idle-worktree reclaim | prune, removals | deliberately unchanged — partially workspace-guarded; follow-up task |
| git-evidence reader base class (`self-healing-git-evidence.ts`) | read-only evidence probes | out of scope — RUFU-717 owns that path; this change delivers the probe module it can reuse |

A **deliberately unchanged** row is not a verdict that the sweep is healthy. It means the fix belongs at the
same seam with its own evidence, filed as its own task, and the row above is the reviewer's coverage answer
for why this card did not touch it.

## Reusable lessons beyond this seam

- **A swallowed exception is a missing feature, not a style problem.** The catch that turned a subprocess
  error into one log line is what made a total outage of that sweep unreadable for an entire era. When a
  `catch` returns a value that a healthy no-op pass also returns, the pass has no failure surface at all.
- **Zero success-log lines must be corroborated, not assumed.** Counting a bare substring (`Reclaimed` → 21
  hits) is what proves a zero is a real zero and not a needle that never matched any line shape.
- **A precondition learned once must be propagated.** The workspace skip comment proved the author understood
  the non-repo root; the knowledge died in that one sweep. When a guard exists for one call site of a shared
  precondition, enumerate the other call sites before shipping the guard.
- **Fixing a shared fixture, not the tests, preserves per-test invariants.** Both sweeps' fixtures pointed
  `rootDir` at a path that never existed; after the gate that is a named refusal, which would have made
  assertions about prune delegation and branch reclaim vacuously true. One real `git init` repository per
  fixture keeps each test able to fail.
