// @vitest-environment node
/*
FNXC:ArtifactRetraction 2026-11-11-12:27 (RUFU-433):
The HTTP layer is where retraction stops being a store property and becomes an operator-visible fact, so this
suite drives the real Express stack over the artifact routes rather than calling the store. Each assertion names
the harm it forecloses:

- A default browse must not find a retracted artifact. The motivating harm is a false review artifact staying
  findable by an ordinary gallery scroll, so hiding is the DEFAULT and revealing is the explicit opt-in.
- The media route must refuse outright. It is the one surface a client reaches without consulting anything:
  an <img>/<video> src, a plain <a href>, or a player's Range request all arrive here directly, so a VOID tile
  over bytes that still stream would be a lie the gallery tells while the withdrawn claim stays fully readable.
- The detail route answers with the tombstone and NO body. This route deliberately includes inline content for
  the document viewer, which is precisely what a retracted artifact must not hand back to an old bookmark or a
  still-open modal.
- Attribution is derived server-side and a body-supplied `actor` can only annotate it, never replace it — the
  same rule `bypass-review` in this registrar already enforces, because the daemon bearer token is one shared
  operator secret.
- Restore exists here and nowhere an agent can reach: an agent able to un-retract its own retraction could
  launder a withdrawn claim back into the gallery after the reason for withdrawing it had been read.

Surface enumeration: list (default-hidden, opted-in, falsey flag, malformed flag), single read, media read,
PATCH edit refusal, POST retract (blank/missing reason, missing row, foreign-author irrelevant at this layer
because an operator may retract any), POST restore (happy path, nothing-to-restore), and the shape both
mutations answer with.
*/
import express from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Artifact, TaskStore } from "@fusion/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const { createApiRoutes } = await import("../routes.js");
const { request: performRequest } = await import("../test-request.js");

const LIVE_ID = "art-live";
const VOID_ID = "art-void";

function artifactRow(over: Partial<Artifact> = {}): Artifact {
  return {
    id: LIVE_ID,
    type: "document",
    title: "Review summary",
    description: "Claims about the fix",
    mimeType: "text/markdown",
    uri: `.fusion/artifacts/${LIVE_ID}.md`,
    content: "The migration is verified end to end.",
    taskId: "RUFU-433",
    authorId: "agent-executor",
    authorType: "agent",
    createdAt: "2026-11-10T10:00:00.000Z",
    updatedAt: "2026-11-10T10:00:00.000Z",
    ...over,
  } as Artifact;
}

interface Registry {
  rows: Artifact[];
  retractCalls: Array<{ id: string; reason: string; actorId: string; actorType: string }>;
  restoreCalls: Array<{ id: string; actorId: string; actorType: string }>;
}

/**
 * The registry mirrors the store contract the routes are written against: `listArtifacts` honours
 * `includeRetracted` itself, `getArtifact` returns the row including its inline content, and the mutation
 * methods refuse with the store's own refusal sentences so the route's status mapping is what is under test.
 */
