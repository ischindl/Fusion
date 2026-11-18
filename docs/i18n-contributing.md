# Localization (i18n) contributor guide

Fusion's UI is localized with [react-i18next]. English (`en`) is the
source-of-truth language; everything else is a translation of it. Both UI
surfaces — the React dashboard and the Ink terminal UI — share one set of
catalogs and config in the `@fusion/i18n` package.

## Where things live

| Path | What it is |
| ---- | ---------- |
| `packages/i18n/locales/{locale}/{namespace}.json` | Authored catalogs (translators edit here). `en` is the source. |
| `packages/i18n/src/config.ts` | Shared i18next config: namespaces, fallback chain, plural setup. |
| `packages/core` (`SUPPORTED_LOCALES`, `Locale`) | The single list of supported locale codes. |
| `i18next.config.ts` (repo root) | `i18next-cli` workflow config. |

Namespaces: `common` (shared), `app` (dashboard-only), `errors`, and `cli`
(terminal-only). The dashboard loads `common`/`app`/`errors`; the CLI loads
`common`/`cli`/`errors`.

## The workflow

All commands run from the repo root:

```bash
pnpm i18n:extract   # SURVEY ONLY - see "Is extraction authoritative?" below
pnpm i18n:sync      # propagate the en key structure to every other locale
pnpm i18n:types     # regenerate key types from the en catalogs
pnpm i18n:status    # key-parity gate: structure only, empty values allowed
pnpm i18n:status:report # upstream completeness report (informational; may exit non-zero)
pnpm i18n:lint      # flag hardcoded user-facing strings
pnpm i18n:gen-cli   # regenerate the CLI static catalog import map
pnpm check:i18n-extract-clean # measure what `extract` would churn, then restore
```

`pnpm i18n:status` must be green before landing catalog or extraction changes,
but it only verifies that every secondary catalog has the same structural keys as
`en`. Empty secondary-locale values (`""`) are expected placeholders and do not
fail the gate because runtime falls back to English. Use
`pnpm i18n:status:report` when you want the upstream completeness report that
counts empty placeholders as untranslated; that report is informational and may
exit non-zero until translations are filled.

## Is extraction authoritative?

**No. Do not commit the output of `pnpm i18n:extract`.** The sanctioned way to add a key is to author
it in `packages/i18n/locales/en/<namespace>.json` by hand and then run `pnpm i18n:sync` and
`pnpm i18n:types`. Extraction is kept in the toolbelt as a *survey* of what the scanner can and cannot
see, not as a generator of the catalogs.

This is a measured conclusion, taken on a clean tree at the 2026-11 base. One `pnpm i18n:extract` run
rewrites 17 catalog files and 161,008 lines, and it is deterministic — three consecutive runs are
byte-identical — so the problem is not instability, it is what its fixed point contains:

| What extraction does | Measured |
| ---- | ---- |
| Deletes keys that no scanner can bind | 910 keys per locale, 6,370 across the seven. Only 541 have no leaf occurrence anywhere in `extract.input`; 26 carry their full dotted key as a quoted literal in source and are read back through a dynamic `t(row.key, row.fallback)` — the registry tables in `PostMergeEvidenceStatus.tsx` (`postMergeEvidence.{kind,provider,reason}.*`), `tasks.humanMergeApproval.reason.*`, `uiStyle.*`. |
| Moves keys into the default namespace | 135 keys per locale go `app` -> `common`. In each secondary locale 110-118 of them arrive as `""`, so **~684 translated values are destroyed**, and an `app`-bound call site stops resolving even where the text survives. |
| Re-sorts everything | 74,835 of the 161,008 lines (93%) are byte-identical content that only moved, because the authored catalogs are not in the extractor's collation order. The destructive 7% therefore cannot be reviewed separately from the cosmetic 93%. |
| Invents keys | `en/app.json` gains a top-level key literally named `"…disposition"` from a template literal. |

For comparison, measured on the same tree: `pnpm i18n:sync` costs 504 churn lines with zero keys lost
and zero values emptied, and `pnpm i18n:types` costs 22 lines. The catalogs stay hand-authored precisely
so that a scanner cannot decide what the product says.

`pnpm check:i18n-extract-clean` is what keeps that decision from decaying into folklore. It refuses to
run on a dirty `packages/i18n` tree, runs the sanctioned extraction, measures the churn against
`EXTRACT_CHURN_BASELINE` in `packages/i18n/scripts/check-i18n-extract-clean.mjs`, and always restores the
tree — including removing any file the run created — before it exits. The budget is **shrink-only**: when
the number falls, lower the constant to the reported value; when it grows, the check fails, because that
means extraction wants to remove or relocate more than it did when the decision was made. Landing the
keys a surface was missing moves the number down, which is the only movement it rewards: landing the
24 keys per locale this card added took the budget from 161,008 to 159,534 on its first run.

### The gates cannot see a missing key, either

