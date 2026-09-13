---
title: "A zero-own-commit branch on a foreign-tainted base must terminate, not re-loop"
date: 2026-09-13
category: reliability
problem_type: reliability
module: "@fusion/engine"
component: self-healing / branch-conflict-recovery
tags:
  - self-healing
  - branch-conflict
  - worktree
  - retry-budget
  - lifecycle-containment
  - trusted-identity
symptoms:
  - "a review-lane card stays failed+paused `branch-conflict-unrecoverable` forever"
  - "every maintenance pass repeats the same refusal pair (`already-merged rejected`, `is already checked out at`)"
  - "a peer card's `overlapBlockedBy` points at the wedge indefinitely"
root_cause: "two closed exits that were both unreachable: the zero-loss proof refused the identity the branch actually landed on, and no refusal path persisted `recoveryRetryCount`, so the dispatcher retry budget could never advance"
resolution_type: product-fix
applies_when: "diagnosing a branch-conflict wedge, changing the branch-conflict refusal sites, or touching checkout-emptiness / landedness proofs"
---

## The shape (RUFU-217)

A card in the review lane whose task branch owns ZERO commits of its own, cut from a base that
local `main` never advanced to, then rebased onto the fetched `origin/main` (acquisition-time
rebase onto the remote). Its tip is a foreign landing — commits owned by another lineage — and
the worktree is clean. The operator-visible loop: the reclaim sweep re-admits the
`branch-conflict-unrecoverable` pause every maintenance pass, the already-merged arm logs
`already-merged rejected (foreign-task-tip)`, the outer catch pauses again, nothing is ever
written that a future pass could read differently.

## The two-closed-exits trap

1. **The trusted-identity gap.** Every landedness proof (the sweep's foreign-tip rejection, the
   classifier, the checkout-emptiness prover) asked "is the tip an ancestor of / zero ahead of
   the LOCAL integration branch?" A branch rebased onto `origin/main` while local `main` sits
   behind fails exactly that test: the inherited foreign tip is unique against the behind local
   identity, so every proof said "foreign content" or "occupied" forever. The disposition the
   operator would perform by hand (see it landed, release it) had no automated equivalent.
2. **The counter that was never written.** The dispatcher decision engine requires
   `retryCount >= maxRetries` to refuse with exhaustion, and it reads `task.recoveryRetryCount`.
   Every refusal in this loop parked or paused the card WITHOUT persisting any counter, so
   `retryCount` was always 0 — a fresh budget on every pass. The loop was not "retrying too
   much"; it was unbounded by construction.

## Why the contamination handler was never the route

The executor dispatcher routes `branch-conflict-unrecoverable` to
`BranchWorktreeAutoRecoveryHandler`; the `SelfHealingManager` dispatchers are constructed
handler-less, and the contamination auto-recovery handler is not registered for this class at
all. Wiring recovery INTO the dispatcher would put it behind the very decision that produced
the wedge. The reachability fix is a DIRECT CALL to the existing exported
`recoverForeignOnlyContamination()` at the three sites that fall through to the unrecoverable
pause: the sweep's outer catch (mirroring its sibling PR-conflict catch), and
`handleBranchConflict` before dispatch / before force-cleanup. The routing table is unchanged,
byte-identical.

## The fix

- **One shared trusted-identity chain** (`resolveTrustedIntegrationRefs`): local integration
  branch first, then each existing `<remote>/<integration>`. Shared by the conflict
  inspections, the sweep's foreign-tip rejection, the foreign-only classifier, and the
  checkout-emptiness prover (chain anchored on the branch NAME so a recorded SHA base still
  gains the remote-tracking identity). A card's own commit unique against EVERY identity still
  refuses (FN-1406); unknown stays occupied-equivalent.
- **A persisted budget** (`recovery/branch-conflict-recovery-accounting.ts`): every counted
  pass at every refusal site (sweep, dispatcher-pause, handler irreducible pause, in-session
  exhaustion) writes `recoveryRetryCount` in the same update. `autoRecovery.mode: "off"` opts
  out. Operator retry resets it (`MANUAL_RETRY_RESET_COUNTER_KEYS`).
- **A terminal park separated from lease release.** At `maxRetries + 1` the card parks
  `failed`+`paused` with the existing `branch-conflict-recovery-exhausted` reason and an error
  naming the remedy — and that write performs ZERO git mutation: no worktree removal, no branch
  delete, no field clearing. The retained checkout stays inspectable; the sweep never
  re-admits the exhausted reason. Lease release is the separate, proof-gated decision: the
  zero-loss exit (re-anchor when the worktree is usable, discard when it is not) or the RUFU-200
  emptiness downgrade (clean tree AND zero-ahead of a TRUSTED identity — no git mutation at
  all, which also repairs cards predating acquire-time base recording).

**The tradeoff, stated:** for a shape the proof cannot clear, the card is deliberately held —
lease kept, peer still blocked. Termination + named remedy + wedge notification is the
guarantee; unblocking is NOT. Releasing an unproven checkout is the destruction FN-1406 forbids;
a blocked peer is operator-recoverable, destroyed work is not.

## Forensics notes

- The deployed-bundle refusal string `foreign-tainted` does not exist at HEAD — reason codes are
  `foreign-task-tip` / `foreign-lineage-tip` / `foreign-landed-commit` / `ownership-unverifiable`
  / `ambiguous`. Key diagnoses on the SHAPE, not the operator-visible literal.
- `landedVia: "remote-tracking"` on a `tip-already-merged` verdict is the marker of exactly this
  shape: landed where the LOCAL identity could not prove it.
- Real-git fixtures that reproduce it live in
  `packages/engine/src/__tests__/self-healing-zero-own-commit-foreign-base.real-git.test.ts`
  (origin-clone-diverge-rebase recipe); the loop-bound assertions live in
  `branch-conflict-retry-bound.test.ts`.
