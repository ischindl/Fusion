---
category: architecture
module: Task lifecycle
tags:
  - post-merge
  - review-recovery
  - upstream-sync
  - fork-decision
  - merge-admission
  - run-audit
problem_type: architecture-decision
applies_when: The post-merge review-recovery seam is touched by an upstream merge, or a recovery-lane change reaches `resumeMissingPostMergeGate`, the pre/post-merge gate seed lanes, merge admission for a landed card, or review-content capture.
---

# Post-merge review-recovery seam: which lineage wins, per behavior

Recorded 2026-11-12 by RUFU-557. **No behavior was changed by RUFU-557.** Nothing here is a shipped
change: every row below is a ruling about code that already exists, plus a disposition for the rows
where the two lineages still disagree. Read this before resolving a conflict in the files named in
"Surfaces this ruling binds", not after.

## Decision

**Default in this seam: OURS keeps the authority, theirs keeps the schedule.** Concretely:

- A refusal in this seam must be a **named reason**, never a boolean and never a sentence. Upstream's
  `{outcome:"resumed"} | {outcome:"not-resumable"}` is strictly less informative than our
  `outcome` + `reason` taxonomy, and our operator notice reads `reason` through
  `isTerminalPostMergeReseedRefusal`. Where upstream added a *behavior* that is expressible inside our
  options-and-reason shape (items 1, 2's legacy clear, 3, 4, 7, 9), we adopted it verbatim and kept the
  shape. Where upstream added a *second authority* for a budget our lane already bounds (items 5, 6's
  classification half, 10, 11), ours stays unless the guard proves our bound does not cover the case.
- **Two arms, two budgets, no shared counter.** The MISSING-gate arm is bounded by the fork's durable
  per-`(task, gate)` attempt budget; the REJECTED-EVIDENCE arm is bounded by upstream's rate schedule.
  The rejected arm deliberately does not write the marker the budget counts
  (`post-merge-gate-reseed.ts`, the `FNXC:PostMergeRecovery 2026-10-05-09:31` note above the two
  sentences). Never "unify" these counters: merging them is what strands CI evidence that lands after
  the early retries.
- **Rule on the measured tree, not on the inventory text.** Six of the twelve rows the operator
  measured on 2026-10-05 describe code that has since landed here (1, 3, 4, 7, 9) or that upstream
  itself deleted (2). A conflict-resolver who applies the original wording re-adds deleted code or
  files a card for shipped behavior.

Re-application recipe for the next upstream touch: for each numbered row, run the probe command it
names against both blobs, apply the recorded side, then run
`pnpm --filter @fusion/engine exec vitest run src/__tests__/post-merge-seam-fork-decision.test.ts`
which fails the moment a recorded choice drifts.

### Blob vocabulary

Every count below is reproducible. `git grep -c <symbol> <sha> -- packages/` summed over files.

| name | SHA | identity |
|---|---|---|
| OURS | `99755fb1e7` | our `main` lineage tip at measurement (2026-11-12) |
| UPSTREAM | `eb7eef49d5` | `refs/remotes/origin/main` (Runfusion/Fusion, 2026-10-26). Proven upstream content, not a descendant of ours: `git merge-base --is-ancestor origin/main HEAD` is true and `git rev-list --left-right --count HEAD...origin/main` = `1199  0` |
| sync commit | `7f111ff3fe` | `fix(FN-9442): recover stalled reviews without retry loops`, an ancestor of OURS; its parent `c7e16ff7c` is item 4's admission fix |

Probe hygiene: `git log --all -S 'isRejectedGateRecheckDue' -- packages/` returns `7f111ff3fe` (the
sync, upstream lineage) and `62804b4340` (RUFU-294, on `refs/remotes/lan/fusion/rufu-293`, NOT
upstream). `-S` does not list the fork's own merge that carried the symbol in, so a naive reading of
that probe invites picking a fork branch as "upstream".

## Re-baseline: rows already settled in-tree

Recorded 2026-11-12 (RUFU-557 Step 0/1). Rows 1, 2, 3, 4, 7, 9 were written before the later syncs and
remediation cards. They are settled and **must not be re-opened from the operator's original wording**.

| item | settled by | how it reads today |
|---|---|---|
| 1 | FN-9502 sync (`FNXC:PostMergeRecovery 2026-10-05-09:31`) | adopted verbatim, live production code |
| 2 | upstream itself, at `32fb16778b` | the exhaustion arm does not exist on either side anymore |
| 3 | RUFU-611 | option **and** production caller live |
| 4 | RUFU-319 | landed-card fast path is blocker-aware |
| 7 | RUFU-346 (with `merger-ai` publish-before-finalize) | machinery live, `recoverConfirmedMergePush` has a caller |
| 9 | the honest-disposition prompt rewrite | prompt and its consumer test agree, both green |

Genuinely open after this document: **6, 8, 10, 11** (all ADOPT-THEIRS-PENDING), plus two questions the
measurement closed — item 3's dashboard surface (ruled KEEP-OURS, the asymmetry is intended) and item 5's
content-keyed half (ruled HYBRID: our budget stays the authority, the one case it does not cover is named
and accepted). Item 12's red set is measured, not inherited: **two files, eight failures**, and every
failure names an item on this card. Four of the eight are the acceptance tests of **items 6 and 10**,
already written, already in `pre-merge-gate-reseed.test.ts`, and red ever since the sync that carried
them in.

## Anchor drift warning

Line numbers quoted in the card, in the ledger, and in the FNXC headers are stale by 1,000-3,000 lines
in several files. The claims held; the numbers did not. Measured corrections used throughout this
document:

| quoted | measured 2026-11-12 |
|---|---|
| `self-healing.ts:18053` (`manualRetry: rejectedEvidence`) | `self-healing.ts:21372` |
| `project-engine.ts:3273/3353` | `project-engine.ts:3421` / `:3554` |
| `pre-merge-gate-reseed.ts` reason enum L71-83 | L80-98 (10 members; `UnrunPreMergeGateRefusalReason` is a derived `Exclude` at L109) |
| `allowDeadlockPark` L192/L198 | declared L626, consumed L633 |
| `isEngineAuthoredInReviewStallPark` L63 / `isRecoverableUnrunGatePark` L83 | L72 / L116 |
| `notifyUnreachablePostMergeGate` L261 called L482 | L277, called L607 |
| `clampReviewGateEntry` L29/L243 | import L37, used L710 |
| `durable-read-unavailable` L106/L152 | L110 / L156 |
| `countReseedAttempts` L165 | L206 (called L534) |
| "17-value `PostMergeGateReseedReason`" | **19** values, L91-110 |

## S0. The signature decision (the fork's extension surface)

**Ruling: KEEP-OURS.**

`resumeMissingPostMergeGate(store, task, options)` keeps the options object; upstream's shape (fewer
arguments, `{outcome:"resumed"|"not-resumable"}` result) is not restored. The options object
(`post-merge-gate-reseed.ts` L340-352) is the fork's extension surface: `source`, `contract`,
`producerSurface`, `manualRetry`, plus the write fence pair `expectedWorkflowSelection` +
`expectedTaskUpdatedAt` at the seed call (L609-610). **Items 3 and 11 are decided by this shape**,
which is why it is recorded first: every later merge re-conflicts here before it conflicts anywhere
else. The options type is inline on the private `runPostMergeGateResume` (L339-355: `source`,
`contract`, `manualRetry`, `fence`, `producerSurface`) and the public wrapper takes it as
`Parameters<typeof runPostMergeGateResume>[2]` (L148-152). Do not flatten it back to positional
arguments to match upstream: that is how the contract and the flag leave the tree.

