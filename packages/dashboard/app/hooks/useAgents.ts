import { useState, useEffect, useCallback, useRef } from "react";
import type { Agent, AgentState, AgentCapability, AgentStats } from "../api";
import { fetchAgents, fetchAgentStats } from "../api";
import { isEphemeralAgent } from "@fusion/core";
import { readCache, SWR_CACHE_KEYS, SWR_DEFAULT_MAX_AGE_MS, writeCache } from "../utils/swrCache";
import { useProjectContextGuard } from "./useProjectContextGuard";
import { getAgentRosterOwner } from "./agent-roster-owner";

interface UseAgentsOptions {
  filterState?: AgentState | "all";
  showSystemAgents?: boolean;
  /*
  FNXC:BoardBootRequestSet 2026-11-08-03:34 (RUFU-493):
  `GET /api/agents` and `GET /api/agents/stats` are background chrome. `App` mounts `useAgents` for
  exactly one consumer - the dismissible capacity-risk banner - and the unbounded board read measured
  22.0 s on the deployed dashboard, so a stats read issued at mount was queued behind, and competing
  with, the payload the operator actually came to read. `enabled` lets a caller say when its own surface
  is reachable. Default `true` leaves every view that mounts this hook to RENDER agent data fetching
  eagerly and unchanged.
  */
  enabled?: boolean;
}

interface AgentFilter {
  state?: AgentState;
  role?: AgentCapability;
  includeEphemeral?: boolean;
}

/*
FNXC:AggregateEndpointHydration 2026-11-11-14:45 (RUFU-591):
The SSE debounce window (250 ms, with the trailing catch-up guarantee) used to live here, per hook
instance - so N mounted consumers meant N parallel roster refreshes per event burst, each forceFresh
redirecting (not joining) the dedupe entry its sibling had just started. The debounce, the single
SSE subscription, and the forceFresh fetch pair now live in ONE shared owner per request variant
(`agent-roster-owner.ts`); this hook retains the owner and applies its snapshots.
*/

/*
FNXC:AggregateEndpointHydration 2026-11-14-12:28 (RUFU-591):
The roster snapshot slot must be keyed by the same request variant the fetch is keyed by, or the
shared-cache half of the fix leaks: `AGENTS:<projectId>` carried whichever variant wrote last, so an
"Show system agents" refresh in the Agents panel left an ephemeral-INCLUSIVE roster in the slot that
`App.tsx` and every other default-variant mount hydrates from on the next open — a roster whose shape
is not the one that consumer asked the server for. Keeping the DEFAULT slot byte-identical (no
suffix) means existing readers, and `clearCache(SWR_CACHE_KEYS.AGENTS)`'s prefix sweep in
DashboardLoader, behave exactly as before; only the ephemeral-inclusive variant moves to its own
sub-slot, so neither variant can overwrite the other's snapshot in either direction.
*/
export function agentsRosterCacheKey(projectId?: string, includeEphemeral = false): string {
  const base = projectId ? `${SWR_CACHE_KEYS.AGENTS}:${projectId}` : SWR_CACHE_KEYS.AGENTS;
  return includeEphemeral ? `${base}:ephemeral` : base;
}

