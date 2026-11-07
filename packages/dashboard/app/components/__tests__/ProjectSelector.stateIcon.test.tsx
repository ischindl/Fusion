import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectSelector } from "../ProjectSelector";
import type { ProjectInfo } from "../../api";

/*
FNXC:ProjectRuntimeVisibility 2026-11-07-20:23 (RUFU-871):
The combo already said the project state in words; an operator scanning 25 rows cannot read 25
sentences, so each entry now leads with a state ICON. These tests pin the mapping rule that keeps
the icon from lying:

- runtime off wins over everything (an `active` project with an unloaded runtime does no work, so
  it is never green),
- `unknown` is neutral — never red, never green — because measured 2026-11-07 fourteen of 25
  projects answered `unknown` only because their settings could not be read,
- `paused` is yellow and a loaded, unpaused project is green.

Colour is never the only carrier, so every assertion below reads the accessible name too, and the
typing case is driven per character with `userEvent.type`: the indicator sits in a row that
re-renders on every keystroke, and `fireEvent.change` sets a value without needing the input to stay
mounted, so it cannot catch the FN-8606 remount class at all.
*/

vi.mock("../../hooks/useProjectBookmarks", () => {
  const bookmarkedIds = new Set<string>();
  return {
    useProjectBookmarks: () => ({
      bookmarkedIds,
      toggleBookmark: vi.fn(),
      isBookmarked: () => false,
    }),
  };
});

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
    Square: () => <span data-testid="square-icon" />,
    HelpCircle: () => <span data-testid="help-icon" />,
    AlertCircle: () => <span data-testid="alert-icon" />,
    Loader2: () => <span data-testid="loader-icon" />,
  };
});

