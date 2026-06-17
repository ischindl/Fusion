import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ActivityAnalytics } from "@fusion/core";
import type { DateRange } from "../DateRangePicker";
import { Sparkline } from "../charts/Sparkline";
import { AreaShell } from "./AreaShell";
import { useAnalyticsArea } from "./useAnalyticsArea";
import { formatCount } from "./areaShared";

/**
 * Activity area: sessions / messages / active-nodes / stickiness (DAU/MAU) over
 * the range, plus per-day sparklines for messages and active nodes.
 */
export function ActivityArea({ range }: { range: DateRange }) {
  const { t } = useTranslation("app");
  const { data, isLoading, error } = useAnalyticsArea<ActivityAnalytics>("/command-center/activity", range);

  const daily = useMemo(() => data?.daily ?? [], [data?.daily]);
  const messagesSeries = useMemo(() => daily.map((d) => d.messages), [daily]);
  const nodesSeries = useMemo(() => daily.map((d) => d.activeNodes), [daily]);

  const isEmpty =
    !data ||
    (data.sessions === 0 && data.messages === 0 && data.activeNodes === 0 && data.activeAgents === 0);

  return (
    <AreaShell testId="activity" isLoading={isLoading} error={error} isEmpty={isEmpty}>
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

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.activity.messagesPerDay", "Messages / day")}</h3>
        <Sparkline
          values={messagesSeries}
          ariaLabel={t("commandCenter.activity.messagesPerDay", "Messages / day")}
        />
      </div>

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.activity.nodesPerDay", "Active nodes / day")}</h3>
        <Sparkline values={nodesSeries} ariaLabel={t("commandCenter.activity.nodesPerDay", "Active nodes / day")} />
      </div>
    </AreaShell>
  );
}
