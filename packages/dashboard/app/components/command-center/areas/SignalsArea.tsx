import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../api/legacy";
import type { DateRange } from "../DateRangePicker";
import { Bar } from "../charts/Bar";
import { AreaShell } from "./AreaShell";
import { rangeQuery, formatCount, isInvalidRange } from "./areaShared";

/*
FNXC:CommandCenter 2026-06-16-09:42:
Signals area of the Command Center (PR #1683). Surfaces external-signal volume/severity (Sentry/Datadog/PagerDuty/webhook ingest from U11) so operators see incoming pressure alongside internal analytics.
*/

/**
 * Shape the External Signals endpoint will return once U11/U13 land. Until then
 * the endpoint does not exist, so this area degrades to its empty state — it
 * must NOT surface a crash/error for the missing endpoint.
 */
export interface SignalsAnalytics {
  totalSignals: number;
  open: number;
  resolved: number;
  /** Mean time to resolve, minutes; null/unavailable until U13. */
  mttr: { value: number | null; unavailable: boolean };
  bySource: Array<{ source: string; count: number }>;
  bySeverity: Array<{ severity: string; count: number }>;
}

export function SignalsArea({ range }: { range: DateRange }) {
  const { t } = useTranslation("app");
  const [data, setData] = useState<SignalsAnalytics | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const query = rangeQuery(range);
  const invalid = isInvalidRange(range);

  useEffect(() => {
    if (invalid) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    void (async () => {
      try {
        const result = await api<SignalsAnalytics>(`/command-center/signals${query}`);
        if (!cancelled) {
          setData(result);
        }
      } catch {
        // U11/U13 not wired yet (or no signals): degrade to the empty state,
        // never an error. External-signal ingestion lands in Phase C.
        if (!cancelled) {
          setData(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query, invalid]);

  const sourceBars = useMemo(
    () => (data?.bySource ?? []).map((s) => ({ label: s.source, value: s.count, valueLabel: formatCount(s.count) })),
    [data?.bySource],
  );
  const severityBars = useMemo(
    () =>
      (data?.bySeverity ?? []).map((s) => ({ label: s.severity, value: s.count, valueLabel: formatCount(s.count) })),
    [data?.bySeverity],
  );

  const isEmpty = !data || data.totalSignals === 0;

  return (
    <AreaShell
      testId="signals"
      isLoading={isLoading}
      error={null}
      isEmpty={isEmpty}
      emptyMessage={t(
        "commandCenter.signals.empty",
        "No external signals yet. Connect a signal source (Sentry, Datadog, PagerDuty, webhook) to see incident metrics here.",
      )}
    >
      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.signals.summaryTitle", "Summary")}</h3>
        <div className="cc-stat-grid">
          <div className="card cc-stat-card" data-testid="cc-signals-total">
            <div className="cc-stat-label">{t("commandCenter.signals.total", "Total signals")}</div>
            <div className="cc-stat-value">{formatCount(data?.totalSignals ?? 0)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-signals-open">
            <div className="cc-stat-label">{t("commandCenter.signals.open", "Open")}</div>
            <div className="cc-stat-value">{formatCount(data?.open ?? 0)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-signals-resolved">
            <div className="cc-stat-label">{t("commandCenter.signals.resolved", "Resolved")}</div>
            <div className="cc-stat-value">{formatCount(data?.resolved ?? 0)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-signals-mttr">
            <div className="cc-stat-label">{t("commandCenter.signals.mttr", "MTTR")}</div>
            <div className="cc-stat-value">
              {data && data.mttr.value !== null && !data.mttr.unavailable ? (
                t("commandCenter.signals.mttrValue", "{{min}} min", { min: Math.round(data.mttr.value) })
              ) : (
                <span
                  className="cc-unavailable"
                  title={t("commandCenter.signals.mttrUnavailable", "MTTR is unavailable until incident data is recorded")}
                >
                  —
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.signals.bySource", "By source")}</h3>
        <Bar data={sourceBars} ariaLabel={t("commandCenter.signals.bySource", "By source")} />
      </div>

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.signals.bySeverity", "By severity")}</h3>
        <Bar data={severityBars} ariaLabel={t("commandCenter.signals.bySeverity", "By severity")} />
      </div>
    </AreaShell>
  );
}
