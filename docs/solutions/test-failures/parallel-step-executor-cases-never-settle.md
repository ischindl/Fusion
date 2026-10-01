---
category: test-failures
module: "@fusion/engine"
date: 2026-09-02
problem_type: pre_existing_hang
component: step-session-executor
severity: high
status: resolved
applies_when:
  - "Running `src/__tests__/step-session-executor.test.ts` and seeing `Test timed out in 30000ms` in the `parallel execution` describe"
  - "A hand-written `node:child_process` mock needs to support a product path that newly uses `promisify(execFile)`"
  - "A review or verification pass attributes never-settling test timeouts to the change under review"
tags:
  - hang
  - never-settles
  - step-session-executor
  - parallel-execution
  - false-red
  - pre-existing
  - mock-drift
  - promisify
---

# Parallel step-executor cases never settle: a bare `execFile: vi.fn()` never fires its callback

Observed 2026-09-02 on `fusion/rufu-172` while verifying RUFU-172; **root-caused and fixed the
same day on that card** — this document now records the diagnosis and the fix so a later session
recognizes the pattern instead of re-deriving the hang. Eight consecutive review passes on that
card each rediscovered the hang from scratch and exhausted their session budget doing it, so the
Code Review node reported "failed before producing a verdict" with no findings at all.

## Symptom

Nine cases in the `parallel execution` describe failed with `Error: Test timed out in 30000ms`,
while the rest of the file passed:

```bash
pnpm --filter @fusion/engine exec vitest run \
  src/__tests__/step-session-executor.test.ts -t "parallel execution"
# Tests  9 failed | 2 passed | 119 skipped (130)   Duration ~276s
```

Every failure was a timeout, never an assertion — and raising the budget only moves the wall:
a 120-second `testTimeout` timed out at exactly 120 s. An await never settled.

## Root cause

The test file's hand-written `node:child_process` mock exported `execFile: vi.fn()` — a bare mock
that **never invokes its callback**. FN-251's defensive-removal probe
(`assertCleanForDefensiveRemoval` in `worktree-backend.ts`) runs `git status --porcelain` through
`promisify(execFile)` on every `removeWorktree({ reason: StepSessionCleanup })`, which is exactly
what each parallel-step wave cleanup does. With the callback never firing, the generic-promisify
promise never settles, so every test that reaches parallel-wave cleanup hangs.

Two details made this hunt expensive:

- **The file already had the right pattern.** Its `exec` mock deliberately routes through the
  `execSync` mock via `promisify.custom`; `execFile` was simply never given the same treatment
  because the cleanup path only used `exec` until FN-251. Classic mock drift, the same failure
  family this file's `FNXC:EngineTestDrift` notes describe — except the drift mode here is a
  never-settling await (silent hang) instead of a thrown `TypeError` (loud failure).
- **Sequential tests never call `removeWorktree`,** so ~121 cases stayed green and the hang
  looked like a property of the parallel machinery rather than of one mocked export.

## Fix

Give the mock a real `execFile`: normalize Node's `(file, [args], [options], callback)` overloads,
route them through the same `execSync` mock surface, and implement `promisify.custom` resolving
`{ stdout, stderr }` — matching Node's real special-case contract for `promisify(execFile)`
(identical in shape to the file's existing `exec` adapter). The `git status` probe then resolves
to `""` → `clean` → removal proceeds exactly as it did pre-FN-251.

## The hang had also been hiding stale fixtures

Once cleanup settled, four cases still failed with *real* assertions: they keyed step-worktree
paths on `generateWorktreeName` mocks (`wt-step-0`, `wt-mixed-0`, `wt-clean-N`), a contract
`createStepWorktree` stopped consuming when FNXC:TaskWorktreeNames 2026-08-29-08:51 made step
paths deterministic (`<task-id>-step-<n>` under the resolved worktrees dir). The hang had made
them red-invisible for four days. They were updated to the deterministic naming, not weakened —
the cleanup test now asserts the full deterministic path shape
`/project/.fusion/worktrees/fn-001-step-\d+`.

**Lesson: a deterministic hang can mask a second, real contract break beneath it.** When a hang
clears, run the whole file before declaring victory — the first green-again assertions are where
the masked staleness surfaces.

## Not quarantine, not appeasement

The honest resolution was the mock fix, not quarantine or timeout inflation: a file-level
quarantine would have evicted ~121 passing tests, and the register's admission condition ("passes
when run alone") never applied to a deterministic hang. Post-fix the full file runs 130/130 in
~7 s.

## Diagnostic recipe for this failure family

1. Suspect never-settling awaits whenever every failure is a timeout and none is an assertion.
2. Diff the mocked module's surface against what the product path *now* imports — grep the
   hanging path for `promisify(execFile)` / `promisify(exec)` / raw callbacks and check each one
   exists honestly in the `vi.mock` factory (callback invoked, `promisify.custom` shape correct).
3. Confirm with a single case at a raised `testTimeout`: real slowness makes partial progress; a
   dead await hits the raised ceiling exactly.
4. After the mock fix, run the *entire* file — assertions masked by the hang are your second bug.
