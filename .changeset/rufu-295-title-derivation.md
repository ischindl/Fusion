---
"@runfusion/fusion": minor
---

summary: Cards get a real one-line title from `--title` or the description's first sentence; adds `fn task rename`.
category: feature
dev: `deriveTaskLabelFromDescription` in `@fusion/core` is the single derivation for every derived label — board display, tool/CLI list labels, and the Patchnode delivery ledger. `PATCHNODE_DESCRIPTION_LABEL_LENGTH` stays 220 but its content is now derived, so a heading-first description can no longer freeze `## Pôvodný popis` into History; `planPatchnodeLabelRepair` additionally admits a stored label that is provably junk (equals its task id, starts with an ATX heading, or contains a newline) and remains idempotent. New inputs: `fn task create --title`, `fn task rename <id> "<title>"`, and optional `title` on `fn_task_create` / `fn_delegate_task` / `fn_task_update`; a blank, heading-shaped, multi-line, or over-220-character title is refused rather than stored.
