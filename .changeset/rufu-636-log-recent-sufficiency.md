---
"@runfusion/fusion": patch
---

summary: In-review stalled badges on board rows no longer under-report a History they cannot prove.
category: fix
dev: One shared `taskLogEnvelopeProves()` verdict gates every answer taken from the stored signal envelope, replacing four resolvers' private copies of the rule. The two board reads that hydrate no History (`listTasks`, task search) now repair an unprovable envelope with one horizon-bounded `task_log_entries` fetch per pass and answer from it only when four ground-truth proofs hold (History present, window not truncated, side table not behind the envelope's author, and the window holding every timestamp the envelope names); a refused proof keeps the previous answer and tallies a fixed reason, and the pass says so once in a `[log-recent-sufficiency]` warning. Total timed execution still comes from the stored column, never from a bounded window. `scripts/census-log-recent-sufficiency.mjs` measures the affected population through the same shipped helpers.
