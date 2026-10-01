---
"@runfusion/fusion": patch
---

summary: A card whose work has already merged stops being sent back to re-implement itself.
category: fix
dev: Premise attribution (`packages/engine/src/execution/plan-premise-tree.ts`) proved a card's own delivery only from its unique `merge-base(base, tip)..tip` commit set. A landed card has no such set — its branch is merged and usually deleted, so the identity ladder falls back to the declared base, the set is empty, and the card's own commit was filed as upstream `stale`, which re-plans and re-implements finished work. Attribution now also accepts the landed form: the commit that last changed the premise path in the evaluated history, when the engine's `Fusion-Task-Id` trailer on that commit names this exact card (`extractAttributedTaskId`, the canonical task-id grammar already used for branch conflicts). A landed commit naming another card or none stays unattributable and loudly `stale`. A premise set holding both classes keeps the loud `stale` verdict but its detail now names the card's own delivered culprit alongside the upstream one, because the re-plan it triggers otherwise re-implements the premise that is already shipped.
