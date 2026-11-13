---
title: "A landed card is refused forever because one word in a skipped step's title reads like a verification gate"
date: 2026-11-13
category: reliability
problem_type: reliability
module: "@fusion/core"
component: merge / finalize guard
tags:
  - zero-diff
  - finalize
  - no-commits
  - landing-proof
  - step-name
  - regex
  - review-input-fingerprint
  - file-scope-overlap
  - rufu-292
  - rufu-649
  - fn-8141
  - fn-6461
symptoms:
  - "an `in-review` card with `ahead=0` against the integration branch repeats the same refusal every pass"
  - "`error = skipped verification step(s) with no net branch changes: <name of an implementation step>`"
  - "the card's `code-review` row is `passed` / `APPROVE` over `reviewInputFingerprint = \"empty-review-input:v1\"` and the refusal still names a step"
  - "other cards sit with `overlapBlockedBy` pointing at that card and never release"
root_cause: "`evaluateNoCommitsNoOpFinalize` classified \"is this skipped step a verification gate?\" by running `/test|verif|qa|review/i` over the step NAME, and returned before the code-review sign-off was ever read. The sign-off two arms below it is the authority that answers the same question."
resolution_type: code_and_test
---

## What the guard was actually asking

`evaluateNoCommitsNoOpFinalize` in `packages/core/src/merge/no-commits-finalize-guard.ts` is the shared
finalize decision for a card whose branch produced no net diff. It asks four things: is any required
pre-merge gate unmet, is delivery proven, is any skipped step unfinished work, and does the step ledger's
done/skip ratio itself argue against finalizing.

The skipped-step arm answered the third question with the fourth one's tool:

```ts
const VERIFICATION_STEP_NAME = /test|verif|qa|review/i;
const verificationSkipped = skippedSteps.filter((step) =>
  VERIFICATION_STEP_NAME.test(step.name ?? "") || isRemediationStep(step),
);
if (verificationSkipped.length > 0) { /* block unconditionally */ }
```

A step title is author-facing prose chosen by a planner. It is not a declaration of gate status. The card
that proved it was RUFU-292, whose skipped implementation step was titled:

```
Destructive reclaim sweeps — make the activation deliberate and tested
```

`tested` matches `/test/i`. The step is not a gate, was never declared one, and the same guard answers
gate status correctly elsewhere — `evaluatePreMergeApprovals` decides declared gates from
`enabledWorkflowSteps` plus the step-result rows, and `hasApprovedEmptyCodeReview` decides review
sign-off from the fingerprint. Only this one arm consulted the dictionary.

## Measured evidence

Read-only measurements, taken against `main` before the change.

| Evidence | Measured value | Why it matters |
| --- | --- | --- |
| `git rev-list --count main..fusion/rufu-292` | `0` | nothing left to deliver |
| `git diff --stat main...fusion/rufu-292` | empty | no net diff |
| deliverable commit | `f2492f3078`, ancestor of `main` | the work is landed |
| `workflowStepResults.code-review` | `passed` / `APPROVE` / `reviewInputFingerprint = "empty-review-input:v1"` | the exact sign-off this guard itself recognises |
| `workflowStepResults.plan-review` | `passed` / `APPROVE_WITH_NOTES` | gates are satisfied |
| `steps` | 0,1,2,5,6,7,8 `done`; 3,4 `skipped` | step 4 is the title that trips the regex |
| `task.json` keys | no `landingProof`, no `noCommitsExpected` | delivery is authorized by `nothing-to-deliver`, not by a sha |
| refusal, unchanged every pass | `skipped verification step(s) with no net branch changes: Destructive reclaim sweeps — make the activation deliberate and tested` | the message names prose, not work |

Three consequences of the last two rows are load-bearing and were the reason a fix that only demanded
"durable landing proof" would not have worked:

1. RUFU-292 carries **no** landing-proof key. Its delivery arm resolves to
   `proven-legitimate-noop` with basis `nothing-to-deliver` — a positive content probe, not a sha. Any
   relaxation keyed on the durable basis alone leaves the motivating card refused.
2. The sign-off arm requires four fields together: `workflowStepId === "code-review"`, `reviewKind === "code"`,
   `status === "passed"`, `verdict === "APPROVE"`, and the empty-input fingerprint. A fixture missing
   `reviewKind` is refused for its step wording even after the relaxation — measured while writing the
   lane test, and the predicate is correct to do so.
3. The card reached `done` only because an operator landed and released it by hand. No agent session
   finalized it: its newest agent-log row is the reviewer's `APPROVE`, and the last engine-visible action
   on its History is an operator `Task unpaused`.

## The fix, stated as a decision contract

The arm now classifies a skipped step by **provenance**, and asks prose last:

| Skipped step shape | Authority consulted | Verdict |
| --- | --- | --- |
| declared required pre-merge gate | `evaluatePreMergeApprovals` (unchanged, runs first) | blocks as before |
| carries structural `remediation` provenance | `isRemediationStep` (unchanged, still unconditional) | blocks, no evidence cures it |
| flagged **only** by title wording, card shows both proofs | `verdict.kind === "proven-legitimate-noop"` AND `hasApprovedEmptyCodeReview` | falls through to the existing signature rule |
| flagged only by title wording, either proof missing | same two predicates, negative | blocks exactly as before |
| any other skipped step | `everyNonSkippedDone && (noCommitsExpected \|\| hasApprovedEmptyCodeReview)` | unchanged signature rule |
| no delivery evidence at all | `evaluateZeroCommitLandingProof` | refuses; a missing evidence object is never read as clean |

