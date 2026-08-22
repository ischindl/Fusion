import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Agent, AgentCapability, AgentState } from "../../api";
import { FleetDashboardView } from "../FleetDashboardView";

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

// Mobile breakpoint: FleetDashboardView renders stacked cards instead of a table.
vi.mock("../../hooks/useViewportMode", () => ({
  useViewportMode: () => "mobile" as const,
}));

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
  lastHeartbeatAt: new Date(Date.now() - 5_000).toISOString(),
});

const EPHEMERAL_WORKER = makeAgent({
  id: "worker-1",
  name: "Spawned Worker",
  roles: ["executor" as AgentCapability],
  state: "running",
  metadata: { type: "spawned" },
});

const addToast = vi.fn();

describe("FleetDashboardView (mobile)", () => {
  beforeEach(() => {
    addToast.mockClear();
  });

  afterEach(() => {
    agentsRef.current = [];
  });

  it("renders the same roster as stacked cards on the mobile breakpoint", () => {
    agentsRef.current = [DURABLE_ACTIVE, DURABLE_PAUSED];
    render(<FleetDashboardView projectId="proj-1" addToast={addToast} />);

    expect(screen.getByText("Durable Triage")).toBeInTheDocument();
    expect(screen.getByText("Durable Reviewer")).toBeInTheDocument();
    // Same columns surfaced in card form: state, current task, heartbeat.
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getAllByText(/(FN-101)/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("<1m").length).toBeGreaterThan(0);

    // Each card exposes its own drill-down affordance.
    expect(screen.getByRole("button", { name: /Open Durable Triage/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open Durable Reviewer/ })).toBeInTheDocument();
  });

  it("drills into AgentDetailView and Back restores the card roster on mobile", async () => {
    agentsRef.current = [DURABLE_ACTIVE];
    render(<FleetDashboardView projectId="proj-1" addToast={addToast} />);

    fireEvent.click(screen.getByRole("button", { name: /Open Durable Triage/ }));
    const detail = await screen.findByTestId("detail-agent");
    expect(detail).toHaveTextContent("triage-1");

    fireEvent.click(screen.getByRole("button", { name: /Back to fleet/ }));
    expect(screen.queryByTestId("detail-agent")).not.toBeInTheDocument();
    expect(screen.getByText("Durable Triage")).toBeInTheDocument();
  });

  it("applies the durable filter and show-system toggle on mobile", () => {
    agentsRef.current = [DURABLE_ACTIVE, EPHEMERAL_WORKER];
    render(<FleetDashboardView projectId="proj-1" addToast={addToast} />);

    expect(screen.getByText("Durable Triage")).toBeInTheDocument();
    expect(screen.queryByText("Spawned Worker")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /Show system agents/ }));
    expect(screen.getByText("Spawned Worker")).toBeInTheDocument();
  });
});