---
"@runfusion/fusion": minor
---

summary: `fn task create` now names the project a card lands in and asks before filing it into another one.
category: feature
dev: `ProjectContext` gains optional `resolvedFrom` (flag/default/cwd/cwd-fallback) and `cwdProject`; `create`/`duplicate`/`refine` print the absolute card path; `fn task create` parses `--yes` (it previously leaked into the card title). Resolution precedence is unchanged.