Both proofs are required together, so the relaxation is reachable only by a card that can show its
delivery **and** a reviewer's sign-off on the exact empty input. The refusal sentence prefix is byte-identical,
so any log-based triage or run-audit query keeps matching.

One intentional message change: when a card carries both a skipped remediation step and a name-flagged
step, the refusal now names the remediation subset instead of the union. That row is the one a reviewer can
re-issue, so the message became strictly more actionable.

## Why the anti-laundering invariant is unchanged

FN-8141 is the shape "empty diff plus genuinely skipped work, laundered into `done`". It stays closed on
every axis the guard can see, each pinned by a named test:

| Class | Still refused when | Proof |
| --- | --- | --- |
| no reviewer sign-off | `workflowStepResults` has no empty-input `APPROVE` | `blocks the name-flagged skip when the reviewer never signed the empty input` |
| sign-off on a different revision | fingerprint differs from `empty-review-input:v1` | `blocks when the code review approved a non-empty input, or approved with notes` |
| notes-only approval | `APPROVE_WITH_NOTES` | same test |
| work still ahead | `aheadCommitCount: 1` | `blocks a name-flagged skip with commits still ahead` |
| uncommitted deliverable | dirty tree | `blocks a dirty worktree even with the empty-input sign-off`, asserting `deliveryUnproven.refusalCode === "uncommitted-work"` |
| tree cannot be probed | unverifiable | `blocks an unprobed worktree even with the empty-input sign-off` |
| skipped remediation work | `remediation` provenance | `blocks a skipped remediation step even with both proofs` |
| incomplete work outweighs done work | FN-6461 tie | `keeps the FN-6461 tie arm un-widened` |
| reverted commit-expected card | FN-8141 ledger, no sign-off | `mirrors the FN-8141 reverted shape without a sign-off` |

The neighbouring classes the fix must not widen — `isRemediationStep`, the unmet-gate arm, the FN-6461
ratio rule — each have an explicit "un-widened" assertion rather than an absence of failure.

## Symptom verification

- **Original symptom:** a landed zero-diff card with approved gates refused with the step-title sentence,
  repeating every pass.
- **Exact reproduction, before:** the guard suite run against the pre-fix guard file returned

  ```
  skipped verification step(s) with no net branch changes: Destructive reclaim sweeps - make the activation deliberate and tested
  ```

  with 6 of 13 new assertions failing, and the real-git lane's clean-tree control failing on
  `expect(result.noOp).toBe(true)` — 1 failed / 13 passed.
- **Assertion it is gone:** the identical inputs return `blocked: false` at the guard and finalize through
  `aiMergeTask` against a real repository. Green-after is 42/42 in the guard file and 14/14 in the real-git
  file, with all 29 pre-existing guard assertions and all 155 pre-existing engine assertions untouched and
  passing.
- **The discriminator pair:** two real-git cases differing only in whether the worktree holds an uncommitted
  file. The dirty one is refused on the content reason with the durable hold written
  (`mergeDetails.uncommittedWorkHold`, `paused: true`, `pausedReason: "manual-hold"`, source
  `zero-commit-landing-proof:*`) in both builds, because the merge runner consults the content door before
  the step ledger. The clean one fails before the fix and passes after. That pair is what proves the hold
  assertion is about content rather than an artifact of the fixture.

## Where the reasoning generalizes

- **Prose is not a declaration.** Any decision that reads a human-facing label to answer a structural
  question ("is this a gate?", "is this destructive?", "is this a verification step?") will be wrong the day
  a planner writes a sentence instead of a keyword. Ask the authority that already owns the fact:
  `enabledWorkflowSteps` plus step-result rows for gates, `isRemediationStep` for mandated work,
  `evaluateZeroCommitLandingProof` for delivery.
- **A name-based regex survives as a backstop, not as a key.** Keeping `VERIFICATION_STEP_NAME` for cards
  that cannot show evidence was deliberate: removing it would have widened the arm for exactly the cards that
  have no proof.
- **Ordering hides bugs.** The delivery verdict is computed up front and rides on every earlier refusal, so a
  content-blocked card reports its content reason and never shows the prose bug. The prose refusal was only
  observable for cards whose delivery was already proven — i.e. precisely the cards it should never have
  blocked. When a refusal is only ever visible for the innocent shape, the arm is misclassified.
- **A stuck holder is a board-wide outage.** `overlapBlockedBy` waiters release through
  `reconcileTaskOverlapWaitsImpl` when the holder reaches a complete lane (and only while it is not standing
  in a WIP lane). A card that can never leave review therefore holds every file-scope successor behind it:
  one regex over a title stalled 70 waiters, two executors' slots, and 153 board-wide overlap-blocked cards.
  Triage any "nobody is running" report by finding the holder whose terminal transition is impossible.

## Related

- `no-commits` finalize guard and its delivery door: `packages/core/src/merge/no-commits-finalize-guard.ts`,
  `packages/core/src/merge/zero-commit-landing-proof.ts`
- canonical gate authority: `packages/core/src/merge/pre-merge-approval.ts` (`evaluatePreMergeApprovals`)
- remediation provenance: `packages/core/src/tasks/remediation-steps.ts` (`isRemediationStep`)
- waiter release: `packages/core/src/task-store/overlap-wait-reconciliation.ts`,
  `packages/core/src/tasks/overlap-wait-release.ts`
- tests: `packages/core/src/__tests__/no-commits-finalize-guard.test.ts`,
  `packages/engine/src/__tests__/merger-finalize-unproven.real-git.test.ts`
- complementary layer: RUFU-469 binds the *waiter's* yield predicate to the holder's column; this document is
  about why the holder could not close at all.
