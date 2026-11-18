---
"@runfusion/fusion": patch
---

summary: Board feed reads fewer columns per card, cutting ~48% of bytes fetched per board refresh.
category: performance
dev: Read-path flag `FUSION_BOARD_FEED_PROJECTION` now defaults ON (set it to `0`/`false`/`no`/`off` for a one-statement rollback to the previous query; no migration exists to undo because the flag writes no state). The board page's SELECT narrows `source_metadata` to the 12 board allowlist keys in PostgreSQL and stops transferring `summary`, `comments`, `steeringComments`, `stepReports`, `recommendations` and the token-usage columns the board already discards — 182 → 171 columns and 16 590 → 8 588 bytes per card. The PostgreSQL-CPU measurement RUFU-902 required before enabling is now taken on the live board: key-projecting `source_metadata` costs +1.49 ms of server execution time per 100-card page (2.83 ms → 4.32 ms) to remove 1.65x of the transferred heavy-column payload (1 402 058 B → 848 198 B), against a board page the deployed node answers in 8.79–10.79 s — the opposite trade to the one RUFU-615 rejected for `log`. The searched page and the per-lane board reads take the same projected shape, so one card has one column set whichever endpoint listed it.
