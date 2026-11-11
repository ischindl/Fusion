/*
FNXC:ArtifactRetraction 2026-11-11-12:27 (RUFU-433): the shared review gallery is the surface a MERGE decision is
made from, and it receives its artifacts as props rather than fetching them itself. That makes it the surface most
exposed to a tombstone arriving by someone else's choice of `includeRetracted`, so the VOID rule is asserted here
at the gallery's own boundary: whatever the caller hands in, a retracted entry renders as a tombstone in every
category, asks for none of its media, and offers no affordance that treats it as live evidence.

The gallery routes every category through one `CategoryGrid` dispatch, so these cases also pin that a renderer
added later inherits the rule instead of needing its own retraction check.
*/
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ArtifactWithTask } from "@fusion/core";
import { ArtifactsGallery } from "../ArtifactsGallery";
import { artifactMediaUrlWithToken, fetchArtifact } from "../../api";

vi.mock("../../api", () => ({
  artifactMediaUrlWithToken: vi.fn((id: string) => `/api/artifacts/${id}/media?fn_token=t`),
  fetchArtifact: vi.fn(),
  fetchArtifactText: vi.fn(),
  updateArtifact: vi.fn(),
  deleteArtifact: vi.fn(),
}));

vi.mock("../../hooks/useArtifactImageBlob", () => ({
  useArtifactImageBlob: vi.fn(() => ({ url: "blob:preview", loading: false, error: null, reload: vi.fn() })),
}));

const mockMediaUrl = vi.mocked(artifactMediaUrlWithToken);
const mockFetchArtifact = vi.mocked(fetchArtifact);

function artifact(over: Partial<ArtifactWithTask>): ArtifactWithTask {
  return {
    id: "art-1",
    type: "image",
    title: "Screenshot",
    authorId: "agent-executor",
    authorType: "agent",
    taskId: "RUFU-433",
    taskLabel: "RUFU-433",
    taskColumn: "review",
    createdAt: "2026-11-10T10:00:00.000Z",
    updatedAt: "2026-11-10T10:00:00.000Z",
    ...over,
  } as ArtifactWithTask;
}

const RETRACTED = "The run I described was not the run I executed.";

function retracted(over: Partial<ArtifactWithTask> = {}): ArtifactWithTask {
  return artifact({
    retractedAt: "2026-11-11T09:30:00.000Z",
    retractedBy: "agent-executor",
    retractReason: RETRACTED,
    ...over,
  });
}

function renderGallery(artifacts: ArtifactWithTask[]) {
  return render(
    <ArtifactsGallery
      artifacts={artifacts}
      projectId="project-1"
      isMobile={false}
      addToast={vi.fn()}
      onOpenTask={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchArtifact.mockResolvedValue(artifact({}));
});

describe("ArtifactsGallery retraction rendering", () => {
  it("renders a retracted image as a tombstone that requests none of its media", () => {
    const { container } = renderGallery([retracted({ title: "Retracted screenshot" })]);

    const tile = screen.getByLabelText("Retracted artifact Retracted screenshot");
    expect(tile.textContent).toContain("VOID");
    expect(tile.textContent).toContain(RETRACTED);
    expect(container.querySelector("img")).toBeNull();
    expect(mockMediaUrl).not.toHaveBeenCalled();
  });

  it("renders a retracted document row with no affordance that treats it as live evidence", async () => {
    const doc = retracted({ id: "art-doc", type: "document", title: "Retracted claim", mimeType: "text/markdown" });
    const { container } = renderGallery([doc]);

    const row = screen.getByLabelText("Retracted artifact Retracted claim");
    expect(row.textContent).toContain("VOID");
    expect(row.textContent).toContain(RETRACTED);
    // A tombstone is not editable and not openable: no click target exists to reach the viewer or its Edit button.
    expect(container.querySelector("button")).toBeNull();
    expect(mockFetchArtifact).not.toHaveBeenCalled();

    fireEvent.click(row);
    expect(mockFetchArtifact).not.toHaveBeenCalled();
  });

  it("renders a retracted audio entry without a playable element", () => {
    const { container } = renderGallery([
      retracted({ id: "art-audio", type: "audio", title: "Retracted recording", mimeType: "audio/mpeg" }),
    ]);

    expect(screen.getByLabelText("Retracted artifact Retracted recording").textContent).toContain("VOID");
    expect(container.querySelector("audio")).toBeNull();
    expect(container.querySelector("source")).toBeNull();
  });

  it("renders a retracted other-category entry as a tombstone rather than a download link", () => {
    const { container } = renderGallery([
      retracted({ id: "art-file", type: "other", title: "Retracted bundle", mimeType: "application/gzip" }),
    ]);

    expect(screen.getByLabelText("Retracted artifact Retracted bundle").textContent).toContain("VOID");
    // A plain anchor to the media URL is the one affordance that survives every React-side refusal, because the
    // browser follows it without asking the component tree anything.
    expect(container.querySelector("a[href]")).toBeNull();
  });

  it("keeps a live artifact of the same category fully interactive beside a tombstone", () => {
    const liveImage = artifact({ id: "art-live", title: "Live screenshot" });
    const liveVideo = artifact({ id: "art-clip", type: "video", title: "Live clip", mimeType: "video/mp4" });
    renderGallery([liveImage, liveVideo, retracted({ id: "art-void", title: "Retracted screenshot" })]);

    expect(screen.getByLabelText("Retracted artifact Retracted screenshot")).toBeTruthy();
    // The rule is per-entry: the gallery must not go blank or lose its grid because one entry was withdrawn.
    expect(screen.getByText("Live screenshot")).toBeTruthy();
    // An image reaches its bytes through the authorised blob path, so the URL assertion belongs to the video,
    // the category that does build a media URL into the tile.
    expect(mockMediaUrl).toHaveBeenCalledWith("art-clip", "project-1");
    expect(mockMediaUrl).not.toHaveBeenCalledWith("art-void", "project-1");
  });

  it("shows the tombstone count so a withdrawn artifact is visible in the header numbers", () => {
    renderGallery([
      artifact({ id: "art-live", title: "Live screenshot" }),
      retracted({ id: "art-void", title: "Retracted screenshot" }),
    ]);

    // The count is the only place the totals are stated; a tombstone that vanished from it would be uncounted.
    expect(screen.getByText(/2/)).toBeTruthy();
  });

  it("renders nothing alarming for an empty gallery", () => {
    renderGallery([]);
    expect(screen.queryByText("VOID")).toBeNull();
  });
});
