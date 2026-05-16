import { useState, useEffect, useCallback, useRef } from "react";
import type { ProjectInfo } from "../api";
import { fetchGlobalSettings, updateGlobalSettings } from "../api";

// Legacy localStorage key for migration - no longer used as primary storage
const LEGACY_STORAGE_KEY = "kb-dashboard-current-project";
export const CONSECUTIVE_ABSENCE_THRESHOLD = 3;

/**
 * Get the node key used in dashboardCurrentProjectIdByNode.
 * Use "local" for the local node, otherwise use the node ID.
 */
function getNodeKey(nodeId: string | null): string {
  return nodeId ?? "local";
}

export interface UseCurrentProjectResult {
  /** Currently selected project or null if none selected */
  currentProject: ProjectInfo | null;
  /** Set the current project */
  setCurrentProject: (project: ProjectInfo | null) => void;
  /** Clear the current project selection (suppresses auto-select) */
  clearCurrentProject: () => void;
  /** Whether we're still loading from global settings */
  loading: boolean;
}

interface UseCurrentProjectOptions {
  /** Node ID from NodeContext - used to key project selection per node */
  nodeId?: string | null;
}

/**
 * Hook for managing the currently selected project.
 * Persists selection to global settings (server-backed) instead of localStorage.
 * This enables PWA fresh sessions to restore the correct project context.
 */
