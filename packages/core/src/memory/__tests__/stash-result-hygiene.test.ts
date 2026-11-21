/**
 * RUFU-1088 — the hygiene pass in the lane, and on the surfaces that render it.
 *
 * `src/__tests__/stash-result-hygiene.test.ts` proves the pure rules. This file proves they are wired
 * into the read path and that the surfaces deliver the cleaned page: the `fn_memory_search` entry
 * (`searchProjectMemory`), the per-turn recall cue, the proactive cue block, and `read()`.
 *
 * The fixture is the measured page, not a paraphrase of it: 2026-11-18T13:58Z, served build
 * `b9d149751f`, query "blanking predikatel" → 10 rows, 9 of them `stash://session/fusion-task-SANE-367`,
 * every snippet the literal `bash`, every score `0.18558138608932495`.
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  STASH_READ_WINDOW_FACTOR,
  StashMemoryBackend,
  getStashReadOutcome,
  stashProjectIdentityFor,
  __resetStashFolderCacheForTests,
  __resetStashReadAuditDedupeForTests,
  __resetStashReadDiagnosticsForTests,
  __resetStashReadScopeAuditDedupeForTests,
  __resetVectorCapabilityCacheForTests,
  type StashReadStoreHost,
} from "../memory-backend-stash.js";
import {
  buildProactiveMemoryCueBlock,
  mergeMemoryFileLayerHits,
  searchProjectMemory,
  stashPageOrderNote,
} from "../project-memory.js";
import { buildPerTurnMemoryRecallCue, __resetPerTurnRecallDedupForTests } from "../recall/per-turn-recall.js";
import { STASH_SECRET_KEY } from "../stash-settings.js";

const SECRET = "hygiene-probe-secret";
const KEYWORD_PATH = "/api/v1/me/sessions/events/search";
/** The constant the deployed image sends, taken from the reported page. */
const CONSTANT_SCORE = 0.18558138608932495;

type Row = {
  id: string;
  content: string;
  session_id: string;
  event_type: string;
  score?: number;
  rank?: number;
  metadata?: Record<string, unknown>;
};

/** A row exactly as Stash returns it, with this project's discriminator unless one is given. */
function row(discriminator: string, id: string, content: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    content,
    session_id: extra.session_id ?? `ses-${id}`,
    event_type: extra.event_type ?? "memory",
    ...(extra.score !== undefined ? { score: extra.score } : {}),
    ...(extra.rank !== undefined ? { rank: extra.rank } : {}),
    metadata: { discriminator },
  };
}

/** The nine `bash` rows from one session that owned the measured page. */
function bashRows(discriminator: string, session: string, count: number): Row[] {
  return Array.from({ length: count }, (_, i) =>
    row(discriminator, `${session}-${i}`, "bash", { session_id: session, event_type: "tool_use", score: CONSTANT_SCORE }),
  );
}

function ownNote(discriminator: string, session: string, text: string, extra: Partial<Row> = {}): Row {
  return row(discriminator, `${session}-note`, text, { session_id: session, ...extra });
}

interface RecordedRequest {
  path: string;
}

async function startStash(store: Row[]): Promise<{
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const path = req.url ?? "";
    requests.push({ path });
    req.on("data", () => undefined);
    const limit = Number(new URL(path, "http://x.invalid").searchParams.get("limit") ?? "50");
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ results: store.slice(0, limit) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}

function settingsFor(baseUrl: string) {
  return { memoryEnabled: true, memoryBackendType: "stash", stashUrl: baseUrl, stashApiKey: "" };
}

function secretsHost(): StashReadStoreHost {
  return {
    getSecretsStore: async () => ({
      listSecrets: async () => [{ id: "row-1", key: STASH_SECRET_KEY }],
      revealSecret: async () => ({ plaintextValue: SECRET }),
    }),
  } as StashReadStoreHost;
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "rufu1088-"));
}

