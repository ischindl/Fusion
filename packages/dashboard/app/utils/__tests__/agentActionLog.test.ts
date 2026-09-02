import { describe, it, expect } from "vitest";
import type { AgentActivityEvent, AgentActivitySseFrame } from "../../api";
import { toActionLogRows, type ActionLogRosterAgent } from "../agentActionLog";

/*
FNXC:AgentActionLog 2026-09-02-07:20 (RUFU-176):
The drawer's label resolver is a pure projection over the shared activity wire, so it is tested without a DOM or the
store. The invariants that matter are the attribution constraints from core `agents.ts`: a roster id resolves to a human
name, an off-roster id or a lane/actor attribution NEVER surfaces a raw id as a headline label, and the ledger order is
the shared newest-first comparator (so seed, replay, and live appends cannot disagree).
*/

const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW - offsetMs).toISOString();

function makeEvent(overrides: Partial<AgentActivityEvent> & Pick<AgentActivityEvent, "agentId">): AgentActivityEvent {
  return {
    seq: "100",
    eventId: `evt-${overrides.agentId}-${Math.random().toString(36).slice(2)}`,
    projectId: "project",
    agentAttribution: "agent",
    taskId: null,
    type: "task:started",
    fromAgentId: null,
    toAgentId: null,
    summary: "did work",
    occurredAt: iso(0),
    metadata: null,
    ...overrides,
  } as AgentActivityEvent;
}

const ROSTER: ActionLogRosterAgent[] = [
  { id: "agent-alice", name: "Alice" },
  { id: "agent-bob", name: "Bob" },
];

describe("toActionLogRows", () => {
  it("resolves a roster agent id to its human-readable name", () => {
    const rows = toActionLogRows([makeEvent({ agentId: "agent-alice" })], ROSTER);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.kind).toBe("event");
    if (row.kind === "event") {
      expect(row.agentLabel).toBe("Alice");
      expect(row.attribution).toBe("agent");
      expect(row.agentUnresolved).toBeUndefined();
      expect(row.laneName).toBeUndefined();
    }
  });

  it("marks a roster attribution whose id is no longer on the roster as unresolved (never the raw id)", () => {
    const rows = toActionLogRows([makeEvent({ agentId: "agent-gone" })], ROSTER);
    const row = rows[0];
    if (row.kind !== "event") throw new Error("expected event row");
    expect(row.agentUnresolved).toBe(true);
    expect(row.agentLabel).toBe("");
  });

  it("annotates a known engine-lane attribution as a lane, not a node identity", () => {
    const rows = toActionLogRows(
      [makeEvent({ agentId: "executor", agentAttribution: "lane" })],
      ROSTER,
    );
    const row = rows[0];
    if (row.kind !== "event") throw new Error("expected event row");
    expect(row.attribution).toBe("lane");
    expect(row.laneName).toBe("executor");
    expect(row.agentLabel).toBe("");
    expect(row.agentUnresolved).toBeUndefined();
  });

  it("leaves an unknown lane id without a name so the panel renders a generic lane, not a raw id", () => {
    const rows = toActionLogRows(
      [makeEvent({ agentId: "some-unknown-lane", agentAttribution: "lane" })],
      ROSTER,
    );
    const row = rows[0];
    if (row.kind !== "event") throw new Error("expected event row");
    expect(row.attribution).toBe("lane");
    expect(row.laneName).toBeUndefined();
  });

  it("annotates an actor attribution without a name", () => {
    const rows = toActionLogRows([makeEvent({ agentId: "actor-9", agentAttribution: "actor" })], ROSTER);
    const row = rows[0];
    if (row.kind !== "event") throw new Error("expected event row");
    expect(row.attribution).toBe("actor");
    expect(row.agentLabel).toBe("");
    expect(row.laneName).toBeUndefined();
  });

  it("sorts events newest-first using the shared comparator", () => {
    const rows = toActionLogRows(
      [
        makeEvent({ agentId: "agent-alice", eventId: "old", occurredAt: iso(5000) }),
        makeEvent({ agentId: "agent-bob", eventId: "new", occurredAt: iso(1000) }),
        makeEvent({ agentId: "agent-alice", eventId: "mid", occurredAt: iso(3000) }),
      ],
      ROSTER,
    ).filter((r) => r.kind === "event");
    expect(rows.map((r) => (r.kind === "event" ? r.key : ""))).toEqual(["new", "mid", "old"]);
  });

  it("surfaces a truncation marker row pinned at the top and keeps it out of the event stream", () => {
    const frame: AgentActivitySseFrame = { truncated: true, fromSeq: "10", toSeq: "20" };
    const rows = toActionLogRows([makeEvent({ agentId: "agent-alice" }), frame], ROSTER);
    expect(rows[0].kind).toBe("gap");
    if (rows[0].kind === "gap") {
      expect(rows[0].fromSeq).toBe("10");
      expect(rows[0].toSeq).toBe("20");
    }
    // Only one event row remains.
    expect(rows.filter((r) => r.kind === "event")).toHaveLength(1);
  });

  it("drops malformed frames without an eventId rather than throwing", () => {
    const rows = toActionLogRows([{} as unknown as AgentActivitySseFrame], ROSTER);
    expect(rows).toHaveLength(0);
  });

  it("returns an empty ledger for an empty window", () => {
    expect(toActionLogRows([], ROSTER)).toEqual([]);
  });
});
