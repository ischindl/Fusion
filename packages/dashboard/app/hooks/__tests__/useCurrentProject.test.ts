import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import {
  CONSECUTIVE_ABSENCE_THRESHOLD,
  useCurrentProject,
} from "../useCurrentProject";
import type { ProjectInfo } from "../../api";
import * as swrCache from "../../utils/swrCache";

// Mock the API functions
vi.mock("../../api", () => ({
  fetchGlobalSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
}));

import { fetchGlobalSettings, updateGlobalSettings } from "../../api";

/*
FNXC:IdleBoardReadCost 2026-11-18-11:25 (RUFU-479): the two kinds of settings read are now distinguishable
by their arguments, and the assertions below have to name which one they are counting. A read with NO
arguments is the hydrating read - the one that could DECIDE the selection. A read with `{ forceFresh: true }`
is the merge base a whole-map write needs (`dashboardCurrentProjectIdByNode` carries one entry per node, so
the writer must not merge onto a TTL-cached snapshot). Counting them together used to be exact; counting
them together now would either forgive a duplicate hydrating read or forbid a write's own base.
*/
type SettingsCall = Parameters<typeof fetchGlobalSettings>;
const settingsMock = () => fetchGlobalSettings as unknown as ReturnType<typeof vi.fn>;
/** Reads that could have decided the selection: the hydrating read takes no arguments. */
const decisionReads = () => settingsMock().mock.calls.filter((call: SettingsCall) => call.length === 0);
/** Reads that only exist to give a whole-map write its merge base. */
const mergeReads = () =>
  settingsMock().mock.calls.filter(
    (call: SettingsCall) => (call[0] as { forceFresh?: boolean } | undefined)?.forceFresh === true,
  );

