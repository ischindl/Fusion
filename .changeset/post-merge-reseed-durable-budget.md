---
"@runfusion/fusion": patch
---

summary: Post-merge verification gates now stop re-seeding after three attempts, as the limit always claimed.
category: fix
dev: `countReseedAttempts` read the caller's `task.log` projection, which board reads answer as `log: []`, so `MAX_POST_MERGE_GATE_RESEED_ATTEMPTS` never fired on the two self-healing lanes that pass slim rows (`self-healing.ts:3827`, `:3968`). It now reads the durable row via `store.getTask`, fails closed on a rejected read, and the log line reports the real attempt number. Same shape as the PENDING RUFU-452 fix; that branch is not an ancestor of main, so the pre-merge counter (`pre-merge-gate-reseed.ts:117`) is still dead on main and `MAX_VERDICTLESS_GATE_RERUN_ATTEMPTS` remains unenforceable there.

dev-followup: Review finding F2 (batch cancellation) is fixed in the same change — the seam no longer throws, an unreadable durable row becomes the named refusal `durable-read-unavailable`, and one missing card can no longer cancel recovery for the rest of the pass. Finding F3 (terminal refusal silent on three self-healing lanes) is NOT addressed here.
