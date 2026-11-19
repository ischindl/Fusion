---
"@runfusion/fusion": patch
---

summary: An impossible dependency is now refused inside the tool result, so the agent keeps planning instead of dying.
category: fix
dev: Dependency-cycle, self-spawn and self-defeating refusals resolve as typed tool results naming the refused edge and cycle path, are recorded on the card's history, no longer spend the planning retry budget, and a blocked park keeps its BLOCKED status when a blockedBy edge is dropped for closing a cycle. Cycle detection remains solely in the task store.
