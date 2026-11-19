---
category: workflow-learnings
module: packages/core/src/merge/no-commits-finalize-guard.ts
tags: [step-role, finalize-guard, zero-diff, lexical-classifier, file-scope-lease, board-starvation]
problem_type: classification-defect
applies_when: deciding whether a skipped step is missing quality work, or reading a "skipped verification step" blocker
---

# A step's title is not its role: the lexical classifier that made a finished card undefinable

Recorded 2026-11-19 on RUFU-659, from a card that was demonstrably delivered, reviewer-approved, and fully
merged into `main`, and that could not close. Nothing was wrong with the work. The blocker came from a
regular expression asking a **step title** what kind of work it was.

## The symptom, byte-identical

The card sat `in-review` with `mergeDetails: null` and this exact error sentence:

```
skipped verification step(s) with no net branch changes: Destructive reclaim sweeps - make the activation deliberate and tested
```

Its evidence shape was unambiguously complete:

- `code-review` row `passed` / `APPROVE` / `reviewInputFingerprint = 'empty-review-input:v1'`;
- the canonical `Testing & Verification` step **`done`** (so the sentence contradicted the card's own ledger —
  verification had run and passed);
- branch fully contained in `main` (`git rev-list --left-right --count main...<tip>` = `124 / 0`, zero commits
  ahead).

That one card held the whole board's execution capacity. Both execution slots returned
`queued — waiting for active file-scope lease RUFU-292 (column=in-review, lease=active)` on every cycle, and
317 Todo cards never reached an executor.

## Why a title-substring classifier is unfixable by tuning

`packages/core/src/merge/no-commits-finalize-guard.ts` carried
`const VERIFICATION_STEP_NAME = /test|verif|qa|review/i` — an **unanchored substring test** over
planner-generated prose names. It fed two decisions, and both were wrong in opposite directions:

1. the `verificationSkipped` filter, whose refusal is the sentence above;
2. `hasCompletedVerification`, the positive evidence the FN-6461 `verifiedIntentionalNoOp` exception requires.

No amount of pattern maintenance rescues this shape, because the failure cases are ordinary English. The
planner writes implementation steps as sentences, and the gate words appear inside them as often as not:
`...make the activation deliberate and tested`, `Add regression tests for the guard`, `Reviewed findings`,
`Update review docs`. All four are implementation work; all four contain a gate word. The word `tested`
contains `test`. Meanwhile the planner's wording is not a contract any guard owns, so the classifier's false
positive rate was set by a component (the step-name generator) owned by someone else entirely.

The refusal was also **ordered ahead of** the `hasApprovedEmptyCodeReview` exception that FN-9422 landed for
precisely this evidence shape. So the exception was unreachable: the skip landed in the wrong set, and the set
decided before the sign-off was consulted. RUFU-649 had already relaxed the *consequence* for the
double-evidenced card; this card still refused because the *cause* — the classifier — was still there. When the
exception and the misclassification disagree, the misclassification wins, which is the general lesson.

## The rule that replaced it

One code-owned vocabulary: `packages/core/src/tasks/step-role.ts`.

- `type StepRole = "implementation" | "verification" | "remediation"`, derived, never persisted — a
  role column or parser-stamped role metadata needs a migration and belongs to the planner-parser owner.
- Verification identity is an **anchored role label at the head** of the normalized name:
  `^(?:optional\s+)?(?:testing|tests?|verification|verif(?:y|ied|ication)|qa|reviews?)(?![a-z])`,
  case-insensitive, after stripping the `Step N:` prefix and an optional `Optional` qualifier. The word-boundary
  lookahead is load-bearing: it is what keeps `Reviewed findings` in implementation while `Review` stays a gate.
- Remediation comes from **structural provenance** (`step.remediation`, via `isRemediationStep`), never from the
  title. This is the half that already worked; the fix reuses it instead of re-deriving it.
- Verification identity is checked **before** remediation provenance, so a remediation-marked step named like a
  gate still reads as verification and keeps the executor's fresh-verification prompt line.
- The guard's blocking set is `resolveStepRole(step) !== "implementation"`. **No unanchored substring test on a
  step name may exist anywhere.**

Both consumers of the question now share it. The second classifier
(`remediation-step-placement.ts`, an unanchored `/(?:testing|verification)/i`) converged its **predicate** only.

## The negative half must stay red

The tightening is permitted to be **stricter, never looser** — a mis-filed skip that finalizes is the FN-8141
laundering shape. These each still refuse, each with a named test:

