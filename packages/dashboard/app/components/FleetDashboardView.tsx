import "./FleetDashboardView.css";
import { lazy, Suspense, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, RefreshCw, Ship, ChevronRight } from "lucide-react";
import type { Agent, AgentCapability } from "../api";
import { useAgents } from "../hooks/useAgents";
import { useViewportMode } from "../hooks/useViewportMode";
import { ViewHeader } from "./ViewHeader";
import { AgentAvatar } from "./AgentAvatar";
import { AgentTaskBadge } from "./AgentTaskBadge";
import { AgentEmptyState } from "./AgentEmptyState";
import { LoadingSpinner } from "./LoadingSpinner";
import { getAgentHealthStatus } from "../utils/agentHealth";
import { isEphemeralAgent } from "@fusion/core";

export interface FleetDashboardViewProps {
  projectId?: string;
  addToast: (message: string, type?: "success" | "error") => void;
}

/*
FNXC:FleetObservation 2026-08-16-01:22:
Drill-down reuses the existing AgentDetailView inline (matching AgentsView's
split-detail pattern) instead of fabricating a fleet-specific detail pane. The
detail is lazy-loaded, so the roster chunk stays independent of the heavy detail
surface until an agent is actually opened.
*/
const AgentDetailView = lazy(() => import("./AgentDetailView").then((m) => ({ default: m.AgentDetailView })));

const AGENT_CAPABILITY_ORDER: AgentCapability[] = [
  "triage",
  "executor",
  "reviewer",
  "merger",
  "scheduler",
  "engineer",
  "custom",
];

/**
 * Role tags rendered in the stable canonical order from @fusion/core. Unknown
 * tags are never persisted, so this always maps cleanly.
 */
function formatRoleTags(agent: Agent): string {
  const roles = agent.roles?.length ? agent.roles : agent.role ? [agent.role] : [];
  const ordered = AGENT_CAPABILITY_ORDER.filter((cap) => roles.includes(cap));
  return ordered.length ? ordered.join(", ") : agent.role;
}

/*
FNXC:FleetObservation 2026-08-16-01:20:
Relative heartbeat age shown in the roster's last-heartbeat cell. The agent
snapshot is live-fetched by useAgents (SWR hydrate-to-live), so aging a
persisted timestamp against wall-clock now matches the profile of the agents
surface rather than a staled hydrated snapshot.
*/
function formatRelativeAge(iso: string | undefined): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "<1m";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

