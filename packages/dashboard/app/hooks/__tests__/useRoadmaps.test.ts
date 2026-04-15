import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useRoadmaps } from "../useRoadmaps";
import * as api from "../../api";

// Mock the API module
vi.mock("../../api", () => ({
  fetchRoadmaps: vi.fn(),
  fetchRoadmap: vi.fn(),
  createRoadmap: vi.fn(),
  updateRoadmap: vi.fn(),
  deleteRoadmap: vi.fn(),
  createRoadmapMilestone: vi.fn(),
  updateRoadmapMilestone: vi.fn(),
  deleteRoadmapMilestone: vi.fn(),
  createRoadmapFeature: vi.fn(),
  updateRoadmapFeature: vi.fn(),
  deleteRoadmapFeature: vi.fn(),
  reorderRoadmapMilestones: vi.fn(),
  reorderRoadmapFeatures: vi.fn(),
  moveRoadmapFeature: vi.fn(),
}));

const mockRoadmaps = [
  {
    id: "RM-001",
    title: "Q2 Roadmap",
    description: "Q2 product roadmap",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "RM-002",
    title: "Q3 Roadmap",
    description: "Q3 product roadmap",
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  },
];

const mockRoadmapHierarchy: import("@fusion/core").RoadmapWithHierarchy = {
  id: "RM-001",
  title: "Q2 Roadmap",
  description: "Q2 product roadmap",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  milestones: [
    {
      id: "RMS-001",
      roadmapId: "RM-001",
      title: "Milestone 1",
      description: "First milestone",
      orderIndex: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      features: [
        {
          id: "RF-001",
          milestoneId: "RMS-001",
          title: "Feature 1",
          description: "First feature",
          orderIndex: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
    {
      id: "RMS-002",
      roadmapId: "RM-001",
      title: "Milestone 2",
      description: "Second milestone",
      orderIndex: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      features: [],
    },
  ],
};

describe("useRoadmaps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.fetchRoadmaps as ReturnType<typeof vi.fn>).mockResolvedValue(mockRoadmaps);
    (api.fetchRoadmap as ReturnType<typeof vi.fn>).mockResolvedValue(mockRoadmapHierarchy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("initializes with empty state and fetches roadmaps on mount", async () => {
    const { result } = renderHook(() => useRoadmaps());

    // Initially loading
    expect(result.current.loading).toBe(true);
    expect(result.current.roadmaps).toEqual([]);
    expect(result.current.selectedRoadmapId).toBeNull();

    // Wait for fetch to complete
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.roadmaps).toEqual(mockRoadmaps);
    expect(api.fetchRoadmaps).toHaveBeenCalledWith(undefined);
  });

  it("fetches roadmaps with projectId when provided", async () => {
    const { result } = renderHook(() => useRoadmaps({ projectId: "proj_abc" }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(api.fetchRoadmaps).toHaveBeenCalledWith("proj_abc");
    expect(result.current.roadmaps).toEqual(mockRoadmaps);
  });

  it("clears selection and refetches when projectId changes", async () => {
    const { result, rerender } = renderHook(
      ({ projectId }: { projectId?: string }) => useRoadmaps({ projectId }),
      { initialProps: { projectId: "proj_abc" } }
    );

    // Select a roadmap
    result.current.selectRoadmap("RM-001");
    await waitFor(() => {
      expect(result.current.selectedRoadmapId).toBe("RM-001");
    });

    // Change project
    rerender({ projectId: "proj_xyz" });

    // Selection should be cleared
    expect(result.current.selectedRoadmapId).toBeNull();
    expect(api.fetchRoadmaps).toHaveBeenLastCalledWith("proj_xyz");
  });

  it("selects a roadmap and fetches its data", async () => {
    const { result } = renderHook(() => useRoadmaps());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    result.current.selectRoadmap("RM-001");

    await waitFor(() => {
      expect(result.current.selectedRoadmapId).toBe("RM-001");
    });

    expect(api.fetchRoadmap).toHaveBeenCalledWith("RM-001", undefined);
    expect(result.current.selectedRoadmap).toEqual(mockRoadmapHierarchy);
    expect(result.current.milestones).toEqual(mockRoadmapHierarchy.milestones);
  });

  it("creates a new roadmap and refreshes the list", async () => {
    const newRoadmap = {
      id: "RM-003",
      title: "New Roadmap",
      description: "A new roadmap",
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    };
    (api.createRoadmap as ReturnType<typeof vi.fn>).mockResolvedValue(newRoadmap);

    const { result } = renderHook(() => useRoadmaps());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const onSuccess = vi.fn();
    await result.current.createRoadmap({ title: "New Roadmap", description: "A new roadmap" }, { onSuccess });

    expect(api.createRoadmap).toHaveBeenCalledWith(
      { title: "New Roadmap", description: "A new roadmap" },
      undefined
    );
    await waitFor(() => {
      expect(result.current.roadmaps).toContainEqual(newRoadmap);
    });
    expect(onSuccess).toHaveBeenCalled();
  });

  it("updates a roadmap and refreshes the list", async () => {
    const updatedRoadmap = { ...mockRoadmaps[0], title: "Updated Title" };
    (api.updateRoadmap as ReturnType<typeof vi.fn>).mockResolvedValue(updatedRoadmap);

    const { result } = renderHook(() => useRoadmaps());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const onSuccess = vi.fn();
    await result.current.updateRoadmap("RM-001", { title: "Updated Title" }, { onSuccess });

    expect(api.updateRoadmap).toHaveBeenCalledWith("RM-001", { title: "Updated Title" }, undefined);
    await waitFor(() => {
      expect(result.current.roadmaps.find((r) => r.id === "RM-001")?.title).toBe("Updated Title");
    });
    expect(onSuccess).toHaveBeenCalled();
  });

  it("deletes a roadmap and removes it from the list", async () => {
    (api.deleteRoadmap as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const { result } = renderHook(() => useRoadmaps());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const onSuccess = vi.fn();
    await result.current.deleteRoadmap("RM-001", { onSuccess });

    expect(api.deleteRoadmap).toHaveBeenCalledWith("RM-001", undefined);
    await waitFor(() => {
      expect(result.current.roadmaps.find((r) => r.id === "RM-001")).toBeUndefined();
    });
    expect(onSuccess).toHaveBeenCalled();
  });

  it("clears selected roadmap when deleting the selected roadmap", async () => {
    (api.deleteRoadmap as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const { result } = renderHook(() => useRoadmaps());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    result.current.selectRoadmap("RM-001");
    await waitFor(() => {
      expect(result.current.selectedRoadmapId).toBe("RM-001");
    });

    await result.current.deleteRoadmap("RM-001");

    await waitFor(() => {
      expect(result.current.selectedRoadmapId).toBeNull();
    });
    expect(result.current.selectedRoadmap).toBeNull();
  });

  it("creates a milestone in the selected roadmap", async () => {
    const newMilestone = {
      id: "RMS-003",
      roadmapId: "RM-001",
      title: "New Milestone",
      description: "A new milestone",
      orderIndex: 2,
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    };
    (api.createRoadmapMilestone as ReturnType<typeof vi.fn>).mockResolvedValue(newMilestone);

    const { result } = renderHook(() => useRoadmaps());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    result.current.selectRoadmap("RM-001");
    await waitFor(() => {
      expect(result.current.selectedRoadmapId).toBe("RM-001");
    });

    const onSuccess = vi.fn();
    await result.current.createMilestone({ title: "New Milestone", description: "A new milestone" }, { onSuccess });

    expect(api.createRoadmapMilestone).toHaveBeenCalledWith(
      "RM-001",
      { title: "New Milestone", description: "A new milestone" },
      undefined
    );
    expect(onSuccess).toHaveBeenCalled();
    // Should trigger refresh
    expect(api.fetchRoadmap).toHaveBeenCalled();
  });

  it("throws error when creating milestone without selected roadmap", async () => {
    const { result } = renderHook(() => useRoadmaps());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const onError = vi.fn();
    await expect(
      result.current.createMilestone({ title: "New Milestone" }, { onError })
    ).rejects.toThrow("No roadmap selected");
    expect(onError).toHaveBeenCalled();
  });

  it("updates a milestone and refreshes", async () => {
    const updatedMilestone = { ...mockRoadmapHierarchy.milestones[0], title: "Updated Milestone" };
    (api.updateRoadmapMilestone as ReturnType<typeof vi.fn>).mockResolvedValue(updatedMilestone);

    const { result } = renderHook(() => useRoadmaps());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    result.current.selectRoadmap("RM-001");
    await waitFor(() => {
      expect(result.current.selectedRoadmapId).toBe("RM-001");
    });

    const onSuccess = vi.fn();
    await result.current.updateMilestone("RMS-001", { title: "Updated Milestone" }, { onSuccess });

    expect(api.updateRoadmapMilestone).toHaveBeenCalledWith("RMS-001", { title: "Updated Milestone" }, undefined);
    expect(onSuccess).toHaveBeenCalled();
    expect(api.fetchRoadmap).toHaveBeenCalled();
  });

  it("deletes a milestone and removes it from state", async () => {
    (api.deleteRoadmapMilestone as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const { result } = renderHook(() => useRoadmaps());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    result.current.selectRoadmap("RM-001");
    await waitFor(() => {
      expect(result.current.selectedRoadmapId).toBe("RM-001");
    });

    const onSuccess = vi.fn();
    await result.current.deleteMilestone("RMS-001", { onSuccess });

    expect(api.deleteRoadmapMilestone).toHaveBeenCalledWith("RMS-001", undefined);
    expect(onSuccess).toHaveBeenCalled();
    expect(api.fetchRoadmap).toHaveBeenCalled();
  });

  it("creates a feature in a milestone", async () => {
    const newFeature = {
      id: "RF-002",
      milestoneId: "RMS-001",
      title: "New Feature",
      description: "A new feature",
      orderIndex: 1,
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    };
    (api.createRoadmapFeature as ReturnType<typeof vi.fn>).mockResolvedValue(newFeature);

    const { result } = renderHook(() => useRoadmaps());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    result.current.selectRoadmap("RM-001");
    await waitFor(() => {
      expect(result.current.selectedRoadmapId).toBe("RM-001");
    });

    const onSuccess = vi.fn();
    await result.current.createFeature("RMS-001", { title: "New Feature", description: "A new feature" }, { onSuccess });

    expect(api.createRoadmapFeature).toHaveBeenCalledWith(
      "RMS-001",
      { title: "New Feature", description: "A new feature" },
      undefined
    );
    expect(onSuccess).toHaveBeenCalled();
    expect(api.fetchRoadmap).toHaveBeenCalled();
  });

  it("updates a feature and refreshes", async () => {
    const updatedFeature = {
      ...mockRoadmapHierarchy.milestones[0].features[0],
      title: "Updated Feature",
    };
    (api.updateRoadmapFeature as ReturnType<typeof vi.fn>).mockResolvedValue(updatedFeature);

    const { result } = renderHook(() => useRoadmaps());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    result.current.selectRoadmap("RM-001");
    await waitFor(() => {
      expect(result.current.selectedRoadmapId).toBe("RM-001");
    });

    const onSuccess = vi.fn();
    await result.current.updateFeature("RF-001", { title: "Updated Feature" }, { onSuccess });

    expect(api.updateRoadmapFeature).toHaveBeenCalledWith("RF-001", { title: "Updated Feature" }, undefined);
    expect(onSuccess).toHaveBeenCalled();
    expect(api.fetchRoadmap).toHaveBeenCalled();
  });

  it("deletes a feature and refreshes", async () => {
    (api.deleteRoadmapFeature as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const { result } = renderHook(() => useRoadmaps());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    result.current.selectRoadmap("RM-001");
    await waitFor(() => {
      expect(result.current.selectedRoadmapId).toBe("RM-001");
    });

    const onSuccess = vi.fn();
    await result.current.deleteFeature("RF-001", { onSuccess });

    expect(api.deleteRoadmapFeature).toHaveBeenCalledWith("RF-001", undefined);
    expect(onSuccess).toHaveBeenCalled();
    expect(api.fetchRoadmap).toHaveBeenCalled();
  });

  it("surfaces error state when fetch fails", async () => {
    const fetchError = new Error("Network error");
    (api.fetchRoadmaps as ReturnType<typeof vi.fn>).mockRejectedValue(fetchError);

    const { result } = renderHook(() => useRoadmaps());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toEqual(fetchError);
  });

  it("calls onError callback when CRUD operation fails", async () => {
    const apiError = new Error("API error");
    (api.createRoadmap as ReturnType<typeof vi.fn>).mockRejectedValue(apiError);

    const { result } = renderHook(() => useRoadmaps());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const onError = vi.fn();
    await expect(
      result.current.createRoadmap({ title: "Test" }, { onError })
    ).rejects.toThrow("API error");
    expect(onError).toHaveBeenCalledWith(apiError);
  });

  it("refreshes roadmaps and selected roadmap", async () => {
    const { result } = renderHook(() => useRoadmaps());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    result.current.selectRoadmap("RM-001");
    await waitFor(() => {
      expect(result.current.selectedRoadmapId).toBe("RM-001");
    });

    await result.current.refresh();

    expect(api.fetchRoadmaps).toHaveBeenCalled();
    expect(api.fetchRoadmap).toHaveBeenCalledWith("RM-001", undefined);
  });

  describe("reorderMilestones", () => {
    it("reorders milestones and refreshes", async () => {
      (api.reorderRoadmapMilestones as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const { result } = renderHook(() => useRoadmaps());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      result.current.selectRoadmap("RM-001");
      await waitFor(() => {
        expect(result.current.selectedRoadmapId).toBe("RM-001");
      });

      // Reorder milestones: swap RMS-001 and RMS-002
      await result.current.reorderMilestones("RM-001", ["RMS-002", "RMS-001"]);

      expect(api.reorderRoadmapMilestones).toHaveBeenCalledWith(
        "RM-001",
        ["RMS-002", "RMS-001"],
        undefined
      );
      // Should refresh to get server state
      expect(api.fetchRoadmap).toHaveBeenCalled();
    });

    it("rolls back on failure and calls onError", async () => {
      const reorderError = new Error("Reorder failed");
      (api.reorderRoadmapMilestones as ReturnType<typeof vi.fn>).mockRejectedValue(reorderError);

      const { result } = renderHook(() => useRoadmaps());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      result.current.selectRoadmap("RM-001");
      await waitFor(() => {
        expect(result.current.selectedRoadmapId).toBe("RM-001");
      });

      const initialMilestones = result.current.milestones;
      const onError = vi.fn();

      try {
        await result.current.reorderMilestones("RM-001", ["RMS-002", "RMS-001"], { onError });
      } catch {
        // Expected to throw
      }

      expect(onError).toHaveBeenCalledWith(reorderError);
      // State should be rolled back
      expect(result.current.milestones).toEqual(initialMilestones);
    });

    it("sends correct payload shape for reorder", async () => {
      (api.reorderRoadmapMilestones as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const { result } = renderHook(() => useRoadmaps());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      result.current.selectRoadmap("RM-001");
      await waitFor(() => {
        expect(result.current.selectedRoadmapId).toBe("RM-001");
      });

      await result.current.reorderMilestones("RM-001", ["RMS-001", "RMS-002"]);

      // Verify the payload shape
      expect(api.reorderRoadmapMilestones).toHaveBeenCalledTimes(1);
      const call = (api.reorderRoadmapMilestones as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe("RM-001");
      expect(Array.isArray(call[1])).toBe(true);
      expect(call[1]).toHaveLength(2);
    });
  });

  describe("reorderFeatures", () => {
    it("reorders features within a milestone", async () => {
      (api.reorderRoadmapFeatures as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const { result } = renderHook(() => useRoadmaps());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      result.current.selectRoadmap("RM-001");
      await waitFor(() => {
        expect(result.current.selectedRoadmapId).toBe("RM-001");
      });

      // Reorder features in RMS-001: already has RF-001 at orderIndex 0
      await result.current.reorderFeatures("RMS-001", ["RF-001"]);

      expect(api.reorderRoadmapFeatures).toHaveBeenCalledWith(
        "RMS-001",
        ["RF-001"],
        undefined
      );
      expect(api.fetchRoadmap).toHaveBeenCalled();
    });

    it("rolls back on failure", async () => {
      const reorderError = new Error("Feature reorder failed");
      (api.reorderRoadmapFeatures as ReturnType<typeof vi.fn>).mockRejectedValue(reorderError);

      const { result } = renderHook(() => useRoadmaps());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      result.current.selectRoadmap("RM-001");
      await waitFor(() => {
        expect(result.current.selectedRoadmapId).toBe("RM-001");
      });

      const initialFeatures = result.current.featuresByMilestoneId["RMS-001"];
      const onError = vi.fn();

      try {
        await result.current.reorderFeatures("RMS-001", ["RF-001"], { onError });
      } catch {
        // Expected to throw
      }

      expect(onError).toHaveBeenCalledWith(reorderError);
      expect(result.current.featuresByMilestoneId["RMS-001"]).toEqual(initialFeatures);
    });
  });

  describe("moveFeature", () => {
    it("moves a feature to a different milestone", async () => {
      (api.moveRoadmapFeature as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const { result } = renderHook(() => useRoadmaps());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      result.current.selectRoadmap("RM-001");
      await waitFor(() => {
        expect(result.current.selectedRoadmapId).toBe("RM-001");
      });

      // Move RF-001 from RMS-001 to RMS-002 at index 0
      await result.current.moveFeature("RF-001", "RMS-002", 0);

      expect(api.moveRoadmapFeature).toHaveBeenCalledWith(
        "RF-001",
        "RMS-002",
        0,
        undefined
      );
      expect(api.fetchRoadmap).toHaveBeenCalled();
    });

    it("rolls back on failure", async () => {
      const moveError = new Error("Move failed");
      (api.moveRoadmapFeature as ReturnType<typeof vi.fn>).mockRejectedValue(moveError);

      const { result } = renderHook(() => useRoadmaps());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      result.current.selectRoadmap("RM-001");
      await waitFor(() => {
        expect(result.current.selectedRoadmapId).toBe("RM-001");
      });

      const initialFeaturesByMilestoneId = result.current.featuresByMilestoneId;
      const onError = vi.fn();

      try {
        await result.current.moveFeature("RF-001", "RMS-002", 0, { onError });
      } catch {
        // Expected to throw
      }

      expect(onError).toHaveBeenCalledWith(moveError);
      expect(result.current.featuresByMilestoneId).toEqual(initialFeaturesByMilestoneId);
    });

    it("throws when feature not found", async () => {
      const { result } = renderHook(() => useRoadmaps());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      result.current.selectRoadmap("RM-001");
      await waitFor(() => {
        expect(result.current.selectedRoadmapId).toBe("RM-001");
      });

      const onError = vi.fn();
      await expect(
        result.current.moveFeature("NONEXISTENT", "RMS-002", 0, { onError })
      ).rejects.toThrow("Feature not found");
    });
  });
});
