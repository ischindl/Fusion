import { useState, useEffect, useCallback, useRef } from "react";
import type { ProjectInfo } from "../api";
import { fetchGlobalSettings, updateGlobalSettings } from "../api";
import { getProjectIdFromUrl } from "../utils/projectUrlState";
import { readCache, SWR_CACHE_KEYS, SWR_LONG_MAX_AGE_MS, writeCache } from "../utils/swrCache";

// Legacy localStorage key for migration - no longer used as primary storage
const LEGACY_STORAGE_KEY = "kb-dashboard-current-project";
export const CONSECUTIVE_ABSENCE_THRESHOLD = 3;

function getNodeKey(nodeId: string | null): string {
  return nodeId ?? "local";
}

export interface UseCurrentProjectResult {
  currentProject: ProjectInfo | null;
  setCurrentProject: (project: ProjectInfo | null) => void;
  clearCurrentProject: () => void;
  loading: boolean;
}

interface UseCurrentProjectOptions {
  nodeId?: string | null;
  projectsLoading?: boolean;
}

export function useCurrentProject(
  availableProjects: ProjectInfo[],
  options: UseCurrentProjectOptions = {},
): UseCurrentProjectResult {
  const { nodeId = null, projectsLoading = false } = options;
  const urlProjectId = getProjectIdFromUrl();
  const urlProject = urlProjectId
    ? availableProjects.find((project) => project.id === urlProjectId) ?? null
    : null;
  const cachedProjectId = readCache<string>(SWR_CACHE_KEYS.CURRENT_PROJECT_ID, { maxAgeMs: SWR_LONG_MAX_AGE_MS });
  const cachedProject =
    urlProject ??
    (typeof cachedProjectId === "string" && cachedProjectId.length > 0
      ? availableProjects.find((project) => project.id === cachedProjectId) ?? null
      : null);

  const [currentProject, setCurrentProjectState] = useState<ProjectInfo | null>(cachedProject);
  const [loading, setLoading] = useState(() => {
    if (urlProjectId) {
      return projectsLoading || (availableProjects.length === 0 && !urlProject);
    }
    return cachedProject === null;
  });
  const hydratedRef = useRef(false);
  const hydratedNodeKeyRef = useRef<string | null>(null);
  const explicitlyClearedRef = useRef(false);
  const settingsCacheRef = useRef<Record<string, string> | null>(null);
  const absentCountRef = useRef(0);
  const autoDefaultCountRef = useRef(0);

  const nodeKey = getNodeKey(nodeId);

  const persistCurrentProjectId = useCallback((projectId: string | null) => {
    writeCache(SWR_CACHE_KEYS.CURRENT_PROJECT_ID, projectId ?? "");
  }, []);

  /*
  FNXC:DashboardProjectSelection 2026-10-12-15:03:
  Project-list polling creates fresh arrays, so re-persist only a changed node selection.
  The global value remains restore state, but routine poll reconciliation must not create
  settings mutations that contend across tabs or inflate durable audit history.
  */
  const persistGlobalProjectSelection = useCallback(async (projectId: string): Promise<void> => {
    const currentCache = settingsCacheRef.current ?? {};
    if (currentCache[nodeKey] === projectId) return;

    /*
    FNXC:IdleBoardReadCost 2026-11-18-11:20 (RUFU-479): the write is CLAIMED before the first await, and the
    order is load-bearing. Project-list polling hands this hook fresh arrays, which is why the guard above
    exists at all (FNXC:DashboardProjectSelection 2026-10-12): reading the server base made the guard stop
    working, because `settingsCacheRef` only changed after the fetch settled, so every rerender inside that
    window re-passed it and bought its own settings read. Measured here by the poll-rerender case: one
    manual switch turned into six reads. Claiming synchronously keeps the guard closed while the merge read
    is in flight, and the merge below still lets our key win over whatever the server returned.
    */
    const claimed = { ...currentCache, [nodeKey]: projectId };
    settingsCacheRef.current = claimed;

    /*
    FNXC:IdleBoardReadCost 2026-11-18-08:45 (RUFU-479): `dashboardCurrentProjectIdByNode` is a MAP this
    caller writes whole, and it holds one entry per node - so whoever merged the map decides whether the
    OTHER nodes' selections survive. The hydrating read that filled `settingsCacheRef` is now served from a
    short-TTL cache (that is what turned four boot-time settings reads into one), so the write path takes its
    base from the server with `forceFresh` instead of from that snapshot. A failed fresh read degrades to the
    in-memory map - the pre-existing behaviour - rather than skipping the save.
    */
    const serverCache = await fetchGlobalSettings({ forceFresh: true })
      .then((settings) => settings.dashboardCurrentProjectIdByNode ?? {})
      .catch(() => claimed);
    // Our key wins over the server snapshot; only the SIBLING entries come from the freshly-read map.
    const newCache = { ...serverCache, [nodeKey]: projectId };
    settingsCacheRef.current = newCache;
    await updateGlobalSettings({ dashboardCurrentProjectIdByNode: newCache }).catch(() => {
      // Non-critical - persistence failed.
    });
  }, [nodeKey]);

  const pickFallbackProject = useCallback((projects: ProjectInfo[]): ProjectInfo | null => {
    return projects.find((p) => p.status === "active") || projects[0] || null;
  }, []);

  const setListDrivenSelection = useCallback(
    (project: ProjectInfo | null) => {
      absentCountRef.current = 0;
      autoDefaultCountRef.current = 0;
      setCurrentProjectState(project);
      persistCurrentProjectId(project?.id ?? null);
    },
    [persistCurrentProjectId],
  );

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

    if (urlProjectId) {
      const foundFromUrl = availableProjects.find((project) => project.id === urlProjectId) ?? null;
      if (foundFromUrl) {
        explicitlyClearedRef.current = false;
        absentCountRef.current = 0;
        autoDefaultCountRef.current = 0;
        setCurrentProjectState(foundFromUrl);
        persistCurrentProjectId(foundFromUrl.id);
        hydratedRef.current = true;
        hydratedNodeKeyRef.current = nodeKey;
        setLoading(false);
      } else if (!projectsLoading) {
        explicitlyClearedRef.current = true;
        absentCountRef.current = 0;
        autoDefaultCountRef.current = 0;
        setCurrentProjectState(null);
        hydratedRef.current = true;
        hydratedNodeKeyRef.current = nodeKey;
        setLoading(false);
      } else {
        setLoading(true);
      }
      return () => {
        cancelled = true;
      };
    }

    const cacheResolvesToKnownProject =
      typeof cachedProjectId === "string" &&
      cachedProjectId.length > 0 &&
      availableProjects.some((project) => project.id === cachedProjectId);

    if (!cacheResolvesToKnownProject) {
      setLoading(true);
    }

    async function loadFromGlobalSettings() {
      try {
        const settings = await fetchGlobalSettings();

        if (cancelled) return;

        settingsCacheRef.current = settings.dashboardCurrentProjectIdByNode ?? {};

        const savedProjectId = settingsCacheRef.current[nodeKey];
        if (savedProjectId) {
          const found = availableProjects.find((p) => p.id === savedProjectId);
          if (found) {
            autoDefaultCountRef.current = 0;
            setCurrentProjectState(found);
            persistCurrentProjectId(found.id);
          }
        }

        if (!savedProjectId) {
          try {
            const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
            if (legacy) {
              const parsed = JSON.parse(legacy) as ProjectInfo;
              if (parsed?.id) {
                const exists = availableProjects.some((p) => p.id === parsed.id);
                if (exists) {
                  autoDefaultCountRef.current = 0;
                  setCurrentProjectState(parsed);
                  persistCurrentProjectId(parsed.id);
                  await persistGlobalProjectSelection(parsed.id);
                }
              }
            }
          } catch {
            // Ignore legacy localStorage errors.
          }
        }
      } catch {
        // Global settings fetch failed - non-critical.
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
  }, [availableProjects, cachedProjectId, nodeKey, persistCurrentProjectId, persistGlobalProjectSelection, projectsLoading, urlProjectId]);

  useEffect(() => {
    absentCountRef.current = 0;
    autoDefaultCountRef.current = 0;
  }, [currentProject?.id]);

  useEffect(() => {
    if (loading) return;

    if (urlProjectId && !currentProject) {
      return;
    }

    if (currentProject) {
      autoDefaultCountRef.current = 0;
      const stillExists = availableProjects.some((p) => p.id === currentProject.id);
      if (stillExists) {
        absentCountRef.current = 0;
      } else if (availableProjects.length === 0) {
        absentCountRef.current = 0;
      } else {
        absentCountRef.current += 1;
        if (absentCountRef.current >= CONSECUTIVE_ABSENCE_THRESHOLD) {
          const fallbackProject = pickFallbackProject(availableProjects);
          setListDrivenSelection(fallbackProject);
          if (!fallbackProject) {
            persistCurrentProjectId(null);
          }
        }
        return;
      }

      void persistGlobalProjectSelection(currentProject.id);
      persistCurrentProjectId(currentProject.id);
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
          setListDrivenSelection(pickFallbackProject(availableProjects));
        }
      }
    }
  }, [
    availableProjects,
    currentProject,
    loading,
    nodeKey,
    urlProjectId,
    persistCurrentProjectId,
    pickFallbackProject,
    setListDrivenSelection,
    persistGlobalProjectSelection,
  ]);

  const setCurrentProject = useCallback(
    (project: ProjectInfo | null) => {
      explicitlyClearedRef.current = false;
      absentCountRef.current = 0;
      autoDefaultCountRef.current = 0;
      setCurrentProjectState(project);
      persistCurrentProjectId(project?.id ?? null);

      if (project) {
        void persistGlobalProjectSelection(project.id);
      }
    },
    [persistCurrentProjectId, persistGlobalProjectSelection],
  );

  const clearCurrentProject = useCallback(async () => {
    explicitlyClearedRef.current = true;
    absentCountRef.current = 0;
    autoDefaultCountRef.current = 0;
    setCurrentProjectState(null);
    persistCurrentProjectId(null);

    /* Same merge-onto-the-server rule as `persistGlobalProjectSelection`: this deletes ONE key from a map
    that carries every other node's selection, so its base is the server snapshot, not the cached one - and
    for the same reason the claim is published synchronously before the read. */
    const claimedClear = { ...(settingsCacheRef.current ?? {}) };
    delete claimedClear[nodeKey];
    settingsCacheRef.current = claimedClear;

    const serverCache = await fetchGlobalSettings({ forceFresh: true })
      .then((settings) => settings.dashboardCurrentProjectIdByNode ?? {})
      .catch(() => claimedClear);
    const newCache = { ...serverCache };
    delete newCache[nodeKey];
    settingsCacheRef.current = newCache;
    updateGlobalSettings({ dashboardCurrentProjectIdByNode: newCache }).catch(() => {
      // Non-critical - persistence failed.
    });
  }, [nodeKey, persistCurrentProjectId]);

  return {
    currentProject,
    setCurrentProject,
    clearCurrentProject,
    loading,
  };
}
