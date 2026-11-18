---
"@runfusion/fusion": patch
---

summary: Board move rejections now show their full sentence instead of a raw translation key.
category: fix
dev: The six `board.rejection.unplannedForExecution*` keys are authored in `app.json` for all seven locales and propagated with `pnpm i18n:sync`. `pnpm i18n:extract` is now documented as non-authoritative - never commit its output (measured: 161,008 churn lines, 910 keys pruned per locale, ~684 secondary-locale translations emptied). Add `pnpm check:i18n-extract-clean` to measure its churn against a shrink-only budget and restore the tree. The duplicate-key scan now covers all 28 catalog files and a measured cross-namespace budget.
