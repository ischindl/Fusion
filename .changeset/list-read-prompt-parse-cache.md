---
"@runfusion/fusion": patch
---

summary: Board reads no longer re-parse every card's PROMPT.md, which was blocking the dashboard's event loop.
category: performance
dev: `parseStepsFromPrompt` is now memoised per store, validated by `mtimeNs` + `size` (never a TTL), with coalesced in-flight parses and remembered failures; a deleted PROMPT.md invalidates instead of serving stale steps. The `failed to sync steps from PROMPT.md` warning is logged once per card instead of ~1.7/s (measured 572 lines in 331 s from 9 cards, while `/api/health` took 2.9-5.6 s under one board mount). Call sites keep the same degrade-to-persisted-steps behaviour and still see every throw.
