---
category: test-failures
module: testing
date: 2026-09-04
problem_type: suite_only_flake
component: Vitest workers / Node native HTTP/2
severity: high
applies_when:
  - "A test file's whole-file invocation OOM-kills the host while per-case runs are green"
  - "RSS climbs hundreds of MB/s while the V8 heap stays near empty"
  - "Profiling a vitest worker pathology produced only the launcher's profile"
  - "A unit-suite verification dispatch is expected to touch no network yet the suite makes real requests"
tags:
  - vitest
  - oom
  - profiling
  - node
  - http2
  - undici
  - network-dead-tests
---

# Profiling a vitest worker allocation storm (and why the suite must be network-dead)

RUFU-186 root-caused the register entry 15 pathology: whole-file
`packages/engine/src/notification/__tests__/notification-service.test.ts` OOM-killed the host
(killed at 62–68 GB RSS; bounded runs died at the 6G cap ~15 s in) while every `-t`-filtered run
was green in seconds. This doc keeps the *method* and the *safe-run recipe* durable so the next
author does not re-derive either.

## The failure signature

- Deterministic, not load-dependent: dies at the START of one specific case, always the same one,
  but only when an earlier describe ran in the same process. "Which earlier describe" is a clue, not
  the cause — what accumulates may simply be egress attempts.
- RSS grows ~350 MB/s from a normal ~550 MB plateau; the 1 Hz in-test probe stops ticking (the
  event loop starves before any timer/await can report anything).
- **V8 reports a near-empty heap** (6 MB used under a 4 GB cap). Heap snapshots,
  `--heapsnapshot-near-heap-limit`, and `--cpu-prof` (which GC-thrashes instead of naming a site)
  are all dead ends: the allocation is off-heap native, too fast to GC, and too transient to retain.
- Exit is a kill, not a test failure: `WTERMSYS=1` means SIGKILL (cgroup `memory.peak` ≈ the cap,
  `memory.events:max` climbed). Kernel journal shows `anon-rss` in the tens of GB.

## Root cause (the RUFU-186 instance)

The harness settings defaulted to `{ ntfyEnabled: true, ntfyTopic: "topic" }` with no
`ntfyBaseUrl`, so the service under test built a **real production `NtfyNotificationProvider`**
(base URL `https://ntfy.sh`) and the file never stubbed `fetch` — a unit suite was pushing real
HTTPS requests to a public endpoint. On Node 26.7.0, undici's `fetch` negotiates HTTP/2 over TLS,
and Node's native `Http2Session::SendPendingData → CopyDataIntoOutgoing` enters a
geometric-doubling `operator new[]` loop (an interposer capture recorded 51.5 GB requested across
35 events ≥ 4 MB, 256 MB → 16 GB per request). The ordering trigger was cross-describe **egress
attempt count**, not in-file state; no product defect — but CI had been receiving real pushes to a
public topic named `topic` until the fix.

**Fix shape:** stub `fetch` at file top (the sibling convention — see
`packages/engine/src/__tests__/webhook-provider.test.ts`,
`packages/engine/src/cli-agent/__tests__/chat-recall-provisioner.test.ts`, and
`packages/engine/src/__tests__/mock-provider.test.ts`), and *assert* the dispatch reached the fake
(so the test stays stronger than the accidental live call it replaces). A permanent tripwire guard
belongs in the same file: patch `net.connect`/`tls.connect`/`http2.connect` via `createRequire` to
record and **synchronously refuse** any non-loopback socket attempt — a refused connect cannot feed
the native storm, so guard regressions fail fast as a named assertion instead of an OOM kill.

## Method that actually sees the worker

1. **Launcher-vs-worker trap (always check first).** `packages/engine/vitest.config.ts` sets
   `pool: "threads"`; `NODE_OPTIONS=--cpu-prof/--heap-prof` then profiles only the **launcher** and
   workers never flush — structurally, not by bad luck. Use a diagnostic config with
   `pool: "forks"` (and `poolOptions.forks.singleFork: true` to eliminate worker reuse as a variable
   and keep output linear). Proof the override took effect = a `.cpuprofile` exists in the prof dir.
2. **Bound the run before instrumenting it** (see recipe below). Every storm-probe run must be
   unable to hurt the host: the cgroup cap, not the V8 heap cap, is the real fence — native
   allocations bypass `--max-old-space-size` entirely (a run rode a 4 GB heap cap to a 5.5 GB kill).
   Note the worktree sandbox rejects writing scratch outside the worktree — put probes/logs in
   `packages/engine/.tmp-prof/` (never-commit list), not `/tmp`.
3. **Prove off-heapness with a 1 Hz RSS-vs-heap probe** (per-worker, via `--require`): RSS climb
   against a flat small heap usage rules out a retained-object leak and points at native/synchronous
   allocation. A worker probe that self-aborts at an RSS threshold keeps the probe itself bounded.
4. **Name the JS caller cheaply before reaching for native tooling.** A `--require` probe that
   monkey-patches `http2.connect`/`tls.connect`/`net.connect` (via `createRequire` — works in the
   worker, visible to undici) records authority/port plus a JS stack. One run names the suite's real
   network caller; Node 26.7.0's `http2` streams have no patchable prototype method, so probe
   success writes = 0 at the stream layer is NOT evidence of absence — check the connect layer.
5. **Name the native allocation site with an interposer.** When the caller is Node's own (undici →
   native h2), LD_PRELOAD an `operator new[]` interposer that logs requests ≥ 4 MB with the calling
   frames and geometric backoff. Capture per-fork log files (= per-worker heap-allocation profiles)
   to keep attribution honest across processes. A `writes=0` result at one layer is only proof for
   that layer.

## Safe bounded-run recipe (host-safety first)

```bash
systemd-run --user --scope -p MemoryMax=6G -p MemorySwapMax=0 --quiet \
  env NODE_OPTIONS=--max-old-space-size=4096 timeout 300 \
  pnpm --filter @fusion/engine exec vitest run src/<path>/<file>.test.ts
```

- `MemorySwapMax=0` is **mandatory on a swap-starved host**: without it the cgroup silently
  offloads the storm to swap and the 6G cap becomes advisory for RSS accounting purposes only.
- The probe/peak evidence that convinced: in-scope `memory.peak` (cgroup) after the run plus a 1 Hz
  `memory.current` sampler; expect a flat curve (a few hundred MB) on a fixed suite vs a
  hundreds-of-MB/s ramp to the cap on the unfixed one. An A/B where both outcomes are bounded and
  green-or-killed-in-seconds is the honest causality experiment shape.
- Sampling gotcha: inside a transient `systemd-run --scope`, `/proc/self/cgroup`'s path must be
  joined onto `/sys/fs/cgroup` carefully (`awk -F'::' '{print $2}'` — field 2, not 3), or the
  sampler silently produces nothing and the gate "passes" without evidence.

## Resolution pattern for the whole class

A unit/integration suite must be **network-dead by harness construction**, not by luck: stub the
transport (`globalThis.fetch` for undici-backed code paths), keep the assertion *inside* the stubbed
path (record + assert the URL), and — for files whose harness has previously escaped — a
connect-layer tripwire that converts a future live egress into a fast red with a named target
(`tls->host:port` × N) rather than a host-threatening storm. Red-before/green-after for such a
guard is demonstrated safely: disable the stub, keep the tripwire, run bounded — the tripwire's
refusal makes even the red run harmless. Register entry 15
([suite-only-flakes-observed-register.md](suite-only-flakes-observed-register.md)) records the
closeout; the red-then-green measurements live there and in that card's `profile-evidence` task
document.
