import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import * as apiModule from "../../api";
import type { ProjectInfo } from "../../api";
import { TaskTransferModal } from "../TaskTransferModal";
import { ProjectSelector } from "../ProjectSelector";

/*
FNXC:CrossProjectHandoff 2026-09-10-19:19 (RUFU-211):
One Escape press must dismiss exactly one layer. Before this fix a single press closed the transfer
dialog *and* still reached the overlay underneath it, and the hosted project dropdown never owned the
keystroke at all. The repair is two mechanisms that are each individually insufficient, so each half
gets its own test:

- The picker claims Escape at document CAPTURE with `stopPropagation()`. That is the only thing that
  keeps the keystroke from the BUBBLE-phase document listeners of every surface stacked beneath the
  dialog (task detail, board card, list view, the app-wide Escape arbiter, and the header's menu
  cluster — all four are reproduced as pre-registered bubble spies below).
- The dialog YIELDS while its dropdown is open (a ref-based flag written by `onOpenChange`). That is
  the only thing that lets a later-registered picker listener beat the dialog's own earlier capture
  registration, because same-node/same-phase listeners run in registration order.

A capture listener removed without the `true` flag is never removed, and a leaked claim would swallow
Escape forever, so one test presses Escape AFTER the dropdown closes and asserts the dialog still
closes — the behavioral proof that the claim was withdrawn, without addEventListener introspection.
*/

