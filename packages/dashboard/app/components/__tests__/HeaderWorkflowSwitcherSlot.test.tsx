/*
FNXC:MissionWorkflows 2026-06-25-00:00:
The shared header workflow slot is the canonical desktop workflow selector for Planning and Missions, and it must render no leftover toolbar shell when workflow mode cannot be switched.
*/

import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardWorkflowDefinition, BoardWorkflowsPayload } from "../../api";
import { HeaderWorkflowSwitcherSlot, type HeaderWorkflowSelection } from "../HeaderWorkflowSwitcherSlot";
import { PlanningWorkflowSwitcherSlot } from "../PlanningWorkflowSwitcherSlot";

const fetchBoardWorkflowsMock = vi.fn();
const subscribeSseMock = vi.fn(() => vi.fn());

vi.mock("../../api", () => ({
  fetchBoardWorkflows: (...args: unknown[]) => fetchBoardWorkflowsMock(...args),
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: (...args: unknown[]) => subscribeSseMock(...args),
}));

const DEFAULT_WORKFLOW: BoardWorkflowDefinition = {
  id: "builtin:coding",
  name: "Coding",
  columns: [],
};

const MISSION_WORKFLOW: BoardWorkflowDefinition = {
  id: "wf-missions",
  name: "Missions",
  columns: [],
};

function workflowPayload(overrides: Partial<BoardWorkflowsPayload> = {}): BoardWorkflowsPayload {
  return {
    flagEnabled: true,
    defaultWorkflowId: DEFAULT_WORKFLOW.id,
    workflows: [DEFAULT_WORKFLOW, MISSION_WORKFLOW],
    taskWorkflowIds: {},
    ...overrides,
  };
}

function renderWithHeader(children: ReactNode) {
  return render(
    <>
      <div id="header-workflow-slot" data-testid="header-workflow-slot" />
      {children}
    </>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  fetchBoardWorkflowsMock.mockReset();
  subscribeSseMock.mockClear();
  fetchBoardWorkflowsMock.mockResolvedValue(workflowPayload());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HeaderWorkflowSwitcherSlot", () => {
  it("ports the workflow switcher into the desktop header slot and reports selection changes", async () => {
    const onWorkflowSelectionChange = vi.fn<(selection: HeaderWorkflowSelection | null) => void>();

    renderWithHeader(
      <HeaderWorkflowSwitcherSlot projectId="project-missions" onWorkflowSelectionChange={onWorkflowSelectionChange} />,
    );

    const headerSlot = screen.getByTestId("header-workflow-slot");
    const selector = await screen.findByTestId("workflow-switcher");
    expect(headerSlot.contains(selector)).toBe(true);

    await waitFor(() => {
      expect(onWorkflowSelectionChange).toHaveBeenLastCalledWith(expect.objectContaining({
        selectedWorkflow: expect.objectContaining({ id: DEFAULT_WORKFLOW.id }),
      }));
    });

    fireEvent.click(selector);
    fireEvent.click(screen.getByTestId("workflow-switcher-option-wf-missions"));

    await waitFor(() => {
      expect(onWorkflowSelectionChange).toHaveBeenLastCalledWith(expect.objectContaining({
        selectedWorkflow: expect.objectContaining({ id: MISSION_WORKFLOW.id }),
      }));
    });
  });

  it("keeps the Planning wrapper rendering the shared header switcher", async () => {
    renderWithHeader(<PlanningWorkflowSwitcherSlot projectId="project-planning" />);

    const headerSlot = screen.getByTestId("header-workflow-slot");
    const selector = await screen.findByTestId("workflow-switcher");
    expect(headerSlot.contains(selector)).toBe(true);
  });

  it("renders no toolbar shell when workflow mode is off or only one workflow exists", async () => {
    fetchBoardWorkflowsMock.mockResolvedValueOnce(workflowPayload({ flagEnabled: false, workflows: [] }));
    const { unmount } = renderWithHeader(<HeaderWorkflowSwitcherSlot projectId="project-off" />);
    await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledWith("project-off"));
    expect(screen.queryByTestId("workflow-switcher")).toBeNull();
    expect(screen.getByTestId("header-workflow-slot")).toBeEmptyDOMElement();

    unmount();
    sessionStorage.clear();
    fetchBoardWorkflowsMock.mockResolvedValueOnce(workflowPayload({ workflows: [DEFAULT_WORKFLOW] }));
    renderWithHeader(<HeaderWorkflowSwitcherSlot projectId="project-one" />);
    await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledWith("project-one"));
    expect(screen.queryByTestId("workflow-switcher")).toBeNull();
    expect(screen.getByTestId("header-workflow-slot")).toBeEmptyDOMElement();
  });

  it("renders no toolbar shell when the header slot is absent", async () => {
    render(<HeaderWorkflowSwitcherSlot projectId="project-mobile" />);

    await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledWith("project-mobile"));
    expect(screen.queryByTestId("workflow-switcher")).toBeNull();
  });
});
