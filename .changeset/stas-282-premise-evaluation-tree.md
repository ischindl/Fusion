---
"@runfusion/fusion": minor
---

summary: Premises verify against the card's own commit; a premise its delivery consumed no longer sends it back to re-plan.
category: fix
dev: Premises resolve to committed content only - the card's worktree HEAD once ownership of that worktree is proven, otherwise its branch tip, otherwise its declared base or the resolved integration branch, and otherwise `unavailable` (retryable, fail-closed). The shared project checkout is never a fact source, so a detached or foreign root HEAD can no longer freeze an unrelated card. Falsification by a commit inside the card's own delivery (`merge-base(base, tip)..tip`) is the new `premise-invalidated-by-delivery` outcome: one deduplicated History entry plus the card's `premise-invalidated` task document naming the invalidating commits, the card stays promotable to review, and the hold/replan/park ladder is not entered. A violation the card's own commits cannot explain stays `stale` and escalates as before, naming the upstream commit. Operators see: re-plan storms on already-landed cards stop, the landed-card delete workaround is obsolete, and a premise that names an untracked or root-only path now fails loud as plan-stale instead of passing by accident - that is intended, and the fix is to correct the plan.
