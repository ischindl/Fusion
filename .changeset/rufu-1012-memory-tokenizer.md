---
"@runfusion/fusion": patch
---

summary: Memory search now matches whole words in any language and stops returning duplicate snippets.
category: fix
dev: One Unicode-aware tokenizer and matcher (`deriveMemoryQueryTerms` / `countMemoryTermMatches` in `@fusion/core`) replaces the per-lane ASCII split plus substring test, the snippet walk uses stride == window (12) instead of 8-over-12, externally authored `qmd` windows are de-overlapped before the limit, and an empty `fn_memory_search` now reports `details.emptyReason` (`no-query-terms` | `no-memory-content` | `no-token-match`) with `details.termCount`. Score ordering, the `+1000` cross-scope offset, limits and snippet caps are unchanged (RUFU-665 owns those).
