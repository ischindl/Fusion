/**
 * RUFU-1008 — a Stash READ must be verified against the asking project's identity.
 *
 * Why this file exists: Stash partitions its memory store by OWNER, and one operator's Fusion
 * projects all live under one owner. The read route carries no scope filter and ignores undeclared
 * params (re-measured 2026-11-19 against the live server, RUFU-121's inert-param precedent), so
 * `GET /api/v1/me/sessions/events/search?q=…` answers with every project's rows on that account.
 * Before this card the client returned whatever arrived: `fn_memory_search` and the per-turn recall
 * cue handed other projects' lines to the model, and "0 results" was reported for the cards whose
 * answers were entirely foreign.
 *
 * These cases therefore run against an in-process Stash stand-in that behaves like the real one —
 * it answers an unscoped query with rows of SEVERAL discriminators — which is the only way to prove
 * the filter rather than the fixture. Existing Stash tests inject `StashHttpClient`; that seam is
 * used here for the pure/branch cases, and a real `node:http` server (never port 4040) for the four
 * core entries, which resolve their own backend from settings and cannot accept an injected client.
 *
 * Fail-closed contract that must NOT change: a scoped-empty read still resolves to `[]` / `""`, and
 * a report failure — including a hostile audit sink — may never alter a read's result.
 */

import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STASH_READ_SCOPE_MUTATION_TYPE,
  STASH_READ_SCOPE_AUDIT_REFRESH_FLOOR_MS,
  StashMemoryBackend,
  classifyStashReadScope,
  getStashReadScope,
  reportStashReadScope,
  stashProjectIdentityFor,
  __resetStashReadDiagnosticsForTests,
  __resetStashReadAuditDedupeForTests,
  __resetStashReadScopeAuditDedupeForTests,
  __resetVectorCapabilityCacheForTests,
} from "../memory-backend-stash.js";
import type { StashReadStoreHost, StashProjectIdentity } from "../memory-backend-stash.js";
import {
  buildProactiveMemoryCueBlock,
  readProjectMemoryWithBackend,
  searchProjectMemory,
} from "../project-memory.js";
import { buildPerTurnMemoryRecallCue, __resetPerTurnRecallDedupForTests } from "../recall/per-turn-recall.js";
import { STASH_SECRET_KEY } from "../stash-settings.js";

const RESOLVED_SECRET = "scope-probe-secret";
const KEYWORD_PATH = "/api/v1/me/sessions/events/search";
const SEMANTIC_PATH = "/api/v1/me/sessions/events/semantic-search";
/*
FNXC:StashBroadRecallRoute 2026-11-21-14:28 (RUFU-1152): the list route carries the SAME owner-wide
behavior this card is about (it filters by owner, never by Fusion project), so the drop-class counts
must hold there too — that route is where `read()`'s broad recall now runs.
*/
const RECENT_PATH = "/api/v1/me/sessions/events";

type RecordedRequest = { method: string; path: string };
type Row = { id: string; content: string; session_id: string; event_type: string; metadata?: Record<string, unknown> };

interface StandIn {
  baseUrl: string;
  requests: RecordedRequest[];
  /** Rows the keyword route answers with; the server does NOT scope them, exactly like the real one. */
  keywordRows: Row[];
  /** Rows the semantic route answers with. */
  semanticRows: Row[];
  /**
   * When set, decides the keyword rows per request query instead of the static `keywordRows`.
   *
   * FNXC:StashReadScope 2026-11-19-16:08 (RUFU-1008 code review, P2): the per-turn recall runs TWO
   * searches (lane P project keywords, lane T focus terms), and a stand-in that answers every query
   * with the same rows cannot show that the second lane ran at all, let alone what it cost. The real
   * route answers per query, so this makes the stand-in do the same.
   */
  keywordRowsFor?: (query: string) => Row[];
  close(): Promise<void>;
}