/** One line of the measured page: nine `bash` slots plus their one sibling. */
function measuredPage(own: string): Row[] {
  return [
    ...bashRows(own, "fusion-task-SANE-367", 9),
    ...bashRows(own, "fusion-task-RUFU-180", 1),
    ownNote(own, "ses-alpha", "predikatel sa resetuje pred blanking oknom", { score: CONSTANT_SCORE }),
    ownNote(own, "ses-beta", "blanking pouziva ten isty predikatel", { score: CONSTANT_SCORE }),
  ];
}

beforeEach(() => {
  __resetStashReadDiagnosticsForTests();
  __resetStashReadAuditDedupeForTests();
  __resetStashReadScopeAuditDedupeForTests();
  __resetVectorCapabilityCacheForTests();
  __resetStashFolderCacheForTests();
  __resetPerTurnRecallDedupForTests();
});

describe("RUFU-1088 the lane delivers a usable page", () => {
  let server: Awaited<ReturnType<typeof startStash>> | null = null;
  let root: string | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  /**
   * Opens one lane over one store. The store is built FROM the root the read will ask as, because a
   * store whose rows carry another project's discriminator would be answered by the RUFU-1008 scoping
   * before hygiene ever saw it — which proves a different card.
   */
  async function lane(storeFor: (discriminator: string) => Row[]): Promise<StashMemoryBackend> {
    root = tempRoot();
    server = await startStash(storeFor(stashProjectIdentityFor(root).discriminator));
    return new StashMemoryBackend({ baseUrl: server.baseUrl, apiKey: SECRET });
  }

  it("never hands the agent a `bash` row, and never gives one session the page", async () => {
    const backend = await lane(measuredPage);
    const hits = await backend.search(root as string, { query: "blanking predikatel", limit: 5 });

    // (1) no textless/label-only row survives;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.snippet.trim() !== "" && h.snippet !== "bash")).toBe(true);
    // (2) one row per session — the page is a survey, not a monologue;
    const sessions = hits.map((h) => h.path);
    expect(new Set(sessions).size).toBe(sessions.length);
    // (3) the constant is labelled instead of presented as relevance.
    expect(hits.every((h) => h.rankingSource === "positional")).toBe(true);
  });

  it("keeps one slot per event even when one session sends ten distinct ids", async () => {
    const backend = await lane((own) =>
      Array.from({ length: 10 }, (_, i) =>
        row(own, `e${i}`, `note ${i} from the busy session`, { session_id: "busy", score: 0.5 + i / 100 }),
      ),
    );
    const hits = await backend.search(root as string, { query: "note", limit: 5 });
    expect(hits).toHaveLength(1);
  });

  it("records no-match with a ZERO delivered count when hygiene empties the page", async () => {
    const backend = await lane((own) => bashRows(own, "fusion-task-SANE-367", 9));
    const hits = await backend.search(root as string, { query: "blanking", limit: 5 });
    expect(hits).toEqual([]);
    const outcome = getStashReadOutcome((server as Awaited<ReturnType<typeof startStash>>).baseUrl, "keyword-search");
    expect(outcome).toMatchObject({ code: "no-match", resultCount: 0 });
  });

  it("sends the URL contract RUFU-121 froze and RUFU-1146 widened — hygiene adds no request", async () => {
    const backend = await lane(measuredPage);
    await backend.search(root as string, { query: "blanking predikatel", limit: 5 });
    const requests = (server as Awaited<ReturnType<typeof startStash>>).requests;
    expect(requests).toHaveLength(1);
    // Page 5, window 6x (RUFU-1146). RUFU-1088 buys nothing: it cleans what the window delivered.
    expect(requests[0]!.path).toBe(`/api/v1/me/sessions/events/search?q=blanking&limit=${5 * STASH_READ_WINDOW_FACTOR}`);
  });

  it("read() prints no recalled-count header when every recalled row was a label", async () => {
    const backend = await lane((own) => bashRows(own, "fusion-task-SANE-367", 9));
    const result = await backend.read(root as string);
    expect(result.exists).toBe(false);
    expect(result.content).toBe("");
  });

  it("read() counts the rows it actually delivered", async () => {
    const backend = await lane((own) => [
      ...bashRows(own, "fusion-task-SANE-367", 4),
      ownNote(own, "ses-one", "first real note"),
      ownNote(own, "ses-two", "second real note"),
    ]);
    const result = await backend.read(root as string);
    expect(result.content).toContain("2 memories recalled");
    expect(result.content).not.toContain("bash");
  });
});