export function useAgents(projectId?: string, options?: UseAgentsOptions) {
  const includeEphemeral = options?.showSystemAgents ?? false;
  const agentsCacheKey = agentsRosterCacheKey(projectId, includeEphemeral);
  const statsCacheKey = projectId ? `${SWR_CACHE_KEYS.AGENT_STATS}:${projectId}` : SWR_CACHE_KEYS.AGENT_STATS;
  const [agents, setAgents] = useState<Agent[]>(() => {
    const cached = readCache<Agent[]>(agentsCacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
    return Array.isArray(cached) ? cached : [];
  });
  const [stats, setStats] = useState<AgentStats | null>(() => {
    const cached = readCache<AgentStats>(statsCacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
    return cached ?? null;
  });
  const [isLoading, setIsLoading] = useState(false);
  const hasCachedHydrationRef = useRef(agents.length > 0 || stats !== null);

  // Generation counters. Each loadAgents/loadStats call gets a monotonically
  // increasing id; only the latest call's response is allowed to write state.
  // This neutralizes two races at once:
  //   (a) poll-vs-mutation: if a slow poll resolves AFTER a forceFresh
  //       mutation refetch, the poll's setAgents is dropped instead of
  //       overwriting fresh post-mutation data.
  //   (b) concurrent forceFresh: if two mutations fire near-simultaneously,
  //       only the second's response updates state regardless of which HTTP
  //       response happens to arrive first (TCP/HTTP ordering is not
  //       guaranteed).
  // With this in place, callers don't need to remember to pass forceFresh
  // for correctness — the gen counter handles stale-response suppression
  // regardless. forceFresh still helps by triggering an actual fresh
  // network request, useful when mutations have already committed and the
  // caller wants the post-mutation snapshot now rather than waiting for the
  // next SSE event.
  const agentsGenRef = useRef(0);
  const statsGenRef = useRef(0);
  /*
  FNXC:ProjectScoping 2026-07-15-20:10:
  Agent snapshots and their SSE-triggered refreshes are scoped to the project
  captured at dispatch, so a stale prior-project response cannot replace B.
  */
  const { capture } = useProjectContextGuard(projectId, "useAgents");

  useEffect(() => {
    /*
    FNXC:ProjectScoping 2026-07-16-00:00:
    Agent cache hydration is keyed by project. On a project switch, clear A's
    snapshot immediately or hydrate only B's cache while B's scoped request runs.
    */
    const cachedAgents = readCache<Agent[]>(agentsCacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
    const cachedStats = readCache<AgentStats>(statsCacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
    const nextAgents = Array.isArray(cachedAgents) ? cachedAgents : [];
    const nextStats = cachedStats ?? null;
    setAgents(nextAgents);
    setStats(nextStats);
    hasCachedHydrationRef.current = nextAgents.length > 0 || nextStats !== null;
    setIsLoading(false);
  }, [agentsCacheKey, statsCacheKey]);

  const applyAgentSnapshot = useCallback((data: Agent[]): Agent[] => {
    // Defensive dedupe: a race between the initial fetch and an SSE refresh
    // (or a backend that returned the same agent twice) would otherwise put
    // duplicate ids into every list rendered from this hook, flooding React
    // with duplicate-key warnings until the dashboard runs out of heap.
    const unique = Array.from(new Map(data.map((a) => [a.id, a])).values());
    setAgents(unique);
    /*
    FNXC:AggregateEndpointHydration 2026-11-14-12:47 (RUFU-591):
    An empty roster never overwrites a populated snapshot in the cache. The shared owner publishes
    whatever a `forceFresh` pair returns, so one transient empty list read by the server (a store
    mid-provision, a scoped read that answered empty) would wipe the only snapshot a later mount
    hydrates from - and while fetches keep answering empty there is no path back to a painted board
    short of a reload. Keeping the previous snapshot is bounded staleness instead: any successful
    non-empty write replaces it, and the mounted surface's live state still updates truthfully here,
    so a genuinely deleted-to-zero roster never keeps lit indicators in the UI. The cache is the
    hydrate source, never the truth of the moment, which is why the guard sits on the write and not
    on `setAgents`.
    */
    const writesEmpty = unique.length === 0;
    if (writesEmpty) {
      const cachedSnapshot = readCache<Agent[]>(agentsCacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
      if (Array.isArray(cachedSnapshot) && cachedSnapshot.length > 0) {
        hasCachedHydrationRef.current = hasCachedHydrationRef.current || unique.length > 0;
        return unique;
      }
    }
    writeCache(agentsCacheKey, unique, { maxBytes: 500_000 });
    hasCachedHydrationRef.current = hasCachedHydrationRef.current || unique.length > 0;
    return unique;
  }, [agentsCacheKey]);

  const loadAgents = useCallback(async (filter?: AgentFilter, opts?: { forceFresh?: boolean }) => {
    const context = capture();
    const gen = ++agentsGenRef.current;
    if (!hasCachedHydrationRef.current) {
      setIsLoading(true);
    }
    try {
      const filterState = options?.filterState;
      const baseFilter = filterState && filterState !== "all" ? { state: filterState } : undefined;
      const mergedFilter = {
        ...baseFilter,
        ...filter,
        includeEphemeral: filter?.includeEphemeral ?? includeEphemeral,
      };
      const data = opts?.forceFresh
        ? await fetchAgents(mergedFilter, projectId, { forceFresh: true })
        : await fetchAgents(mergedFilter, projectId);
      // A newer call superseded us — drop this response so we don't clobber
      // fresher state with stale data.
      if (gen !== agentsGenRef.current || context.isStale()) return;
      applyAgentSnapshot(data);
    } catch (err) {
      console.error("Failed to load agents:", err);
    } finally {
      if (gen === agentsGenRef.current) setIsLoading(false);
    }
  }, [applyAgentSnapshot, capture, projectId, includeEphemeral, options?.filterState]);

  const loadStats = useCallback(async (opts?: { forceFresh?: boolean }) => {
    const context = capture();
    const gen = ++statsGenRef.current;
    try {
      const data = opts?.forceFresh
        ? await fetchAgentStats(projectId, { forceFresh: true })
        : await fetchAgentStats(projectId);
      if (gen !== statsGenRef.current || context.isStale()) return;
      setStats(data);
      writeCache(statsCacheKey, data, { maxBytes: 500_000 });
      hasCachedHydrationRef.current = true;
    } catch (err) {
      console.error("Failed to load agent stats:", err);
    }
  }, [capture, projectId, statsCacheKey]);

  /*
  FNXC:BoardBootRequestSet 2026-11-08-03:34 (RUFU-493):
  One gate on the mount effect, covering both reads. A disabled caller still gets cached hydration from
  the initializers above, so a surface that later enables itself paints its last known numbers first.
  */
  useEffect(() => {
    if (options?.enabled === false) return;
    void loadAgents();
    void loadStats();
  }, [loadAgents, loadStats, options?.enabled]);

  /*
  FNXC:AggregateEndpointHydration 2026-11-11-14:45 (RUFU-591):
  SSE-driven refresh, previously a per-hook subscription + debounce: every mounted consumer ran its
  own `subscribeSse` and its own 250 ms timer, so one `agent:updated` burst cost one forceFresh
  roster fetch PER COMPONENT (a second forceFresh arriving while a sibling fetch was in flight
  REDIRECTS the dedupe entry instead of joining it). The shared owner keeps one subscription, one
  debounce, and one fetch pair per (projectId, state, includeEphemeral) variant and broadcasts the
  snapshot; this hook keeps its stale-context guard, its generation discipline (a snapshot outranks
  any in-flight response, so it bumps the counters and drops those writes), and its cache write.
  SSE events still fire AFTER the backend commits, so the forceFresh snapshot remains the
  post-mutation view; missed-event recovery (`onReconnect`) is the owner's as before.
  */
  useEffect(() => {
    const context = capture();
    const filterState = options?.filterState;
    const owner = getAgentRosterOwner({
      projectId,
      state: filterState && filterState !== "all" ? filterState : undefined,
      includeEphemeral,
    });
    const release = owner.retain();
    const unsubscribe = owner.subscribe(({ agents: snapshotAgents, stats: snapshotStats }) => {
      if (context.isStale()) return;
      // The snapshot is the freshest view; outrank any in-flight loadAgents/loadStats response.
      agentsGenRef.current += 1;
      statsGenRef.current += 1;
      applyAgentSnapshot(snapshotAgents);
      setStats(snapshotStats);
      writeCache(statsCacheKey, snapshotStats, { maxBytes: 500_000 });
      hasCachedHydrationRef.current = true;
      setIsLoading(false);
    });
    return () => {
      unsubscribe();
      release();
    };
  }, [capture, projectId, options?.filterState, includeEphemeral, applyAgentSnapshot, statsCacheKey]);

  // refreshAgents is the canonical post-mutation refetch entrypoint. It
  // defaults to forceFresh so consumers don't have to remember — anyone
  // calling refreshAgents() after a save/delete gets a fresh round trip,
  // never a stale in-flight pre-mutation read.
  const refreshAgents = useCallback(async () => {
    await Promise.all([
      loadAgents(undefined, { forceFresh: true }),
      loadStats({ forceFresh: true }),
    ]);
  }, [loadAgents, loadStats]);

  const showSystemAgents = options?.showSystemAgents ?? false;
  const activeAgents = agents.filter((agent) => {
    if (agent.state !== "active" && agent.state !== "running") {
      return false;
    }
    return showSystemAgents || !isEphemeralAgent(agent);
  });

  return { agents, activeAgents, stats, isLoading, loadAgents, loadStats, refreshAgents };
}
