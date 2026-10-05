---
category: performance
module: packages/dashboard/src/routes/register-session-diff-routes.ts
date: 2026-09-10
problem_type: performance
severity: high
applies_when:
  - "A dashboard route answers an aggregate question (a count or sum) via one subprocess per item"
  - "The only consumer of an endpoint's response is a single number on a card that re-polls on a timer"
  - "Choosing between per-file git patch calls and one whole-tree `diff --numstat` and wondering what changes the counted number"
component: dashboard-api
tags:
  - performance
  - subprocess-spawn
  - vfork-execve
  - git-plumbing
  - numstat
  - server-cache
  - fnxc-taskdiffstats
related_components:
  - dashboard
  - session_diff_routes
  - attribute_done_range_files
  - use_task_diff_stats
---

# Stats-only `/tasks/:id/diff`: one stat subprocess, not one per file (RUFU-206)

## Symptom

Opening the board made the whole dashboard slow: API latency 0.77–2.0 s (up to 3.4 s even on a request
rejected with 401 — the event loop was blocked past auth), `child_process.spawn` at 41.8 % CPU self time,
≥ 22 git spawns/s attributable to the dashboard pid, ~52,700 minor page faults/s. The fan-out:
`GET /tasks/:id/diff` computed per-file patch text — three `--name-status` passes plus one
`git diff <base> -- <file>` subprocess **per changed file** — and the TaskCard badge consumed exactly one
integer (`stats.filesChanged`) from the response and threw the rest away. Every visible active card every
30 s therefore paid ~(commits + 3 + files) subprocesses for one number, with no server-side cache at all.

## The measurement: spawn cost tracks live RSS, not the heap cap

Measured on production 2026-09-09 (dashboard live RSS 2.07 GB, 24 cores; same vfork/execve mechanism
quantified in `done-range-attribution-subprocess-batching.md`): one `child_process.spawn` costs
**1.15 ms** of main-thread CPU at 0.06 GB live RSS and **31.7 ms** at 2.02 GB live RSS; raising
`--max-old-space-size` does not help. At production size a 12-file card paid ~300–480 ms of main-thread
stall per poll for a one-number answer. A local scratch-repo control (git 2.55, small process): 12
sequential path-limited `git diff <spec> -- <path>` calls = 37.3 ms vs **ONE**
`git diff --numstat -z --no-renames <spec>` = 2.9 ms, with byte-identical additions/deletions totals
(24/12 == 24/12). The lever is spawn **count**, and it pays out worst exactly when the dashboard is biggest.

## The fix: a whole-tree numstat joined onto the attribution path set

`?stats=1` on `/tasks/:id/diff` answers the stats triple with **one whole-tree stat subprocess** per
resolved range instead of the N-file patch fan-out, on every lane:

| Lane | Diff-body spawns before | After (`?stats=1`) |
|---|---|---|
| Active worktree, F files | 3 + F (concurrency-8 patch fan-out) | 3 name-status + 1 numstat = **4** (0-file path set skips the numstat) |
| Landed/done aggregation, K commit specs | K × (1 + files-per-spec, serial) | K × 2 |
| Rebase-range / commit-shape range | 1 + F (serial) | **2** |
| Branch-ref fallback (worktree gone) | 1 + F (serial) | **2** |
| Landed last-resort shortstat | 1 | **1** (already O(1); untouched) |
| Workspace, R sub-repos | R × lane cost | R × lane constant — never O(R × files) |
| Server stats-cache hit | n/a (no cache existed) | **0** total |

The diff-body spawn count no longer depends on how many files changed: a 3-file and a 12-file card cost
identically (pinned by a spawn-count test on the real-git route harness).

Two design constraints make the join necessary rather than optional:

1. **The numstat is a lookup table, never the answer.** A bare whole-tree total cannot attribute files to
   the task's own commits, and shared branches carry foreign commits, so it would silently widen the
   operator's number. Stats mode keeps the existing `--name-status` path-set passes and the existing
   own-task attribution filter verbatim, then joins numstat counts onto that owned path set by path.
2. **`--no-renames` is mandatory on the numstat.** Today's per-file patch (`git diff <spec> -- <path>`) is
   rename-blind — a single-path pathspec can never pair a rename's source — so a pure rename counts as a
   full add. Git's `diff.renames` defaults to true, and a rename-detected numstat reports a pure rename as
   `0 0`; joining it would silently shrink the card's number. Rename-blind numstat + `--no-renames`
   reproduces the path-limited patch's per-path counts exactly (binary `-\t-\t` maps to 0/0, never `NaN`).
   The per-lane parity tests — not this reasoning — are the arbiter.

`parseNumstatOutput` (in `diff-counts.ts`) parses the NUL-delimited `-z` layout (paths may contain
spaces/unicode verbatim; rename records consume their extra NUL-separated pre/post images) into a
`Map<path, {additions, deletions}>` keyed on the same path identity `parseNameStatusLine` yields. A
missing path is a legitimate `0/0` — the same observable outcome as today's empty patch (committed-then-
reverted paths, staged-only paths that net to base, untracked paths `git diff` never lists).

## The cache: key carries the lane identity so moves miss by construction

A module-level stats cache beside the route's two existing caches (10 s TTL — parity with
`sessionFilesCache`/`fileDiffsCache` and the RUFU-207 attribution cache, plain `Map`, insertion-order
eviction, injectable clock, successes-only, `__resetTaskDiffStatsCacheForTests()`). It is read **before**
the lane dispatch, so a cache-served badge poll costs zero subprocesses including attribution and base
resolution. The key carries lane identity from stored task fields only — `task.id | task.column |
resolved worktree | mergeDetails.commitSha | mergeDetails.rebaseBaseSha` — so a column move, merge
landing, or worktree swap misses immediately without needing an invalidator. The accepted envelope: new
commits inside an unchanged active worktree are visible ≤ 10 s late, which the 30 s client poll can never
observe because every poll outlives the TTL; a git-verified key would itself spend subprocesses on the hit
path, defeating the purpose.

## Proof

- Spawn-count guard (`routes-github.test.ts` stats-mode suite, real-git harness with a pass-through
  `mockExecFile`): `?stats=1` records **zero** per-file patch argv (`diff` argv containing `--` with a path
  element after it) and ≤ 1 whole-tree stat argv (`--numstat`/`--shortstat`) per lane; 3-file and 12-file
  fixtures produce **identical total** git spawn counts; a cache-served repeat spawns 0; a `column` or
  `mergeDetails.commitSha` change misses under a fake clock. All 9 tests were observed red on the route
  before the stats mode landed.
- Parity, lane by lane (active with committed+staged+unstaged mix, landed with own+foreign commits,
  rebase-range, foreign-only range → zeros, branch-ref fallback, multi-repo workspace, pure rename,
  binary): the `?stats=1` triple deep-equals the triple from the unparameterized full-detail response for
  the same repo state — the operator's number provably did not change.
- Full-detail parity: the unparameterized `/diff` keeps non-empty `files[].patch`, `?stats=1` carries no
  `files` key, and `TaskChangesTab`'s call passes a falsy stats flag (asserted).

In code, stamp `FNXC:TaskDiffStats` greps the parser, every fan-out replacement site, and the cache.
