---
"@runfusion/fusion": minor
---

summary: Question cards now remember which reply answered them, so the right answer survives reloads.
category: feature
dev: The dashboard chat server stamps an operator's answer row with `metadata.questionAnswer.questionMessageId` naming the assistant question row it answers; ChatView and task-detail Planner Chat resolve answered state and submitted text from that link first and fall back to the legacy positional heuristics only for pre-feature rows. No migration; CLI-runner chat, the room responder, and task-execution question cards are unaffected.
