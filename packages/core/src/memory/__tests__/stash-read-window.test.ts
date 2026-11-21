/**
 * RUFU-1146 — the Stash read window must be bought BEFORE it is spent.
 *
 * Why this file exists: RUFU-1008 made every Stash read prove project identity on every returned row
 * (correct — Stash partitions by owner, and one operator owns every Fusion project), but it left the
 * request sized by the PAGE: `limit=<asked>` rows from an owner-wide store, then drop what is not
 * ours. Measured on the live server for every scoped read after that card landed
 * (`project.run_audit_events`, `memory:stash-read-scope`): 116 reads, 839 rows answered, 261 kept
 * (31 percent), 33 reads (28 percent) returned an EMPTY page, and ZERO reads filled the requested
 * limit. The repair asks for a wider window, scopes, and only then trims — bounded by what each route
 * validates, with ONE widening request, and with the exact-limit request replayed when a deployed
 * route refuses the wider one.
 *
 * Every case here runs against an in-process Stash stand-in that behaves like the real route: it
 * applies `limit` to the WHOLE store and knows nothing about projects. That is the only geometry in
 * which the defect exists, so a fake that pre-scoped its own answer would prove nothing.
 *
 * Surfaces covered by the invariant "a Stash read returns the page it asked for, never more":
 * `StashMemoryBackend.search()` (keyword and vector branches), `read()`, and the three consumers that
 * build prompts or tool output from it (`searchProjectMemory` = `fn_memory_search`'s entry,
 * `buildPerTurnMemoryRecallCue`, `buildProactiveMemoryCueBlock`).
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  STASH_KEYWORD_SEARCH_SERVER_MAX_LIMIT,
  STASH_SEMANTIC_SEARCH_SERVER_MAX_LIMIT,
  STASH_READ_WINDOW_FACTOR,
  StashMemoryBackend,
  getStashReadScope,
  mergeStashRowsById,
  stashProjectIdentityFor,
  stashReadFetchWindow,
  __resetStashFolderCacheForTests,
  __resetStashReadAuditDedupeForTests,
  __resetStashReadDiagnosticsForTests,
  __resetStashReadScopeAuditDedupeForTests,
  __resetVectorCapabilityCacheForTests,
  type StashReadStoreHost,
} from "../memory-backend-stash.js";
import { buildProactiveMemoryCueBlock, searchProjectMemory } from "../project-memory.js";
import { buildPerTurnMemoryRecallCue, __resetPerTurnRecallDedupForTests } from "../recall/per-turn-recall.js";
import { STASH_SECRET_KEY } from "../stash-settings.js";

const RESOLVED_SECRET = "window-probe-secret";
const KEYWORD_PATH = "/api/v1/me/sessions/events/search";
const SEMANTIC_PATH = "/api/v1/me/sessions/events/semantic-search";
/*
FNXC:StashBroadRecallRoute 2026-11-21-14:28 (RUFU-1152):
The list route — the only Stash read route that answers a request with no `q`. Declaring it here is
what lets this stand-in be route-faithful: `backend/routers/memory.py:146` at the deployed commit
`4585c2d24` validates `q: str = Query(..., min_length=1)`, so a keyword request with an empty `q` is
refused BEFORE any query runs. A stand-in that answered `?q=` as if it were fine is what let a dead
request survive as a frozen contract for three cards.
*/
const RECENT_PATH = "/api/v1/me/sessions/events";

type Row = { id: string; content: string; session_id: string; event_type: string; rank?: number; metadata?: Record<string, unknown> };
type RecordedRequest = { method: string; path: string };

/** The discriminator half of the identity one project claims; foreign rows carry another one. */
const FOREIGN = "gedapp-b4ee5f7bf6";

/** A row exactly as Stash stores it: the identity lives in `metadata.discriminator`. */
function row(discriminator: string, id: string, content: string, rank?: number): Row {
  return {
    id,
    content,
    session_id: `ses-${id}`,
    event_type: "memory",
    ...(rank === undefined ? {} : { rank }),
    metadata: { discriminator },
  };
}

/** `count` foreign rows, so a `limit`-sized window can be filled by rows that are not ours. */
function foreignRows(count: number, from = 0): Row[] {
  return Array.from({ length: count }, (_, i) => row(FOREIGN, `f${from + i}`, `foreign note ${from + i}`));
}

/** `count` rows this project wrote. */
function ownRows(rootDir: string, count: number, from = 0): Row[] {
  const disc = stashProjectIdentityFor(rootDir).discriminator;
  return Array.from({ length: count }, (_, i) => row(disc, `o${from + i}`, `own note ${from + i}`, 0.5));
}