describe("useCurrentProject", () => {
  const mockProjects: ProjectInfo[] = [
    {
      id: "proj_1",
      name: "Project One",
      path: "/path/one",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "proj_2",
      name: "Project Two",
      path: "/path/two",
      status: "paused",
      isolationMode: "child-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  const cloneProjects = (): ProjectInfo[] => mockProjects.map((project) => ({ ...project }));

  const mockReadCache = vi.spyOn(swrCache, "readCache");
  const mockWriteCache = vi.spyOn(swrCache, "writeCache");

  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    vi.clearAllMocks();
    mockReadCache.mockReturnValue(null);
    // Default mock implementations
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (updateGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("initializes with null when no saved project and no available projects", async () => {
    const { result } = renderHook(() => useCurrentProject([]));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.currentProject).toBeNull();
  });

  it("auto-default on null requires threshold number of confirming polls", async () => {
    const { result, rerender } = renderHook(
      ({ projects }) => useCurrentProject(projects),
      { initialProps: { projects: [] as ProjectInfo[] } },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.currentProject).toBeNull();

    for (let i = 0; i < CONSECUTIVE_ABSENCE_THRESHOLD - 1; i += 1) {
      rerender({ projects: [...mockProjects] });
      expect(result.current.currentProject).toBeNull();
    }

    rerender({ projects: [...mockProjects] });
    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_1");
    });
  });

  it("hydrates from cached project id immediately", async () => {
    mockReadCache.mockReturnValueOnce("proj_2");
    const { result } = renderHook(() => useCurrentProject(mockProjects));

    expect(result.current.loading).toBe(false);
    expect(result.current.currentProject?.id).toBe("proj_2");
  });

  it("passes long maxAge for current-project cache reads", () => {
    renderHook(() => useCurrentProject(mockProjects));

    expect(mockReadCache).toHaveBeenCalledWith(
      swrCache.SWR_CACHE_KEYS.CURRENT_PROJECT_ID,
      { maxAgeMs: swrCache.SWR_LONG_MAX_AGE_MS },
    );
  });

  it("hydrates from URL project before settings/cache fallback", async () => {
    mockReadCache.mockReturnValueOnce("proj_1");
    window.history.replaceState({}, "", "/?project=proj_2");
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      dashboardCurrentProjectIdByNode: { local: "proj_1" },
    });

    const { result } = renderHook(() => useCurrentProject(mockProjects));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.currentProject?.id).toBe("proj_2");
    // The URL is the whole decision: nothing about the selection was read from settings.
    expect(decisionReads()).toHaveLength(0);
    // Persisting the URL-derived selection is a whole-map write, and that write buys its own merge base.
    expect(mergeReads()).toHaveLength(1);
    expect(mockWriteCache).toHaveBeenCalledWith(swrCache.SWR_CACHE_KEYS.CURRENT_PROJECT_ID, "proj_2");
  });

  it("waits for URL project while projects are still loading", async () => {
    window.history.replaceState({}, "", "/?project=proj_2");

    const { result, rerender } = renderHook(
      ({ projects, projectsLoading }) => useCurrentProject(projects, { projectsLoading }),
      { initialProps: { projects: [] as ProjectInfo[], projectsLoading: true } },
    );

    expect(result.current.currentProject).toBeNull();
    expect(result.current.loading).toBe(true);

    rerender({ projects: cloneProjects(), projectsLoading: false });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.currentProject?.id).toBe("proj_2");
    // Waiting for the URL list must not spend a settings read on the decision either.
    expect(decisionReads()).toHaveLength(0);
    expect(mergeReads()).toHaveLength(1);
  });

  it("keeps unknown URL project from falling back to default project", async () => {
    window.history.replaceState({}, "", "/?project=missing");
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      dashboardCurrentProjectIdByNode: { local: "proj_1" },
    });

    const { result, rerender } = renderHook(
      ({ projects }) => useCurrentProject(projects),
      { initialProps: { projects: cloneProjects() } },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.currentProject).toBeNull();
    expect(fetchGlobalSettings).not.toHaveBeenCalled();

    for (let i = 0; i <= CONSECUTIVE_ABSENCE_THRESHOLD; i += 1) {
      rerender({ projects: cloneProjects() });
    }

    expect(result.current.currentProject).toBeNull();
  });

  it("falls back to settings-driven selection when cache miss occurs", async () => {
    mockReadCache.mockReturnValueOnce(null);
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      dashboardCurrentProjectIdByNode: { local: "proj_1" },
    });

    const { result } = renderHook(() => useCurrentProject(mockProjects));

    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_1");
    });
  });

  it("loads saved project from global settings", async () => {
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      dashboardCurrentProjectIdByNode: { local: "proj_1" },
    });

    const { result } = renderHook(() => useCurrentProject(mockProjects));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // After hydration, it should have the saved project
    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_1");
    });
  });

  it("loads saved project for specific node ID", async () => {
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      dashboardCurrentProjectIdByNode: { "node-123": "proj_2" },
    });

    const { result } = renderHook(() => useCurrentProject(mockProjects, { nodeId: "node-123" }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Should load proj_2 for node-123
    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_2");
    });
  });

  it("does not rehydrate on poll rerenders after manual project switch", async () => {
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      dashboardCurrentProjectIdByNode: { local: "proj_1" },
    });

    const { result, rerender } = renderHook(
      ({ projects }) => useCurrentProject(projects),
      { initialProps: { projects: cloneProjects() } },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_1");
    });

    act(() => {
      result.current.setCurrentProject(mockProjects[1]);
    });
    expect(result.current.currentProject?.id).toBe("proj_2");

    for (let i = 0; i < 3; i += 1) {
      rerender({ projects: cloneProjects() });
    }

    expect(result.current.currentProject?.id).toBe("proj_2");
    // Three fresh poll arrays must not re-hydrate: exactly one deciding read for the whole sequence.
    expect(decisionReads()).toHaveLength(1);
    // The one manual switch is the only write, so it owns the only merge base. The claim is published
    // before that read settles, which is what stops a re-render storm from buying a read each.
    expect(mergeReads()).toHaveLength(1);
  });

  it("does not persist a saved local selection across fresh poll arrays", async () => {
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      dashboardCurrentProjectIdByNode: { local: "proj_1" },
    });

    const { result, rerender } = renderHook(
      ({ projects }) => useCurrentProject(projects),
      { initialProps: { projects: cloneProjects() } },
    );

    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_1");
    });

    for (let poll = 0; poll < 4; poll += 1) {
      rerender({ projects: cloneProjects() });
    }

    expect(result.current.currentProject?.id).toBe("proj_1");
    expect(updateGlobalSettings).not.toHaveBeenCalled();
  });

  it("persists a named-node manual switch once after matching hydration", async () => {
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      dashboardCurrentProjectIdByNode: { "node-456": "proj_1" },
    });

    const { result } = renderHook(() => useCurrentProject(cloneProjects(), { nodeId: "node-456" }));

    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_1");
    });

    act(() => {
      result.current.setCurrentProject(mockProjects[1]);
    });

    // The PUT now follows a fresh merge-base read, so it settles a hop later than the click; the count and
    // the map contents are the same claim they always were.
    await waitFor(() => {
      expect(updateGlobalSettings).toHaveBeenCalledTimes(1);
    });
    expect(updateGlobalSettings).toHaveBeenCalledWith({
      dashboardCurrentProjectIdByNode: { "node-456": "proj_2" },
    });
  });

  it("keeps explicit clear through poll rerenders without rehydrating", async () => {
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      dashboardCurrentProjectIdByNode: { local: "proj_1" },
    });

    const { result, rerender } = renderHook(
      ({ projects }) => useCurrentProject(projects),
      { initialProps: { projects: cloneProjects() } },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_1");
    });

    act(() => {
      result.current.clearCurrentProject();
    });
    expect(result.current.currentProject).toBeNull();

    for (let i = 0; i < CONSECUTIVE_ABSENCE_THRESHOLD - 1; i += 1) {
      rerender({ projects: cloneProjects() });
    }

    expect(result.current.currentProject).toBeNull();
    expect(decisionReads()).toHaveLength(1);
    // The clear deletes one key out of the whole map, so it buys its merge base exactly once - and the
    // synchronously claimed delete is what keeps the absence threshold's rerenders from buying more.
    expect(mergeReads()).toHaveLength(1);
  });

  it("rehydrates once when nodeId changes", async () => {
    (fetchGlobalSettings as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        dashboardCurrentProjectIdByNode: { local: "proj_1" },
      })
      .mockResolvedValueOnce({
        dashboardCurrentProjectIdByNode: { "node-123": "proj_2" },
      });

    const { result, rerender } = renderHook(
      ({ projects, nodeId }) => useCurrentProject(projects, { nodeId }),
      { initialProps: { projects: cloneProjects(), nodeId: null as string | null } },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_1");
    });

    rerender({ projects: cloneProjects(), nodeId: "node-123" });

    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_2");
    });
    // One deciding read per node key, and no more, however many reads the writes themselves need.
    expect(decisionReads()).toHaveLength(2);
  });

  it("restores saved project when it appears in later polls", async () => {
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      dashboardCurrentProjectIdByNode: { local: "proj_2" },
    });

    const { result, rerender } = renderHook(
      ({ projects }) => useCurrentProject(projects),
      { initialProps: { projects: [mockProjects[0]] as ProjectInfo[] } },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.currentProject).toBeNull();

    rerender({ projects: cloneProjects() });

    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_2");
    });
    expect(fetchGlobalSettings).toHaveBeenCalledTimes(1);
  });

  it("stale cached project id falls back after absence threshold", async () => {
    mockReadCache.mockReturnValueOnce("proj_old");
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      dashboardCurrentProjectIdByNode: { local: "proj_old" },
    });

    const { result, rerender } = renderHook(
      ({ projects }) => useCurrentProject(projects),
      { initialProps: { projects: mockProjects } },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    for (let i = 0; i < CONSECUTIVE_ABSENCE_THRESHOLD; i += 1) {
      rerender({ projects: [...mockProjects] });
    }

    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_1");
    });
  });

  it("clears selection when project no longer exists and defaults to first active", async () => {
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      dashboardCurrentProjectIdByNode: { local: "proj_old" },
    });

    const { result, rerender } = renderHook(
      ({ projects }) => useCurrentProject(projects),
      { initialProps: { projects: mockProjects } },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    for (let i = 0; i < CONSECUTIVE_ABSENCE_THRESHOLD; i += 1) {
      rerender({ projects: [...mockProjects] });
    }

    // Should clear and default to first active
    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_1");
    });

    // Should persist the new selection
    expect(updateGlobalSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        dashboardCurrentProjectIdByNode: { local: "proj_1" },
      }),
    );
  });

  it("setCurrentProject updates selection and persists to global settings", async () => {
    const { result } = renderHook(() => useCurrentProject(mockProjects));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setCurrentProject(mockProjects[1]);
    });

    expect(result.current.currentProject?.id).toBe("proj_2");
    /*
    FNXC:IdleBoardReadCost 2026-11-18-11:35 (RUFU-479): the PUT now lands one hop after the click, because a
    whole-map write first buys the server map it is merging into. The selection itself is still applied
    synchronously (the line above), which is the user-visible half of the contract.
    */
    await waitFor(() => {
      expect(updateGlobalSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          dashboardCurrentProjectIdByNode: { local: "proj_2" },
        }),
      );
    });
    expect(mockWriteCache).toHaveBeenCalledWith(swrCache.SWR_CACHE_KEYS.CURRENT_PROJECT_ID, "proj_2");
  });

  it("setCurrentProject uses node ID as key when provided", async () => {
    const { result } = renderHook(() => useCurrentProject(mockProjects, { nodeId: "node-456" }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setCurrentProject(mockProjects[1]);
    });

    await waitFor(() => {
      expect(updateGlobalSettings).toHaveBeenCalled();
    });
    expect(updateGlobalSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        dashboardCurrentProjectIdByNode: { "node-456": "proj_2" },
      }),
    );
  });

  it("clearCurrentProject removes selection and does not auto-select", async () => {
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      dashboardCurrentProjectIdByNode: { local: "proj_1" },
    });

    const { result } = renderHook(() => useCurrentProject(mockProjects));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // After loading, we should have proj_1
    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_1");
    });

    act(() => {
      result.current.clearCurrentProject();
    });

    // After explicit clear, should stay null (no auto-select) so user can view overview
    await waitFor(() => {
      expect(result.current.currentProject).toBeNull();
    });

    // Should persist the clear (remove the key)
    expect(updateGlobalSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        dashboardCurrentProjectIdByNode: {},
      }),
    );
  });

  it("handles global settings fetch failure gracefully", async () => {
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network error"));

    const { result, rerender } = renderHook(
      ({ projects }) => useCurrentProject(projects),
      { initialProps: { projects: mockProjects } },
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    for (let i = 0; i < CONSECUTIVE_ABSENCE_THRESHOLD; i += 1) {
      rerender({ projects: [...mockProjects] });
    }

    // Should fall back to default behavior (first active project)
    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_1");
    });
  });

  it("handles global settings update failure gracefully", async () => {
    (updateGlobalSettings as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() => useCurrentProject(mockProjects));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setCurrentProject(mockProjects[1]);
    });

    // Should still update state even if persistence fails
    expect(result.current.currentProject?.id).toBe("proj_2");
  });

  it("migrates legacy localStorage to global settings", async () => {
    // Set up legacy localStorage
    localStorage.setItem("kb-dashboard-current-project", JSON.stringify(mockProjects[0]));
    (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const { result } = renderHook(() => useCurrentProject(mockProjects));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Should load from legacy localStorage
    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe("proj_1");
    });

    // Should migrate to global settings
    expect(updateGlobalSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        dashboardCurrentProjectIdByNode: { local: "proj_1" },
      }),
    );
  });

  describe("transient omission tolerance", () => {
    const activeProjectTwo: ProjectInfo = { ...mockProjects[1], status: "active" };
    const projectsWithoutCurrent = (): ProjectInfo[] => [activeProjectTwo];

    async function waitForProjectOneSelection(result: { current: ReturnType<typeof useCurrentProject> }) {
      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
      await waitFor(() => {
        expect(result.current.currentProject?.id).toBe("proj_1");
      });
    }

    it("transient 1-poll drop of current project does NOT switch selection", async () => {
      (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        dashboardCurrentProjectIdByNode: { local: "proj_1" },
      });

      const { result, rerender } = renderHook(
        ({ projects }) => useCurrentProject(projects),
        { initialProps: { projects: mockProjects } },
      );

      await waitForProjectOneSelection(result);
      rerender({ projects: projectsWithoutCurrent() });
      expect(result.current.currentProject?.id).toBe("proj_1");

      rerender({ projects: mockProjects });
      expect(result.current.currentProject?.id).toBe("proj_1");
    });

    it("transient 2-poll drop of current project does NOT switch selection", async () => {
      (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        dashboardCurrentProjectIdByNode: { local: "proj_1" },
      });

      const { result, rerender } = renderHook(
        ({ projects }) => useCurrentProject(projects),
        { initialProps: { projects: mockProjects } },
      );

      await waitForProjectOneSelection(result);

      for (let i = 0; i < CONSECUTIVE_ABSENCE_THRESHOLD - 1; i += 1) {
        rerender({ projects: projectsWithoutCurrent() });
      }
      expect(result.current.currentProject?.id).toBe("proj_1");

      rerender({ projects: mockProjects });
      expect(result.current.currentProject?.id).toBe("proj_1");
    });

    it("sustained 3+ poll absence of current project DOES switch to fallback", async () => {
      (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        dashboardCurrentProjectIdByNode: { local: "proj_1" },
      });

      const { result, rerender } = renderHook(
        ({ projects }) => useCurrentProject(projects),
        { initialProps: { projects: mockProjects } },
      );

      await waitForProjectOneSelection(result);

      for (let i = 0; i < CONSECUTIVE_ABSENCE_THRESHOLD; i += 1) {
        rerender({ projects: projectsWithoutCurrent() });
      }

      await waitFor(() => {
        expect(result.current.currentProject?.id).toBe("proj_2");
      });
    });

    it("saved-project hydration is immediate (not debounced)", async () => {
      (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        dashboardCurrentProjectIdByNode: { local: "proj_1" },
      });

      const { result } = renderHook(() => useCurrentProject(mockProjects));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.currentProject?.id).toBe("proj_1");
    });

    it("explicit clearCurrentProject() still suppresses auto-select after polls confirm", async () => {
      (fetchGlobalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        dashboardCurrentProjectIdByNode: { local: "proj_1" },
      });

      const { result, rerender } = renderHook(
        ({ projects }) => useCurrentProject(projects),
        { initialProps: { projects: mockProjects } },
      );

      await waitForProjectOneSelection(result);

      act(() => {
        result.current.clearCurrentProject();
      });
      expect(result.current.currentProject).toBeNull();

      for (let i = 0; i <= CONSECUTIVE_ABSENCE_THRESHOLD; i += 1) {
        rerender({ projects: mockProjects });
      }

      expect(result.current.currentProject).toBeNull();
    });
  });
});
