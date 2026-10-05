---
"@runfusion/fusion": patch
---

summary: Admit plan-premise cards in multi-repo workspaces instead of refusing them as having no git identity.
category: fix
dev: A card's declared base now resolves against the workspace member repositories under the project root when the root itself is not a git repository; a refusal names the base and the members searched.
