---
"@runfusion/fusion": minor
---

summary: Reply-less chat turns get a Retry action and one automatic engine-side retry.
category: feature
dev: The "no reply" and "interrupted" notices now carry a Retry button that resends the nearest preceding prompt (project Chat and Planner Chat). `ChatManager` additionally auto-retries a turn ONCE when it ends with thinking/tool evidence but no visible reply, or a provider error interrupted work in progress — never for explicit Stop, budget-exhausted turns, question cards awaiting an answer, or chains (the synthetic user row carries `metadata.autoRetry`).
