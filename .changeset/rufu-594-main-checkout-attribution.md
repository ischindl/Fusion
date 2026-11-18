---
"@runfusion/fusion": patch
---

summary: Finishing a workspace card is no longer refused because another card's commit mentions its task ID.
category: fix
dev: Main-checkout completion attribution now requires a structural marker (a `Fusion-Task-Id` trailer line from `taskAttributionTrailerNames`, or a task-ID subject prefix such as `fix(RUFU-594): ...` / `RUFU-594: ...`); a bare ID mention in the commit body never blocks. A structurally attributed commit already contained in a remote-tracking ref is downgraded to a `worktree:workspace-main-checkout-edit` warning with `reason: "published-to-remote"` instead of refusing, so a card whose `workspaceWorktrees` entry is absent is no longer blocked by already-published work. An attributed, genuinely undelivered commit (for example in a repository with no remote) still refuses with `main_checkout_edit`.
