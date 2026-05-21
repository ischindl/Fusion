import { useCallback, useEffect, useRef, useState } from "react";
import type { NodeMeshState } from "@fusion/core";
import { fetchMeshState } from "../api";
import { recordResumeEvent } from "../utils/resumeInstrumentation";

const POLL_INTERVAL_MS = 10000;
const VISIBILITY_REFRESH_DEBOUNCE_MS = 1000;

export interface UseMeshStateResult {
  meshState: NodeMeshState[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useMeshState(): UseMeshStateResult {
  const [meshState, setMeshState] = useState<NodeMeshState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastVisibilityRefreshRef = useRef<number>(0);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchMeshState();
      setMeshState(data.nodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch mesh state");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const data = await fetchMeshState();
        if (!cancelled) {
          setMeshState(data.nodes);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to fetch mesh state");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      const timeSinceLastRefresh = now - lastVisibilityRefreshRef.current;
      if (timeSinceLastRefresh < VISIBILITY_REFRESH_DEBOUNCE_MS) {
        recordResumeEvent({
          view: "useMeshState",
          trigger: "visibility",
          projectId: undefined,
          replayAttempted: false,
          reason: "debounce-skipped",
          detail: { timeSinceLastRefreshMs: timeSinceLastRefresh },
        });
        return;
      }
      lastVisibilityRefreshRef.current = now;
      recordResumeEvent({
        view: "useMeshState",
        trigger: "visibility",
        projectId: undefined,
        replayAttempted: false,
        reason: "debounced-refresh",
      });
      void refresh();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refresh]);

  useEffect(() => {
    if (loading) return;
    intervalRef.current = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [loading, refresh]);

  return { meshState, loading, error, refresh };
}