interface StandInOptions {
  /** The whole store. The route answers `store.slice(0, limit)` — it does not scope, like the real one. */
  keywordStore: Row[];
  semanticStore?: Row[];
  /** When set, the keyword route answers `422` for any `limit` above it (a stricter deployed route). */
  refuseKeywordAboveLimit?: number;
  /** Rows the LIST route serves (defaults to the keyword store). */
  recentStore?: StashRow[];
  /** Default true: the keyword route refuses an empty/absent `q` with 422, as the deployed route does. */
  lenientEmptyQ?: boolean;
}

interface StandIn {
  baseUrl: string;
  requests: RecordedRequest[];
  keywordRequests(): RecordedRequest[];
  semanticRequests(): RecordedRequest[];
  recentRequests(): RecordedRequest[];
  close(): Promise<void>;
}

/** An in-process Stash stand-in: owner-wide answers, `limit` respected, no project filter. */
async function startStash(options: StandInOptions): Promise<StandIn> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const path = req.url ?? "";
    requests.push({ method: req.method ?? "", path });
    req.on("data", () => undefined);
    const url = new URL(path, "http://stand-in.invalid");
    const limit = Number(url.searchParams.get("limit") ?? "50");
    if (path.startsWith(SEMANTIC_PATH)) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ results: (options.semanticStore ?? []).slice(0, limit) }));
      return;
    }
    if (path.startsWith(RECENT_PATH) && !path.startsWith(KEYWORD_PATH) && !path.startsWith(SEMANTIC_PATH)) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ events: (options.recentStore ?? options.keywordStore).slice(0, limit), has_more: false }));
      return;
    }
    if (path.startsWith(KEYWORD_PATH)) {
      if (!options.lenientEmptyQ && !(url.searchParams.get("q") ?? "").trim()) {
        // Route-faithful to `q: Query(..., min_length=1)` — the refusal that made broad recall dead.
        res.statusCode = 422;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ detail: "q String required empty" }));
        return;
      }
      if (options.refuseKeywordAboveLimit !== undefined && limit > options.refuseKeywordAboveLimit) {
        // How the real seam surfaces a validation refusal: `Stash returned <status>: <body>`.
        res.statusCode = 422;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ detail: `limit above ${options.refuseKeywordAboveLimit}` }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ results: options.keywordStore.slice(0, limit) }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ detail: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    requests,
    keywordRequests: () => requests.filter((r) => r.path.startsWith(KEYWORD_PATH)),
    semanticRequests: () => requests.filter((r) => r.path.startsWith(SEMANTIC_PATH)),
    recentRequests: () =>
      requests.filter(
        (r) => r.path.startsWith(RECENT_PATH) && !r.path.startsWith(KEYWORD_PATH) && !r.path.startsWith(SEMANTIC_PATH),
      ),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}

/** The `limit=` value of the nth keyword request (0-based). */
function keywordLimitOf(server: StandIn, index: number): string | null {
  const path = server.keywordRequests()[index]?.path ?? "";
  return new URL(path, "http://stand-in.invalid").searchParams.get("limit") ?? null;
}

function settings(baseUrl: string, extra: Record<string, unknown> = {}) {
  return { memoryEnabled: true, memoryBackendType: "stash", stashUrl: baseUrl, stashApiKey: "", ...extra };
}

/** The duck-typed TaskStore the read entries need to resolve the Stash key. */
function secretsHost(): StashReadStoreHost {
  return {
    getSecretsStore: async () => ({
      listSecrets: async () => [{ id: "row-uuid-1", key: STASH_SECRET_KEY }],
      revealSecret: async () => ({ plaintextValue: RESOLVED_SECRET }),
    }),
  } as StashReadStoreHost;
}

/** An empty temp root: the durable file lane contributes nothing, so every row provably came from Stash. */
function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

beforeEach(() => {
  __resetStashReadDiagnosticsForTests();
  __resetStashReadAuditDedupeForTests();
  __resetStashReadScopeAuditDedupeForTests();
  __resetVectorCapabilityCacheForTests();
  __resetStashFolderCacheForTests();
  __resetPerTurnRecallDedupForTests();
});

