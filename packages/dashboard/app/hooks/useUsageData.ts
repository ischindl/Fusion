import { useState, useEffect, useCallback, useRef } from "react";
import { getErrorMessage } from "@fusion/core";
import { fetchUsageData, type ProviderUsage } from "../api";
import { readCache, readCacheSavedAt, writeCache, SWR_CACHE_KEYS } from "../utils/swrCache";
import { isVisibilityResumeError, useTabVisibilitySuspension, useVisibilityAwarePoll } from "./visibilitySuspension";

/*
FNXC:UsageFetchGating 2026-11-08-03:34 (RUFU-493):
A snapshot TTL so one open -> close -> open cycle is ONE read, not two.

The gate added above keeps `/api/usage` off the board mount entirely, but the surface itself still
re-read the endpoint every single time it was opened, and that endpoint measured 61.8 s / 81.7 s on the
deployed board. Usage windows roll hourly, so five minutes of staleness costs the operator nothing they
can see, while a re-read on every open turns a 60-second endpoint into a per-click cost in a session
where the operator checks usage repeatedly.

The manual Refresh button (`refreshNow()` below) bypasses the window: an operator who explicitly asks
for the current numbers gets a network read. The window only suppresses the reads nobody asked for.
*/
export const USAGE_SNAPSHOT_MAX_AGE_MS = 5 * 60_000;

interface UsageDataState {
  providers: ProviderUsage[];
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  hasFetched: boolean;
}

/** A snapshot read out of the session cache, with the stamp the envelope already carries. */
function readUsageSnapshot(): { providers: ProviderUsage[]; savedAt: number } | null {
  const providers = readCache<ProviderUsage[]>(SWR_CACHE_KEYS.USAGE, { maxAgeMs: USAGE_SNAPSHOT_MAX_AGE_MS });
  if (!Array.isArray(providers)) return null;
  const savedAt = readCacheSavedAt(SWR_CACHE_KEYS.USAGE, { maxAgeMs: USAGE_SNAPSHOT_MAX_AGE_MS }) ?? Date.now();
  return { providers, savedAt };
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

  const [state, setState] = useState<UsageDataState>(() => {
    // A reopened view inside the snapshot window hydrates synchronously: no spinner for a number
    // this session already fetched, and no second read of a 61-82 s endpoint.
    const snapshot = enabled ? readUsageSnapshot() : null;
    return {
      providers: snapshot?.providers ?? [],
      // A closed Usage view has not started loading; reporting `loading` there renders a spinner for a
      // request that will never be made.
      loading: enabled && snapshot === null,
      error: null,
      lastUpdated: snapshot ? new Date(snapshot.savedAt) : null,
      hasFetched: snapshot !== null,
    };
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

  const fetchData = useCallback(async (options: { manual?: boolean; bypassSnapshot?: boolean } = {}) => {
    const { manual = false, bypassSnapshot = false } = options;

    /*
    FNXC:UsageFetchGating 2026-11-08-03:34 (RUFU-493):
    `UsageIndicator` fires a refresh on the closed -> open transition IN ADDITION to the hook's own
    read, so ONE open cost TWO reads of a 61-82 s endpoint. Both now ask the question the snapshot
    already answers: is this session's number young enough to show? Only the Refresh button bypasses it.
    */
    if (!bypassSnapshot) {
      const snapshot = readUsageSnapshot();
      if (snapshot) {
        setState((prev) => ({
          ...prev,
          providers: snapshot.providers,
          loading: false,
          error: null,
          lastUpdated: new Date(snapshot.savedAt),
          hasFetched: true,
        }));
        return;
      }
    }

    // Cancel any in-flight request
    if (abortRef.current) {
      abortRef.current.abort();
    }
    abortRef.current = new AbortController();

    if (manual) {
      setState((prev) => ({ ...prev, loading: true, error: null }));
    }

    try {
      const { providers } = await fetchUsageData(abortRef.current.signal);
      writeCache(SWR_CACHE_KEYS.USAGE, providers, { maxBytes: 500_000 });
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
  // A snapshot younger than `USAGE_SNAPSHOT_MAX_AGE_MS` answers that open without a network read
  // (`fetchData` consults it before dispatching, so both the open transition and the mount agree).
  useEffect(() => {
    if (!enabled) return;
    void fetchData();
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
    /*
    FNXC:UsageFetchGating 2026-11-08-03:34 (RUFU-493): the poll bypasses the snapshot on purpose. It
    runs only while the view is OPEN, where the operator is watching live numbers; the snapshot gates
    the reads nobody asked for (a mount, an open), never the ones they are looking at.
    */
    void fetchData({ bypassSnapshot: true });
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

  /*
  FNXC:UsageFetchGating 2026-11-08-03:34 (RUFU-493):
  Two entrypoints, because the two callers want different things. `refresh()` means "make sure this view
  has data" and is what the open transition calls — inside the snapshot window it costs nothing.
  `refreshNow()` means "the operator pressed Refresh" and always pays the network read. Collapsing the
  two is exactly how a 61-82 s endpoint ends up on every click.
  */
  const refresh = useCallback(() => {
    return fetchData({ manual: true });
  }, [fetchData]);

  const refreshNow = useCallback(() => {
    return fetchData({ manual: true, bypassSnapshot: true });
  }, [fetchData]);

  return {
    providers: state.providers,
    loading: state.loading,
    error: state.error,
    lastUpdated: state.lastUpdated,
    hasFetched: state.hasFetched,
    refresh,
    refreshNow,
  };
}
