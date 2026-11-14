/*
FNXC:BoardOrdering 2026-11-13-09:30 (RUFU-526):
The two halves of one acceptance sentence, asserted where an operator actually reads them.

The requirement says the board's first screen must lead with work that needs attention AND that a
user-selected sort still wins. Those two sentences are satisfied by two different mechanisms and the
risk is that the new default quietly eats the second one: the list view sorts a column's rows by the
shared display comparator ONLY while no sort field is selected (`ListView.tsx`, the `if (!sortField)`
arm in its grouping memo). Once the operator clicks a column header, that arm is not taken at all and
the ladder never runs. Asserting both in the same file, on the same rows, is what makes the difference
visible instead of inferred: the SAME failed card leads by default and stops leading the moment a sort
field is chosen.

The failure card is deliberately the OLDEST row. Arrival order alone would put it last, so a passing
first assertion cannot be explained by the old rule; and the two idle cards differ from each other only
by arrival, so the second assertion also proves the ladder left the idle tail in its existing order.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { ListView } from "../ListView";

const workflows = [
  {
    id: "builtin:coding",
    name: "Coding",
    columns: [
      { id: "todo", name: "Todo", flags: { countsTowardWip: true } },
      { id: "in-progress", name: "In progress", flags: { countsTowardWip: true } },
      { id: "done", name: "Done", flags: { complete: true } },
    ],
  },
];

vi.mock("../../hooks/useBoardWorkflows", () => ({
  useBoardWorkflows: () => ({
    boardWorkflows: { defaultWorkflowId: workflows[0].id, workflows, taskWorkflowIds: {} },
    workflowMode: true,
    workflowOptions: workflows,
    selectedWorkflow: workflows[0],
    selectedWorkflowId: workflows[0].id,
    isAllWorkflowsSelected: false,
    setSelectedWorkflowId: vi.fn(),
    refreshBoardWorkflows: vi.fn(),
    setBoardWorkflowsState: vi.fn(),
  }),
}));

vi.mock("../../api", () => ({
  batchUpdateTaskModels: vi.fn(),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchGlobalSettings: vi.fn().mockResolvedValue({}),
  fetchNodes: vi.fn().mockResolvedValue([]),
  fetchWorkflowOptionalSteps: vi.fn().mockResolvedValue([]),
  fetchTaskDetail: vi.fn(),
  checkDuplicateTasks: vi.fn().mockResolvedValue([]),
  fetchAgents: vi.fn().mockResolvedValue([]),
  uploadAttachment: vi.fn().mockResolvedValue({}),
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
  refreshPrStatus: vi.fn(),
  updateTask: vi.fn(),
}));

function row(id: string, title: string, createdAt: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title,
    description: "",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    createdAt,
    updatedAt: createdAt,
    status: null,
    error: null,
    ...extra,
  } as Task;
}

/* The oldest card in the lane, and the one that needs attention. Arrival alone would rank it LAST. */
const TASKS: Task[] = [
  row("FN-100", "Miserable failure", "2026-11-01T00:00:00.000Z", { error: "merge failed", status: "failed" }),
  row("FN-101", "Quiet backlog", "2026-11-02T00:00:00.000Z"),
  row("FN-102", "Another quiet card", "2026-11-03T00:00:00.000Z"),
];

function listProps(overrides: Partial<React.ComponentProps<typeof ListView>> = {}) {
  return {
    tasks: TASKS,
    onMoveTask: vi.fn(async () => ({})),
    onDeleteTask: vi.fn(async () => ({})),
    onMergeTask: vi.fn(async () => ({ merged: false })),
    onOpenDetail: vi.fn(),
    addToast: vi.fn(),
    ...overrides,
  } as React.ComponentProps<typeof ListView>;
}

function renderedOrder(): string[] {
  return screen
    .getAllByRole("row")
    .filter((row) => row.getAttribute("data-id"))
    .map((row) => row.getAttribute("data-id")!);
}

function mockViewport(mode: "desktop" | "mobile") {
  const originalWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: mode === "mobile" ? 390 : 1280 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: mode === "mobile" ? 844 : 800 });
  vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
    matches: mode === "mobile" && query.includes("max-width: 768px"),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  return () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
  };
}