Evidence: `git grep -c 'PostMergeEvidenceContract' eb7eef49d5 -- packages/` = **0** against
**242** in OURS; `TERMINAL_POST_MERGE_RESEED_REFUSALS` 0 upstream / 3 ours. Every production caller in
the merged tree hands a card projection plus the per-project contract (`auto-merge-finalization.ts`,
four `self-healing.ts` sites, `project-engine.ts`), so a signature change is not cosmetic.

Guard: the drift test asserts `isTerminalPostMergeReseedRefusal` and the `manualRetry` option are
present in production source.

## 1. Time-based recheck ladder for rejected post-merge evidence

**Ruling: KEEP-THEIRS-ADOPTED.** Disposition: none.

Probe: `isRejectedGateRecheckDue` 2 upstream / 4 ours; `isPostMergeGateRecoveryDue` 8 / 11.

The ladder is live here: `isRejectedGateRecheckDue` (`post-merge-gate-reseed.ts` L314) computes
`15 min * 2 ** min(failures, 2)` from `result.completedAt`, so 15, 30, 60 minutes and then one check per
hour; `isPostMergeGateRecoveryDue` (L324, exported) puts it together with the legacy-park and resumable
arms. Adopted verbatim per the `FNXC:PostMergeRecovery 2026-10-05-09:31` header.

**Coexistence question, answered:** the two arms do not double-burn, and the split is the final word.
The rejected arm writes `[post-merge] Rechecking rejected evidence at '<gate>'; …` (L642), which is not
prefixed by `postMergeGateReseedLogMarker`, so `countReseedAttempts` (L206) never counts it against
`MAX_POST_MERGE_GATE_RESEED_ATTEMPTS` (L89, = 3). The missing arm keeps the counted marker and its
ordinal (L643). RUFU-430's permanent-REVISE problem cannot return through this arm because the rejected
arm re-seeds at most hourly and only while the gate's own latest row is `failed` — it never converts an
approved gate into a demand.

## 2. Bounded exhaustion (`hasExhaustedRechecks`, the `"exhausted"` outcome, the park sentence)

**Ruling: REJECTED-UPSTREAM-DROPPED.** Disposition: none. No card is owed, and no re-adoption is
correct: upstream itself deleted this arm.

Probe: `hasExhaustedRechecks` = **0** on UPSTREAM `eb7eef49d5`, and 1 in OURS where the only occurrence
is the explanatory comment at `post-merge-gate-reseed.ts` L37. The deletion is pinpointed, not inferred:
walking the first-parent history of that file from `7f111ff3fe`, the per-commit count is
`d6cb8cb915` 3, `acf81f8d7a` 3, `b4cac0775f` 3, **`32fb16778b` 0**, `b3b833585e` 0. FN-9502 replaced the
terminal exhaustion park with the legacy clear plus the hourly revisit.

