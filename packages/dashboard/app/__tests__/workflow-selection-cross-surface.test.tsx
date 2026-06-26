import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardWorkflowDefinition, BoardWorkflowsPayload } from "../api";
import { HeaderWorkflowSwitcherSlot, type HeaderWorkflowSelection } from "../components/HeaderWorkflowSwitcherSlot";
import {
  filterTasksByGraphWorkflowSelection,
  GraphWorkflowSwitcherSlot,
  type GraphWorkflowSelection,
} from "../components/GraphWorkflowSwitcherSlot";

const fetchBoardWorkflowsMock = vi.fn();
const subscribeSseMock = vi.fn(() => vi.fn());

vi.mock("../api", () => ({
  fetchBoardWorkflows: (...args: unknown[]) => fetchBoardWorkflowsMock(...args),
}));

vi.mock("../sse-bus", () => ({
  subscribeSse: (...args: unknown[]) => subscribeSseMock(...args),
}));

const DEFAULT_WORKFLOW: BoardWorkflowDefinition = {
  id: "builtin:coding",
  name: "Coding",
  columns: [],
};

const GRAPH_WORKFLOW: BoardWorkflowDefinition = {
  id: "wf-graph",
  name: "Graph",
  columns: [],
};

const HEADER_WORKFLOW: BoardWorkflowDefinition = {
  id: "wf-header",
  name: "Header",
  columns: [],
};

const TASKS = [
  { id: "FN-default", title: "Default task" },
  { id: "FN-unassigned", title: "Unassigned task" },
  { id: "FN-graph", title: "Graph task" },
  { id: "FN-deleted", title: "Deleted workflow task" },
];

function workflowPayload(overrides: Partial<BoardWorkflowsPayload> = {}): BoardWorkflowsPayload {
  return {
    flagEnabled: true,
    defaultWorkflowId: DEFAULT_WORKFLOW.id,
    workflows: [DEFAULT_WORKFLOW, GRAPH_WORKFLOW, HEADER_WORKFLOW],
    taskWorkflowIds: {
      "FN-graph": GRAPH_WORKFLOW.id,
      "FN-deleted": "wf-deleted",
    },
    ...overrides,
  };
}

function CrossSurfaceHarness({ projectId = "project-cross" }: { projectId?: string }) {
  const [graphSelection, setGraphSelection] = useState<GraphWorkflowSelection | null>(null);
  const [headerSelection, setHeaderSelection] = useState<HeaderWorkflowSelection | null>(null);
  const graphTasks = filterTasksByGraphWorkflowSelection(TASKS, projectId, graphSelection);

  return (
    <>
      <div id="header-workflow-slot" data-testid="header-workflow-slot" />
      <HeaderWorkflowSwitcherSlot projectId={projectId} onWorkflowSelectionChange={setHeaderSelection} />
      <GraphWorkflowSwitcherSlot projectId={projectId} onWorkflowSelectionChange={setGraphSelection} />
      <output data-testid="header-selection">{headerSelection?.selectedWorkflow.id ?? "none"}</output>
      <output data-testid="graph-selection">{graphSelection?.selectedWorkflow.id ?? "none"}</output>
      <ul data-testid="graph-tasks">
        {graphTasks.map((task) => (
          <li key={task.id} data-testid={`graph-task-${task.id}`}>{task.title}</li>
        ))}
      </ul>
    </>
  );
}