vi.mock("../../api", () => ({
  fetchProjects: vi.fn(),
  fetchProjectsAcrossNodes: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

const fetchProjects = vi.mocked(apiModule.fetchProjects);
const fetchProjectsAcrossNodes = vi.mocked(apiModule.fetchProjectsAcrossNodes);

const CURRENT = { id: "p-cur", name: "Current Project", path: "/p-cur" };
const TARGET = { id: "p-b", name: "Project Beta", path: "/p-b" };

function project(p: { id: string; name: string; path: string }): ProjectInfo {
  return {
    id: p.id,
    name: p.name,
    path: p.path,
    status: "active",
    isolationMode: "in-process",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

const TASK = { id: "FN-101", title: "Transfer me" };

function renderModal(overrides: Partial<React.ComponentProps<typeof TaskTransferModal>> = {}) {
  const props = {
    task: TASK,
    currentProjectId: CURRENT.id,
    open: true,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides,
  };
  render(<TaskTransferModal {...props} />);
  return props;
}

/** Opens the hosted picker and returns its search input, the element a real Escape is aimed at. */
async function openDropdown(): Promise<HTMLInputElement> {
  fireEvent.click(await screen.findByTestId("project-selector-trigger"));
  await screen.findByTestId("project-selector-dropdown");
  return screen.getByTestId("project-selector-search-input") as HTMLInputElement;
}

function pressEscape(target: Element | Document): void {
  fireEvent.keyDown(target, { key: "Escape" });
}

beforeEach(() => {
  vi.clearAllMocks();
  // JSDOM does not implement scrollIntoView, which the picker calls when keyboard focus moves.
  Element.prototype.scrollIntoView = vi.fn();
  fetchProjectsAcrossNodes.mockResolvedValue([project(CURRENT), project(TARGET)]);
  fetchProjects.mockResolvedValue([project(CURRENT), project(TARGET)]);
});

describe("TaskTransferModal Escape layering", () => {
  it("closes only the dropdown, leaving the dialog open", async () => {
    const { onClose } = renderModal();
    const searchInput = await openDropdown();

    pressEscape(searchInput);

    expect(screen.queryByTestId("project-selector-dropdown")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("task-transfer-modal")).toBeTruthy();
  });

  it("closes the dialog on the next Escape once no layer is below it", async () => {
    const { onClose } = renderModal();
    const searchInput = await openDropdown();

    pressEscape(searchInput);
    expect(onClose).not.toHaveBeenCalled();

    pressEscape(screen.getByTestId("task-transfer-modal"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not leak the claimed Escape to an overlay stacked beneath the dialog", async () => {
    renderModal();
    const searchInput = await openDropdown();

    // Stands in for the task-detail / board-card / list-view / arbiter listeners: bubble-phase on
    // document. Registered BEFORE the keystroke it must not see, exactly like those hosts.
    const overlayBeneath = vi.fn();
    document.addEventListener("keydown", overlayBeneath);
    try {
      // Control FIRST, while the input is still mounted: an ordinary key must reach the overlay
      // beneath untouched. It also proves the recorder works, so the Escape assertion below cannot
      // be satisfied by a listener that never fires at all — and it fails if the claim over-reaches
      // past Escape.
      fireEvent.keyDown(searchInput, { key: "a" });
      expect(overlayBeneath).toHaveBeenCalledTimes(1);

      pressEscape(searchInput);
      expect(overlayBeneath).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", overlayBeneath);
    }
  });

  it("stale-yield guard: the dialog's capture handler reflects the dropdown opened AFTER it registered", async () => {
    // The dialog registers its capture Escape listener the moment it opens; the picker registers its
    // own only once its dropdown opens, i.e. strictly later. A yield flag read from a stale closure
    // would still be `false` here and the dialog would close on the first Escape — the exact
    // one-keystroke collapse this change removes.
    const { onClose } = renderModal();
    const searchInput = await openDropdown();

    pressEscape(searchInput);

    expect(screen.queryByTestId("project-selector-dropdown")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("returns Escape to the dialog when the dropdown closes by selecting a target", async () => {
    const { onClose } = renderModal();
    await openDropdown();

    // Closing by selection is the other path back to the dialog — it must clear the yield flag too.
    fireEvent.click(screen.getByText("Project Beta"));
    expect(screen.queryByTestId("project-selector-dropdown")).toBeNull();

    pressEscape(screen.getByTestId("task-transfer-modal"));

    // A yield flag stuck at `true` (or a capture claim that leaked past close) lands here instead.
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves the dropdown's own keyboard handling alive for non-Escape keys", async () => {
    renderModal();
    await openDropdown();

    // The dropdown container owns the arrow/Enter keyboard model (the picker's Escape claim is a
    // separate native listener). If that claim swallowed every key, the picker inside this dialog
    // could no longer be driven from the keyboard at all.
    fireEvent.keyDown(screen.getByTestId("project-selector-dropdown"), { key: "ArrowDown" });

    expect(screen.getByTestId("project-selector-item-p-b").className).toContain("highlighted");
  });
});

/*
FNXC:CrossProjectHandoff 2026-09-10-00:20 (RUFU-211):
Header-host stand-in. `Header.tsx` is out of scope, but its Escape handler (which closes the view
overflow, main overflow, mobile search, node selector, and mobile project switch — all in the BUBBLE
phase on document) is the host whose menus the picker now sits above. This component reproduces
exactly that registration: a bubble-phase document listener that consumes Escape to "close the
menus". With the dropdown CLOSED the picker claims nothing, so a host Escape must still behave as it
always did; with the dropdown OPEN the picker's capture claim must stop the keystroke so the menus
survive. That side effect (opening the dropdown no longer collapses the header's other menus in the
same keystroke) is the intended behavior change, not a regression.
*/
function HostStandIn({ onCloseMenus }: { onCloseMenus: () => void }) {
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseMenus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCloseMenus]);

  return (
    <div data-testid="host-standin">
      <ProjectSelector
        projects={[project(CURRENT), project(TARGET)]}
        currentProject={project(CURRENT)}
        onViewAll={vi.fn()}
        allowSingleProject
      />
    </div>
  );
}

describe("ProjectSelector Escape layering against a bubble-phase host (header stand-in)", () => {
  it("with the dropdown CLOSED, one Escape still closes the host exactly as before", () => {
    const onCloseMenus = vi.fn();
    render(<HostStandIn onCloseMenus={onCloseMenus} />);

    pressEscape(document.body);

    // The picker registers no listener while closed, so it cannot intercept this keystroke.
    expect(onCloseMenus).toHaveBeenCalledTimes(1);
  });

  it("with the dropdown OPEN, the host's menus do NOT close — the picker owns the keystroke", async () => {
    const onCloseMenus = vi.fn();
    render(<HostStandIn onCloseMenus={onCloseMenus} />);

    const searchInput = await openDropdown();

    pressEscape(searchInput);

    expect(screen.queryByTestId("project-selector-dropdown")).toBeNull();
    expect(onCloseMenus).not.toHaveBeenCalled();

    // Non-vacuity: once the picker tears its claim down, the very same event reaches the host again.
    pressEscape(document.body);
    expect(onCloseMenus).toHaveBeenCalledTimes(1);
  });
});