`pnpm i18n:status` compares key *structure* and tolerates empty values, so it cannot notice that a key
moved namespace, and it never notices a `t()` call site that has no catalog entry at all. The only value
guard, `stall-catalog-values.test.ts`, covers the `stall.*` subtree. That gap is how RUFU-718 shipped six
reason-specific board rejection sentences in `Column.tsx` without a single catalog entry and the board
printed `board.rejection.unplannedForExecutionNeedsReplan` at operators.

Two rules follow, both machine-checked:

1. Every `t("<literal>", "<default>")` you add needs its key authored in the namespace the surface binds.
   `useTranslation("app")` resolves from `app.json`; a key that lands only in `common.json` does not
   resolve there. `board-rejection-catalog.test.ts` is the pattern to copy for copy you must not lose.
2. A key present in two namespaces is inert in one of them. `i18n-duplicate-keys.test.ts` scans all 28
   catalog files for intra-file duplicates and holds cross-namespace duplication at a measured
   shrink-only budget (50 leaf paths per locale in 32 groups today, `board.rejection` among them).

## Lint baseline policy

`pnpm i18n:lint` is the hardcoded user-facing string guardrail and must stay
green. Its file scope intentionally matches extraction: tests and stories are
excluded because they are non-shipping fixtures and `extract` already ignores
them. Suppress non-translatable token categories with narrow
`lint.ignoredTags` / `lint.ignoredAttributes` entries, such as keyboard-key
content in `<kbd>`, instead of hiding source directories.

Any remaining user-facing copy must be localized with `t()` / `<Trans>` and an
`en` catalog entry. A temporary deferral is only acceptable when it is scoped to
specific files or a small cluster in `lint.ignore`, includes an `FNXC` rationale,
and has a filed follow-up task that removes the ignore. The settings sections
cluster is no longer deferred as of FN-6771; keep those files covered by lint.
The production catalog currently has a clean lint baseline: `pnpm i18n:lint`
must finish with `No issues found.`. Keep the executable regression alongside the
catalog tests so future shipping copy cannot reintroduce debt:

```bash
pnpm --filter @fusion/i18n exec vitest run src/__tests__/i18n-lint-baseline.test.ts src/__tests__/i18n-gate-coverage.test.ts --silent=passed-only --reporter=dot
```

`i18n-lint-baseline.test.ts` imports the root `i18next.config.ts` and calls the
installed `runLinter` API directly. It therefore checks the same production
inputs as the CLI rather than relying on a mocked catalog or a source-text count.
The `@fusion/i18n` regression tests also assert the lint-ignore scope and live
catalog key parity so those guardrails cannot silently drift.

## Translating an existing language

1. Run `pnpm i18n:sync` so every catalog has the current `en` keys (untranslated
   entries are empty strings).
2. Fill the empty strings in `packages/i18n/locales/{locale}/*.json`.
3. Keep interpolation placeholders verbatim: `{{brand}}`, `{{detail}}`,
   `{{key}}`. Never translate a `[{{key}}]` keybinding accelerator — only the
   words around it.
4. Run `pnpm i18n:status` to confirm key parity still holds, then optionally run
   `pnpm i18n:status:report` to inspect remaining untranslated placeholders.

`zh-CN` and `zh-TW` are independent — different script **and** vocabulary. Do
not machine-convert one into the other.

## Adding a new language (near-zero code)

1. Add the locale code to `SUPPORTED_LOCALES` in `packages/core/src/types.ts`
   and to `locales` in `i18next.config.ts`.
2. `pnpm i18n:sync` — scaffolds a full set of catalog files for the new locale
   with the correct plural categories.
3. `pnpm i18n:gen-cli` — adds the locale to the CLI's static import map.
4. Run `pnpm i18n:status` to verify the new locale has the same key structure as
   `en`. Translate the new catalogs as time allows, using
   `pnpm i18n:status:report` as the informational completeness report.

No feature code changes are required: the dashboard discovers the locale through
the generated `app/locales/` tree, and the CLI through the regenerated import
map. Add the language's endonym to `ENDONYMS` in
`packages/dashboard/app/components/LanguageSelector.tsx` so it appears in the
Settings switcher, add a prompt label to `LOCALE_LABELS` in
`packages/dashboard/src/ai-translate.ts` (compile-enforced), and add a display
name to `localeDisplayName` in
`packages/core/src/i18n/detect-content-language.ts`. For Latin-script languages,
also consider a stopword list in `LATIN_STOPWORDS` there so content-language
detection can recognize the language (entries must be accent-stripped).

## Using a non-English locale

- **Dashboard / mobile:** Settings → Appearance → Language. The choice persists
  to `localStorage` and to server settings.
- **Terminal UI:** resolved from `--lang <code>` → the saved dashboard language
  setting → the `LC_ALL`/`LC_MESSAGES`/`LANG`/`LANGUAGE` environment → `en`.

  ```bash
  fusion dashboard --lang zh-TW
  ```

[react-i18next]: https://react.i18next.com/