function createStore(): { store: TaskStore & Partial<Registry>; registry: Registry } {
  const registry: Registry = {
    rows: [
      // The live row is an inline-text artifact: its media comes from `content`, so the route needs no file.
      artifactRow({ uri: undefined }),
      /*
      The retracted row carries a `uri` on purpose. The media refusal must fire before any path resolution or
      file read, and a row whose bytes are genuinely not on disk is the only shape that proves it: were the
      route to reach the filesystem first, this request would answer 404 rather than 410.
      */
      artifactRow({
        id: VOID_ID,
        title: "Retracted review artifact",
        content: "A claim the author withdrew.",
        retractedAt: "2026-11-11T09:00:00.000Z",
        retractedBy: "agent-executor",
        retractReason: "The diff I described was not the one I ran.",
      }),
    ],
    retractCalls: [],
    restoreCalls: [],
  };

  const store = {
    getRootDir: vi.fn(() => "/tmp/fusion-artifact-route-root"),
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    getProject: vi.fn().mockResolvedValue(null),
    getPluginStore: vi.fn(() => ({ init: () => Promise.resolve(), loadAllPlugins: () => Promise.resolve(), listPlugins: () => [] })),
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
    off: vi.fn(),

    listArtifacts: vi.fn(async (filters: { includeRetracted?: boolean } = {}) => {
      // The store owns the hide; the route must neither re-implement it nor widen it.
      const visible = filters.includeRetracted ? registry.rows : registry.rows.filter((row) => !row.retractedAt);
      return visible.map((row) => ({ ...row, content: undefined }));
    }),

    getArtifact: vi.fn(async (id: string) => {
      const found = registry.rows.find((row) => row.id === id);
      return found ? { ...found } : null;
    }),

    updateArtifact: vi.fn(async (id: string, updates: Record<string, unknown>) => {
      const found = registry.rows.find((row) => row.id === id);
      if (!found) throw new Error(`Artifact ${id} not found`);
      if (found.retractedAt) {
        throw new Error(`Artifact ${id} was retracted (${found.retractReason}) - it is a VOID record and is not editable`);
      }
      Object.assign(found, updates);
      return { ...found };
    }),

    retractArtifact: vi.fn(async (id: string, input: { reason: string; actorId: string; actorType: string }) => {
      registry.retractCalls.push({ id, ...input });
      const found = registry.rows.find((row) => row.id === id);
      if (!found) throw new Error(`Artifact ${id} not found`);
      if (!input.reason || input.reason.trim().length === 0) {
        throw new Error("Retracting an artifact requires a non-empty reason");
      }
      found.retractedAt = "2026-11-11T10:00:00.000Z";
      found.retractedBy = input.actorId;
      found.retractReason = input.reason;
      return { ...found };
    }),

    restoreArtifact: vi.fn(async (id: string, input: { actorId: string; actorType: string }) => {
      registry.restoreCalls.push({ id, ...input });
      const found = registry.rows.find((row) => row.id === id);
      if (!found) throw new Error(`Artifact ${id} not found`);
      if (!found.retractedAt) throw new Error(`Artifact ${id} is not retracted - nothing to restore`);
      found.retractedAt = undefined;
      found.retractedBy = undefined;
      found.retractReason = undefined;
      return { ...found };
    }),
  } as unknown as TaskStore & Partial<Registry>;

  return { store, registry };
}

/*
FNXC:ArtifactRetraction 2026-11-11-12:27 (RUFU-433): the load-bearing invariant of the whole feature is that
retracting an artifact leaves every card exactly where it stood - no column move, no changed gate verdict, no
cleared pause, no task lifecycle write. A fake store that simply omits the task-mutating methods proves that
only accidentally (a route reaching one would 500 for the wrong reason and the test would still be green if it
asserted only on 4xx/2xx), so every task-lifecycle verb is replaced by a tripwire that names itself. The store
seam's OWN History line and audit row live below this boundary - the route calls `retractArtifact` and nothing
else - so `logEntry` and `recordRunAuditEvent` belong on the tripwire too.
*/
const TASK_LIFECYCLE_TRIPWIRE = /^(updateTask|moveTask|patchTask|deleteTask|pauseTask|resumeTask|setTask|handoffTask|recordHuman|bypass|retractTask|logEntry|recordRunAuditEvent|recordTaskEvent)/;

function guardTaskInvariants(store: TaskStore & Partial<Registry>): TaskStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && TASK_LIFECYCLE_TRIPWIRE.test(prop) && !(prop in target)) {
        throw new Error(`CARD-INVARIANT VIOLATION: artifact route touched task lifecycle method "${prop}"`);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function createApp(store: TaskStore) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(guardTaskInvariants(store)));
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});
async function get(store: TaskStore, path: string) {
  return performRequest(createApp(store), "GET", `/api/artifacts${path}`);
}

