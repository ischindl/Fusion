import {
  defineConfig,
  recommendedAcceptedAttributes,
  recommendedAcceptedTags,
} from "i18next-cli";


const DEFERRED_I18N_LINT_FILES = [
  // FNXC:i18n-LintBaseline 2026-06-20-00:00:
  // FN-6770 and FN-6771 localized the remaining workflow/task/setup/PR and settings/sections clusters, so no dashboard component files remain deferred from hardcoded-string lint.
] as const;

/**
 * i18next-cli workflow config for the whole monorepo.
 *
 * - `extract` pulls t()/<Trans> keys from the dashboard and CLI source into the
 *   authored `en` catalogs under @fusion/i18n.
 * - `sync` propagates the `en` key structure to the secondary locales.
 * - `types` regenerates key types from the `en` catalogs.
 * - `status` runs the project key-parity gate: structure only, empty values allowed.
 * - `status:report` preserves the upstream translation-completeness report.
 * - `lint` flags hardcoded user-facing strings (primary guardrail).
 *
 * FNXC:i18n-ParityGate 2026-06-20-00:00:
 * `pnpm i18n:status` points at packages/i18n/scripts/check-i18n-parity.mjs because empty secondary-locale values are intentional fallback placeholders, not gate failures.
 * Use `pnpm i18n:status:report` when a human wants the upstream completeness report that still counts empty placeholders as untranslated.
 *
 * Namespaces are routed by the `ns:` prefix in keys / `useTranslation(ns)` in
 * source, not by file path. `common` is the default namespace.
 */
export default defineConfig({
  locales: ["en", "zh-CN", "zh-TW", "fr", "es", "ko", "pt-BR"],
  extract: {
    input: [
      "packages/dashboard/app/**/*.{ts,tsx}",
      "packages/cli/src/**/*.{ts,tsx}",
      "!**/__tests__/**",
      "!**/*.test.*",
    ],
    output: "packages/i18n/locales/{{language}}/{{namespace}}.json",
    primaryLanguage: "en",
    defaultNS: "common",
    keySeparator: ".",
    nsSeparator: ":",
    // FNXC:i18n-ParityGate 2026-06-20-00:00:
    // Untranslated secondary-locale keys stay empty for runtime fallback to `en`; `status` now gates structural key parity only, while `status:report` measures real completion.
    defaultValue: "",
    /*
    FNXC:i18n-DynamicKeyPreservation 2026-09-02-07:17:
    `extract` prunes keys no static `t()`/`<Trans>` call site references, but some live copy is reachable ONLY through
    runtime-composed keys the AST scanner cannot see: template-literal calls (`t(`models.options.${level}`)`,
    `t(`taskHistory.verdict.${token}`)`, `t(`systemStats.agent${State}`)`, `t(`settings.general.reportTargetOverride.${action}`)`)
    and settings-search metadata that builds `helpKey: `settings.jira.${key}Help``.
    Without patterns these keys are deleted as "unused" on the next extraction, silently reverting translated UI to inline
    fallbacks (measured: the RUFU-176 extraction catch-up deleted 35 such keys — `models.options.*`, `systemStats.agent*`,
    the three `taskHistory.*` families, `settings.general.reportTargetOverride.*`, and three settings rows the FN-7505
    guard caught) before the regression was restored from the pre-catch-up catalog. Patterns cover exactly the families proven dynamic-only by that incident — keys
    with literal call sites (sibling `settings.*` copy, `insights.category.*`, `skills.*`, `theme.mode*`) are deliberately
    NOT listed, so ordinary extraction keeps managing them; a stale key listed here is preserved forever, so this list must
    shrink, not grow, as call sites become static.

    FNXC:i18n-DynamicKeyPreservation 2026-09-02-16:48:
    The same RUFU-176 catch-up deleted a second, larger class of 49 live `app` keys, and the reason was NOT a
    runtime-composed key: the call site held a string literal, but the scanner could not bind it to the `app` namespace,
    so it wrote the key to `defaultNS` (`common`) and pruned the `app` entry the runtime actually reads. Two shapes cause
    this: (a) a literal in a registry table consumed by a dynamic call (`labelKey: "skills.autoAvailable"` read back as
    `t(classification.labelKey, classification.defaultLabel)`; the earlier note's claim that `skills.*` is literal-bound is
    true only for `skills.forced`-style direct calls), and (b) a real `t("key", "default")` call whose `t` arrives as a
    parameter typed `TFunction<"app">` in a module with no `useTranslation` (`utils/duplicateTaskAction.ts`,
    `components/TaskContextMenu.tsx`, `components/ArtifactMedia.tsx`, and the module-level helpers inside
    `TaskDetailModal.tsx`/`Column.tsx`). `t(...)` under any of those shapes resolves against `app` at runtime
    (`App.tsx`, `MobileNavBar`, `AgentDetailView`, `TaskHistoryTab` all bind `useTranslation("app")` and thread that `t`
    down), so an entry parked only in `common.json` is invisible and the string silently reverts to its inline English
    default for every non-English operator. Patterns below pin exactly the families proven broken by that measurement;
    prefer moving a call site to a bound `t` (or an explicit `app:` key prefix) over adding to this list.
    */
    preservePatterns: [
      "app:models.options.*",
      "app:systemStats.agent*",
      "app:taskHistory.empty.*",
      "app:taskHistory.stage.*",
      "app:taskHistory.verdict.*",
      "app:taskHistory.entry.*",
      "app:settings.general.reportTargetOverride.*",
      "app:settings.jira.enabledHelp",
      "app:settings.globalGeneral.autoUpdateAndRestartHelp",
      "app:settings.general.reportTargetByActionHelp",
      // Registry-consumed labels: the literal lives in a table, the call is `t(row.labelKey, row.defaultLabel)`.
      "app:nav.*",
      "app:skills.autoAvailable*",
      "app:skills.disabledSkill*",
      "app:skills.notDiscovered*",
      "app:skills.skillStatePending*",
      // App-namespaced copy reached through a `TFunction<"app">` parameter the scanner cannot namespace-bind.
      "app:taskDetail.duplicate.*",
      "app:taskDetail.pr.*",
      "app:taskDetail.pause.*",
      "app:taskDetail.gitlabTracking.kind*",
      "app:taskDetail.refine.btn",
      "app:taskDetail.retry.btn",
      "app:taskDetail.bypassReview.btn",
      "app:board.rejection.unplannedForExecution",
      "app:documents.noArtifactPreview",
      "app:app.backendError.failedFetch",
      "app:commandCenter.agentActivity.workflowGateNotRun",
    ],
  },
  types: {
    input: ["packages/i18n/locales/en/*.json"],
    output: "packages/i18n/src/i18next-resources.d.ts",
  },
  lint: {
    /*
     * FNXC:i18n-LintBaseline 2026-06-19-00:00:
     * i18n lint must scan the same shipping surfaces as extract so it remains a trusted user-facing-copy guardrail.
     * Tests and stories are excluded because they are non-shipping fixtures and extract already excludes test files.
     * Keyboard-key glyphs inside <kbd> are technical tokens, not translated prose.
     */
    ignore: ["**/__tests__/**", "**/*.test.*", "**/*.stories.*", ...DEFERRED_I18N_LINT_FILES],
    ignoredTags: ["kbd"],
    acceptedTags: recommendedAcceptedTags,
    acceptedAttributes: recommendedAcceptedAttributes,
  },
});
