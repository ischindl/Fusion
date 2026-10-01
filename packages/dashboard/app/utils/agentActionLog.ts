import type { Agent, AgentActivityEvent, AgentActivitySseFrame } from "../api";
import { compareActivityEvents } from "../components/agentsOrgChartActivity";

/*
FNXC:AgentActionLog 2026-09-02-06:20 (RUFU-176):
The Fleet tab's action-log drawer answers "what has the project actually done?" It consumes the SAME agent-activity wire
as the org chart (`GET /api/agent-activity`, one shared SSE `agent:activity` channel) but renders it as a flat ledger of
recent project actions rather than per-node liveness.

ATTRIBUTION CONSTRAINT (core agents.ts, AGENT_ACTIVITY_ATTRIBUTIONS): an event whose `agentAttribution` is `lane` or
`actor` must NEVER be rendered as an org-map node and never surfaces a raw id as a headline label — `fromAgentId`/`toAgentId`
persist only when roster-proven. The engine lanes (`executor`, `merger`) therefore appear here as TEXT ANNOTATIONS only.
This util turns each event into a display row: roster agents resolve to their human-readable name; lanes/actors and any
roster id that is no longer on the roster fall back to a stable code the panel localizes, never a bare id.
*/

/** Lane sentinels that carry no roster identity but name a known engine lane; rendered as an annotation, not a node. */
const LANE_SENTINELS = new Set<string>(["executor", "merger"]);

/** A display row in the action-log drawer: a real event or a single defensive truncation marker. */
export type AgentActionLogRow =
  | {
      kind: "event";
      /** Stable React key (the event id). */
      key: string;
      occurredAt: string;
      type: AgentActivityEvent["type"];
      /** How to attribute this action. Mirrors the roster/lane/actor attribution. */
      attribution: AgentActivityEvent["agentAttribution"];
      /** Resolved roster-agent name; empty for lane/actor or a roster id no longer on the roster. */
      agentLabel: string;
      /** Engine lane name (`executor`/`merger`) for a lane-attributed event. */
      laneName?: string;
      /** Roster attribution whose id is not on the roster → render the localized "unrecognized agent" fallback, not the raw id. */
      agentUnresolved?: boolean;
      taskId: string | null;
      summary: string;
    }
  | {
      kind: "gap";
      key: string;
      /**
       * Defensive-only: the shared store self-heals a truncated SSE frame by re-seeding (agentActivityStore), so the live
       * channel never delivers this frame; a synthesized frame exercises the pure mapper's gap marker only, never a live claim.
       */
      fromSeq: string;
      toSeq: string;
    };

/** Roster rows the label resolver needs; partial so a caller can pass its display roster verbatim. */
export type ActionLogRosterAgent = Pick<Agent, "id"> & Partial<Agent>;

function isTruncatedFrame(frame: AgentActivitySseFrame): frame is Extract<AgentActivitySseFrame, { truncated: true }> {
  return typeof frame === "object" && frame !== null && (frame as { truncated?: unknown }).truncated === true;
}

/**
 * Build the drawer's flat ledger from an untyped batch of activity frames (events plus, defensively, one truncation marker).
 *
 * Events sort newest-first with the shared comparator so the ledger cannot reorder between seed, replay, and live appends.
 * A single truncation marker, when present, is pinned at the top: it announces that history between two sequence numbers
 * was omitted, which is a property of the whole list, not of one timestamp.
 *
 * @param events activity events (or truncated frames) already windowed by the caller's snapshot.
 * @param rosterAgents the roster used to resolve human-readable names. Never a second graph population.
 */
export function toActionLogRows(
  events: readonly AgentActivitySseFrame[],
  rosterAgents: readonly ActionLogRosterAgent[],
): AgentActionLogRow[] {
  const namesById = new Map<string, string>();
  for (const agent of rosterAgents) {
    if (agent && typeof agent.id === "string" && typeof agent.name === "string" && agent.name) {
      namesById.set(agent.id, agent.name);
    }
  }

  const activityEvents: AgentActivityEvent[] = [];
  let gap: AgentActivitySseFrame | null = null;
  for (const frame of events) {
    if (isTruncatedFrame(frame)) {
      // Keep the most recent gap marker if the batch carries more than one.
      gap = frame;
      continue;
    }
    if (frame && typeof frame === "object" && typeof (frame as AgentActivityEvent).eventId === "string") {
      activityEvents.push(frame as AgentActivityEvent);
    }
  }
  activityEvents.sort(compareActivityEvents);

  const rows: AgentActionLogRow[] = [];
  if (gap) {
    const { fromSeq, toSeq } = gap as Extract<AgentActivitySseFrame, { truncated: true }>;
    rows.push({ kind: "gap", key: `gap:${fromSeq}:${toSeq}`, fromSeq, toSeq });
  }

  for (const event of activityEvents) {
    const attribution = event.agentAttribution === "lane" || event.agentAttribution === "actor"
      ? event.agentAttribution
      : "agent";
    const laneName = attribution === "lane" && LANE_SENTINELS.has(event.agentId) ? event.agentId : undefined;
    const resolved = attribution === "agent" ? namesById.get(event.agentId) : undefined;

    rows.push({
      kind: "event",
      key: event.eventId,
      occurredAt: event.occurredAt,
      type: event.type,
      attribution,
      agentLabel: resolved ?? "",
      ...(laneName ? { laneName } : {}),
      ...(attribution === "agent" && resolved === undefined ? { agentUnresolved: true } : {}),
      taskId: event.taskId,
      summary: event.summary,
    });
  }
  return rows;
}