/** Every name carries `proj` so one query can keep all four rows on screen. */
function project(id: string, name: string, overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id,
    name,
    path: `/srv/${id}`,
    status: "active",
    isolationMode: "in-process",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const PROJECTS: ProjectInfo[] = [
  project("p-proj-running", "proj-running", { runtimeEnabled: true, runtimeState: "enabled" }),
  project("p-proj-paused", "proj-paused", { status: "paused", runtimeEnabled: true, runtimeState: "enabled" }),
  // `active` + runtime disabled: the case that proves the runtime switch outranks `status`.
  project("p-proj-off", "proj-off", { runtimeEnabled: false, runtimeState: "disabled" }),
  // Legacy shape: no `runtimeState` at all, only the old boolean.
  project("p-proj-off-legacy", "proj-off-legacy", { runtimeEnabled: false }),
  // The measured contradiction: settings unreadable, so NOTHING may be claimed by colour.
  project("p-proj-unknown", "proj-unknown", { status: "paused", runtimeEnabled: false, runtimeState: "unknown" }),
];

const CURRENT = project("p-proj-current", "proj-current", { runtimeEnabled: true, runtimeState: "enabled" });
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

/** The indicator element for one entry, read through its accessible state attribute. */
function stateIcon(id: string): HTMLElement {
  const node = screen.getByTestId(`project-state-icon-${id}`);
  expect(node.getAttribute("data-project-state-icon")).not.toBeNull();
  return node;
}

beforeEach(() => {
  vi.restoreAllMocks();
  // JSDOM does not implement scrollIntoView; the combo scrolls the keyboard highlight into view.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe("ProjectSelector per-entry state icon", () => {
  it("leads every entry with its state icon and accessible name", () => {
    openCombo();

    const running = stateIcon("p-proj-running");
    expect(running).toHaveAttribute("data-project-state-icon", "running");
    expect(running.className).toContain("project-selector__item-state-icon--running");
    expect(within(running).getByTestId("play-icon")).toBeDefined();
    expect(running.getAttribute("aria-label")).toBe("Running");
    expect(running.getAttribute("title")).toMatch(/runtime loaded/i);

    const paused = stateIcon("p-proj-paused");
    expect(paused).toHaveAttribute("data-project-state-icon", "paused");
    expect(paused.className).toContain("project-selector__item-state-icon--paused");
    expect(within(paused).getByTestId("pause-icon")).toBeDefined();
    expect(paused.getAttribute("aria-label")).toBe("Paused");
    expect(paused.getAttribute("title")).toMatch(/paused/i);

    const off = stateIcon("p-proj-off");
    expect(off).toHaveAttribute("data-project-state-icon", "off");
    expect(off.className).toContain("project-selector__item-state-icon--off");
    expect(within(off).getByTestId("square-icon")).toBeDefined();
    expect(off.getAttribute("aria-label")).toMatch(/runtime off/i);
    expect(off.getAttribute("title")).toMatch(/no engine work/i);

    const unknown = stateIcon("p-proj-unknown");
    expect(unknown).toHaveAttribute("data-project-state-icon", "unknown");
    expect(unknown.className).toContain("project-selector__item-state-icon--unknown");
    expect(within(unknown).getByTestId("help-icon")).toBeDefined();
    expect(unknown.getAttribute("aria-label")).toMatch(/unknown/i);
    expect(unknown.getAttribute("title")).toMatch(/could not be read/i);
  });

  it("reads each indicator by role and accessible name, so colour is never the only carrier", () => {
    openCombo();

    for (const [id, name] of [
      ["p-proj-running", "Running"],
      ["p-proj-paused", "Paused"],
      ["p-proj-off", /runtime off/i],
      ["p-proj-off-legacy", /runtime off/i],
      ["p-proj-unknown", /state unknown/i],
    ] as const) {
      const row = screen.getByTestId(`project-selector-item-${id}`);
      // One labelled indicator per row, reached by name alone — no colour, no test id involved.
      expect(within(row).getAllByRole("img", { name })).toHaveLength(1);
    }
  });

  it("renders `unknown` neutral, never the off indicator, even though runtimeEnabled is false", () => {
    openCombo();

    const row = screen.getByTestId("project-selector-item-p-proj-unknown");
    const icon = within(row).getByTestId("project-state-icon-p-proj-unknown");

    expect(icon).toHaveAttribute("data-project-state-icon", "unknown");
    expect(icon.className).toContain("--unknown");
    expect(icon.className).not.toContain("--off");
    // The red stop glyph is absent for this row; an unreadable project is not a turned-off one.
    expect(within(row).queryByTestId("square-icon")).toBeNull();
    expect(within(row).queryByTestId("play-icon")).toBeNull();
    // And the neutral colour token is the dimmed text token, not a status colour.
    expect(icon.className).not.toContain("--running");
  });

  it("lets the runtime switch beat `status`: an active project with runtimeState disabled is off", () => {
    openCombo();

    const off = stateIcon("p-proj-off");
    expect(within(screen.getByTestId("project-selector-item-p-proj-off")).getByTestId("square-icon")).toBeDefined();
    expect(off).toHaveAttribute("data-project-state-icon", "off");

    // Same verdict through the legacy projection, which carries only `runtimeEnabled: false`.
    expect(stateIcon("p-proj-off-legacy")).toHaveAttribute("data-project-state-icon", "off");
  });

  it("survives per-character typing: the indicator does not remount or steal the search input's focus", async () => {
    const user = userEvent.setup();
    openCombo();

    const input = screen.getByTestId("project-selector-search-input");
    await user.click(input);

    // Node identity across the re-render, not just a final value: a component nested in the selector
    // would replace the whole row subtree on each keystroke (FN-8606), and this is the only
    // assertion that can see it.
    const iconBefore = screen.getByTestId("project-state-icon-p-proj-off");
    await user.type(input, "proj");

    expect(input).toHaveValue("proj");
    expect(input).toHaveFocus();
    expect(screen.getByTestId("project-state-icon-p-proj-off")).toBe(iconBefore);
    expect(within(screen.getByTestId("project-selector-item-p-proj-off")).getByTestId("square-icon")).toBeDefined();

    // Narrowing to one row keeps its indicator and its accessible name intact.
    await user.clear(input);
    await user.type(input, "unknown");
    expect(input).toHaveValue("unknown");
    expect(input).toHaveFocus();
    expect(screen.getByTestId("project-state-icon-p-proj-unknown")).toHaveAttribute(
      "data-project-state-icon",
      "unknown",
    );
  });
});
