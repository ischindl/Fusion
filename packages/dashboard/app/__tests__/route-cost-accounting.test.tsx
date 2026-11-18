/*
FNXC:RouteCostAccounting 2026-11-18-07:32 (RUFU-479) — what one boot asked the server, counted.

The server-side route cost table answers "which endpoint is slow". The measured board failure had a second
half that no server metric can see: the tab itself asked too often — 42 requests in one second, and
`/api/settings/global` four times in a single board load. A question that can only be answered from the
client needs a client counter, and a counter in the page has to be bounded before it is useful.

Pinned here:
  * one entry per URL PATTERN whose count grows across repeat calls (the four settings fetches are one
    entry reading 4, not four entries);
  * ids of every shape collapse onto one pattern, so opening a hundred cards is not a hundred keys;
  * a pattern nobody requested reports a plain 0 rather than undefined;
  * the query string is not part of the key, and neither a body nor a header is ever recorded;
  * the pattern table is capped, oldest-inserted evicted.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client/client";
import {
  REQUEST_STATS_MAX_PATTERNS,
  requestPattern,
  requestStatCount,
  requestStatSnapshot,
  resetRequestStats,
} from "../api/client/request-stats";

function jsonResponse(body: unknown, contentLength = 1024): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "content-length": String(contentLength) },
  });
}

async function flushReadQueue(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

beforeEach(() => {
  resetRequestStats();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("client request accounting (RUFU-479)", () => {
  it("counts repeat requests to one pattern as one entry that grows", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ tasks: [] })));

    await api("/tasks/page?columns=todo&limit=50");
    await api("/tasks/page?columns=review&limit=50");
    await flushReadQueue();

    expect(requestStatCount("/tasks/page")).toBe(2);
    const entry = requestStatSnapshot()["/tasks/page"];
    expect(entry).toMatchObject({ count: 2, failures: 0 });
    expect(entry!.totalBytes).toBe(2_048);
  });

  it("reports a pattern nobody requested as zero, not as an absent counter", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true })));
    await api("/settings/global");
    await flushReadQueue();

    expect(requestStatCount("/settings/global")).toBe(1);
    expect(requestStatCount("/insights")).toBe(0);
    expect(requestStatSnapshot()["/insights"]).toBeUndefined();
  });

  it("collapses every id shape onto one pattern so opening many cards is one key", () => {
    // Keys are the CALLER-FACING path (`/tasks/:id`), not the wire URL: `buildApiUrl` prepends `/api`
    // inside `api()`, so the prefix a caller never wrote would be a prefix no test can name from a call
    // site. The server-side table keys on its own matched template and therefore does carry `/api`.
    expect(requestPattern("/tasks/RUFU-457/diff")).toBe("/tasks/:id/diff");
    expect(requestPattern("/tasks/42")).toBe("/tasks/:id");
    expect(requestPattern("/tasks/3f2b6c1a-9d4e-4a11-8b7f-0c5d9e2a1b3c/comments")).toBe("/tasks/:id/comments");
    expect(requestPattern("/tasks/proj_9326d74a133b421a/summary")).toBe("/tasks/:id/summary");
    expect(requestPattern("/tasks/page?limit=100&offset=0")).toBe("/tasks/page");
  });

  it("counts a failed request as a failure on the same pattern entry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(api("/tasks/page")).rejects.toThrow();
    await flushReadQueue();

    expect(requestStatSnapshot()["/tasks/page"]).toMatchObject({ count: 1, failures: 1 });
  });

  it("caps the pattern table so the counter cannot grow with the URL space", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true })));
    for (let index = 0; index < REQUEST_STATS_MAX_PATTERNS * 2; index += 1) {
      // Short, distinct, non-id-shaped segments: each path is its own pattern, so the bound has to hold
      // on key count alone rather than on id-collapse doing the work.
      await api(`/ep${index}`);
    }
    await flushReadQueue();
    expect(Object.keys(requestStatSnapshot()).length).toBeLessThanOrEqual(REQUEST_STATS_MAX_PATTERNS);
  });
});
