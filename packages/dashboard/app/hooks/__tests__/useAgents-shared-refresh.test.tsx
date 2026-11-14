/*
FNXC:AggregateEndpointHydration 2026-11-11-14:45 (RUFU-591):
The server-side aggregate swap is worthless if the client multiplies it again - and it did: every
mounted `useAgents` consumer kept its own SSE subscription and its own debounce, so one
`agent:updated` burst cost one forceFresh `GET /api/agents` PER COMPONENT. The shared roster owner
(`app/hooks/agent-roster-owner.ts`) collapses that to ONE subscription, ONE debounce, and ONE fetch
pair per (projectId, state, includeEphemeral) variant.

This file pins the client half through the real transport stack (fetch stub, real api/dedupe layers,
real hooks) - shape only: which paths were requested and how many times. The only clock use is
waiting past the code-owned 250 ms debounce window; nothing asserts a duration.
  - N consumers of one variant share ONE subscribeSse registration;
  - one event burst costs exactly ONE `GET /api/agents` AND exactly ONE `GET /api/agents/stats`
    for the variant (not one pair per component);
  - events arriving during an in-flight refresh still get the one trailing catch-up;
  - a different `includeEphemeral` variant keeps its OWN owner (no superset roster is shared);
  - unmounting one consumer keeps the surviving consumers' refresh path intact;
  - unmounting every consumer releases the subscription and stops refreshes.

FNXC:AggregateEndpointHydration 2026-11-14-12:28 (RUFU-591):
The roster snapshot and the SWR slot that hydrates it are keyed by the SAME variant, so the cache
half is asserted here too: a default-variant refresh must leave the `:ephemeral` slot byte-identical
(and the reverse), because a toggled panel previously overwrote the one shared `AGENTS:<project>`
slot and every other reader hydrated the roster shape the toggle had asked for.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { agentsRosterCacheKey, useAgents } from "../useAgents";
import { resetAgentRosterOwnersForTests } from "../agent-roster-owner";
import { SWR_CACHE_KEYS, clearCache, readCache, writeCache } from "../../utils/swrCache";

interface SseCapture {
  url: string;
  handlers: Record<string, () => void>;
  onReconnect: (() => void) | undefined;
  unsubscribeCalls: number;
}

const sseCapture = {
  subscriptions: [] as SseCapture[],
};

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn((url: string, opts: { events?: Record<string, () => void>; onReconnect?: () => void }) => {
    const entry: SseCapture = {
      url,
      handlers: { ...(opts.events ?? {}) },
      onReconnect: opts.onReconnect,
      unsubscribeCalls: 0,
    };
    sseCapture.subscriptions.push(entry);
    return () => { entry.unsubscribeCalls += 1; };
  }),
}));

/* -- recording transport (mirrors board-boot-request-set.test.tsx) ---------- */

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const AGENT_A = { id: "agent-a", name: "A", role: "executor", state: "idle", totalInputTokens: 0, totalOutputTokens: 0 };
const AGENT_SYSTEM = { id: "agent-system", name: "S", role: "custom", state: "idle", metadata: { ephemeral: true }, totalInputTokens: 0, totalOutputTokens: 0 };
const STATS = { activeCount: 0, assignedTaskCount: 0, completedRuns: 0, failedRuns: 0, successRate: 0, idleNonEphemeralCount: 0, todoTaskCount: 0, totalAgents: 1 };

let recorded: string[] = [];
let gate: Promise<void> | null = null;
/** Per-test override for the roster payload (an empty answer is a case, not a default). */
let rosterOverride: unknown[] | null = null;

function answerFor(path: string): unknown {
  const clean = path.split("?")[0];
  if (clean.endsWith("/agents/stats")) return STATS;
  if (clean.endsWith("/agents")) return rosterOverride ?? [AGENT_A];
  return [];
}

function recordTransport(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    recorded.push(raw);
    if (gate) await gate;
    return jsonResponse(answerFor(raw));
  }) as typeof fetch;
}

// Module-scope consumers (fusion-react/no-nested-component-definitions): a component per render
// would remount the hooks on every parent update; options are passed as primitive props.
function OneConsumer({ showSystem }: { showSystem?: boolean }) {
  useAgents("proj-roster", showSystem ? { showSystemAgents: true } : undefined);
  return null;
}

function ConsumersN({ count, showSystem }: { count: number; showSystem?: boolean }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => <OneConsumer key={index} showSystem={showSystem} />)}
    </>
  );
}

function rosterFetches(): string[] {
  return recorded.filter((path) => /\/api\/agents(\?|$)/.test(path));
}

function statsFetches(): string[] {
  return recorded.filter((path) => /\/api\/agents\/stats/.test(path));
}

