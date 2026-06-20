import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { CommandCenterControls } from "../CommandCenterControls";

const mocks = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  fetchConfig: vi.fn(),
  updateSettings: vi.fn(),
  toggleGlobalPause: vi.fn(),
  toggleEnginePause: vi.fn(),
  refresh: vi.fn(),
  appSettings: {
    globalPaused: false,
    enginePaused: false,
  },
}));

vi.mock("../../../api/legacy", () => ({
  fetchSettings: mocks.fetchSettings,
  fetchConfig: mocks.fetchConfig,
  updateSettings: mocks.updateSettings,
}));

vi.mock("../../../hooks/useAppSettings", () => ({
  useAppSettings: () => ({
    globalPaused: mocks.appSettings.globalPaused,
    enginePaused: mocks.appSettings.enginePaused,
    toggleGlobalPause: mocks.toggleGlobalPause,
    toggleEnginePause: mocks.toggleEnginePause,
    refresh: mocks.refresh,
  }),
}));

function renderControls(projectId?: string) {
  return render(
    <CommandCenterControls
      projectId={projectId}
      colorTheme="default"
      themeMode="dark"
      onColorThemeChange={vi.fn()}
      onThemeModeChange={vi.fn()}
    />,
  );
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.appSettings.globalPaused = false;
  mocks.appSettings.enginePaused = false;
  mocks.fetchSettings.mockResolvedValue({ maxConcurrent: 2, maxTriageConcurrent: 1, maxWorktrees: 5 });
  mocks.fetchConfig.mockResolvedValue({ maxConcurrent: 2, rootDir: "/repo" });
  mocks.updateSettings.mockResolvedValue({});
  mocks.refresh.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CommandCenterControls", () => {
  it("renders only overview controls after team affordances move", async () => {
    renderControls(undefined);

    await flushPromises();
    expect(screen.getByTestId("command-center-controls")).toBeDefined();
    expect(screen.queryByTestId("cc-controls-org-chart")).toBeNull();
    expect(screen.queryByTestId("cc-controls-heartbeat")).toBeNull();
    expect(screen.getByTestId("cc-controls-engine")).toBeDefined();
    expect(screen.getByTestId("cc-controls-concurrency")).toBeDefined();
    expect(screen.getByTestId("cc-controls-theme")).toBeDefined();
  });

  it("engine controls call the existing settings toggle", async () => {
    renderControls("project-a");

    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: /stop ai engine/i }));
    expect(mocks.toggleGlobalPause).toHaveBeenCalledTimes(1);
    expect(mocks.toggleEnginePause).not.toHaveBeenCalled();
  });

  it("persists bounded concurrency slider changes and refreshes settings", async () => {
    renderControls("project-a");

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");
    const slider = within(section).getByLabelText(/max concurrent tasks/i);
    fireEvent.change(slider, { target: { value: "7" } });

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(mocks.updateSettings).toHaveBeenCalledWith(
      { maxConcurrent: 7, maxTriageConcurrent: 1, maxWorktrees: 5 },
      "project-a",
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("persists concurrency slider changes without a project id", async () => {
    renderControls(undefined);

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");
    const slider = within(section).getByLabelText(/max worktrees/i);
    fireEvent.change(slider, { target: { value: "12" } });

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(mocks.updateSettings).toHaveBeenCalledWith(
      { maxConcurrent: 2, maxTriageConcurrent: 1, maxWorktrees: 12 },
      undefined,
    );
  });

  it("shows save error indicator when concurrency update fails", async () => {
    mocks.updateSettings.mockRejectedValueOnce(new Error("network error"));
    renderControls("project-a");

    await flushPromises();
    const section = screen.getByTestId("cc-controls-concurrency");
    const slider = within(section).getByLabelText(/max concurrent tasks/i);
    fireEvent.change(slider, { target: { value: "8" } });

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(within(section).getByText(/save failed/i)).toBeDefined();
  });

  it("selects a theme from the embedded dropdown", async () => {
    const onColorThemeChange = vi.fn();
    render(
      <CommandCenterControls
        colorTheme="default"
        themeMode="dark"
        onColorThemeChange={onColorThemeChange}
        onThemeModeChange={vi.fn()}
      />,
    );

    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: /default/i }));
    fireEvent.click(screen.getAllByRole("option").find((element) => element.textContent?.trim() === "Forest")!);

    expect(onColorThemeChange).toHaveBeenCalledWith("forest");
  });
});
