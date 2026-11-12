/**
 * RUFU-994 — Stash memory READ paths must carry the resolved API key on the wire.
 *
 * Why this file exists (and why it does NOT use the `httpClient` recorder fake):
 * every existing Stash test injects `StashHttpClient`, which receives
 * `(path, method, payload)` and therefore CANNOT observe the `Authorization`
 * header. The defect this file pins — reads leaving without a credential while
 * writes carry it — is invisible to that fake, which is exactly how it survived
 * 8320 successful writes against 2334 refused reads. These tests therefore drive
 * the REAL transport (`stashHttpJsonRequest`) against an in-process
 * `node:http` server bound to `127.0.0.1:0`, the only seam that can see a header.
 *
 * Fail-closed contract that must NOT change here: a refused read still resolves
 * to `[]` / `""` / `false`. This file asserts the credential and the wire shape,
 * never a thrown error.
 */

import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureMemoryFileWithBackend,
  readProjectMemoryWithBackend,
  searchProjectMemory,
} from "../project-memory.js";
import { buildPerTurnMemoryRecallCue } from "../recall/per-turn-recall.js";
import {
  StashMemoryBackend,
  STASH_READ_REFUSAL_MUTATION_TYPE,
  STASH_READ_REFUSAL_AUDIT_REFRESH_FLOOR_MS,
  getStashReadOutcome,
  reportStashReadOutcome,
  __resetStashReadDiagnosticsForTests,
  __resetStashReadAuditDedupeForTests,
  __resetVectorCapabilityCacheForTests,
} from "../memory-backend-stash.js";
import type { StashReadStoreHost } from "../memory-backend-stash.js";
import { STASH_SECRET_KEY } from "../stash-settings.js";

/** The audit half of the store host a read entry holds (a TaskStore carries both halves). */
type AuditHost = {
  recordRunAuditEvent?: (input: Record<string, unknown>) => unknown;
  recordRunAuditEventBuffered?: (input: Record<string, unknown>) => {
    accepted: boolean;
    queued: boolean;
    spilled: boolean;
    queueDepth: number;
  };
};
import type { StashSecretsReader } from "../stash-settings.js";

/** The key the global `stash-api-key` secret row holds. Distinct from any settings value. */
const RESOLVED_SECRET = "resolved-from-global-secret-store";
const BEARER_RESOLVED = `Bearer ${RESOLVED_SECRET}`;

const BATCH_PATH = "/api/v1/me/sessions/events/batch";
const KEYWORD_PATH = "/api/v1/me/sessions/events/search";
const SEMANTIC_PATH = "/api/v1/me/sessions/events/semantic-search";

interface RecordedRequest {
  method: string;
  path: string;
  /** Raw `authorization` header, or null when the client sent none. */
  authorization: string | null;
}

interface LoopbackStash {
  /** Base URL for `stashUrl` settings (no trailing slash). */
  baseUrl: string;
  requests: RecordedRequest[];
  /**
   * Flip to `true` to model the operator fixing the credential/grant mid-process (Step 5). The
   * server is a closure over this object, so recovery needs no restart — which is the point.
   */
  allowsAuthorizedReads: boolean;
  /** Flip to `false` to model a semantic-search route that has come back. */
  refuseSemanticOnly: boolean;
  close(): Promise<void>;
}

/**
 * In-process Stash stand-in on an ephemeral loopback port (never 4040).
 *
 * Mirrors the real server's auth shape, verified read-only against
 * `/home/schindler/git/stash`: `get_current_user` raises 401
 * "Missing Authorization header" when the header is absent, and the same
 * dependency guards `/events/batch` and both search routes.
 *
 * `refuseEvenWhenAuthed` models a server that rejects a VALID key on the read
 * routers (the alternative Step 0 had to disprove); `emptyResults` models the
 * honest "nothing stored" state that must stay distinguishable from a refusal.
 */
