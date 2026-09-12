---
"@runfusion/fusion": patch
---

summary: Chat replies no longer start with their first chunk doubled ("TheThe-operator" stutter).
category: fix
dev: The capture seam's delta path now consults its per-block offset ledger before emitting, so the openai-completions producer race (pi-ai mutates the shared partial before async re-delivery) cannot double-emit `text_start`'s flush. The dashboard done-handler's authoritative-reply join now skips `stopReason: "error"/"aborted"` turns and strict-prefix retry ghosts, and `persistInterruptedSessionContext` bakes interrupted partials as `stopReason: "aborted"`.