beforeEach(() => {
  sessionStorage.clear();
  fetchBoardWorkflowsMock.mockReset();
  subscribeSseMock.mockClear();
  fetchBoardWorkflowsMock.mockResolvedValue(workflowPayload());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workflow selection across dashboard surfaces", () => {
  it("hydrates remounted surfaces from the persisted board-workflows payload", async () => {
    const { unmount } = render(<CrossSurfaceHarness />);

    expect(await screen.findAllByTestId("workflow-switcher")).toHaveLength(2);
    await waitFor(() => {
      expect(screen.getByTestId("header-selection")).toHaveTextContent(DEFAULT_WORKFLOW.id);
      expect(screen.getByTestId("graph-selection")).toHaveTextContent(DEFAULT_WORKFLOW.id);
    });

    const [, graphSwitcher] = screen.getAllByTestId("workflow-switcher");
    fireEvent.click(graphSwitcher);
    fireEvent.click(screen.getByTestId(`workflow-switcher-option-${GRAPH_WORKFLOW.id}`));
    await waitFor(() => expect(screen.getByTestId("graph-selection")).toHaveTextContent(GRAPH_WORKFLOW.id));

    unmount();
    fetchBoardWorkflowsMock.mockImplementation(() => new Promise<BoardWorkflowsPayload>(() => {}));

    render(<CrossSurfaceHarness />);

    const remountedSwitchers = screen.getAllByTestId("workflow-switcher");
    expect(remountedSwitchers).toHaveLength(2);
    expect(screen.getByTestId("header-selection")).toHaveTextContent(DEFAULT_WORKFLOW.id);
    expect(screen.getByTestId("graph-selection")).toHaveTextContent(DEFAULT_WORKFLOW.id);
    expect(fetchBoardWorkflowsMock).toHaveBeenCalledWith("project-cross");
  });

  it("keeps Graph and Header workflow selections isolated while Graph filtering follows only Graph", async () => {
    render(<CrossSurfaceHarness />);

    const switchers = await screen.findAllByTestId("workflow-switcher");
    await waitFor(() => {
      expect(screen.getByTestId("header-selection")).toHaveTextContent(DEFAULT_WORKFLOW.id);
      expect(screen.getByTestId("graph-selection")).toHaveTextContent(DEFAULT_WORKFLOW.id);
    });

    const graphTasks = screen.getByTestId("graph-tasks");
    expect(within(graphTasks).getByTestId("graph-task-FN-default")).toBeInTheDocument();
    expect(within(graphTasks).getByTestId("graph-task-FN-unassigned")).toBeInTheDocument();
    expect(within(graphTasks).getByTestId("graph-task-FN-deleted")).toBeInTheDocument();
    expect(within(graphTasks).queryByTestId("graph-task-FN-graph")).toBeNull();

    fireEvent.click(switchers[1]);
    fireEvent.click(screen.getByTestId(`workflow-switcher-option-${GRAPH_WORKFLOW.id}`));

    await waitFor(() => {
      expect(screen.getByTestId("graph-selection")).toHaveTextContent(GRAPH_WORKFLOW.id);
      expect(screen.getByTestId("header-selection")).toHaveTextContent(DEFAULT_WORKFLOW.id);
      expect(within(graphTasks).getByTestId("graph-task-FN-graph")).toBeInTheDocument();
      expect(within(graphTasks).queryByTestId("graph-task-FN-default")).toBeNull();
      expect(within(graphTasks).queryByTestId("graph-task-FN-deleted")).toBeNull();
    });

    fireEvent.click(switchers[0]);
    fireEvent.click(screen.getByTestId(`workflow-switcher-option-${HEADER_WORKFLOW.id}`));

    await waitFor(() => {
      expect(screen.getByTestId("header-selection")).toHaveTextContent(HEADER_WORKFLOW.id);
      expect(screen.getByTestId("graph-selection")).toHaveTextContent(GRAPH_WORKFLOW.id);
      expect(within(graphTasks).getByTestId("graph-task-FN-graph")).toBeInTheDocument();
    });
  });

  it("preserves boundary behavior for disabled, empty, and single-workflow payloads", async () => {
    fetchBoardWorkflowsMock.mockResolvedValue(workflowPayload({ flagEnabled: false, workflows: [] }));
    const { unmount } = render(<CrossSurfaceHarness />);

    await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledWith("project-cross"));
    expect(screen.queryByTestId("workflow-switcher")).toBeNull();
    expect(screen.getByTestId("header-workflow-slot")).toBeEmptyDOMElement();
    for (const task of TASKS) {
      expect(screen.getByTestId(`graph-task-${task.id}`)).toBeInTheDocument();
    }

    unmount();
    sessionStorage.clear();
    fetchBoardWorkflowsMock.mockResolvedValue(workflowPayload({ workflows: [] }));
    const empty = render(<CrossSurfaceHarness />);
    await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledWith("project-cross"));
    expect(screen.queryByTestId("workflow-switcher")).toBeNull();
    expect(screen.getByTestId("header-workflow-slot")).toBeEmptyDOMElement();
    empty.unmount();

    sessionStorage.clear();
    fetchBoardWorkflowsMock.mockResolvedValue(workflowPayload({ workflows: [DEFAULT_WORKFLOW] }));
    render(<CrossSurfaceHarness />);
    await waitFor(() => expect(fetchBoardWorkflowsMock).toHaveBeenCalledWith("project-cross"));
    expect(screen.queryByTestId("workflow-switcher")).toBeNull();
    expect(screen.getByTestId("header-workflow-slot")).toBeEmptyDOMElement();
  });
});