async function startLoopbackStash(
  opts: { refuseEvenWhenAuthed?: boolean; emptyResults?: boolean; refuseSemanticOnly?: boolean } = {},
): Promise<LoopbackStash> {
  const requests: RecordedRequest[] = [];
  const state: Pick<LoopbackStash, "allowsAuthorizedReads" | "refuseSemanticOnly"> = {
    allowsAuthorizedReads: !opts.refuseEvenWhenAuthed,
    refuseSemanticOnly: opts.refuseSemanticOnly ?? false,
  };
  const server = http.createServer((req, res) => {
    const path = req.url ?? "";
    const authorization = req.headers.authorization ?? null;
    requests.push({ method: req.method ?? "", path, authorization });
    // Drain any request body so the client's `req.end()` completes.
    req.on("data", () => undefined);

    const accepted = authorization === BEARER_RESOLVED && state.allowsAuthorizedReads;
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };

    if (path.startsWith(BATCH_PATH)) {
      // Writes prove the credential: a valid key answers 201, a missing one 401.
      accepted ? send(201, { inserted: 1 }) : send(401, { detail: "Missing Authorization header" });
      return;
    }
    if (path.startsWith(KEYWORD_PATH) || path.startsWith(SEMANTIC_PATH)) {
      const semantic = path.startsWith(SEMANTIC_PATH);
      if (!accepted || (semantic && state.refuseSemanticOnly)) {
        send(401, { detail: "Missing Authorization header" });
        return;
      }
      send(200, {
        results: opts.emptyResults
          ? []
          : [{ id: "ev-1", session_id: "ses-1", content: "recalled memory body", event_type: "memory" }],
      });
      return;
    }
    send(404, { detail: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    // Same object identity the request handler closes over, so a test flip takes effect at once.
    get allowsAuthorizedReads() {
      return state.allowsAuthorizedReads;
    },
    set allowsAuthorizedReads(value: boolean) {
      state.allowsAuthorizedReads = value;
    },
    get refuseSemanticOnly() {
      return state.refuseSemanticOnly;
    },
    set refuseSemanticOnly(value: boolean) {
      state.refuseSemanticOnly = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}

/**
 * The duck-typed `TaskStore` surface the single resolver needs
 * (`resolveStashMemorySettings`): a global secret row whose display key is
 * `stash-api-key`, resolved to its row UUID then revealed.
 */
function secretsReaderReturning(
  plaintext: string,
  reveal = () => undefined,
  audit?: Partial<AuditHost>,
): StashReadStoreHost & AuditHost {
  return {
    getSecretsStore: async () => ({
      listSecrets: async () => [{ id: "row-uuid-1", key: STASH_SECRET_KEY }],
      revealSecret: async () => {
        reveal();
        return { plaintextValue: plaintext };
      },
    }),
    ...(audit ? { recordRunAuditEvent: audit.recordRunAuditEvent } : {}),
    recordRunAuditEventBuffered: audit?.recordRunAuditEventBuffered,
  };
}

/**
 * Operator-shaped settings: the documented normal case. `stashApiKey` is the
 * schema default empty string (no UI field ever writes it), so the ONLY possible
 * credential is the global secret.
 */
function readPathSettings(baseUrl: string, extra: Record<string, unknown> = {}) {
  return {
    memoryEnabled: true,
    memoryBackendType: "stash",
    stashUrl: baseUrl,
    stashApiKey: "",
    ...extra,
  };
}

function paths(server: LoopbackStash, prefix: string): RecordedRequest[] {
  return server.requests.filter((r) => r.path.startsWith(prefix));
}

describe("RUFU-994 Stash read paths carry the resolved key on the wire", () => {
  let server: LoopbackStash | null = null;
  let scratchRoot: string | null = null;

  beforeEach(() => {
    // Every map here is per-process. The vector suppression window is keyed by baseUrl and now
    // survives a refused 401, so a case that leaves it set would skip its own next request.
    __resetStashReadDiagnosticsForTests();
    __resetStashReadAuditDedupeForTests();
    __resetVectorCapabilityCacheForTests();
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
    scratchRoot = null;
  });

  function scratchProjectRoot(): string {
    scratchRoot = mkdtempSync(join(tmpdir(), "rufu994-"));
    return scratchRoot;
  }

  it("keyword search() sends the same Bearer credential the batch write sends", async () => {
    server = await startLoopbackStash();
    const reader = secretsReaderReturning(RESOLVED_SECRET);
    const settings = readPathSettings(server.baseUrl);

    const hits = await searchProjectMemory(
      "/project",
      { query: "alpha beta", limit: 5 },
      settings,
      undefined,
      reader,
    );

    // The write side is the reference credential path — the one that measured 8320 x 201.
    // It is a key-holding backend by construction, so its 201 answers are the baseline
    // the read paths must match byte-for-byte on the header.
    await new StashMemoryBackend({ baseUrl: server.baseUrl, apiKey: RESOLVED_SECRET }).write(
      "/project",
      "memory body",
    );
    const writes = paths(server, BATCH_PATH);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.authorization).toBe(BEARER_RESOLVED);

    const reads = paths(server, KEYWORD_PATH);
    expect(reads).toHaveLength(1);
    // The invariant: a read never leaves without the resolved credential.
    expect(reads[0]!.authorization).toBe(BEARER_RESOLVED);
    expect(hits).toHaveLength(1);
  });

  it("semantic-search (stashVectorSearch on, multi-word query) sends the credential too", async () => {
    server = await startLoopbackStash();
    const reader = secretsReaderReturning(RESOLVED_SECRET);
    const settings = readPathSettings(server.baseUrl, { stashVectorSearch: true });

    await searchProjectMemory(
      "/project",
      { query: "alpha beta gamma", limit: 5 },
      settings,
      undefined,
      reader,
    );

    const semantic = paths(server, SEMANTIC_PATH);
    expect(semantic).toHaveLength(1);
    expect(semantic[0]!.authorization).toBe(BEARER_RESOLVED);
    // RUFU-126 D1: an answered semantic hit IS the result — the keyword route only runs when
    // the vector attempt yields nothing. Its credential is pinned in the keyword test above
    // and the refused-endpoint fallback in the RUFU-994 cache-window test.
    expect(paths(server, KEYWORD_PATH)).toHaveLength(0);
  });

  it("read() broad recall sends the credential", async () => {
    server = await startLoopbackStash();
    const reader = secretsReaderReturning(RESOLVED_SECRET);
    const settings = readPathSettings(server.baseUrl);

    const content = await readProjectMemoryWithBackend("/project", settings, reader);

    const reads = paths(server, KEYWORD_PATH);
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(read.authorization).toBe(BEARER_RESOLVED);
    expect(content).toContain("recalled memory body");
  });

  it("exists() reachability probe sends the credential", async () => {
    server = await startLoopbackStash();
    const reader = secretsReaderReturning(RESOLVED_SECRET);
    const settings = readPathSettings(server.baseUrl);

    // `ensureMemoryFileWithBackend` is the entry that reaches `exists()`; its
    // probe URL is the empty-query search family.
    await ensureMemoryFileWithBackend(scratchProjectRoot(), settings, reader);

    const probes = paths(server, KEYWORD_PATH);
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) expect(probe.authorization).toBe(BEARER_RESOLVED);
  });

  it("one recall invocation reveals the secret at most once (shared enriched settings)", async () => {
    server = await startLoopbackStash();
    let reveals = 0;
    const reader = secretsReaderReturning(RESOLVED_SECRET, () => {
      reveals += 1;
    });
    const settings = readPathSettings(server.baseUrl);

    await searchProjectMemory("/project", { query: "alpha beta", limit: 5 }, settings, undefined, reader);
    await searchProjectMemory("/project", { query: "gamma delta", limit: 5 }, settings, undefined, reader);

    // One per invocation — never one per lane, per endpoint, or per retry.
    expect(reveals).toBe(2);
  });

  it("fail-closed holds: an auth refusal still resolves to an empty result, never a throw", async () => {
    server = await startLoopbackStash({ refuseEvenWhenAuthed: true });
    const reader = secretsReaderReturning(RESOLVED_SECRET);
    const settings = readPathSettings(server.baseUrl);

    await expect(
      searchProjectMemory("/project", { query: "alpha beta", limit: 5 }, settings, undefined, reader),
    ).resolves.toEqual([]);
    await expect(readProjectMemoryWithBackend("/project", settings, reader)).resolves.toBe("");
  });

  /*
  RUFU-994 Step 3 — the operator's core pair. Same server, same credential, two states:
  a 401 refusal and a 200-with-zero-results. Callers MUST keep receiving [] both times
  (fail-closed is unchanged), and the two states MUST still be tellable apart afterwards.
  */
  it("refusal and genuine-empty return the same [] but record different codes", async () => {
    const reader = secretsReaderReturning(RESOLVED_SECRET);

    server = await startLoopbackStash({ refuseEvenWhenAuthed: true });
    const refused = await searchProjectMemory(
      "/project",
      { query: "alpha beta", limit: 5 },
      readPathSettings(server.baseUrl),
      undefined,
      reader,
    );
    const refusalOutcome = getStashReadOutcome(server.baseUrl, "keyword-search");
    await server.close();
    server = null;

    __resetStashReadDiagnosticsForTests();

    server = await startLoopbackStash({ emptyResults: true });
    const empty = await searchProjectMemory(
      "/project",
      { query: "alpha beta", limit: 5 },
      readPathSettings(server.baseUrl),
      undefined,
      reader,
    );
    const emptyOutcome = getStashReadOutcome(server.baseUrl, "keyword-search");

    // The caller contract is identical in both states…
    expect(refused).toEqual([]);
    expect(empty).toEqual([]);
    // …and the recorded cause is what differs — the pair the defect made indistinguishable.
    expect(refusalOutcome?.code).toBe("refused-auth");
    expect(emptyOutcome?.code).toBe("no-match");
    expect(refusalOutcome?.code).not.toBe(emptyOutcome?.code);
    // Both sent a real key, so neither failure is our-side configuration.
    expect(refusalOutcome?.keyResolved).toBe(true);
    expect(emptyOutcome?.keyResolved).toBe(true);
    expect(emptyOutcome?.resultCount).toBe(0);
  });

  it("a read with no resolvable key names key-unresolved, not refused-auth", async () => {
    server = await startLoopbackStash();
    const settings = readPathSettings(server.baseUrl);

    // The global secret exists but reveals empty → the single resolver degrades fail-closed.
    await expect(
      searchProjectMemory("/project", { query: "alpha beta", limit: 5 }, settings, undefined, secretsReaderReturning("")),
    ).resolves.toEqual([]);

    const outcome = getStashReadOutcome(server.baseUrl, "keyword-search");
    expect(outcome?.code).toBe("key-unresolved");
    expect(outcome?.keyResolved).toBe(false);
    // No credential ever reached the server, which is why it answered 401.
    expect(server.requests.filter((r) => r.path.startsWith(KEYWORD_PATH))[0]?.authorization).toBeNull();
  });

  it("the semantic lane records its own refusal even when the keyword fallback then succeeds", async () => {
    server = await startLoopbackStash({ refuseSemanticOnly: true });
    const settings = readPathSettings(server.baseUrl, { stashVectorSearch: true });

    const hits = await searchProjectMemory(
      "/project",
      { query: "alpha beta gamma", limit: 5 },
      settings,
      undefined,
      secretsReaderReturning(RESOLVED_SECRET),
    );

    // Recall still worked via the keyword fallback (D2's load-bearing guarantee).
    expect(hits).toHaveLength(1);
    expect(getStashReadOutcome(server.baseUrl, "keyword-search")?.code).toBe("ok");
    // The semantic refusal survived the fallback instead of being attributed to the keyword route.
    expect(getStashReadOutcome(server.baseUrl, "semantic-search")?.code).toBe("refused-auth");
    expect(getStashReadOutcome(server.baseUrl)?.endpoint).toBe("keyword-search");
  });

  it("exists() refusal records the exists endpoint, not a silent false", async () => {
    server = await startLoopbackStash({ refuseEvenWhenAuthed: true });
    const settings = readPathSettings(server.baseUrl);

    await ensureMemoryFileWithBackend(scratchProjectRoot(), settings, secretsReaderReturning(RESOLVED_SECRET));

    const outcome = getStashReadOutcome(server.baseUrl, "exists");
    expect(outcome?.code).toBe("refused-auth");
    expect(outcome?.resultCount).toBe(0);
  });
});

/*
RUFU-994 Step 4 — the refusal must be COUNTABLE, and telemetry must never become a
lifecycle dependency. Every case below drives the real read entry (so the emitter runs on
its production path) against a hostile audit sink.
*/
describe("RUFU-994 Stash read refusal audit row", () => {
  let server: LoopbackStash | null = null;

  beforeEach(() => {
    __resetStashReadDiagnosticsForTests();
    __resetStashReadAuditDedupeForTests();
    __resetVectorCapabilityCacheForTests();
  });

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  /**
   * Refuse one read and return the rows the entry tried to write.
   *
   * `withRecorder: false` builds a store host that carries NO audit writer at all — the genuinely
   * absent-sink case. Leaving it in would mean the "absent" case silently tested a healthy sink.
   */
  async function refusedSearch(host: Partial<AuditHost> = {}, opts: { withRecorder?: boolean } = {}) {
    server = await startLoopbackStash({ refuseEvenWhenAuthed: true });
    const rows: Array<Record<string, unknown>> = [];
    const recorder =
      opts.withRecorder === false
        ? {}
        : {
            recordRunAuditEvent: (input: Record<string, unknown>) => {
              rows.push(input);
              return host.recordRunAuditEvent?.(input);
            },
          };
    const reader = secretsReaderReturning(RESOLVED_SECRET, () => undefined, { ...host, ...recorder });
    const results = await searchProjectMemory(
      "/project",
      { query: "alpha beta", limit: 5 },
      readPathSettings(server.baseUrl),
      undefined,
      reader,
    );
    return { rows, results, baseUrl: server.baseUrl, reader };
  }

  it("writes one row per (server, code) inside the refresh floor, not one per turn", async () => {
    const { rows, reader } = await refusedSearch({});
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.mutationType).toBe(STASH_READ_REFUSAL_MUTATION_TYPE);
    expect(row.agentId).toBe("memory-read");
    expect(row.target).toBe("stash-memory");
    expect(row.metadata).toEqual({
      endpoint: "keyword-search",
      code: "refused-auth",
      keyResolved: true,
      resultCount: 0,
    });

    // A second refused turn on the same server + same code, SAME sink, inside the window:
    // the refusal is still true, but it is the same wait, so no second row.
    await searchProjectMemory(
      "/project",
      { query: "gamma delta", limit: 5 },
      readPathSettings(server!.baseUrl),
      undefined,
      reader,
    );
    expect(rows).toHaveLength(1);

    // Past the floor the same refusal becomes countable again — one row per window, forever.
    // Same host, because the row needs a sink to land in; only the clock moved.
    reportStashReadOutcome(reader, server!.baseUrl, {
      nowMs: Date.now() + STASH_READ_REFUSAL_AUDIT_REFRESH_FLOOR_MS + 1,
    });
    expect(rows).toHaveLength(2);
    // The marker advances even for the row that re-armed, so a sustained refusal stays bounded.
    reportStashReadOutcome(reader, server!.baseUrl, {
      nowMs: Date.now() + STASH_READ_REFUSAL_AUDIT_REFRESH_FLOOR_MS + 1,
    });
    expect(rows).toHaveLength(2);
  });

  it("records nothing that could name the credential, the URL, or the response", async () => {
    const { rows } = await refusedSearch({});
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(RESOLVED_SECRET);
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain(server!.baseUrl);
    // A refusal sentence from the server never reaches the row either.
    expect(serialized).not.toContain("Missing Authorization header");
  });

  it("a successful read with zero results writes no refusal row at all", async () => {
    server = await startLoopbackStash({ emptyResults: true });
    const rows: Array<Record<string, unknown>> = [];
    const reader = secretsReaderReturning(RESOLVED_SECRET, () => undefined, {
      recordRunAuditEvent: (input) => {
        rows.push(input);
      },
    });
    await expect(
      searchProjectMemory("/project", { query: "alpha beta", limit: 5 }, readPathSettings(server.baseUrl), undefined, reader),
    ).resolves.toEqual([]);
    expect(rows).toEqual([]);
    expect(getStashReadOutcome(server.baseUrl, "keyword-search")?.code).toBe("no-match");
  });

  const HOSTILE_SINKS: Array<[string, Partial<AuditHost>, { withRecorder?: boolean }]> = [
    ["absent sink (the store host carries no audit writer)", {}, { withRecorder: false }],
    [
      "synchronously throwing sink",
      {
        recordRunAuditEvent: () => {
          throw new Error("sink exploded");
        },
      },
      {},
    ],
    ["rejecting sink", { recordRunAuditEvent: () => Promise.reject(new Error("sink rejected")) }, {}],
    ["never-settling sink", { recordRunAuditEvent: () => new Promise(() => undefined) }, {}],
  ];

  it.each(HOSTILE_SINKS)("hostile audit sink: %s leaves the recall result and code identical", async (_label, host, opts) => {
    const { rows, results, baseUrl } = await refusedSearch(host, opts);
    // The read behaved exactly as it does with a healthy sink: fail-closed empty, named cause.
    expect(results).toEqual([]);
    expect(getStashReadOutcome(baseUrl, "keyword-search")?.code).toBe("refused-auth");
    // The dedupe marker advanced regardless, so a broken sink cannot become a row flood.
    expect(rows.length).toBeLessThanOrEqual(1);
  });
});

/*
RUFU-994 Step 5 — recovery must be possible WITHOUT a restart.
This is a pin, not a fix report: there is no process-level auth cache to clear, and the one
negative cache that exists (`stashVectorNegativeCache`) is TTL-bounded and poisoned only by
definitive no-vector statuses {404,405,501,503} — never by a 401. What must stay true is that no
later change caches an auth refusal, because that would turn a fixed key into hours of silent
empty recall. Each case refuses first, then serves, in ONE process, and asserts the next call sees
the recovered credential.
*/
describe("RUFU-994 Stash read recovery without a restart", () => {
  let server: LoopbackStash | null = null;

  beforeEach(() => {
    __resetStashReadDiagnosticsForTests();
    __resetStashReadAuditDedupeForTests();
    __resetVectorCapabilityCacheForTests();
  });

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("the next search after the key works again returns the stored memory", async () => {
    server = await startLoopbackStash({ refuseEvenWhenAuthed: true });
    const settings = readPathSettings(server.baseUrl);
    const reader = secretsReaderReturning(RESOLVED_SECRET);

    await expect(
      searchProjectMemory("/project", { query: "alpha beta", limit: 5 }, settings, undefined, reader),
    ).resolves.toEqual([]);
    expect(getStashReadOutcome(server.baseUrl, "keyword-search")?.code).toBe("refused-auth");

    server.allowsAuthorizedReads = true;
    const recovered = await searchProjectMemory("/project", { query: "alpha beta", limit: 5 }, settings, undefined, reader);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.snippet).toContain("recalled memory body");
    expect(getStashReadOutcome(server.baseUrl, "keyword-search")?.code).toBe("ok");
  });

  it("the next per-turn recall after recovery renders the cue again (chat lane, long-lived process)", async () => {
    server = await startLoopbackStash({ refuseEvenWhenAuthed: true });
    const settings = readPathSettings(server.baseUrl);
    const reader = secretsReaderReturning(RESOLVED_SECRET);
    const options = {
      rootDir: "/project",
      topic: "alpha beta",
      settings,
      sessionKey: "task-1",
      secretsReader: reader,
    };

    await expect(buildPerTurnMemoryRecallCue(options)).resolves.toBe("");
    expect(getStashReadOutcome(server.baseUrl, "keyword-search")?.code).toBe("refused-auth");

    server.allowsAuthorizedReads = true;
    const cue = await buildPerTurnMemoryRecallCue(options);
    expect(cue).toContain("recalled memory body");
    expect(cue).toContain("stash://session/ses-1");
    expect(getStashReadOutcome(server.baseUrl, "keyword-search")?.code).toBe("ok");
  });

  /*
  FNXC:StashReadAuth 2026-11-12-20:09 (RUFU-994 Step 5):
  This case first encoded the OLD rule ("a 401 is transient, keep probing"), which is how one process
  came to burn 2 334 refused semantic requests. The card's decision is the opposite: a refused
  credential is definitive for the window, so the semantic attempt happens once. The assertion is
  rewritten to that truth rather than relaxed — and the two halves that must survive the suppression
  are asserted beside it: the keyword lane still runs every turn, and the cause stays visible while
  the lane is suppressed. Re-probing after the window is pinned with an injected clock in
  `memory-backend-stash.test.ts` case 4b, because the window is an hour and this harness has no clock.
  */
  it("a refused semantic endpoint costs ONE attempt per window while the keyword lane keeps running", async () => {
    server = await startLoopbackStash({ refuseSemanticOnly: true });
    const settings = readPathSettings(server.baseUrl, { stashVectorSearch: true });
    const reader = secretsReaderReturning(RESOLVED_SECRET);
    const attempts = () => server!.requests.filter((r) => r.path.startsWith(SEMANTIC_PATH)).length;
    const keywordTurns = () => server!.requests.filter((r) => r.path.startsWith(KEYWORD_PATH)).length;

    await searchProjectMemory("/project", { query: "alpha beta", limit: 5 }, settings, "alpha", reader);
    expect(attempts()).toBe(1);
    expect(getStashReadOutcome(server.baseUrl, "semantic-search")?.code).toBe("refused-auth");

    // Second turn inside the window: no new semantic request, keyword still searched, cause still named.
    await searchProjectMemory("/project", { query: "gamma delta", limit: 5 }, settings, "gamma", reader);
    expect(attempts()).toBe(1);
    expect(keywordTurns()).toBe(2);
    expect(getStashReadOutcome(server.baseUrl, "semantic-search")?.code).toBe("refused-auth");

    // The keyword lane is what recovers, and it recovers immediately: suppression is semantic-only.
    server.refuseSemanticOnly = false;
    const recovered = await searchProjectMemory("/project", { query: "epsilon zeta", limit: 5 }, settings, "epsilon", reader);
    expect(recovered).toHaveLength(1);
    expect(attempts()).toBe(1);
  });
});