async function post(store: TaskStore, path: string, body?: Record<string, unknown>) {
  return performRequest(createApp(store), "POST", `/api/artifacts${path}`, JSON.stringify(body ?? {}), {
    "Content-Type": "application/json",
  });
}

async function patch(store: TaskStore, id: string, body: Record<string, unknown>) {
  return performRequest(createApp(store), "PATCH", `/api/artifacts/${id}`, JSON.stringify(body), {
    "Content-Type": "application/json",
  });
}

describe("artifact retraction routes", () => {
  it("hides a retracted artifact from the default list and returns it only on explicit opt-in", async () => {
    const { store } = createStore();

    const byDefault = await get(store, "");
    expect(byDefault.status).toBe(200);
    const defaultIds = (byDefault.body as Array<{ id: string }>).map((row) => row.id);
    expect(defaultIds).toContain(LIVE_ID);
    expect(defaultIds).not.toContain(VOID_ID);

    const optedIn = await get(store, "?includeRetracted=true");
    expect(optedIn.status).toBe(200);
    const optedIds = (optedIn.body as Array<{ id: string; retractReason?: string }>).map((row) => row.id);
    expect(optedIds).toContain(VOID_ID);
    const voidRow = (optedIn.body as Array<{ id: string; retractReason?: string }>).find((row) => row.id === VOID_ID);
    expect(voidRow?.retractReason).toBe("The diff I described was not the one I ran.");
  });

  it.each(["false", "0", "no", "off", ""])("treats includeRetracted=%j as hidden, not shown", async (flag) => {
    const { store } = createStore();
    const res = await get(store, `?includeRetracted=${flag}`);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((row) => row.id);
    expect(ids).not.toContain(VOID_ID);
  });

  /*
  A malformed flag is refused rather than silently honoured in either direction: guessing would make a typo
  into either a leak (tombstones revealed) or a silent loss (the operator thinks they are looking at them).
  */
  it("refuses a malformed includeRetracted flag instead of guessing a direction", async () => {
    const { store } = createStore();
    const res = await get(store, "?includeRetracted=maybe");
    expect(res.status).toBe(400);
    expect((res.body as { error?: string; message?: string }).error ?? (res.body as { message?: string }).message)
      ?.toContain("includeRetracted");
  });

  /*
  The media refusal is the load-bearing one. Every other VOID answer can be skipped by a client that never
  consulted it, so this asserts the bytes are unreachable rather than merely unlinked.
  */
  it("refuses media for a retracted artifact with 410 while still serving a live one", async () => {
    const { store } = createStore();

    const voidMedia = await get(store, `/${VOID_ID}/media`);
    expect(voidMedia.status).toBe(410);
    const refusal = JSON.stringify(voidMedia.body);
    expect(refusal).not.toContain("A claim the author withdrew.");

    const liveMedia = await get(store, `/${LIVE_ID}/media`);
    expect(liveMedia.status).toBe(200);
    expect(liveMedia.headers["content-type"]).toContain("text/markdown");
    // Supertest leaves an unrecognised MIME type unparsed; either shape proves the bytes were served.
    expect(String(liveMedia.text ?? liveMedia.body)).toContain("verified end to end");
  });

  it("answers a retracted artifact's detail read with the tombstone and no content body", async () => {
    const { store } = createStore();
    const res = await get(store, `/${VOID_ID}`);
    expect(res.status).toBe(200);
    const body = res.body as Artifact & { retracted?: boolean };
    expect(body.id).toBe(VOID_ID);
    expect(body.retracted).toBe(true);
    expect(body.retractedAt).toBe("2026-11-11T09:00:00.000Z");
    expect(body.retractedBy).toBe("agent-executor");
    expect(body.retractReason).toBe("The diff I described was not the one I ran.");
    // The withdrawn claim must not be in the payload at all, under any key.
    expect(body.content).toBeNull();
    expect(JSON.stringify(body)).not.toContain("A claim the author withdrew.");
  });

  it("serves a live artifact's detail read with its content intact", async () => {
    const { store } = createStore();
    const res = await get(store, `/${LIVE_ID}`);
    expect(res.status).toBe(200);
    expect((res.body as Artifact).content).toContain("verified end to end");
    expect((res.body as Artifact & { retracted?: boolean }).retracted).toBeUndefined();
  });

  it("requires a reason to retract over HTTP and never defaults one", async () => {
    const { store, registry } = createStore();

    const missing = await post(store, `/${LIVE_ID}/retract`, {});
    expect(missing.status).toBe(400);
    const blank = await post(store, `/${LIVE_ID}/retract`, { reason: "   " });
    expect(blank.status).toBe(400);
    const nonString = await post(store, `/${LIVE_ID}/retract`, { reason: 42 });
    expect(nonString.status).toBe(400);

    expect(registry.retractCalls).toHaveLength(0);
    expect(registry.rows.find((row) => row.id === LIVE_ID)?.retractedAt).toBeUndefined();
  });

  /*
  The reason is the whole point of the tombstone - it is what stops a withdrawn claim being read as live
  evidence - so the store's own blank-reason refusal has to reach the caller as a 400, not as a 500 that
  implies the server broke.
  */
  it("maps the store's missing-reason refusal to 400 rather than 500", async () => {
    const { store } = createStore();
    vi.mocked(store.retractArtifact).mockRejectedValue(new Error("Retracting an artifact requires a non-empty reason"));

    const res = await post(store, `/${LIVE_ID}/retract`, { reason: "whatever" });
    expect(res.status).toBe(400);
  });

  it("records an HTTP retraction as a server-derived operator, with any client actor kept advisory", async () => {
    const { store, registry } = createStore();

    const plain = await post(store, `/${LIVE_ID}/retract`, { reason: "Withdrawn: overstated coverage." });
    expect(plain.status).toBe(200);
    expect(registry.retractCalls[0]).toEqual({
      id: LIVE_ID,
      reason: "Withdrawn: overstated coverage.",
      actorId: "dashboard-operator",
      actorType: "user",
    });

    registry.retractCalls.length = 0;
    const claimed = await post(store, `/${VOID_ID}/retract`, { reason: "Second tombstone.", actor: "card-owner" });
    expect(claimed.status).toBe(200);
    // Advisory name annotates the attribution; it never replaces it.
    expect(registry.retractCalls[0]?.actorId).toBe('dashboard-operator (as "card-owner")');
    expect(registry.retractCalls[0]?.actorType).toBe("user");
  });

  it("answers a retract on an unknown artifact with 404, not a 500", async () => {
    const { store } = createStore();
    const res = await post(store, "/art-does-not-exist/retract", { reason: "Any reason at all." });
    expect(res.status).toBe(404);
  });

  it("clears all three tombstone fields on operator restore and answers with the live row", async () => {
    const { store, registry } = createStore();

    const res = await post(store, `/${VOID_ID}/restore`, {});
    expect(res.status).toBe(200);
    expect(registry.restoreCalls[0]).toEqual({
      id: VOID_ID,
      actorId: "dashboard-operator",
      actorType: "user",
    });
    const row = registry.rows.find((candidate) => candidate.id === VOID_ID);
    expect(row?.retractedAt).toBeUndefined();
    expect(row?.retractedBy).toBeUndefined();
    expect(row?.retractReason).toBeUndefined();

    // Restored means findable again through the default browse, with its content served.
    const listed = await get(store, "");
    expect((listed.body as Array<{ id: string }>).map((item) => item.id)).toContain(VOID_ID);
  });

  it("refuses to restore an artifact that was never retracted", async () => {
    const { store } = createStore();
    const res = await post(store, `/${LIVE_ID}/restore`, {});
    expect(res.status).toBe(409);
  });

  /*
  A guard that cannot fire is decoration, so its own teeth are asserted here: a store that does not implement a
  task-lifecycle verb must raise on mere property access rather than answer `undefined`, which is what turns a
  future route change from a silent no-op into this suite going red. The methods the artifact routes genuinely
  need must still pass through untouched, or the guard would merely be a broken proxy.
  */
  it("arms the card-invariant tripwire so a task-lifecycle reach cannot pass silently", () => {
    const bare = guardTaskInvariants({} as TaskStore) as unknown as Record<string, unknown>;
    expect(() => bare.updateTask).toThrow(/CARD-INVARIANT VIOLATION/);
    expect(() => bare.moveTask).toThrow(/CARD-INVARIANT VIOLATION/);

    const { store } = createStore();
    const guarded = guardTaskInvariants(store) as unknown as Record<string, unknown>;
    expect(typeof guarded.listArtifacts).toBe("function");
    expect(typeof guarded.retractArtifact).toBe("function");
    expect(typeof guarded.restoreArtifact).toBe("function");
  });

  it("refuses a content edit on a retracted artifact with a client error, not a server fault", async () => {
    const { store, registry } = createStore();
    const res = await patch(store, VOID_ID, { content: "Silently rewritten claim." });
    expect(res.status).toBe(400);
    expect(registry.rows.find((row) => row.id === VOID_ID)?.content).toBe("A claim the author withdrew.");
  });
});

