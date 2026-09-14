import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentsOverviewBar, AgentsOverviewToggle } from "../AgentsOverviewBar";
import type { Agent } from "../../api";
import type { FleetVerdict } from "../../utils/fleetVerdict";

vi.mock("lucide-react", async () => {
  const actual = await vi.importActual("lucide-react");
  return {
    ...actual,
    ChevronDown: () => <span data-testid="chevron-down" />,
    ChevronRight: () => <span data-testid="chevron-right" />,
  };
});

vi.mock("../AgentMetricsBar", () => ({
  AgentMetricsBar: () => <div data-testid="agent-metrics-bar" />,
}));

vi.mock("../ActiveAgentsPanel", () => ({
  ActiveAgentsPanel: () => <div data-testid="active-agents-panel" />,
}));

function makeAgent(id: string, state: Agent["state"]): Agent {
  return {
    id,
    name: id,
    role: "executor",
    roles: ["executor"],
    state,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  };
}

const ZERO_VERDICT: FleetVerdict = { active: 0, waitingHuman: 0, noHeartbeat: 0, stalled: 0 };

function renderBar(props: Partial<React.ComponentProps<typeof AgentsOverviewBar>> = {}) {
  return render(
    <AgentsOverviewBar
      stats={null}
      activeAgents={[]}
      isOpen={false}
      {...props}
    />,
  );
}

/*
FNXC:FleetVerdict 2026-09-14-22:05 (upstream sync merge, FN-379):
The FN-379 header relocation moved the collapse trigger into the Agents header (AgentsOverviewToggle).
RUFU-176's four-bucket strip rides that trigger, so every strip assertion now renders the TOGGLE —
the strip's contract (visible buckets, roster-wide verdict, never hover-gated) is unchanged.
*/
function renderToggle(props: Partial<React.ComponentProps<typeof AgentsOverviewToggle>> = {}) {
  return render(
    <AgentsOverviewToggle
      activeAgents={[]}
      verdict={ZERO_VERDICT}
      isOpen={false}
      onToggle={() => {}}
      {...props}
    />,
  );
}

describe("AgentsOverviewBar verdict strip", () => {
  /*
  FNXC:FleetVerdict 2026-09-02-05:44 (RUFU-176):
  These replaced the "N active · M running" copy assertions, which RUFU-176 deliberately removed: the bar's meta slot
  is now the four-bucket "is the project moving?" answer. The strip renders every bucket as visible text (never
  hover-gated) and the `verdict` prop is the roster-wide count, NOT a count of the `activeAgents` live list.
  */
  it("renders all four operator buckets as visible text", () => {
    renderToggle({
      verdict: { active: 3, waitingHuman: 2, noHeartbeat: 1, stalled: 4 },
    });

    expect(screen.getByText("3 active")).toBeInTheDocument();
    expect(screen.getByText("2 waiting on a human")).toBeInTheDocument();
    expect(screen.getByText("1 no heartbeat")).toBeInTheDocument();
    expect(screen.getByText("4 stalled")).toBeInTheDocument();
  });

  it("renders honest zeros for an empty roster instead of hiding buckets", () => {
    renderToggle();

    expect(screen.getByText("0 active")).toBeInTheDocument();
    expect(screen.getByText("0 waiting on a human")).toBeInTheDocument();
    expect(screen.getByText("0 no heartbeat")).toBeInTheDocument();
    expect(screen.getByText("0 stalled")).toBeInTheDocument();
  });

  it("labels the strip region so a screen reader announces what the counts are", () => {
    renderToggle({ verdict: { active: 1, waitingHuman: 0, noHeartbeat: 0, stalled: 0 } });

    expect(screen.getByRole("group", { name: "Project movement" })).toBeInTheDocument();
  });

  it("shows the roster-wide counts even when the live active list is smaller", () => {
    // The hazard this guards: `activeAgents` is state-filtered to {active, running} for the live panel.
    // A strip derived from it could never show a waiting/stalled count.
    renderToggle({
      activeAgents: [makeAgent("a-1", "active")],
      verdict: { active: 1, waitingHuman: 5, noHeartbeat: 2, stalled: 3 },
    });

    expect(screen.getByText("1 active")).toBeInTheDocument();
    expect(screen.getByText("5 waiting on a human")).toBeInTheDocument();
    expect(screen.getByText("2 no heartbeat")).toBeInTheDocument();
    expect(screen.getByText("3 stalled")).toBeInTheDocument();
  });

  it("uses singular grammar for a single agent in a bucket", () => {
    renderToggle({ verdict: { active: 1, waitingHuman: 1, noHeartbeat: 1, stalled: 1 } });
    expect(screen.getByText("1 waiting on a human")).toBeInTheDocument();
  });

  it("stays inside the collapse toggle so the affordance does not move", () => {
    renderToggle({ verdict: { active: 2, waitingHuman: 0, noHeartbeat: 0, stalled: 0 } });
    const toggle = screen.getByRole("button", { expanded: false });
    expect(toggle).toHaveTextContent("2 active");
  });
});

describe("AgentsOverviewBar", () => {
  /*
  FNXC:FleetVerdict 2026-09-14-22:05 (upstream sync merge):
  Upstream's "N active · M running" meta-count tests were superseded here: RUFU-176 deliberately
  removed that sentence in favor of the four-bucket strip, and FN-379 relocated the trigger to the
  header. The surviving contract is that the strip renders in the collapsed header trigger.
  */
  it("hosts the verdict strip in the collapsed header trigger", () => {
    renderToggle({ isOpen: false });
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Project movement" })).toBeInTheDocument();
  });

  it("renders metrics bar and active agents panel when open", () => {
    renderBar({ isOpen: true });

    expect(screen.getByTestId("agent-metrics-bar")).toBeInTheDocument();
    expect(screen.getByTestId("active-agents-panel")).toBeInTheDocument();
  });

  it("hides content when collapsed", () => {
    renderBar({ isOpen: false });

    expect(screen.queryByTestId("agent-metrics-bar")).toBeNull();
    expect(screen.queryByTestId("active-agents-panel")).toBeNull();
  });
});
