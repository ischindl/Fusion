---
"@runfusion/fusion": patch
---

summary: Escape now closes exactly one modal layer; the Create PR sheet no longer closes its host with the draft.
category: fix
dev: PrCreateModal's Escape listener is capture-phase behind a focus/ownership guard (target, current focus, or most-recently-focused overlay); deferred keystrokes stay unconsumed for the app-wide popup arbiter.
