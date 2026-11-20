---
"@runfusion/fusion": minor
---

summary: Over-budget agent memory now converges by filing oldest entries into a dated archive file, still searchable.
category: feature
dev: Long-term `MEMORY.md` maintenance rolls whole oldest `## ` sections verbatim into
`.fusion/memory/ARCHIVE-YYYY-MM-DD.md` (agent scope: `.fusion/agent-memory/<agentId>/`) until the hot file
reaches `MEMORY_LONG_TERM_HOT_TARGET_BYTES` (75% of `MEMORY_LONG_TERM_BYTE_BUDGET`), so a breach converges
instead of only being reported. The cold tier is listed and readable through `fn_memory_get`,
`fn_memory_search` and the memory APIs, is never injected into the prompt, is never a maintenance target, and
refuses every write path. `fn_memory_search` no longer adds a `+1000` cross-scope offset to agent-memory
scores; a strictly project-relevant hit can outrank a weakly-matching agent note, with a 0.5 tie-break for
exact ties. Audit rows `memory:long-term-consolidated` gain `hotTargetBytes`, `rolledUpSections` and
`rolledUpBytes`, and `memory:long-term-over-budget` gains `collapseCanConverge` / `retirementCanConverge`.