describe("ListView default order and a user-selected sort", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("leads the lane with the card that needs attention when no sort is selected", async () => {
    render(<ListView {...listProps()} />);
    await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(0));

    // Same lane, same three rows, no scroll: the failing card is the first row the operator reads.
    const order = renderedOrder();
    expect(order.slice(0, 3)).toEqual(["FN-100", "FN-101", "FN-102"]);
  });

  it("gives up that ranking the moment the operator selects a sort of their own", async () => {
    /*
    Titles are chosen so a title sort is unambiguous and DIFFERENT from the attention order: alphabetical
    puts the two idle cards first ("Another quiet card", "Miserable failure", "Quiet backlog"), so the
    failed card must move off the head. If the default comparator ever leaked into the sorted branch, the
    failed card would stay first and this assertion is where that shows up.
    */
    render(<ListView {...listProps()} />);
    await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(0));
    expect(renderedOrder()[0]).toBe("FN-100");

    const titleHeader = screen.getByRole("columnheader", { name: /title/i });
    fireEvent.click(titleHeader);

    await waitFor(() => expect(renderedOrder()[0]).toBe("FN-102"));
    expect(renderedOrder().slice(0, 3)).toEqual(["FN-102", "FN-100", "FN-101"]);
  });

  it("writes no sort preference of its own while reordering", async () => {
    /*
    The ladder is a presentation rule, so it must leave the operator's stored state byte-identical. The
    list's own persisted keys (collapsed sections, windowing, layout) are the only things that may appear
    in storage, and none of them may name a sort or a task order because of a render.
    */
    const before = new Set(Object.keys(localStorage));
    render(<ListView {...listProps()} />);
    await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(0));

    const written = Object.keys(localStorage).filter((key) => !before.has(key));
    expect(written.filter((key) => /sort|order/i.test(key))).toEqual([]);
  });

  it("keeps the list at its head when a lane page arrives as a prepend", async () => {
    /*
    The lane head delivers pages whose first row is the attention card, so merging one into this virtual
    list is a PREPEND. `useVirtualizedList` preserves a scrolled reader's anchor by adding the arriving
    rows' height to the container's own `scrollTop`, and that compensation is correct only below the
    head - at `scrollTop: 0` it pushes the card the ladder just ranked first above the viewport, which is
    the burial this ordering exists to remove. Unlike a rect, `scrollTop` is a real stored property in
    jsdom because the hook writes it directly, so this assertion can fail: with the opt-in removed the
    container ends up one row-estimate below zero, exactly as the phone board measured (320 px, card top
    -218) in `board-attention-viewport-browser.test.ts`.
    */
    const idle = Array.from({ length: 6 }, (_, index) =>
      row(`FN-2${index}`, `Idle ${index}`, `2026-11-0${index + 1}T00:00:00.000Z`),
    );
    const view = render(<ListView {...listProps({ tasks: idle })} />);
    await waitFor(() => expect(renderedOrder()).toHaveLength(6));

    const container = document.querySelector<HTMLElement>(".list-table-container")!;
    expect(container, "the list renders no virtualiser scroll container").not.toBeNull();
    Object.defineProperty(container, "scrollTop", { configurable: true, writable: true, value: 0 });

    const failing = row("FN-100", "Miserable failure", "2026-10-01T00:00:00.000Z", { error: "merge failed", status: "failed" });
    view.rerender(<ListView {...listProps({ tasks: [failing, ...idle] })} />);
    await waitFor(() => expect(renderedOrder()[0]).toBe("FN-100"));

    expect(container.scrollTop, "the head arrival pushed the list off its own head").toBe(0);
  });

  it("keeps the card that needs attention at the head of the lane's own scroll container on a phone", async () => {
    /*
    RUFU-526 Step 6 asks for the FIRST SCREEN at 390x844 without scrolling. A jsdom render cannot measure
    that viewport: jsdom runs no layout engine, so every `getBoundingClientRect()` it returns is zero and a
    geometry assertion here would pass on a page that renders the card below the fold. What jsdom CAN
    settle - and what the browser half then rides on - is the two facts the viewport claim reduces to:
    the attention card is the FIRST row of its lane in the rendered DOM, and the lane's scroll container is
    at its head (scrollTop 0), so nothing above it has to be scrolled past.

    The browser half is no longer a gap: `src/__tests__/board-attention-viewport-browser.test.ts` mounts the
    real `Board` behind a fetch stub in headless Chromium at 1440x900 and 390x844, and measures the failing
    card's rect, the lane's first rendered row, the spacer above it, and every scroll offset. That lane is
    what found the defect this assertion cannot see: the lane-head prepend made the virtualiser add its
    320 px row estimate to the lane's `scrollTop`, pushing the card it had just ranked first to top -218 —
    above the phone viewport. A zero-rect environment cannot see a card pushed out of a zero-height
    viewport, which is exactly why the two halves are kept.
    */
    const restoreViewport = mockViewport("mobile");
    try {
      const { container } = render(<ListView {...listProps()} />);
      await waitFor(() => expect(container.querySelectorAll(".list-card").length).toBeGreaterThan(0));

      /*
      A phone gets the CARDS branch (`list-view--cards`), not the table, so the assertion walks card
      elements. `.list-card-id` is the id cell inside each card, in the same document order as the cards.
      */
      const ids = Array.from(container.querySelectorAll(".list-card-id")).map((node) => node.textContent?.trim());
      expect(ids[0]).toBe("FN-100");
      expect(ids).toEqual(["FN-100", "FN-101", "FN-102"]);

      /*
      `scrollTop` on an element is a stored property in jsdom (the virtualiser's own compensation writes
      it), so this one CAN fail. What jsdom cannot produce is a viewport, so no rect-containment claim is
      made here - review F-1 removed the `window.innerHeight` assertion that only echoed the value this
      test had just assigned to it.
      */
      const scroller = container.querySelector(".list-cards") ?? container;
      expect(scroller.scrollTop).toBe(0);
      expect(window.scrollY).toBe(0);
    } finally {
      restoreViewport();
    }
  });
});
