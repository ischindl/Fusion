import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import * as apiModule from "../../api";
import type { ProjectInfo, ProjectInfoWithSource } from "../../api";
import { TaskTransferModal, type TaskTransferSelection } from "../TaskTransferModal";
import { useTaskTransferModal, type TaskTransferModalHost } from "../../hooks/useTaskTransferModal";

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
