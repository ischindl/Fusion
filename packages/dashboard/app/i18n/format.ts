import { useMemo } from "react";
import { useTranslation } from "react-i18next";

/**
 * Locale-aware date/number formatting bound to the active i18n locale.
 *
 * Replaces the ~45 `toLocale*(undefined, …)` call sites that previously used
 * the implicit browser locale. Routing them through this hook threads the
 * user's chosen language into all date/number formatting (R8).
 */
export function useLocaleFormat() {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language || "en";

  // Memoized per locale so the formatter identities stay stable across
  // renders — consumers can safely put them in hook dependency arrays.
  return useMemo(
    () => ({
      locale,
      formatDate: (value: number | string | Date, options?: Intl.DateTimeFormatOptions) =>
        new Date(value).toLocaleDateString(locale, options),
      formatTime: (value: number | string | Date, options?: Intl.DateTimeFormatOptions) =>
        new Date(value).toLocaleTimeString(locale, options),
      formatDateTime: (value: number | string | Date, options?: Intl.DateTimeFormatOptions) =>
        new Date(value).toLocaleString(locale, options),
      formatNumber: (value: number, options?: Intl.NumberFormatOptions) =>
        value.toLocaleString(locale, options),
    }),
    [locale],
  );
}
