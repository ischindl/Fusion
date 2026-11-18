import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";
import { MainContent } from "../MainContent";
import type { MainContentProps } from "../types";

const { fetchTaskDetailMock, fetchMissionMock, fetchMissionsMock, fetchInsightsMock, listEvalsMock, apiMock } = vi.hoisted(() => ({
  fetchTaskDetailMock: vi.fn(),
  apiMock: vi.fn(async (path: string) => {
    /*
    FNXC:IdleBoardReadCost 2026-11-18-09:10 (RUFU-479): the goals and roadmap candidate reads moved from raw
    `fetch` (which silently went nowhere in jsdom, so this file never saw them) to `api()`, the client seam
    that sits inside the bounded read queue. The mock therefore has to answer them now - and answering here
    is what lets this file assert the seam at all, which the raw-fetch shape could not.
    */
    if (path.startsWith("/goals")) return { goals: [] };
    if (path.includes("/plugins/fusion-plugin-roadmap/roadmaps")) return [];
    throw new Error(`unexpected api path ${path}`);
  }),
  fetchMissionMock: vi.fn(async () => ({
    id: "mission-1",
    milestones: [{ id: "milestone-1", title: "Milestone candidate" }],
  })),
  fetchMissionsMock: vi.fn(async () => [{ id: "mission-1", title: "Mission candidate" }]),
  fetchInsightsMock: vi.fn(async () => ({
    insights: [{ id: "insight-1", title: "Research candidate" }],
    count: 1,
  })),
  listEvalsMock: vi.fn(async () => ({
    results: [{ id: "eval-1", taskId: "FN-1", taskSnapshot: { title: "Evaluation candidate" } }],
    count: 1,
  })),
}));

vi.mock("../../../api", () => ({
  api: apiMock,
  fetchTaskDetail: fetchTaskDetailMock,
  fetchMission: fetchMissionMock,
  fetchMissions: fetchMissionsMock,
  fetchInsights: fetchInsightsMock,
  listEvals: listEvalsMock,
}));

vi.mock("../../MailboxView", () => ({
  MailboxView: ({
    onOpenTask,
    onOpenPlanningSession,
    nativeStructureCandidates = [],
  }: {
    onOpenTask?: (taskId: string) => void;
    onOpenPlanningSession?: (sessionId: string) => void;
    nativeStructureCandidates?: Array<{ label: string }>;
  }) => (
    <>
      <button type="button" onClick={() => onOpenTask?.("FN-7935")}>Open mailbox artifact task</button>
      <button type="button" onClick={() => onOpenPlanningSession?.("planning-8428")}>Open mailbox planning session</button>
      <output aria-label="Native structure candidate labels">
        {nativeStructureCandidates.map((candidate) => candidate.label).join(", ")}
      </output>
    </>
  ),
}));

function mainContentProps(overrides: Partial<MainContentProps> = {}): MainContentProps {
  return {
    showBackendConnectionErrorPage: false,
    projectsError: null,
    t: ((key: string, fallback?: string) => fallback ?? key) as MainContentProps["t"],
    retryingProjects: false,
    handleRetryProjects: vi.fn(),
    shellApi: null,
    taskView: "mailbox",
    modalManager: {} as MainContentProps["modalManager"],
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

describe("MainContent mailbox artifact View task routing", () => {
  it("opens mailbox artifact tasks in the shared popped-out task-detail window", async () => {
    const fetchedTask = {
      id: "FN-7935",
      title: "Mailbox artifact task",
      description: "Task opened from a mailbox artifact message",
      column: "todo",
      status: "todo",
      dependencies: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      steps: [],
    } as unknown as TaskDetail;
    const openDetailTask = vi.fn();
    const popOutTaskDetail = vi.fn();

    fetchTaskDetailMock.mockResolvedValueOnce(fetchedTask);

    render(<MainContent {...mainContentProps({ openDetailTask, popOutTaskDetail })} />);

    screen.getByText("Open mailbox artifact task").click();

    await waitFor(() => expect(popOutTaskDetail).toHaveBeenCalledWith(fetchedTask));
    expect(fetchTaskDetailMock).toHaveBeenCalledWith("FN-7935", "project-1");
    expect(openDetailTask).not.toHaveBeenCalled();
  });

  it("opens the exact planning session and navigates to Planning", () => {
    const openPlanningWithSession = vi.fn();
    const handleChangeTaskView = vi.fn();
    render(
      <MainContent
        {...mainContentProps({
          // Intentionally partial modal manager — this test exercises only
          // onOpenPlanningSession; escalate the cast per the RUFU-140 convention.
          modalManager: { openPlanningWithSession } as unknown as MainContentProps["modalManager"],
          handleChangeTaskView,
        })}
      />);

    screen.getByText("Open mailbox planning session").click();
    expect(openPlanningWithSession).toHaveBeenCalledWith("planning-8428");
    expect(handleChangeTaskView).toHaveBeenCalledWith("planning");
  });

  it("supplies project-scoped native structure candidates to the mailbox picker", async () => {
    render(<MainContent {...mainContentProps()} />);

    await waitFor(() => expect(screen.getByLabelText("Native structure candidate labels")).toHaveTextContent(
      "Mission candidate, Milestone candidate, Research candidate, Evaluation candidate",
    ));
    expect(fetchMissionsMock).toHaveBeenCalledWith("project-1");
    expect(fetchMissionMock).toHaveBeenCalledWith("mission-1", "project-1");
    expect(fetchInsightsMock).toHaveBeenCalledWith({ limit: 100 }, "project-1");
    expect(listEvalsMock).toHaveBeenCalledWith({ limit: 100 }, "project-1");
    // The goals and roadmap reads are queue-routed now, and still project-scoped like the other three.
    expect(apiMock.mock.calls.map((call) => String(call[0]))).toEqual(
      expect.arrayContaining(["/goals?projectId=project-1"]),
    );
  });
});
