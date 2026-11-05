---
"@runfusion/fusion": minor
---

summary: Agent-authored text carrying stray foreign-alphabet characters is now refused before it reaches the board.
category: feature
dev: Agent tool writes (task create/update/rename, task log, final summary, mail and room messages, memory append, artifact register, CLI delegation) validate an explicitly enumerated allowlist - printable ASCII, newline, and the Slovak diacritic letters - through `findDisallowedAgentTextChars`/`assertAgentTextAllowed` in `@fusion/core`, and refusals name offenders as `U+XXXX` code points. `fn_task_prompt_write` keeps saving and appends a WARNING instead of rejecting, so plan authoring is never dead-locked, and records one bounded `task:agent-text-charset-warned` run-audit row with code points and counts only. Already-stored text is never rewritten.
