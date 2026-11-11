/*
FNXC:ArtifactRetraction 2026-11-11-12:27 (RUFU-433): the task Artifacts tab is where an operator reads a
retraction, so these tests pin what the tile refuses to render, not only what it shows.

The harm this feature removes is a false review artifact staying readable as live evidence. A tile that merely
looked "dimmed" while still loading its image or still offering its expand affordance would leave that harm in
place behind a label, so what is asserted here is:
  - the withdrawn media is never even requested, so no URL exists to click, cache, or leak into a screenshot,
  - the claim text the author wrote (the artifact description) is not rendered,
  - the reason the author was REQUIRED to give is rendered - it is what replaces the claim,
  - the filter is off by default, and reaching a tombstone takes an explicit action,
  - the control stays reachable when the card's only artifact is a tombstone, because default-hidden must not
    quietly become undiscoverable.
*/
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ArtifactWithTask } from "@fusion/core";
import { TaskDocumentsTab } from "../TaskDocumentsTab";
import { artifactMediaUrlWithToken, fetchTaskDocuments } from "../../api";
import { useArtifacts } from "../../hooks/useArtifacts";

vi.mock("../../api", () => ({
  fetchTaskDocuments: vi.fn(),
  fetchTaskDocument: vi.fn(),
  fetchTaskDocumentRevisions: vi.fn(),
  putTaskDocument: vi.fn(),
  deleteTaskDocument: vi.fn(),
  artifactMediaUrlWithToken: vi.fn((id: string) => `/api/artifacts/${id}/media?fn_token=token`),
}));

vi.mock("../../hooks/useArtifacts", () => ({
  useArtifacts: vi.fn(),
}));

vi.mock("../../hooks/useArtifactImageBlob", () => ({
  useArtifactImageBlob: vi.fn(() => ({ url: "blob:secure-preview", loading: false, error: null, reload: vi.fn() })),
}));

const mockFetchTaskDocuments = vi.mocked(fetchTaskDocuments);
const mockMediaUrl = vi.mocked(artifactMediaUrlWithToken);
const mockUseArtifacts = vi.mocked(useArtifacts);

const LIVE: ArtifactWithTask = {
  id: "art-live",
  type: "image",
  title: "Live screenshot",
  description: "What the run actually looked like",
  authorId: "agent-executor",
  authorType: "agent",
  taskId: "RUFU-433",
  createdAt: "2026-11-10T10:00:00.000Z",
  updatedAt: "2026-11-10T10:00:00.000Z",
};

const VOID: ArtifactWithTask = {
  ...LIVE,
  id: "art-void",
  title: "Retracted screenshot",
  description: "A claim about coverage that the author withdrew.",
  retractedAt: "2026-11-11T09:30:00.000Z",
  retractedBy: "agent-executor",
  retractReason: "The run I described was not the run I executed.",
};

const capturedOptions: Array<Record<string, unknown> | undefined> = [];

function mockArtifactList(artifacts: ArtifactWithTask[]) {
  mockUseArtifacts.mockImplementation((options) => {
    capturedOptions.push(options);
    return {
      artifacts,
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    } as ReturnType<typeof useArtifacts>;
  });
}

/*
The tab holds its own documents fetch behind a loading state, so every query waits for the loaded shell first.
Querying synchronously would assert against the spinner rather than the gallery.
*/
async function renderTab() {
  const utils = render(<TaskDocumentsTab taskId="RUFU-433" addToast={vi.fn()} />);
  await waitFor(() => expect(screen.getAllByText("Artifacts").length).toBeGreaterThan(0));
  return utils;
}

beforeEach(() => {
  capturedOptions.length = 0;
  vi.clearAllMocks();
  mockFetchTaskDocuments.mockResolvedValue([]);
});

describe("TaskDocumentsTab retraction rendering", () => {
  it("asks the artifact hook for the hidden view by default", async () => {
    mockArtifactList([LIVE]);
    await renderTab();

    expect(capturedOptions[0]).toMatchObject({ taskId: "RUFU-433", includeRetracted: false });
  });

  it("renders a tombstone as VOID with its reason and requests none of its media", async () => {
    mockArtifactList([VOID]);
    const { container } = await renderTab();

    const tile = screen.getByLabelText("Retracted artifact Retracted screenshot");
    expect(tile.textContent).toContain("VOID");
    expect(tile.textContent).toContain("The run I described was not the run I executed.");
    expect(tile.textContent).toContain("Retracted");

    // Nothing that could load the withdrawn bytes is in the document at all.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("audio")).toBeNull();
    expect(container.querySelector("source")).toBeNull();
    expect(mockMediaUrl).not.toHaveBeenCalledWith("art-void", undefined);
  });

  it("does not render the withdrawn claim a retracted artifact still carries in its description", async () => {
    mockArtifactList([VOID]);
    await renderTab();

    // The reason replaces the claim; a VOID label sitting beside the original claim is a thin defence.
    expect(screen.queryByText("A claim about coverage that the author withdrew.")).toBeNull();
  });

  it("still offers the expand affordance for a live artifact beside a tombstone", async () => {
    mockArtifactList([LIVE, VOID]);
    await renderTab();

    expect(screen.getByLabelText("Expand image artifact Live screenshot")).toBeTruthy();
    expect(screen.queryByLabelText(/Expand image artifact Retracted/)).toBeNull();
    expect(mockMediaUrl).toHaveBeenCalledWith("art-live", undefined);
  });

  it("passes the opt-in to the fetch when the retraction filter is turned on", async () => {
    mockArtifactList([LIVE]);
    await renderTab();

    const toggle = screen.getByRole("checkbox") as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(capturedOptions[capturedOptions.length - 1]).toMatchObject({ includeRetracted: true });
    });
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });

  /*
  The discovery case. A card whose only artifact was retracted shows nothing under the default hide, and if the
  control lived inside an `artifacts.length > 0` guard the operator would have no way to learn a tombstone exists.
  */
  it("keeps the retraction filter reachable when every artifact on the card is hidden", async () => {
    mockArtifactList([]);
    await renderTab();

    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => {
      expect(capturedOptions[capturedOptions.length - 1]).toMatchObject({ includeRetracted: true });
    });
  });

  it("reports an empty tombstone set honestly instead of rendering nothing", async () => {
    mockArtifactList([]);
    await renderTab();

    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => {
      expect(screen.getByText("No retracted artifacts on this task.")).toBeTruthy();
    });
  });

  it("renders a tombstone that carries no recorded reason without an empty gap", async () => {
    mockArtifactList([{ ...VOID, retractReason: undefined }]);
    await renderTab();

    expect(screen.getByText("Retracted, with no reason recorded.")).toBeTruthy();
  });
});