async function startStash(
  overrides: Partial<Pick<StandIn, "keywordRows" | "semanticRows" | "keywordRowsFor">> = {},
): Promise<StandIn> {
  const requests: RecordedRequest[] = [];
  const state: Pick<StandIn, "keywordRows" | "semanticRows" | "keywordRowsFor"> = {
    keywordRows: overrides.keywordRows ?? [],
    semanticRows: overrides.semanticRows ?? [],
    keywordRowsFor: overrides.keywordRowsFor,
  };
  const server = http.createServer((req, res) => {
    const path = req.url ?? "";
    requests.push({ method: req.method ?? "", path });
    req.on("data", () => undefined);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    if (path.startsWith(SEMANTIC_PATH)) {
      res.end(JSON.stringify({ results: state.semanticRows }));
      return;
    }
    if (path.startsWith(RECENT_PATH) && !path.startsWith(KEYWORD_PATH) && !path.startsWith(SEMANTIC_PATH)) {
      // Same owner-wide answer as the keyword route, no project filter — the drop class this card
      // counts has to hold on the route `read()` now uses (RUFU-1152).
      res.end(JSON.stringify({ events: state.keywordRows, has_more: false }));
      return;
    }
    if (path.startsWith(KEYWORD_PATH)) {
      const query = new URL(path, "http://stand-in.invalid").searchParams.get("q") ?? "";
      const rows = state.keywordRowsFor ? state.keywordRowsFor(query) : state.keywordRows;
      res.end(JSON.stringify({ results: rows }));
      return;
    }
    res.end(JSON.stringify({ detail: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    get keywordRows() {
      return state.keywordRows;
    },
    set keywordRows(value) {
      state.keywordRows = value;
    },
    get semanticRows() {
      return state.semanticRows;
    },
    set semanticRows(value) {
      state.semanticRows = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}

/** A row as Stash actually stores it: the identity lives in `metadata.discriminator`. */
function rowFrom(identity: StashProjectIdentity | string, id: string, content: string): Row {
  const discriminator = typeof identity === "string" ? identity : identity.discriminator;
  return {
    id,
    content,
    session_id: `ses-${id}`,
    event_type: "memory",
    metadata: { discriminator },
  };
}

type AuditRow = { mutationType: string; agentId: string; target: string; metadata: Record<string, unknown> };

/** The duck-typed TaskStore the resolver needs, plus the audit sink the scope rows land in. */
function readerWithAudit(sink?: (row: AuditRow) => void): StashReadStoreHost & { rows: AuditRow[] } {
  const rows: AuditRow[] = [];
  const host = {
    rows,
    getSecretsStore: async () => ({
      listSecrets: async () => [{ id: "row-uuid-1", key: STASH_SECRET_KEY }],
      revealSecret: async () => ({ plaintextValue: RESOLVED_SECRET }),
    }),
  } as StashReadStoreHost & { rows: AuditRow[] };
  if (!sink) {
    (host as unknown as Record<string, unknown>).recordRunAuditEvent = async (input: AuditRow) => {
      rows.push(input);
      sink?.(input);
    };
  }
  return host;
}

function settings(baseUrl: string, extra: Record<string, unknown> = {}) {
  return { memoryEnabled: true, memoryBackendType: "stash", stashUrl: baseUrl, stashApiKey: "", ...extra };
}

function tempRoot(prefix: string): string {
  // No `.fusion/memory/` inside: the durable file lane must contribute nothing, so every row in
  // every assertion below provably came from the Stash route (RUFU-1010's lane is pinned elsewhere).
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("RUFU-1008 classifyStashReadScope (pure)", () => {
  const rootA = "/repos/projectA";
  const identityA = stashProjectIdentityFor(rootA);
  const identityB = stashProjectIdentityFor("/repos/projectB");

  it("keeps exact identity matches and nothing resembling them", () => {
    const rows = [
      rowFrom(identityA, "own", "ours"),
      rowFrom(identityB, "foreign", "theirs"),
      // A discriminator that merely CONTAINS ours, or is ours plus a suffix: neither is ours.
      { id: "p", content: "prefix lookalike", session_id: "s", event_type: "memory", metadata: { discriminator: `${identityA.discriminator}-extra` } },
      // The write-side session id is a second accepted identity, and only in exact form.
      { id: "sid", content: "by session id", session_id: identityA.sessionId, event_type: "memory" },
      { id: "sidf", content: "session id prefix", session_id: `${identityA.sessionId}-x`, event_type: "memory" },
    ];
    const r = classifyStashReadScope(rows, identityA);
    expect(r.kept.map((k) => k.id)).toEqual(["own", "sid"]);
    expect(r.ownCount).toBe(2);
    // "foreign" means the row NAMES another project. `sidf` names none - it has no metadata at all -
    // so it lands in the unidentified class rather than being guessed at from its session id.
    expect(r.foreignCount).toBe(2);
    expect(r.unidentifiedCount).toBe(1);
    expect(r.outcome).toBe("dropped-foreign");
  });

  it("an empty answer is all-own with zero counts, not a drop", () => {
    const r = classifyStashReadScope([], identityA);
    expect(r).toMatchObject({ kept: [], ownCount: 0, foreignCount: 0, unidentifiedCount: 0, outcome: "all-own" });
  });

  it("a row with metadata but no discriminator is unidentified, not assumed ours", () => {
    const rows = [
      { id: "cur", content: "stash curator row", session_id: "agent-curate-1", event_type: "memory", metadata: { project: "other" } },
      // metadata absent entirely behaves the same way: nothing proves it, so it is not returned.
      { id: "bare", content: "no metadata", session_id: "ses-x", event_type: "memory" },
    ];
    const r = classifyStashReadScope(rows, identityA);
    expect(r.kept).toHaveLength(0);
    expect(r.unidentifiedCount).toBe(2);
    expect(r.foreignCount).toBe(0);
    expect(r.outcome).toBe("dropped-unidentified");
  });

  it("names the foreign class when both classes are present", () => {
    const rows = [
      rowFrom(identityB, "f", "foreign"),
      { id: "u", content: "unattributable", session_id: "s", event_type: "memory", metadata: { topic: "x" } },
    ];
    expect(classifyStashReadScope(rows, identityA).outcome).toBe("dropped-foreign");
  });

  it("identity is derived from the root alone and is stable across calls", () => {
    expect(stashProjectIdentityFor(rootA)).toEqual(stashProjectIdentityFor(rootA));
    // The two halves are the two things the write lane stamps; nothing else may be trusted.
    expect(identityA.discriminator).toBe("projectA-" + identityA.discriminator.split("-").pop());
    expect(identityA.sessionId).toBe(`fusion-${identityA.discriminator}`.slice(0, 64));
  });
});

describe("RUFU-1008 StashMemoryBackend read scoping (injected transport)", () => {
  const rootA = "/repos/projectA";
  const rootB = "/repos/projectB";
  const identityA = stashProjectIdentityFor(rootA);
  const identityB = stashProjectIdentityFor(rootB);

  beforeEach(() => {
    __resetStashReadDiagnosticsForTests();
    __resetStashReadAuditDedupeForTests();
    __resetStashReadScopeAuditDedupeForTests();
    __resetVectorCapabilityCacheForTests();
  });

  /**
   * Backend over a recorder that answers with whatever rows the case names.
   *
   * FNXC:StashReadScope 2026-11-19-16:08 (RUFU-1008 code review, P1): a case may also pass an ARRAY
   * of batches — one per keyword call, the last batch repeating — because the record's stickiness is
   * only observable across reads whose classifications DIFFER (drop, then all-own).
   */
  function backendWith(rows: Row[] | Row[][], opts: { vectorSearch?: boolean } = {}) {
    const batches = rows.length > 0 && Array.isArray(rows[0]) ? (rows as Row[][]) : [rows as Row[]];
    const paths: string[] = [];
    let keywordCalls = 0;
    const backend = new StashMemoryBackend({
      baseUrl: "http://stash.test",
      apiKey: "k",
      vectorSearch: opts.vectorSearch,
      httpClient: async (path) => {
        paths.push(path);
        const answer = batches[Math.min(keywordCalls, batches.length - 1)];
        if (path.startsWith(KEYWORD_PATH)) keywordCalls += 1;
        return { results: answer };
      },
    });
    return { backend, paths };
  }

  it("returns own rows and drops another project's rows from the same answer", async () => {
    const { backend } = backendWith([rowFrom(identityA, "a", "project A note"), rowFrom(identityB, "b", "project B secret")]);
    const hits = await backend.search(rootA, { query: "note", limit: 5 });
    expect(hits.map((h) => h.snippet)).toEqual(["project A note"]);
    const scope = getStashReadScope("http://stash.test", identityA.discriminator);
    expect(scope).toMatchObject({ outcome: "dropped-foreign", matchedCount: 2, ownCount: 1, droppedForeignCount: 1, droppedUnidentifiedCount: 0, limit: 5 });
  });

  it("an answer made only of foreign rows is empty — the fail-closed contract holds", async () => {
    const { backend } = backendWith([rowFrom(identityB, "b", "project B secret")]);
    await expect(backend.search(rootA, { query: "secret", limit: 5 })).resolves.toEqual([]);
    expect(getStashReadScope("http://stash.test", identityA.discriminator)?.outcome).toBe("dropped-foreign");
  });

  it("the semantic branch is scoped too (vector-first must not bypass the filter)", async () => {
    // Vector on, and the SEMANTIC route is the one that answers with foreign rows: if scoping lived
    // only on the keyword route, these rows would reach the caller untouched.
    const { backend, paths } = backendWith([rowFrom(identityB, "v", "foreign semantic hit")], { vectorSearch: true });
    const hits = await backend.search(rootA, { query: "vector hit", limit: 5 });
    expect(hits.filter((h) => h.snippet.includes("foreign semantic hit"))).toEqual([]);
    expect(paths.some((p) => p.startsWith(SEMANTIC_PATH))).toBe(true);
    expect(getStashReadScope("http://stash.test", identityA.discriminator)?.droppedForeignCount).toBeGreaterThanOrEqual(1);
  });

  it("a later all-own read cannot un-report an earlier drop for the same pair (two-lane ordering)", async () => {
    /*
    FNXC:StashReadScope 2026-11-19-16:08 (RUFU-1008 code review, P1):
    `buildPerTurnMemoryRecallCue()` searches twice and reports once, so whatever the SECOND search
    classified is what a last-write-wins record would show. This is that geometry in its cheapest
    form: one read that dropped a foreign row, then one clean read. If the clean read may overwrite
    the record, the leak stops being reportable the moment a focus query happens to answer cleanly —
    on the lane that produced the reported symptom.
    */
    const { backend } = backendWith([
      [rowFrom(identityB, "b", "foreign"), rowFrom(identityA, "a", "ours")],
      [rowFrom(identityA, "a2", "ours only")],
    ]);
    await backend.search(rootA, { query: "note", limit: 5 });
    const dropped = getStashReadScope("http://stash.test", identityA.discriminator);
    expect(dropped).toMatchObject({ outcome: "dropped-foreign", ownCount: 1, droppedForeignCount: 1 });
    const earnedAt = dropped!.at;
    const hits = await backend.search(rootA, { query: "ours", limit: 5 });
    // The clean read still returns its own row — stickiness is a reporting fact, never a data filter.
    expect(hits.map((h) => h.snippet)).toEqual(["ours only"]);
    expect(getStashReadScope("http://stash.test", identityA.discriminator)).toMatchObject({
      outcome: "dropped-foreign",
      ownCount: 1,
      droppedForeignCount: 1,
    });
    // `at` names the read that DROPPED, not the newest read: a reader must be able to weigh staleness.
    expect(getStashReadScope("http://stash.test", identityA.discriminator)?.at).toBe(earnedAt);
  });

  it("sends no scope parameter of its own — the param is inert, so claiming it would lie", async () => {
    const { backend, paths } = backendWith([rowFrom(identityA, "a", "ours")]);
    await backend.search(rootA, { query: "ours", limit: 4 });
    const searchPath = paths.find((p) => p.startsWith(KEYWORD_PATH))!;
    // No folder id, no discriminator, no project name: the server ignores undeclared params, and an
    // inert param would advertise an enforcement that does not exist (RUFU-121's finding).
    expect(searchPath).not.toMatch(/session_folder_id|discriminator|project|namespace/i);
    expect(searchPath).toContain("q=ours");
  });

  it("read() is scoped too, because it goes through search()", async () => {
    const { backend } = backendWith([rowFrom(identityB, "b", "another project's body")]);
    const r = await backend.read(rootA);
    expect(r.exists).toBe(false);
    expect(r.content).toBe("");
  });

  it("exists() stays an unscoped reachability probe and leaves the scope record alone", async () => {
    const { backend } = backendWith([rowFrom(identityB, "b", "foreign")]);
    // Only `?q=` traffic counts toward the pair, so nothing may be recorded before a real search.
    expect(getStashReadScope("http://stash.test", identityA.discriminator)).toBeNull();
    await expect(backend.exists(rootA)).resolves.toBe(true);
    expect(getStashReadScope("http://stash.test", identityA.discriminator)).toBeNull();
  });

  it("counters are keyed by (server, project): reading as B does not speak for A", async () => {
    const { backend } = backendWith([rowFrom(identityA, "a", "A note"), rowFrom(identityB, "b", "B note")]);
    await backend.search(rootA, { query: "note", limit: 5 });
    await backend.search(rootB, { query: "note", limit: 5 });
    // Same server, same answer: each project saw its own one row and dropped the other's.
    expect(getStashReadScope("http://stash.test", identityA.discriminator)).toMatchObject({ ownCount: 1, droppedForeignCount: 1 });
    expect(getStashReadScope("http://stash.test", identityB.discriminator)).toMatchObject({ ownCount: 1, droppedForeignCount: 1 });
    // And a project nobody read for has no record, rather than a borrowed one.
    expect(getStashReadScope("http://stash.test", stashProjectIdentityFor("/repos/projectC").discriminator)).toBeNull();
    // An incomplete key never resolves: no discriminator means "every project on this server", which
    // is the ambiguity the record exists to remove.
    expect(getStashReadScope("http://stash.test")).toBeNull();
  });
});

describe("RUFU-1008 the four core entries report the drop class", () => {
  let server: StandIn | null = null;
  let root: string | null = null;
  let host: StashReadStoreHost & { rows: AuditRow[] };

  const identityOf = (dir: string) => stashProjectIdentityFor(dir);

  beforeEach(() => {
    __resetStashReadDiagnosticsForTests();
    __resetStashReadAuditDedupeForTests();
    __resetStashReadScopeAuditDedupeForTests();
    __resetVectorCapabilityCacheForTests();
    __resetPerTurnRecallDedupForTests();
    host = readerWithAudit();
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  function scopeRows(): AuditRow[] {
    return host.rows.filter((r) => r.mutationType === STASH_READ_SCOPE_MUTATION_TYPE);
  }

  it("fn_memory_search's entry: own row returned, foreign dropped, class counted", async () => {
    root = tempRoot("rufu1008-search-");
    server = await startStash({
      keywordRows: [rowFrom(identityOf(root), "own", "our container note"), rowFrom("dgx_spark-3346c25997", "x", "foreign VLLM note")],
    });
    const hits = await searchProjectMemory(root, { query: "container note", limit: 5 }, settings(server.baseUrl), undefined, host);
    expect(hits.map((h) => h.snippet)).toEqual(["our container note"]);
    expect(hits.some((h) => h.snippet.includes("foreign"))).toBe(false);
    const scope = getStashReadScope(server.baseUrl, identityOf(root).discriminator);
    expect(scope).toMatchObject({ outcome: "dropped-foreign", ownCount: 1, droppedForeignCount: 1 });
    expect(scopeRows()).toHaveLength(1);
  });

  it("an entirely foreign answer recalls as empty AND says so (the two truths separate)", async () => {
    root = tempRoot("rufu1008-foreign-");
    server = await startStash({ keywordRows: [rowFrom("gedapp-b4ee5f7bf6", "x", "another project's GEDA note")] });
    await expect(searchProjectMemory(root, { query: "GEDA", limit: 5 }, settings(server.baseUrl), undefined, host)).resolves.toEqual([]);
    expect(scopeRows()[0]?.metadata).toMatchObject({ outcome: "dropped-foreign", ownCount: 0, droppedForeignCount: 1 });
  });

  it("the per-turn recall cue stays empty for a foreign answer and still records the class", async () => {
    root = tempRoot("rufu1008-recall-");
    server = await startStash({ keywordRows: [rowFrom("dgx_spark-3346c25997", "x", "foreign body")] });
    const cue = await buildPerTurnMemoryRecallCue({
      rootDir: root,
      topic: "foreign body",
      settings: settings(server.baseUrl),
      sessionKey: "chat-rufu1008-scope",
      secretsReader: host,
    });
    expect(cue).toBe("");
    expect(scopeRows().map((r) => r.metadata.outcome)).toEqual(["dropped-foreign"]);
  });

  /*
  FNXC:StashReadScope 2026-11-19-16:08 (RUFU-1008 code review, P1 + P2):
  The per-turn recall is the lane that produced the reported symptom, and it is the only entry here
  that searches TWICE per invocation (lane P project keywords, lane T focus terms) while reporting
  ONCE. Two things had gone unproven before this case:
  - lane T never ran in any two-identity reproduction (no `focus` was passed, so the second search
    never happened and only lane P's filtering was covered);
  - a clean lane T answer used to overwrite lane P's drop class in the record, and `reportStashReadScope`
    returns immediately on `all-own`, so the leak would have left no audit row, no warn line, and no
    number on either operator surface.
  The stand-in answers per query, so a foreign row for lane P's query and an own row for lane T's
  focus query is exactly the geometry the operator measured.
  */
  it("per-turn recall BOTH lanes: a clean lane T answer cannot un-report lane P's foreign drop", async () => {
    root = tempRoot("rufu1008-twolane-");
    const own = identityOf(root);
    const foreignDiscriminator = "gedapp-b4ee5f7bf6";
    server = await startStash({
      keywordRowsFor: (query) =>
        query.toLowerCase().includes("geda")
          ? [rowFrom(own, "own-t", "own focus note")]
          : [rowFrom(own, "own-p", "own project note"), rowFrom(foreignDiscriminator, "x", "foreign GEDA spec body")],
    });
    const cue = await buildPerTurnMemoryRecallCue({
      rootDir: root,
      topic: "project note",
      focus: "geda spec",
      settings: settings(server.baseUrl),
      sessionKey: "chat-rufu1008-twolane",
      secretsReader: host,
    });
    // The second search really ran: without it this case would prove nothing about lane T.
    const keywordRequests = server.requests.filter((r) => r.path.startsWith(KEYWORD_PATH));
    expect(keywordRequests).toHaveLength(2);
    expect(keywordRequests[1]!.path).toContain("OR");
    // Both own rows reached the cue, and nothing foreign did — for either lane.
    expect(cue).toContain("own project note");
    expect(cue).toContain("own focus note");
    expect(cue).not.toContain("foreign GEDA spec body");
    expect(cue).not.toContain("stash://session/ses-x");
    // The class survives lane T's all-own read, on the surface each consumer reads.
    expect(getStashReadScope(server.baseUrl, own.discriminator)).toMatchObject({
      outcome: "dropped-foreign",
      ownCount: 1,
      droppedForeignCount: 1,
    });
    const rows = scopeRows();
    expect(rows.map((r) => r.metadata.outcome)).toEqual(["dropped-foreign"]);
    expect(rows[0]!.metadata).toMatchObject({ droppedForeignCount: 1, ownCount: 1 });
  });

  it("the executor session-start cue reports the class too", async () => {
    root = tempRoot("rufu1008-cue-");
    server = await startStash({ keywordRows: [rowFrom("gedapp-b4ee5f7bf6", "x", "foreign")] });
    const block = await buildProactiveMemoryCueBlock(root, "foreign", settings(server.baseUrl), { limit: 5, secretsReader: host });
    expect(block).toBe("");
    expect(scopeRows()).toHaveLength(1);
  });

  it("readProjectMemoryWithBackend reports what its broad read dropped", async () => {
    root = tempRoot("rufu1008-read-");
    server = await startStash({ keywordRows: [rowFrom("other-proj-0000000000", "x", "not ours")] });
    await expect(readProjectMemoryWithBackend(root, settings(server.baseUrl), host)).resolves.toBe("");
    expect(scopeRows()).toHaveLength(1);
  });

  it("an all-own read writes NO row (routine traffic must not bury the drops)", async () => {
    root = tempRoot("rufu1008-allown-");
    server = await startStash({ keywordRows: [rowFrom(identityOf(root), "own", "ours")] });
    await expect(searchProjectMemory(root, { query: "ours", limit: 5 }, settings(server.baseUrl), undefined, host)).resolves.toHaveLength(1);
    expect(getStashReadScope(server.baseUrl, identityOf(root).discriminator)?.outcome).toBe("all-own");
    expect(scopeRows()).toEqual([]);
  });

  it("a server that answers nothing writes no row either", async () => {
    root = tempRoot("rufu1008-empty-");
    server = await startStash({ keywordRows: [] });
    await expect(searchProjectMemory(root, { query: "nothing", limit: 5 }, settings(server.baseUrl), undefined, host)).resolves.toEqual([]);
    expect(scopeRows()).toEqual([]);
  });

  it("a row whose metadata carries no discriminator is counted as unidentified, never assumed ours", async () => {
    root = tempRoot("rufu1008-unident-");
    server = await startStash({
      keywordRows: [{ id: "cur", content: "curator row", session_id: "agent-curate-9", event_type: "memory", metadata: { project: "someone" } }],
    });
    await expect(searchProjectMemory(root, { query: "curator", limit: 5 }, settings(server.baseUrl), undefined, host)).resolves.toEqual([]);
    const rows = scopeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ outcome: "dropped-unidentified", ownCount: 0, droppedForeignCount: 0, droppedUnidentifiedCount: 1 });
  });

  it("writes one row per (server, project, class) inside the floor, not one per turn", async () => {
    root = tempRoot("rufu1008-dedupe-");
    server = await startStash({ keywordRows: [rowFrom("gedapp-b4ee5f7bf6", "x", "foreign")] });
    const identity = identityOf(root);
    await searchProjectMemory(root, { query: "GEDA", limit: 5 }, settings(server.baseUrl), undefined, host);
    await searchProjectMemory(root, { query: "GEDA again", limit: 5 }, settings(server.baseUrl), undefined, host);
    expect(scopeRows()).toHaveLength(1);
    // Same host, only the clock moved: past the floor the same drop becomes countable again.
    reportStashReadScope(host, server.baseUrl, identity, {
      outcome: "dropped-foreign",
      matchedCount: 1,
      ownCount: 0,
      droppedForeignCount: 1,
      droppedUnidentifiedCount: 0,
      limit: 5,
      at: Date.now(),
    }, { nowMs: Date.now() + STASH_READ_SCOPE_AUDIT_REFRESH_FLOOR_MS + 1 });
    expect(scopeRows()).toHaveLength(2);
  });

  it("the row carries counts and one class only — no URL, no row text, no other project's name", async () => {
    root = tempRoot("rufu1008-metadata-");
    const foreignDiscriminator = "dgx_spark-3346c25997";
    server = await startStash({ keywordRows: [rowFrom(foreignDiscriminator, "evt-77", "a foreign note body")] });
    await searchProjectMemory(root, { query: "foreign", limit: 5 }, settings(server.baseUrl), undefined, host);
    const rows = scopeRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.agentId).toBe("memory-read");
    expect(row.target).toBe("stash-memory");
    // The closed set, exactly. No `endpoint`: the counts are taken after both branches were scoped.
    expect(Object.keys(row.metadata).sort()).toEqual([
      "droppedForeignCount",
      "droppedUnidentifiedCount",
      "limit",
      "matchedCount",
      "outcome",
      "ownCount",
    ]);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(server.baseUrl);
    expect(serialized).not.toContain(RESOLVED_SECRET);
    expect(serialized).not.toContain("a foreign note body");
    expect(serialized).not.toContain(foreignDiscriminator);
    expect(serialized).not.toContain("evt-77");
  });

  const HOSTILE_SINKS: Array<[string, Record<string, unknown>]> = [
    ["absent sink", {}],
    ["throwing sink", { recordRunAuditEvent: () => { throw new Error("sink exploded"); } }],
    ["rejecting sink", { recordRunAuditEvent: () => Promise.reject(new Error("nope")) }],
    ["never-settling sink", { recordRunAuditEvent: () => new Promise(() => undefined) }],
  ];

  it.each(HOSTILE_SINKS)("hostile audit sink (%s) cannot change the read or the recorded class", async (_label, sink) => {
    root = tempRoot("rufu1008-hostile-");
    const reader = readerWithAudit();
    Object.assign(reader, sink);
    server = await startStash({ keywordRows: [rowFrom("gedapp-b4ee5f7bf6", "x", "foreign")] });
    const hits = await searchProjectMemory(root, { query: "GEDA", limit: 5 }, settings(server.baseUrl), undefined, reader);
    expect(hits).toEqual([]);
    expect(getStashReadScope(server.baseUrl, identityOf(root).discriminator)?.outcome).toBe("dropped-foreign");
  });

  it("identity used by the read is the identity the write lane stamps (AC4 parity)", async () => {
    root = tempRoot("rufu1008-parity-");
    type WrittenEvent = { content?: string; session_id?: string; metadata?: Record<string, unknown> };
    const written: WrittenEvent[] = [];
    const backend = new StashMemoryBackend({
      baseUrl: "http://stash.test",
      apiKey: "k",
      httpClient: async (path, method, payload) => {
        if (method === "POST" && path.includes("/events/batch") && payload && typeof payload === "object") {
          const events = (payload as { events?: WrittenEvent[] }).events;
          if (events) written.push(...events);
          return { inserted: events?.length ?? 0 };
        }
        // The read answers with what was written — the way a real Stash does for one owner.
        return {
          results: written.map((e, i) => ({
            id: `w-${i}`,
            content: e.content ?? "",
            session_id: e.session_id ?? "ses-w",
            event_type: "memory",
            metadata: e.metadata,
          })),
        };
      },
    });
    const identity = stashProjectIdentityFor(root);
    // The real write signature: `write(rootDir, content, meta?)` — the identity is what the backend
    // DERIVES from the root, and `meta` carries project classification, not identity.
    const res = await backend.write(root, "written body", { projectId: "proj-1", projectName: "projectA" });
    expect(res.success).toBe(true);
    expect(written.length).toBeGreaterThan(0);
    expect((written[0]!.metadata ?? {}).discriminator).toBe(identity.discriminator);
    expect(written[0]!.session_id).toBe(identity.sessionId);
    const hit = await backend.search(root, { query: "written", limit: 5 });
    // One function derives both sides, so a row this root wrote is a row this root reads back — and
    // the body that comes back is the body that went in, not a fixture string.
    expect(hit.map((h) => h.snippet)).toEqual(["written body"]);
    // And the mirror image: another root cannot read this root's row off the same account.
    await expect(backend.search("/repos/a-different-project", { query: "written", limit: 5 })).resolves.toEqual([]);
  });
});
