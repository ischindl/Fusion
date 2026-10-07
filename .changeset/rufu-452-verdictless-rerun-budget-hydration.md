---
"@runfusion/fusion": patch
---

summary: Verdict-less review-gate re-runs now stop after three strikes per gate.
category: fix
dev: The rerun counter reads the durable task row instead of the caller's board projection, so a slim `log: []` read no longer hides the strikes: the `[verdictless-gate-rerun]` marker shows the true strike number and the 4th attempt is refused with `rerun-budget-exhausted`. A rejected durable read now seeds nothing instead of counting zero strikes, which is also how a missing row on the real store (`TaskNotFoundError`, or `TaskDeletedError` for a soft-deleted card) behaves. The strike count spans the retained activity window: the durable task log keeps its newest 1,000 entries, so extreme churn can retire an old marker.
