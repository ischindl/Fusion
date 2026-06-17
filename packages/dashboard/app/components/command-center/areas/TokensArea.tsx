/*
FNXC:CommandCenter 2026-06-16-09:42:
Tokens area of the Command Center (PR #1683). Renders token totals + derived cost grouped by model/provider; unpriced models must report cost as unavailable (never $0) so totals are not understated.
*/
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  CostResult,
  TokenAnalytics,
  TokenGroupSummary,
} from "@fusion/core";
import type { DateRange } from "../DateRangePicker";
import { Bar } from "../charts/Bar";
import { AreaShell } from "./AreaShell";
import { useAnalyticsArea } from "./useAnalyticsArea";
import { formatCost, formatCount } from "./areaShared";

type SortKey = "key" | "totalTokens" | "cost";

function costSortValue(cost: CostResult): number {
  return cost.unavailable || cost.usd === null ? -1 : cost.usd;
}

function sortGroups(groups: TokenGroupSummary[], key: SortKey, dir: 1 | -1): TokenGroupSummary[] {
  const sorted = [...groups];
  sorted.sort((a, b) => {
    let cmp = 0;
    if (key === "key") {
      cmp = (a.key ?? "").localeCompare(b.key ?? "");
    } else if (key === "totalTokens") {
      cmp = a.totalTokens - b.totalTokens;
    } else {
      cmp = costSortValue(a.cost) - costSortValue(b.cost);
    }
    if (cmp === 0) {
      cmp = (a.key ?? "").localeCompare(b.key ?? "");
    }
    return cmp * dir;
  });
  return sorted;
}

/**
 * Tokens area: per-model token totals + derived USD cost, plus a bar chart of
 * tokens by model. Grouped by model via the `?groupBy=model` endpoint param.
 */
export function TokensArea({ range }: { range: DateRange }) {
  const { t } = useTranslation("app");
  const { data, isLoading, error } = useAnalyticsArea<TokenAnalytics>(
    "/command-center/tokens?groupBy=model",
    range,
  );

  const groups = useMemo(() => data?.groups ?? [], [data?.groups]);

  const [sortKey, setSortKey] = useState<SortKey>("totalTokens");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  // SWR-identity guard: the set of group keys is the DERIVED value we key the
  // sort-reset on. A revalidation that returns content-identical rows with a
  // new array identity leaves this string unchanged, so the user's chosen sort
  // survives. We only reset sort when the *set of models* actually changes.
  const groupKeysSig = useMemo(() => groups.map((g) => g.key ?? "∅").join(" "), [groups]);
  const firstSig = useRef<string | null>(null);
  useEffect(() => {
    if (firstSig.current === null) {
      firstSig.current = groupKeysSig;
      return;
    }
    if (firstSig.current !== groupKeysSig) {
      firstSig.current = groupKeysSig;
      setSortKey("totalTokens");
      setSortDir(-1);
    }
  }, [groupKeysSig]);

  const sortedGroups = useMemo(() => sortGroups(groups, sortKey, sortDir), [groups, sortKey, sortDir]);

  const barData = useMemo(
    () =>
      [...groups]
        .sort((a, b) => b.totalTokens - a.totalTokens)
        .slice(0, 12)
        .map((g) => ({
          label: g.key ?? t("commandCenter.tokens.unknownModel", "(unknown)"),
          value: g.totalTokens,
          valueLabel: formatCount(g.totalTokens),
        })),
    [groups, t],
  );

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(key === "key" ? 1 : -1);
    }
  }

  function caret(key: SortKey) {
    if (key !== sortKey) return null;
    return <span className="cc-sort-caret">{sortDir === 1 ? "▲" : "▼"}</span>;
  }

  const totals = data?.totals;
  const isEmpty = !data || (totals?.totalTokens ?? 0) === 0;

  return (
    <AreaShell testId="tokens" isLoading={isLoading} error={error} isEmpty={isEmpty}>
      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.tokens.totalsTitle", "Totals")}</h3>
        <div className="cc-stat-grid">
          <div className="card cc-stat-card" data-testid="cc-tokens-total">
            <div className="cc-stat-label">{t("commandCenter.tokens.totalTokens", "Total tokens")}</div>
            <div className="cc-stat-value">{formatCount(totals?.totalTokens ?? 0)}</div>
          </div>
          <div className="card cc-stat-card" data-testid="cc-tokens-cost">
            <div className="cc-stat-label">{t("commandCenter.tokens.cost", "Estimated cost")}</div>
            <div className="cc-stat-value">
              {data ? formatCost(data.cost.usd, data.cost.unavailable) : "—"}
            </div>
            {data?.cost.stale ? (
              <span className="cc-stat-sub">{t("commandCenter.tokens.stalePricing", "pricing may be stale")}</span>
            ) : null}
          </div>
          <div className="card cc-stat-card">
            <div className="cc-stat-label">{t("commandCenter.tokens.tasks", "Tasks")}</div>
            <div className="cc-stat-value">{formatCount(totals?.nTasks ?? 0)}</div>
          </div>
        </div>
      </div>

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.tokens.byModelChart", "Tokens by model")}</h3>
        <Bar data={barData} ariaLabel={t("commandCenter.tokens.byModelChart", "Tokens by model")} />
      </div>

      <div className="cc-area-section">
        <h3 className="cc-area-section-title">{t("commandCenter.tokens.tableTitle", "Per-model breakdown")}</h3>
        <div className="cc-table-wrap">
          <table className="cc-table" data-testid="cc-tokens-table">
            <thead>
              <tr>
                <th className="cc-sortable" onClick={() => toggleSort("key")} data-testid="cc-tokens-sort-key">
                  {t("commandCenter.tokens.model", "Model")}
                  {caret("key")}
                </th>
                <th>{t("commandCenter.tokens.input", "Input")}</th>
                <th>{t("commandCenter.tokens.output", "Output")}</th>
                <th>{t("commandCenter.tokens.cached", "Cached")}</th>
                <th className="cc-sortable" onClick={() => toggleSort("totalTokens")} data-testid="cc-tokens-sort-total">
                  {t("commandCenter.tokens.total", "Total")}
                  {caret("totalTokens")}
                </th>
                <th className="cc-sortable" onClick={() => toggleSort("cost")} data-testid="cc-tokens-sort-cost">
                  {t("commandCenter.tokens.costCol", "Cost")}
                  {caret("cost")}
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedGroups.map((g) => (
                <tr key={g.key ?? "∅"} data-testid={`cc-tokens-row-${g.key ?? "unknown"}`}>
                  <td>{g.key ?? t("commandCenter.tokens.unknownModel", "(unknown)")}</td>
                  <td>{formatCount(g.inputTokens)}</td>
                  <td>{formatCount(g.outputTokens)}</td>
                  <td>{formatCount(g.cachedTokens)}</td>
                  <td>{formatCount(g.totalTokens)}</td>
                  <td>
                    {g.cost.unavailable || g.cost.usd === null ? (
                      <span
                        className="cc-unavailable"
                        title={t("commandCenter.tokens.costUnavailable", "No pricing for this model")}
                      >
                        —
                      </span>
                    ) : (
                      formatCost(g.cost.usd, g.cost.unavailable)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AreaShell>
  );
}
