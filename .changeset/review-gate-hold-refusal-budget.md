---
"@runfusion/fusion": patch
---

summary: A review gate that cannot run now stops repeating itself after a few History lines per card.
category: fix
dev: Adds a durable, operator-re-armable hold ledger for re-seed refusals raised against an unowned workflow continuation (`MAX_CONTINUATION_HOLD_GATE_RERUN_ATTEMPTS` = 3 strikes per gate, one per distinct holder) and a distinct `continuation-hold-budget-exhausted` refusal reason beside the existing `rerun-budget-exhausted`. `POST /tasks/:id/retry` opens a hold episode for every discarded gate whose ledger held a line; no automatic lane may write that marker.