describe("RUFU-1146 window math (pure)", () => {
  it("sizes the window as a multiple of the page, never below it", () => {
    expect(STASH_READ_WINDOW_FACTOR).toBeGreaterThan(1);
    expect(stashReadFetchWindow(5, 200)).toBe(5 * STASH_READ_WINDOW_FACTOR);
    expect(stashReadFetchWindow(1, 200)).toBe(STASH_READ_WINDOW_FACTOR);
    expect(stashReadFetchWindow(20, 200)).toBe(20 * STASH_READ_WINDOW_FACTOR);
  });

  it("never asks above the ceiling the route itself validates, for either route", () => {
    // 200 and 100 are the `le=` bounds of the deployed keyword and semantic routes; above them a
    // wider window is a 422, i.e. a WORSE read, not a wider one.
    expect(stashReadFetchWindow(200, STASH_KEYWORD_SEARCH_SERVER_MAX_LIMIT)).toBe(200);
    expect(stashReadFetchWindow(1000, STASH_KEYWORD_SEARCH_SERVER_MAX_LIMIT)).toBe(200);
    expect(stashReadFetchWindow(20, STASH_SEMANTIC_SEARCH_SERVER_MAX_LIMIT)).toBe(100);
    expect(stashReadFetchWindow(999, STASH_SEMANTIC_SEARCH_SERVER_MAX_LIMIT)).toBe(100);
  });

  it("merges the wide answer over the narrow one without ever repeating a row", () => {
    const a = row(FOREIGN, "a", "shared row");
    const b = row(FOREIGN, "b", "shared row b");
    const c = row(FOREIGN, "c", "only in the wide answer");
    const merged = mergeStashRowsById([a, b], [a, b, c]);
    expect(merged.map((r) => r.id)).toEqual(["a", "b", "c"]);
    // A row with no `id` falls back to its (session_id, content) pair, so two rows that are the
    // same answer twice stay one row, and two different answers stay two rows.
    const anonymous = [{ content: "first" }, { content: "second" }] as never[];
    expect(mergeStashRowsById(anonymous, anonymous)).toHaveLength(2);
    expect(mergeStashRowsById([row(FOREIGN, "z", "same")], [{ id: "z", content: "relabelled" }])).toHaveLength(1);
  });
});

