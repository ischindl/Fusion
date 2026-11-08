/*
FNXC:BoardBootRequestSet 2026-11-08-03:34 (RUFU-493):
A cold authenticated board mount measured 178 API requests and was still RECEIVING responses 161.9 s
after navigation, while first-contentful-paint was only 628 ms. The lag the operator feels is therefore
not rendering — it is the request set. Two `GET /api/usage` calls (81.7 s and 61.2 s) each held one of
the four client read slots (`MAX_CONCURRENT_READS = 4`) for over a minute on a route whose only job is
to paint cards, `GET /tasks/board-workflows` cost 30.0 s then 17.4 s, `GET /api/agents/stats` 11.8 s,
and one card's `/diff` re-fired at 96.9 s / 128.9 s / 146.0 s at 10-12 s each.

`bootstrap-read-scheduler.test.ts` pins the QUEUE (classification, the 4-slot bound, mutation bypass)
but never asks which requests a mount issues — a bounded queue full of requests that should not exist
is still a board that answers nothing for two minutes. This file pins the other half: the SET.

Deliberate constraint on every case here: no assertion reads a clock. Not a duration, not an elapsed
time, not a timeout constant. The wall-clock numbers above are the reason the work exists and the
reason a timing assertion would rot — the same endpoint measured 61 s and 82 s in two adjacent calls of
ONE mount. Shape only: which paths were requested, how many times, and with which query parameters.

The harness mounts the boot-path consumers exactly as `App.tsx` mounts them for the board route:
  - `UsageIndicator` mounted CLOSED (`AppModals.tsx` renders it on every mount; it returns null while
    closed, but its hooks still run — that is precisely the hole that let `/api/usage` onto the board),
  - `useBoardWorkflows` from three mounted consumers (the `App.tsx` footer slot, `Board`, and one
    header switcher slot — the hook documents that it does not dedupe across consumers),
  - `useAgents` the way `App.tsx:1269` calls it,
  - `TaskCard`s that are OFF-SCREEN, which is the state a real cold board is in for every card below
    the fold.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { useBoardWorkflows } from "../hooks/useBoardWorkflows";
import { useAgents } from "../hooks/useAgents";
import { useBoardChromeReady } from "../hooks/useBoardChromeReady";
import { fetchBoardWorkflows } from "../api";
import { UsageIndicator } from "../components/UsageIndicator";
import { TaskCard, __test_clearMissionTitleCache, __test_clearAgentNameCache } from "../components/TaskCard";
import { SWR_CACHE_KEYS, clearCache } from "../utils/swrCache";
import type { Task } from "@fusion/core";

/*
The SSE multiplexer opens a real EventSource. Nothing in this file asserts on an event, and jsdom owns
no EventSource, so the bus is stubbed to a no-op subscription. The reads this file counts are all
issued by the mount path, which is exactly what the defect is.
*/
vi.mock("../sse-bus", () => ({
  subscribeSse: vi.fn(() => () => {}),
}));

vi.mock("../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../components/PluginSlot", () => ({ PluginSlot: () => null }));
vi.mock("../hooks/useBadgeWebSocket", () => ({
  useBadgeWebSocket: () => ({ badgeUpdates: new Map(), isConnected: true, subscribeToBadge: vi.fn(), unsubscribeFromBadge: vi.fn() }),
}));
vi.mock("../hooks/useBatchBadgeFetch", () => ({ getFreshBatchData: vi.fn(() => null) }));
vi.mock("../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: vi.fn(), confirmWithChoice: vi.fn(), confirmWithCheckbox: vi.fn(async () => ({ choice: "cancel" as const, checkboxValue: false })) }),
}));
vi.mock("../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }),
}));

