import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactImageViewer } from "../ArtifactImageViewer";
import { useArtifactImageBlob } from "../../hooks/useArtifactImageBlob";

vi.mock("../../hooks/useArtifactImageBlob", () => ({ useArtifactImageBlob: vi.fn() }));
vi.mock("../FloatingWindow", () => ({
  FloatingWindow: ({ children, ariaLabel }: { children: ReactNode; ariaLabel?: string }) => <div role="dialog" aria-label={ariaLabel}>{children}</div>,
}));

const mockUseArtifactImageBlob = vi.mocked(useArtifactImageBlob);

describe("ArtifactImageViewer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders a blob image without a raw media link and closes with Escape while restoring focus", () => {
    mockUseArtifactImageBlob.mockReturnValue({ url: "blob:secure-preview", loading: false, error: null, reload: vi.fn() });
    const onClose = vi.fn();
    const trigger = document.createElement("button");
    trigger.textContent = "Open";
    document.body.append(trigger);
    trigger.focus();

    const { unmount } = render(<ArtifactImageViewer artifactId="image-1" title="Secure image" onClose={onClose} />);
    const image = screen.getByRole("img", { name: "Secure image" });
    expect(image).toHaveAttribute("src", "blob:secure-preview");
    expect(image.getAttribute("src")).not.toContain("fn_token");
    expect(screen.queryByRole("link")).toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("exposes an accessible error and retry action without an unsafe image URL", () => {
    const reload = vi.fn();
    mockUseArtifactImageBlob.mockReturnValue({ url: null, loading: false, error: "Failed to load image artifact.", reload });
    render(<ArtifactImageViewer artifactId="image-1" title="Broken image" onClose={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Failed to load image artifact.");
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  /*
  FNXC:ArtifactImageSecurity 2026-08-23-22:30:
  RUFU-152 moved the viewer's open/close/loading/retry copy to app-namespace i18n keys; these
  cases pin the migrated copy through the test i18n instance's English inline defaults.
  */
  it("renders the localized loading copy while the blob resolves", () => {
    mockUseArtifactImageBlob.mockReturnValue({ url: null, loading: true, error: null, reload: vi.fn() });
    render(<ArtifactImageViewer artifactId="image-1" title="Pending image" onClose={vi.fn()} />);

    expect(screen.getByText("Loading image artifact…")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("exposes localized open-task and close controls", () => {
    mockUseArtifactImageBlob.mockReturnValue({ url: "blob:secure-preview", loading: false, error: null, reload: vi.fn() });
    const onOpenTask = vi.fn();
    render(<ArtifactImageViewer artifactId="image-1" title="Secured image" taskId="task-42" onOpenTask={onOpenTask} onClose={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Close artifact preview" })).toHaveAccessibleName("Close artifact preview");
    fireEvent.click(screen.getByRole("button", { name: "Open task" }));
    expect(onOpenTask).toHaveBeenCalledOnce();
    expect(onOpenTask).toHaveBeenCalledWith("task-42");
  });
});
