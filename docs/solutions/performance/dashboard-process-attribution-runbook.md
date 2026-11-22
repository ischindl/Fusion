---
title: "Which dashboard process am I measuring? (process attribution)"
problem_type: performance
module: packages/core/src/process, packages/dashboard/src/routes, packages/cli/src/commands/dashboard-tui
category: performance
tags: [process-attribution, pgrep, procfs, kill-vitest, dashboard-pid, cross-checkout, RUFU-760]
applies_when: "Before quoting any process count, RSS figure, or kill result that came from a pattern match (`pgrep -f ...`), and before signalling any process you did not spawn."
---

## The trap

`pgrep -f <pattern>` matches **full command lines across the whole machine**. It answers "which
processes on this host mention this string?" and never answers "which process belongs to the checkout
I am looking at?" Two checkouts of the same repository, or a developer's laptop dashboard and the
deployed one, therefore arrive as one number.

Two measured mis-reads, both from this exact shape:

- **The summed-RSS "second generation" (RUFU-760's withdrawn premise).** `pgrep -f 'bin.js dashboard'`
  on the production host returned two pids. Their RSS values were added, and the total was read as one
  wedged extra dashboard generation that the watchdog had supposedly spawned and lost track of. The
  two pids were two different checkouts. The concurrency claim was retracted by the operator; the
  measurement artifact is the durable lesson and is recorded under
  [What this card's correction actually changed](#what-this-cards-correction-actually-changed).
- **The wrong-checkout kill.** `POST /api/kill-vitest` and the terminal dashboard's memory-pressure
  auto-kill both took their pid list from `pgrep -f vitest`, narrowed by executable only. Pressing
  "Kill vitest" in one project's Command Center SIGKILLed a vitest worker that belonged to a different
  checkout on the same machine.

Both are the same invariant failure as *measure the leg, not the folder* (`AGENTS.md`, lane-leg
measurement): a read that succeeds is not automatically a read of the thing you asked about.

## Attribute the process before you trust the number

Run this in order. Steps 1 and 2 are the whole method: **ask the socket who answers, then ask the
kernel where that process stands.**

```bash
# 1. Who actually holds the port? Not the pid file, not a pattern match.
ss -ltnp -H "sport = :4040"

# 2. Which checkout is that pid standing in?
readlink /proc/<pid>/cwd

# 3. Only now is a per-pid row safe to quote. Never sum rows across cwds.
ps -o pid=,ppid=,lstart=,rss=,args= -p <pid>
```

Notes that decide verdicts:

- **The pid file is not an identity.** `~/.fusion/dashboard.pid` records who *last wrote it*. If it is
  empty or stale, that is a fact about the file, not proof of a second server. The socket is the
  authority for "who is answering on 4040".
- **A ` (deleted)` suffix is a real answer, not a failure.** `readlink /proc/<pid>/cwd` prints
  `/path/that/no/longer/exists (deleted)` when the directory was removed while the process kept
  running — the normal shape of a task worktree that was cleaned up under a live process. Strip the
  suffix, then decide from the path; `packages/engine/src/util/orphaned-git-child-reaper.ts` handles
  the same suffix for the same reason.
- **`readlink` failing is not "foreign".** Permission (another uid) or an exited-between-calls process
  gives you nothing. Nothing is not evidence of anything; say "unattributed" in your notes.
- **macOS has no `procfs`.** Use `lsof -a -p <pid> -d cwd -Fn` and read the line starting with `n`.
- **`readlink -f` vs `readlink`.** The kernel's cwd link is already resolved; `-f` additionally
  resolves symlinks in the printed path, which on macOS `/tmp` shapes can make a path *look* different
  from the one you are comparing against.

If step 1 yields more than one listener, that is a finding to report per pid — attributed — not a
number to add up.

## The invariant Fusion now enforces

> A process may be counted or signalled by Fusion only once its working directory has been attributed
> to the project being acted on. Unknown ownership is never treated as foreign ownership.

Implemented in one place per concern:

| Concern | Where |
| --- | --- |
| Read a pid's cwd, and decide where the process table lives | `packages/core/src/process/proc-cwd.ts` (`resolveProcRoot`, `readProcessCwd`, `readProcessCwds`, `isCwdAttributedTo`) |
| Split candidates into killable / proved-foreign / unattributed | `packages/core/src/process/vitest-processes.ts` (`findVitestProcessInventory`) |
| Command Center count and kill share one resolution | `packages/dashboard/src/routes/register-system-maintenance-routes.ts` |
| The TUI auto-kill follows the board's own project | `packages/cli/src/commands/dashboard-tui/controller.ts` (`killVitestProcesses`) + `onResolveWorktreesDir` in `TUICallbacks`, implemented in `packages/cli/src/commands/dashboard.ts` |
| Which roots a project owns | `resolveWorktreesDirCandidates()` in `packages/core/src/tasks/worktree-layout.ts` |

The verdict table, because it is what an operator needs when a kill "did too little":

| Candidate state | Counted? | Signalled? | Reported as |
| --- | --- | --- | --- |
| cwd is inside the project checkout or one of its managed worktree roots | yes | yes | in `pids` |
| cwd resolved and lies outside every root | no | no | `foreignPids`, logged with its cwd |
| cwd unreadable (no `procfs`, other uid, exited mid-scan) | yes | yes | `unattributedPids`, still in `pids` |
| No `procfs` at all (macOS), or no usable scope root | yes | yes | `scoped: false` — the pre-attribution machine-wide set |
| Windows | no | no | empty (pgrep/ps are POSIX) |

Two consequences worth knowing before debugging:

- **A spare is visible, not silent.** When the route suppresses foreign pids it logs each pid with its
  resolved cwd; the TUI logs a suppressed count. "Killed 0" plus that line is a complete explanation.
- **Scope is per request/project.** `GET /api/system-stats`'s `vitestProcessCount` and
  `POST /api/kill-vitest` resolve the same set for the same request, so the number you read is the set
  the button acts on. A configured `worktreesDir` is exclusive, and it is read from the *viewed*
  project's own store, not from the project the dashboard was launched in.

## Writing a test that names a synthetic pid

A pid like `1001` exists on some test runners and not others, and a test whose result depends on that
is a flake this repo quarantines on sight. So a test never reads the host's process table:

- `resolveProcRoot()` precedence is explicit option, then `FUSION_PROC_ROOT`, then `/proc` — and
  `FUSION_PROC_ROOT` is honored **only when the runner set `VITEST`**, so a stray environment variable
  in a real dashboard process can never redirect attribution.
- A test creates a temp proc root, sets `FUSION_PROC_ROOT`, and lays down
  `<procRoot>/<pid>/cwd -> <checkout>` with a symlink. The substituted input is the proc table's
  *location*; the resolver, the link read, and the attribution decision all run for real.
- Route and TUI tests additionally stub `execFile` so no real `pgrep`/`ps` runs, and assert with a
  `process.kill` spy.
- Production callers pass **no** `procRoot`. If you are tempted to inject one outside a test, the
  single decider is the thing you would be bypassing.

See `packages/core/src/__tests__/proc-cwd.test.ts`,
`packages/core/src/__tests__/vitest-processes.test.ts`,
`packages/dashboard/src/__tests__/routes-system.test.ts`, and
`packages/cli/src/commands/dashboard-tui/__tests__/vitest-kill-scope.test.ts`.

## What this card's correction actually changed

RUFU-760 opened as "the watchdog can run two dashboard processes at once; it loses its own pid". That
claim is **withdrawn** and must not be re-minted from the card's original description: the two pids
were two checkouts, and the doubling that was read from their summed RSS was the measurement, not the
system. What survived the correction, and what this card shipped, is narrower and still true:

1. process attribution was not a product invariant anywhere in this code path, and one of the two
   consumers sends `SIGKILL`;
2. the late-kill measurement recorded in the card's history was itself taken through an
   unattributed probe, so it needed the same re-reading as the RSS figure.

Retitling the card was the operator's request precisely so the withdrawn premise could not be
inferred from its title later. If you find a future report of "two dashboards", the fix is the three
commands above, not a new concurrency theory.

## Do not

- Do not quote a `pgrep -f` count as "the Fusion processes" without attributing each pid first.
- Do not treat a missing cwd read as proof of a foreign process; that would let an unreadable
  process escape a kill the operator asked for.
- Do not widen a destructive scope when a lookup fails. Returning the partial root set (or the
  documented unscoped set on a platform with no `procfs`) is the honest degrade; silently narrowing to
  nothing answers an operator's "Kill vitest" with a no-op and no reason.
- Do not rewrite the heap-growth runbook's `ss -ltnp` guidance here; it owns that surface. This file
  only adds what to do with the pid it hands you.

## Related

- `docs/solutions/performance/dashboard-heap-growth-runbook.md` — the RSS/heap side of the same
  process: how to find the leaking structure once you know which process you are holding.
- `docs/solutions/performance/heap-floor-probe-runbook.md` — what a measurement lane may claim.
- `packages/engine/src/util/orphaned-git-child-reaper.ts` — prior art for `(deleted)` cwd handling.
- `AGENTS.md` → *Standing Rule: A Workspace Leg Must Be Its Own Repository Before Anything Measures
  It* — the sibling invariant: measure the thing, not the path that names it.
