import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Agent, AgentCapability, AgentState } from "../../api";
import { FleetDashboardView } from "../FleetDashboardView";

/*
FNXC:FleetObservation 2026-08-16-01:22:
FleetDashboardView consumes useAgents for its LIVE, SSE-subscribed roster (the
feature AC is a live observation surface, not a static snapshot). These tests
mock the hook with a mutable agentsRef so the live-refresh invariant — an
SSE-triggered state flip re-renders the roster — is asserted by swapping the
array reference and re-rendering, exactly as SWR would hand a new value.
*/
const { agentsRef } = vi.hoisted(() => ({ agentsRef: { current: [] as Agent[] } }));

vi.mock("../../hooks/useAgents", () => ({
  useAgents: (projectId?: string) => ({
    agents: agentsRef.current,
    activeAgents: agentsRef.current.filter((a) => a.state === "active"),
    stats: { active: agentsRef.current.filter((a) => a.state === "active").length, total: agentsRef.current.length, error: 0 },
    isLoading: false,
    loadAgents: vi.fn(),
    loadStats: vi.fn(),
    refreshAgents: vi.fn(),
  }),
}));

vi.mock("../../hooks/useViewportMode", () => ({
  useViewportMode: () => "desktop" as const,
}));

/*
FNXC:FleetObservation 2026-08-16-01:22:
AgentDetailView is lazy-imported by the roster. Mock it to a stub that announces
the opened agentId so the drill-down/back invariant is testable without mounting
the heavy detail surface.
*/
vi.mock("../AgentDetailView", () => ({
  AgentDetailView: ({ agentId }: { agentId: string }) => <output data-testid="detail-agent">{agentId}</output>,
}));

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-" + Math.random(),
    name: "Agent",
    roles: [],
    role: "executor" as AgentCapability,
    state: "active" as AgentState,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

const DURABLE_ACTIVE = makeAgent({
  id: "triage-1",
  name: "Durable Triage",
  roles: ["triage" as AgentCapability],
  state: "active",
  taskId: "FN-101",
  taskColumn: "todo",
  lastHeartbeatAt: new Date(Date.now() - 10_000).toISOString(),
});

const DURABLE_PAUSED = makeAgent({
  id: "reviewer-1",
  name: "Durable Reviewer",
  roles: ["reviewer" as AgentCapability],
  state: "paused",
  taskId: "FN-202",
  taskColumn: "in-progress",
  lastHeartbeatAt: new Date(Date.now() - 5_000).toISOString(),
});

const DURABLE_NO_HB_NO_TASK = makeAgent({
  id: "merger-1",
  name: "New Merger",
  roles: ["merger" as AgentCapability],
  state: "active",
});

const EPHEMERAL_WORKER = makeAgent({
  id: "worker-1",
  name: "Spawned Worker",
  roles: ["executor" as AgentCapability],
  state: "running",
  taskId: "FN-303",
  taskColumn: "in-progress",
  metadata: { type: "spawned" },
});

const addToast = vi.fn();

function renderFleet() {
  return render(<FleetDashboardView projectId="proj-1" addToast={addToast} />);
}

describe("FleetDashboardView (desktop)", () => {
  beforeEach(() => {
    addToast.mockClear();
  });

  afterEach(() => {
    agentsRef.current = [];
  });

  it("renders the durable roster with all four columns from live useAgents data", () => {
    agentsRef.current = [DURABLE_ACTIVE, DURABLE_PAUSED];
    renderFleet();

    // Agent column: avatar + name + role tags.
    expect(screen.getByText("Durable Triage")).toBeInTheDocument();
    expect(screen.getByText("Durable Reviewer")).toBeInTheDocument();
    // Role tags canonical.
    expect(screen.getByText("triage")).toBeInTheDocument();
    expect(screen.getByText("reviewer")).toBeInTheDocument();

    // State badge derived from the canonical health status.
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();

    // Current task badge.
    expect(screen.getByText(/(FN-101)/)).toBeInTheDocument();
    expect(screen.getByText(/(FN-202)/)).toBeInTheDocument();

    // Last-heartbeat relative age is rendered, not blank (recent -> "<1m").
    expect(screen.getAllByText("<1m").length).toBeGreaterThan(0);
  });

  it("hides ephemeral/system agents by default and reveals them via the toggle", () => {
    agentsRef.current = [DURABLE_ACTIVE, EPHEMERAL_WORKER];
    renderFleet();

    // Durable agent visible, ephemeral hidden.
    expect(screen.getByText("Durable Triage")).toBeInTheDocument();
    expect(screen.queryByText("Spawned Worker")).not.toBeInTheDocument();

    const toggle = screen.getByRole("checkbox", { name: /Show system agents/ });
    fireEvent.click(toggle);

    expect(screen.getByText("Spawned Worker")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("renders an empty state when there are no durable agents", () => {
    agentsRef.current = [EPHEMERAL_WORKER];
    const { rerender } = renderFleet();
    // Only ephemeral agents present => no durable rows, empty state shown.
    expect(screen.getByText("No agents in the fleet")).toBeInTheDocument();

    agentsRef.current = [];
    rerender(<FleetDashboardView projectId="proj-1" addToast={addToast} />);
    expect(screen.getByText("No agents in the fleet")).toBeInTheDocument();
  });

  it("renders safe placeholder cells for undefined lastHeartbeatAt and taskId", () => {
    agentsRef.current = [DURABLE_NO_HB_NO_TASK];
    renderFleet();

    expect(screen.getByText("New Merger")).toBeInTheDocument();
    // active + no heartbeat => Starting...
    expect(screen.getByText("Starting...")).toBeInTheDocument();
    // No task cell renders a muted placeholder, not a crash.
    const placeholder = screen.getAllByText("—");
    expect(placeholder.length).toBeGreaterThan(0);
  });

  it("opens AgentDetailView on row click and Back restores the roster", async () => {
    agentsRef.current = [DURABLE_ACTIVE];
    renderFleet();

    const openBtn = screen.getByRole("button", { name: /Open Durable Triage/ });
    fireEvent.click(openBtn);

    // Drill-down: lazy AgentDetailView resolves asynchronously, then announces the agent.
    const detail = await screen.findByTestId("detail-agent");
    expect(detail).toHaveTextContent("triage-1");

    // Back control restores the roster.
    const backBtn = screen.getByRole("button", { name: /Back to fleet/ });
    fireEvent.click(backBtn);

    expect(screen.queryByTestId("detail-agent")).not.toBeInTheDocument();
    expect(screen.getByText("Durable Triage")).toBeInTheDocument();
  });

  it("re-renders when live useAgents state flips (SSE live-refresh invariant)", () => {
    agentsRef.current = [DURABLE_NO_HB_NO_TASK];
    const { rerender } = renderFleet();

    // Initial: active + no heartbeat => Starting...
    expect(screen.getByText("Starting...")).toBeInTheDocument();

    // SSE pushes a fresh snapshot: heartbeat arrives, state now healthy.
    agentsRef.current = [
      makeAgent({ ...DURABLE_NO_HB_NO_TASK, lastHeartbeatAt: new Date(Date.now() - 5_000).toISOString() }),
    ];
    rerender(<FleetDashboardView projectId="proj-1" addToast={addToast} />);

    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.queryByText("Starting...")).not.toBeInTheDocument();
  });
});