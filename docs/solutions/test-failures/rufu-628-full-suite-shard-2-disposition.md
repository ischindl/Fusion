---
title: RUFU-628 Full Suite shard 2 disposition
date: 2026-11-18
category: test-failures
---

# RUFU-628: Full Suite shard 2 disposition

Two `@fusion/engine` cases were red in shard 2/4 of push-to-main Full Suite run `38050589218`. Both
were re-executed at the current head and both are green, because landed work had already replaced the
dispositions they encoded. No assertion was edited, skipped, widened, or quarantined by this card, and
no production file changed. This document is the record that stops the October evidence from
re-filing the same work.

## Source evidence (the October record this card was filed from)

- Full Suite run: `38050589218`, head `ddf4b7ac27c72e4c426ee72eeafbf9078940b486`, created
  `2026-10-10T12:03:33Z`. Shards 1/4, 3/4, 4/4 and the Pipeline smoke tier were green.
- Failing job: `114208738962` (`Test shard 2/4`), which runs
  `pnpm test:ci:shard --shard 2 --total 4` from `.github/workflows/full-suite.yml`.
- Shard-2 diagnostic record: `stage: "test-command"`, `exitCode: 1`, `signal: null`,
  `timedOut: false`. The shard returned; it did not hang and did not hit the job budget.
- Evidence artifact: `post-merge-full-suite-evidence`, artifact id `11670365612`, digest
  `sha256:f935dd0cbf73b5281406adf3f4ee13b10feec174c3bb35e65147ed01c641caa7`.
- The two `failedFullNames`, verbatim:
  1. `reliability interaction: contamination auto-recovery precedence retry budget exhaustion pauses
     on subsequent event` -
     `packages/engine/src/__tests__/reliability-interactions/auto-recovery-contamination.test.ts:111`
  2. `triage planning lifecycle lock transport failures (FN-8911) persists transport failures across a
     fresh triage owner instead of laundering them into unchanged-PROMPT failures` -
     `packages/engine/src/__tests__/triage-planning-lifecycle-transport-failure.test.ts:110`
- Known evidence limit: the raw shard-2 job log is not readable through the read-only Actions lane
  (`.../jobs/114208738962/logs` is refused for containing terminal escape sequences), so the
  per-test assertion text had to be recovered by reproducing locally. It was, and the reproduction
  came back green.

The October failures belonged to the `ddf4b7ac` main line. FN-9512 (landed 2026-10-06) had already
replaced the disposition each case encoded, so each case was asserting a contract the shipped code
deliberately no longer had.

## Re-measurement at the current head

| Item | First measurement | Re-measured at the delivery head |
| --- | --- | --- |
| Head executed | `7062b054ed898188c2fe5303953fe556d1c8a26c` (`RUFU-1050: own and repair graph work no consumer will take`) | `7d96b9f5d90ed232a08313179d3aec8de12ba968` (`fix(RUFU-1044): repair a boost stored one JSON layer too deep`) |
| Date measured | 2026-11-17 | 2026-11-18 |
| Result | **7 passed / 0 failed, exit code 0** | **7 passed / 0 failed, exit code 0** |

Both measurements carry the same per-case breakdown: 5 cases in the auto-recovery file and 2 in the
transport file. The second row exists because `main` advanced between the reproduction and the delivery
of this record, so the shipped claim is the one taken at the head this document lands behind, and it
agrees with the first. The full `--reporter=verbose` output of the delivery-head run names all seven
cases green individually, including `retry budget exhaustion escalates without issuing another
contamination retry` and `persists transport failures across a fresh triage owner instead of laundering
them into unchanged-PROMPT failures`.

```bash
pnpm --filter @fusion/engine exec vitest run \
  src/__tests__/reliability-interactions/auto-recovery-contamination.test.ts \
  src/__tests__/triage-planning-lifecycle-transport-failure.test.ts \
  --silent=passed-only --reporter=dot
# Test Files  2 passed (2)   Tests  7 passed (7)   exit 0
```

Determinism was measured rather than assumed: the auto-recovery file was run alone twice (330 ms and
328 ms, identical) and the pair was additionally run with the argv order reversed. All green, so
neither case is order-dependent and there is no hang hypothesis to pursue.