/* ── recording transport ──────────────────────────────────────────────────── */

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const BOARD_WORKFLOWS = {
  flagEnabled: true,
  defaultWorkflowId: "builtin:coding",
  workflows: [
    {
      id: "builtin:coding",
      name: "Coding",
      columns: [
        { id: "todo", name: "Todo", role: "backlog" },
        { id: "in-progress", name: "In progress", role: "wip" },
        { id: "in-review", name: "In review", role: "review" },
        { id: "done", name: "Done", role: "complete" },
      ],
    },
  ],
  taskWorkflowIds: {} as Record<string, string>,
};

function answerFor(path: string): unknown {
  const clean = path.split("?")[0];
  if (clean.endsWith("/usage")) return { providers: [] };
  if (clean.endsWith("/tasks/board-workflows")) return BOARD_WORKFLOWS;
  if (clean.endsWith("/agents/stats")) return { total: 0, byState: {}, active: 0 };
  if (clean.endsWith("/agents")) return [];
  if (clean.endsWith("/diff")) return { files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } };
  if (clean.endsWith("/runtime-fallback")) return { showFallbackBadge: false, runtimeHint: null, reason: null, eventId: null };
  if (clean.endsWith("/setting-values")) return { stored: {}, effective: {}, orphaned: [] };
  if (clean.includes("/missions/")) return { id: "M-001", title: "Board boot baseline mission" };
  if (clean.endsWith("/settings/global")) return {};
  return [];
}

/** Every path recorded since the transport was created, in request order. */
let recorded: string[] = [];

function recordTransport(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") recorded.push(raw);
    return jsonResponse(answerFor(raw));
  }) as typeof fetch;
}

/* ── harness components ──────────────────────────────────────────────────── */

/** Mirrors the three simultaneously-mounted `useBoardWorkflows` consumers of a board route. */
function BoardWorkflowsConsumers({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <BoardWorkflowsOneConsumer key={index} />
      ))}
    </>
  );
}

function BoardWorkflowsOneConsumer() {
  useBoardWorkflows({ projectId: PROJECT_ID });
  return null;
}

/*
Mirrors App's boot-path `useAgents` call, whose only consumer is the dismissible capacity-risk banner.
The two clauses are App's own: the banner setting - which ships DISABLED - and `useBoardChromeReady` over
the board's own `lastFetchTimeMs`.

This mirror used to claim a gate `App` never applied: the production call site read `useAgents(projectId)`
with no `enabled`, so both agent reads stayed on the cold boot path (11.8 s measured for the stats read
alone) while the suite stayed green against a harness that pinned code which did not exist. The mirror is
therefore not trusted on its own - the source-construct guard at the end of this file reads `App.tsx` and
fails if its call site stops gating, so a production regression cannot hide behind this component again.
FNXC:BoardBootRequestSet 2026-11-08-05:40 (RUFU-493 code review, P1).
*/
function AppChromeAgentsConsumer({
  boardReadSettledAt,
  capacityBannerEnabled,
}: {
  boardReadSettledAt?: number;
  capacityBannerEnabled?: boolean;
}) {
  const boardChromeReady = useBoardChromeReady(boardReadSettledAt);
  useAgents(PROJECT_ID, { enabled: boardChromeReady && capacityBannerEnabled === true });
  return null;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "RUFU-900",
    title: "Baseline card",
    column: "in-progress",
    status: null,
    steps: [],
    dependencies: [],
    description: "",
    missionId: "M-001",
    worktree: "/tmp/worktrees/rufu-900",
    ...overrides,
  } as Task;
}

const PROJECT_ID = "proj-boot";

const noop = () => {};

function BoardCard({ task }: { task: Task }) {
  return <TaskCard task={task} onOpenDetail={noop} addToast={noop} />;
}

