import type { Agent, AgentState, AgentStats } from "@fusion/core";
import { fetchAgents, fetchAgentStats } from "../api";
import { subscribeSse } from "../sse-bus";

/*
FNXC:AggregateEndpointHydration 2026-11-11-14:45 (RUFU-591):
Every mounted `useAgents` consumer (App's capacity banner, FleetDashboardView, AgentsView) used to run
its OWN SSE subscription and its OWN 250 ms debounce, so one `agent:updated` burst refreshed the
identical roster once PER COMPONENT — each forceFresh arriving while a sibling's fetch was still
in-flight redirecting (not joining) the dedupe entry, so N components cost N full `GET /api/agents`
round trips per interval. The server side of that endpoint just got one shared AgentStore and a
grouped SQL aggregate; the client must not multiply it again.

This module is the single roster owner per REQUEST VARIANT: the cache key is
`(projectId, state filter, includeEphemeral)` because each component's server-side filter is part of
the request identity — serving one `includeEphemeral` superset roster to both variants would change
what each component displays. Within one variant the owner holds:
  - exactly ONE `subscribeSse` registration (N mounts retain/refcount it),
  - exactly ONE debounce timer with the same trailing-catch-up guarantee the per-hook effect had
    (at most 2 fetches per burst: the debounced fetch plus one trailing refresh for events that
    arrived while it was in flight),
  - exactly ONE fetch pair (`GET /api/agents` + `GET /api/agents/stats`, forceFresh as before),
    whose result is broadcast to every retained listener.

Direct per-hook paths (mount load, `refreshAgents` after a mutation) deliberately do NOT route
through here: a post-mutation refetch must not wait behind another variant's debounce window, and
the api-layer dedupe already coalesces concurrent identical requests with forceFresh redirection.
Sharing happens on the EVENT-TRIGGERED refresh path, which is where "one per component" was the bug.
*/

const SSE_REFRESH_DEBOUNCE_MS = 250;

export interface AgentRosterSnapshot {
  agents: Agent[];
  stats: AgentStats;
}

export interface AgentRosterVariant {
  projectId?: string;
  /** The `state` query filter the variant's consumers request (undefined = no state filter). */
  state?: string;
  includeEphemeral: boolean;
}

interface RosterOwner {
  retain(): () => void;
  subscribe(listener: (snapshot: AgentRosterSnapshot) => void): () => void;
}

// Owners are stored in their mutable form: the test seam below and `getAgentRosterOwner` both need
// the lifecycle half (`disposeForTests`) that the consumer-facing `RosterOwner` interface hides.
const owners = new Map<string, MutableRosterOwner>();

export function agentRosterOwnerKey(variant: AgentRosterVariant): string {
  return `${variant.projectId ?? ""}|${variant.state ?? ""}|${variant.includeEphemeral ? "eph" : "core"}`;
}

interface MutableRosterOwner extends RosterOwner {
  disposeForTests?: () => void;
}

/** Test seam: the registry is module-level state, exactly like the dedupe map it replaces per-variant. */
export function resetAgentRosterOwnersForTests(): void {
  for (const owner of owners.values()) {
    owner.disposeForTests?.();
  }
  owners.clear();
}

function createOwner(variant: AgentRosterVariant): MutableRosterOwner {
  const key = agentRosterOwnerKey(variant);
  const listeners = new Set<(snapshot: AgentRosterSnapshot) => void>();
  let refCount = 0;
  let disposed = false;
  let unsubscribeSse: (() => void) | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let fetchInProgress = false;
  let pendingDuringFetch = false;

  const notify = (snapshot: AgentRosterSnapshot): void => {
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // One broken consumer must not strand the shared roster for the others.
      }
    }
  };

  const fire = async (): Promise<void> => {
    fetchInProgress = true;
    pendingDuringFetch = false;
    try {
      const [agents, stats] = await Promise.all([
        fetchAgents(
          {
            ...(variant.state ? { state: variant.state as AgentState } : {}),
            includeEphemeral: variant.includeEphemeral,
          },
          variant.projectId,
          { forceFresh: true },
        ),
        fetchAgentStats(variant.projectId, { forceFresh: true }),
      ]);
      notify({ agents, stats });
    } catch (err) {
      // A failed shared refresh must not reject into every consumer; the hooks keep their last
      // snapshot (same degradation each per-hook catch had before).
      console.error("Failed to refresh shared agent roster:", err);
    } finally {
      fetchInProgress = false;
      if (pendingDuringFetch) {
        // Events arrived while the fetch was in flight - one trailing catch-up, debounced so a
        // continuing burst still coalesces. Identical guarantee to the old per-hook effect.
        schedule();
      }
    }
  };

  const schedule = (): void => {
    if (disposed || debounceTimer || fetchInProgress) {
      if (fetchInProgress) pendingDuringFetch = true;
      return;
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void fire();
    }, SSE_REFRESH_DEBOUNCE_MS);
  };

  const onEvent = (): void => {
    // A released owner never re-arms: the multiplexer stops dispatching after unsubscribe,
    // and a stale handler reference must not resurrect the roster loop either way.
    if (disposed) return;
    if (fetchInProgress) {
      pendingDuringFetch = true;
      return;
    }
    schedule();
  };

  const ensureSse = (): void => {
    if (unsubscribeSse) return;
    const query = variant.projectId ? `?projectId=${encodeURIComponent(variant.projectId)}` : "";
    unsubscribeSse = subscribeSse(`/api/events${query}`, {
      onReconnect: onEvent,
      events: {
        "agent:created": onEvent,
        "agent:updated": onEvent,
        "agent:deleted": onEvent,
        "agent:stateChanged": onEvent,
        "approval:requested": onEvent,
        "approval:updated": onEvent,
        "approval:decided": onEvent,
      },
    });
  };

  const release = (): void => {
    refCount -= 1;
    if (refCount > 0) return;
    disposed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    pendingDuringFetch = false;
    unsubscribeSse?.();
    unsubscribeSse = null;
    owners.delete(key);
  };

  return {
    retain(): () => void {
      refCount += 1;
      if (refCount === 1) ensureSse();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
      };
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    disposeForTests(): void {
      if (debounceTimer) clearTimeout(debounceTimer);
      unsubscribeSse?.();
      unsubscribeSse = null;
    },
  };
}

/**
 * The single owner for a request variant. Every `useAgents` mount with the same
 * (projectId, state, includeEphemeral) shares its subscription, debounce, and fetch; different
 * variants keep separate owners because they are genuinely different server-side filters.
 */
export function getAgentRosterOwner(variant: AgentRosterVariant): RosterOwner {
  const key = agentRosterOwnerKey(variant);
  let owner = owners.get(key);
  if (!owner) {
    owner = createOwner(variant);
    owners.set(key, owner);
  }
  return owner;
}
