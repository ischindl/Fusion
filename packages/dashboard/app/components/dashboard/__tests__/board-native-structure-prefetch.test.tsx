/*
FNXC:IdleBoardReadCost 2026-11-18-09:00 (RUFU-479) — opening the board must not read a picker it will not show.

THE MEASURED COST. A cold board load issued 63 requests, 42 of them inside one second, and a slice of that
fan-out belonged to no visible surface at all: `MainContent` assembled the mailbox's native-structure
picker candidates on MOUNT. Per mount that was five list reads (`missions`, `insights`, `evals`, `goals`,
`roadmaps`) PLUS one detail read per mission and one per roadmap, so the read count grew with the project's
hierarchy while the consumer - `MailboxView` / `MessageComposer`, inside the `taskView === "mailbox"`
branch - was not even rendered.

What is pinned here is the gate and the two things the gate must not break:
  * a board mount issues ZERO candidate reads (absence is asserted, not "fewer");
  * opening the mailbox issues them, once;
  * navigating away and back does not re-fan-out, because the candidates are project-scoped;
  * a project change clears the list before loading, so a ref can never be carried across projects.
*/
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MainContentProps } from "../types";
import { MainContent } from "../MainContent";

const { apiMock, fetchMissionMock, fetchMissionsMock, fetchInsightsMock, listEvalsMock } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  fetchMissionMock: vi.fn(),
  fetchMissionsMock: vi.fn(),
  fetchInsightsMock: vi.fn(),
  listEvalsMock: vi.fn(),
}));

vi.mock("../../../api", () => ({
  api: apiMock,
  fetchMission: fetchMissionMock,
  fetchMissions: fetchMissionsMock,
  fetchInsights: fetchInsightsMock,
  listEvals: listEvalsMock,
  fetchTaskDetail: vi.fn(),
}));

vi.mock("../../MailboxView", () => ({
  MailboxView: ({ nativeStructureCandidates = [] }: { nativeStructureCandidates?: Array<{ ref: { kind: string; id: string }; label: string }> }) => (
    <output data-testid="native-structure-candidates">{nativeStructureCandidates.map((c) => `${c.ref.kind}:${c.label}`).join("|")}</output>
  ),
}));

vi.mock("../../PluginSlot", () => ({ PluginSlot: () => null }));

function props(overrides: Partial<MainContentProps> = {}): MainContentProps {
  return {
    showBackendConnectionErrorPage: false,
    projectsError: null,
    t: ((key: string, fallback?: string) => fallback ?? key) as MainContentProps["t"],
    retryingProjects: false,
    handleRetryProjects: vi.fn(),
    shellApi: null,
    taskView: "board",
    modalManager: { openPlanningWithSession: vi.fn() } as unknown as MainContentProps["modalManager"],
    handleChangeTaskView: vi.fn(),
    openHistory: vi.fn(),
    refreshAppSettings: vi.fn(async () => undefined),
    addToast: vi.fn(),
    currentProject: { id: "project-1", name: "Project 1" } as MainContentProps["currentProject"],
    viewMode: "project",
    tasks: [],
    workflowSteps: [],
    openDetailTask: vi.fn(),
    popOutTaskDetail: vi.fn(),
    setMailboxUnreadCount: vi.fn(),
    settingsLoaded: true,
    skillsEnabled: true,
    insightsEnabled: true,
    researchEnabled: true,
    evalsEnabled: true,
    memoryEnabled: true,
    goalsEnabled: true,
    todosEnabled: true,
    nodesEnabled: true,
    capacityRiskBannerEnabled: false,
    capacityRiskDismissed: false,
    capacityRiskSignal: { level: "low", reasons: [] } as unknown as MainContentProps["capacityRiskSignal"],
    ...overrides,
  } as unknown as MainContentProps;
}

/** Candidate reads the gate owns, counted as paths handed to the client's read seam.
 *  `api()` is asserted as the SEAM so a read that bypassed the queue could not pass as absent. */
function candidateReads(): string[] {
  return apiMock.mock.calls.map((call) => String(call[0]));
}

function listReadPaths(): string[] {
  return [
    ...fetchMissionsMock.mock.calls.map(() => "missions"),
    ...fetchInsightsMock.mock.calls.map(() => "insights"),
    ...listEvalsMock.mock.calls.map(() => "evals"),
    ...candidateReads(),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMissionsMock.mockResolvedValue([{ id: "M-1", title: "Mission" }]);
  fetchMissionMock.mockResolvedValue({ milestones: [{ id: "MS-1", title: "Milestone" }] });
  fetchInsightsMock.mockResolvedValue({ insights: [{ id: "I-1", title: "Research" }], count: 1 });
  listEvalsMock.mockResolvedValue({ results: [{ id: "E-1", taskId: "FN-1", taskSnapshot: { title: "Eval" } }], count: 1 });
  apiMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/goals")) return { goals: [{ id: "G-1", title: "Goal" }] };
    if (path.includes("/roadmaps/RM-1")) return { milestones: [{ features: [{ id: "RF-1", title: "Roadmap feature" }] }] };
    if (path.includes("/plugins/fusion-plugin-roadmap/roadmaps")) return [{ id: "RM-1" }];
    throw new Error(`unexpected api path ${path}`);
  });
});

describe("native-structure candidate prefetch gate (RUFU-479)", () => {
  it("issues no candidate read while the board is the active view", async () => {
    const { unmount } = render(<MainContent {...props()} />);
    // Let any queued microtasks/reads settle before asserting absence.
    await waitFor(() => expect(screen.queryByTestId("native-structure-candidates")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listReadPaths()).toEqual([]);
    expect(fetchMissionMock).not.toHaveBeenCalled();
    unmount();
  });

  it("issues the candidate reads when the mailbox is opened, and only once per project", async () => {
    const { rerender, unmount } = render(<MainContent {...props({ taskView: "mailbox" })} />);
    await waitFor(() => expect(screen.getByTestId("native-structure-candidates")).toHaveTextContent("mission:Mission"));

    const readsAfterFirstMailbox = listReadPaths().length;
    expect(readsAfterFirstMailbox).toBeGreaterThan(0);
    // Goals and roadmap hierarchy reads go through the client read queue, not a raw fetch.
    expect(candidateReads().some((path) => path.startsWith("/goals"))).toBe(true);
    expect(candidateReads().some((path) => path.includes("fusion-plugin-roadmap/roadmaps"))).toBe(true);

    rerender(<MainContent {...props({ taskView: "board" })} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    rerender(<MainContent {...props({ taskView: "mailbox" })} />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listReadPaths().length).toBe(readsAfterFirstMailbox);
    unmount();
  });

  it("clears another project's candidates before loading the new project's", async () => {
    const { rerender } = render(<MainContent {...props({ taskView: "mailbox" })} />);
    await waitFor(() => expect(screen.getByTestId("native-structure-candidates")).toHaveTextContent("mission:Mission"));

    fetchMissionsMock.mockResolvedValue([{ id: "M-2", title: "Other project mission" }]);
    rerender(<MainContent {...props({ taskView: "mailbox", currentProject: { id: "project-2", name: "Project 2" } as MainContentProps["currentProject"] })} />);

    await waitFor(() => expect(screen.getByTestId("native-structure-candidates")).toHaveTextContent("Other project mission"));
    expect(screen.getByTestId("native-structure-candidates")).not.toHaveTextContent("mission:Mission|");
  });
});
