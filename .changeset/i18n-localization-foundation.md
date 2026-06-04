---
"@runfusion/fusion": minor
---

Add a localization (i18n) foundation across the UI. Introduces react-i18next-backed translation for both the dashboard and the terminal UI, with English as the source language and Simplified Chinese, Traditional Chinese, French, and Spanish as target locales.

- New `@fusion/i18n` package holding the authored catalogs and shared i18next configuration (namespace split, script-aware zh-CN/zh-TW fallback, plural setup).
- A `language` preference (`fusion settings`) and a Settings language switcher; the CLI resolves locale from `--lang`, settings, then environment.
- An `i18next-cli` workflow (`extract`/`sync`/`types`/`status`/`lint`) so adding a future language is a translate-only, near-zero-code operation.