describe("RUFU-1088 the consumer surfaces deliver the cleaned page", () => {
  let server: Awaited<ReturnType<typeof startStash>> | null = null;
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

  /** The measured page, on a store the asking project owns. */
  async function measuredSurface(): Promise<string> {
    root = tempRoot();
    server = await startStash(measuredPage(stashProjectIdentityFor(root).discriminator));
    return server.baseUrl;
  }

  it("fn_memory_search's entry: own rows only, one per session, no bare-token row", async () => {
    const baseUrl = await measuredSurface();
    const hits = await searchProjectMemory(
      root as string,
      { query: "blanking predikatel", limit: 5 },
      settingsFor(baseUrl),
      undefined,
      host,
    );
    const stashHits = hits.filter((h) => h.backend === "stash");
    expect(stashHits.length).toBeGreaterThan(0);
    expect(stashHits.every((h) => h.snippet !== "bash" && h.snippet.trim() !== "")).toBe(true);
    expect(new Set(stashHits.map((h) => h.path)).size).toBe(stashHits.length);
  });

  it("buildProactiveMemoryCueBlock: no `(no excerpt)` shell, no score claim, one order note", async () => {
    const baseUrl = await measuredSurface();
    const block = await buildProactiveMemoryCueBlock(
      root as string,
      "blanking predikatel",
      settingsFor(baseUrl),
      { limit: 5, secretsReader: host },
    );
    expect(block).toContain("predikatel sa resetuje");
    expect(block).not.toContain("(no excerpt)");
    expect(block).not.toContain("bash");
    // The constant would have been printed as `(score 0.19)` — a relevance claim about a constant.
    expect(block).not.toContain("(score ");
    expect(block).toContain(stashPageOrderNote([{ path: "p", lineStart: 1, lineEnd: 1, snippet: "s", score: CONSTANT_SCORE, backend: "stash", rankingSource: "positional" }]));
  });

  it("the per-turn recall cue carries no dangling shell line", async () => {
    const baseUrl = await measuredSurface();
    const cue = await buildPerTurnMemoryRecallCue({
      rootDir: root as string,
      topic: "blanking predikatel",
      settings: settingsFor(baseUrl),
      sessionKey: "chat-rufu1088",
      secretsReader: host,
    });
    expect(cue).not.toBe("");
    for (const line of cue.split("\n")) {
      // A rendered entry always ends with text after the em-dash; a shell ends with the dash itself.
      expect(line.endsWith(" — ")).toBe(false);
      expect(line).not.toContain("bash");
    }
  });

  it("mergeMemoryFileLayerHits still reserves the durable-file slot against a cleaned remote page", async () => {
    const remote = [
      { path: "stash://session/ses-alpha", lineStart: 1, lineEnd: 1, snippet: "own note one", score: CONSTANT_SCORE, backend: "stash", rankingSource: "positional" as const },
      { path: "stash://session/ses-beta", lineStart: 1, lineEnd: 1, snippet: "own note two", score: CONSTANT_SCORE, backend: "stash", rankingSource: "positional" as const },
    ];
    const file = [{ path: ".fusion/memory/MEMORY.md", lineStart: 7, lineEnd: 9, snippet: "durable note", score: 1.2, backend: "file" }];
    const merged = mergeMemoryFileLayerHits(remote, file, 2);
    expect(merged.some((h) => h.backend === "file")).toBe(true);
    // The label survives the merge, so the renderer's honesty rule still applies to the merged page.
    expect(merged.filter((h) => h.backend === "stash").every((h) => h.rankingSource === "positional")).toBe(true);
  });
});
