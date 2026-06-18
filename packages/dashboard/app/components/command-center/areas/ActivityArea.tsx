import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ActivityAnalytics } from "@fusion/core";
import type { DateRange } from "../DateRangePicker";
import { LineChart } from "../charts/LineChart";
import { AreaShell } from "./AreaShell";
import { useAnalyticsArea } from "./useAnalyticsArea";
import { formatCount, isInvalidRange } from "./areaShared";

const ACTIVITY_LIVE_REFRESH_MS = 15_000;

/**
 * FNXC:CommandCenter 2026-06-18-14:29:
 * Activity metrics surface as live, animated line charts auto-refreshed via reload() on a bounded interval; motion is decorative and reduced-motion-safe, uses the existing activity endpoint, and keeps prior data visible during polling revalidation.
 */
export function ActivityArea({ range }: { range: DateRange }) {
  const { t } = useTranslation("app");
  const { data, isLoading, error, reload } = useAnalyticsArea<ActivityAnalytics>("/command-center/activity", range);

  const daily = useMemo(() => data?.daily ?? [], [data?.daily]);
  const messagesSeries = useMemo(() => daily.map((d) => d.messages), [daily]);
  const agentsSeries = useMemo(() => daily.map((d) => d.activeAgents), [daily]);
  const nodesSeries = useMemo(() => daily.map((d) => d.activeNodes), [daily]);
  const throughputSeries = useMemo(
    () => daily.map((d) => d.messages + d.activeAgents + d.activeNodes),
    [daily],
  );
  const invalidRange = isInvalidRange(range);
  const isInitialLoading = isLoading && data === null;

  useEffect(() => {
    if (invalidRange) {
      return undefined;
    }
    const interval = window.setInterval(() => {
      reload();
    }, ACTIVITY_LIVE_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [invalidRange, reload]);

  const isEmpty =
    !data ||
    (data.sessions === 0 && data.messages === 0 && data.activeNodes === 0 && data.activeAgents === 0);

  return (
    <AreaShell testId="activity" isLoading={isInitialLoading} error={error} isEmpty={isEmpty}>
      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.activity.summaryTitle", "Summary")}</h3>
        <div className="cc-stat-grid">
          <div className="card cc-stat-card" data-testid="cc-activity-sessions">
            <div className="cc-stat-label">{t("commandCenter.activity.sessions", "Sessions")}</div>
            <div className="cc-stat-value">{formatCount(data?.sessions ?? 0)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-activity-messages">
            <div className="cc-stat-label">{t("commandCenter.activity.messages", "Messages")}</div>
            <div className="cc-stat-value">{formatCount(data?.messages ?? 0)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-activity-nodes">
            <div className="cc-stat-label">{t("commandCenter.activity.activeNodes", "Active nodes")}</div>
            <div className="cc-stat-value">{formatCount(data?.activeNodes ?? 0)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-activity-agents">
            <div className="cc-stat-label">{t("commandCenter.activity.activeAgents", "Active agents")}</div>
            <div className="cc-stat-value">{formatCount(data?.activeAgents ?? 0)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-activity-stickiness">
            <div className="cc-stat-label">{t("commandCenter.activity.stickiness", "Stickiness")}</div>
            <div className="cc-stat-value">{data ? `${Math.round(data.stickiness * 100)}%` : "—"}</div>
            <span className="cc-stat-sub">{t("commandCenter.activity.stickinessHint", "DAU / MAU")}</span>
          </div>
        </div>
      </div>

      <div className="cc-area-section" data-testid="cc-activity-line-messages">
        <h3 className="cc-area-section-title">{t("commandCenter.activity.messagesPerDay", "Messages / day")}</h3>
        <LineChart
          series={[{ label: t("commandCenter.activity.messages", "Messages"), values: messagesSeries }]}
          ariaLabel={t("commandCenter.activity.messagesPerDay", "Messages / day")}
        />
      </div>

      <div className="cc-area-section" data-testid="cc-activity-line-agents">
        <h3 className="cc-area-section-title">{t("commandCenter.activity.agentsPerDay", "Active agents / day")}</h3>
        <LineChart
          series={[{ label: t("commandCenter.activity.activeAgents", "Active agents"), values: agentsSeries }]}
          ariaLabel={t("commandCenter.activity.agentsPerDay", "Active agents / day")}
        />
      </div>

      <div className="cc-area-section" data-testid="cc-activity-line-nodes">
        <h3 className="cc-area-section-title">{t("commandCenter.activity.nodesPerDay", "Active nodes / day")}</h3>
        <LineChart
          series={[{ label: t("commandCenter.activity.activeNodes", "Active nodes"), values: nodesSeries }]}
          ariaLabel={t("commandCenter.activity.nodesPerDay", "Active nodes / day")}
        />
      </div>

      <div className="cc-area-section" data-testid="cc-activity-line-throughput">
        <h3 className="cc-area-section-title">{t("commandCenter.activity.throughputPerDay", "Throughput / day")}</h3>
        <LineChart
          series={[{ label: t("commandCenter.activity.throughput", "Throughput"), values: throughputSeries }]}
          ariaLabel={t("commandCenter.activity.throughputPerDay", "Throughput / day")}
        />
      </div>
    </AreaShell>
  );
}
