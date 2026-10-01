import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import * as apiModule from "../../api";
import type { ProjectInfo, ProjectInfoWithSource } from "../../api";
import { PROJECT_DISCOVERY_TIMEOUT_MS, TaskTransferModal, type TaskTransferSelection } from "../TaskTransferModal";
import { useTaskTransferModal, type TaskTransferModalHost } from "../../hooks/useTaskTransferModal";
import { SWR_CACHE_KEYS, writeCache } from "../../utils/swrCache";

/*
FNXC:CrossProjectHandoff 2026-09-09-09:02 (RUFU-203):
The picker is the ONLY place a transfer target is chosen, so these tests pin what the server cannot
enforce for itself: the current project is never a selectable target, remote (cross-node) projects
are visible-but-disabled with a human sentence (never a machine code), and Escape/backdrop collapse
exactly one layer when the picker is nested inside another overlay.
*/

vi.mock("../../api", () => ({
  fetchProjects: vi.fn(),
  fetchProjectsAcrossNodes: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, values?: Record<string, unknown>) => {
      let text = fallback ?? key;
      if (values) {
        for (const [name, value] of Object.entries(values)) {
          text = text.split(`{{${name}}}`).join(String(value));
        }
      }
      return text;
    },
  }),
}));

const fetchProjects = vi.mocked(apiModule.fetchProjects);
const fetchProjectsAcrossNodes = vi.mocked(apiModule.fetchProjectsAcrossNodes);

const CURRENT = { id: "p-cur", name: "Current Project", path: "/p-cur" };
const TARGET = { id: "p-b", name: "Project Beta", path: "/p-b" };
const REMOTE_NAME = "Project Remote";

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

const REMOTE: ProjectInfoWithSource = {
  ...project({ id: "p-remote", name: REMOTE_NAME, path: "/p-remote" }),
  _sourceNodeName: "node-2",
};

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
  const utils = render(<TaskTransferModal {...props} />);
  return { ...props, ...utils };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchProjectsAcrossNodes.mockResolvedValue([project(CURRENT), project(TARGET), REMOTE]);
  fetchProjects.mockResolvedValue([project(CURRENT), project(TARGET)]);
});

async function openDropdown() {
  fireEvent.click(await screen.findByTestId("project-selector-trigger"));
  return screen.findByTestId("project-selector-dropdown");
}