function BoardBootHarness({ usageOpen = false }: { usageOpen?: boolean }) {
  return (
    <>
      {/* What `AppModals` mounts on every board mount: the Usage surface, mounted CLOSED. */}
      <UsageIndicator isOpen={usageOpen} onClose={noop} projectId={PROJECT_ID} />
      <BoardWorkflowsConsumers count={3} />
      {/* The default deployment: capacity banner switched off, board read not yet answered. */}
      <AppChromeAgentsConsumer />
      {/* Two off-screen cards, i.e. every card below the fold of a cold board. */}
      <BoardCard task={makeTask()} />
      <BoardCard task={makeTask({ id: "RUFU-901", missionId: "M-002" })} />
    </>
  );
}

/*
The same board once the board payload has answered AND the operator has the capacity banner switched on -
the only state in which App's chrome read is allowed to run. The gate is a STATE, so this is how a test
reaches it: no timer is advanced and no clock constant appears anywhere in this file.
*/
function SettledBoardHarness() {
  return <AppChromeAgentsConsumer boardReadSettledAt={Date.now()} capacityBannerEnabled />;
}

/** The same board with the Usage surface reachable, so opening it is an interaction, not a remount. */
function ToggleableUsageHarness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <UsageIndicator isOpen={open} onClose={() => setOpen(false)} projectId={PROJECT_ID} />
      <BoardWorkflowsConsumers count={3} />
      <AppChromeAgentsConsumer />
      <BoardCard task={makeTask()} />
      <button type="button" onClick={() => setOpen(true)}>open-usage</button>
      <button type="button" onClick={() => setOpen(false)}>close-usage</button>
    </div>
  );
}

