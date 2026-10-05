---
"@runfusion/fusion": patch
---

summary: Admit plan-premise cards in multi-repo workspaces instead of refusing them as having no git identity.
category: fix
dev: A card’s declared base now resolves against the workspace member repositories under the project root when the root itself is not a git repository, and a member-prefixed premise path (lager-manager/src/X.java) is re-rooted to that repository’s own path (src/X.java) before it is measured, so a premise stated from the workspace root is no longer called false for being spelled correctly. A refusal names the base, the members searched, and both the written and the resolved-in-member path.
