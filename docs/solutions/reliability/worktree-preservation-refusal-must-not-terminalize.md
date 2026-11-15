---
title: "A worktree preservation refusal must keep the checkout, the pointers, and the card alive"
date: 2026-11-15
problem_type: reliability
module: "@fusion/engine"
component: worktree-removal
tags:
  - worktrees
  - executor-teardown
  - external-block
  - lifecycle-containment
  - FN-9233
symptoms:
  - "a card whose work is entirely committed reaches `status: \"failed\"` with the sentence `preserving <worktree>: uncommitted or ignored content present` in `error`"
  - "the same card has `worktree: null` and `branch: null` while `.fusion/worktrees/<id>` and `fusion/<id>` still exist on disk"
  - "`agentId` is null too, so no recovery sweep claims the card and it sits in its lane unowned"
  - "Retry reproduces the identical refusal"
root_cause: "every removal lane caught the preservation refusal and rendered it as a generic failure: the terminal sink wrote the refusal sentence into `status: \"failed\"`, and the transient-retry teardown nulled `worktree`/`branch` after a removal that had provably not released the checkout"
resolution_type: bugfix
---

## Invariant

**The refusal to delete unproven content is a decision about the checkout, never about the card.**
It may retain the worktree, and where a lane genuinely cannot proceed it may freeze the card as
operator-clearable `status: "blocked"`, but no lane may write it as `status: "failed"` in `error`, and no
pointer clear may happen for a removal that did not actually release the checkout. Stated as a rule in
`docs/architecture.md`.

## Symptom

The card had every one of its commits on `fusion/<id>`. It was parked failed with the removal refusal as its
error sentence, and its `worktree` and `branch` pointers were gone — while the checkout and the branch were both
still on disk. The card therefore had no owner, no address for its own deliverable, and no self-healing owner:
each half of the state said something the others contradicted. Eight cards carried that sentence in `error`
(RUFU-178, RUFU-186, RUFU-210, RUFU-253, RUFU-260, RUFU-262, RUFU-263, RUFU-265). RUFU-260 is the instance that
lost both halves at once and is the reason the invariant names two failures rather than one.

## Mechanism

One episode, two independent defects that happen in the same breath:

1. **Terminalization.** The executor's terminal sink first offers the error to `parkExternalSessionObstacle`,
   whose `classifyExternalObstacle` is deliberately message-conservative — host, provider, credential, network.
   A preservation refusal is none of those, so it returned null and the very next line wrote
   `updateTask({ status: "failed", error: <the refusal sentence> })`. A policy that had just *protected* the
   deliverable authored the card's death sentence, and because that sentence reads like an implementation bug,
   Retry was the only visible remedy and it reproduced the same refusal.
2. **The pointer clear.** The transient-retry teardown in `run-implementation.ts` called `removeWorktree()`,
   caught whatever came back, logged one WARN line, and then nulled `worktree` and `branch` **unconditionally**.
   Nulling those two fields is a claim that the checkout is gone; the refusal was proof that it is not. That is
   what orphaned RUFU-260: the surviving unmerged commit is the only reason its work was recoverable at all, and
   the retained checkout sat at the head of the file-scope gate and blocked 14 other cards behind it.

Both halves were reachable only through `.throws` surfaces: each lane's `catch` knew how to recognize
`ActiveSessionWorktreeRemovalError` and re-raised or logged everything else, so a refusal was
indistinguishable from a genuine removal failure by the time any lane decided what to do with the card.

## Resolution

One classifier, one settlement seam, one pointer-clear discriminator.

- `worktreePreservationRefusal()` / `isWorktreePreservationRefusal()` in
  `packages/engine/src/worktree/worktree-preservation.ts` answer "is this the content policy?" for every lane,
  returning one of the three fixed classifications (`deliverable`, `ignored-only`, `unverifiable`). Lanes no
  longer re-parse the sentence; the one private `message.includes(": status probe failed (")` test in
  post-landing cleanup is gone, and self-healing's WIP-cap branch now asks the classifier instead of matching
  the shared `preserving <path>:` prefix — which previously swallowed the *project-root* refusal (a sweep being
  asked to delete the primary checkout, which genuinely is a bug) into a quiet debug record.
- Recognition is **structural, not `instanceof`**, and that is not laziness. `post-landing-worktree-cleanup.test.ts`
  doubles `worktree-backend.js` down to three exports, which leaves the error class `undefined` and made
  `error instanceof WorktreeContentPreservationError` throw *inside the catch that existed to absorb the refusal*.
  A classifier that can throw is worse than no classifier: it turns a protection into a fresh failure. So a refusal
  is recognized as "carries one of the three fixed classifications **and** speaks a preservation sentence" — strictly
  weaker than class identity in the language, strictly stronger than either half alone. The shared `preserving `
  prefix alone still matches nothing: the project-root refusal and the `task-owned branch rebind could not be proven`
  refusal carry no content classification and no content tail, so a lane routed by this predicate cannot absorb a
  misconfiguration into the preserve path.
