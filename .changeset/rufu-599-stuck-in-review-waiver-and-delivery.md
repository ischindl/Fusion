---
"@runfusion/fusion": minor
---

summary: Stuck review cards get a real remedy: an operator waiver that closes them, and a Retry that stops erasing approvals.
category: fix
dev: Post-merge gate waivers are now offered and accepted for a gate that never ran or never reported a verdict (the card's Review menu / overflow action, `POST /api/tasks/<id>/bypass-review`, operator `fn_task_bypass_review`); an accepted waiver rewrites that gate's single current row instead of appending a second one, and the Workflow Results tab labels it "Waived by <actor>". An accepted Plan Review close terminates the run instead of resuming into execution. `fn task retry` / `fn_task_retry` now refuse with a sentence naming that waiver as the remedy when the waiver is the card's only remaining blocker; the refusal is one History line per card and gate, the card hides Retry and shows the sentence instead, and a failed card's stall chip quotes it. A workspace card whose every declared repository is already integrated closes on that recorded commit-free delivery: the merge door, the completion guard, the repair sweep and `fn task reconcile` all read the same record (`fn task reconcile` reports its own `workspace-delivery-closed` verdict, `task:reconcile-workspace-landed-review` with `basisSource: "recorded"`), so the card no longer needs a commit that git says does not exist.
