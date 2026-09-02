import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AgentMetricsBar } from "./AgentMetricsBar";
import { ActiveAgentsPanel } from "./ActiveAgentsPanel";
import type { Agent, AgentStats } from "../api";
import type { FleetVerdict } from "../utils/fleetVerdict";
import "./AgentsOverviewBar.css";

interface AgentsOverviewBarProps {
  stats: AgentStats | null;
  activeAgents: Agent[];
  /**
   * RUFU-176: aggregate verdict over the FULL system/ephemeral-filtered roster (never state-filtered).
   * Computed in `AgentsView` via `classifyFleetVerdict(fleetRoster, ...)` — see that classifier's input invariant.
   * `activeAgents` stays for the Active Agents panel's live list; the strip must NOT be derived from it.
   */
  verdict: FleetVerdict;
  projectId?: string;
  isOpen: boolean;
  onToggle: () => void;
  onSelectAgent?: (agentId: string) => void;
  onOpenTaskLogs?: (taskId: string) => void;
}

/**
 * The operator's four-bucket answer to „na jeden pohľad potrebujem vidieť, že sa projekt hýbe" (at one glance I need to
 * see the project is moving). Replaces the old "N active · M running" meta sentence in place: same header row, same
 * collapse affordance, no new heading level.
 *
 * Every count is its own VISIBLE span, never tooltip-only, because a touch user has no hover to discover the verdict
 * with; the `title` is a desktop-only gloss. All four always render, so an empty roster reads as honest zeros rather
 * than a silently missing bucket.
 */
function FleetVerdictStrip({ verdict }: { verdict: FleetVerdict }) {
  const { t } = useTranslation("app");
  return (
    <span
      className="agents-overview-bar__meta agents-fleet-verdict text-secondary"
      role="group"
      aria-label={t("agents.fleet.verdictLabel", "Project movement")}
    >
      <span
        className="agents-fleet-verdict__item agents-fleet-verdict__item--active"
        title={t("agents.fleet.activeTooltip", "Running or active right now")}
      >
        {t("agents.fleet.active", {
          count: verdict.active,
          defaultValue_one: "{{count}} active",
          defaultValue_other: "{{count}} active",
        })}
      </span>
      <span
        className="agents-fleet-verdict__item agents-fleet-verdict__item--waiting-human"
        title={t("agents.fleet.waitingHumanTooltip", "Waiting for a person to approve, review, or answer")}
      >
        {t("agents.fleet.waitingHuman", {
          count: verdict.waitingHuman,
          defaultValue_one: "{{count}} waiting on a human",
          defaultValue_other: "{{count}} waiting on a human",
        })}
      </span>
      <span
        className="agents-fleet-verdict__item agents-fleet-verdict__item--no-heartbeat"
        title={t("agents.fleet.noHeartbeatTooltip", "Heartbeat disabled, overdue, or never recorded")}
      >
        {t("agents.fleet.noHeartbeat", {
          count: verdict.noHeartbeat,
          defaultValue_one: "{{count}} no heartbeat",
          defaultValue_other: "{{count}} no heartbeat",
        })}
      </span>
      <span
        className="agents-fleet-verdict__item agents-fleet-verdict__item--stalled"
        title={t("agents.fleet.stalledTooltip", "Paused or errored; see the node's reason line")}
      >
        {t("agents.fleet.stalled", {
          count: verdict.stalled,
          defaultValue_one: "{{count}} stalled",
          defaultValue_other: "{{count}} stalled",
        })}
      </span>
    </span>
  );
}

export function AgentsOverviewBar({
  stats,
  activeAgents,
  verdict,
  projectId,
  isOpen,
  onToggle,
  onSelectAgent,
  onOpenTaskLogs,
}: AgentsOverviewBarProps) {
  const { t } = useTranslation("app");

  return (
    <section className="agents-overview-bar" aria-label={t("agents.overviewLabel", "Agents overview")}>
      <button
        type="button"
        className="agents-overview-bar__toggle"
        aria-expanded={isOpen}
        onClick={onToggle}
      >
        <span className="agents-overview-bar__title-wrap">
          {isOpen ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
          <span className="agents-overview-bar__title">{t("agents.overview", "Overview")}</span>
        </span>
        <FleetVerdictStrip verdict={verdict} />
      </button>
      {isOpen ? (
        <div className="agents-overview-bar__content">
          <AgentMetricsBar stats={stats} className="agents-overview-bar__metrics" />
          <ActiveAgentsPanel
            agents={activeAgents}
            projectId={projectId}
            onAgentSelect={onSelectAgent}
            onOpenTaskLogs={onOpenTaskLogs}
            className="agents-overview-bar__active-panel"
          />
        </div>
      ) : null}
    </section>
  );
}
