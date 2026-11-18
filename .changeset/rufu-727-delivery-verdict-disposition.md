---
"@runfusion/fusion": patch
---

summary: A release refusal now says which premise failed and whether retrying can help, on both release routes.
category: fix
dev: `disposePremiseRecheck` maps every plan-premise re-check outcome to its own disposition, so a card whose own delivery consumed a premise releases with recorded evidence instead of the stale-plan ladder, and only a premise that became satisfied again still reports the source-change race. The release 409 resolves `code`, `messageKey` and `retryable` from one closed table: a premise refusal never borrows the "still unplanned" copy, and `retryable` is true only where the next attempt re-derives something (probe unavailable, source moved) — a false premise, a malformed premise and a spent escalation budget are deterministic. The promote route no longer collapses those refusals into `guard-rejected` with the raw code as its message.
