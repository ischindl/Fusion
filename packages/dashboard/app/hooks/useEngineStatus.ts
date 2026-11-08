import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchEngineStatus, startEngine, type EngineStatusResponse } from "../api";
import { useVisibilityAwarePoll } from "./visibilitySuspension";

const POLL_INTERVAL_MS = 10000;

const DISCONNECTED_UNREACHABLE_STATUS: EngineStatusResponse = {
  connected: false,
  starting: false,
  canStart: false,
  reason: "unreachable",
};

export interface UseEngineStatusResult {
  status: EngineStatusResponse | null;
  loading: boolean;
  error: string | null;
  canStart: boolean;
  starting: boolean;
  /** A paused project can be resumed; distinct from `canStart` because resuming is another action. */
  canResume: boolean;
  refetch: () => Promise<void>;
  start: () => Promise<void>;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/*
 * FNXC:EngineStatusBanner 2026-06-22-00:00:
 * The banner must never leave the board silently inert. Poll while the current project is disconnected, stop once connected to avoid steady-state traffic, and fold local Start engine clicks into `starting` so the button cannot be double-triggered before the server reports its transient starting state.
 */
export function useEngineStatus(projectId?: string): UseEngineStatusResult {
  const [status, setStatus] = useState<EngineStatusResponse | null>(null);
  const [loading, setLoading] = useState(Boolean(projectId));
  const [error, setError] = useState<string | null>(null);
  const [startInFlight, setStartInFlight] = useState(false);
  const requestIdRef = useRef(0);

  const refetch = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if (!projectId) {
      setStatus(null);
      setLoading(false);
      setStartInFlight(false);
      return;
    }

    setLoading(true);
    try {
      const nextStatus = await fetchEngineStatus(projectId);
      if (requestIdRef.current !== requestId) return;
      setStatus(nextStatus);
      if (nextStatus.connected) {
        setStartInFlight(false);
      }
    } catch {
      if (requestIdRef.current !== requestId) return;
      setStatus({ ...DISCONNECTED_UNREACHABLE_STATUS, projectId });
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [projectId]);

  const start = useCallback(async () => {
    if (!projectId) return;

    setStartInFlight(true);
    setError(null);
    try {
      const startedStatus = await startEngine(projectId);
      setStatus(startedStatus);
      await refetch();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setStartInFlight(false);
    }
  }, [projectId, refetch]);

  useEffect(() => {
    setStatus(null);
    setError(null);
    setStartInFlight(false);
    void refetch();
  }, [refetch]);

  /*
  FNXC:MobileTabRetention 2026-07-26-10:34:
  The "engine not yet connected" retry poll is suspended while the tab is hidden. Nothing observes engine
  connectivity while the page is backgrounded, and a page that keeps fetching is exactly what iOS/Chrome
  Android discard; the hidden -> visible edge re-checks once so a reconnected engine is reflected on return.
  */
  useVisibilityAwarePoll(refetch, POLL_INTERVAL_MS, { enabled: Boolean(projectId) && !status?.connected });

  return useMemo(() => ({
    status,
    loading,
    error,
    /*
    FNXC:EngineStatusTruth 2026-11-07-13:55 (RUFU-496):
    The optimistic click state used to add `starting` on top of a server payload that still said
    `canStart: true`, which is the exact contradictory triple this task exists to make impossible -
    it just moved from the server into the browser. The in-flight click now WITHDRAWS the offer to
    start instead of only adding a spinner, so the double-click guard keeps working while the panel
    can never render "starting and free to start" at the same instant.
    */
    canStart: Boolean(status?.canStart) && !startInFlight,
    canResume: Boolean(status?.canResume) && !startInFlight,
    starting: Boolean(status?.starting) || startInFlight,
    refetch,
    start,
  }), [error, loading, refetch, start, startInFlight, status]);
}
