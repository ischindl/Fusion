---
title: "A pinned worktree holding only ignored output must be vacated, not deleted, by acquisition"
date: 2026-09-26
problem_type: reliability
module: "@fusion/engine"
component: worktree-acquisition
tags:
  - worktrees
  - acquisition
  - git-worktree-prune
  - content-preservation
symptoms:
  - "session start fails with 'already registered' / 'already exists' at the pinned path on every heartbeat"
  - "a card that has not executed a step dies without reaching code review"
  - "a preserved checkout leaves a stale `git worktree` registration behind"
root_cause: "acquisition decided preserve-vs-remove from a boolean and relied on the branch-collision ladder to prune the admin entry its own preserve rename had vacated"
resolution_type: bugfix
---

## Mechanism

FN-9233 (2026-08-28) classified defensive cleanup into `clean`, `regenerable-ignored`, `ignored-only`, and
`deliverable`, and made removal refuse rather than delete an `ignored-only` checkout. Task-pinned acquisition —
the one checkout funnel every lane passes through — asked a derived boolean (`defensiveRemovalWouldPreserve()`)
whether removal would refuse, and on "yes" renamed the tree into `.fusion/recovery/worktrees/`. A rename moves the
working tree but leaves the `git worktree` registration in the shared admin directory, and the plain
`git worktree add` that follows cannot see past it. Recovery then depended on the collision ladder's incidental
prune, i.e. on whichever error string git happened to print. When that ordering did not hold, every later
acquisition failed identically at the same pinned path.

Two secondary defects made it uninvestigable: the preserve audit row recorded the literal string
`content-preservation` in its `classification` field, so the row could not say which class had blocked removal,
and the task-log sentence said only "content-preservation".

## Resolution

Acquisition now decides from the same classification removal uses, obtained from the shared
`probeWorktreeRemovalContent()` probe — the record `assertCleanForDefensiveRemoval()` is built on, so the two
doors cannot drift:

- `clean` / `regenerable-ignored`: ordinary `PoolPrune` removal, unchanged (allowlisted build output is still
  deleted with its discard audit row; preserving it would strand gigabytes per card).
- `ignored-only` / `deliverable`: preserve aside under the recovery root, then prune the registration the rename
  vacated with the explicit reason `task-pinned-preserving-reclaim`. Recreation is deterministic, not incidental.
- Unreadable status probe (`status: "probe-failed"`, which the probe reports instead of throwing) and the project
  root checkout: preserves nothing, never moves the tree, and defers to `removeWorktree()`'s own gate so the
  fail-closed refusal still surfaces. A failed probe is never coerced into a content class, and a deciding caller
  must read `status` — the failed record's `classification` is a conservative `ignored-only` label, not a verdict.

The audit row and the task-log line now carry the concrete class.

## Boundary notes

- **Lifecycle containment:** this is not a recovery path that moves a card backward. It changes only whether the
  same acquisition can create the checkout after the vacate.
- **A probe you plan to extract may already be shipped.** RUFU-298's first pass pulled the classification out of
  `assertCleanForDefensiveRemoval()` into a new local probe. `main` had meanwhile landed the same seam (RUFU-274's
  `probeWorktreeRemovalContent()` / `DefensiveRemovalContentProbe`, with a `status` field, `uncommittedPaths`, and
  the counts that feed the operator removal notice, and deliberately non-throwing). Two extracted probes with
  different failure vocabularies in one file is exactly the drift the shared probe exists to prevent, so the
  branch adopted `main`'s probe and its acquisition guard reads `status` plus `isRepoRootPath()` instead. The
  general rule: when a task's premise predates the current `main`, re-read the seam after syncing before keeping
  a hand-rolled extraction — and re-derive generated inventories from the synced tree, never from the base, or a
  squash merge reverts whoever regenerated last (`merge-orphan-durable-write-inventory.json` carries every
  scanned module's `lineHint`, so a stale regeneration silently deletes `main`'s newer call-site rows).
- **How much the explicit prune is worth is measurable, and it is determinism rather than the unlock.** Removing the
  `pruneWorktreeAdminEntries()` call from the preserve branch and re-running the real-git file leaves the
  outcome case green (git's collision ladder still prunes incidentally, so `git worktree add` recreates at the
  pinned path) and reddens only the audit case that names the prune. Stated the other way: the assertion proves
  the prune *happens and is recorded*, not that recreation is impossible without it. That is the honest bound —
  the deterministic ordering and its audit row are the deliverable, not a claim that acquisition was otherwise
  permanently wedged on today's `main`.
- **Premise drift is worth re-measuring on a sibling-heavy board.** RUFU-298 was specified against FN-9233's
  original shape, where an `ignored-only` checkout was refused outright and the card truly died. RUFU-278 landed
  first and already renamed the tree aside, so at execution time the headline symptom no longer reproduced: 2 of
  the 3 repro cases were green at base, and the surviving owned gap was the boolean decision plus the missing
  explicit prune (which the third case pinned red). Re-run the premise before treating a spec's stated failure as
  still reachable.
- **Workspace-aware recovery root.** The primary preserve root is inside the project root, which is already
  workspace-resolved; the workspace distinction is exercised through the cross-filesystem (`EXDEV`) fallback, where
  the preserve root is recomputed from production's own `resolveWorktreesDir()` so a workspace sub-repo checkout
  never preserves beside the parent project.

## Pinned by

- `packages/engine/src/__tests__/reliability-interactions/worktree-acquisition-ignored-only.real-git.test.ts` —
  real-git repro, including the audit-row class assertion.
- `packages/engine/src/__tests__/worktree-acquisition-pinned.test.ts` — the whole decision table, the
  `unverifiable` fail-closed row, and the workspace `EXDEV` preserve root.
- `packages/engine/src/__tests__/worktree-backend.test.ts` — probe classification and the removal-side lockstep
  guards that keep `defensiveRemovalWouldPreserve()` honest.
- `packages/engine/src/__tests__/reliability-interactions/worktree-defensive-removal-preservation.real-git.test.ts`
  — removal-side preservation semantics, unchanged by this change.
