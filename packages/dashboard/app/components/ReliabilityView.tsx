import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import "./ReliabilityView.css";

type ReliabilityResponse = {
  windowDays: number;
  generatedAt: string;
  resetAt: string | null;
  headline: { inReviewFailureRate7d: number | null; reason?: string };
  perDay: Array<{
    date: string;
    tasksEnteredInReview: number;
    tasksBouncedToInProgress: number;
    postMergeAuditFailures: { block: number; warn: number; off: number } | null;
    fileScopeInvariantFailures: number | null;
    recoverAlreadyMergedReviewTasksRecoveries: number | null;
    hasSamples?: boolean;
  }>;
  duration: { p50Ms: number | null; p95Ms: number | null; sampleCount: number; reason?: string };
  mergeAttempts: { mean: number | null; max: number | null; histogram: Record<string, number>; reason?: string };
};

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(value: number | null): string {
  if (value === null) {
    return "—";
  }
  return `${(value / 60_000).toFixed(1)}m`;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "—";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function ReliabilityView() {
  const { t } = useTranslation("app");
  const [data, setData] = useState<ReliabilityResponse | null>(null);
  const [showEmptyDays, setShowEmptyDays] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/health/reliability");
    if (!response.ok) {
      throw new Error(`Failed to load reliability metrics (${response.status})`);
    }
    const payload = (await response.json()) as ReliabilityResponse;
    setData(payload);
  }, []);

  const resetStats = useCallback(async () => {
    setResetError(null);
    const response = await fetch("/api/health/reliability/reset", { method: "POST" });
    if (!response.ok) {
      throw new Error(`Failed to reset reliability metrics (${response.status})`);
    }
    await load();
    setShowResetConfirm(false);
  }, [load]);

  useEffect(() => {
    void load();
    const pollInterval = setInterval(() => {
      void load();
    }, 60_000);
    return () => clearInterval(pollInterval);
  }, [load]);

  const failureRate = data?.headline.inReviewFailureRate7d;
  const reliabilityRate = useMemo(() => {
    if (failureRate === null || failureRate === undefined) return null;
    return Math.max(0, Math.min(1, 1 - failureRate));
  }, [failureRate]);

  const headlineColorVar = useMemo(() => {
    if (reliabilityRate === null) return "var(--text-muted)";
    if (reliabilityRate >= 0.95) return "var(--color-success)";
    if (reliabilityRate >= 0.9) return "var(--color-warning)";
    return "var(--color-error)";
  }, [reliabilityRate]);

  const totalEntered = useMemo(() => (data?.perDay ?? []).reduce((sum, row) => sum + row.tasksEnteredInReview, 0), [data?.perDay]);
  const totalBounced = useMemo(() => (data?.perDay ?? []).reduce((sum, row) => sum + row.tasksBouncedToInProgress, 0), [data?.perDay]);

  const perDayRows = useMemo(() => {
    if (!data?.perDay) return [];
    return showEmptyDays ? data.perDay : data.perDay.filter((row) => row.hasSamples !== false);
  }, [data?.perDay, showEmptyDays]);

  const mergeAttemptTaskCount = useMemo(
    () => Object.values(data?.mergeAttempts.histogram ?? {}).reduce((sum, count) => sum + count, 0),
    [data?.mergeAttempts.histogram],
  );

  const windowStartLabel = data
    ? formatDateTime(data.resetAt ?? new Date(Date.parse(data.generatedAt) - data.windowDays * 86_400_000).toISOString())
    : "—";

  return (
    <section className="reliability-view">
      <div className="card reliability-card reliability-headline-card">
        <div className="reliability-section-header">
          <h2>{t("reliability.heading", "Reliability")}</h2>
          <button className="btn btn-danger btn-sm" onClick={() => setShowResetConfirm(true)}>{t("reliability.resetStats", "Reset stats")}</button>
        </div>
        <div className="reliability-headline" style={{ color: headlineColorVar }}>
          {failureRate === null || failureRate === undefined
            ? t("reliability.insufficientData", "Insufficient data — {{reason}}", { reason: data?.headline.reason ?? "unknown" })
            : formatPercent(reliabilityRate ?? 0)}
        </div>
        {reliabilityRate !== null ? <div className="reliability-muted">{t("reliability.successRateLabel", "In-review success rate (last 7d)")}</div> : null}
        {data?.resetAt ? <div className="reliability-muted">{t("reliability.countingSince", "Counting since {{date}}", { date: formatDateTime(data.resetAt) })}</div> : null}
        <details className="reliability-details">
          <summary>{t("reliability.details", "Details")}</summary>
          <div className="reliability-details-content">
            <div>{t("reliability.bouncedEntered", "{{bounced}} bounced / {{entered}} entered (last {{days}}d)", { bounced: totalBounced, entered: totalEntered, days: data?.windowDays ?? 7 })}</div>
            {failureRate !== null && failureRate !== undefined ? <div>{t("reliability.failureRate", "Failure rate: {{rate}}", { rate: formatPercent(failureRate) })}</div> : null}
            <div>{t("reliability.window", "Window: {{start}} → {{end}}", { start: windowStartLabel, end: formatDateTime(data?.generatedAt) })}</div>
            {data?.resetAt ? <div>{t("reliability.resetBaseline", "Reset baseline: {{date}}", { date: formatDateTime(data.resetAt) })}</div> : null}
            {data?.headline.reason ? <div>{t("reliability.reason", "Reason: {{reason}}", { reason: data.headline.reason })}</div> : null}
          </div>
        </details>
      </div>

      <div className="reliability-grid">
        <div className="card reliability-card">
          <div className="reliability-section-header">
            <h3>{t("reliability.inReviewFlow", "In-review flow")}</h3>
            <button className="btn btn-sm" onClick={() => setShowEmptyDays((value) => !value)}>
              {showEmptyDays ? t("reliability.hideEmptyDays", "Hide empty days") : t("reliability.showEmptyDays", "Show empty days")}
            </button>
          </div>
          <table className="reliability-table">
            <thead><tr><th>{t("reliability.table.date", "Date")}</th><th>{t("reliability.table.entered", "Entered")}</th><th>{t("reliability.table.bounced", "Bounced")}</th></tr></thead>
            <tbody>
              {perDayRows.map((row) => (
                <tr key={row.date}><td>{row.date}</td><td>{row.tasksEnteredInReview}</td><td>{row.tasksBouncedToInProgress}</td></tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card reliability-card">
          <h3>{t("reliability.duration.heading", "Duration")}</h3>
          <div className="reliability-stat-row"><span>{t("reliability.duration.p50", "P50")}</span><strong>{formatDuration(data?.duration.p50Ms ?? null)}</strong></div>
          <div className="reliability-stat-row"><span>{t("reliability.duration.p95", "P95")}</span><strong>{formatDuration(data?.duration.p95Ms ?? null)}</strong></div>
          <div className="reliability-muted">{t("reliability.duration.samples", "Samples: {{count}}", { count: data?.duration.sampleCount ?? 0 })}</div>
          <details className="reliability-details">
            <summary>{t("reliability.duration.moreStats", "More stats")}</summary>
            <div className="reliability-details-content">
              <div>{t("reliability.duration.p50Raw", "P50 raw: {{value}} ms", { value: data?.duration.p50Ms ?? "—" })}</div>
              <div>{t("reliability.duration.p95Raw", "P95 raw: {{value}} ms", { value: data?.duration.p95Ms ?? "—" })}</div>
              <div>{t("reliability.duration.sampleCount", "Sample count: {{count}}", { count: data?.duration.sampleCount ?? 0 })}</div>
              {data?.duration.reason ? <div>{t("reliability.duration.reason", "Reason: {{reason}}", { reason: data.duration.reason })}</div> : null}
            </div>
          </details>
        </div>

        <div className="card reliability-card">
          <h3>{t("reliability.mergeAttempts.heading", "Merge attempts")}</h3>
          <div className="reliability-stat-row"><span>{t("reliability.mergeAttempts.mean", "Mean")}</span><strong>{data?.mergeAttempts.mean?.toFixed(2) ?? "—"}</strong></div>
          <div className="reliability-stat-row"><span>{t("reliability.mergeAttempts.max", "Max")}</span><strong>{data?.mergeAttempts.max ?? "—"}</strong></div>
          <ul className="reliability-histogram">
            {Object.entries(data?.mergeAttempts.histogram ?? {}).map(([bucket, count]) => (
              <li key={bucket}>
                <span>{bucket}</span>
                <div className="reliability-histogram-bar-wrap"><div className="reliability-histogram-bar" style={{ width: `${Math.min(count * 20, 100)}%` }} /></div>
                <strong>{count}</strong>
              </li>
            ))}
          </ul>
          <details className="reliability-details">
            <summary>{t("reliability.mergeAttempts.moreStats", "More stats")}</summary>
            <div className="reliability-details-content">
              <div>{t("reliability.mergeAttempts.tasksCounted", "Tasks counted: {{count}}", { count: mergeAttemptTaskCount })}</div>
              <div>{t("reliability.mergeAttempts.histogramTotal", "Histogram total: {{count}}", { count: mergeAttemptTaskCount })}</div>
              {data?.mergeAttempts.reason ? <div>{t("reliability.mergeAttempts.reason", "Reason: {{reason}}", { reason: data.mergeAttempts.reason })}</div> : null}
            </div>
          </details>
        </div>
      </div>

      {showResetConfirm ? (
        <div className="modal-overlay open" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="reliability-reset-title">
            <div className="modal-header"><h2 id="reliability-reset-title">{t("reliability.resetModal.title", "Reset reliability stats?")}</h2></div>
            <p>{t("reliability.resetModal.description", "This sets a new baseline for reliability statistics. Historical events older than the reset time are excluded from counts but are not deleted.")}</p>
            {resetError ? <div className="form-error">{resetError}</div> : null}
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowResetConfirm(false)}>{t("common.cancel", "Cancel")}</button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  void resetStats().catch((error: unknown) => {
                    setResetError(error instanceof Error ? error.message : t("reliability.resetModal.failedError", "Failed to reset reliability stats"));
                  });
                }}
              >
                {t("reliability.resetModal.confirm", "Confirm reset")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
