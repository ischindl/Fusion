---
"@runfusion/fusion": patch
---

summary: Engine stops re-deciding a deferred mailbox backlog every time an agent changes state.
category: fix
dev: The wake-deferral memo keyed on raw `agent.state`, so a heartbeat run moving a recipient `idle -> running -> idle` evicted its own verdict and the next 1 s pass re-decided and re-logged every unread message for that recipient (measured 19 388 verdict lines/hour over 22 recipients on a board with live_exec=0). The key is now the inputs the verdict actually reads: `messageResponseMode`, plus wake eligibility only for `immediate`, which is the only mode whose decision reaches the state gate. Mode edits and eligibility changes still invalidate immediately, and `agent:updated` still drops the recipient outright.
