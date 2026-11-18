---
category: test-failures
module: "@fusion/engine"
date: 2026-11-18
component: "cron-runner.test.ts, pi.test.ts, chat-manager.test.ts, bubblewrap-backend.test.ts"
severity: high
problem_type: defect
applies_when:
  - "A suite that the gate never runs is reported red and nobody owns it"
  - "A real bubblewrap or sandbox case fails on a host where the binary demonstrably works"
  - "A suite goes red in a wall of ReferenceError naming an identifier that is exported and imported nowhere"
  - "A behavior change lands with guard semantics that its own fixtures still assume the opposite of"
tags:
  - RUFU-732
  - RUFU-334
  - stale-fixture
  - vitest-mocks
  - bubblewrap
  - bind-mount
  - model-lane-precedence
  - test-maintenance
---

# Four base-red suites: the verdicts, and the bind that silenced every sandbox

RUFU-334 documented four red suites on the default branch and owned none of them. RUFU-732 reproduced each
one at the tip, kept three, and found the fourth was never red where it was reported. Each verdict, its
measured baseline, and the command that re-derives it are recorded here so the next author does not have to
re-measure the ground.

## Verdict table

| Reported suite | Measured baseline at base `91ab8277b` | Verdict | Change that landed | Re-derive it |
| --- | --- | --- | --- | --- |
| `packages/engine/src/__tests__/cron-runner.test.ts` | 1 failed, 156 passed | Stale test | Expectation `medium` to `low` in the inherited-thinking case, retitled to name the winning lane; two stale precedence comments corrected | `pnpm --filter @fusion/engine exec vitest run src/__tests__/cron-runner.test.ts --silent=passed-only` |
| `packages/engine/src/__tests__/pi.test.ts` | 56 failed, 50 passed | Stale test plus missing imports | Imported `classifyCompactionFailure`, `isRetryAfterCompactionFailureLegal`, `CompactionOutcome`; one real throwaway session root replaced 52 fabricated `cwd` literals | `pnpm --filter @fusion/engine exec vitest run src/__tests__/pi.test.ts --silent=passed-only` |
| `packages/engine/src/__tests__/chat-manager.test.ts` | Reported file does not exist; the real suite `packages/dashboard/src/__tests__/chat-manager.test.ts` was 159 passed | Did not reproduce | Nothing. No fix was invented for a failure that is not there | `pnpm --filter @fusion/dashboard exec vitest run src/__tests__/chat-manager.test.ts --silent=passed-only` |
| `packages/engine/src/__tests__/sandbox/bubblewrap-backend.test.ts` | 1 failed, 4 passed | Real bug, in the product AND in the case | `BubblewrapBackend` now passes `existsSync` into `policyToBwrapArgs`; the case resets modules before its dynamic import and asserts containment | `pnpm --filter @fusion/engine exec vitest run src/__tests__/sandbox/bubblewrap-backend.test.ts --silent=passed-only` |

## The bind that made every sandboxed command fail

`policyToBwrapArgs` accepts a `pathExists` predicate and skips any read or write path whose source is not on
disk. The predicate defaults to "everything exists", because the policy builder is a pure function and its
unit tests pass fabricated paths on purpose. That default is a seam waiting for a caller to close it, and
`BubblewrapBackend` never did: `run`, `runStreaming`, and `wrapCommand` all handed over paths with no
predicate, so every one of them was emitted as a `--bind` or `--ro-bind`.

The paths include the pnpm store directory, which `resolvePnpmStorePath` takes from the output of
`pnpm store path --silent`. That output depends on the `$HOME` and `PNPM_HOME` of the calling process, so it
is a path the backend never verified. bwrap does not tolerate a missing bind source. It aborts the whole
invocation:

```
bwrap: Can't find source path /home/.pnpm-store/v10: No such file or directory
```

with exit 1, before `/bin/sh -lc <command>` runs. One absent directory therefore failed every sandboxed
command, with a message that names a directory and says nothing about the fact that the wrapped command was
never started. The fix is the seam the policy builder already exposed: pass `existsSync`. That can only ever
drop a mount, never add one, so containment is unchanged or narrower; the isolation flags, the read-only
system binds, the environment filter, and `--chdir` are untouched.

Two things made this invisible for its whole life. The integration case never reached bwrap (below), and the
unit cases called `policyToBwrapArgs` directly with fabricated paths, which is precisely the shape the
defaults-to-true predicate is there to tolerate. When the only case that exercises the real caller is the one
that silently does nothing, a defect sitting on the caller is unobservable.

## `vi.doUnmock` does not reach an already-evaluated module

The bubblewrap integration case called `vi.doUnmock()` and then re-imported the module under test. The module
under test was imported statically at the top of the same file, where a hoisted `vi.mock` had already bound
its dependency to the mock. `doUnmock` changes what a LATER import resolves; it cannot rebind a module
instance the file already holds. So the re-import handed back the same instance, still holding the mocked
`detectBwrap`, whose `mockReset()` value in `beforeEach` is `undefined`. `prepare()` read
`undefined.available` and threw `TypeError: Cannot read properties of undefined (reading 'available')`. The
case never built an argv and never spawned `bwrap`, while its name claimed end-to-end sandbox coverage.

