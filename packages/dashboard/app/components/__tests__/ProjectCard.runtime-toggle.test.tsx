import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ProjectCard } from "../ProjectCard";
import { setProjectRuntime } from "../../api";
import type { ProjectHealth } from "@fusion/core";
import type { ProjectCardEntry } from "../ProjectCard";

/*
FNXC:ProjectRuntimeOff 2026-11-07-20:31 (RUFU-871):
The runtime control on a project card was one-sided: `App.tsx` wired only `handleEnableProjectRuntime`
and the card rendered the affordance only for `isRuntimeOff`, so an operator could read "Runtime off"
and re-arm a project from its card but could never UNLOAD one there — that needed the footer engine menu
of the project you were already inside. These tests pin the toggle: a running project's card offers
"Turn runtime off" and fires the setter with the off state, an unloaded card keeps "Turn runtime on" and
fires with the on state, the pause axis is never touched, and the pressed control shows a pending state
until the refreshed projection lands.
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
  projectId: "p-toggle",
  status: "active",
  activeTaskCount: 1,
  inFlightAgentCount: 0,
  totalTasksCompleted: 0,
  totalTasksFailed: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function entry(overrides: Partial<ProjectCardEntry> = {}): ProjectCardEntry {
  return {
    id: "p-toggle",
    name: "Running Project",
    path: "/srv/p-toggle",
    status: "active",
    isolationMode: "in-process",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runtimeEnabled: true,
    ...overrides,
  };
}

const noop = () => {};

interface CardHost {
  onSelect?: (project: ProjectCardEntry) => void;
  onPause?: (project: ProjectCardEntry) => void;
  onResume?: (project: ProjectCardEntry) => void;
  onEnableRuntime?: (project: ProjectCardEntry, enabled?: boolean) => void | Promise<void>;
}

function renderCard(project: ProjectCardEntry, host: CardHost = {}) {
  return render(
    <ProjectCard
      project={project}
      health={HEALTH}
      onSelect={host.onSelect ?? noop}
      onPause={host.onPause ?? noop}
      onResume={host.onResume ?? noop}
      onRemove={noop}
      onEnableRuntime={host.onEnableRuntime}
    />,
  );
}

afterEach(cleanup);

describe("ProjectCard runtime toggle", () => {
  it("offers a turn-off affordance on a running project's card, naming the runtime axis", () => {
    renderCard(entry({ runtimeEnabled: true }), { onEnableRuntime: noop });

    const button = screen.getByTestId("project-runtime-disable");
    expect(button.textContent).toContain("Turn runtime off");
    // The copy says what the switch does and never claims the project is deleted or paused.
    expect(String(button.getAttribute("title"))).toContain("next pass");
    expect(String(button.getAttribute("title"))).toContain("stay readable");
    expect(button.textContent).not.toMatch(/delete|remove|pause/i);
    // The pause axis keeps its own control beside it: two switches, two names.
    expect(screen.getByText("Stop engine")).toBeTruthy();
  });

  it("fires the runtime setter with the OFF state when a running project's toggle is pressed", () => {
    const onEnableRuntime = vi.fn();
    const project = entry({ runtimeEnabled: true });
    renderCard(project, { onEnableRuntime });

    fireEvent.click(screen.getByTestId("project-runtime-disable"));

    expect(onEnableRuntime).toHaveBeenCalledTimes(1);
    expect(onEnableRuntime.mock.calls[0][0]).toMatchObject({ id: "p-toggle" });
    expect(onEnableRuntime.mock.calls[0][1]).toBe(false);
  });

  it("rides POST /projects/:id/runtime with enabled:false for the off direction", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ projectId: "p-toggle", runtimeEnabled: false, priorRuntimeEnabled: true }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    renderCard(entry({ runtimeEnabled: true }), {
      onEnableRuntime: (project, enabled) => setProjectRuntime(project.id, enabled === true, "project-card"),
    });
    fireEvent.click(screen.getByTestId("project-runtime-disable"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/projects/p-toggle/runtime");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ enabled: false });
    expect((init.headers as Record<string, string>)?.["x-fusion-surface"]).toBe("project-card");

    vi.unstubAllGlobals();
  });

  it("still offers turn-on for an unloaded project and fires the setter with the ON state", () => {
    const onEnableRuntime = vi.fn();
    renderCard(entry({ runtimeEnabled: false }), { onEnableRuntime });

    const button = screen.getByTestId("project-runtime-enable");
    expect(button.textContent).toContain("Turn runtime on");
    expect(screen.queryByTestId("project-runtime-disable")).toBeNull();

    fireEvent.click(button);

    expect(onEnableRuntime).toHaveBeenCalledTimes(1);
    expect(onEnableRuntime.mock.calls[0][0]).toMatchObject({ id: "p-toggle" });
    expect(onEnableRuntime.mock.calls[0][1]).toBe(true);
  });

  it("never touches the pause axis from either direction of the runtime toggle", () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    const onSelect = vi.fn();

    const { unmount } = renderCard(entry({ runtimeEnabled: true }), {
      onPause,
      onResume,
      onSelect,
      onEnableRuntime: noop,
    });
    fireEvent.click(screen.getByTestId("project-runtime-disable"));
    expect(onPause).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    unmount();

    renderCard(entry({ runtimeEnabled: false, status: "paused" }), { onPause, onResume, onEnableRuntime: noop });
    fireEvent.click(screen.getByTestId("project-runtime-enable"));
    expect(onPause).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
  });

  it("shows a pending state while the request is in flight, then reflects the new state", async () => {
    let settle: () => void = () => {};
    const onEnableRuntime = vi.fn(
      () => new Promise<void>((resolve) => { settle = resolve; }),
    );
    const { rerender } = renderCard(entry({ runtimeEnabled: true }), { onEnableRuntime });

    const button = screen.getByTestId("project-runtime-disable");
    fireEvent.click(button);

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.textContent).toContain("Turning runtime off");

    // The host's refresh flips only `runtimeEnabled`; the memo comparator must let that through so the
    // card repaints to the new state without a page reload.
    settle();
    await waitFor(() => expect(button).not.toBeDisabled());

    rerender(
      <ProjectCard
        project={entry({ runtimeEnabled: false })}
        health={HEALTH}
        onSelect={noop}
        onPause={noop}
        onResume={noop}
        onRemove={noop}
        onEnableRuntime={onEnableRuntime}
      />,
    );

    expect(screen.queryByTestId("project-runtime-disable")).toBeNull();
    expect(screen.getByTestId("project-runtime-enable").textContent).toContain("Turn runtime on");
    expect(screen.getByTestId("project-runtime-state").textContent).toContain("Runtime off");
  });

  it("renders no runtime affordance at all when the host cannot act on the axis", () => {
    renderCard(entry({ runtimeEnabled: true }));
    expect(screen.queryByTestId("project-runtime-disable")).toBeNull();
    expect(screen.queryByTestId("project-runtime-enable")).toBeNull();
  });
});
