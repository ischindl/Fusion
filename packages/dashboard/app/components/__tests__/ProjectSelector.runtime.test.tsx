import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectSelector } from "../ProjectSelector";
import type { ProjectInfo } from "../../api";

/*
FNXC:ProjectRuntimeOff 2026-11-07-17:41 (RUFU-871):
The combo used to be unable to answer "which of my 25 projects are actually running", because
`GET /api/projects` carried no runtime field and a turned-off project (5 of 25 in production) looked
exactly like a loaded one. These assertions pin the three things the operator asked for on this
surface: a turned-off project is still LISTED, it is VISIBLY labelled as unloaded, and the entries are
grouped LIVE → PAUSED → TURNED OFF with names alphabetical inside each group.

Filtering is typed per character with `userEvent.type`, never `fireEvent.change`: the state line is a
sibling inside a row that re-renders on every keystroke, and only real per-character typing catches a
subtree that gets remounted under the operator's fingers (FN-8606's failure class).
*/

vi.mock("../../hooks/useProjectBookmarks", () => ({
  useProjectBookmarks: () => ({
    bookmarkedIds: new Set<string>(),
    toggleBookmark: vi.fn(),
    isBookmarked: () => false,
  }),
}));

vi.mock("lucide-react", async () => {
  const actual = await vi.importActual("lucide-react");
  return {
    ...actual,
    ChevronDown: () => <span data-testid="chevron-icon" />,
    Check: () => <span data-testid="check-icon" />,
    Folder: () => <span data-testid="folder-icon" />,
    Grid3X3: () => <span data-testid="grid-icon" />,
    Search: () => <span data-testid="search-icon" />,
    Clock: () => <span data-testid="clock-icon" />,
    Star: () => <span data-testid="star-icon" />,
    X: () => <span data-testid="x-icon" />,
    Play: () => <span data-testid="play-icon" />,
    Pause: () => <span data-testid="pause-icon" />,
    AlertCircle: () => <span data-testid="alert-icon" />,
    Loader2: () => <span data-testid="loader-icon" />,
  };
});

function project(id: string, name: string, overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id,
    name,
    path: `/srv/${id}`,
    status: "active",
    isolationMode: "in-process",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runtimeEnabled: true,
    ...overrides,
  };
}

/** Deliberately unsorted and alphabetically scrambled inside every group. */
const PROJECTS: ProjectInfo[] = [
  project("p-zeta-off", "zeta-unloaded", { runtimeEnabled: false }),
  project("p-mike-paused", "mike-paused", { status: "paused" }),
  project("p-alpha-live", "alpha-live"),
  project("p-bravo-off", "bravo-unloaded", { runtimeEnabled: false, status: "paused" }),
  project("p-charlie-paused", "charlie-paused", { status: "paused" }),
  project("p-delta-live", "delta-live"),
];

const CURRENT = project("p-current", "the-project-you-are-in");
const ALL = [CURRENT, ...PROJECTS];

function openCombo() {
  render(
    <ProjectSelector
      projects={ALL}
      currentProject={CURRENT}
      onSelect={vi.fn()}
      onViewAll={vi.fn()}
      allowSingleProject
    />,
  );
  fireEvent.click(screen.getByTestId("project-selector-trigger"));
}

function renderedItemOrder(): string[] {
  return Array.from(document.querySelectorAll("[data-testid^='project-selector-item-']"))
    .map((node) => node.getAttribute("data-testid")!.replace("project-selector-item-", ""));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(cleanup);

describe("ProjectSelector runtime state", () => {
  it("lists a turned-off project instead of hiding it, grouped live → paused → off with names alphabetical inside a group", () => {
    openCombo();

    expect(renderedItemOrder()).toEqual([
      "p-alpha-live",
      "p-delta-live",
      "p-charlie-paused",
      "p-mike-paused",
      "p-bravo-off",
      "p-zeta-off",
    ]);
  });

  it("labels the turned-off entry as unloaded and leaves a loaded entry unlabelled", () => {
    openCombo();

    const off = screen.getByTestId("project-state-p-zeta-off");
    expect(off).toHaveAttribute("data-project-state", "off");
    expect(off.textContent).toMatch(/runtime off/i);
    expect(off.textContent).toMatch(/unloaded/i);
    expect(screen.getByTestId("project-state-p-bravo-off").textContent).toMatch(/runtime off/i);

    expect(screen.queryByTestId("project-state-p-alpha-live")).toBeNull();
    expect(screen.getByTestId("project-state-p-mike-paused").textContent).toMatch(/paused/i);
  });

  it("survives per-character typing: the state line does not steal the search input's focus", async () => {
    const user = userEvent.setup();
    openCombo();

    const input = screen.getByTestId("project-selector-search-input");
    await user.click(input);
    await user.type(input, "unloaded");

    expect(input).toHaveValue("unloaded");
    // Both turned-off projects match "unloaded", the rest do not, and the state labels stay visible.
    expect(renderedItemOrder()).toEqual(["p-bravo-off", "p-zeta-off"]);
    expect(screen.getByTestId("project-state-p-zeta-off").textContent).toMatch(/runtime off/i);
  });

  it("still selects a turned-off project by click, because reachability is the point", () => {
    const onSelect = vi.fn();
    render(
      <ProjectSelector
        projects={ALL}
        currentProject={CURRENT}
        onSelect={onSelect}
        onViewAll={vi.fn()}
        allowSingleProject
      />,
    );
    fireEvent.click(screen.getByTestId("project-selector-trigger"));
    fireEvent.click(screen.getByTestId("project-selector-item-p-zeta-off"));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ id: "p-zeta-off" });
  });
});
