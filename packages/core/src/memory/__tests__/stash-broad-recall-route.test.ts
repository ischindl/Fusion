/*
FNXC:StashBroadRecallRoute 2026-11-21-14:28 (RUFU-1152):
Symptom-verification suite for the class where a read surface reports "nothing remembered" because the
request it sends is one the server's own validation refuses.

The deployed Stash route declares `q: str = Query(..., min_length=1)`
(`backend/routers/memory.py:146` at the pinned deploy `4585c2d24`, read-only against
`/home/schindler/git/stash`), and the list route `GET /api/v1/me/sessions/events` validates
`limit` at `le=200` and requires no `q` (`backend/routers/memory.py:118-127`). So a keyword request
with no terms is refused BEFORE the query runs, and only the list route can answer a no-terms read.

Every stand-in in this repo that modelled the old shape answered `?q=` as if it were valid, which is
how a dead request survived three cards of "byte-identical contract" language. The stand-in below
refuses it, exactly as the deployed route does — the first assertion of every case here is therefore
about which route was asked, before anything is said about what came back.
*/

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http, { type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  StashMemoryBackend,
  getStashReadOutcome,
  getStashReadScope,
  stashProjectIdentityFor,
  __resetStashReadDiagnosticsForTests,
  __resetStashReadAuditDedupeForTests,
  __resetStashReadScopeAuditDedupeForTests,
  __resetStashFolderCacheForTests,
  __resetVectorCapabilityCacheForTests,
} from "../memory-backend-stash.js";

const KEYWORD_PATH = "/api/v1/me/sessions/events/search";
const RECENT_PATH = "/api/v1/me/sessions/events";
const RESOLVED_SECRET = "broad-recall-secret";

type Row = {
  id: string;
  content: string;
  session_id: string;
  event_type: string;
  metadata: Record<string, unknown>;
};

interface StandIn {
  baseUrl: string;
  requests: Array<{ method: string; path: string }>;
  /** Requests that reached the keyword route (the one that refuses a no-terms read). */
  keywordRequests(): Array<{ method: string; path: string }>;
  /** Requests that reached the list route (the one that answers a no-terms read). */
  recentRequests(): Array<{ method: string; path: string }>;
  /** Flip the list route to a transport failure (a server that is really down). */
  failRecent: (status: number | null) => void;
  close(): Promise<void>;
}

