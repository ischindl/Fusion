---
"@runfusion/fusion": patch
---

summary: Vanished-work audit rows are recorded once per finding, not once per sweep pass.
category: fix
dev: `task:vanished-approved-work` is now bounded by a `(reason, branchRef, unmergedCommitCount, gateApproved)` signature per `WEDGE_RENOTIFY_COOLDOWN_MS` window in `notification/vanished-work-audit-notice.ts` (first report unconditional, changed signature immediate, per-store state). The per-pass detection summary and the mailbox notice are unchanged; queries that counted rows for this mutation type counted sweeps before this fix.
