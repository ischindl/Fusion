import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ProductivityAnalytics } from "@fusion/core";
import type { DateRange } from "../DateRangePicker";
import { Bar } from "../charts/Bar";
import { AreaShell } from "./AreaShell";
import { useAnalyticsArea } from "./useAnalyticsArea";
import { formatCount } from "./areaShared";

/**
 * Productivity area. Per the plan's A5 framing, LOC and tool/file counts are
 * presented as *volume* proxies, kept visually distinct from outcome counters
 * (PRs, commits). Unavailable LOC renders the "—" sentinel with a tooltip,
 * NEVER 0.
 *
 * FNXC:CommandCenter 2026-06-16-09:42:
 * Productivity area of the Command Center (PR #1683). Volume proxies (files/LOC) must read as distinct
 * from outcome counters (PRs/commits), and missing LOC must render "—", never 0, to avoid implying zero work.
 */
export function ProductivityArea({ range }: { range: DateRange }) {
  const { t } = useTranslation("app");
  const { data, isLoading, error } = useAnalyticsArea<ProductivityAnalytics>(
    "/command-center/productivity",
    range,
  );

  const languageBars = useMemo(
    () =>
      (data?.byLanguage ?? []).slice(0, 12).map((l) => ({
        label: l.language,
        value: l.count,
        valueLabel: formatCount(l.count),
      })),
    [data?.byLanguage],
  );

  const isEmpty =
    !data ||
    (data.modifiedFiles === 0 && data.commits === 0 && data.pullRequests === 0);

  const locUnavailable = !data || data.loc.unavailable || data.loc.value === null;

  return (
    <AreaShell testId="productivity" isLoading={isLoading} error={error} isEmpty={isEmpty}>
      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.productivity.outcomesTitle", "Outcomes")}</h3>
        <div className="cc-stat-grid">
          <div className="card cc-stat-card" data-testid="cc-productivity-commits">
            <div className="cc-stat-label">{t("commandCenter.productivity.commits", "Commits")}</div>
            <div className="cc-stat-value">{formatCount(data?.commits ?? 0)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-productivity-prs">
            <div className="cc-stat-label">{t("commandCenter.productivity.pullRequests", "Pull requests")}</div>
            <div className="cc-stat-value">{formatCount(data?.pullRequests ?? 0)}</div>
          </div>
        </div>
      </div>

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.productivity.volumeTitle", "Volume (proxy)")}</h3>
        <div className="cc-stat-grid">
          <div className="card cc-stat-card" data-testid="cc-productivity-files">
            <div className="cc-stat-label">{t("commandCenter.productivity.modifiedFiles", "Files modified")}</div>
            <div className="cc-stat-value">{formatCount(data?.modifiedFiles ?? 0)}</div>
            <span className="cc-stat-sub">{t("commandCenter.productivity.volumeHint", "volume, not outcome")}</span>
          </div>
          <div className="card cc-stat-card" data-testid="cc-productivity-loc">
            <div className="cc-stat-label">{t("commandCenter.productivity.loc", "Lines changed")}</div>
            <div className="cc-stat-value">
              {locUnavailable ? (
                <span
                  className="cc-unavailable"
                  title={t(
                    "commandCenter.productivity.locUnavailable",
                    "LOC is unavailable until commit diff stats are recorded",
                  )}
                  data-testid="cc-productivity-loc-unavailable"
                >
                  —
                </span>
              ) : (
                formatCount(data.loc.value ?? 0)
              )}
            </div>
            <span className="cc-stat-sub">{t("commandCenter.productivity.volumeHint", "volume, not outcome")}</span>
          </div>
        </div>
      </div>

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">
          {t("commandCenter.productivity.byLanguage", "Files by language")}
        </h3>
        <Bar data={languageBars} ariaLabel={t("commandCenter.productivity.byLanguage", "Files by language")} />
      </div>
    </AreaShell>
  );
}