export function FleetDashboardView({ projectId, addToast }: FleetDashboardViewProps) {
  const { t } = useTranslation("app");
  const [refreshing, setRefreshing] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [showSystem, setShowSystem] = useState(false);
  /*
  FNXC:FleetObservation 2026-08-16-01:22:
  The show-system toggle must be threaded through to useAgents (showSystemAgents
  option), not just applied as a client-side filter. useAgents uses that option to
  pass includeEphemeral=true to fetchAgents; without it, the server excludes
  ephemeral agents and the client-side filter has nothing to reveal when the
  toggle is enabled. This mirrors AgentsView's showSystemAgents wiring.
  */
  const { agents, isLoading, refreshAgents } = useAgents(projectId, { showSystemAgents: showSystem });
  const viewportMode = useViewportMode();

  /*
  FNXC:FleetObservation 2026-08-16-01:22:
  The fleet roster is the durable-agent org: ephemeral task-worker agents are
  filtered out by default (mirroring the Agents surface) because they come and go
  with their owning task and would drown the durable roster. A "Show system agents"
  toggle (same text as AgentsView) reveals them alongside durable agents.
  */
  const roster = useMemo(
    () => agents.filter((agent) => showSystem || !isEphemeralAgent(agent)),
    [agents, showSystem],
  );

  const unresponsiveCount = useMemo(
    () => roster.filter((agent) => getAgentHealthStatus(agent).label === "Unresponsive").length,
    [roster],
  );
  const activeCount = useMemo(
    () => roster.filter((agent) => agent.state === "active" || agent.state === "running").length,
    [roster],
  );

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshAgents();
    } finally {
      setRefreshing(false);
    }
  };

  const closeAgent = () => setSelectedAgentId(null);

  const showInitialLoading = isLoading && roster.length === 0;
  const title = t("nav.fleet", "Fleet");

  /*
  FNXC:FleetObservation 2026-08-16-01:22:
  When an agent is selected the roster is replaced by the inline AgentDetailView
  plus a Back control that restores the roster. This is the hover shell/empty-state
  concern from Surface Enumeration: closing the detail must bring back the roster,
  never leave an orphaned empty detail pane.
  */
  if (selectedAgentId) {
    return (
      <div className="fleet-view fleet-view--detail">
        <ViewHeader
          icon={Ship}
          title={t("fleet.backToFleet", "Fleet")}
          actions={
            <button
              type="button"
              className="btn btn-sm fleet-view__back"
              onClick={closeAgent}
              aria-label={t("fleet.backToRoster", "Back to fleet roster")}
            >
              <ChevronLeft size={16} aria-hidden="true" />
              {t("fleet.backToRoster", "Back to fleet")}
            </button>
          }
        />
        <Suspense fallback={<div className="fleet-view__loading"><LoadingSpinner label={t("fleet.loadingDetail", "Loading agent…")} /></div>}>
          <AgentDetailView
            key={selectedAgentId}
            inline
            showInlineBackButton={false}
            agentId={selectedAgentId}
            projectId={projectId}
            onClose={closeAgent}
            addToast={addToast}
            onChildClick={setSelectedAgentId}
          />
        </Suspense>
      </div>
    );
  }

  return (
    <div className="fleet-view">
      <ViewHeader
        icon={Ship}
        title={title}
        actions={
          <>
            <label className="fleet-view__system-toggle">
              <input
                type="checkbox"
                checked={showSystem}
                onChange={(e) => setShowSystem(e.target.checked)}
                aria-label={t("fleet.showSystemAgents", "Show system agents")}
              />
              {t("fleet.showSystemAgents", "Show system agents")}
            </label>
            <button
              type="button"
              className="btn-icon fleet-view__refresh"
              onClick={handleRefresh}
              disabled={refreshing}
              title={t("fleet.refresh", "Refresh roster")}
              aria-label={t("fleet.refresh", "Refresh roster")}
            >
              <RefreshCw size={16} className={refreshing ? "animate-spin" : undefined} />
            </button>
          </>
        }
      />

      {roster.length > 0 ? (
        <>
          <div className="fleet-view__summary" aria-label={t("fleet.summaryLabel", "Fleet summary")}>
            <div className="fleet-view__summary-item">
              <span className="fleet-view__summary-value">{roster.length}</span>
              <span className="fleet-view__summary-label">{t("fleet.total", "Agents")}</span>
            </div>
            <div className="fleet-view__summary-item">
              <span className="fleet-view__summary-value fleet-view__summary-value--active">{activeCount}</span>
              <span className="fleet-view__summary-label">{t("fleet.active", "Active")}</span>
            </div>
            <div className="fleet-view__summary-item">
              <span
                className={`fleet-view__summary-value${
                  unresponsiveCount > 0 ? " fleet-view__summary-value--unresponsive" : ""
                }`}
              >
                {unresponsiveCount}
              </span>
              <span className="fleet-view__summary-label">{t("fleet.unresponsive", "Unresponsive")}</span>
            </div>
          </div>

          {viewportMode === "mobile" ? (
            <ul className="fleet-view__cards">
              {roster.map((agent) => (
                <li key={agent.id} className="fleet-view__card">
                  <FleetAgent identity={agent} onOpenAgent={setSelectedAgentId} />
                </li>
              ))}
            </ul>
          ) : (
            <div className="fleet-view__table-wrap">
              <table className="fleet-view__table">
                <thead>
                  <tr>
                    <th scope="col">{t("fleet.role", "Role")}</th>
                    <th scope="col">{t("fleet.state", "State")}</th>
                    <th scope="col">{t("fleet.currentTask", "Current task")}</th>
                    <th scope="col">{t("fleet.lastHeartbeat", "Last heartbeat")}</th>
                  </tr>
                </thead>
                <tbody>
                  {roster.map((agent) => (
                    <tr key={agent.id} className="fleet-view__row">
                      <FleetRoleCell agent={agent} onOpenAgent={setSelectedAgentId} />
                      <FleetStateCell agent={agent} />
                      <td className="fleet-view__task-cell">
                        {agent.taskId ? <AgentTaskBadge taskId={agent.taskId} taskColumn={agent.taskColumn} /> : "—"}
                      </td>
                      <td className="fleet-view__heartbeat-cell">{formatRelativeAge(agent.lastHeartbeatAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : showInitialLoading ? (
        <div className="fleet-view__loading">
          <LoadingSpinner label={t("fleet.loading", "Loading fleet…")} />
        </div>
      ) : (
        <AgentEmptyState
          title={t("fleet.emptyTitle", "No agents in the fleet")}
          description={t("fleet.emptyDescription", "Durable agents will appear here once they are provisioned.")}
        />
      )}
    </div>
  );
}

/** Desktop row role cell: avatar + name + role tags. */
function FleetRoleCell({ agent, onOpenAgent }: { agent: Agent; onOpenAgent: (id: string) => void }) {
  const { t } = useTranslation("app");
  return (
    <td className="fleet-view__agent-cell">
      <button
        type="button"
        className="fleet-view__agent-btn"
        onClick={() => onOpenAgent(agent.id)}
        aria-label={t("fleet.openAgent", "Open {{name}}", { name: agent.name })}
      >
        <AgentAvatar agent={agent} size={28} />
        <span className="fleet-view__agent-meta">
          <span className="fleet-view__agent-name">{agent.name}</span>
          <span className="fleet-view__agent-roles text-secondary">{formatRoleTags(agent)}</span>
        </span>
      </button>
    </td>
  );
}

/** Desktop row state cell rendered from the canonical health status. */
function FleetStateCell({ agent }: { agent: Agent }) {
  const status = getAgentHealthStatus(agent);
  return (
    <td className="fleet-view__state-cell">
      <span className="fleet-view__state-chip" style={{ color: status.color }}>
        {status.icon}
        <span>{status.label}</span>
      </span>
    </td>
  );
}

/** Mobile card body reusing the same cells in a stacked column. */
function FleetAgent({ identity, onOpenAgent }: { identity: Agent; onOpenAgent: (id: string) => void }) {
  const { t } = useTranslation("app");
  return (
    <div className="fleet-view__card-inner">
      <div className="fleet-view__card-head">
        {identity.taskId ? (
          <AgentTaskBadge taskId={identity.taskId} taskColumn={identity.taskColumn} />
        ) : null}
      </div>
      <div className="fleet-view__card-main">
        <AgentAvatar agent={identity} size={32} />
        <span className="fleet-view__agent-meta">
          <span className="fleet-view__agent-name">{identity.name}</span>
          <span className="fleet-view__agent-roles text-secondary">{formatRoleTags(identity)}</span>
        </span>
      </div>
      <dl className="fleet-view__card-fields">
        <div className="fleet-view__card-field">
          <dt>{t("fleet.state", "State")}</dt>
          <dd>
            <FleetStateCell agent={identity} />
          </dd>
        </div>
        <div className="fleet-view__card-field">
          <dt>{t("fleet.currentTask", "Current task")}</dt>
          <dd className="fleet-view__card-task">
            {identity.taskId ? <AgentTaskBadge taskId={identity.taskId} taskColumn={identity.taskColumn} /> : "—"}
          </dd>
        </div>
        <div className="fleet-view__card-field">
          <dt>{t("fleet.lastHeartbeat", "Last heartbeat")}</dt>
          <dd>{formatRelativeAge(identity.lastHeartbeatAt)}</dd>
        </div>
      </dl>
      <button
        type="button"
        className="fleet-view__card-open"
        onClick={() => onOpenAgent(identity.id)}
        aria-label={t("fleet.openAgent", "Open {{name}}", { name: identity.name })}
      >
        {t("fleet.openAgent", "Open agent")}
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </div>
  );
}