`vi.resetModules()` before the dynamic import is what makes the unmock effective. The case now asserts the
detected capability it is about to depend on, so a host that ships `bwrap` on `PATH` but cannot create a
namespace reports a named verdict instead of a `TypeError`.

The case then proves containment, which its original assertions could not. `exitCode 0` and stdout `hello`
are exactly what an UNCONTAINED run of `echo hello` produces. The policy always passes `--unshare-pid`, so
inside the sandbox the `/bin/sh` the backend launches is PID 1 or 2, while a native spawn inherits the host
PID space. Asserting the small PID is a cheap, read-only witness that the command really ran inside a new
namespace. `hostname` is not such a witness: `--unshare-uts` on bubblewrap 0.13.0 reproduces the host
hostname, measured.

## An exported symbol absent from the import list is a whole-file red wall

`pi.test.ts` failed 56 of 106 cases. Eight were `ReferenceError` for identifiers that `src/pi.ts` exports and
the test's own import list did not name - `classifyCompactionFailure`, `isRetryAfterCompactionFailureLegal`,
and the `CompactionOutcome` type. Vitest collects the file, so one missing name is reported per use site, not
one, which is why eight became a wall. Read the first error's identifier and grep it against the import
statement before reading any assertion.

The other 48 were `the path cannot be resolved` and had a different owner: RUFU-334 landed
`assertAgentCwdAllowed` with the rule that a session working directory whose `realpath` fails is a hard
refusal, and every session case in the file passed a fabricated path as `cwd`. That is 48 fixtures asserting
a leniency the guard deliberately removed. The fix belongs at the shared fixture, not per case: one real
throwaway directory, created once, removed in `afterAll`.

A real directory then has to be given two properties a fabricated path got for free. It must not be a git
checkout, or the boundary-inference cases measure the repository the test run happens to live in, which is
why it is a temp directory rather than one inside the repo. And its project-root resolution has to be made
deterministic, which is the next section.

## A `.fusion` marker leaked into the OS temp root

`resolvePiExtensionProjectRoot` walks ancestors for a `.fusion` directory with no bound. On this host
`/tmp/.fusion/tasks/` exists, created 2026-11-13, empty. Any temp-rooted fixture therefore resolves its
project root to `/tmp`, so the assertion "no marker above me, so my path comes back unchanged" is not
satisfiable here at all. The same pollution independently reddens
`packages/core/src/__tests__/pi-extensions-project-root-cache.test.ts` (measured: 1 failed of 5, expected the
fixture's own nested path, received `/tmp`).

The engine suite now gives its fixture its own `.fusion` marker, so the walk-up terminates at the fixture on
every host, and the subdirectory case asserts what the seam actually guarantees - the skill resolver receives
the resolved project root, never the raw `cwd` - rather than depending on a host-wide negative. Two
conclusions for the next author: a fixture that expects a marker-free ancestor chain is asserting the state
of the machine, and the unbounded walk makes that state load-bearing.

## Why three of four could stay red unnoticed

Both facts are measured, and both are the systemic gap this card was written around.

`packages/engine/tsconfig.json` excludes `src/__tests__/**/*`, so a missing import or a wrong expectation in
an engine test is invisible to typecheck. `eslint.config.mjs` lists `packages/!(dashboard)/**/__tests__/**`
in its ignore set, so lint stays silent about those same files - verified by passing three of these suites to
`eslint` explicitly and getting "File ignored because of a matching ignore pattern" for each. Neither of the
two blocking CI gates could see any of these failures: lint skipped the files, typecheck skipped the files,
and the merge gate runs a curated engine-core allow-list that contains none of them. The failures were only
ever visible in a full-suite run, which is non-blocking on push to `main`.

## Related findings left alone deliberately

- `pnpm check:quarantine-ledger` (`--strict`, a `pr-checks.yml` step) exits 1 on the default branch over three
  quarantines past their 14-day deletion clock: `AgentDetailView.core.test.tsx` and
  `TaskPlannerChatTab.virtualization.test.tsx` (58 days overdue) and `executor-prompt.test.ts` (30 days). The
  deletion ratchet says expired means deleted unless rescued. None of the three is one of these four suites.
- Name-adjacent dashboard suites are red for their own unrelated reasons and were not touched:
  `resolve-chat-manager-plugin-runner.test.ts` fails at collection on an unbuilt
  `@fusion-plugin-examples/antigravity-runtime` entry in an unbootstrapped worktree, and
  `chat-manager-stream-fidelity.test.ts` fails a RUFU-234 byte-fidelity expectation.
- Two more comments still describe the removed model-lane precedence and were outside this card's file scope:
  `packages/dashboard/src/routes/automation-step-execution.ts:241` lists the order without the
  selected-workflow lane at all, and `packages/engine/src/triage.ts:4449` still puts the project lane and the
  global lane above the selected-workflow lane for planning sessions. Both helpers involved resolve the
  workflow lane first, so both sentences are wrong in the same way the two corrected ones were. A comment that
  misstates a precedence is how a wrong assertion gets written again.
- Stale test names outlive their rename only if the rename says so. The case renamed here keeps its old title
  in the correction comment, so a grep for the old name still lands on the explanation.