describe("TaskTransferModal", () => {
  it("shows the copy contract, defaults to keep-transferred, and blocks Confirm until a target is picked", async () => {
    const { onConfirm } = renderModal();
    const dialog = await screen.findByTestId("task-transfer-modal");

    expect(dialog.textContent).toContain("Copies FN-101 into another project");
    expect(within(dialog).getByText("Comments, execution history, worktrees, branches, and missions are NOT copied")).toBeTruthy();

    const keepTransferred = within(dialog).getByLabelText("Keep the original, marked as transferred") as HTMLInputElement;
    const keepUnchanged = within(dialog).getByLabelText("Keep the original unchanged") as HTMLInputElement;
    expect(keepTransferred.checked).toBe(true);
    expect(keepUnchanged.checked).toBe(false);

    const confirm = screen.getByTestId("task-transfer-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("lists other local projects, never the current one, and disables remote projects with a translated sentence", async () => {
    renderModal();
    await screen.findByTestId("task-transfer-modal");

    const dropdown = await openDropdown();

    expect(within(dropdown).queryByText(CURRENT.name)).toBeNull();
    expect(within(dropdown).getByText(TARGET.name)).toBeTruthy();

    const remoteRow = (await within(dropdown).findByTestId("project-selector-item-p-remote")) as HTMLButtonElement;
    expect(remoteRow.disabled).toBe(true);
    expect(remoteRow.getAttribute("aria-disabled")).toBe("true");
    // A translated sentence, never the machine code: an operator learns WHY without reading internals.
    expect(remoteRow.textContent).toContain("Lives on another machine — transfer only reaches projects on this install");
    expect(remoteRow.textContent).not.toContain("cross-node");

    // A disabled remote entry is a no-op: nothing gets selected, Confirm stays blocked.
    fireEvent.click(remoteRow);
    expect(screen.queryByTestId("task-transfer-change-project")).toBeNull();
    expect((screen.getByTestId("task-transfer-confirm") as HTMLButtonElement).disabled).toBe(true);
  });

  it("confirms with the selected target and the chosen disposition", async () => {
    const { onConfirm } = renderModal();
    await screen.findByTestId("task-transfer-modal");

    const dropdown = await openDropdown();
    fireEvent.click(within(dropdown).getByText(TARGET.name).closest('[role="option"]')!);

    expect(await screen.findByText("Target: Project Beta")).toBeTruthy();
    const confirm = screen.getByTestId("task-transfer-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);

    fireEvent.click(screen.getByText("Keep the original unchanged"));
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const selection = onConfirm.mock.calls[0][0] as TaskTransferSelection;
    expect(selection).toEqual({ targetProjectId: TARGET.id, disposition: "keep-unchanged" });
  });

  it("cancel closes the picker and confirms nothing", async () => {
    const { onClose, onConfirm } = renderModal();
    await screen.findByTestId("task-transfer-modal");

    fireEvent.click(screen.getByTestId("task-transfer-cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("reports a failed project-list load instead of offering an empty target list", async () => {
    fetchProjectsAcrossNodes.mockRejectedValue(new Error("registry offline"));
    renderModal();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load the project list");
    expect(alert.textContent).toContain("registry offline");
  });

  /*
  FNXC:CrossProjectHandoff 2026-09-11-00:20 (RUFU-211):
  Enumerated surface: a one-project install (or an install whose only other project IS the card's
  own) filters `currentProjectId` down to zero selectable targets. The picker used to answer that
  with a blank panel — indistinguishable from the stalled load the operator reported — because its
  only empty message was gated on a typed search query. This pins the invariant at the TRANSFER
  HOST (not just at the picker in isolation): the host that filters candidates away must still
  render the explained empty state, keep the search-specific message out of it, and refuse to
  submit a target that does not exist.
  */
  it("explains a zero-target install instead of offering a blank target panel", async () => {
    fetchProjectsAcrossNodes.mockResolvedValue([project(CURRENT)]);
    fetchProjects.mockResolvedValue([project(CURRENT)]);
    renderModal();

    await screen.findByTestId("task-transfer-modal");
    const dropdown = await openDropdown();

    const empty = within(dropdown).getByTestId("project-selector-empty");
    expect(empty.textContent).toContain("No other projects on this machine");
    // A blank panel looked like the hang; a search-specific sentence would blame a query never typed.
    expect(within(dropdown).queryByTestId("project-selector-no-results")).toBeNull();
    expect(within(dropdown).queryByText(CURRENT.name)).toBeNull();

    // Nothing selectable means nothing to submit: Confirm stays disabled rather than transferring
    // the card into its own project.
    expect((screen.getByTestId("task-transfer-confirm") as HTMLButtonElement).disabled).toBe(true);
  });

  /*
  FNXC:CrossProjectHandoff 2026-09-09-09:02 (RUFU-203):
  The picker is hosted INSIDE the card-detail overlay, whose bubble-phase document Escape listener
  was registered BEFORE the picker existed — same-node bubble listeners run in registration order,
  so the naive wiring closed BOTH layers on one Escape. The capture-phase listener in the modal is
  the fix; the unmount control below proves the host listener really does receive the same keydown
  when the picker is not mounted, so the swallow above is the capture phase, not a dead spy.
  */
  it("Escape closes only the picker, never the hosting overlay", async () => {
    const hostEscape = vi.fn();
    document.addEventListener("keydown", hostEscape); // bubble phase, registered BEFORE the picker opens
    const { onClose, unmount } = renderModal();
    const dialog = await screen.findByTestId("task-transfer-modal");

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(hostEscape).not.toHaveBeenCalled();

    // Non-vacuous control: with the picker unmounted, the SAME keydown reaches the host listener.
    unmount();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(hostEscape).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", hostEscape);
  });

  it("a backdrop click cancels; clicks inside the dialog do not", async () => {
    const { onClose } = renderModal();
    const dialog = await screen.findByTestId("task-transfer-modal");
    const backdrop = dialog.parentElement as HTMLElement;

    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/*
FNXC:CrossProjectHandoff 2026-09-10-18:40 (RUFU-211):
Symptom verification for the operator's "iba tam svietilo Loading projects": the target picker sat on
the loading row forever because nothing bounded the two discovery reads, and reopening inherited the
same hung request. These cases pin the invariant the old render gate broke — the picker always lands
on something the operator can act on — with fake timers so the 10 s bound is exercised in milliseconds
(no real waits: AGENTS.md "Do Not Add Slow Tests"). Every case drives the REAL never-settling shape
(`new Promise(() => {})`) rather than a rejection, because a stalled server never rejects; the
rejection path is the pre-existing load-failure case above.
*/
describe("TaskTransferModal bounded project discovery", () => {
  /** A request that never answers — the shape of a stalled `withCentralCore` read. */
  function neverSettle(): Promise<never> {
    return new Promise<never>(() => {});
  }

  /** Drain the promise chain (then/catch/finally hops) inside React's act queue. */
  async function flush(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });
  }

  /** Pass the UI's own deadline, flushing the state the timeout writes. */
  async function passDiscoveryBound(): Promise<void> {
    await act(async () => {
      vi.advanceTimersByTime(PROJECT_DISCOVERY_TIMEOUT_MS + 10);
    });
  }

  afterEach(() => {
    vi.useRealTimers();
    // The projects SWR key is read-only here but shared process-side: never leak a seed into
    // another test in this file (the dashboard setup only clears sessionStorage).
    window.localStorage.clear();
  });

  it("leaves the spinner at the discovery bound with a named error and a Retry affordance", async () => {
    vi.useFakeTimers();
    fetchProjectsAcrossNodes.mockImplementation(neverSettle);
    fetchProjects.mockImplementation(neverSettle);

    renderModal();

    // Cold cache + no candidates: the spinner is the honest state, but only until the bound.
    expect(screen.getByTestId("task-transfer-loading").textContent).toContain("Loading projects");
    expect(screen.queryByTestId("task-transfer-load-error")).toBeNull();

    await passDiscoveryBound();

    expect(screen.queryByTestId("task-transfer-loading")).toBeNull();
    const alert = screen.getByTestId("task-transfer-load-error");
    expect(alert.getAttribute("role")).toBe("alert");
    // The timeout is its OWN named condition — not "could not load: <error>", which blames the
    // operator for a server that never answered.
    expect(alert.textContent).toContain("Still waiting on the project list");
    const retry = screen.getByTestId("task-transfer-retry") as HTMLButtonElement;
    expect(retry.getAttribute("aria-busy")).toBe("false");
    expect(screen.getByTestId("task-transfer-cancel")).toBeTruthy();
  });

  it("Retry re-issues discovery force-fresh and a successful retry replaces the error row", async () => {
    vi.useFakeTimers();
    fetchProjectsAcrossNodes.mockImplementation(neverSettle);
    fetchProjects.mockImplementation(neverSettle);

    renderModal();
    await passDiscoveryBound();

    const callsBefore = fetchProjectsAcrossNodes.mock.calls.length;
    expect(callsBefore).toBe(1);

    fetchProjectsAcrossNodes.mockResolvedValue([project(CURRENT), project(TARGET), REMOTE]);
    fetchProjects.mockResolvedValue([project(CURRENT), project(TARGET)]);

    fireEvent.click(screen.getByTestId("task-transfer-retry"));

    expect(fetchProjectsAcrossNodes.mock.calls.length).toBe(callsBefore + 1);
    /*
    A retry that merely JOINS the still-hanging shared entry reproduces the original stall, so the
    operator-initiated retry must bypass it (`forceFresh`) — that also redirects joiners such as the
    header switcher to the fresh result.
    */
    expect(fetchProjectsAcrossNodes.mock.calls[callsBefore][0]).toMatchObject({ forceFresh: true });

    await flush();

    expect(screen.queryByTestId("task-transfer-load-error")).toBeNull();
    fireEvent.click(screen.getByTestId("project-selector-trigger"));
    const dropdown = screen.getByTestId("project-selector-dropdown");
    expect(within(dropdown).getByText(TARGET.name)).toBeTruthy();
    expect(within(dropdown).queryByText(CURRENT.name)).toBeNull();
  });

  it("seeds candidates from the header switcher's cache so a stalled refresh never blocks the decision", async () => {
    vi.useFakeTimers();
    writeCache(SWR_CACHE_KEYS.PROJECTS, [project(CURRENT), project(TARGET), REMOTE]);
    fetchProjectsAcrossNodes.mockImplementation(neverSettle);
    fetchProjects.mockImplementation(neverSettle);
    const setItem = vi.spyOn(window.localStorage, "setItem");

    renderModal();

    // Targets are actionable at t=0: no spinner while there is something to select.
    expect(screen.queryByTestId("task-transfer-loading")).toBeNull();
    const trigger = screen.getByTestId("project-selector-trigger");
    expect(trigger).toBeTruthy();

    await passDiscoveryBound();

    // The failed refresh reports itself ABOVE the picker instead of replacing it: the seeded list
    // stays selectable, so the operator is never asked to reload the page to make a decision.
    expect(screen.getByTestId("task-transfer-load-error").textContent).toContain("Still waiting");
    fireEvent.click(trigger);
    const dropdown = screen.getByTestId("project-selector-dropdown");
    expect(within(dropdown).getByText(TARGET.name)).toBeTruthy();
    expect(within(dropdown).getByText(TARGET.name).closest("button")?.hasAttribute("disabled")).toBe(false);
    // Past the bound the dialog has GIVEN UP waiting, so it no longer claims to be busy.
    const retry = screen.getByTestId("task-transfer-retry");
    expect(retry.getAttribute("aria-busy")).toBe("false");

    // A seeded retry keeps the candidates on screen (no blank-then-fill flicker) and reports itself.
    fireEvent.click(retry);
    expect(screen.getByTestId("task-transfer-retry").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("project-selector-trigger")).toBeTruthy();
    expect(fetchProjectsAcrossNodes.mock.calls.length).toBe(2);
    expect(fetchProjectsAcrossNodes.mock.calls[1][0]).toMatchObject({ forceFresh: true });

    // Read-only against the cache: useProjects stays the sole writer of the projects key.
    for (const [key] of setItem.mock.calls) {
      expect(key).not.toBe(SWR_CACHE_KEYS.PROJECTS);
    }
    setItem.mockRestore();
  });

  it("keeps an already-chosen target ahead of a later failed retry", async () => {
    vi.useFakeTimers();
    // Seeded cache + a refresh that fails outright: the error row and the picker coexist, which is
    // the only shape in which a target can be chosen while a load error is on screen.
    writeCache(SWR_CACHE_KEYS.PROJECTS, [project(CURRENT), project(TARGET), REMOTE]);
    fetchProjectsAcrossNodes.mockRejectedValue(new Error("registry offline"));
    fetchProjects.mockRejectedValue(new Error("registry offline"));

    renderModal();
    await flush();

    const alert = screen.getByTestId("task-transfer-load-error");
    // A real rejection keeps the {{error}} interpolation (pre-existing contract), unlike a timeout.
    expect(alert.textContent).toContain("Could not load the project list: registry offline");
    expect(screen.getByTestId("project-selector-trigger")).toBeTruthy();

    fireEvent.click(screen.getByTestId("project-selector-trigger"));
    const dropdown = screen.getByTestId("project-selector-dropdown");
    fireEvent.click(within(dropdown).getByText(TARGET.name).closest('[role="option"]')!);

    // The chosen target outranks the error row: hiding the operator's own decision behind a stale
    // failure would lose their place, and Confirm is exactly what they are about to act on.
    expect(screen.getByText("Target: Project Beta")).toBeTruthy();
    expect(screen.queryByTestId("task-transfer-load-error")).toBeNull();
    expect((screen.getByTestId("task-transfer-confirm") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("useTaskTransferModal", () => {
  let hostRef: TaskTransferModalHost | null = null;
  function Host() {
    hostRef = useTaskTransferModal(CURRENT.id);
    return <div>{hostRef.transferModal}</div>;
  }

  function openPicker(task = TASK): Promise<TaskTransferSelection | null> {
    let promise!: Promise<TaskTransferSelection | null>;
    act(() => {
      promise = hostRef!.requestTransfer(task);
    });
    return promise;
  }

  it("resolves the promise with the operator's selection", async () => {
    render(<Host />);
    const pending = openPicker();
    await screen.findByTestId("task-transfer-modal");

    const dropdown = await openDropdown();
    fireEvent.click(within(dropdown).getByText(TARGET.name).closest('[role="option"]')!);
    fireEvent.click(screen.getByTestId("task-transfer-confirm"));

    await expect(pending).resolves.toEqual({ targetProjectId: TARGET.id, disposition: "keep-transferred" });
  });

  it("resolves null on cancel, and unmounting with the picker open is a cancel, not a hang", async () => {
    const { unmount } = render(<Host />);

    const cancelled = openPicker();
    await screen.findByTestId("task-transfer-modal");
    fireEvent.click(screen.getByTestId("task-transfer-cancel"));
    await expect(cancelled).resolves.toBeNull();

    const hanging = openPicker();
    unmount();
    await expect(hanging).resolves.toBeNull();
  });

  it("a second open cancels the first picker instead of stacking promises", async () => {
    render(<Host />);
    const first = openPicker();
    const second = openPicker({ id: "FN-102", title: "Other card" });

    await expect(first).resolves.toBeNull();
    await screen.findByTestId("task-transfer-modal");
    fireEvent.click(screen.getByTestId("task-transfer-cancel"));
    await expect(second).resolves.toBeNull();
  });
});