- `settlePreservedWorktreeRemoval()` records the settled decision where an operator reads it — one card History
  sentence naming the preserved path, plus a `worktree:removal-preserved` run-audit row whose `lane` and `outcome`
  keys are fixed vocabularies (ids, counts, fixed outcomes; the path lives on the card, never in the row) — and
  returns the discriminator so the caller continues instead of failing. It returns `null` for anything that is not
  a refusal, so every lane's existing failure handling is untouched.
- `worktreeCheckoutIsReleased()` is now the only basis a pointer clear may take. Both honest arms qualify (the
  removal happened, or it proved the path was already unregistered and gone); a thrown refusal, a skip, or a branch
  that never attempted the call does not.
- The escalation half: `parkPreservedWorktreeObstacle()` runs **before** the terminal write in the sink and freezes
  through the already-sanctioned `buildTaskExternalBlockPatch()` primitive — `status: "blocked"`,
  `pausedReason: "external-block"`, resume pointer carrying `column`/`nodeId`/`currentStep`/`worktree`/`branch`, and
  a bound-and-redacted operator report naming the unblock condition. Codes are fixed:
  `project-configuration/WORKTREE_CONTENT_PRESERVED`, or `WORKTREE_STATE_UNVERIFIABLE` when git's own status probe
  failed. Teaching `classifyExternalObstacle` instead was rejected on purpose: that classifier is shared by every
  lane's freeze decision, and its blast radius is not this card's to take.

Six lanes settle a refusal (`executor-transient-retry`, `executor-teardown`, `execution-terminal-sink`,
`step-session-cleanup`, `pre-execution-release`, `session-start-recovery`). The post-landing outcome map and the
self-healing WIP cap deliberately keep their own pre-existing outcome records rather than joining that vocabulary —
a fixed audit vocabulary that names a writer nobody has is a vocabulary that lies about what is queryable.

**What did not loosen.** The FN-9233 guarantee is intact: content that cannot be proven disposable is still never
deleted, and an ordinary removal error — a lock, git noise, anything the classifier declines — still fails the card
exactly as it did before. Both directions are pinned by cases in the exec-lane test, because "a refusal no longer
fails the card" is only worth what "a real failure still does" is worth.

## Reproduction (exec lane)

Commit every step of the card's work on `fusion/<id>`, then leave one untracked scratch file the executor itself
wrote in the checkout (the real instance was a gate's `.gate-out.txt`), and run the exec teardown/completion path.

- Before: `status: "failed"` whose `error` is the refusal sentence, `worktree` and `branch` null, and a checkout on
  disk that nothing points at.
- After: the card keeps both pointers, the checkout is untouched, and its History line says the cleanup lane refused
  to delete the tree because it holds `deliverable` content.

The test must drive the **exec** lane: the pinned-acquisition lane already had this coverage and its green told
everyone the invariant was held while the executor kept doing the opposite.

## Boundary notes

- **A module barrel is a claim about another module's exports, and nothing type-checks it in tests.** The first pass
  of this change added `worktreeRemovalActuallyHappened` to `worktree-pool.ts`'s re-export list, a name
  `worktree-preservation.ts` never exported. Vitest passed: it transpiles without typechecking and its SSR transform
  does not validate re-export names. `tsc` fails it (TS2305) and — because the engine is ESM built by plain `tsc` —
  the emitted barrel throws at link time for every module that imports it, so the engine cannot boot at all. When a
  change touches a barrel, run `pnpm --filter @fusion/engine typecheck`; a green targeted test run is not evidence
  about a re-export.
- **Where a lane's only symptom was an engine-log WARN, the deliverable is legibility, not behavior.**
  `release-pre-execution-worktree.ts` and `worktree-missing-session-recovery.ts` already kept their pointers on a
  throw, so the settle calls there change no disposition: what they buy is a card that says *why* its checkout is
  still there, instead of a card that simply never released it with the explanation in a log nobody reads.
- **Lifecycle containment.** The freeze is a park with a resume pointer, not a backward move: no `moveTask`, no
  column change, no completed-step loss. `fn_task_retry` and the operator's Retry remain reachable, which is the
  property that `status: "failed"` with an implementation-looking sentence destroyed.

## Pinned by

- `packages/engine/src/__tests__/reliability-interactions/worktree-preservation-exec-lane.real-git.test.ts` — real-git
  exec lane: refuses at the teardown seam and deletes nothing unprovable, records the protection on the card,
  freezes through the external-block primitive at the terminal sink instead of writing `status: "failed"`, declines
  a genuine removal failure so the card still fails, declines the project-root refusal, removes the worktree once the
  unproven file is gone (proving the refusal was the only obstacle), and the strict landed-cleanup premise case.
- `packages/engine/src/__tests__/worktree-preservation-refusal-non-terminal.test.ts` — every refusal at its raise site
  classified, the two shared-prefix refusals excluded, one classifier through both module boundaries, the settlement's
  operator sentence, its ids-and-fixed-outcomes-only audit row, the `parked` outcome, and the pointer-clear
  discriminator's decision table.
- `packages/engine/src/__tests__/worktree-doc-accuracy.test.ts` — the prose census that keeps this record's vocabulary
  confined to where it is true and keeps every path cited above a file that exists.
- `packages/engine/src/__tests__/worktree-backend.test.ts` — the removal-side refusals behind the classifier, asserted
  through public `removeWorktree` with a defensive reason.