/*
FNXC:ArtifactRetraction 2026-11-11-15:12 (RUFU-433):
A retraction only removes a false artifact from an operator's view if the notice reaches the browser. That
path has three independent layers, and the defect this guard exists for was exactly one of them going
missing: `retractArtifactImpl` published `artifact:retracted`, `store.ts` declared it in the event map, and
`useArtifacts` subscribed to it - but `sse.ts` subscribes to the store event-by-event rather than
re-broadcasting the whole bus, so the unregistered event was dropped at the only transport that reaches a
client. The hook's subscription was a dead control and an already-open gallery kept offering a retracted
review artifact as a live tile - i.e. as live merge-grade input - until someone reloaded the view, which is
the precise failure the retraction was built to remove.

Every layer compiles green and every unit test stays green when only the middle one is missing, so the
invariant is asserted structurally across the three files from ONE derived list: the artifact events the
store declares. Adding an artifact event to the store map without wiring both ends therefore fails here
rather than shipping as an invisible no-op. This asserts code constructs (subscriptions and the forward
call), never prose.
*/
describe("artifact live-forwarding wiring", () => {
  const repoRoot = path.resolve(__dirname, "../../../../");
  const read = (relativePath: string) => readFileSync(path.join(repoRoot, relativePath), "utf8");

  const storeSource = read("packages/core/src/store.ts");
  const sseSource = read("packages/dashboard/src/sse.ts");
  const hookSource = read("packages/dashboard/app/hooks/useArtifacts.ts");

  // Derived from the store event map, so the guard cannot be satisfied by a hardcoded list that drifts.
  const artifactEvents = [...storeSource.matchAll(/^\s*"(artifact:[a-z-]+)"\s*:\s*\[/gm)].map((m) => m[1]);

  it("derives a non-empty artifact event set that includes the retraction", () => {
    expect(artifactEvents.length).toBeGreaterThan(0);
    // Without this, renaming the event would vacuously satisfy every loop below.
    expect(artifactEvents).toContain("artifact:retracted");
  });

  for (const event of artifactEvents) {
    it(`forwards ${event} across the SSE transport the browser actually reads`, () => {
      expect(sseSource, `${event} is never subscribed to the store in sse.ts`).toContain(`store.on("${event}",`);
      expect(sseSource, `${event} is subscribed but never unsubscribed (a leaked listener)`).toContain(`store.off("${event}",`);
      // The forward is a template literal in sse.ts, so the source text carries a two-character `\n`, not a newline.
      expect(sseSource, `${event} is subscribed but never sent to the client`).toContain("event: " + event + "\\ndata: ");
    });

    it(`subscribes the artifact gallery to ${event}`, () => {
      expect(hookSource, `useArtifacts never listens for ${event}, so an open gallery cannot react to it`).toContain(`"${event}":`);
    });
  }
});
