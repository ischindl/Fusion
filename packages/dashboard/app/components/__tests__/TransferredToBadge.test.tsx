import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Task } from "@fusion/core";
import { TransferredToBadge } from "../TransferredToBadge";
import * as apiModule from "../../api";

/*
FNXC:CrossProjectHandoff 2026-09-09-09:02:
RUFU-203 source-side badge contract: static-from-pointer chip immediately, exactly ONE
handoff-status fetch per badge mount covering every pointer, live pill only for
`targetAvailable:true`, and NEVER an error toast when a target went dark. Clicking performs the
deep-link project switch instead of an in-memory board lookup.
*/

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

vi.mock("../../api", () => ({
  fetchHandoffStatus: vi.fn(async () => ({ handoffs: [] })),
  transferTask: vi.fn(),
  fetchWorkflowSettingValues: vi.fn(async () => ({ stored: {}, effective: {}, orphaned: [] })),
  fetchMission: vi.fn(),
  fetchAgent: vi.fn(),
  fetchAgents: vi.fn().mockResolvedValue([]),
  rebuildTaskSpec: vi.fn(),
}));

const fetchHandoffStatus = vi.mocked(apiModule.fetchHandoffStatus);

function pointer(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "proj-stash",
    projectName: "STASH",
    taskId: "STAS-042",
    transferredAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function badgeTask(sourceMetadata: Record<string, unknown> | undefined): Task {
  return { id: "FN-099", title: "Source", column: "todo", sourceMetadata } as unknown as Task;
}

/** One resolved handoff-status row for a target card, for per-card fetch fixtures. */
function handoffFor(taskId: string, column: string) {
  return {
    projectId: "proj-stash",
    projectName: "STASH",
    taskId,
    transferredAt: "2026-09-01T10:00:00.000Z",
    targetAvailable: true,
    column,
    status: "pending",
  };
}

beforeEach(() => {
  fetchHandoffStatus.mockReset();
  fetchHandoffStatus.mockResolvedValue({ handoffs: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubLocation() {
  const assign = vi.fn();
  vi.stubGlobal("location", { href: "http://localhost:4040/?project=proj-fusion", assign });
  return assign;
}

describe("TransferredToBadge", () => {
  it("renders nothing and fetches nothing without a transferredTo pointer", () => {
    render(<TransferredToBadge task={badgeTask(undefined)} projectId="proj-fusion" />);
    render(<TransferredToBadge task={badgeTask({ transferredTo: [] })} projectId="proj-fusion" />);
    render(<TransferredToBadge task={badgeTask({ transferredTo: [{ projectId: "", taskId: "X" }] })} projectId="proj-fusion" />);
    expect(screen.queryByText(/Transferred/)).toBeNull();
    expect(fetchHandoffStatus).not.toHaveBeenCalled();
  });

  it("shows the static chip immediately from the pointer alone", () => {
    render(<TransferredToBadge task={badgeTask({ transferredTo: [pointer()] })} projectId="proj-fusion" />);
    // The chip label needs no network round-trip: project name + target id were captured at transfer time.
    expect(screen.getByText("Transferred → STASH STAS-042")).toBeTruthy();
  });

  it("fetches handoff status exactly once per mount even with multiple pointers", () => {
    const twoPointers = {
      transferredTo: [pointer(), pointer({ projectId: "proj-keel", projectName: "KEEL", taskId: "KEE-007" })],
    };
    render(<TransferredToBadge task={badgeTask(twoPointers)} projectId="proj-fusion" />);
    expect(screen.getAllByText(/^Transferred → /)).toHaveLength(2);
    expect(fetchHandoffStatus).toHaveBeenCalledTimes(1);
    expect(fetchHandoffStatus).toHaveBeenCalledWith("FN-099", "proj-fusion");
  });

  it("adds the live column pill for a target that resolved", async () => {
    fetchHandoffStatus.mockResolvedValue({
      handoffs: [
        { projectId: "proj-stash", projectName: "STASH", taskId: "STAS-042", transferredAt: "2026-09-01T10:00:00.000Z", targetAvailable: true, column: "in-review", status: "pending" },
        { projectId: "proj-keel", projectName: "KEEL", taskId: "KEE-007", transferredAt: "2026-09-01T10:00:00.000Z", targetAvailable: false, error: "task KEE-007 not found" },
      ],
    });
    render(
      <TransferredToBadge
        task={badgeTask({ transferredTo: [pointer(), pointer({ projectId: "proj-keel", projectName: "KEEL", taskId: "KEE-007" })] })}
        projectId="proj-fusion"
      />,
    );
    const pill = await screen.findByText("in-review");
    expect(pill).toBeTruthy();
    // Per-pointer status: the dark sibling stays static (no invented pill).
    expect(screen.queryByText("not found")).toBeNull();
    const darkChip = screen.getByTestId("transferred-badge-KEE-007");
    expect(darkChip.querySelector(".transferred-chip-status")).toBeNull();
    const liveChip = screen.getByTestId("transferred-badge-STAS-042");
    expect(liveChip.querySelector(".transferred-chip-status")?.textContent).toBe("in-review");
  });

  it("keeps the static chip and raises no error surface when the status fetch fails", async () => {
    fetchHandoffStatus.mockRejectedValue(new Error("network down"));
    render(<TransferredToBadge task={badgeTask({ transferredTo: [pointer()] })} projectId="proj-fusion" />);
    await waitFor(() => {
      expect(fetchHandoffStatus).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText("Transferred → STASH STAS-042")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/network down/i)).toBeNull();
  });

  it("shows no pill when the target is dark (targetAvailable:false)", async () => {
    fetchHandoffStatus.mockResolvedValue({
      handoffs: [{ projectId: "proj-stash", projectName: "STASH", taskId: "STAS-042", transferredAt: "2026-09-01T10:00:00.000Z", targetAvailable: false, error: "project removed" }],
    });
    render(<TransferredToBadge task={badgeTask({ transferredTo: [pointer()] })} projectId="proj-fusion" />);
    await waitFor(() => expect(fetchHandoffStatus).toHaveBeenCalledTimes(1));
    const chip = screen.getByTestId("transferred-badge-STAS-042");
    expect(chip.querySelector(".transferred-chip-status")).toBeNull();
    expect(chip.textContent).toBe("Transferred → STASH STAS-042");
  });

  /*
  FNXC:CrossProjectHandoff 2026-09-09-12:37 (RUFU-203):
  The detail modal mounts ONE badge and re-renders it in place when the operator navigates to another
  card. A boolean "already fetched" marker would keep the second card's chips reading the first
  card's status map (keys never match) and silently degrade the affordance to a static id — so the
  marker is per-card. The control here is the STATUS PILL, not the label: only a re-armed fetch plus a
  cleared map can put the newly opened card's column on screen.
  */
  it("re-arms the status fetch when the same mounted badge is given a different card", async () => {
    const cardA = { id: "FN-099", title: "A", column: "todo", sourceMetadata: { transferredTo: [pointer()] } } as unknown as Task;
    const cardB = {
      id: "FN-100",
      title: "B",
      column: "todo",
      sourceMetadata: { transferredTo: [pointer({ taskId: "STAS-050" })] },
    } as unknown as Task;
    fetchHandoffStatus.mockImplementation(async (id: string) => ({
      handoffs: [handoffFor(id === "FN-099" ? "STAS-042" : "STAS-050", id === "FN-099" ? "in-review" : "todo")],
    }));

    const { rerender } = render(<TransferredToBadge task={cardA} projectId="proj-fusion" />);
    await waitFor(() => expect(screen.getByTestId("transferred-badge-STAS-042").textContent).toContain("in-review"));

    rerender(<TransferredToBadge task={cardB} projectId="proj-fusion" />);
    await waitFor(() => expect(fetchHandoffStatus).toHaveBeenLastCalledWith("FN-100", "proj-fusion"));
    expect(fetchHandoffStatus).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      const chipB = screen.getByTestId("transferred-badge-STAS-050");
      expect(chipB.querySelector(".transferred-chip-status")?.textContent).toBe("todo");
    });
    // Re-render with the SAME card must not refetch (the one-request-per-card budget still holds).
    rerender(<TransferredToBadge task={cardB} projectId="proj-fusion" />);
    expect(fetchHandoffStatus).toHaveBeenCalledTimes(2);
  });

  it("clicking a chip deep-links to the target project card via the boot deep-link params", async () => {
    const assign = stubLocation();
    const user = userEvent.setup();
    render(<TransferredToBadge task={badgeTask({ transferredTo: [pointer()] })} projectId="proj-fusion" />);
    await user.click(screen.getByTestId("transferred-badge-STAS-042"));
    expect(assign).toHaveBeenCalledTimes(1);
    const url = new URL(assign.mock.calls[0][0] as string);
    expect(url.searchParams.get("project")).toBe("proj-stash");
    expect(url.searchParams.get("task")).toBe("STAS-042");
  });
});
