---
"@runfusion/fusion": patch
---

summary: Board and tool search find the right cards again when a query mixes words with a hyphen, dot, slash, or path.
category: fix
dev: One `planTaskSearch` plan decides punctuation handling per whitespace-separated term instead of per whole query, so `memory long-term budget` now searches its words while a lone punctuated token such as `.txt`, `foo*`, or `RUFU-276` is still matched literally. Live and archived search share the plan; the cold-index LIKE fallback is suppressed only for genuinely literal-only queries.
