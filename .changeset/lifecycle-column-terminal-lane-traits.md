---
"@runfusion/fusion": patch
---

summary: Board columns now decide "terminal" from the board's own traits, not from the literal id `done`.
category: fix
dev: Column's completed styling, the completed-task set in `useTasks`, and the row menu's merge-approval
entry all call the one `isCompleteColumnRole` helper, so a board whose terminal lane is not named `done`
no longer folds legacy-id rows into completed work. The `done` id stays as the documented degraded answer
while column traits are unresolved.
