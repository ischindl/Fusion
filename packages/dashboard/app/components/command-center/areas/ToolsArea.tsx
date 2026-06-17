import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ToolAnalytics } from "@fusion/core";
import type { DateRange } from "../DateRangePicker";
import { Bar } from "../charts/Bar";
import { AreaShell } from "./AreaShell";
import { useAnalyticsArea } from "./useAnalyticsArea";
import { formatCount } from "./areaShared";

/**
 * Tools area: autonomy ratio readout + tool categories rendered as a bar chart
 * sorted descending by count (the endpoint already returns `byCategory`
 * descending, but we re-sort defensively so display order never depends on
 * server ordering).
 *
 * FNXC:CommandCenter 2026-06-16-09:42:
 * Tools area of the Command Center (PR #1683). Shows the autonomy ratio plus tool-category usage; display
 * order is re-sorted client-side so it never silently depends on server ordering.
 */
export function ToolsArea({ range }: { range: DateRange }) {
  const { t } = useTranslation("app");
  const { data, isLoading, error } = useAnalyticsArea<ToolAnalytics>("/command-center/tools", range);

  const sortedCategories = useMemo(
    () => [...(data?.byCategory ?? [])].sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
    [data?.byCategory],
  );

  const barData = useMemo(
    () =>
      sortedCategories.map((c) => ({
        label: c.category,
        value: c.count,
        valueLabel: formatCount(c.count),
      })),
    [sortedCategories],
  );

  const isEmpty = !data || data.toolCalls === 0;

  const ratioLabel = data
    ? data.fullyAutonomous
      ? t("commandCenter.tools.ratioAutonomous", "{{ratio}} calls/session (fully autonomous)", {
          ratio: data.autonomyRatio.toFixed(1),
        })
      : `${data.autonomyRatio.toFixed(1)}:1`
    : "—";

  return (
    <AreaShell testId="tools" isLoading={isLoading} error={error} isEmpty={isEmpty}>
      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.tools.summaryTitle", "Summary")}</h3>
        <div className="cc-stat-grid">
          <div className="card cc-stat-card" data-testid="cc-tools-autonomy">
            <div className="cc-stat-label">{t("commandCenter.tools.autonomyRatio", "Autonomy ratio")}</div>
            <div className="cc-stat-value">{ratioLabel}</div>
            <span className="cc-stat-sub">
              {t("commandCenter.tools.autonomyHint", "tool calls per human intervention")}
            </span>
          </div>
          <div className="card cc-stat-card">
            <div className="cc-stat-label">{t("commandCenter.tools.toolCalls", "Tool calls")}</div>
            <div className="cc-stat-value">{formatCount(data?.toolCalls ?? 0)}</div>
          </div>
          <div className="card cc-stat-card">
            <div className="cc-stat-label">{t("commandCenter.tools.interventions", "Interventions")}</div>
            <div className="cc-stat-value">{formatCount(data?.interventions.total ?? 0)}</div>
            <span className="cc-stat-sub">
              {t("commandCenter.tools.interventionBreakdown", "{{approvals}} approvals · {{steers}} steers", {
                approvals: formatCount(data?.interventions.approvals ?? 0),
                steers: formatCount(data?.interventions.userSteers ?? 0),
              })}
            </span>
          </div>
          <div className="card cc-stat-card">
            <div className="cc-stat-label">{t("commandCenter.tools.sessions", "Sessions")}</div>
            <div className="cc-stat-value">{formatCount(data?.sessions ?? 0)}</div>
          </div>
        </div>
      </div>

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.tools.categoriesTitle", "Tool categories")}</h3>
        <Bar data={barData} ariaLabel={t("commandCenter.tools.categoriesTitle", "Tool categories")} />
      </div>
    </AreaShell>
  );
}
