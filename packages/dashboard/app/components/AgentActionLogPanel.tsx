import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { X, History } from "lucide-react";
import type { Agent, AgentActivityEvent, AgentActivityEventType } from "../api";
import { getAgentActivity } from "../api";
import { useAgentActivity } from "../hooks/useAgentActivity";
import { toActionLogRows, type AgentActionLogRow } from "../utils/agentActionLog";
import { elapsedSinceMs } from "../utils/dataFreshness";
import { formatDuration } from "../utils/agentHealth";
import { parseActivityOccurredAt } from "./agentsOrgChartActivity";
import "./AgentActionLogPanel.css";

/*
FNXC:FleetActionLog 2026-09-02-06:35 (RUFU-176):
The operator asked for "nejaký log akcií" (some action log) on the Fleet tab so "why is something paused and other
things standing still" is answerable without opening each agent or querying run-audit. This drawer is that surface.

ONE EVENT SOURCE (hard constraint): the shared `agentActivityStore` already owns the single `subscribeSse("/api/events")`
`agent:activity` channel and the one seed (`getAgentActivity({limit: ACTIVITY_EVENT_CAP})`). This panel ADDS a second
retainer to that hook and pages older history through the SAME `GET /api/agent-activity` cursor wire — it never opens a
new EventSource and never duplicates the seed. Older pages use the previous response's `nextCursor` verbatim as the
exclusive `before` bound (`docs/agent-activity-contract.md`); the store's retained ring and the older page are merged by
`eventId` because a reconnect re-seed can make the 200-event window overlap what we already paged.
*/

/** Page size for older-history drawer paging; the seed window (`ACTIVITY_EVENT_CAP`) stays the store's. */
const ACTION_LOG_PAGE_SIZE = 100;

/*
FNXC:FleetActionLog 2026-09-02-07:58 (RUFU-176):
Every activity type translates through a LITERAL `t("key", "English")` call so `pnpm i18n:extract` captures both the key
AND its English value. The map-lookup form (t(MAP[type], DEFAULTS[type])) let the extractor see the keys — they are plain
string literals in source — but never a defaultValue, so it cataloged every `agents.actionLog.type.*` entry with an empty
value; en is the authored catalog and empty means no English for any locale whose fallback resolves to it.
*/
function eventTypeLabel(type: AgentActivityEventType, t: TFunction<"app">): string {
  switch (type) {
    case "task:started":
      return t("agents.actionLog.type.taskStarted", "Task started");
    case "task:handed-off":
      return t("agents.actionLog.type.taskHandedOff", "Task handed off");
    case "task:completed":
      return t("agents.actionLog.type.taskCompleted", "Task completed");
    case "agent:state-changed":
      return t("agents.actionLog.type.agentStateChanged", "Agent state changed");
    case "workflow:gate-passed":
      return t("agents.actionLog.type.gatePassed", "Gate passed");
    case "workflow:gate-failed":
      return t("agents.actionLog.type.gateFailed", "Gate failed");
    case "approval:requested":
      return t("agents.actionLog.type.approvalRequested", "Approval requested");
    default:
      // Exhaustive over the wire enum; an unwired future type renders its raw value until cataloged.
      return type;
  }
}

function seqAsBigInt(seq: string | null | undefined): bigint | null {
  if (typeof seq !== "string" || !/^\d+$/.test(seq)) return null;
  try {
    return BigInt(seq);
  } catch {
    return null;
  }
}

/** Lowest seq across every currently-displayed event — the exclusive `before` bound for the first older page. */
function oldestSeqOf(events: readonly AgentActivityEvent[]): string | null {
  let oldest: bigint | null = null;
  let oldestRaw: string | null = null;
  for (const event of events) {
    const value = seqAsBigInt(event?.seq);
    if (value === null) continue;
    if (oldest === null || value < oldest) {
      oldest = value;
      oldestRaw = event.seq;
    }
  }
  return oldestRaw;
}

/*
FNXC:FleetActionLog 2026-09-02-07:10 (RUFU-176): module scope (AGENTS.md: never a component inside another). A lowercase
render helper returns elements without introducing a new element type, so rows reconcile in place as the ledger appends.
Attribution drives the label: a roster id resolves to its human name; `lane`/`actor` and an off-roster id render an
annotation, never a raw id as a headline label (core agents.ts forbids surfacing a lane/actor id as an identity).
*/
function renderActionLogRow(row: AgentActionLogRow, t: TFunction<"app">, nowTick: number): ReactElement {
  if (row.kind === "gap") {
    /*
    FNXC:FleetActionLog 2026-09-02-07:10 (RUFU-176): defensive-only marker. The shared store self-heals a truncated SSE
    frame by re-seeding (`agentActivityStore.ts`), so a live channel never hands this row to the panel; the unit test
    synthesizes the frame to prove the pure mapper surfaces history loss honestly instead of hiding it.
    */
    return (
      <li key={row.key} className="agent-action-log__row agent-action-log__row--gap">
        <span className="agent-action-log__gap">{t("agents.actionLog.gaps", "Some older actions are missing from this window.")}</span>
      </li>
    );
  }

  const occurredAtMs = parseActivityOccurredAt(row.occurredAt);
  const relative = occurredAtMs === null ? null : formatDuration(elapsedSinceMs(occurredAtMs, nowTick));
  const who = row.attribution === "lane"
    ? row.laneName
      ? t("agents.actionLog.lane", "engine lane {{lane}}", { lane: row.laneName })
      : t("agents.actionLog.laneUnknown", "an engine lane")
    : row.attribution === "actor"
      ? t("agents.actionLog.actor", "an actor")
      : row.agentUnresolved
        ? t("agents.actionLog.unresolved", "an unrecognized agent")
        : row.agentLabel;

  return (
    <li key={row.key} className="agent-action-log__row">
      <span className="agent-action-log__time">{relative ?? t("agents.actionLog.timeUnknown", "unknown time")}</span>
      <span className={`agent-action-log__type agent-action-log__type--${row.type.replace(":", "-")}`}>
        {eventTypeLabel(row.type, t)}
      </span>
      <span className="agent-action-log__who">{who}</span>
      <span className="agent-action-log__summary">{row.summary}</span>
      {row.taskId && (
        <span className="agent-action-log__task">{t("agents.actionLog.taskRef", "task {{taskId}}", { taskId: row.taskId })}</span>
      )}
    </li>
  );
}

