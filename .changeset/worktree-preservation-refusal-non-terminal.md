---
"@runfusion/fusion": patch
---

summary: A worktree cleanup that refuses to delete unprovable files no longer fails a card whose work is already committed.
category: fix
dev: Every removal lane now classifies a worktree content refusal through one shared predicate — `worktreePreservationRefusal()` in `packages/engine/src/worktree/worktree-preservation.ts`, which answers one of three fixed `classification` values (`deliverable`, `ignored-only`, `unverifiable`) — instead of re-parsing its message. A refused removal keeps the card's `worktree` and `branch` links and records a `worktree:removal-preserved` row with a fixed classification and lane; a lane that genuinely cannot proceed parks the card through the operator-clearable external-block freeze (`project-configuration/WORKTREE_CONTENT_PRESERVED`, or `WORKTREE_STATE_UNVERIFIABLE` when git's own status probe failed) instead of writing `status: "failed"` with the refusal sentence. Unproven content is still never deleted and an ordinary removal failure still fails the card exactly as before.