async function startStash(options: { rows: Row[] }): Promise<StandIn> {
  const requests: Array<{ method: string; path: string }> = [];
  let recentFailure: number | null = null;
  const server: Server = http.createServer((req, res) => {
    const path = req.url ?? "";
    requests.push({ method: req.method ?? "", path });
    req.on("data", () => undefined);
    const url = new URL(path, "http://stand-in.invalid");
    const isRecent = path.startsWith(RECENT_PATH) && !path.startsWith(KEYWORD_PATH);
    if (isRecent) {
      if (recentFailure !== null) {
        res.statusCode = recentFailure;
        res.end(JSON.stringify({ detail: "list route unavailable" }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      res.end(JSON.stringify({ events: options.rows.slice(0, limit), has_more: false }));
      return;
    }
    if (path.startsWith(KEYWORD_PATH)) {
      // Route-faithful: `q: Query(..., min_length=1)`. No `q`, or an empty one, is a 422 that
      // happens before the query, so the shape cannot buy a row on any server.
      if (!(url.searchParams.get("q") ?? "").trim()) {
        res.statusCode = 422;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ detail: "q String required empty" }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ results: options.rows }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ detail: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    keywordRequests: () => requests.filter((r) => r.path.startsWith(KEYWORD_PATH)),
    recentRequests: () => requests.filter((r) => r.path.startsWith(RECENT_PATH) && !r.path.startsWith(KEYWORD_PATH)),
    failRecent: (status) => {
      recentFailure = status;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}

let scratch: string;
let root: string;
let server: StandIn | undefined;

function backend(): StashMemoryBackend {
  return new StashMemoryBackend({ baseUrl: server!.baseUrl, apiKey: RESOLVED_SECRET });
}

function ownRow(rootDir: string, i: number): Row {
  return {
    id: `own-${i}`,
    content: `durable note ${i} about the deployment runbook`,
    session_id: `fusion-session-${i}`,
    event_type: "message",
    metadata: { discriminator: stashProjectIdentityFor(rootDir).discriminator },
  };
}

function foreignRow(i: number): Row {
  return {
    id: `foreign-${i}`,
    content: `another project's note ${i} about its own deploy`,
    session_id: `other-session-${i}`,
    event_type: "message",
    metadata: { discriminator: "otherproj-0000000000" },
  };
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "rufu1152-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  root = mkdtempSync(join(scratch, "root-"));
  __resetStashReadDiagnosticsForTests();
  __resetStashReadAuditDedupeForTests();
  __resetStashReadScopeAuditDedupeForTests();
  __resetStashFolderCacheForTests();
  __resetVectorCapabilityCacheForTests();
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("RUFU-1152 the no-terms read asks the route that answers it", () => {
  it("read() returns this project's rows where the keyword route would have refused", async () => {
    server = await startStash({ rows: [foreignRow(0), ownRow(root, 0), ownRow(root, 1)] });
    const result = await backend().read(root);

    // The symptom: the keyword route is never asked, because asking it with no terms is the failure.
    expect(server.keywordRequests()).toHaveLength(0);
    expect(server.recentRequests().map((r) => r.path)).toEqual(["/api/v1/me/sessions/events?limit=60&order=desc"]);
    expect(result.exists).toBe(true);
    expect(result.content).toContain("2 memories recalled");
    expect(result.content).toContain("durable note 0");
    expect(result.content).not.toContain("another project's note");
  });

  it("exists() reports reachability from the route that answers a request with no q", async () => {
    server = await startStash({ rows: [ownRow(root, 0)] });
    await expect(backend().exists(root)).resolves.toBe(true);
    expect(server.keywordRequests()).toHaveLength(0);
    expect(server.recentRequests().map((r) => r.path)).toEqual(["/api/v1/me/sessions/events?limit=1&order=desc"]);
    expect(getStashReadOutcome(server.baseUrl, "exists")?.code).toBe("ok");
  });

  it("a list route that is really down stays a refusal, not an honest empty answer", async () => {
    server = await startStash({ rows: [ownRow(root, 0)] });
    server.failRecent(503);
    const backendUnderTest = backend();
    await expect(backendUnderTest.exists(root)).resolves.toBe(false);
    const read = await backendUnderTest.read(root);
    expect(read).toEqual({ content: "", exists: false, backend: "stash" });
    expect(getStashReadOutcome(server.baseUrl, "read")?.code).toBe("refused-capability");
    expect(getStashReadOutcome(server.baseUrl, "exists")?.code).toBe("refused-capability");
    // One record per surface: `read()` records itself, so no second row appears under the lane id.
    expect(getStashReadOutcome(server.baseUrl, "recent-events")).toBeNull();
  });

  it("keeps the page of own rows when the newest owner-wide rows belong to other projects", async () => {
    server = await startStash({ rows: [...foreignRows(25), ...Array.from({ length: 4 }, (_, i) => ownRow(root, i))] });
    const result = await backend().read(root);
    expect(result.content).toContain("4 memories recalled");
    const scope = getStashReadScope(server.baseUrl, stashProjectIdentityFor(root).discriminator);
    expect(scope?.droppedForeignCount).toBe(25);
    expect(scope?.matchedCount).toBe(29);
  });

  it("cleans the recency page the same way as every other page", async () => {
    const toolRows = Array.from({ length: 8 }, (_, i) => ({
      id: `tool-${i}`,
      content: "bash",
      session_id: `fusion-task-tool-${i}`,
      event_type: "tool",
      metadata: { discriminator: stashProjectIdentityFor(root).discriminator },
    }));
    server = await startStash({ rows: [...toolRows, ownRow(root, 0)] });
    const result = await backend().read(root);
    expect(result.content).toContain("1 memories recalled");
    expect(result.content).not.toContain("bash");
  });

  it("a direct no-terms search records the lane it ran, not a keyword search it did not run", async () => {
    server = await startStash({ rows: [ownRow(root, 0)] });
    server.failRecent(403);
    await expect(backend().search(root, { query: "   ", limit: 5 })).resolves.toEqual([]);
    expect(getStashReadOutcome(server.baseUrl, "recent-events")?.code).toBe("refused-auth");
    expect(getStashReadOutcome(server.baseUrl, "keyword-search")).toBeNull();
  });

  it("a read WITH terms still travels the keyword route, unchanged", async () => {
    server = await startStash({ rows: [ownRow(root, 0)] });
    await backend().read(root);
    const results = await backend().search(root, { query: "deployment runbook", limit: 5 });
    expect(results).toHaveLength(1);
    expect(server.keywordRequests().map((r) => r.path)).toEqual([
      // `normalizeStashSearchQuery` keeps one word token, which is the keyword route's own contract.
      "/api/v1/me/sessions/events/search?q=deployment&limit=30",
    ]);
  });
});

function foreignRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => foreignRow(i));
}
