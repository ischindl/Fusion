import { AlertTriangle, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { TaskIdIntegrityReport } from "@fusion/core";
import { refreshDashboardHealth } from "../api";
import "./TaskIdIntegrityBanner.css";

interface TaskIdIntegrityBannerProps {
  report: TaskIdIntegrityReport;
  recommendedAction: string;
  onRefresh?: (report: TaskIdIntegrityReport, recommendedAction: string | null) => void;
}

const ANOMALY_LABELS: Record<TaskIdIntegrityReport["anomalies"][number]["kind"], string> = {
  duplicate_active_id: "Duplicate active task ID",
  id_in_active_and_archived: "Task ID present in active and archived storage",
  next_sequence_at_or_below_used: "Allocator next sequence overlaps an existing task ID",
  task_row_outside_known_prefix: "Task row uses a prefix outside allocator state",
};

function formatAffectedIds(affectedIds: string[]): string {
  if (affectedIds.length <= 5) {
    return affectedIds.join(", ");
  }

  const visible = affectedIds.slice(0, 5).join(", ");
  return `${visible} +${affectedIds.length - 5} more`;
}

export function TaskIdIntegrityBanner({ report, recommendedAction, onRefresh }: TaskIdIntegrityBannerProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  if (report.status !== "anomaly") {
    return null;
  }

  const handleRefresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const health = await refreshDashboardHealth();
      onRefresh?.(health.taskIdIntegrity, health.taskIdIntegrity.recommendedAction);
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "Failed to refresh integrity status.");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section className="task-id-integrity-banner" role="alert" aria-live="assertive">
      <div className="task-id-integrity-banner__header">
        <div className="task-id-integrity-banner__headline-wrap">
          <span className="status-dot status-dot--error" aria-hidden="true" />
          <AlertTriangle aria-hidden="true" />
          <h2 className="task-id-integrity-banner__headline">Task ID integrity anomaly detected</h2>
        </div>
        <button
          type="button"
          className="btn btn-sm task-id-integrity-banner__refresh"
          onClick={() => {
            void handleRefresh();
          }}
          disabled={refreshing}
        >
          <RefreshCw className={refreshing ? "task-id-integrity-banner__refresh-icon task-id-integrity-banner__refresh-icon--spinning" : "task-id-integrity-banner__refresh-icon"} aria-hidden="true" />
          {refreshing ? "Re-checking…" : "Re-check"}
        </button>
      </div>

      <p className="task-id-integrity-banner__body">
        Fusion found allocator state that can cause task IDs to be reused or overwrite live task records.
      </p>

      <ul className="task-id-integrity-banner__list">
        {report.anomalies.map((anomaly) => (
          <li
            key={`${anomaly.kind}:${anomaly.prefix}:${anomaly.affectedIds.join(",")}`}
            className="task-id-integrity-banner__item"
          >
            <strong className="task-id-integrity-banner__item-title">{ANOMALY_LABELS[anomaly.kind]}</strong>
            <span className="task-id-integrity-banner__item-detail">{anomaly.details}</span>
            <code className="task-id-integrity-banner__ids">{formatAffectedIds(anomaly.affectedIds)}</code>
          </li>
        ))}
      </ul>

      <p className="task-id-integrity-banner__footer">{recommendedAction}</p>
      {refreshError ? <p className="task-id-integrity-banner__error">{refreshError}</p> : null}
    </section>
  );
}