export interface AgentActionLogPanelProps {
  projectId?: string;
  /** Roster used to resolve a human-readable label per action. Never an additional graph population. */
  rosterAgents: readonly Agent[];
  onClose: () => void;
}

/**
 * The Fleet tab's action-log drawer. Module-scope by construction (AGENTS.md: never declare a component inside another)
 * so React reconciles rows in place while new events append; nesting it here would remount its subtree on every append.
 */
export function AgentActionLogPanel({ projectId, rosterAgents, onClose }: AgentActionLogPanelProps) {
  const { t } = useTranslation("app");
  const snapshot = useAgentActivity(projectId);
  const [olderEvents, setOlderEvents] = useState<AgentActivityEvent[]>([]);
  /** Server-provided exclusive `before` cursor; null once a page reports nothing behind it. */
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Merge the store's retained window with paged older history by event id, preferring the store's stamped copy so
  // the recency clamp (`activityWindowOccurredAt`) survives a reconnect that overlaps what we already paged.
  const mergedEvents = useMemo(() => {
    const seen = new Set<string>();
    const out: AgentActivityEvent[] = [];
    for (const event of snapshot.events) {
      if (!event || seen.has(event.eventId)) continue;
      seen.add(event.eventId);
      out.push(event);
    }
    for (const event of olderEvents) {
      if (!event || seen.has(event.eventId)) continue;
      seen.add(event.eventId);
      out.push(event);
    }
    return out;
  }, [snapshot.events, olderEvents]);

  const rows = useMemo<AgentActionLogRow[]>(
    () => toActionLogRows(mergedEvents, rosterAgents),
    [mergedEvents, rosterAgents],
  );

  // A fresh seed can widen the store's window behind our back (the seed has no `before` bound), so "load older"
  // re-arms whenever the retained set changes — otherwise a user who paged to exhaustion would never see new history.
  useEffect(() => {
    setHasMore(snapshot.events.length > 0);
  }, [snapshot.events]);

  const loadOlder = useCallback(async () => {
    if (loading) return;
    const before = cursor ?? oldestSeqOf(mergedEvents);
    if (before === null) {
      setHasMore(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const page = await getAgentActivity({ before, limit: ACTION_LOG_PAGE_SIZE, projectId });
      setOlderEvents((previous) => [...previous, ...page.events]);
      setCursor(page.nextCursor);
      setHasMore(page.nextCursor !== null);
    } catch {
      setError(t("agents.actionLog.loadFailed", "Could not load older actions."));
    } finally {
      setLoading(false);
    }
  }, [cursor, loading, mergedEvents, projectId, t]);

  // Escape and overlay-click close, matching the in-file `role="dialog"` precedent in `AgentsView.tsx`.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="agent-action-log-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="agent-action-log"
        role="dialog"
        aria-modal="true"
        aria-label={t("agents.actionLog.title", "Action log")}
      >
        <header className="agent-action-log__header">
          <span className="agent-action-log__title">
            <History size={16} aria-hidden="true" />
            {t("agents.actionLog.title", "Action log")}
          </span>
          <button
            type="button"
            className="btn-icon agent-action-log__close"
            onClick={onClose}
            title={t("agents.actionLog.close", "Close action log")}
            aria-label={t("agents.actionLog.close", "Close action log")}
          >
            <X size={16} />
          </button>
        </header>

        {rows.length === 0 ? (
          <p className="agent-action-log__empty">{t("agents.actionLog.empty", "No actions recorded yet.")}</p>
        ) : (
          <>
            {hasMore && (
              <button type="button" className="btn btn-sm agent-action-log__older" onClick={() => void loadOlder()} disabled={loading}>
                {loading ? t("agents.actionLog.loading", "Loading…") : t("agents.actionLog.loadOlder", "Load older")}
              </button>
            )}
            {error && <p className="agent-action-log__error">{error}</p>}
            <ul className="agent-action-log__list">
              {rows.map((row) => renderActionLogRow(row, t, snapshot.nowTick))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
