import { useState, useEffect, useCallback, useRef } from "react";
import { getErrorMessage } from "@fusion/core";
import { fetchUsageData, type ProviderUsage } from "../api";
import { isVisibilityResumeError, useTabVisibilitySuspension, useVisibilityAwarePoll } from "./visibilitySuspension";

interface UsageDataState {
  providers: ProviderUsage[];
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  hasFetched: boolean;
}

interface UseUsageDataOptions {
  /** Auto-refresh interval in ms (default: 30 seconds) */
  pollInterval?: number;
  /** Whether to auto-refresh (default: true) */
  autoRefresh?: boolean;
  /*
  FNXC:UsageFetchGating 2026-10-02-11:05 (RUFU-493):
  `autoRefresh` gated only the POLL. The initial fetch ran on mount regardless, and `UsageIndicator` is
  rendered with `isOpen={false}` on every dashboard boot — so `GET /api/usage` was fired on every board
  mount even though nobody had opened Usage. Measured on the production dashboard: 61.8s and 81.7s to
  completion, holding two of the four client read slots for over a minute while the board cards waited
  behind it, and the operator runs one tab per project, so a refresh-everything multiplies it.
  `enabled` gates ALL fetching — the initial fetch, the poll, and it aborts a request still in flight when
  the view closes, which is what frees the slot.
  */
  enabled?: boolean;
}

/**
 * Hook for fetching and polling provider usage data.
 * 
 * Features:
 * - Initial fetch on mount
 * - Auto-refresh every 30 seconds when enabled
 * - Manual refresh capability
 * - Loading and error states
 * - Cleanup on unmount
 */
export function useUsageData(options: UseUsageDataOptions = {}) {
  const { pollInterval = 30_000, autoRefresh = true, enabled = true } = options;

  const [state, setState] = useState<UsageDataState>({
    providers: [],
    // A closed Usage view has not started loading; reporting `loading` there renders a spinner for a
    // request that will never be made.
    loading: enabled,
    error: null,
    lastUpdated: null,
    hasFetched: false,
  });

  const abortRef = useRef<AbortController | null>(null);
  const stateRef = useRef(state);
  const visibilitySuspension = useTabVisibilitySuspension();

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const shouldSuppressVisibilityResumeError = useCallback((errorMessage: string): boolean => {
    return stateRef.current.hasFetched && isVisibilityResumeError(errorMessage, visibilitySuspension.wasRecentlyHidden());
  }, [visibilitySuspension]);

  const fetchData = useCallback(async (isManual = false) => {
    // Cancel any in-flight request
    if (abortRef.current) {
      abortRef.current.abort();
    }
    abortRef.current = new AbortController();

    if (isManual) {
      setState((prev) => ({ ...prev, loading: true, error: null }));
    }

    try {
      const { providers } = await fetchUsageData(abortRef.current.signal);
      setState({
        providers,
        loading: false,
        error: null,
        lastUpdated: new Date(),
        hasFetched: true,
      });
    } catch (err) {
      // Don't update state if the request was aborted
      if (err instanceof Error && err.name === "AbortError") return;

      const errorMessage = getErrorMessage(err) || "Failed to fetch usage data";
      if (shouldSuppressVisibilityResumeError(errorMessage)) {
        setState((prev) => ({
          ...prev,
          loading: false,
        }));
        return;
      }

      setState((prev) => ({
        ...prev,
        loading: false,
        error: errorMessage,
        hasFetched: true,
      }));
    }
  }, [shouldSuppressVisibilityResumeError]);

  // Initial fetch — and the fetch that a newly-opened view needs, since mount happened closed.
  useEffect(() => {
    if (!enabled) return;
    fetchData();
  }, [enabled, fetchData]);

  /*
  FNXC:UsageFetchGating 2026-10-02-11:05 (RUFU-493):
  Closing the view must also stop the work already running. `/api/usage` measured 61-82s on the production
  board, so without this abort the read slot stays occupied for a minute after the operator closed Usage —
  in a multi-tab session that is the difference between a queue that drains and one that never does.
  */
  useEffect(() => {
    if (!enabled && abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, [enabled]);

  /*
  FNXC:MobileTabRetention 2026-07-26-11:00:
  Usage auto-refresh is suspended while the document is hidden. Provider usage is a display-only number, and
  a backgrounded page that keeps polling it is treated by iOS Safari/PWA and Chrome Android as a live page
  worth reclaiming — the discard is what produced the full white-splash reload on return. The hidden ->
  visible edge refreshes once so the returning operator sees current usage.
  */
  const pollUsage = useCallback(() => {
    void fetchData(false);
  }, [fetchData]);
  useVisibilityAwarePoll(pollUsage, pollInterval, { enabled: autoRefresh && enabled });

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, []);

  const refresh = useCallback(() => {
    return fetchData(true);
  }, [fetchData]);

  return {
    providers: state.providers,
    loading: state.loading,
    error: state.error,
    lastUpdated: state.lastUpdated,
    hasFetched: state.hasFetched,
    refresh,
  };
}
