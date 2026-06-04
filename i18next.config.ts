import {
  defineConfig,
  recommendedAcceptedAttributes,
  recommendedAcceptedTags,
} from "i18next-cli";

/**
 * i18next-cli workflow config for the whole monorepo.
 *
 * - `extract` pulls t()/<Trans> keys from the dashboard and CLI source into the
 *   authored `en` catalogs under @fusion/i18n.
 * - `sync` propagates the `en` key structure to the four other locales.
 * - `types` regenerates key types from the `en` catalogs.
 * - `status` reports per-locale completion (CI gate).
 * - `lint` flags hardcoded user-facing strings (primary guardrail).
 *
 * Namespaces are routed by the `ns:` prefix in keys / `useTranslation(ns)` in
 * source, not by file path. `common` is the default namespace.
 */
export default defineConfig({
  locales: ["en", "zh-CN", "zh-TW", "fr", "es", "ko"],
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
    // Untranslated secondary-locale keys stay empty so `status` can measure
    // real completion; the active locale falls back to `en` at runtime.
    defaultValue: "",
  },
  types: {
    input: ["packages/i18n/locales/en/*.json"],
    output: "packages/i18n/src/i18next-resources.d.ts",
  },
  lint: {
    acceptedTags: recommendedAcceptedTags,
    acceptedAttributes: recommendedAcceptedAttributes,
  },
});
