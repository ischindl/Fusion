---
category: performance
module: packages/dashboard/src/routes/attribute-done-range-files.ts
date: 2026-09-09
problem_type: performance
severity: high
applies_when:
  - "A dashboard route fans one logical git question out into N serial `runGit` subprocesses (a loop around execFile, one per commit/sha)"
  - "Done-card `/diff` or `/file-diffs` attribution stalls the event loop by hundreds of ms while the dashboard's live RSS is multi-GB"
  - "Choosing between spawning per item vs one batched plumbing call and wondering where the ~30 ms/spawn actually comes from"
component: dashboard-api
tags:
  - performance
  - subprocess-spawn
  - vfork-execve
  - git-plumbing
  - attribution
  - content-addressed-cache
  - in-flight-coalescing
  - fnxc-taskdiffattribution
related_components:
  - dashboard
  - session_diff_routes
  - resolve_diff_base
  - task_lane_cache
---

# Done-range attribution: batch the git question, not the loop (RUFU-207)

## Symptom

`filterFilesToOwnTaskCommits` — the correctness gate that hides other tasks' files from a
done card's change count — enumerated the own commits with one `git log` and then resolved
each own commit's files in a **serial loop** of `git diff-tree --no-commit-id --name-only -r <sha>`.
A done range with C own commits therefore paid `1 + C` awaited subprocesses per request, and
`/diff` + `/file-diffs` paid the whole pattern twice for the same card. For a 20-commit task
that measured as ~0.6 s of serialized main-thread stall per request.

## The measurement: spawn cost tracks live RSS, not the heap cap

Measured on production (2026-09-09; dashboard live RSS 2.07 GB, 24 cores, load 9.7→16.4):

| Condition | Main-thread CPU per subprocess spawn |
|---|---|
| 0.06 GB live RSS | 1.15 ms |
| 2.02 GB live RSS, default heap cap | **31.7 ms** |
| default cap + `--max-old-space-size=16384` | 28–48 ms |
| 16384 cap but **idle** heap | 1.35 ms |
| GC share of total CPU | 11.9% |

The V8 heap cap is not the driver — an idle heap at the 16 GB cap spawns as cheaply as at the
default cap. The parent's **live resident pages** are, because `vfork`/`execve` has to set up
and tear down the parent's address space for every spawn. GC was a minor share; this is
subprocess churn on the event loop, not a GC crisis. The correct lever is therefore
**spawn count**, and it pays out proportional to the process's current RSS — exactly when a
dashboard process is at its worst.

## The fix: one batched plumbing call that keeps per-commit attribution

The per-sha loop became one `git log` call over the own-commit set:

```
git log --no-walk --no-show-signature --min-parents=1 --max-parents=1 --no-renames
        --format=%x00%H --name-only <sha1> <sha2> ... (chunks of 500)
```

Output parses into per-commit blocks keyed by a `%x00<40-hex>` header — a NUL byte is
impossible inside a git path, so a block header can never collide with a file name — and the
returned `files` set, ordering (`localeCompare`), `ownCommitShas`, and `foreignCommitCount`
are byte-identical to the loop's. Why each flag is load-bearing (measured shape-for-shape on
git 2.55):

- **`--no-walk`** over an explicit sha list reproduces the loop's exact "these commits only" set.
- **`--no-renames`**: porcelain `log` defaults to rename detection (collapsing a rename to the
  new path), while plumbing `diff-tree` ignores `diff.renames` and prints **both** paths.
  `--no-renames` forces the porcelain walk to the plumbing contract, config-drift-proof.
- **`--min-parents=1 --max-parents=1`**: single-parent commits are exactly the loop's
  contributing set — a root commit contributes nothing (`diff-tree -r <root>` prints nothing)
  and merges contribute nothing (`diff-tree -r` without `-m`). Plain `log --no-walk <root>`
  *would* show root files, so parent-count filtering is what keeps roots/merges silent without
  trusting `--diff-merges` config defaults.
- **`--no-show-signature`**: a user's `log.showSignature` would inject GPG payload lines that
  parse as filenames.
- The multi-sha `git diff-tree` form the task spec also floated is **dead**: plumbing treats
  extra tree-ish args as a tree-vs-tree diff and prints nothing — precisely the merged-across-
  commits answer the correctness contract forbids.

**Fail-closed parse**: a block header whose sha is not in the requested own set is discarded;
any unattributable line rejects the whole batch output and the function falls back to the old
per-sha loop for the **entire range**. Correct-but-slow beats guessing ownership.

## The cache: content-addressed, so TTL is a memory bound, not a correctness lever

Key = `worktreePath + baseRef + sorted own-commit shas`. A landed commit changes the key by
itself, so **no time-based invalidation is required for correctness**; the 10 s TTL only bounds
memory. TTL was deliberately capped at the payload caches' TTL (`sessionFilesCache`/
`fileDiffsCache` in `register-session-diff-routes.ts:46`/`:47`) so attribution can never hold a
newer-truth answer longer than the payload caches already mask — the layers never compound
staleness. A sequential re-ask of an unchanged range costs exactly one enumeration `git log`
(the key needs the shas) and zero name-resolution spawns; the literal zero-spawn case is the
**in-flight coalescing** map (`worktreePath + baseRef + taskId`), which lets a concurrent
`/diff` + `/file-diffs` pair share one attribution promise. The flight entry is deleted on
settle — including rejection — so a transient git failure is never cached nor coalesced past
its own lifetime. Both layers mirror `packages/core/src/task-lane-cache.ts` (plain `Map`,
insertion-order eviction, injectable clock for fake-clock tests).

## Proof

- Differential oracle test (`packages/dashboard/src/__tests__/attribute-done-range-files.test.ts`):
  a test-local verbatim copy of the old algorithm vs the batched module over real temp repos —
  single / 20 own commits, foreign-only, duplicate-path, merge-sibling, rename+delete+unicode,
  orphan-root — all deep-equal.
- Call-count guard: ≤ 2 `runGit` invocations for a 20-own-commit range (was 21).
- Route-level guards in `routes-github.test.ts`: a 6-commit card is attributed through the real
  HTTP surface by exactly 1 enumeration + 1 batch spawn (0 per-sha fallbacks), and a primed
  concurrent `/diff` + `/file-diffs` pair never re-resolves names.

In code, stamp `FNXC:TaskDiffAttribution` greps both the batch site and the cache site.