- skipped `Testing & Verification`, `Testing`, `Verify`, `QA sign-off`, `Review` — every one resolves to the
  verification role under the anchored pattern, so the blocking set kept every real gate name;
- a structurally remediation-marked skip whose name carries **no** gate word at all;
- the FN-8141 reverted shape (3 done + 2 skipped, commit-expected, no sign-off).

One consequence is a deliberate tightening and is asserted as such, not discovered later: a `noCommitsExpected`
card whose only "verification-looking" done step is prose-named no longer buys `verifiedIntentionalNoOp` and
falls to the FN-6461 ratio arm instead. An implementation step is not proof that someone checked the work.

Refusal sentence formats stayed **byte-identical**. The truthfulness problem was fixed by putting skips in the
right set, not by rewording — operators, stall classifiers, and existing assertions all match those strings.

## The final-step-only contract that survived convergence

`resolveTrailingVerificationStepIndex` answers for the **final step of the list it is given** and returns
`undefined` otherwise. That is not an accident of implementation: its only production consumer is a
single-element call, `resolveTrailingVerificationStepIndex([step]) === 0`, in
`packages/engine/src/execution/step-session-executor.ts`. It asks "is *this* step the trailing verification
gate?", not "does this list contain one?".

Turning it into a scan for the last verification-role index would look like an improvement and would be a
contract extension: it flips the protecting test `recognizes only a final verification-like step`, whose
assertion `[step("Testing notes"), step("Implement")] → undefined` is exactly what a scan would invert to `0`,
and it would silently attach "Run a fresh verification pass after the preceding fixes:" to every remediation
step in a wave. Predicate converges; selection does not move. A verification-named **non-final** step still
resolves to `undefined`, and that case now has its own test.

The predicate swap does widen one behaviour, stated rather than smuggled: a FINAL step named `QA sign-off`,
`Verify`, or `Review` now resolves as the trailing verification occurrence and earns the prompt line the
two-word pattern ignored.

## The starvation chain, and why its sites are out of scope

Read the chain, because each hop is a separate owner:

1. the guard refuses → merge and finalize both refuse, `mergeDetails` stays `null`, the card stays in the
   review lane;
2. a review-lane holder is **deliberately excluded** from the dormant-proof candidate set in
   `packages/engine/src/executor/file-scope-lease-dispatch-gate.ts` (`dormantProofCandidates`), so
   `classifyFileScopeLease` receives `checkoutEmptiness: undefined` for it;
3. the documented rule "absent keeps the lease" then keeps that holder `active` forever.

The honest proof would have released it — measured live, that worktree had `git status --porcelain` empty,
`rev-parse --show-toplevel` equal to its own recorded path, `symbolic-ref HEAD` on its own branch, and zero
commits ahead — but it was never consulted. Fixing the lease path would have been a lease-policy change
(RUFU-469 owns holder-column release; RUFU-487/RUFU-525 own the emptiness proof's cost and measurability) and
would have left the classifier in place to wedge the next card. One defect, one site.

## Boundaries this fix had to respect

- **No lifecycle move and no fabricated verdict.** No backward move (FN-207/FN-217), no gate bypass, no invented
  reviewer approval. The card is freed by making the decision correct, not by opening a door.
- `skip-bypass-taint-guard.ts` is a name-**agnostic** mirror guard that counts all skips while
  `bulkCompletionRefusalAt` is set. It needed no change, and confirming that is part of the work: a reviewer
  must know the surface was checked.
- The landed-review reconcile fence (`reconcileLandedReviewTask`) is RUFU-656's subject and stayed untouched.
- `fn task reconcile` is **not** a remedy for a card in this shape: without `mergeConfirmed` the fence asks the
  hard merge blocker first, an engine-paused card's next stage returns `paused`, and without `mergeConfirmed` it
  writes nothing to the card. A recommendation that rests on that command is unusable.
- Steps were **classified, never deleted**. Emptying or removing planned steps to satisfy a guard converts a
  classification bug into lost work.

## Test the shape, not the string

The reusable assertion is an invariant, not a fixture: *no implementation step name ever joins the
verification set*. Name-based regression tests age out because the planner keeps inventing new prose; the
invariant plus the anchored pattern is what stops the next wording from re-wedging a card. And the negative
controls are as much the deliverable as the positive one — a "fix" that turns this green by weakening the
blocking half has inverted the bug rather than removed it.

Related: [a-falling-count-is-not-evidence](./a-falling-count-is-not-evidence.md) on claims that need no
measurement, and `docs/architecture.md` § Lane-leg measurement invariant for the `rev-parse`-at-the-wrong-root
trap that made this card's own emptiness proof easy to misread.
