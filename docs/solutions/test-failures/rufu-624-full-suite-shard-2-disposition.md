---
title: RUFU-624 Full Suite shard 2/4 recovery-escalation assertion disposition
date: 2026-11-17
category: test-failures
module: "@fusion/engine"
problem_type: ci-evidence
---

# RUFU-624: Full Suite shard 2/4 recovery-escalation assertion disposition

Two engine assertions held the non-blocking `Test shard 2/4` lane red on every push. Both
asserted a rule that had already been deliberately replaced: that an exhausted bounded recovery
budget terminalizes the card. This record is the disposition for that lane, because the assertion
repair itself landed under another card.

## Source evidence

- Full Suite run: [38050589218](https://github.com/Runfusion/Fusion/actions/runs/38050589218),
  push to `main`, run SHA `ddf4b7ac27c72e4c426ee72eeafbf9078940b486`, non-blocking lane
  (`full-suite.yml`), not the blocking merge gate.
- Shard job: `Test shard 2/4`, job id `114208738962`, conclusion `failure`.
- Evidence manifest: `post-merge-full-suite-evidence` artifact `11670365612`, which named exactly
  two failed tests, both listed in `packages/engine/.timings/timings-shard2-1.json`.
- Discovery record: RUFU-327's post-merge verification (task document `post-merge-verification-9`),
  which was disposing of this lane and correctly declined to fix two engine assertions under a
  docs-only card.
- Provenance honesty: the run, job, artifact, and timing-file identifiers above are quoted from
  this card's Original Description. This card did not re-download artifact `11670365612`, so it
  restates the hosted manifest's contents rather than re-deriving them; the hosted lane remains
  the authoritative record of the original failure, as in the FN-9540 disposition.

The two named cases, verbatim:

| Test | File | Stale expectation at the reported base |
| --- | --- | --- |
| `reliability interaction: contamination auto-recovery precedence retry budget exhaustion pauses on subsequent event` | `packages/engine/src/__tests__/reliability-interactions/auto-recovery-contamination.test.ts:111` | `second.action` was expected to be `"pause"` for `{ retryCount: 1, settings.maxRetries: 1 }`. |
| `triage planning lifecycle lock transport failures (FN-8911) persists transport failures across a fresh triage owner instead of laundering them into unchanged-PROMPT failures` | `packages/engine/src/__tests__/triage-planning-lifecycle-transport-failure.test.ts:110` | The 4-call case's terminal `status` / `error` shape, written while the unchanged-spec branch still short-circuited every pass. |

Both failures were deterministic assertion drift. Neither was a flake, a timeout, or a
pre-Vitest process failure.

## Topology and attribution

Lane ownership, measured on `packages/engine/vitest.config.ts`:

- The reported contamination case runs in the `engine-reliability` project
  (`include: ["src/__tests__/reliability-interactions/**/*.test.ts"]`), the transport case in
  `engine-default`. `Test shard 2/4` is a non-blocking full-suite shard of those lanes.
- Neither reported file is collected by the blocking merge gate: zero matches for either name in
  `packages/engine/vitest.config.ts`, so neither is in the curated `engine-core` `include` array,
  and `pnpm test:gate` was never the red lane. That is consistent with the measured gate result
  below.
- Neither file appears in `scripts/lib/test-quarantine.json` (zero matches).

Attribution chain, from `git log`:

| SHA | Date | Contribution to this story |
| --- | --- | --- |
| `cb57093d03` | 2026-08-03 | `refactor: domain folder layout (types, API, core, engine) (#2398)` carried the sentence "Exhausted retry budgets escalate to a real failure (task marked failed or error set)." into `packages/engine/src/healing/recovery-policy.ts`. |
| `FNXC:RecoveryOwnership 2026-10-06-15:14` (FN-9512) | 2026-10-06 | Replaced the terminal disposition: `computeRecoveryDecision` answers `disposition: "escalate"` with `exhausted: true` and clears `recoveryRetryCount` / `nextRecoveryAt`. |
| `5ba1ee45a0` | 2026-10-12 | `FN-9533: repair full-suite recovery assertions` landed the assertion half of this debt. Verified an ancestor of this card's HEAD with `git merge-base --is-ancestor 5ba1ee45a0 HEAD`. |
| `9e086e8e02` | 2026-10-22 | `fix(RUFU-768): bound planning re-seed cycles ...` introduced `escalated-reseed` in `packages/engine/src/triage.ts`, the planning owner's landing for an escalation. |
| `001cc3ab93` | 2026-11-12 | `RUFU-527: release an unchanged complete spec without a Plan Review verdict` widened the planning release door and moved finding 2's fixture onto a different shipped branch (see the trap below). |
| `cbb599c928` | 2026-11-15 | This card retired the last two written encodings of the old rule, comment-only. |

## Classification and disposition

Both findings are **stale-assertion drift with no product defect**, the failure mode AGENTS.md
calls "a behavior change owns every test that asserts the old behavior". The shipped contract,
read from `packages/engine/src/healing/recovery-policy.ts` and `packages/engine/src/healing/auto-recovery.ts`:

- Budget exhaustion **escalates**. `computeRecoveryDecision` returns the discriminated
  `RecoveryEscalationDecision` (`disposition: "escalate"`, `shouldRetry: false`, `exhausted: true`)
  and its `nextState` clears both recovery fields, so a caller cannot collapse the hand-off into
  an ordinary no-op pause. `AutoRecoveryDispatcher.classify` answers
  `rationale: "retry-budget-exhausted"` and its escalate arm emits
  `auto-recovery:retry-budget-escalated` and invokes no retry handler.
- The **owner** decides the landing. `escalatePlanningReseed` hands a planning card back to the
  replan owner with `recoveryDisposition: "escalated-reseed"`; `reseedExhaustedBranchConflict`
  owns the branch and worktree landing; an owning lane may still author its own terminal park
  (branch-conflict RUFU-231 and RUFU-395, scheduler stale-spec budget, FN-7996/FN-7998
  tool-failure escalation). Policy escalates, owner lands: that division is the invariant.
- `pause` remains correct for its own reasons only, decided before the budget is consulted:
  `mode: "off"` and destructive ambiguity (`isDestructiveAmbiguity`), plus the dispatcher's
  handler-not-registered fallback.

What each reported file asserts today (read on this card's tree, unchanged by this card):

- `reliability-interactions/auto-recovery-contamination.test.ts` carries
  `retry budget exhaustion escalates without issuing another contamination retry`, asserting
  `{ action: "escalate", recoveryDisposition: "escalate", rationale: "retry-budget-exhausted" }`,
  that `issueRetry` was not called (the runaway-recovery-loop guard the original card title
  claimed), and that the audit sink received `auto-recovery:retry-budget-escalated` with
  `maxRetries: 1`. Its neighbour `mode off and destructive ambiguity preserve pause` still
  pauses for its own two legitimate reasons and must not be "fixed" back.
- `triage-planning-lifecycle-transport-failure.test.ts` asserts `status: "failed"`,
  `recoveryRetryCount: null`, `nextRecoveryAt: null`, `planningFailure: null`, that `customFields`
  survive, that the error names `Planning lifecycle lock transport failure`, and the
  anti-laundering guardrail that the retry line never says `did not update the authoritative
  PROMPT.md`.

**The trap the next author falls into.** Triage has two lifecycle-lock transport exits and they
are deliberately asymmetric:

1. The **throw path** behind `isPlanningLifecycleLockTransportError` parks `status: "failed"`
   with `Planning lifecycle lock transport failure: ...` on budget exhaustion. Since RUFU-527
   widened the release door, this fixture's passes reach the handoff, so the outage surfaces from
   the fenced plan-capture write, i.e. from this throw path.
2. The **consumed-marker exit** calls `escalatePlanningReseed` under
   `FNXC:RecoveryOwnership 2026-10-06-15:28` and hands the card back to the replan owner with
   `recoveryDisposition: "escalated-reseed"`.

Do not "unify" them and do not weaken the throw path's `failed` park: the original spec had their
direction backwards for this fixture, and the repaired assertions state the shipped asymmetry.

**Quarantine was rejected deliberately.** AGENTS.md quarantines a flake observed without a real
bug; these two failed deterministically from a contract that had changed, and the honest
resolution was to make the assertions name the shipped contract (FN-9533's repair), not to widen,
skip, exclude, or delete them. This card adds no `scripts/lib/test-quarantine.json` entry, no
vitest `exclude`, no `.skip`, and deletes no assertion.

**Residual written drift this card retired.** A repo-wide census for the retired wording returned
exactly two hits, both in `packages/engine/src/healing/recovery-policy.ts`: the module-header
bullet "Exhausted retry budgets escalate to a real failure (task marked failed or error set)." and
the `MAX_RECOVERY_RETRIES` JSDoc "Maximum number of recovery retry attempts before escalating to
failure." Both taught the rule that caused this red. They now state the shipped disposition, under
`FNXC:RecoveryOwnership 2026-11-15-03:14`, and the change touched no executable line (proved
below). Post-repair census: zero hits for `marked failed or error set` and for
`before escalating to failure`; the two remaining hits for `escalate to a real failure` are this
card's own attributed quotation of the retired sentence in that comment plus its generated
`dist/` copy, which git ignores.

**One spec premise measured false.** This card's Surface Enumeration predicted that
`grep -rn recoveryDisposition packages/dashboard packages/cli` would be empty. It is not:
`packages/dashboard/app/utils/taskStatusBadgeLabel.ts` declares
`recoveryDisposition?: "pending" | "verification-pending" | "escalated-reseed" | "escalated-execution-reseed"`
and renders badge labels from it, pinned by `taskStatusBadgeLabel.test.ts` as `Recovery pending`
and `Recovery reseeded`. That surface corroborates the shipped hand-off disposition rather than
encoding the retired terminal rule, so it needed no edit, but the census is recorded rather than
repeated. `AutoRecoveryAction` appears in no dashboard or CLI file.

**Unrelated card untouched.** RUFU-550 ("planning-fence recovery predicate must recognize the
transport-failure park shape") holds `packages/engine/src/triage.ts` and this transport test in
its File Scope and owns the terminal transport park's missing repair owner. That premise is
unaffected by this card, which claims neither file and raced no lease (RUFU-550 was in `todo`,
dependency-held on RUFU-533, 0 of 7 steps started, when checked).

## Reproduction and verification

Exact reproduction, deterministic, no Postgres, no network:

```bash
pnpm --filter @fusion/engine exec vitest run \
  src/__tests__/reliability-interactions/auto-recovery-contamination.test.ts \
  src/__tests__/triage-planning-lifecycle-transport-failure.test.ts \
  --silent=passed-only --reporter=dot
```

At the reported base `ddf4b7ac` (before FN-9533) that command produced two failures: `expected
'escalate' to be 'pause'` in the first file, and the terminal `status` / `error` assertions in the
second file's 4-call case.

Measured on this card's HEAD `cbb599c928` (2026-11-17):

- The same command, extended with the two seams that pin the invariant at the producer and the
  dispatcher (`src/__tests__/recovery-policy.test.ts`, `src/__tests__/auto-recovery.test.ts`):
  exit 0, `Test Files 4 passed (4)`, `Tests 41 passed (41)`, `Duration 8.89s`. Both reported cases
  green by name.
- The named touched-seam set (six files, adding `__tests__/auto-recovery-contamination.test.ts`
  and `triage-planning-retry-hold.test.ts`): `Test Files 6 passed (6)`, `Tests 49 passed (49)`.
- **Live-guard proof by mutation.** The two mutation sites named in the spec
  (`healing/auto-recovery.ts`, `triage.ts`) are outside this card's File Scope, so the equivalent
  mutation was applied at the owned seam: `if (nextCount > maxRetries)` in
  `computeRecoveryDecision` became `nextCount > maxRetries + 1`, one executable line. Result:
  `Tests 7 failed | 34 passed (41)` across all four files, including both reported cases plus
  `routes retry budget exhaustion to a role-preserving escalation`,
  `audits retry-budget exhaustion as an explicit escalation`, `exhausts after MAX_RECOVERY_RETRIES
  attempts`, `honors an owner-specific bounded retry budget`, and
  `clears recovery metadata when exhausted`. Reverted with `git checkout`: zero dirty lines, zero
  occurrences of the mutation marker, re-run green 41/41. No mutation reached history.
- **Comment-only proof.** Comparing `HEAD` against `HEAD~1` of `recovery-policy.ts` after stripping
  comments and normalizing whitespace yields 67 executable lines on each side and byte-identical
  output. The card's whole diff versus its base is one file, 27 inserted and 2 removed lines, all
  comments.
- Blocking and workspace gates, all exit 0: `pnpm lint`, `pnpm typecheck`, `pnpm test:gate`
  (engine-core 549 passed, core unit-gate 210 passed, CLI ci-shape 76 passed, core pg-gate 13
  skipped), `pnpm test` (mode `gate`, 549 / 210 / 76 passed, 13 skipped), `pnpm build`.
- Directory-walk noise, classified not expanded: pointing the same command at the whole
  `src/__tests__/reliability-interactions` directory walks 115 files and reported
  `115 failed | 531 passed | 24 skipped`. `pnpm pg:test:status` answers health
  `admin-ddl-denied` for `postgresql://localhost:5432` role `schindler` with an empty password and
  the harness prints its own `FUSION_PG_TEST_URL_BASE` remedy, and the fixture failures carry
  `PostgresError: password authentication failed for user "schindler"`. The remaining class is the
  known store-fake shape: `worktree-acquisition-ignored-only.real-git.test.ts` fails with
  `TypeError: store.getTask is not a function`, documented in
  `docs/solutions/test-failures/store-fake-defects-that-masquerade-as-production-bugs.md`. Both
  were proven pre-existing by restoring this card's only touched file to its `HEAD~1` content and
  re-running: identical failures.
- One tooling measurement worth recording: `pnpm test` first failed inside its own bootstrap, not
  in a test, at `stage=test-artifact-preparation status=failure elapsedMs=30005` because the
  worktree had no fresh `dist` artifacts and that stage carries a 30-second budget. Running
  `pnpm build` first made the same stage finish in 236 ms and the command exit 0.

## Hosted-evidence rule

This local green run is not a hosted rerun. The operator's acceptance clause is
"`Test shard 2/4` green on the next post-landing Full Suite run, or a recorded disposition";
this document is that disposition, and the hosted green is observable only in the next
post-landing Full Suite run, whose record must cite its run id, job id, source SHA, and the exact
result of the two named cases before either is called fixed by CI.
