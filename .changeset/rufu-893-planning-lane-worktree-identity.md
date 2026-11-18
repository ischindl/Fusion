---
"@runfusion/fusion": patch
---

summary: Planning-lane worktree/branch pointers are cleared only when git proves the branch is gone.
category: fix
dev: `SelfHealingManager.reconcileTaskWorktreeMetadata` now derives its planning-lane verdict from ref-presence, worktree-registration and containment probes (new pure leaf `worktree/planning-lane-worktree-identity.ts`) instead of a directory check, and a refused clear is announced: one `[worktree-identity]` History line plus one deduped `task:reconcile-planning-lane-worktree-identity-no-action` row whose metadata stays `{taskId, column, code, outcome}`. No refusal deletes a ref, a directory or a `.git/worktrees/` entry, and no card moves lane.
