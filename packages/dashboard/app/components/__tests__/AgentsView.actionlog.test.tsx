import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AgentsView } from "../AgentsView";
import * as apiModule from "../../api";
import { __resetAgentActivityStoreForTests } from "../../hooks/agentActivityStore";
import { __resetSseBus } from "../../sse-bus";

/*
FNXC:FleetActionLog 2026-09-02-07:25 (RUFU-176):
The action-log drawer is verified end-to-end through the real AgentsView wiring and the REAL shared activity store (no
hook mock): the trigger must exist at both breakpoints, the drawer must render the store's seeded window, page older
history through the SAME `GET /api/agent-activity` cursor wire, and append a live SSE event WITHOUT opening a second
EventSource — the single-event-source constraint from the task.
*/

const mockViewportMode = vi.fn<() => "desktop" | "mobile">(() => "desktop");
vi.mock("../../hooks/useViewportMode", () => ({
  useViewportMode: () => mockViewportMode(),
  isMobileViewport: () => mockViewportMode() === "mobile",
  isTabletTouchViewport: () => false,
  isFullScreenSheetViewport: () => false,
  isShortViewport: () => false,
}));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));
vi.mock("../AgentDetailView", () => ({ AgentDetailView: () => null, relativeTime: () => "now" }));

const activityApi = vi.hoisted(() => ({ getAgentActivity: vi.fn() }));
vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchAgents: vi.fn().mockResolvedValue([]),
    fetchAgentStats: vi.fn().mockResolvedValue({ total: 0, byState: {}, byRole: {} }),
    fetchOrgTree: vi.fn().mockResolvedValue([]),
    fetchSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 1 }),
    updateSettings: vi.fn().mockResolvedValue({}),
    getAgentActivity: activityApi.getAgentActivity,
  });
});

const mockFetchAgents = vi.mocked((apiModule as any).fetchAgents);

class ActivityEventSource {
  static readonly instances: ActivityEventSource[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = ActivityEventSource.OPEN;
  private listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(_url: string) { ActivityEventSource.instances.push(this); }
  addEventListener(type: string, listener: (event: Event) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (event: Event) => void) { this.listeners.get(type)?.delete(listener); }
  close() { this.readyState = ActivityEventSource.CLOSED; }
  emit(type: string, data: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

function pushActivity(event: Record<string, unknown>) {
  ActivityEventSource.instances.at(-1)?.emit("agent:activity", event);
}

const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW - offsetMs).toISOString();

function activityEvent(overrides: Record<string, unknown>) {
  return {
    projectId: "project",
    agentAttribution: "agent",
    taskId: null,
    fromAgentId: null,
    toAgentId: null,
    type: "task:started",
    summary: "seed action",
    occurredAt: iso(2000),
    metadata: null,
    ...overrides,
  };
}

function seedWindow() {
  // The store seeds via getAgentActivity({limit}) on mount; the drawer pages older history via a `before` bound.
  activityApi.getAgentActivity.mockImplementation(async (params: Record<string, unknown>) => {
    if (params.before !== undefined) {
      return { events: [activityEvent({ eventId: "older", seq: "10", agentId: "agent-alice", summary: "older action", occurredAt: iso(9000) })], nextCursor: null };
    }
    return {
      events: [
        activityEvent({ eventId: "seed-new", seq: "60", agentId: "agent-alice", agentAttribution: "agent", type: "task:started", summary: "seeded newest action", occurredAt: iso(1000) }),
        activityEvent({ eventId: "seed-lane", seq: "50", agentId: "executor", agentAttribution: "lane", type: "workflow:gate-passed", summary: "gate passed", occurredAt: iso(2000) }),
      ],
      nextCursor: null,
    };
  });
}

beforeEach(() => {
  mockFetchAgents.mockResolvedValue([
    { id: "agent-alice", name: "Alice", role: "executor", state: "running", createdAt: iso(0), updatedAt: iso(0), metadata: {} },
  ]);
  ActivityEventSource.instances.length = 0;
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("EventSource", ActivityEventSource);
  seedWindow();
});

afterEach(() => {
  __resetAgentActivityStoreForTests();
  __resetSseBus();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mockViewportMode.mockReturnValue("desktop");
});

describe("AgentsView action-log drawer", () => {
  it.each(["desktop", "mobile"] as const)("renders the action-log trigger at the %s breakpoint", async (mode) => {
    mockViewportMode.mockReturnValue(mode);
    render(<AgentsView addToast={vi.fn()} projectId="project" />);
    await screen.findByTestId("agent-action-log-trigger");
    expect(screen.getByTestId("agent-action-log-trigger")).toBeInTheDocument();
  });

  it("opens the drawer, renders the store window (roster name + lane annotation), then closes on Escape", async () => {
    render(<AgentsView addToast={vi.fn()} projectId="project" />);
    const trigger = await screen.findByTestId("agent-action-log-trigger");
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    // Roster id resolves to a human name inside the drawer; the lane event renders an annotation, never a node.
    await waitFor(() => expect(within(dialog).getByText("Alice")).toBeInTheDocument());
    expect(within(dialog).getByText("engine lane executor")).toBeInTheDocument();
    expect(within(dialog).getByText("seeded newest action")).toBeInTheDocument();
    expect(within(dialog).getByText("Task started")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("pages older history through the shared cursor wire when 'load older' is clicked", async () => {
    render(<AgentsView addToast={vi.fn()} projectId="project" />);
    fireEvent.click(await screen.findByTestId("agent-action-log-trigger"));
    await screen.findByRole("dialog");
    await waitFor(() => expect(screen.getByText("seeded newest action")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /load older/i }));

    // The older page request carries the oldest displayed seq as its exclusive `before` bound.
    await waitFor(() => expect(screen.getByText("older action")).toBeInTheDocument());
    const olderCall = activityApi.getAgentActivity.mock.calls.find(([params]) => (params as any)?.before === "50");
    expect(olderCall).toBeTruthy();
    expect((olderCall![0] as any).projectId).toBe("project");
  });

  it("appends a live SSE event without opening a second EventSource", async () => {
    render(<AgentsView addToast={vi.fn()} projectId="project" />);
    fireEvent.click(await screen.findByTestId("agent-action-log-trigger"));
    await screen.findByRole("dialog");
    await waitFor(() => expect(screen.getByText("seeded newest action")).toBeInTheDocument());

    const sourcesBefore = ActivityEventSource.instances.length;
    const callsBefore = activityApi.getAgentActivity.mock.calls.length;

    pushActivity(activityEvent({ eventId: "live", seq: "70", agentId: "agent-alice", type: "task:completed", summary: "live appended action", occurredAt: iso(10) }));

    await waitFor(() => expect(screen.getByText("live appended action")).toBeInTheDocument());
    expect(ActivityEventSource.instances.length).toBe(sourcesBefore); // single shared channel
    expect(activityApi.getAgentActivity.mock.calls.length).toBe(callsBefore); // no refetch on a live append
  });

  it("shows an empty ledger honestly when the window has no events", async () => {
    activityApi.getAgentActivity.mockResolvedValue({ events: [], nextCursor: null });
    render(<AgentsView addToast={vi.fn()} projectId="project" />);
    fireEvent.click(await screen.findByTestId("agent-action-log-trigger"));
    await screen.findByRole("dialog");
    await waitFor(() => expect(screen.getByText("No actions recorded yet.")).toBeInTheDocument());
  });
});