describe("RUFU-1146 keyword lane fills the page from the wider window", () => {
  let server: StandIn | null = null;
  let root: string | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  function backendFor(): StashMemoryBackend {
    return new StashMemoryBackend({ baseUrl: (server as StandIn).baseUrl, apiKey: RESOLVED_SECRET });
  }

  it("returns the whole page when the first `limit` rows of the store are all foreign", async () => {
    // The reported geometry: 20 other projects' rows sit in front of ours, so the exact-limit
    // request never reaches our own data. Pre-fix this read returned [] (window == page == 5).
    root = tempRoot("rufu1146-fill-");
    server = await startStash({
      keywordStore: [...foreignRows(20), ...ownRows(root, 5), ...foreignRows(40)],
    });
    const hits = await backendFor().search(root, { query: "own note", limit: 5 });
    expect(hits).toHaveLength(5);
    expect(hits.every((h) => h.snippet.startsWith("own note"))).toBe(true);
    expect(hits.some((h) => h.snippet.includes("foreign"))).toBe(false);
    // The window asked for was 6x the page, and the page is what came back.
    expect(keywordLimitOf(server, 0)).toBe(String(5 * STASH_READ_WINDOW_FACTOR));
  });

  it("never returns more rows than the caller asked for", async () => {
    root = tempRoot("rufu1146-trim-");
    server = await startStash({ keywordStore: [...ownRows(root, 25)] });
    const hits = await backendFor().search(root, { query: "own note", limit: 5 });
    expect(hits).toHaveLength(5);
    // A wider window must not silently widen the page the consumer budgets for.
    expect(await backendFor().search(root, { query: "own note", limit: 3 })).toHaveLength(3);
  });

  it("widens ONCE, only when the answer filled the window, and stops at the route ceiling", async () => {
    // Only 2 of the first 30 rows are ours, so the first window cannot fill a 5-page and the
    // widening request is what recovers the rest.
    root = tempRoot("rufu1146-widen-");
    server = await startStash({
      keywordStore: [
        ...foreignRows(14),
        ...ownRows(root, 2),
        ...foreignRows(14, 100),
        ...ownRows(root, 4, 100),
        ...foreignRows(200, 500),
      ],
    });
    const hits = await backendFor().search(root, { query: "own note", limit: 5 });
    expect(hits).toHaveLength(5);
    const requests = server.keywordRequests();
    expect(requests).toHaveLength(2);
    expect(keywordLimitOf(server, 0)).toBe(String(5 * STASH_READ_WINDOW_FACTOR));
    expect(keywordLimitOf(server, 1)).toBe(String(STASH_KEYWORD_SEARCH_SERVER_MAX_LIMIT));
  });

  it("sends NO second request when the answer was shorter than the window (store exhausted)", async () => {
    // 7 rows total: the server could not fill a 30-window, so nothing wider exists for this query and
    // a second call would be pure cost.
    root = tempRoot("rufu1146-exhausted-");
    server = await startStash({ keywordStore: [...foreignRows(4), ...ownRows(root, 3)] });
    const hits = await backendFor().search(root, { query: "own note", limit: 5 });
    expect(hits).toHaveLength(3);
    expect(server.keywordRequests()).toHaveLength(1);
  });

  it("a route that refuses the wide window is answered at the exact limit, not with an empty page", async () => {
    // The pre-fix shape IS the exact-limit request, so a stricter deployed route keeps working and
    // is never left with LESS than it had before this card.
    root = tempRoot("rufu1146-degrade-");
    server = await startStash({
      keywordStore: [...ownRows(root, 5), ...foreignRows(30)],
      refuseKeywordAboveLimit: 5,
    });
    const hits = await backendFor().search(root, { query: "own note", limit: 5 });
    expect(hits).toHaveLength(5);
    expect(server.keywordRequests()).toHaveLength(2);
    expect(keywordLimitOf(server, 0)).toBe(String(5 * STASH_READ_WINDOW_FACTOR));
    expect(keywordLimitOf(server, 1)).toBe("5");
  });

  /*
  FNXC:StashBroadRecallRoute 2026-11-21-14:28 (RUFU-1152):
  This case froze "the empty-query shape is untouched and unwindowed", and the stand-in answered the
  shape. The deployed route never would: `q` has `min_length=1`, so every no-terms read was a 422 and
  `read()`/`exists()` were dead requests wearing a frozen contract. A query with no terms is a recency
  request now, and it gets the same window every other read gets.
  */
  it("sends a no-terms read to the list route, windowed, and never to the route that refuses it", async () => {
    root = tempRoot("rufu1146-legacy-");
    server = await startStash({ keywordStore: [...ownRows(root, 5)] });
    const results = await backendFor().search(root, { query: "", limit: 5 });
    expect(server.keywordRequests()).toHaveLength(0);
    expect(server.recentRequests().map((r) => r.path)).toEqual([
      "/api/v1/me/sessions/events?limit=30&order=desc",
    ]);
    expect(results).toHaveLength(5);
  });

  it("keeps the scoped record's shape and reports the WINDOW as matchedCount", async () => {
    root = tempRoot("rufu1146-record-");
    server = await startStash({ keywordStore: [...foreignRows(20), ...ownRows(root, 5)] });
    const identity = stashProjectIdentityFor(root);
    await backendFor().search(root, { query: "own note", limit: 5 });
    const scope = getStashReadScope(server.baseUrl, identity.discriminator);
    // No new key: RUFU-1008's closed set is the contract the operator surfaces render.
    expect(Object.keys(scope ?? {}).sort()).toEqual(
      ["at", "droppedForeignCount", "droppedUnidentifiedCount", "limit", "matchedCount", "outcome", "ownCount"],
    );
    expect(scope).toMatchObject({
      // `limit` stays the PAGE the caller asked for; `matchedCount` is what the server ANSWERED,
      // which is the window whenever the store holds that many rows (this store holds 25).
      limit: 5,
      matchedCount: 25,
      ownCount: 5,
      outcome: "dropped-foreign",
    });
  });
});

describe("RUFU-1146 vector lane is bounded by its own route and still returns a page", () => {
  let server: StandIn | null = null;
  let root: string | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("asks the semantic route for its window (capped at 100) and trims the page", async () => {
    root = tempRoot("rufu1146-vector-");
    server = await startStash({
      keywordStore: [],
      semanticStore: [...foreignRows(20, 0), ...ownRows(root, 8)],
    });
    const backend = new StashMemoryBackend({
      baseUrl: server.baseUrl,
      apiKey: RESOLVED_SECRET,
      vectorSearch: true,
    });
    const hits = await backend.search(root, { query: "own note count", limit: 5 });
    expect(server.semanticRequests()).toHaveLength(1);
    expect(new URL(server.semanticRequests()[0]!.path, "http://x").searchParams.get("limit")).toBe(
      String(5 * STASH_READ_WINDOW_FACTOR),
    );
    expect(hits).toHaveLength(5);
    expect(hits.every((h) => h.snippet.startsWith("own note"))).toBe(true);
  });

  it("never asks the semantic route above its validated ceiling", async () => {
    root = tempRoot("rufu1146-vector-ceiling-");
    server = await startStash({ keywordStore: [], semanticStore: ownRows(root, 30) });
    const backend = new StashMemoryBackend({ baseUrl: server.baseUrl, apiKey: RESOLVED_SECRET, vectorSearch: true });
    const hits = await backend.search(root, { query: "own note count", limit: 20 });
    expect(new URL(server.semanticRequests()[0]!.path, "http://x").searchParams.get("limit")).toBe("100");
    expect(hits).toHaveLength(20);
  });
});

