import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { EngineControlMenu } from "../EngineControlMenu";
import { ConfirmDialogProvider } from "../../hooks/useConfirm";

/*
FNXC:ProjectRuntimeOff 2026-11-07-15:56:
The operator has to be able to SEE an unloaded project and SWITCH it back from the same surface.

A project that silently does nothing is indistinguishable from a dead engine — that is the exact
confusion this feature would otherwise create, because the board keeps rendering normally while every
engine lane stands down. So two things are pinned here: the badge is present while the project's
`runtimeEnabled` is false and absent otherwise (it is not a permanent widget), and the menu's runtime
row is the one that POSTs the switch, rather than patching settings from the client — the route is
what records the `project:runtime-toggled` audit row and applies the change to the live engine.

Asserted through the rendered control and a real click, not through source text.
*/

const apiMocks = vi.hoisted(() => ({
  fetchConfig: vi.fn(),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
  setProjectRuntime: vi.fn(),
}));

const legacyMocks = vi.hoisted(() => ({
  fetchConfig: vi.fn(),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
  fetchGlobalConcurrency: vi.fn(),
  updateGlobalConcurrency: vi.fn(),
}));

vi.mock("../../api", () => apiMocks);
vi.mock("../../api/legacy", () => legacyMocks);

const settingsFor = (runtimeEnabled: boolean) => ({
  maxConcurrent: 2,
  maxWorktrees: 4,
  globalPause: false,
  enginePaused: false,
  autoMerge: true,
  runtimeEnabled,
  experimentalFeatures: {},
});

async function openMenu(runtimeEnabled: boolean) {
  legacyMocks.fetchSettings.mockResolvedValue(settingsFor(runtimeEnabled));
  apiMocks.fetchSettings.mockResolvedValue(settingsFor(runtimeEnabled));
  apiMocks.fetchConfig.mockResolvedValue({});
  legacyMocks.fetchConfig.mockResolvedValue({});
  legacyMocks.fetchGlobalConcurrency.mockResolvedValue({
    globalMaxConcurrent: 6,
    currentlyActive: 0,
    queuedCount: 0,
    projectsActive: {},
  });
  legacyMocks.updateGlobalConcurrency.mockResolvedValue({});

  render(
    <ConfirmDialogProvider>
      <EngineControlMenu projectId="proj_off" />
    </ConfirmDialogProvider>,
  );
  await act(async () => {
    fireEvent.click(screen.getByTestId("engine-control-menu-trigger"));
  });
  await screen.findByTestId("engine-control-menu");
}

describe("EngineControlMenu runtime unload switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("badges the trigger while the project's runtime is unloaded", async () => {
    await openMenu(false);
    expect(await screen.findByTestId("engine-control-runtime-off-badge")).toBeTruthy();
  });

  it("badges nothing for a loaded project, so the state is not a permanent widget", async () => {
    await openMenu(true);
    expect(screen.queryByTestId("engine-control-runtime-off-badge")).toBeNull();
  });

  it("switches the runtime through its own route, not by patching settings", async () => {
    await openMenu(true);
    apiMocks.setProjectRuntime.mockResolvedValue({
      projectId: "proj_off",
      runtimeEnabled: false,
      priorRuntimeEnabled: true,
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("engine-control-runtime-toggle-btn"));
    });

    expect(apiMocks.setProjectRuntime).toHaveBeenCalledWith("proj_off", false);
    // The pause control stays a different control with its own meaning.
    expect(legacyMocks.updateSettings).not.toHaveBeenCalledWith({ enginePaused: true });
    await waitFor(() => {
      expect(screen.getByTestId("engine-control-runtime-off-badge")).toBeTruthy();
    });
  });
});