/** Off-screen IntersectionObserver: a cold board renders its below-the-fold cards, then nothing. */
class OffscreenObserver {
  constructor(protected readonly callback: IntersectionObserverCallback) {}
  observe(): void {
    this.callback([{ isIntersecting: false } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  disconnect(): void {}
  unobserve(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  root = null;
  rootMargin = "0px";
  thresholds = [];
}

/*
The same stub reporting ON-screen, for the cases that must prove a surface still loads its own data
rather than being permanently starved by a gate.
*/
class VisibleObserver extends OffscreenObserver {
  override observe(): void {
    this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

/**
 * Mirrors the header workflow switcher slot: it renders the lane drop-down and reads no per-card
 * mapping, so it declares `scope: "lanes"`. FNXC:BoardBootRequestSet 2026-11-08-04:20 (RUFU-493).
 */
function LanesOnlySwitcherConsumer() {
  const { boardWorkflows, workflowOptions } = useBoardWorkflows({ projectId: "p1", scope: "lanes" });
  return <span data-testid="switcher">{boardWorkflows ? `options:${workflowOptions.length}` : "none"}</span>;
}

/**
 * Mirrors a consumer that mounts while the lane vocabulary is ALREADY held — a second mount, a view
 * switch, a tab returning to focus — and knows which cards it renders. That is the case where naming
 * ids costs the server nothing and saves it a whole-table scan. The cache reader is injected so the
 * mount starts held without leaning on sessionStorage. FNXC:BoardBootRequestSet 2026-11-08-04:20
 * (RUFU-493).
 */
/**
 * STABLE on purpose: `useBoardWorkflows` lists its cache reader in a re-hydration effect's deps and
 * writes state from its result, so an inline arrow here re-runs that effect on every render and the
 * component spins. A module constant is the same contract the production call sites get for free from
 * the default reader.
 */
const readHeldLaneVocabulary = () => ({
  flagEnabled: true,
  defaultWorkflowId: "builtin:coding",
  workflows: [{ id: "builtin:coding", name: "Coding", columns: [] }],
  taskWorkflowIds: {},
});

function HeldMappingConsumer({ taskIds }: { taskIds: string[] }) {
  const { boardWorkflows } = useBoardWorkflows({
    projectId: "p1",
    taskIds,
    readBoardWorkflowsCache: readHeldLaneVocabulary,
  });
  return <span data-testid="held">{boardWorkflows ? `lanes:${boardWorkflows.workflows.length}` : "none"}</span>;
}

function countMatching(pattern: RegExp): number {
  return recorded.filter((path) => pattern.test(path)).length;
}

/*
The unbounded shape is defined by what it OMITS: no id list, no lane-only scope. It is the one read that
enumerates the whole current-task table plus the newest Done page. FNXC:BoardBootRequestSet 2026-11-08-05:12
(RUFU-493).
*/
/*
FNXC:BoardBootRequestSet 2026-11-08-05:30 (RUFU-493 code review, P0):
Parameters are read through the URL PARSER, never by substring. A substring test for `scope=lanes` also
matches the corrupted request the first cut of the lane scope really emitted,
`/api/tasks/board-workflows?projectId=X?scope=lanes`, in which `scope` is not a parameter at all - it is a
substring of a project id that resolves to nothing. The classifier then certified as bounded the exact read
the server answered unbounded, which is how the defect reached review with a green suite. "Is this request
bounded?" is a question about what the server sees, and only the parser sees what the server sees.
*/
function readParams(path: string): URLSearchParams {
  return new URL(path, "http://dashboard.test").searchParams;
}

function isUnboundedBoardWorkflowsRead(path: string): boolean {
  if (!/\/tasks\/board-workflows/.test(path)) {
    return false;
  }
  const params = readParams(path);
  return !params.get("taskIds") && params.get("scope") !== "lanes";
}

function unboundedBoardWorkflowsReads(): string[] {
  return recorded.filter(isUnboundedBoardWorkflowsRead);
}

/**
 * Reads a harness component's own report line. `screen` is not wired for this project, and the harness
 * components are the smallest possible witnesses, so the container is the query root.
 */
function textOf(container: HTMLElement, testId: string): string | undefined {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? undefined;
}

function pathsMatching(pattern: RegExp): string[] {
  return recorded.filter((path) => pattern.test(path));
}

beforeEach(() => {
  recorded = [];
  sessionStorage.clear();
  localStorage.clear();
  clearCache(SWR_CACHE_KEYS.USAGE);
  // TaskCard's entity-label caches are module-level on purpose; a shared module cache across cases
  // would make an absence assertion pass for the wrong reason.
  __test_clearMissionTitleCache();
  __test_clearAgentNameCache();
  vi.stubGlobal("fetch", recordTransport());
  vi.stubGlobal("IntersectionObserver", OffscreenObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("board boot request set (RUFU-493)", () => {
  it("issues no /api/usage read while the board is the active route and Usage is closed", async () => {
    const { unmount } = render(<BoardBootHarness />);
    await waitFor(() => expect(countMatching(/\/api\/tasks\/board-workflows/)).toBeGreaterThanOrEqual(1));

    expect(
      pathsMatching(/\/api\/usage/),
      `the cold board mount requested /api/usage; measured 61-82 s each on the deployed board, holding two of the four read slots`,
    ).toEqual([]);

    unmount();
  });

  it("issues exactly one usage read when the Usage surface is opened", async () => {
    const { getByText } = render(<ToggleableUsageHarness />);
    await waitFor(() => expect(countMatching(/\/api\/tasks\/board-workflows/)).toBeGreaterThanOrEqual(1));
    expect(pathsMatching(/\/api\/usage/)).toEqual([]);

    await act(async () => {
      getByText("open-usage").click();
      await Promise.resolve();
    });

    expect(countMatching(/\/api\/usage/)).toBe(1);

    // A second open inside the cache window must not re-pay a 61-82 s endpoint.
    await act(async () => {
      getByText("close-usage").click();
      await Promise.resolve();
      getByText("open-usage").click();
      await Promise.resolve();
    });
    expect(countMatching(/\/api\/usage/)).toBe(1);
  });

  it("issues at most one unbounded board-workflows read per project across every mounted consumer", async () => {
    const { unmount } = render(<BoardBootHarness />);
    await waitFor(() => expect(countMatching(/\/api\/tasks\/board-workflows/)).toBeGreaterThanOrEqual(1));

    const boardWorkflowReads = pathsMatching(/\/api\/tasks\/board-workflows/);
    const unbounded = unboundedBoardWorkflowsReads();
    expect(
      unbounded,
      `each mounted consumer issued its own whole-board read: ${unbounded.join(", ")}`,
    ).toHaveLength(1);

    for (const read of boardWorkflowReads.filter((path) => path !== unbounded[0])) {
      const params = readParams(read);
      expect(params.get("partial"), `partial flag as a PARSED parameter in ${read}`).toBe("1");
      expect(params.get("taskIds"), `an id list as a PARSED parameter in ${read}`).toBeTruthy();
    }

    unmount();
  });

  it("issues no background-chrome read (agent stats, per-mission labels) for a cold board mount", async () => {
    const { unmount } = render(<BoardBootHarness />);
    await waitFor(() => expect(countMatching(/\/api\/tasks\/board-workflows/)).toBeGreaterThanOrEqual(1));
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      pathsMatching(/\/api\/agents\/stats/),
      "agent stats is chrome: it must not sit on the board's first-paint path",
    ).toEqual([]);
    expect(
      pathsMatching(/\/api\/missions\//),
      "per-card mission labels are off-viewport reads and must wait for the card",
    ).toEqual([]);
    /*
    The per-card diff poll belongs to the card, not to the board. An off-screen card holds no armed timer
    and issues no `/diff` read at all; the cadence itself is pinned in `useTaskDiffStats.poll.test.ts`.
    */
    expect(
      pathsMatching(/\/diff\b/),
      "a card that cannot be seen must not be paying for its changes badge",
    ).toEqual([]);
    /*
    Deliberately NOT asserted absent: `useAgentsMapCache`, which every card mounts for assignee names,
    is one project-scoped read shared across all cards (SWR-cached, listener-notified), not a per-card
    read. RUFU-493 scoped the chrome deferral to the two named per-mount reads; a shared cached index
    is the shape this board should keep.
    */

    unmount();
  });

  /*
  The deferral must be a deferral, not an eviction: the capacity banner still gets its stats the moment
  the board it decorates has settled. Pinning the positive is what keeps the absence assertion above
  from being satisfied by a surface that was simply never wired up.
  */
  it("still loads the chrome once the board's own read has settled", async () => {
    const { unmount } = render(<SettledBoardHarness />);

    await waitFor(() => expect(countMatching(/\/api\/agents\/stats/)).toBe(1));
    expect(countMatching(/\/api\/agents(\?|$)/)).toBeGreaterThanOrEqual(1);

    unmount();
  });

  /*
  FNXC:BoardBootRequestSet 2026-11-08-05:40 (RUFU-493 code review, P1):
  The positive case above collapses both clauses of App's gate, so neither could regress on its own. Each is
  pinned apart here, and a board-workflows read rides along as the SENTINEL: once the sentinel has landed,
  every read this mount issued has been handed to the transport, so "zero agent reads" is a settled answer
  and not a race. No clock appears in the argument.
  */
  it("holds the chrome read while the banner is on but the board's own read has not answered", async () => {
    const { unmount } = render(
      <>
        <AppChromeAgentsConsumer capacityBannerEnabled />
        <BoardWorkflowsOneConsumer />
      </>,
    );
    await waitFor(() => expect(countMatching(/\/api\/tasks\/board-workflows/)).toBeGreaterThanOrEqual(1));
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      pathsMatching(/\/api\/agents/),
      "the board payload owns the read queue until it answers, even with the banner switched on",
    ).toEqual([]);
    unmount();
  });

  /*
  The second clause is the one that decides a default deployment: `capacityRiskBannerEnabled` is false in
  `DEFAULT_PROJECT_SETTINGS`, so an un-gated mount was paying two agent reads (11.8 s measured) for a banner
  that can never render. Settling the board must NOT release them while the setting says off.
  */
  it("issues no chrome read at all while the capacity banner is switched off", async () => {
    const { unmount } = render(
      <>
        <AppChromeAgentsConsumer boardReadSettledAt={Date.now()} />
        <BoardWorkflowsOneConsumer />
      </>,
    );
    await waitFor(() => expect(countMatching(/\/api\/tasks\/board-workflows/)).toBeGreaterThanOrEqual(1));
    await act(async () => {
      await Promise.resolve();
    });

    expect(pathsMatching(/\/api\/agents/), "a disabled banner must not buy its statistics").toEqual([]);
    unmount();
  });

  /*
  A mirror is only evidence about itself - which is exactly how the cases above came to be pinned to a
  harness component while `App` still fetched both agent reads on boot. This guard reads the production
  source and asserts the CODE CONSTRUCT (AGENTS.md: a structural scan is a real guard; a comment never is),
  so deleting the wiring in `App.tsx` turns this case red instead of silently narrowing the suite.
  FNXC:BoardBootRequestSet 2026-11-08-05:40 (RUFU-493 code review, P1).
  */
  it("ships the gate in App.tsx itself, not only in this harness", () => {
    const appSource = readFileSync(join(__dirname, "../App.tsx"), "utf8");

    expect(
      (appSource.match(/useAgents\(/g) ?? []).length,
      "this guard points at App's single boot-path agents call; add any new call site to the guard",
    ).toBe(1);

    const callSite = appSource.match(/useAgents\([^)]*\)/)?.[0] ?? "";
    expect(callSite, "App's boot-path useAgents call must carry an enabled gate").toContain("enabled");
    expect(
      callSite,
      "the gate must be the shared board-chrome state, not a bespoke condition that drifts from the harness",
    ).toContain("boardChromeReady");
    expect(
      appSource,
      "the board-chrome state must come from the shared hook over useTasks' answered-read state",
    ).toMatch(/const boardChromeReady = useBoardChromeReady\(lastFetchTimeMs\)/);
  });

  it("issues no per-card diff or runtime-fallback read for an off-screen card", async () => {
    const { unmount } = render(<BoardBootHarness />);
    await waitFor(() => expect(countMatching(/\/api\/tasks\/board-workflows/)).toBeGreaterThanOrEqual(1));
    await act(async () => {
      await Promise.resolve();
    });

    expect(pathsMatching(/\/diff(\?|$)/)).toEqual([]);
    expect(pathsMatching(/\/runtime-fallback(\?|$)/)).toEqual([]);
    unmount();
  });

  /*
  A gate that only ever starves a surface is indistinguishable from a broken surface, so the positive
  half is pinned beside every absence above: a card that CAN be seen still gets its mission label, and
  cards that share a mission share one read. The value cache alone never deduped a within-mount burst —
  eight cards on one mission issued eight identical `GET /api/missions/:id` reads.
  */
  it("issues one mission-label read for four visible cards that share a mission", async () => {
    vi.stubGlobal("IntersectionObserver", VisibleObserver);

    const { unmount } = render(
      <>
        {[
          makeTask({ id: "RUFU-910", missionId: "M-001" }),
          makeTask({ id: "RUFU-911", missionId: "M-001" }),
          makeTask({ id: "RUFU-912", missionId: "M-001" }),
          makeTask({ id: "RUFU-913", missionId: "M-001" }),
        ].map((task) => (
          <BoardCard key={task.id} task={task} />
        ))}
      </>,
    );

    await waitFor(() => expect(countMatching(/\/api\/missions\//)).toBeGreaterThanOrEqual(1));
    await act(async () => {
      await Promise.resolve();
    });

    expect(countMatching(/\/api\/missions\/M-001/)).toBe(1);
    // Positive half for the diff gate too: a card that CAN be seen still gets exactly one badge read.
    for (const id of ["RUFU-910", "RUFU-911", "RUFU-912", "RUFU-913"]) {
      expect(countMatching(new RegExp(`/api/tasks/${id}/diff`)), `${id} badge read`).toBe(1);
    }

    unmount();
  });
});

/*
FNXC:BoardBootRequestSet 2026-11-08-04:25 (RUFU-493):
`GET /tasks/board-workflows` was the one boot read whose scope was decided by the server's default, so
every consumer that mounted asked the same maximally expensive question: enumerate the whole current-task
table plus the newest Done page. Measured live, one cold board paid it twice (30.0 s then 17.4 s, 60.6 s of
the 351.5 s boot) while a header slot mounted a third time for a lane drop-down that reads no per-card
mapping at all.

The invariant is that a read's scope matches what its caller can answer for. A consumer that already holds
the lane vocabulary and knows its cards names those ids — the named-id route answers from the ids alone and
spends zero task-table reads. A consumer that renders the lane list and reads no mapping asks for lanes
only. The unbounded read survives for exactly one request per project per mount: the one that must learn
which lanes exist before any id list can describe them.

Every assertion is on the request line — path, count, query parameters — because that is the dimension the
defect occupied. No timing constant appears here, by design.
*/
describe("board boot request set — board-workflows read scope (RUFU-493)", () => {
  it("asks only for lanes when the consumer reads the lane list and no card", async () => {
    const { container } = render(<LanesOnlySwitcherConsumer />);
    await waitFor(() => expect(pathsMatching(/\/tasks\/board-workflows/).length).toBeGreaterThan(0));

    const [path] = pathsMatching(/\/tasks\/board-workflows/);
    /*
    The switcher names no cards, and says so: a vocabulary question must not buy a task enumeration.
    Both clauses read the PARSED parameters, and the project id is asserted beside them, because that is
    exactly where the P0 defect hid - `scope` was present as a substring while `projectId` had swallowed it.
    */
    const params = readParams(path);
    expect(params.get("scope"), `lane scope as a PARSED parameter in ${path}`).toBe("lanes");
    expect(params.get("projectId"), `the project survives as its own parameter in ${path}`).toBe("p1");
    expect(params.get("taskIds"), `a vocabulary question names no cards: ${path}`).toBeFalsy();
    // Positive half: the cheaper scope still delivers the drop-down its lanes — never a starved switcher.
    await waitFor(() => expect(textOf(container, "switcher")).toBe("options:1"));
  });

  it("re-reads the whole board on mount, because only that answer can describe the lanes", async () => {
    const { container } = render(<HeldMappingConsumer taskIds={["RUFU-1", "RUFU-2"]} />);
    await waitFor(() => expect(pathsMatching(/\/tasks\/board-workflows/).length).toBe(1));

    /*
    This is the deliberate half of the bargain, pinned so a future optimisation cannot silently cross it.
    A mount answer REPLACES state, and a patch cannot express "this lane is gone" or "the default moved" —
    merging one would keep a workflow the server has stopped reporting. The bounded reads belong to the
    refreshes that only re-map cards (asserted next), not to the read that learns the vocabulary.
    */
    expect(unboundedBoardWorkflowsReads()).toHaveLength(1);
    // Positive half: the whole-board answer really delivers the lane set the consumer renders.
    await waitFor(() => expect(textOf(container, "held")).toBe("lanes:1"));
  });

  it("carries the card ids through a tab-focus refresh, the read a backgrounded tab always pays", async () => {
    render(<HeldMappingConsumer taskIds={["RUFU-1"]} />);
    await waitFor(() => expect(pathsMatching(/\/tasks\/board-workflows/).length).toBe(1));

    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });

    const reads = pathsMatching(/\/tasks\/board-workflows/);
    expect(reads.length).toBe(2);
    // The mount read is whole-board; the refresh that only re-maps these cards names them.
    expect(unboundedBoardWorkflowsReads()).toHaveLength(1);
    const refreshParams = readParams(reads[1]);
    expect(refreshParams.get("taskIds"), `named ids as a PARSED parameter in ${reads[1]}`).toContain("RUFU-1");
    expect(refreshParams.get("partial"), `partial as a PARSED parameter in ${reads[1]}`).toBe("1");
  });

  /*
  FNXC:BoardBootRequestSet 2026-11-08-05:30 (RUFU-493 code review, P0):
  Everything above asks what a MOUNTED CONSUMER requested; none of it could see how the request line was
  assembled, because the hook hands the transport one string. The lane scope shipped as
  `/api/tasks/board-workflows?projectId=X?scope=lanes` - a single misplaced separator that no consumer-level
  assertion can distinguish from the correct line, and that the server read as a request from a project
  literally named `X?scope=lanes` with no scope at all: the lane-only branch never fired and project
  resolution asked for a project that does not exist, so the switcher silently lost its drop-down.
  This case pins the transport's own output for every parameter combination the hook can ask for.
  */
  it("builds one parseable query line for every scope combination", async () => {
    const cases: Array<{
      label: string;
      call: () => Promise<unknown>;
      expect: (params: URLSearchParams) => void;
    }> = [
      {
        label: "lane scope with a project",
        call: () => fetchBoardWorkflows(PROJECT_ID, { scope: "lanes" }),
        expect: (params) => {
          expect(params.get("scope")).toBe("lanes");
          expect(params.get("projectId")).toBe(PROJECT_ID);
          expect(params.get("taskIds")).toBeNull();
        },
      },
      {
        label: "named ids with partial",
        call: () => fetchBoardWorkflows(PROJECT_ID, { taskIds: ["RUFU-2", "RUFU-1"], partial: true }),
        expect: (params) => {
          expect(params.get("taskIds")).toBe("RUFU-1,RUFU-2");
          expect(params.get("partial")).toBe("1");
          expect(params.get("projectId")).toBe(PROJECT_ID);
          expect(params.get("scope")).toBeNull();
        },
      },
      {
        label: "named ids without partial keeps the enumeration",
        call: () => fetchBoardWorkflows(PROJECT_ID, { taskIds: ["RUFU-3"] }),
        expect: (params) => {
          expect(params.get("taskIds")).toBe("RUFU-3");
          expect(params.get("partial")).toBeNull();
        },
      },
      {
        label: "unbounded read",
        call: () => fetchBoardWorkflows(PROJECT_ID),
        expect: (params) => {
          expect(params.get("projectId")).toBe(PROJECT_ID);
          expect(params.get("scope")).toBeNull();
          expect(params.get("taskIds")).toBeNull();
        },
      },
      {
        label: "lane scope with no project",
        call: () => fetchBoardWorkflows(undefined, { scope: "lanes" }),
        expect: (params) => {
          expect(params.get("scope")).toBe("lanes");
          expect(params.get("projectId")).toBeNull();
        },
      },
    ];

    for (const testCase of cases) {
      recorded = [];
      await act(async () => {
        await testCase.call();
      });

      const [path] = pathsMatching(/\/tasks\/board-workflows/);
      expect(path, `${testCase.label}: the transport issued a request`).toBeTruthy();
      // Exactly one query separator: a second `?` is what smuggled the scope into the project id.
      expect(path.split("?").length - 1, `${testCase.label}: one query separator in ${path}`).toBe(1);
      const params = readParams(path);
      const projectId = params.get("projectId");
      expect(projectId === null || !projectId.includes("scope"), `${testCase.label}: projectId is not a composite: ${path}`).toBe(true);
      testCase.expect(params);
      // And the classifier the mount assertions lean on must agree with the parser, not with a substring.
      expect(
        isUnboundedBoardWorkflowsRead(path),
        `${testCase.label}: classifier agrees with parsed params: ${path}`,
      ).toBe(!params.get("taskIds") && params.get("scope") !== "lanes");
    }
  });
});