function variantFetches(includeEphemeral: boolean): string[] {
  return rosterFetches().filter((path) => {
    const params = new URL(path, "http://dashboard.test").searchParams;
    return (params.get("includeEphemeral") === "true") === includeEphemeral;
  });
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function pastDebounceWindow(): Promise<void> {
  // The owner's debounce window is code-owned (250 ms); wait past it rather than assert it.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
}

beforeEach(() => {
  recorded = [];
  gate = null;
  rosterOverride = null;
  sseCapture.subscriptions.length = 0;
  sessionStorage.clear();
  localStorage.clear();
  clearCache(`${SWR_CACHE_KEYS.AGENTS}:proj-roster`);
  clearCache(`${SWR_CACHE_KEYS.AGENT_STATS}:proj-roster`);
  resetAgentRosterOwnersForTests();
  vi.stubGlobal("fetch", recordTransport());
});

afterEach(() => {
  resetAgentRosterOwnersForTests();
  vi.unstubAllGlobals();
});

describe("shared agent roster owner (RUFU-591 client half)", () => {
  it("N consumers of one variant share ONE SSE subscription", () => {
    const { unmount } = render(<ConsumersN count={3} />);
    expect(sseCapture.subscriptions).toHaveLength(1);
    expect(sseCapture.subscriptions[0].url).toContain("projectId=proj-roster");
    unmount();
  });

  it("an event burst costs exactly one fetchAgents plus one fetchAgentStats for the variant", async () => {
    const { unmount } = render(<ConsumersN count={3} />);
    await flushMicrotasks();
    const beforeRoster = rosterFetches().length;
    const beforeStats = statsFetches().length;
    expect(beforeStats).toBeGreaterThanOrEqual(1);

    const sub = sseCapture.subscriptions[0];
    await act(async () => {
      sub.handlers["agent:updated"]?.();
      sub.handlers["agent:updated"]?.();
      sub.handlers["agent:stateChanged"]?.();
    });
    // ONE roster fetch for the whole burst, despite three mounted consumers...
    await act(async () => {
      await vi.waitFor(() => expect(rosterFetches().length).toBe(beforeRoster + 1), { timeout: 2000 });
    });
    // ...and ONE stats fetch, not one per component either.
    expect(statsFetches().length).toBe(beforeStats + 1);
    unmount();
  });

  it("events arriving during an in-flight refresh still get exactly one trailing catch-up", async () => {
    let releaseGate: () => void = () => {};
    gate = new Promise((resolve) => { releaseGate = resolve; });

    const { unmount } = render(<ConsumersN count={2} />);
    await flushMicrotasks();
    const sub = sseCapture.subscriptions[0];

    await act(async () => {
      sub.handlers["agent:updated"]?.();
    });
    // The debounce window elapses; the shared fetch starts and parks on the gate.
    await pastDebounceWindow();
    const afterFirstBurst = rosterFetches().length;
    expect(afterFirstBurst).toBeGreaterThanOrEqual(1);

    // Two more events land WHILE the fetch is in flight -> they must collapse into ONE
    // trailing refresh once the in-flight fetch settles, never one each.
    await act(async () => {
      sub.handlers["agent:updated"]?.();
      sub.handlers["agent:updated"]?.();
    });
    gate = null;
    releaseGate();
    await flushMicrotasks();
    await act(async () => {
      await vi.waitFor(() => expect(rosterFetches().length).toBe(afterFirstBurst + 1), { timeout: 2000 });
    });
    // And it stays at exactly one trailing refresh.
    await pastDebounceWindow();
    expect(rosterFetches().length).toBe(afterFirstBurst + 1);
    unmount();
  });

  it("different includeEphemeral variants keep their own owner and their own fetches", async () => {
    const core = render(<ConsumersN count={2} />);
    const withEphemeral = render(<ConsumersN count={1} showSystem />);
    await flushMicrotasks();

    expect(sseCapture.subscriptions).toHaveLength(2);

    const coreBefore = variantFetches(false).length;
    const ephemeralBefore = variantFetches(true).length;
    expect(coreBefore).toBeGreaterThanOrEqual(1);
    expect(ephemeralBefore).toBeGreaterThanOrEqual(1);

    // The event arrives on the CORE variant's stream only (subscriptions[0] is core).
    const sub = sseCapture.subscriptions[0];
    await act(async () => {
      sub.handlers["agent:updated"]?.();
    });
    await act(async () => {
      await vi.waitFor(() => expect(variantFetches(false).length).toBe(coreBefore + 1), { timeout: 2000 });
    });
    // No superset roster crosses variants: the ephemeral variant issued no extra fetch.
    expect(variantFetches(true).length).toBe(ephemeralBefore);
    core.unmount();
    withEphemeral.unmount();
  });

  it("unmounting one consumer keeps the surviving consumers' shared refresh working", async () => {
    const pair = render(<ConsumersN count={2} />);
    await flushMicrotasks();
    const sub = sseCapture.subscriptions[0];
    const unsubscribeBefore = sub.unsubscribeCalls;

    // A third consumer joins the same owner and then leaves it: refcounting must not tear the
    // owner down while siblings still hold it.
    const { unmount: unmountThird } = render(<ConsumersN count={1} />);
    await flushMicrotasks();
    unmountThird();
    await flushMicrotasks();

    const before = rosterFetches().length;
    await act(async () => {
      sub.handlers["agent:updated"]?.();
    });
    await act(async () => {
      await vi.waitFor(() => expect(rosterFetches().length).toBe(before + 1), { timeout: 2000 });
    });
    expect(sub.unsubscribeCalls).toBe(unsubscribeBefore);
    pair.unmount();
  });

  it("unmounting every consumer releases the subscription and stops refreshes", async () => {
    const { unmount } = render(<ConsumersN count={2} />);
    await flushMicrotasks();
    const sub = sseCapture.subscriptions[0];
    unmount();
    expect(sub.unsubscribeCalls).toBe(1);

    const before = rosterFetches().length;
    // A late event on the released stream must not schedule any fetch.
    sub.handlers["agent:updated"]?.();
    await pastDebounceWindow();
    expect(rosterFetches().length).toBe(before);
  });
});

/*
FNXC:AggregateEndpointHydration 2026-11-14-12:28 (RUFU-591):
The roster snapshot and the SWR slot that hydrates it carry the SAME variant key. A toggled Agents
panel used to write its ephemeral-inclusive roster into the single `AGENTS:<project>` slot, so the
next default-variant mount hydrated agents it never asked the server for. These cases pin both
directions of the isolation and the default slot's unchanged name.
*/
describe("per-variant roster cache slot (RUFU-591)", () => {
  it("keeps the default slot's key unchanged and gives the ephemeral variant its own slot", () => {
    expect(agentsRosterCacheKey("proj-roster", false)).toBe(`${SWR_CACHE_KEYS.AGENTS}:proj-roster`);
    expect(agentsRosterCacheKey("proj-roster", true)).toBe(`${SWR_CACHE_KEYS.AGENTS}:proj-roster:ephemeral`);
    expect(agentsRosterCacheKey(undefined, false)).toBe(SWR_CACHE_KEYS.AGENTS);
  });

  it("hydrates each variant from its own slot and never writes the other's", async () => {
    writeCache(agentsRosterCacheKey("proj-roster", false), [AGENT_A], { maxBytes: 500_000 });
    writeCache(agentsRosterCacheKey("proj-roster", true), [AGENT_A, AGENT_SYSTEM], { maxBytes: 500_000 });

    // A default-variant mount hydrates the ephemeral-free roster its own slot holds.
    const core = renderHook(() => useAgents("proj-roster"));
    expect(core.result.current.agents.map((agent) => agent.id)).toEqual(["agent-a"]);

    // Its refresh writes its OWN slot only; the ephemeral-inclusive snapshot stays intact.
    await waitFor(() => expect(rosterFetches().length).toBeGreaterThanOrEqual(1));
    await flushMicrotasks();
    const ephemeralSlot = readCache<unknown[]>(agentsRosterCacheKey("proj-roster", true), { maxAgeMs: 60_000 }) ?? [];
    expect(ephemeralSlot.map((agent) => (agent as { id: string }).id)).toEqual(["agent-a", "agent-system"]);

    core.unmount();
  });

  /*
  FNXC:AggregateEndpointHydration 2026-11-14-12:47 (RUFU-591):
  The empty-roster guard. The shared owner publishes whatever a forceFresh pair returns, so one
  transient empty read used to wipe the snapshot every later mount hydrates from - a board that
  boots to no agents and has no way back while the endpoint keeps answering empty. Live state still
  tells the truth (a genuinely deleted-to-zero roster must not keep its lit indicators); only the
  hydrate source is protected. The companion case proves the guard did not become "never store an
  empty roster" - with nothing populated cached, an empty answer is stored like any other.
  */
  it("an empty roster blanks the live view but never wipes a populated snapshot", async () => {
    writeCache(agentsRosterCacheKey("proj-roster", false), [AGENT_A], { maxBytes: 500_000 });
    rosterOverride = [];

    const { result } = renderHook(() => useAgents("proj-roster"));
    await waitFor(() => expect(rosterFetches().length).toBeGreaterThanOrEqual(1));
    await flushMicrotasks();

    expect(result.current.agents).toEqual([]);
    expect(readCache<unknown[]>(agentsRosterCacheKey("proj-roster", false), { maxAgeMs: 60_000 })
      ?.map((agent) => (agent as { id: string }).id)).toEqual(["agent-a"]);
  });

  it("stores an empty roster when nothing populated was ever cached", async () => {
    rosterOverride = [];

    const { result } = renderHook(() => useAgents("proj-roster"));
    await waitFor(() => expect(rosterFetches().length).toBeGreaterThanOrEqual(1));
    await flushMicrotasks();

    expect(result.current.agents).toEqual([]);
    expect(readCache<unknown[]>(agentsRosterCacheKey("proj-roster", false), { maxAgeMs: 60_000 })).toEqual([]);
  });
});
