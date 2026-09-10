---
category: performance
module: packages/engine/src/execution/verification-resource-bound.ts
date: 2026-09-10
problem_type: performance
severity: high
applies_when:
  - "A single verification spawn (vitest/pnpm build) pegs several cores and the board/terminal feels the stall, even though only one verification runs at a time"
  - "maxConcurrentVerifications is already at its cap and the CPU pain persists — the count cap bounds how many workers run, not how much CPU each one may take"
  - "Deciding whether a systemd cgroup property can carry a bound on a given host (CPUQuota/CPUWeight/IOWeight/MemoryMax vs Nice=, which systemd-run --scope rejects)"
  - "Any wrapper around a supervised spawn on this host must keep the negative-pgid group kill reaching the whole payload tree"
component: engine
tags:
  - performance
  - cpu-bound
  - systemd-run
  - cgroup
  - cpuquota
  - nice
  - ionice
  - supervision
  - pgid-kill
  - fnxc-verificationresourcebound
related_components:
  - engine
  - core
  - dashboard
---

# Bound verification children's CPU, not just their count (RUFU-212)

## Symptom

`maxConcurrentVerifications` (cap 1–8, process-global, min-of-registered-project-caps) bounds how
many verification commands stack. It never bounded how much of one worker a single command's process
tree may consume. Measured live during spec authoring (2026-09-09): a **file-scoped** run —
`vitest run <two named test files>`, the repo's *recommended* verification shape — measured
**152% CPU** for the vitest child plus an **~40%** esbuild service child (~190% combined, ~1.9
cores), for a chain that existed only 7–14 s per burst. The pnpm verification process is a direct
child of the UI-serving dashboard pid, so those bursts are exactly what operators feel as UI stall.
A fix that only bounded marathon commands would not cover this shape.

Two measurement traps observed while capturing this: a one-shot `ps`/subtree count returns a false
negative between bursts (load averaged ~11 while `vmstat` showed ~73–83% idle in the same minute),
and defunct-git counts are ephemeral. Observe over a window spanning at least one dispatch, and
assert the bound, not the absence of children.

## Fix

`packages/engine/src/execution/verification-resource-bound.ts` wraps each verification-class spawn
in a resource envelope, resolved project → global → machine built-in:

| Dimension | Setting | Built-in (both tiers unset) | Disable |
|---|---|---|---|
| CPU quota | `verificationCpuQuotaPercent` | `max(100, cores × 50)` % of one core (≈half the machine) | `0` |
| CPU/IO share | `verificationCpuIoWeight` | `10` (systemd scale, 100 neutral — yields to interactive work) | `0` |
| Memory | `verificationMemoryMaxMb` | unset (opt-in — CPU is the delivered fix) | `0`/unset |

Rungs, probed once per process (cached; three `true` spawns, never `execSync`):

1. **`scope`** — `systemd-run --user --scope -p CPUQuota=… -p CPUWeight=… -p IOWeight=…
   [-p MemoryMax=…]`, with `exec` so the wrapper replaces the shell leader.
2. **`priority`** — `nice -n 10` (+ `ionice -c3` when available) when no systemd user manager exists.
3. **`bare`** — today's command unchanged (CI runners), plus one warning. A bound never fails a
   verification.

Wrapped lanes: `fn_run_verification` tool (`tool`), deterministic `runVerificationWithConcurrency`
including project-engine startup verification (`deterministic`), and the bounded-retry
fix-repair spawn (`fix-repair`). Sandbox-confined lanes (`id !== "native"`) are **not** additionally
wrapped. Machine aggregate = most-conservative-of-registered (mirrors the count-cap registry); a
fully-disabled profile never unbinds the machine for peers.

## Probed properties on this host (systemd 261, cgroup2fs, `XDG_RUNTIME_DIR` present)

| Assignment | Result |
|---|---|
| `-p CPUQuota=50%` | **accepted** (exit 0) |
| `-p CPUWeight=10` | **accepted** |
| `-p IOWeight=10` | **accepted** |
| `-p MemoryMax=2G` | **accepted** |
| `-p Nice=10` | **rejected** — `Unknown assignment: Nice=` in `--scope`; niceness must come from the `nice` wrapper |
| `-p IoWeight=10` | **rejected** — capitalization matters: `IOWeight=` is the accepted spelling |

`nice -n 10`, `ionice -c3`, and `taskset` all exist on the host. GitHub-hosted CI
(`ubuntu-latest`) has no usable systemd user manager, so CI exercises the fallback rungs and the
injected-probe tests, never a live quota.

## Why `--scope` keeps supervision honest

`superviseSpawn`'s timeout/cancel kill is `process.kill(-pgid)`, which relies on the detached child
leading its own process group. Proof on this host: `setsid sh -c 'exec systemd-run --user --scope
-p CPUQuota=50% -- sh -c "sleep 31 & sleep 31 & wait"'` — payload children carried
`ppid=LEADER`/`pgid=LEADER`, and `kill -KILL -<pgid>` left **zero survivors**. A `--scope` unit
joins the caller's unit but does **not** re-lead the process group, so the negative-pgid kill still
reaches the whole payload tree (no immortal-grandchild escape). The real-git regression test pins
this: a bounded `git status` loop is group-killed with **0** descendants named in the command
surviving — the cgroup property did not shield them from the pgid kill.

## Visibility

The applied rung is reported in the verification result text (`resource bound: CPUQuota=… weight=…
(systemd scope)`), and a pair of run-audit events (`verification:resource-bound-engaged`,
`verification:resource-bound-sustained` ≥ 120 s, bounded-emitter, ids/buckets only) records
hostile-sink-safe history. See [run-audit.md](../../run-audit.md) → *Verification resource bound
events*.

## Explicitly not included

**Out-of-process isolation is not included.** Verification still runs as a child of the
dashboard/engine process; this fix bounds that child's CPU (and optionally memory) share, it does
not relocate it to a separate daemon or container. Multi-host / remote execution remains a separate
concern.
