import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useProjects } from "../useProjects";
import * as api from "../../api";
import type { ProjectInfo, ProjectInfoWithSource } from "../../api";

vi.mock("../../api", () => ({
  fetchProjectsAcrossNodes: vi.fn(),
  registerProject: vi.fn(),
  unregisterProject: vi.fn(),
  updateProject: vi.fn(),
  reportDashboardPerf: vi.fn(),
}));

const mockFetchProjectsAcrossNodes = vi.mocked(api.fetchProjectsAcrossNodes);
const mockUpdateProject = vi.mocked(api.updateProject);
const mockRegisterProject = vi.mocked(api.registerProject);
const mockUnregisterProject = vi.mocked(api.unregisterProject);
const mockReportDashboardPerf = vi.mocked(api.reportDashboardPerf);

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useProjects", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchProjectsAcrossNodes.mockReset();
    mockUpdateProject.mockReset();
    mockRegisterProject.mockReset();
    mockUnregisterProject.mockReset();
    mockReportDashboardPerf.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("visibility change", () => {
    let originalVisibilityState: PropertyDescriptor | undefined;

    beforeEach(() => {
      originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");
    });

    afterEach(() => {
      if (originalVisibilityState) {
        Object.defineProperty(document, "visibilityState", originalVisibilityState);
      } else {
        delete (document as any).visibilityState;
      }
    });

    function setVisibilityState(state: "visible" | "hidden") {
      Object.defineProperty(document, "visibilityState", {
        value: state,
        writable: true,
        configurable: true,
      });
    }

    async function dispatchVisibilityChange() {
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await Promise.resolve();
      });
    }

    it("refetches projects when visibility changes from hidden to visible", async () => {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

      const initialProject: ProjectInfoWithSource = {
        id: "proj_001",
        name: "Initial Project",
        path: "/initial/path",
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const refreshedProject: ProjectInfoWithSource = {
        id: "proj_001",
        name: "Updated Project",
        path: "/initial/path",
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      };

      mockFetchProjectsAcrossNodes.mockResolvedValueOnce([initialProject]).mockResolvedValueOnce([refreshedProject]);

      const { result } = renderHook(() => useProjects());

      await act(async () => {
        await flushPromises();
      });

      expect(result.current.projects).toHaveLength(1);
      expect(result.current.projects[0].name).toBe("Initial Project");

      vi.setSystemTime(new Date("2026-01-01T00:00:01.100Z"));
      setVisibilityState("hidden");
      await dispatchVisibilityChange();

      setVisibilityState("visible");
      await dispatchVisibilityChange();

      await act(async () => {
        await flushPromises();
      });

      expect(result.current.projects[0].name).toBe("Updated Project");
      expect(mockFetchProjectsAcrossNodes).toHaveBeenCalledTimes(2);
    });

    it("does not refetch when visibility changes to hidden", async () => {
      const initialProject: ProjectInfoWithSource = {
        id: "proj_001",
        name: "Test Project",
        path: "/test/path",
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      mockFetchProjectsAcrossNodes.mockResolvedValueOnce([initialProject]);

      renderHook(() => useProjects());

      await act(async () => {
        await flushPromises();
      });

      mockFetchProjectsAcrossNodes.mockClear();

      setVisibilityState("hidden");
      await dispatchVisibilityChange();

      expect(mockFetchProjectsAcrossNodes).not.toHaveBeenCalled();
    });

    it("debounces rapid visibility changes (minimum 1 second between fetches)", async () => {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

      const initialProject: ProjectInfoWithSource = {
        id: "proj_001",
        name: "Test Project",
        path: "/test/path",
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      mockFetchProjectsAcrossNodes.mockResolvedValue([initialProject]);

      renderHook(() => useProjects());

      await act(async () => {
        await flushPromises();
      });

      mockFetchProjectsAcrossNodes.mockClear();

      vi.setSystemTime(new Date("2026-01-01T00:00:01.100Z"));
      setVisibilityState("hidden");
      await dispatchVisibilityChange();

      setVisibilityState("visible");
      await dispatchVisibilityChange();

      expect(mockFetchProjectsAcrossNodes).toHaveBeenCalledTimes(1);

      for (let i = 0; i < 5; i++) {
        setVisibilityState("hidden");
        await dispatchVisibilityChange();

        setVisibilityState("visible");
        await dispatchVisibilityChange();
      }

      expect(mockFetchProjectsAcrossNodes).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-01-01T00:00:02.200Z"));
      setVisibilityState("hidden");
      await dispatchVisibilityChange();

      setVisibilityState("visible");
      await dispatchVisibilityChange();

      expect(mockFetchProjectsAcrossNodes).toHaveBeenCalledTimes(2);
    });

    it("cleans up visibility change listener on unmount", async () => {
      mockFetchProjectsAcrossNodes.mockResolvedValueOnce([]);

      const removeEventListenerSpy = vi.spyOn(document, "removeEventListener");

      const { unmount } = renderHook(() => useProjects());

      await waitFor(() => {
        expect(mockFetchProjectsAcrossNodes).toHaveBeenCalledTimes(1);
      });

      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));

      removeEventListenerSpy.mockRestore();
    });
  });

  describe("basic functionality", () => {
    it("fetches projects on mount using cross-node endpoint", async () => {
      const mockProjects: ProjectInfoWithSource[] = [
        {
          id: "proj_001",
          name: "Test Project",
          path: "/test/path",
          status: "active",
          isolationMode: "in-process",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      mockFetchProjectsAcrossNodes.mockResolvedValueOnce(mockProjects);

      const { result } = renderHook(() => useProjects());

      await act(async () => {
        await flushPromises();
      });

      expect(result.current.loading).toBe(false);
      expect(result.current.projects).toHaveLength(1);
      expect(result.current.projects[0].name).toBe("Test Project");
    });

    it("handles errors gracefully", async () => {
      mockFetchProjectsAcrossNodes.mockRejectedValueOnce(new Error("Failed to fetch"));

      const { result } = renderHook(() => useProjects());

      await act(async () => {
        await flushPromises();
      });

      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBe("Failed to fetch");
    });

    it("register adds project optimistically", async () => {
      const newProject: ProjectInfo = {
        id: "proj_new",
        name: "New Project",
        path: "/new/path",
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      mockFetchProjectsAcrossNodes.mockResolvedValueOnce([]);
      mockRegisterProject.mockResolvedValueOnce(newProject);

      const { result } = renderHook(() => useProjects());

      await act(async () => {
        await flushPromises();
      });

      expect(result.current.projects).toHaveLength(0);

      await act(async () => {
        await result.current.register({ name: "New Project", path: "/new/path" });
      });

      expect(result.current.projects).toHaveLength(1);
      expect(result.current.projects[0].id).toBe("proj_new");
    });

    it("unregister removes project optimistically", async () => {
      const mockProjects: ProjectInfoWithSource[] = [
        {
          id: "proj_001",
          name: "Test Project",
          path: "/test/path",
          status: "active",
          isolationMode: "in-process",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      mockFetchProjectsAcrossNodes.mockResolvedValueOnce(mockProjects);
      mockUnregisterProject.mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useProjects());

      await act(async () => {
        await flushPromises();
      });

      expect(result.current.projects).toHaveLength(1);

      await act(async () => {
        await result.current.unregister("proj_001");
      });

      expect(result.current.projects).toHaveLength(0);
    });

    it("update modifies project optimistically", async () => {
      const mockProjects: ProjectInfoWithSource[] = [
        {
          id: "proj_001",
          name: "Test Project",
          path: "/test/path",
          status: "active",
          isolationMode: "in-process",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      const updatedProject: ProjectInfo = {
        ...mockProjects[0],
        name: "Updated Name",
      };
      mockFetchProjectsAcrossNodes.mockResolvedValueOnce(mockProjects);
      mockUpdateProject.mockResolvedValueOnce(updatedProject);

      const { result } = renderHook(() => useProjects());

      await act(async () => {
        await flushPromises();
      });

      expect(result.current.projects[0].name).toBe("Test Project");

      await act(async () => {
        await result.current.update("proj_001", { name: "Updated Name" });
      });

      expect(result.current.projects[0].name).toBe("Updated Name");
    });

    it("refresh manually refetches projects", async () => {
      const initialProject: ProjectInfoWithSource = {
        id: "proj_001",
        name: "Initial",
        path: "/test/path",
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const refreshedProject: ProjectInfoWithSource = {
        ...initialProject,
        name: "Refreshed",
      };
      mockFetchProjectsAcrossNodes.mockResolvedValueOnce([initialProject]).mockResolvedValueOnce([refreshedProject]);

      const { result } = renderHook(() => useProjects());

      await act(async () => {
        await flushPromises();
      });

      expect(result.current.projects[0].name).toBe("Initial");

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.projects[0].name).toBe("Refreshed");
    });

    it("returns projects with _sourceNodeName from aggregated endpoint", async () => {
      const mockProjects: ProjectInfoWithSource[] = [
        {
          id: "proj_local",
          name: "Local Project",
          path: "/local/path",
          status: "active",
          isolationMode: "in-process",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "proj_remote",
          name: "Remote Project",
          path: "/remote/path",
          status: "active",
          isolationMode: "child-process",
          nodeId: "node_alpha",
          _sourceNodeName: "Alpha Node",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      mockFetchProjectsAcrossNodes.mockResolvedValueOnce(mockProjects);

      const { result } = renderHook(() => useProjects());

      await act(async () => {
        await flushPromises();
      });

      expect(result.current.projects).toHaveLength(2);

      const localProject = result.current.projects.find((p) => p.id === "proj_local");
      expect(localProject?._sourceNodeName).toBeUndefined();
      expect(localProject?.nodeId).toBeUndefined();

      const remoteProject = result.current.projects.find((p) => p.id === "proj_remote");
      expect(remoteProject?._sourceNodeName).toBe("Alpha Node");
      expect(remoteProject?.nodeId).toBe("node_alpha");
    });
  });
});
