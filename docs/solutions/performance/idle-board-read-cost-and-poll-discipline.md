---
category: performance
module: packages/dashboard, packages/core/src/task-store/reads.ts
date: 2026-11-18
problem_type: performance
severity: high
task: RUFU-479
tags:
  - board-load
  - read-cost
  - request-set
  - projection
  - read-scheduler
  - diff-lane
  - diagnostics
applies_when:
  - "The board renders seconds after the shell paints, and the browser trace shows the last API request finishing at 22-31 s"
  - "One 100-card page costs ~9-11 s server-side while a same-server `/api/settings/global` answers in 5 ms"
  - "42 of 63 requests in one board load start inside the same second and `/api/health` itself waits 10.4 s"
  - "A route is suspected of costing the whole single-process dashboard and no surface can name it"
  - "A diff lane costs 19-28 s and keeps costing it after the client has navigated away"
  - "Someone proposes a second projection layer, a new table, or a polling refresh for board currency"
---

# Idle board read cost and poll discipline (RUFU-479)

A board that is open and untouched was paying for everything the product could show. The fix is not one
query: it is four rules, each of which was already violated somewhere, plus a cost table so the next
regression names itself.

## The measured problem

Deployed dashboard (`prod-deploy @ 19814793f4`, project `proj_9326d74a133b421a`, 454 cards, real browser):

| Symptom | Measurement |
| --- | --- |
| Board settles | last API request at 21.9 s (46 requests) / 30.7 s (63 requests, still zero cards) |
| One page, solo | `GET /api/tasks/page?limit=100` 200, 1 243 945 B, t = 8.79 / 9.34 / 10.79 s |
| Same server, cheap route | `GET /api/settings/global` 200, 22 371 B, t = 0.005 s |
| Thundering herd | 42 of 63 requests start in the same second; `/api/health` waited 10.4 s |
| Repeated read | `/api/settings/global` fetched 4x by ONE board load |
| Wrong-view reads | `/api/evals`, `/api/insights`, `/api/goals`, `/api/notes`, `/api/ai-sessions`, `/api/voice/status`, `/api/stash-recovery/orphans`, per-mission N+1 |
| Slowest single requests | `/api/tasks/RUFU-457/diff` 21.1 s, `/api/tasks/RUFU-452/diff` 19.8 s (during a board load) |
| Where the CPU goes | 10 s heap profile: 251 MB, `parse` 47.8 MB, `rowToTask` 45.3 MB, `fromJson` 42.8 MB, `DataRow` 30.8 MB |

Pagination was never the problem: `/tasks/page` defaults to `limit 100` and rejects outside 1..200, the board
uses cursor continuation, lane heads use `order=queue limit 50`. A 100-card page still costs 9 s, so the cost
is per-card work.

## The four rules, and the number each one moved

### 1. A lane read selects the columns its consumers declare

Already built (RUFU-902, parity-proved) and already OFF. The remaining work was a decision, a measurement, a
default flip, and wiring the two readers that never asked. Read-only against the live project, first 100
cards, wire-shaped (`JSON.stringify` of the row set):

| SELECT shape | bytes | B/card | SQL |
| --- | --- | --- | --- |
| whole row (`select *`) | 6 187 083 | 61 871 | 36 ms |
| slim (`log`, `search_vector` excluded) | 2 228 327 | 22 283 | 32 ms |
| board feed (what ships) | 1 666 134 | 16 661 | 11 ms |

**3.71x cheaper than the whole row, in bytes and in server ms.** Per-card distribution of the shipped shape:
p50 14 553, p95 40 270, max 85 559. What is left is what the board renders: `workflow_step_results` 49 %,
`description` 13 %, `merge_details` 10 %, `modified_files` 8 %.

The bigger lever was not the whole-board page. It was `listTaskQueuePageImpl` (the per-lane read) and the
board-workflows internal `Done` read, which were neither compacted nor projected: neither `compactBoardFeed`
nor the projection had ever been offered to them.

Two things a re-measurement must not get wrong:

- `search_vector` is 16 % of a naive replication of the page and is ALREADY omitted by
  `LIST_READ_OMITTED_COLUMNS`. A replication that subtracts only `log` overstates the shipped cost by
  ~2.3 kB/card and under-credits the trade.
- The `source_metadata` key-projection costs PostgreSQL CPU: measured +1.49 ms per 100-card page
  (whole-blob 2.83 ms -> key-projected 4.316 ms) against a page the node answers in seconds. The trade lands
  the opposite way to RUFU-615's rejected `log` key-projection, because `log` is megabytes and toasted and
  `source_metadata` is kilobytes.

Rollback is one statement: `FUSION_BOARD_FEED_PROJECTION=0` restores the wide query. An unrecognised value
keeps the default, so a typo cannot silently disable the projection.

### 2. Read what is in view, and only in view

- The board's lane-read set now has ONE owner (`app/api/client/board-request-scope.ts`:
  `buildBoardLaneScopes`, `hasBoardLaneScope`, `laneQueueScopeForColumn`). A 5-column board issues 4 lane
  reads and 0 unscoped; mobile with one visible column issues exactly 1; an off-screen view issues 0; a
  hidden or complete lane is never read; a narrowing of the visible set aborts and re-reads only the
  affected lane.
- The whole-board mount read STAYS. It is the only answer that can say which lanes exist, and a patch
  cannot express a removed lane (RUFU-493). "0 unscoped reads" is therefore asserted over the board's
  lane-read set, not over the mount.