describe("RUFU-1146 every consumer of the lane gets the page, not the residue", () => {
  let server: StandIn | null = null;
  let root: string | null = null;
  let host: StashReadStoreHost;

  beforeEach(() => {
    host = secretsHost();
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  /** The store all three surfaces are pointed at: our rows sit behind 20 foreign ones. */
  async function storeWithOwnRowsBehindForeignOnes(): Promise<Row[]> {
    root = tempRoot("rufu1146-surface-");
    const store = [...foreignRows(20), ...ownRows(root, 5)];
    server = await startStash({ keywordStore: store });
    return store;
  }

  it("fn_memory_search's entry (searchProjectMemory) returns the 5 own rows", async () => {
    await storeWithOwnRowsBehindForeignOnes();
    const hits = await searchProjectMemory(
      root as string,
      { query: "own note", limit: 5 },
      settings(server!.baseUrl),
      undefined,
      host,
    );
    expect(hits.filter((h) => h.backend === "stash")).toHaveLength(5);
    expect(hits.some((h) => h.snippet.includes("foreign"))).toBe(false);
  });

  it("the per-turn recall cue carries own rows instead of the empty cue that was reported", async () => {
    await storeWithOwnRowsBehindForeignOnes();
    const cue = await buildPerTurnMemoryRecallCue({
      rootDir: root as string,
      topic: "own note",
      settings: settings(server!.baseUrl),
      sessionKey: "chat-rufu1146-recall",
      secretsReader: host,
    });
    // The cue renders what fits its 800-char budget, so the claim at THIS surface is the reported
    // symptom: it used to be empty ("memory: none"), and now it carries our own rows and nothing
    // belonging to another project.
    expect(cue).not.toBe("");
    expect(cue).toContain("own note 0");
    expect(cue).not.toContain("foreign note");
    // This lane asks for its own page (9 rows) rather than the tool default, and the window it buys
    // is 6x that page.
    expect(new URL(server!.keywordRequests()[0]!.path, "http://x").searchParams.get("limit")).toBe(
      String(9 * STASH_READ_WINDOW_FACTOR),
    );
  });

  it("buildProactiveMemoryCueBlock recalls the page too", async () => {
    await storeWithOwnRowsBehindForeignOnes();
    const block = await buildProactiveMemoryCueBlock(
      root as string,
      "own note",
      settings(server!.baseUrl),
      { limit: 5, secretsReader: host },
    );
    expect(block).toContain("own note 0");
    expect(block).toContain("own note 4");
    expect(block).not.toContain("foreign note");
  });

  /*
  FNXC:StashBroadRecallRoute 2026-11-21-14:28 (RUFU-1152):
  RUFU-1146 recorded this as a deliberate boundary — the shape stayed byte-identical, so a store that
  led with other projects' rows yielded nothing at `read()`. Reading the pinned route closed the
  boundary for a harder reason: the frozen shape was refused outright, so `read()` could only ever
  return "". `read()` now travels the recency lane with the same window, which makes that boundary's
  consequence (a pageful of foreign rows, zero own rows, an empty body) unreachable rather than merely
  documented — and keeps the keyword route at zero requests, because asking it with no `q` is the
  failure this card removes.
  */
  it("read() travels the windowed recency lane, so foreign rows cannot empty the body", async () => {
    await storeWithOwnRowsBehindForeignOnes();
    const backend = new StashMemoryBackend({ baseUrl: server!.baseUrl, apiKey: RESOLVED_SECRET });
    const result = await backend.read(root as string);
    const requests = server!.recentRequests();
    expect(requests.map((r) => r.path)).toEqual(["/api/v1/me/sessions/events?limit=60&order=desc"]);
    // The fixture holds 20 foreign rows AHEAD of the 5 own ones, which is exactly the shape that
    // used to empty this body: an unwindowed 10-row page was all foreign, so scoping kept nothing.
    expect(result.exists).toBe(true);
    expect(result.content).toContain("5 memories recalled");
    expect(result.content).toContain("own note 4");
    expect(server!.keywordRequests()).toHaveLength(0);
  });
});
