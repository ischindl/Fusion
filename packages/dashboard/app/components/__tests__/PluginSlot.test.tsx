import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { PluginSlot } from "../PluginSlot";
import type { PluginUiSlotEntry } from "../../api";
import { usePluginUiSlots } from "../../hooks/usePluginUiSlots";

vi.mock("../../hooks/usePluginUiSlots");

function createSlotEntry(slotId: string, pluginId = "test-plugin"): PluginUiSlotEntry {
  return {
    pluginId,
    slot: {
      slotId,
      label: `Test slot ${slotId}`,
      componentPath: `./components/${slotId}.js`,
    },
  };
}

describe("PluginSlot", () => {
  beforeEach(() => {
    vi.mocked(usePluginUiSlots).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders nothing when no matching slots (empty array)", () => {
    vi.mocked(usePluginUiSlots).mockReturnValue({
      slots: [],
      getSlotsForId: vi.fn(() => []),
      loading: false,
      error: null,
    });

    const { container } = render(<PluginSlot slotId="task-detail-tab" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders fallback shell for single matching slot", () => {
    const entry = createSlotEntry("task-detail-tab", "plugin-a");
    vi.mocked(usePluginUiSlots).mockReturnValue({
      slots: [entry],
      getSlotsForId: vi.fn(() => [entry]),
      loading: false,
      error: null,
    });

    const { container } = render(<PluginSlot slotId="task-detail-tab" />);

    const shells = container.querySelectorAll("[data-plugin-slot]");
    expect(shells).toHaveLength(1);
    const shell = shells[0];
    expect(shell).toHaveAttribute("data-slot-id", "task-detail-tab");
    expect(shell).toHaveAttribute("data-plugin-id", "plugin-a");
    expect(shell).toHaveAttribute("data-component-path", "./components/task-detail-tab.js");
    expect(shell).toHaveAttribute("aria-label", "Test slot task-detail-tab");
    expect(shell.textContent).toContain("Test slot task-detail-tab");
    expect(shell.textContent).toContain("plugin-a");
  });

  it("renders multiple fallback shells for multiple plugins registered for same slotId", () => {
    const entryA = createSlotEntry("board-column-footer", "plugin-x");
    const entryB = createSlotEntry("board-column-footer", "plugin-y");
    vi.mocked(usePluginUiSlots).mockReturnValue({
      slots: [entryA, entryB],
      getSlotsForId: vi.fn(() => [entryA, entryB]),
      loading: false,
      error: null,
    });

    const { container } = render(<PluginSlot slotId="board-column-footer" />);

    const shells = container.querySelectorAll("[data-plugin-slot]");
    expect(shells).toHaveLength(2);

    // Verify both shells have correct attributes
    expect(shells[0]).toHaveAttribute("data-plugin-id", "plugin-x");
    expect(shells[0]).toHaveAttribute("data-slot-id", "board-column-footer");
    expect(shells[1]).toHaveAttribute("data-plugin-id", "plugin-y");
    expect(shells[1]).toHaveAttribute("data-slot-id", "board-column-footer");
  });

  it("returns null when loading", () => {
    vi.mocked(usePluginUiSlots).mockReturnValue({
      slots: [],
      getSlotsForId: vi.fn(() => []),
      loading: true,
      error: null,
    });

    const { container } = render(<PluginSlot slotId="header-action" />);
    expect(container.firstChild).toBeNull();
  });

  it("returns null on error", () => {
    vi.mocked(usePluginUiSlots).mockReturnValue({
      slots: [],
      getSlotsForId: vi.fn(() => []),
      loading: false,
      error: "fetch failed",
    });

    const { container } = render(<PluginSlot slotId="header-action" />);
    expect(container.firstChild).toBeNull();
  });

  it("passes projectId to usePluginUiSlots hook", () => {
    vi.mocked(usePluginUiSlots).mockReturnValue({
      slots: [],
      getSlotsForId: vi.fn(() => []),
      loading: false,
      error: null,
    });

    render(<PluginSlot slotId="settings-section" projectId="proj-1" />);

    expect(vi.mocked(usePluginUiSlots)).toHaveBeenCalledWith("proj-1");
  });

  it("returns null for empty string slotId", () => {
    const getSlotsForId = vi.fn(() => []);
    vi.mocked(usePluginUiSlots).mockReturnValue({
      slots: [],
      getSlotsForId,
      loading: false,
      error: null,
    });

    const { container } = render(<PluginSlot slotId="" />);
    expect(container.firstChild).toBeNull();
    // getSlotsForId should not be called when slotId is falsy
    expect(getSlotsForId).not.toHaveBeenCalled();
  });

  it("filters rendered slots by pluginIds when provided", () => {
    const entryA = createSlotEntry("task-detail-tab", "plugin-a");
    const entryB = createSlotEntry("task-detail-tab", "plugin-b");
    vi.mocked(usePluginUiSlots).mockReturnValue({
      slots: [entryA, entryB],
      getSlotsForId: vi.fn(() => [entryA, entryB]),
      loading: false,
      error: null,
    });

    const { container } = render(<PluginSlot slotId="task-detail-tab" pluginIds={["plugin-b"]} />);

    const shells = container.querySelectorAll("[data-plugin-slot]");
    expect(shells).toHaveLength(1);
    expect(shells[0]).toHaveAttribute("data-plugin-id", "plugin-b");
  });
});
