---
"@runfusion/fusion": patch
---

summary: Board feed reads fewer columns per card, cutting ~48% of bytes fetched per board refresh.
category: performance
dev: Opt-in read-path flag `FUSION_BOARD_FEED_PROJECTION=1` (default OFF, nothing changes until set). When ON, the board page's SELECT narrows `source_metadata` to the 12 board allowlist keys in PostgreSQL and stops transferring `summary`, `comments`, `steeringComments`, `stepReports`, `recommendations` and the token-usage columns the board already discards — 182 → 171 columns and 16 590 → 8 588 bytes per card. Rollback is unsetting the variable; no migration exists to undo because the flag writes no state. Measure PostgreSQL CPU before enabling: key-projecting `source_metadata` decompresses it server-side, the trade RUFU-615 rejected for `log`.