What survives on both sides, and must not be mistaken for the deleted arm: the park **sentence**
`Post-merge verification needs remediation` is authored in production on both blobs (1 occurrence in
UPSTREAM's file, 2 in ours) and in `confirmed-merge-must-finalize.test.ts` (10 each), because cards
already terminalized by an older build in the field still carry it. Here it is read-side only:
`EXHAUSTED_PREFIX` (L240) and `hasLegacyRecoveryFailure` (L246), whose fenced clear is adopted. The
>=3-attempt count survives only as the schedule's `Math.min(failures, 2)` clamp.

**Sync-header check:** the header's "NOT re-added" claim is accurate on the blob. No finding.

## 3. Operator `manualRetry` recheck

**Ruling: KEEP-THEIRS-ADOPTED (option *and* caller).** Disposition: none for the seam itself; the
dashboard half is ruled below.

Probe: `manualRetry` 6 upstream / 7 ours, all in production here: the option in
`PostMergeGateResumeOptions` (`post-merge-gate-reseed.ts` L349), its narrowing at L495
(`options.manualRetry === true && decision.outcome === "blocked" && decision.reason === "failed"`), its
use in the due-gate at L507, and the caller `self-healing.ts:21372` (`source: "manual-reconcile"`,
`contract`, `producerSurface`, `manualRetry: rejectedEvidence`) under the
`FNXC:PostMergeRecovery 2026-10-09-13:04 (RUFU-611)` header.

What the seam guarantees when the flag IS set, which is what `confirmed-merge-must-finalize.test.ts`
(now green) pins: `manualRetry` buys an **immediate recheck**, not an exemption. Every guard inside the
seam still refuses (workspace lane, missing merge proof, operator hold, fresh checkout lease, live
execution, an approved or `pending` row) and a failed recheck returns its refusal rather than a success.

### 3a. The dashboard restart surface (open sub-question, now ruled)

**Ruling: KEEP-OURS, the asymmetry is intended.** Disposition: none, with one optional improvement
recorded at the end.

`packages/dashboard/src/routes/task-restart-stage.ts` reaches NEITHER `resumeMissingPostMergeGate` NOR
`manualRetry`. It is not an oversight: it is a different authority that reaches the *pre-merge* re-arms
(`openVerdictlessGateRerunEpisode` at L287, `openContinuationHoldRerunEpisode`, imported at L14) because
a stage restart legitimately reopens a stage. The two facts that make routing the post-merge recheck
through it wrong:

1. its own fence refuses a restart while a merge is live (`isLiveMergeRestart`, L112-119, shared
   `isMergeActiveStatus` definition), and
2. a stage restart **discards the work of the current stage** (`confirm: true` is mandatory, L123-125).

Reusing it for "recheck the evidence now" would destroy a landed card's review stage to accomplish a
re-poll. `fn task reconcile <id>` (the manual-reconcile arm) is the correct and only operator surface
for that re-poll. The optional improvement is an operator-visible affordance that calls the reconcile
arm, not the restart route; it is an improvement, not a defect. It is deliberately NOT tracked as a
card or a recommendation by RUFU-557: the task-execution session that produced this document withholds
task-creation tools, and its completion-recommendation cap was spent on the three genuinely pending
adoptions (items 5's floor with 6 and 10, item 8, item 11). A reader who wants this affordance files it
from this section; the ruling itself is that the current asymmetry is correct.

## 4. Merge-pump admission for a landed card

**Ruling: KEEP-THEIRS-ADOPTED.** Disposition: none.

The fast path is blocker-aware: `project-engine.ts:3421` reads
`if (task.mergeDetails?.mergeConfirmed) { return !resolvedMergeBlocker; }` inside `canMergeTask`, under
`FNXC:PostMergeEvidenceHold 2026-10-08-02:58 (RUFU-319)`, whose own text names the dropped half: the
`origin-sync 2026-10-05` merge (9ecab8cae6) kept origin's *test* while taking the fork parent's one-line
`return undefined;`, sending 14 cases of `project-engine-post-merge-hold.test.ts` red with
`expected true to be false`. Eligibility also carries the landed-card exemption
(`!(task.paused && !task.mergeDetails?.mergeConfirmed)`, ~L3293).

**The pairing is what must be re-applied, not just the line.** Three properties, all load-bearing:

1. the fast path **consumes the caller-resolved blocker** rather than recomputing it
   (`resolveMergeGateBlocker` is the single contract-aware resolver);
2. an **absent** gate still yields `true` so the graph-resume lane can seed it, and the RUFU-430
   exemption arrives as an `undefined` blocker through that same argument;
3. the sibling arm, in the same function, **clears a stale merge-active status** for a landed card
   (L3560-3576): `updateTaskAtomic` writing `{ status: null }`, refused unless `mergeConfirmed` is
   present, the row's `updatedAt` still matches the read, no queue/capacity/merge claim is held, and no
   execution is live, with a `[post-merge] Landing is complete; cleared stale merge activity…` log line.

**Is any half of upstream's admission fix still owed? No.** The item's example ("clearing a stale
merge-active status") is property 3 above and is live. What `canMergeTask` does with a landed card
today: `resumeMissingPostMergeGate` is offered when `isPostMergeGateRecoveryDue` (L3557), stale merge
activity is cleared (L3560-3576), and the blocker returned is
`getRequiredPostMergeEvidenceBlocker(...)` or the named gate sentence (L3578-3579) — i.e. the card is
re-admitted only when its evidence is actually satisfied.

## 5. Restart-proof no-verdict bound: fingerprint-keyed vs log-marker counting

**Ruling: HYBRID. KEEP-OURS stays the authority for the loop bound; the content-keyed predicate is not
adopted as the authority; upstream's same-content floor is owed as an ADDITIVE refusal.** Disposition:
open, folded into the items-6/10 adoption card (its acceptance test is already red here, named below).

Probe: `hasExhaustedNoVerdictRecovery` 6 upstream / **0** ours; `countReseedAttempts` 0 / 4.

Why log markers survive what slim projections broke (the RUFU-502/RUFU-452 finding is about *which read*
the counter used, not about markers being unreliable): both counters go to the durable row, never to the
caller's projection — `countReseedAttempts` through `const live = await store.getTask(task.id)`
(`post-merge-gate-reseed.ts` L206-208, no `.catch`, because a rejected read must not read as "no
attempts"), and `countVerdictlessGateRerunAttempts` (`pre-merge-gate-reseed.ts` L586-608) through the
memoised `createGateLogReader` -> `readGateLogLedger` -> `store.getTask(taskId)` (L268-276). The note at
L180-187 records why the old shape was dead code: `listTasks({ slim: true })`, the modified-since prelude
and search all answer `log: []` for a card whose durable log holds every marker, so the
"hydrate-if-array-is-empty" arm never fired. Strikes are scoped to an episode, newest
`VERDICTLESS_GATE_EPISODE_RESET_MARKER_PREFIX` (L171) window inclusive, scanned by the single shared
`scanGateLogLines` so the verdictless budget and the RUFU-490 hold ledger cannot cut different windows.
The reset marker is written only by `openVerdictlessGateRerunEpisode` (L187), the human Restart route.
`MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS = 3` (L135) is enforced at L667 and L852. The ledger is append-only,
so a daemon restart cannot hand a looping gate a fresh budget, and no schema change was needed.

Ours is also the *stronger* bound of the two, which is the substance of not adopting theirs:

- Upstream's `hasExhaustedNoVerdictRecovery` counts >=3 non-superseded `priorAttempts` entries sharing
  `reviewInputFingerprint` AND `reviewedCommitSha`. In our tree `priorAttempts` is capped at
  `MAX_WORKFLOW_STEP_PRIOR_ATTEMPTS = 5`, single-level, oldest-dropped
  (`packages/core/src/workflows/workflow-step-results.ts` L266, L317) and documented READ-ONLY history
  that never participates in merge-blocking or recovery selection (L408-418). A >=3 filter over a 5-slot
  window is satisfiable but **evictable**: two interleaved failures with different content push the third
  same-input snapshot out and the count silently returns to zero. Upstream's own adopted post-merge
  ladder (item 1) is safe from that only because it saturates at `Math.min(failures, 2)`.
- Our bound is content-independent and per-`(task, gate)`, and it **cannot be refilled by pushing a
  commit**. Theirs re-arms itself whenever the card's content changes, which is the exact hole RUFU-449
  and RUFU-452 closed by making an operator click outrank the automatic budget — deliberately, and only
  through the human route.
- The two executor lanes where upstream consumes its helper
  (`recover-failed-pre-merge-step.ts:138`, `request-pre-merge-optional-step-fix.ts:364`) are bounded here
  by a *richer* authority than a `>=3` filter: `resolveFailedPreMergeWorkflowStepBudget` and
  `resolveOptionalStepRevisionBudget`, per workflow-step key with an absolute safety cap. Re-adding a
  second counter there would create two opinions about one budget.

**The named hole, and the test that proves it.** Upstream's predicate also refuses when the row
remembers three same-input deaths that this lane did not itself dispatch. Our counters count only *our*
markers, so a card whose gate died three times inside execution sessions before this lane ever seeded it
gets seeds from us that upstream would refuse. That is not a hypothetical:
`pre-merge-gate-reseed.test.ts > bounds consecutive failed no-verdict attempts without discarding
evidence` is **red** here (three identical `priorAttempts`, zero durable markers, asserts
`rerouted === false` and no mutation of the row). Its sibling
`> allows recovery for new review input despite old failure history` is **green** for the *opposite*
reason: three old failures plus a NEW fingerprint must still re-seed, which is the case upstream's
content-keyed predicate grants and our budget also grants, because our budget is not content-keyed at
all. The two assertions together are upstream's bound, and our tree satisfies one of them.

So the owed change is the **floor, not the authority**: refuse to seed when the row itself remembers
three failed attempts on the same `reviewInputFingerprint` and `reviewedCommitSha`, in front of the
existing per-`(task, gate)` marker budget, which keeps its operator-only reset. Adopting the floor turns
the red assertion green and leaves the 35 green assertions untouched - the durable-marker suite
(`counts zero strikes…`, `refuses the sixth re-run when the durable row holds the strikes the empty
projection hid`, `does not let another gate's durable markers spend this gate's budget`, and the rest,
all green measured 2026-11-13) is what proves the authority must not be replaced by the predicate.

## 6. `isUnavailablePlanLockResult`: a deterministic spec-lock rejection must not spend another reviewer call

**Ruling: ADOPT-THEIRS-PENDING.** Disposition: open; recorded as a recommendation at completion
(RUFU-557's session cannot file tasks; see "Dispositions" below). This is the row most likely to be
silently re-dropped, because the exclusion is one clause.

Probe: `isUnavailablePlanLockResult` 7 upstream / **0** ours.

Upstream's predicate is trivially portable, because our *producer already writes exactly the shape it
reads*: `execute-workflow-graph.ts` L552-561 catches `isUnavailablePlanLockError`, then sets
`status: "failed"`, `verdict: undefined`, and puts the `PLAN_LOCK_UNAVAILABLE_DIAGNOSTIC` sentence into
**both** `output` and `notes`. Upstream's test is
`[result.output, result.notes].some((text) => text?.startsWith(PLAN_LOCK_UNAVAILABLE_DIAGNOSTIC))`.
The diagnostic constant is exported from `@fusion/core` in both lineages
(`packages/core/src/planner/spec-lock.ts` L11).

What our classifier does without the clause: `isFailedNoVerdictPreMergeReviewResult`
(`pre-merge-gate-reseed.ts` L915) checks phase, `status === "failed"`, `verdict === undefined` and
membership in `requiredPreMergeStepIds` — nothing about cause. So a Plan-Review row that died on an
unavailable spec lock reads as a plumbing death, gets re-routed, and burns a dispatch on unchanged
parser input until the 3-strike budget is spent (it is bounded, but the strikes are wasted and the
card's history blames the reviewer). Upstream's header names the requirement this task records:
"A deterministic spec-lock rejection is not a lost dispatch. Never spend another reviewer call on
unchanged parser input."

**Its acceptance test is already in our tree and red.** `packages/engine/src/__tests__/pre-merge-gate-reseed.test.ts`
carries `it.each(["output", "notes"])("does not redispatch deterministic plan-lock failures carried in
%s")`, which seeds a task whose failed Plan-Review row carries
`Plan approved but spec lock unavailable: mission-missing (mission).` and asserts `rerouted === false`
over five passes. Both instances **fail** here (measured 2026-11-13), and the fixture's sentence is the
mocked `PLAN_LOCK_UNAVAILABLE_DIAGNOSTIC` from `@fusion/core` — the same constant our producer
interpolates. The test arrived with the FN-9442 sync `7f111ff3fe` and has never been green on this
lineage: the door did not travel with its test. That file's own mock at L4 is the other half of the
evidence, since a module that never reads the constant cannot need it mocked.

Adoption shape (for the adoption card, not done here): add the exclusion inside
`isFailedNoVerdictPreMergeReviewResult`, so every consumer inherits it, and mirror upstream's two
executor-lane guards. Note that `packages/engine/src/__tests__/pre-merge-gate-reseed.test.ts` L4
already mocks `PLAN_LOCK_UNAVAILABLE_DIAGNOSTIC` although the module never reads it today: that mock is
inert *now* and becomes load-bearing on adoption.

## 7. `publishLanding(...)`: push landed work before hosted evidence exists

**Ruling: KEEP-THEIRS-ADOPTED.** Disposition: none.

Probe: `publishLanding` 11 upstream / 10 ours; `recoverConfirmedMergePush` 33 / 25 with a live
production caller at `project-engine.ts:3554` (guarded by `if (!await this.isMergePending(task.id))`) —
the inventory's "no caller" claim is superseded.

Here the machinery is `createPublishBeforeFinalizeLanding` (`merger-ai.ts` L2907) built from
`publishLandingContext` (L1877) into its two closures, `publishLandedWork` and `publishRecordedLanding`
(L1879-1881, differing only by `requireRecordedLandingProof`), threaded through finalization at L5205,
L5273-5274, L5294 and L5327. The mid-merge-change deferral the inventory asked for is
`runPublishBeforeFinalizeAttempt`'s live re-read of the task and settings (L2751-2762, then
`classifyPublishBeforeFinalizeHold`): a pause, a flipped `pushAfterMerge`, or a changed destination
between merge and publish stops the push rather than publishing to a target the operator no longer
chose, and the withheld publish reports a fixed hold code instead of making a reader re-derive it.

Composition with our own layers, which a resolver must preserve: the RUFU-346 audit pair
(`task:merge-publish-before-finalize` / `-unavailable`, and RUFU-338's `task:merge-publish-policy-skipped`
for a policy-withheld publish) is ours-only upstream (0 on that blob), and KB-002's stranded-ref
recovery (`push:recovery-branch`, 3 on both blobs) remains the divergent-push path. Do not let a
conflict resolve these three into one push helper.

## 8. Reviewer-cleanliness door on review-content capture

**Ruling: ADOPT-THEIRS-PENDING.** Disposition: open; recorded as a recommendation at completion. Its
acceptance test already exists and is red today (see item 12):
`packages/engine/src/__tests__/merge-content-descriptor-doors.test.ts`. This card owns the door; do not
let it be quarantined away.

Probe: `probeReviewCheckout` 9 upstream / 6 ours, and the door codes
`uncommitted-review-changes` / `review-checkout-unavailable` **2 / 0** and **2 / 0**, each side's only
home being `merge-content-capture.ts`. Our only production consumer of the helper is
`executor/execute-workflow-step.ts`; `merge/merge-content-capture.ts` has 0 hits and does not import it.

Upstream's shape, both legs: per repository for a workspace card (upstream L26-31, refusing with
`uncommitted-review-changes:<repo>:<paths>` / `review-checkout-unavailable:<repo>`) and once for the
singular leg (upstream L54-58, same two codes without the repo prefix). The helper itself is shared and
unchanged in shape here: `ReviewCheckoutProbe` is `clean | dirty(paths) | unavailable` over
`git status --porcelain=v1 -z --untracked-files=all`, with ignored verification artifacts deliberately
not counted as source changes (`worktree/review-checkout-clean.ts` L6-24).

**This is an integrity risk, not a tidiness gap, but it is narrower than the inventory implies, and the
doc must say both halves.** Dirty-checkout capture means a reviewer's approval can bind content while
uncommitted source edits sit in the lane. What has changed since the inventory: RUFU-521 moved the
singular leg to `probeSingularReviewDiffFingerprint({ worktreePath, recordedBaseCommitSha, branchRef })`
(`merge-content-capture.ts` L93-97, with its header at L80-92), which digests a **commit range** on the
card's own branch, so an uncommitted edit no longer changes the fingerprint; workspace members already
measured `entry.branch`. The residue is real but specific: the `branchRef`-absent arm of that probe still
falls back to the working tree (`review-diff-fingerprint.ts` L161-163), and neither leg refuses to
*bind* against a dirty checkout, which is a different guarantee from measuring a committed range. The
adoption card should state which of the two it is restoring.

## 9. Post-merge gate prompt: honest evidence-backed disposition

**Ruling: KEEP-THEIRS-ADOPTED.** Disposition: none. This is the settled case to quote when someone
re-opens a row from the card's original wording.

Probe: `packages/core/src/workflows/builtin-post-merge-group.ts` L219 reads
`2. The completed conclusion for Pipeline smoke tier.`; the old demand
`A successful conclusion for Pipeline smoke tier.` is **0** occurrences in that file. The consumer agrees
in the same direction: `packages/core/src/__tests__/builtin-workflows.test.ts` asserts the
completed-conclusion wording and rejects the old demand (its assertions moved with the prompt; the old
prompt-size literal is gone). Both files measured green on 2026-11-12.

Careful with a bare absence check: the shorter phrase `A successful conclusion` still occurs in an
**explanatory comment** in that file (L173-184, the note explaining that demanding it "is exactly the
demand that turned an honest reviewer into a permanent REVISE"). Assert the full sentence with its
period, never the phrase.

The RUFU-430/RUFU-457 half survived the rewrite: the `PostMergeEvidenceContract` blocks are intact, so a
board with no CI reporter is never told to produce CI evidence and a board that declares the demand is
never exempted. Do not "simplify" the four contract blocks while touching this prompt.

## 10. `already-landed` refusal in the pre-merge seed lane

**Ruling: ADOPT-THEIRS-PENDING.** Disposition: open; recorded as a recommendation at completion.

Probe: inside `packages/engine/src/merge/pre-merge-gate-reseed.ts`, `already-landed` = **4** upstream /
**0** ours. Upstream carries it in both reason enums (upstream L27, L37) and short-circuits at its seed
entry, L75: `if (task.mergeDetails?.mergeConfirmed) return { rerouted: false, reason: "already-landed" };`

Ours has **no landedness guard at all** in that file: `mergeConfirmed` and `mergeDetails` have 0
occurrences there. `UnrunPreMergeGateRerouteReason` (L80-90) has 10 members and none of them is
`already-landed`. So a card whose merge is confirmed but whose pre-merge gate evidence is missing or
verdict-less can be re-seeded into a **pre-merge** review of content that has already landed: the review
runs, its result gates a merge that already happened, and the rerun budget is charged for it. Our
terminal-set plus `notifyUnreachablePostMergeGate` design makes a named reason the right shape, not a
silent return.

**The two enums diverge in both directions, so a conflict must merge the member lists, never take one
side's list.** Measured 2026-11-12 from `export type UnrunPreMergeGateRerouteReason`:

| side | members |
|---|---|
| ours (10) | `seeded`, `verdictless-seeded`, `rerun-budget-exhausted`, `active-continuation`, `continuation-hold-budget-exhausted`, `no-unrun-gate`, `no-review-route`, `not-singular`, `operator-held`, `workflow-selection-changed` |
| theirs (8) | `seeded`, `active-continuation`, `no-unrun-gate`, `no-review-route`, `not-singular`, `operator-held`, `already-landed`, `workflow-selection-changed` |

Taking theirs silently deletes `verdictless-seeded`, `rerun-budget-exhausted` and
`continuation-hold-budget-exhausted`, which our RUFU-490 hold-ledger lane returns; taking ours silently
drops `already-landed`, which is this item. The correct resolution is ours **plus** `already-landed`. The
holder-arm vocabulary is ours-only and is not part of this item: `ContinuationHoldRecordOutcome` (L421:
`no-holder`, `holder-owned`, `holder-already-struck`, `struck`, `exhausted`) and
`FailedNoVerdictPreMergeGateRerouteReason` (L760) both have 0 occurrences on the upstream blob.

**Its acceptance test is already in our tree and red.** The same test file carries
`it.each([rerouteUnrunPreMergeGateToReview, rerouteFailedNoVerdictPreMergeGateToReview])("never seeds
pre-merge work after landing")`, which sets `mergeDetails: { mergeConfirmed: true }` and asserts
`rerouted === false` plus "no seed call" for BOTH pre-merge lanes. Both instances **fail** here
(measured 2026-11-13): the fixture is exactly the card this item describes, and the assertion names
exactly the guard that is missing. Same provenance (`7f111ff3fe`), same conclusion: the refusal is owed,
the test is already written, and the adoption card's acceptance criterion is "these two instances go
green", not a new test.

Two token traps for the adoption card, both unrelated to this enum:
`workflow-merge-nodes.ts` uses `"already-landed"` as a merge-value on its no-op landed path (a different
seam), and `post-merge-gate-reseed.ts` L642-643 contains the phrase "already-landed implementation and
merge will not run again" in **log prose** that exists on both blobs. Neither may be renamed to satisfy
this item, and neither is a reason code.

## 11. `expectedTaskUpdatedAt` snapshot fence on the pre-merge seed

**Ruling: ADOPT-THEIRS-PENDING (low severity, cheap, one-line plus one enum member).** Disposition:
open; recorded as a recommendation at completion.

Probe: inside the pre-merge file, `expectedTaskUpdatedAt` = **1** upstream (its seed passes
`expectedTaskUpdatedAt: task.updatedAt`, upstream L95) / **0** ours. Inside the post-merge file: 1
upstream / 3 ours. Both lineages already fence the **post-merge** seed on the pair
(`post-merge-gate-reseed.ts` L609-610: `expectedWorkflowSelection` + `expectedTaskUpdatedAt`); only the
pre-merge seed is single-fenced here (L712, L888).

Why the residual is narrow rather than urgent: our pre-merge seed's other guards cover the two races
that actually produced incidents (the idle-only continuation fence refusing an active holder, and the
selection fence added by FN-9353 and recorded at L715-722), and its `runId` embeds `items.length`. What
the second fence would still add: the seed's `targetColumn` is computed from the caller's projection
(`clampReviewGateEntry(ir, node, task.column)`, L710) and the IR pin likewise, so if the card moved
lanes between the decision and the fenced write, we install a continuation addressed at the lane the
card no longer occupies. The store seam already implements exactly this refusal —
`{seeded:false, reason:"task-state-changed"}` when `task.updatedAt !== input.expectedTaskUpdatedAt`
(`packages/core/src/task-store/async/async-workflow-workitems.ts` L456-461) — so the adoption is the
argument plus a reason member, not new machinery. `task-state-changed` already exists in the post-merge
taxonomy (L108), so the vocabulary is consistent.

## 12. Red-in-reality files: measured set and sister-card disposition

**Ruling: recorded from measurement, superseding the inherited "two files" wording.** Disposition: see
below; nothing was fixed, quarantined, skipped, or appeased by RUFU-557.

Measured 2026-11-13, each file run alone with `pnpm --filter @fusion/<pkg> exec vitest run <file> --silent=passed-only --reporter=dot`, and the
failure names extracted per-test with `--reporter=junit` (the harness's grep-level summaries collapse
`it.each` instances, which is exactly how a 5-failure file reads as 3):

| file | result | disposition |
|---|---|---|
| `packages/engine/src/__tests__/merge-content-descriptor-doors.test.ts` | **RED, 3 failed / 3 passed** | no owning card on the board; its three failures are **item 8**'s door (`checkout.probe` never called with `/worktree` or `/api`, plus the resulting descriptor-shape mismatch). Ownership belongs to item 8's adoption card, whose acceptance test this is |
| `packages/engine/src/__tests__/pre-merge-gate-reseed.test.ts` | **RED, 5 failed / 35 passed** | no owning card on the board. All five failures name an item here: `does not redispatch deterministic plan-lock failures carried in output` and `... in notes` (2, **item 6**), `never seeds pre-merge work after landing` on both seed lanes (2, **item 10**), and `bounds consecutive failed no-verdict attempts without discarding evidence` (**item 5**'s same-content floor). The 35 green include the whole durable-marker budget suite and `allows recovery for new review input despite old failure history`, which is why item 5 is ruled HYBRID: the authority is proven by green tests, only its floor is missing |
| `packages/engine/src/__tests__/confirmed-merge-must-finalize.test.ts` | green | no longer a candidate; RUFU-611's caller is live and rev 1's defect markers are gone |
| `packages/core/src/__tests__/builtin-workflows.test.ts` | green | no longer a candidate; it now asserts the shipped honest wording (item 9) |
| `packages/engine/src/__tests__/non-executor-run-audit-sink-health.test.ts` | green | owned by **RUFU-540**, which is Done and landed; its repair holds |

**So the measured red set inside this seam is two files and eight failures, and every one of them names
an item on this card rather than a mystery.** Both files arrived with the FN-9442 sync
(`7f111ff3fe`, "fix(FN-9442): recover stalled reviews without retry loops"); in each case the upstream
TEST crossed the merge and the upstream PRODUCTION half did not, which is why they are deterministically
red rather than flaky. There is no quarantine entry for either
(`scripts/lib/test-quarantine.json`, 0 hits) and no `docs/solutions/` note naming them, which is
consistent with the AGENTS rule that a red-in-reality file is its owning card's problem and never a flake
to be appeased. Provenance for `merge-content-descriptor-doors.test.ts`: its three failing assertions
are **byte-identical on both blobs**, and our delta against upstream in that file is only the RUFU-445
spawn/stream harness plus a widened workspace-source construct assertion. Upstream passes because its
capture calls `probeReviewCheckout` in both legs.

Two rules this evidence exists to enforce. Do not quarantine either file: both name behavior a ruling
here says is owed. And do not treat a green targeted run as proof of settlement — the tests encoding
these rulings live in files an adoption card would not otherwise touch.

## Keep-list: seven behaviors that break if this seam flips to theirs

All seven are OURS-only or ours-first; the operator's card settles the direction, the anchors settle
where each lives today, and the drift guard is named per row.

| # | behavior | lives here | upstream shape on `eb7eef49d5` | guard |
|---|---|---|---|---|
| K1 | `allowDeadlockPark` — RUFU-391 stall-deadlock self-recovery | `pre-merge-gate-reseed.ts` L626 (option), consumed L633; post-merge equivalent inline at L395 (`task.paused === true && task.pausedReason !== IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON`) | **0 occurrences**; both seed lanes refuse `task.paused` blanket (pre-merge L74, post-merge L91 and L105) | drift test asserts the option and its consumption |
| K2 | `isEngineAuthoredInReviewStallPark` + error-prefix proof | `pre-merge-gate-reseed.ts` L72; 20 hits tree-wide including `self-healing.ts` | **0 occurrences** | drift test asserts the definition |
| K3 | `notifyUnreachablePostMergeGate` and its refusal-shaped operator notice | `auto-merge-finalization.ts` L277 (takes `refusal: PostMergeGateReseedReason`), called L607 behind `isTerminalPostMergeReseedRefusal`, notice id `system:unrun-post-merge-gate:<task>:<gate>:<refusal>:<bucket>`; `PostMergeGateReseedReason` = **19** values (L91-110) with `TERMINAL_POST_MERGE_RESEED_REFUSALS` L123 and `isTerminalPostMergeReseedRefusal` L131 | **0 occurrences** of the notice helper; its result shape has no `reason` at all, so nothing can be noticed | drift test asserts the helper, its notice id prefix, and `isTerminalPostMergeReseedRefusal`; RUFU-370 / SANE-452 / STAS-288 are the provenance |
| K4 | `PostMergeEvidenceContract` threading | `post-merge-gate-reseed.ts` (options param L344, resolution in `self-healing.ts`), 242 hits tree-wide | **0 occurrences** | drift test asserts the type import in the seam |
| K5 | `isWorkspaceTask` refusal (`reason: "workspace"`, in the terminal set) | `post-merge-gate-reseed.ts` L373, imported L54 | workspace cards are not refused by this seam there | drift test asserts the guard call |
| K6 | `durable-read-unavailable` non-throwing wrapper | `resumeMissingPostMergeGate` L148-158 catches and returns the named refusal (L110 in the taxonomy, produced at L156) | **0 occurrences**; a throwing durable read escapes | drift test asserts both the taxonomy member and the wrapper's return |
| K7 | `clampReviewGateEntry` target-column clamping | `pre-merge-gate-reseed.ts` import L37, used L710 | **0 occurrences** | drift test asserts the import and use |

### The correction, recorded as a dated fact

2026-11-12, measured by extracting the function from both blobs: **`isRecoverableUnrunGatePark` is
byte-identical** across OURS and UPSTREAM (same six clauses, same `IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON`
exception, same drift-park arm). The claim made in chat before the measurement — that upstream tolerates
the stall-deadlock pause "unconditionally, looser than ours" — is wrong in that direction. In
`isRecoverableUnrunGatePark` neither side is stricter; **in the seed lanes theirs is the stricter side**
(blanket `task.paused` refusal, pre-merge L74 / post-merge L91), and **ours is the permissive side**,
permissive behind an explicit `allowDeadlockPark` flag or a matching `pausedReason`, never permissive by
default. That asymmetry is the reason a card whose only hold is the engine's own deadlock park can lift
here and cannot there: the stall classifier exempts paused cards, so a blanket refusal there could never
lift.

## Run-audit events on the surfaces this ruling binds

No event is added, renamed, or dropped by RUFU-557 or by any ruling above; the table records which rows
survive each ruling so a future conflict-resolution does not silently drop one. Any new event in this
seam must carry ids / counts / fixed outcomes only (AGENTS run-audit rules).

| surface | events | survives the ruling |
|---|---|---|
| `post-merge-gate-reseed.ts` | `task:merge-unrun-post-merge-gate-reseeded` (ours-only; 0 on the upstream blob, 2 here) | survives; it is the auditable form of the S0 signature decision and of the bounded budget |
| `auto-merge-finalization.ts` | `task:auto-merge-finalize-post-merge-gate-unreachable` (ours-only), `task:auto-merge-finalize-column-mismatch-reconciled` (9 / 8) and `-no-action` (24 / 14, both sides) | all survive; the first is K3's operator-facing half |
| `project-engine.ts` merge admission | `push:origin`, `push:recovery-branch` (both sides, 3 / 3), `task:merge-publish-*` | survive; do not collapse item 7's three publish rows into one |
| `merger-ai.ts` finalization | `task:merge-publish-before-finalize` / `-unavailable` (8 / 5 here, 0 upstream), `task:merge-publish-policy-skipped` (9 here, 0 upstream) | survive; RUFU-346 / RUFU-338 provenance |
| pre-merge seed lane and its callers | `task:merge-unrun-pre-merge-gate-rerouted` (17 / 2), `task:merge-unrun-gate-retry-deferred` (3 / 0), `task:merge-unrun-gate-park-repaired` (9 / 0), `task:review-no-verdict-park-repaired` (2 / 0) | survive; items 10 and 11 add **reason values** to existing rows, never new event types |
| `merge-content-capture.ts` | none (both sides) | item 8's adoption adds the door's *refusal code strings* into the descriptor's `reason`, not an event |

## Surfaces this ruling binds

`packages/engine/src/merge/post-merge-gate-reseed.ts` (S0, 1, 2, 3, 5, 11, K4-K6) ·
`packages/engine/src/merge/pre-merge-gate-reseed.ts` (K1-K3, K7, 10, 11) ·
`packages/engine/src/merge/auto-merge-finalization.ts` (K3) ·
`packages/engine/src/project-engine.ts` merge admission (4, 7) ·
`packages/engine/src/merge/merger-ai.ts` finalization (7) ·
`packages/engine/src/merge/merge-content-capture.ts` (8) ·
`packages/engine/src/worktree/review-checkout-clean.ts` (8, helper shape only) ·
`packages/engine/src/executor/recover-failed-pre-merge-step.ts` and
`request-pre-merge-optional-step-fix.ts` (5, 6) ·
`packages/engine/src/executor/execute-workflow-graph.ts` (6, the producer side) ·
`packages/dashboard/src/routes/task-restart-stage.ts` (3a) ·
`packages/engine/src/self-healing.ts` consumers of the seam (1, 3, K2) ·
`packages/engine/src/index.ts` barrel (S0) ·
`packages/core/src/workflows/builtin-post-merge-group.ts` and its consumer test (9) ·
`packages/engine/src/__tests__/merge-content-descriptor-doors.test.ts` (8, 12).

Barrel delta to preserve: ours exports `isFailedNoVerdictPreMergeReviewResult`,
`openVerdictlessGateRerunEpisode`, the RUFU-490 continuation-hold family,
`rerouteFailedNoVerdictPreMergeGateToReview`, and `verdictlessGateEpisodeResetMarker` from
`merge/pre-merge-gate-reseed.js`; upstream exports two symbols from that module plus
`resumeMissingPostMergeGate`. Deleting an export to match upstream breaks the dashboard Retry route.

## Dispositions

Four rulings are ADOPT-THEIRS-PENDING, in the order their evidence ranks them:

- **6** (spec-lock exclusion in `isFailedNoVerdictPreMergeReviewResult`) — two red instances in
  `pre-merge-gate-reseed.test.ts` are its acceptance test; the fix is one clause, and the producer half
  already writes the shape the predicate reads.
- **10** (`already-landed` refusal in both pre-merge seed lanes) — two red instances in the same file are
  its acceptance test; the adoption also adds the reason member (see the enum-merge table).
- **8** (review-cleanliness door on `merge-content-capture.ts`) — three red instances in
  `merge-content-descriptor-doors.test.ts` are its acceptance test.
- **5's floor** (refuse to seed when the row remembers three failed attempts on the same input+SHA) —
  one red instance in `pre-merge-gate-reseed.test.ts` is its acceptance test, and it lands with items
  6/10 because all three changes sit in front of the same seed call.
- **11** (`expectedTaskUpdatedAt` on the pre-merge seed, low severity) — no red test; one argument plus
  one reason member, and the store seam already implements the refusal.

Items **5's floor, 6 and 10 should land as ONE card**: same file, same predicate family, one red test
block of five instances, and each half alone leaves the file red. Item 8 is a separate card (different
file, different mechanism). Each cites this document's section and the two blob SHAs.

They are **not** filed as board tasks by RUFU-557: the task-execution session that produced this
document structurally withholds task-creation tools, so each disposition was submitted through the
completion-recommendation route with the same content (construct, blob SHAs, guard, acceptance test).
A reader who wants them tracked should file them from this section; the rulings, probes and acceptance
criteria above are complete for that purpose. RULINGS THAT SAY KEEP-* OR REJECTED-UPSTREAM-DROPPED MUST
NOT become cards, and items 3, 4, 7 and 9 must never become cards at all — the behavior already ships.

## What to re-run before trusting this document again

The tree moves. Every number above is a measurement with a date (2026-11-12/13) and a command. Before
acting on any row: re-run `git fetch --all`, re-resolve the upstream blob (it advances), re-run that
row's probe on both blobs and on `HEAD`, and re-run the drift guard. A row whose construct is now
present in production has moved from PENDING to ADOPTED, and that is a document edit, not a card.