## Case 1: contamination retry-budget exhaustion

`packages/engine/src/__tests__/reliability-interactions/auto-recovery-contamination.test.ts`

**Already green at the measured head; nothing edited.** The October case title
`retry budget exhaustion pauses on subsequent event` no longer exists in the file. It was renamed and
re-asserted by commit `5ba1ee45a091bba0c1096330944f254d4cdc4cee` (FN-9533, "repair full-suite recovery
assertions", 2026-10-12) and is now titled
`retry budget exhaustion escalates without issuing another contamination retry`.

The assertion that replaced it, which is the shipped contract:

```ts
expect(second).toMatchObject({
  action: "escalate",
  recoveryDisposition: "escalate",
  rationale: "retry-budget-exhausted",
});
expect(issueRetry).not.toHaveBeenCalled();
expect(database).toHaveBeenCalledWith(expect.objectContaining({
  type: "auto-recovery:retry-budget-escalated",
  target: "FN-1",
  metadata: expect.objectContaining({ rationale: "retry-budget-exhausted", maxRetries: 1 }),
}));
```

Why `escalate` and not `pause` is the shipped invariant, not a test convenience: FN-9512
(`FNXC:RecoveryOwnership 2026-10-06-15:14` in `packages/engine/src/healing/recovery-policy.ts`)
requires every bounded recovery owner to surface exhaustion as an explicit escalation rather than
leaving a card in an indistinguishable pause. The chain is
`computeRecoveryDecision` returning `disposition: "escalate", shouldRetry: false, exhausted: true`
(`recovery-policy.ts:107-120`), `AutoRecoveryDispatcher.classify` mapping it to `action: "escalate"`
(`healing/auto-recovery.ts:114-122`), and `AutoRecoveryDispatcher.dispatch` emitting the audit row and
returning **before** any retry handler is invoked (`auto-recovery.ts:144-151`). The
`expect(issueRetry).not.toHaveBeenCalled()` line is what makes that ordering observable.

The `pause` assertions in this file are the control group and were left untouched:
`mode off and destructive ambiguity preserve pause` still asserts
`expect(modeOff.action).toBe("pause")` and `expect(destructive.action).toBe("pause")`.

Recorded rather than added: the shipped `escalate` decision still sets
`legacyPausedReason: failure.pausedReason` (`auto-recovery.ts:119`), and the current case does not
assert it. Adding assertions to a green case is out of scope, so this stands as documentation.

## Case 2: planning lifecycle-lock transport failure

`packages/engine/src/__tests__/triage-planning-lifecycle-transport-failure.test.ts`

**Already green at the measured head; nothing edited.** The case kept its October name, but RUFU-527
(commit `001cc3ab936d88a68b9f996134db0c50ecc775c5`, "release an unchanged complete spec without a Plan
Review verdict", 2026-11-12) moved which branch its passes take, and the file carries three
`FNXC:PlannerNoopRelease 2026-11-11-22:54` notes stating the new contract and its one non-monotone
consequence.

Before RUFU-527 the fixture's every pass short-circuited at the unchanged-spec failure branch, so the
October shape could reach `needs-replan` through the generic planning cadence. With the release door
widened, the passes reach the handoff and the outage surfaces at the fenced plan-capture write, so the
transport lane is what stops the loop. The assertion that is now current:

```ts
// retry pass names the real cause, never a planner verdict
expect(retryLog).toContain("Planning lifecycle lock transport failure");
expect(retryLog).not.toContain("did not update the authoritative PROMPT.md");
expect(fixture.task().recoveryRetryCount).toBe(2);

// terminal pass: the transport lane's own bounded park
expect(fixture.task()).toMatchObject({
  status: "failed",
  recoveryRetryCount: null,
  nextRecoveryAt: null,
  planningFailure: null,
  customFields: { unrelated: "preserve-me" },
});
expect(fixture.task().error ?? "").toContain("Planning lifecycle lock transport failure");
expect(fixture.logs.at(-1)).not.toContain("did not update the authoritative PROMPT.md");
```

That park is the `isPlanningLifecycleLockTransportError(err)` branch
(`packages/engine/src/triage.ts:5482`) exhausting its own cadence and writing
`status: "failed", error: failureMessage, recoveryRetryCount: null, nextRecoveryAt: null,
planningFailure: null` at `triage.ts:5522`. The same patch literal appears at three planning exits in
`triage.ts`, so the branch is identified by its guard, never by the shape of the patch.

**The two anti-laundering guarantees this card was written to protect are intact, and both are
asserted by real assertions:** exhaustion hands work to an owner or names the real cause (case 1
escalates and issues no further retry; case 2 names the database endpoint), and a transport-caused
planning failure is never reported as an unchanged-PROMPT failure (the two `not.toContain` guards
above). The opposite direction is owned by the sibling case
`keeps the ordinary unchanged-PROMPT verdict when no persisted transport marker exists`, which is also
green; without it case 2 would be a tautology.

Converting this case to `needs-replan` plus `escalated-reseed` - the obvious-looking edit, since that
is what the neighbouring `escalatePlanningReseed` exit does - would have been wrong: this fixture no
longer reaches that exit, and the rewrite would have deleted a `not.toContain` anti-laundering guard
while asserting a contract the shipped code deliberately does not have.

## Sibling sweep: no third stale assertion

The two superseded contracts were searched for elsewhere at the same head. Nothing else encodes them,
so File Scope was not extended:

- All 7 remaining `expect(...action).toBe("pause")` assertions in `packages/engine/src` are control
  cases: mode off (`auto-recovery-disabled`), `destructive-ambiguity`, and handler-not-registered, in
  `auto-recovery.test.ts`, `auto-recovery-contamination.test.ts` (both copies), and
  `reliability-interactions/auto-recovery-dispatch.test.ts`. The canonical escalation holder is
  `auto-recovery.test.ts:50` (`routes retry budget exhaustion to a role-preserving escalation`). The
  two `pause` returns in `branch-conflict-retry-bound.test.ts` and
  `branch-conflict-phantom-echo.test.ts` are dispatcher fakes, not assertions.
- `escalated-reseed` is asserted only by its legitimate holders: `triage-planning-retry-hold.test.ts`
  (authoring lane), `execution-reseed-not-planning-stranded.test.ts` (the value-disjointness ratchet),
  `task-wedge-planning-spec-exhaustion.test.ts` (wedge shape), `self-healing-pr-conflict.test.ts`, and
  `agent-tools-task-retry.test.ts`. None is a transport-lane exhaustion case, so the reverse drift (a
  test asserting `needs-replan` where the shipped transport lane parks `failed`) is absent. The
  transport marker `planningFailure.lifecycleLockTransport` has exactly two test readers: this case and
  a fixture in `agent-tools-task-retry.test.ts` that asserts nothing about the park.
- Every planning-subject `toBe("failed")` park is intentional: `PLANNING_FENCE_UNAVAILABLE:`
  (RUFU-288), `DETERMINISTIC_SPEC_VALIDATION_EXHAUSTED:` (RUFU-485), the plan-review session-dispatch
  shape, prompt-shrink classification, the executor tool-failure lane, and the branch-conflict recovery
  terminal park (whose own RUFU-432 note records its contract change).
- The sibling confusable file `packages/engine/src/__tests__/auto-recovery-contamination.test.ts` - no
  `reliability-interactions/` directory, and the file whose earlier FN-9475 red was
  `store.getTask is not a function` - was run alongside the rest and is green. It is named here so the
  two files are never conflated again.

## Quarantine and flake-register status

**Neither file is listed in `scripts/lib/test-quarantine.json`, and neither is recorded in
`docs/solutions/test-failures/suite-only-flakes-observed-register.md`. No entry was added, and none is
warranted.** The October failures were deterministic assertion drift against dispositions FN-9512 had
deliberately shipped, not nondeterministic failures: both files were re-run solo, twice in the
auto-recovery file's case, and in reversed pair order, with byte-identical green results, and the
shard's own diagnostic record already showed a returned command (`exitCode: 1`, `signal: null`,
`timedOut: false`) rather than a timeout. A quarantine, a `.skip`, a widened timeout, a retry, or a
looser matcher would each have destroyed the anti-laundering signal these two cases exist to carry.

## The flake-register guard is red, and not because of this card

`scripts/__tests__/observed-flake-register.test.mjs` reports **10 pass / 1 fail**, and the one failure
predates this card. The violating record is neither of the two files this card was filed for:

- Failing assertion: `observed-flake register paths and every documented hierarchy segment remain valid`
  (`observed-flake-register.test.mjs:166`), violation
  `kind: "missing-hierarchy-segment"`.
- Offending register entry: `Entry: PlanningModeModal 'reconnect' recovery, pool-dependent (first
  sighting)` at `docs/solutions/test-failures/suite-only-flakes-observed-register.md:1028`, whose
  `Exact test` line names the segment
  `keeps 'reconnect' stream-error recovery when stale duplicate reconciliation resolves on 'mobile'`.
- Why the segment cannot be found: the guard matches each segment as literal text against the subject
  file (`observed-flake-register.test.mjs:117-120`), and the subject's title is an `it.each` template,
  `"keeps $recovery stream-error recovery when stale duplicate reconciliation resolves on $viewport"`
  (`packages/dashboard/app/components/__tests__/PlanningModeModal.planning-flow.test.tsx:1572`), with no
  apostrophes and no substituted values. That template line is unchanged since `7527d2651f` (FN-9116,
  2026-08-16), so the register recorded the vitest-rendered name where the guard requires the
  source-rendered one.
- Not this card's doing, and provably so rather than asserted:
  `git diff --name-only $(git merge-base main HEAD)..HEAD` for this card is exactly
  `docs/solutions/test-failures/rufu-628-full-suite-shard-2-disposition.md`. That
  guard reads the register, `docs/testing.md`, `scripts/lib/test-quarantine.json` and the recorded test
  files, none of which this card changes, so its verdict at this head is byte-identical to its verdict
  at the branch base.

Nothing was edited here to close it. The register is the one document where a self-serving edit is most
damaging - rewriting a flake record's `Exact test` string to satisfy a matcher would erase the evidence
of which observation that record was made from - and the drift belongs to the dashboard planning-modal
lane, not to the two engine cases this card dispositioned. It is written down here so it can be given
its own card instead of being absorbed into this one.

## Which CI run proves the shard

**No CI run proves it, and none can while RUFU-620 is open.** This card's proof is the local
file-scoped commands below.

The freshest push-to-main Full Suite evidence anywhere remains run `38050589218` itself, whose head
`ddf4b7ac…` predates both dispositions, so it cannot certify the current shape of either file.
RUFU-620 (`todo`) owns restoring the GitHub publication path; until it lands there is no new
push-to-main `full-suite.yml` run to read.

The measurement behind that statement was taken from this checkout rather than inherited from the card
text, and it corrected the card text in one respect. `refs/remotes/origin/main` resolves to
`eb7eef49d5a0fe3e84e99be30e8ed9622a694e35`, whose commit is dated 2026-10-26, and local `main` is
**1243 commits ahead of it** as measured at the delivery head - so nothing on this side of that boundary
has been published, and a workflow triggered by a push to `main` therefore cannot have run. The card
asserted two things that this measurement disproves: it named `ddf4b7ac…` as the frozen `origin/main`
(the fetched ref has advanced once since, to `eb7eef49d5`), and it claimed the checkout configures no
`origin` remote. It does: `origin` points at `https://github.com/Runfusion/Fusion.git`, alongside
`fork`, `gitlab`, `lan` and `origin-ssh`. The missing fact is publication, not configuration, which is
why RUFU-620 is a publication-path card rather than a git-remote-setup card. No push was attempted
here; publishing is this card's boundary to respect, not its work to perform.

## Verification actually run

```bash
# the two named cases (the Symptom-Verification command; also re-run with --reporter=verbose)
pnpm --filter @fusion/engine exec vitest run \
  src/__tests__/reliability-interactions/auto-recovery-contamination.test.ts \
  src/__tests__/triage-planning-lifecycle-transport-failure.test.ts \
  --silent=passed-only --reporter=dot                        # 2 files / 7 tests passed, exit 0

# sibling contract suites, proving the shared contract did not drift
pnpm --filter @fusion/engine exec vitest run \
  src/__tests__/auto-recovery.test.ts \
  src/__tests__/auto-recovery-contamination.test.ts \
  src/__tests__/triage-planning-retry-hold.test.ts \
  src/__tests__/reliability-interactions/auto-recovery-dispatch.test.ts \
  --silent=passed-only --reporter=dot                        # 4 files / 26 tests passed, exit 0

# re-measured at the delivery head, and widened to the repo-level gates
pnpm lint                                                    # exit 0: 0 errors, 7 pre-existing warnings
                                                             # (control-character regex and empty-block
                                                             #  warnings in files this card never touched)
pnpm --filter @fusion/engine typecheck                       # exit 0
pnpm test                                                    # exit 0 (changed-only resolver: gate stage
                                                             # plus affected tests, all green)
pnpm build                                                   # exit 0 (workspace build, the fourth
                                                             # blocking CI gate; run at the delivery head
                                                             # after the last document commit)
node --test scripts/__tests__/observed-flake-register.test.mjs   # 10 pass / 1 fail, and that one failure
                                                             # predates this card - see the register-drift
                                                             # section above; this card added no entry
node scripts/check-nonlatin-tracked-text.mjs                  # exit 0
node scripts/check-fnxc-future-dates.mjs                     # exit 0, "0 known future-dated stamp(s)"
node scripts/check-quarantine-ledger.mjs                     # exit 0; lists only pre-existing expired
                                                             # entries in other packages, none here
```

`git diff --stat $(git merge-base main HEAD)..HEAD` for this card is one file - this document. No assertion,
no quarantine entry, no vitest `exclude`, and no production source changed. The merge-base form is the
one that stays true: `main` advanced to `284b09622c` (RUFU-594) while this card was in review, so a raw
`main..HEAD` diff also lists the inverse of that landed work and is the wrong question to ask of a
branch-local diff.

`pnpm test:ci:shard` was deliberately not run locally; it is the CI marathon, and the file-scoped runs
above are its equivalent coverage for these two files.

## Follow-up work this sweep surfaced (not folded into this change)

The transport park is the only planning exhaustion exit with no automatic re-probe owner. The fence
park names its sweep on the card face (`reconcile-planning-fence-park`, `triage.ts:5540` and `:5584`,
wedge action text in `notification/task-wedge-notification.ts:417`), and RUFU-768 and RUFU-485 each
gave their planning parks a named claimant; `grep lifecycleLockTransport self-healing.ts` returns only
`:25633`, which handles a transport error raised by the recovery pass itself, not a card already parked
`failed`. A card whose planning was killed by a database transport failure therefore exits only through
the operator's manual Retry. RUFU-527's own note in the spec file records exactly this as follow-up
work rather than folding it in, and this card honors that boundary.

The wedge surface carries the same hole. `packages/engine/src/notification/task-wedge-notification.ts`
declares a named terminal descriptor for each of the other planning parks - `planning-fence-unavailable`
(:408) and `deterministic-spec-validation-exhausted` (:446), each deliberately its own key rather than a
`stall:`-prefixed one because the remedy differs - and the catalogue has no key for a transport-caused
planning park. So a card in this state is invisible to the alerting surface as well as to recovery, and an
operator learns about it only by opening the card.

## One aged comment that this card deliberately did not touch

`packages/engine/src/self-healing.ts:7164-7171` (`FNXC:BranchConflictRecovery 2026-09-13-01:38`) still
reasons about a "`retry-budget-exhausted` pause", and the `shouldSelfHeal` guard below it reads
`failure.rationale === "retry-budget-exhausted"`. That wording predates FN-9512: the note ~85 lines later
at `:7249` (`FNXC:RecoveryOwnership 2026-10-08-13:22`, duplicated for a sibling lane at `:5985`) states
that the rationale now always arrives as `action: "escalate"` and that the pause guard was narrowed to
`destructive-ambiguity` at `:7255`, which is what
`packages/engine/src/worktree/worktree-branch-conflict-handle.ts:413` says too. So the shipped
behaviour is right, the older comment is misleading, and the two sit ~85 lines apart in one function.

Nothing was edited here. This card's contract is that production source stays untouched unless a
reproduced product defect earns the edit (and none was: both named cases measured green), and a comment
is not a test subject under the AGENTS.md rule that forbids asserting one. Recording it is the whole
deliverable, so the next reader of that guard finds the contradiction written down somewhere other than
in a closed card.
