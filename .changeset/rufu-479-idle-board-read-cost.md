---
"@runfusion/fusion": patch
---

summary: Board loads read only what is on screen; abandoned diff reads stop their git work.
category: performance
dev: Global-settings reads are shared through a 5 s memory cache (write-invalidated, `forceFresh` for read-modify-write; measured 4 reads per board load -> 1); native-structure candidates load only for the mailbox view; stash-orphan and notes reads are deferred past first paint; `/tasks/:id/file-diffs` aborts its git subprocesses when the client disconnects. Board-feed SQL projection is now ON by default (`FUSION_BOARD_FEED_PROJECTION=0` rolls back): measured on the first 100 live cards, 6 187 083 B / 61 871 B/card whole-row -> 1 666 134 B / 16 661 B/card projected, and 36 ms -> 11 ms of SQL (3.71x). Pressing Save/Test/Refresh in Providers or GitHub settings now also clears the cached `gh` availability/authentication verdicts, so a `gh auth login` no longer keeps showing a stale status for up to 60 s. Per-route cost (latency + bytes) is queryable at `GET /api/diagnostics/costs`.
