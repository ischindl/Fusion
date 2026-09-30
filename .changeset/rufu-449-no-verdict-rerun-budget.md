---
"@runfusion/fusion": patch
---

summary: A review gate that dies the same way is re-run at most three times, and each re-run is visible on the card.
category: fix
dev: The failed-no-verdict re-seed lane now consumes the same durable per-(task, gate) `MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS` marker budget the unrun-gate lane already enforced, shared across both lanes, and writes the `[verdictless-gate-rerun]` task-log marker with `rerun N of 3`. After the cap it refuses with `rerun-budget-exhausted` and leaves the card for the operator.
