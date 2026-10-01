---
"@runfusion/fusion": minor
---

summary: Long-term memory reports its byte budget on append and is consolidated loss-free after a backup.
category: feature
dev: `fn_memory_append` long-term confirmations now report measured bytes, budget, percentage and `## ` entry count (daily wording unchanged). A 32 KiB code-owned budget (`MEMORY_LONG_TERM_BYTE_BUDGET`) replaces the never-declared settings knob. Self-healing registers `reconcile-long-term-memory-budget` (startup + maintenance batch 1, independent of the opt-in `Memory Keeper` runtime lane): it backs up memory via `MemoryBackupManager` first, then collapses only exactly duplicated `## ` sections, never shortens or drops a unique entry, and never rewrites a within-budget file. New run-audit events `memory:long-term-over-budget` (rate-limited by signature + 6h cooldown), `memory:long-term-consolidated`, and `memory:long-term-consolidation-failed` (fixed `stage` enum); metadata is ids/counts/fixed enums only, never memory content or paths.
