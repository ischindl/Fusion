import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ProjectCard } from "../ProjectCard";
import { setProjectRuntime } from "../../api";
import type { ProjectHealth } from "@fusion/core";
import type { ProjectCardEntry } from "../ProjectCard";

/*
FNXC:ProjectRuntimeOff 2026-11-07-17:41 (RUFU-871):
The projects surface must answer "which projects are unloaded" at a glance and let the operator undo
it from the same place. Before this the only way back on was the footer engine menu of the project you
were ALREADY inside, so a turned-off project could only be read about, never recovered.

The card is `memo`'d with a hand-written comparator, so the label is also asserted across a prop
change: a refresh that flips only `runtimeEnabled` must repaint, or the operator keeps being told the
runtime is off after they turned it on.
*/

vi.mock("lucide-react", () => ({
  Play: () => <span data-testid="play-icon" />,
  Power: () => <span data-testid="power-icon" />,
  PowerOff: () => <span data-testid="power-off-icon" />,
  Pause: () => <span data-testid="status-pause-icon" />,
  Square: () => <span data-testid="stop-icon" />,
  AlertCircle: () => <span data-testid="alert-icon" />,
  Loader2: () => <span data-testid="loader-icon" />,
  Trash2: () => <span data-testid="trash-icon" />,
  Folder: () => <span data-testid="folder-icon" />,
  ArrowRight: () => <span data-testid="arrow-icon" />,
}));

const HEALTH: ProjectHealth = {
  projectId: "p-off",
  status: "active",
  activeTaskCount: 0,
  inFlightAgentCount: 0,
  totalTasksCompleted: 0,
  totalTasksFailed: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function entry(overrides: Partial<ProjectCardEntry> = {}): ProjectCardEntry {
  return {
    id: "p-off",
    name: "Turned Off Project",
    path: "/srv/p-off",
    status: "active",
    isolationMode: "in-process",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runtimeEnabled: false,
    ...overrides,
  };
}

const noop = () => {};

afterEach(cleanup);

function renderCard(project: ProjectCardEntry, onEnableRuntime?: (project: ProjectCardEntry) => void) {
  return render(
    <ProjectCard
      project={project}
      health={HEALTH}
      onSelect={noop}
      onPause={noop}
      onResume={noop}
      onRemove={noop}
      onEnableRuntime={onEnableRuntime}
    />,
  );
}

describe("ProjectCard runtime state", () => {
  it("labels a turned-off project as unloaded, separately from its project status", () => {
    renderCard(entry({ status: "paused" }));

    const state = screen.getByTestId("project-runtime-state");
    expect(state).toHaveAttribute("data-project-state", "off");
    expect(state.textContent).toContain("Runtime off");
    // `status` keeps its own badge: the two axes are shown side by side, never merged.
    expect(screen.getByText("Paused")).toBeTruthy();
  });

  it("offers a turn-on affordance on the off card and fires it with that project", () => {
    const onEnableRuntime = vi.fn();
    const project = entry();
    renderCard(project, onEnableRuntime);

    const button = screen.getByTestId("project-runtime-enable");
    expect(button.textContent).toContain("Turn runtime on");

    fireEvent.click(button);
    expect(onEnableRuntime).toHaveBeenCalledTimes(1);
    expect(onEnableRuntime.mock.calls[0][0]).toMatchObject({ id: "p-off" });
  });

  it("does not act as a card navigation when the runtime control is pressed", () => {
    const onSelect = vi.fn();
    const onEnableRuntime = vi.fn();
    render(
      <ProjectCard
        project={entry()}
        health={HEALTH}
        onSelect={onSelect}
        onPause={noop}
        onResume={noop}
        onRemove={noop}
        onEnableRuntime={onEnableRuntime}
      />,
    );

    fireEvent.click(screen.getByTestId("project-runtime-enable"));
    expect(onEnableRuntime).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows no runtime label or affordance for a loaded project, and none without a host that can act", () => {
    const { unmount } = renderCard(entry({ runtimeEnabled: true }, noop));
    expect(screen.queryByTestId("project-runtime-state")).toBeNull();
    expect(screen.queryByTestId("project-runtime-enable")).toBeNull();
    unmount();

    // An absent flag means enabled, matching the gate's default, so a server without the field stays quiet.
    renderCard(entry({ runtimeEnabled: undefined }));
    expect(screen.queryByTestId("project-runtime-state")).toBeNull();
  });

  it("rides the existing POST /projects/:id/runtime route when the host wires the real client", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ projectId: "p-off", runtimeEnabled: true, priorRuntimeEnabled: false }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    renderCard(entry(), (project) => {
      void setProjectRuntime(project.id, true, "project-card");
    });
    fireEvent.click(screen.getByTestId("project-runtime-enable"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/projects/p-off/runtime");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ enabled: true });
    expect((init.headers as Record<string, string>)?.["x-fusion-surface"]).toBe("project-card");

    vi.unstubAllGlobals();
  });

  it("re-renders when ONLY runtimeEnabled changes, because the memo comparator must not swallow it", () => {
    const { rerender } = renderCard(entry({ runtimeEnabled: false }), noop);
    expect(screen.getByTestId("project-runtime-state")).toBeTruthy();

    rerender(
      <ProjectCard
        project={entry({ runtimeEnabled: true })}
        health={HEALTH}
        onSelect={noop}
        onPause={noop}
        onResume={noop}
        onRemove={noop}
        onEnableRuntime={noop}
      />,
    );

    expect(screen.queryByTestId("project-runtime-state")).toBeNull();
  });
});
