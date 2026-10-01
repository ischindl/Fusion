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
  projectId?: string;
  isOpen: boolean;
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

interface AgentsOverviewToggleProps {
  activeAgents: Agent[];
  verdict: FleetVerdict;
  isOpen: boolean;
  onToggle: () => void;
}

/*
FNXC:StandardizedViewActions 2026-09-14-02:47:
Overview is a view-level control, so its trigger belongs in the Agents header beside the other view actions, not in a
permanent third block between the header and the collection. FN-379 standardized the header and the rail but left this
bar untouched, so Agents read as three stacked zones. The trigger renders in the header; the expanded content stays a
sibling section under it and remains the constrained touch-scroll owner on phones.
*/
export function AgentsOverviewToggle({ verdict, isOpen, onToggle }: AgentsOverviewToggleProps) {
  const { t } = useTranslation("app");

  return (
    <button
      type="button"
      className="agents-overview-bar__toggle"
      aria-expanded={isOpen}
      data-testid="agents-overview-toggle"
      onClick={onToggle}
    >
      <span className="agents-overview-bar__title-wrap">
        {isOpen ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
        <span className="agents-overview-bar__title">{t("agents.overview", "Overview")}</span>
      </span>
      {/*
      FNXC:FleetVerdict 2026-09-14-21:55 (upstream sync merge):
      RUFU-176 replaced the "N active · M running" meta sentence with the four-bucket visible strip.
      The FN-379 header relocation keeps that requirement — the strip rides the trigger so every
      count stays visible without hover, and the verdict never disappears behind a tooltip.
      */}
      <FleetVerdictStrip verdict={verdict} />
    </button>
  );
}

export function AgentsOverviewBar({
  stats,
  activeAgents,
  projectId,
  isOpen,
  onSelectAgent,
  onOpenTaskLogs,
}: AgentsOverviewBarProps) {
  const { t } = useTranslation("app");

  if (!isOpen) return null;

  return (
    <section className="agents-overview-bar" aria-label={t("agents.overviewLabel", "Agents overview")}>
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
    </section>
  );
}