export function useCurrentProject(
  availableProjects: ProjectInfo[],
  options: UseCurrentProjectOptions = {},
): UseCurrentProjectResult {
  const { nodeId = null } = options;
  const [currentProject, setCurrentProjectState] = useState<ProjectInfo | null>(null);
  const [loading, setLoading] = useState(true);
  // Track if we've hydrated from global settings (vs just initialized)
  const hydratedRef = useRef(false);
  const hydratedNodeKeyRef = useRef<string | null>(null);
  // When true, the user explicitly cleared the project (e.g. clicked "Projects")
  // and we should not auto-select until they pick one manually.
  const explicitlyClearedRef = useRef(false);
  // Cache of current settings to avoid repeated fetches
  const settingsCacheRef = useRef<Record<string, string> | null>(null);
  // Consecutive poll cycles where current project is missing from availableProjects
  const absentCountRef = useRef(0);
  // Consecutive poll cycles confirming auto-default is safe when selection is null
  const autoDefaultCountRef = useRef(0);

  const nodeKey = getNodeKey(nodeId);

  const pickFallbackProject = useCallback((projects: ProjectInfo[]): ProjectInfo | null => {
    return projects.find((p) => p.status === "active") || projects[0] || null;
  }, []);

  const setListDrivenSelection = useCallback((project: ProjectInfo | null) => {
    absentCountRef.current = 0;
    autoDefaultCountRef.current = 0;
    setCurrentProjectState(project);
  }, []);

  // Load from global settings once per node key
  useEffect(() => {
    let cancelled = false;

    if (hydratedNodeKeyRef.current !== nodeKey) {
      hydratedNodeKeyRef.current = null;
      hydratedRef.current = false;
    }

    if (hydratedRef.current && hydratedNodeKeyRef.current === nodeKey) {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);

    async function loadFromGlobalSettings() {
      try {
        const settings = await fetchGlobalSettings();

        if (cancelled) return;

        // Build cache from settings
        settingsCacheRef.current = settings.dashboardCurrentProjectIdByNode ?? {};

        const savedProjectId = settingsCacheRef.current[nodeKey];
        if (savedProjectId) {
          // Try to find the saved project in available projects
          const found = availableProjects.find((p) => p.id === savedProjectId);
          if (found) {
            autoDefaultCountRef.current = 0;
            setCurrentProjectState(found);
          }
          // If project not found, we'll handle in the validation effect
          // (project may still be loading or was unregistered)
        }

        // Also migrate legacy localStorage if no global settings entry exists
        if (!savedProjectId) {
          try {
            const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
            if (legacy) {
              const parsed = JSON.parse(legacy) as ProjectInfo;
              if (parsed?.id) {
                // Check if project still exists
                const exists = availableProjects.some((p) => p.id === parsed.id);
                if (exists) {
                  autoDefaultCountRef.current = 0;
                  setCurrentProjectState(parsed);
                  // Migrate to global settings
                  settingsCacheRef.current = { ...settingsCacheRef.current, [nodeKey]: parsed.id };
                  await updateGlobalSettings({
                    dashboardCurrentProjectIdByNode: settingsCacheRef.current,
                  }).catch(() => {
                    // Non-critical - migration failed, but we have the data in memory
                  });
                }
              }
            }
          } catch {
            // Ignore legacy localStorage errors
          }
        }
      } catch {
        // Global settings fetch failed - this is non-critical
        // We'll fall back to default behavior
      } finally {
        if (!cancelled) {
          hydratedRef.current = true;
          hydratedNodeKeyRef.current = nodeKey;
          setLoading(false);
        }
      }
    }

    void loadFromGlobalSettings();

    return () => {
      cancelled = true;
    };
  }, [nodeKey]);

  // Reset absence tracking when selection changes
  useEffect(() => {
    absentCountRef.current = 0;
    autoDefaultCountRef.current = 0;
  }, [currentProject?.id]);

  // Validate project still exists and persist to global settings
  useEffect(() => {
    if (loading) return;

    if (currentProject) {
      autoDefaultCountRef.current = 0;
      // Validate project still exists in available projects
      const stillExists = availableProjects.some((p) => p.id === currentProject.id);
      if (stillExists) {
        absentCountRef.current = 0;
      } else if (availableProjects.length === 0) {
        // Likely a transient total poll failure; keep current selection
        absentCountRef.current = 0;
      } else {
        absentCountRef.current += 1;
        // Keep threshold-based tolerance: 1-2 missing polls are treated as transient list-shrink drops.
        if (absentCountRef.current >= CONSECUTIVE_ABSENCE_THRESHOLD) {
          // Project was sustainably absent - fallback through shared list-driven selection reset.
          setListDrivenSelection(pickFallbackProject(availableProjects));
        }
        return;
      }

      // Persist to global settings
      const newCache = { ...settingsCacheRef.current, [nodeKey]: currentProject.id };
      settingsCacheRef.current = newCache;
      updateGlobalSettings({ dashboardCurrentProjectIdByNode: newCache }).catch(() => {
        // Non-critical - persistence failed
      });
    } else {
      absentCountRef.current = 0;
      if (availableProjects.length === 0) {
        autoDefaultCountRef.current = 0;
        return;
      }
      if (!explicitlyClearedRef.current) {
        const savedProjectId = settingsCacheRef.current?.[nodeKey];
        if (savedProjectId) {
          const savedProject = availableProjects.find((p) => p.id === savedProjectId) ?? null;
          if (savedProject) {
            autoDefaultCountRef.current = 0;
            setListDrivenSelection(savedProject);
            return;
          }
        }

        autoDefaultCountRef.current += 1;
        if (autoDefaultCountRef.current >= CONSECUTIVE_ABSENCE_THRESHOLD) {
          autoDefaultCountRef.current = 0;
          // No selection but projects available - default to first active
          // after consecutive poll confirmation.
          setListDrivenSelection(pickFallbackProject(availableProjects));
        }
      }
    }
  }, [
    currentProject,
    availableProjects,
    loading,
    nodeKey,
    pickFallbackProject,
    setListDrivenSelection,
  ]);

  const setCurrentProject = useCallback(
    (project: ProjectInfo | null) => {
      explicitlyClearedRef.current = false;
      absentCountRef.current = 0;
      autoDefaultCountRef.current = 0;
      setCurrentProjectState(project);

      if (project) {
        const newCache = { ...settingsCacheRef.current, [nodeKey]: project.id };
        settingsCacheRef.current = newCache;
        updateGlobalSettings({ dashboardCurrentProjectIdByNode: newCache }).catch(() => {
          // Non-critical - persistence failed
        });
      }
    },
    [nodeKey],
  );

  const clearCurrentProject = useCallback(() => {
    explicitlyClearedRef.current = true;
    absentCountRef.current = 0;
    autoDefaultCountRef.current = 0;
    setCurrentProjectState(null);

    // Remove from cache and persist
    const newCache = { ...settingsCacheRef.current };
    delete newCache[nodeKey];
    settingsCacheRef.current = newCache;
    updateGlobalSettings({ dashboardCurrentProjectIdByNode: newCache }).catch(() => {
      // Non-critical - persistence failed
    });
  }, [nodeKey]);

  return {
    currentProject,
    setCurrentProject,
    clearCurrentProject,
    loading,
  };
}
