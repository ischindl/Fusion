---
"@runfusion/fusion": patch
---

summary: Board reads no longer re-parse every card's PROMPT.md, which was blocking the dashboard's event loop.
category: performance
dev: `parseStepsFromPrompt` is now memoised per store, validated by `mtimeNs` + `size` (never a TTL),
with coalesced in-flight parses and remembered failures; a deleted PROMPT.md invalidates instead of
serving stale steps. The `failed to sync steps from PROMPT.md` warning is logged once per card instead
of ~1.7/s (measured 572 lines in 331 s from 9 cards, while `/api/health` took 2.9-5.6 s under one board
mount). Call sites keep the same degrade-to-persisted-steps behaviour and still see every throw.
The residual pass on that memo: every return path hands out a copy (`copyPromptSteps`), so a caller that
writes a step `status` cannot reach cached state; the success entry, the failure entry and the
warned-key set all sit under one named bound (`PROMPT_STEPS_CACHE_MAX`, 4096 per store) and evict the
oldest on insert, instead of the failure entry skipping the size check and the warn set being cleared
wholesale; in-flight coalescing is keyed by the card plus the file stamp the joining read validated, so a
rewrite is never served stale; and the once-per-card warning now covers the `updateStep` auto-init
surface too, keyed on the card id rather than the card plus message. `getPromptStepsCacheStats(store)`
answers live entries, the bound, and monotonic hit / miss / coalesce / invalidate / evict / warn
counters (counts only); `__resetPromptStepsCacheForTests` and `__setPromptStepsCacheBoundForTests` are
test-only seams.