- Native-structure candidate reads (`/api/goals`, `/api/insights`, `/api/evals`, `/api/missions`, roadmap
  list + per-roadmap detail) are assembled only where they are consumed, i.e. when the mailbox view is
  active. A board view issues ZERO of them; a project change clears them first; re-entering the mailbox in
  the same project reuses the completed load. The same reads moved off raw `fetch` onto `api()`, because a
  raw fetch opts an endpoint out of the bounded read queue and out of per-pattern accounting.
- Chrome reads that are not the board (`/api/stash-recovery/orphans`, the shared Notes list) are deferred to
  idle instead of firing inside the mount burst. Deferred, not gated: a badge that silently never arrived is
  a wrong badge. The deferred badge read inherits the visibility rule of the poll it belongs to
  (`document.visibilityState === "hidden"`), so a background-tab mount still issues nothing.
- `/api/settings/global` went from 4 reads per board load to 1, behind a 5 s in-memory TTL with invalidation
  on write. Two rules come with it: the payload can carry `daemonToken`/`githubAuthToken`/`gitlabAuthToken`,
  so it is NEVER written to browser storage; and a read-modify-write of a whole map
  (`dashboardCurrentProjectIdByNode`, `experimentalFeatures`) must read with `forceFresh`, because merging
  onto a snapshot up to a TTL old silently drops a sibling key.

### 3. An abandoned read must stop costing the machine

The diff lane answered for 19.96-28.35 s after the client had navigated away, in the same single process that
was trying to answer the board. Cancellation is per-request and server-side, via `AsyncLocalStorage`
(`routes/diff-request-signal.ts`), because `runGitCommand` is reached from many shared helpers and threading
a signal through their signatures would miss the next helper added. Two deliberate limits:

- Only `/tasks/:id/file-diffs` is cancellable. The `?stats=1` lane is a single-flight rendezvous whose
  computation answers every joined waiter, so one departing client is not entitled to kill shared work.
- `killSignal: "SIGKILL"` is attached only when a signal exists; an un-cancelled diff keeps the historical
  SIGTERM-on-timeout behaviour.

A test note that cost a debugging cycle: mocking `node:child_process.execFile` must keep its REAL arity
`(file, args, options, callback)`, because `util.promisify` appends the callback. A three-parameter mock
receives the callback as `options`, never calls it, and the suite hangs instead of failing.

### 4. Presence answers from one owner, and every route is bounded

`invalidateRuntimeCliProbeCaches()` also resets the gh CLI cache. `resetGhAvailabilityCache()` was exported,
documented as THE invalidation hook, and had no production caller, while the sibling that already had four
callers returned a body containing the gh verdicts - so one operator Refresh cleared five probes and kept
serving a gh answer up to 60 s stale. The ratchet (`gh-probe-call-site-guard.test.ts`) could not see this: it
only inventories call sites, not invalidation ownership.

Cost accounting now exists on both sides. Server: `src/metrics/route-cost.ts`, keyed on
`METHOD + matched route template` (never a raw URL), ring-buffered at 256 samples per route and 256 route
templates with oldest-inserted eviction, read at `GET /api/diagnostics/costs`. Client:
`app/api/client/request-stats.ts` at the single `api()` seam, normalising ids to `:id`. Both are
in-process memory and both clear on restart or reload - this is a diagnostic table, deliberately NOT a
run-audit row (no sink, no migration, no replay).

## Two traps this card fell into and recorded

1. **A guard that closes behind an await is not a guard.** Moving a whole-map write's merge base from an
   in-memory snapshot to a fresh read also moved the line that publishes the claimed value. The
   re-render-dedupe guard above it reads that ref, so it opened again for the whole fetch window: one manual
   project switch turned into six settings reads. Claim synchronously, merge afterwards.
2. **A published bound that real data exceeds is a false green with a delay.** The first ceiling (12 600
   B/card, half the Step 0 log-excluded figure) sat below the live p50 of the shape it bounded (14 553). A
   ceiling must be derived from the distribution of the shape it governs: 20 000 / 10 000 B/card now, still
   3x below a whole-row regression and backed by an absent-column assertion.

## Verification that counts as evidence

`pnpm test:gate` (engine-core 549, core unit-gate 210, cli ci-shape 76; pg gate files SKIP with the
harness's own reason when no authenticable PostgreSQL exists), `pnpm smoke:boot` (real serve + `/api/health`),
`pnpm typecheck` including `tsconfig.app.json` (the per-package `tsconfig.json` alone misses app sources),
`pnpm build`, and the recorded numbers above. Green suites are not the acceptance; the numbers are.

## Landed siblings this extends rather than duplicates

- `list-tasks-derive-optout-and-memo.md` - the engine-side read cost and the declared-field mechanism; the
  board feed is the board's consumer of that mechanism, and its default-ON decision plus the two readers that
  never asked are what this card added.
- `task-diff-stats-mode-one-stat-subprocess.md` - the stats-only diff seam and its one-subprocess budget;
  this card adds the TTL/poll pairing (accepted staleness: the `+N ~M` badge may lag up to
  `TASK_DIFF_STATS_CACHE_TTL_MS`), the within-TTL zero-invocation witness, the 60-commit two-call bound, and
  per-request cancellation of the patch fan-out.
- `done-range-attribution-subprocess-batching.md` - done-range attribution's call budget; this card's
  60-commit case holds that budget flat at three times the commits.

In code, `FNXC:IdleBoardReadCost`, `FNXC:BoardReadProjection`, `FNXC:RouteCostAccounting`,
`FNXC:GlobalSettingsCache`, `FNXC:DiffLaneCancellation` and `FNXC:TaskDiffStats` grep the decision sites.
