import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { StashMemoryBackend, DEFAULT_STASH_URL } from "../memory-backend-stash.js";
import type { MemorySearchOptions } from "../memory-backend.js";
import { searchProjectMemory } from "../project-memory.js";

/**
 * RUFU-068 unit tests: the read-time focus/topic seam.
 *
 * FNXC:MemoryFocusTests 2026-08-13-16:35:
 * topic is a read-time WITHIN-project topic hint (not a result-set filter — see the
 * RUFU-121 and RUFU-172 notes below: no backend narrows what it returns by topic).
 * These tests run WITHOUT any live Stash — they mock node:http to prove (a) that a topic-scoped result
 * set never reintroduces cross-project leakage, and (b) that returns are
 * mapped verbatim (no client-side in-memory re-filter that could mask the
 * project scope).
 *
 * FNXC:RUFU121TopicRemoval 2026-08-18-19:53:
 * RUFU-121: the Stash REST search route no longer receives a `topic` param —
 * the param was inert (the route only accepts q+limit, verified against
 * /home/schindler/git/stash), so the push-down assertions below now assert
 * its ABSENCE. `MemorySearchOptions.topic` remains for the qmd/file/readonly
 * backends and read-side gating; Stash topic-like scoping maps to the
 * structured queryStashEvents() filters instead.
 */

type MockResponse = { statusCode: number; body: unknown };
type RequestLog = { path: string; method: string; body?: string; headers: http.OutgoingHttpHeaders };

let responder: (opts: http.RequestOptions, body?: string) => MockResponse | Promise<MockResponse>;
let log: RequestLog[] = [];

function fakeIncoming(statusCode: number, body: unknown): http.IncomingMessage {
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
  const data = typeof body === "string" ? body : JSON.stringify(body);
  const incoming = {
    statusCode,
    setEncoding: () => {},
    on(event: string, cb: (arg?: unknown) => void) {
      (listeners[event] ||= []).push(cb);
      return incoming;
    },
    headers: {},
  } as unknown as http.IncomingMessage;
  setImmediate(() => {
    (listeners["data"] ?? []).forEach((cb) => cb(Buffer.from(data, "utf-8")));
    (listeners["end"] ?? []).forEach((cb) => cb());
  });
  return incoming;
}

function fakeRequest(): http.ClientRequest {
  let body = "";
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
  const req = {
    write(chunk: string | Buffer) { body += typeof chunk === "string" ? chunk : chunk.toString("utf-8"); return true; },
    end(chunk?: string | Buffer) {
      if (chunk) body += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      const last = log[log.length - 1];
      if (last) last.body = body;
      return req;
    },
    on(event: string, cb: (arg?: unknown) => void) { (listeners[event] ||= []).push(cb); return req; },
    emit(event: string, arg?: unknown) { (listeners[event] || []).forEach((cb) => cb(arg)); return true; },
    destroy() {},
  } as unknown as http.ClientRequest;
  return req;
}

let pendingRequest: { options: http.RequestOptions; cb?: (res: http.IncomingMessage) => void; req: http.ClientRequest } | null = null;

function mockHttpRequest() {
  vi.spyOn(http, "request").mockImplementation(((options: http.RequestOptions, cb?: (res: http.IncomingMessage) => void) => {
    log.push({ path: options.path ?? "", method: options.method ?? "GET", headers: options.headers ?? {} });
    const req = fakeRequest();
    pendingRequest = { options, cb, req };
    return req;
  }) as unknown as typeof http.request);
}

async function deliver(): Promise<void> {
  if (!pendingRequest) return;
  const { options, cb, req } = pendingRequest;
  pendingRequest = null;
  const last = log[log.length - 1];
  const body = last?.body;
  let mock: MockResponse;
  try {
    mock = await responder(options, body);
  } catch (e) {
    (req as unknown as { emit: (event: string, arg?: unknown) => boolean }).emit("error", e);
    return;
  }
  if (typeof cb === "function") cb(fakeIncoming(mock.statusCode, mock.body));
}

beforeEach(() => {
  log = [];
  pendingRequest = null;
  responder = () => ({ statusCode: 200, body: {} });
  mockHttpRequest();
});

afterEach(() => {
  vi.restoreAllMocks();
  log = [];
  pendingRequest = null;
});

function backend(baseUrl = DEFAULT_STASH_URL, apiKey = "test-key") {
  return new StashMemoryBackend({ baseUrl, apiKey });
}

describe("memory focus/topic search seam (RUFU-068)", () => {
  describe("Stash search topic push-down", () => {
    it("sends no &topic= param in any Stash search request (RUFU-121: inert param removed)", async () => {
      /*
      FNXC:RUFU121TopicRemoval 2026-08-18-19:53:
      RUFU-121: the former assertion here (topic forwarded as &topic=) is
      REPLACED by its inverse — the Stash search URL must never carry a
      topic param. The route only accepts q+limit (verified 2026-08-18
      against /home/schindler/git/stash); the param was inert. topic is still
      honored by the topic-aware backends and read-side gating (see
      MemorySearchOptions.topic).
      */
      responder = () => ({ statusCode: 200, body: { results: [{ content: "stash memory", session_id: "fusion-1-a" }] } });
      const ps = backend().search("/repos/projectA", { query: "secret", topic: "stash lcm" } satisfies MemorySearchOptions);
      await deliver();
      await ps;
      const searchReq = [...log].reverse().find((r) => r.path?.includes("/events/search"));
      expect(searchReq).toBeTruthy();
      const qs = new URLSearchParams((searchReq!.path!.split("?")[1] ?? "").replace(/^\?/, ""));
      expect(qs.has("topic")).toBe(false);
      // The query itself is still sent ("secret" is already a single ASCII
      // keyword, so normalization is identity).
      expect(qs.get("q")).toBe("secret");
    });

    it("never URL-encodes a topic value into the Stash search URL (RUFU-121)", async () => {
      /*
      FNXC:RUFU121TopicRemoval 2026-08-18-19:53:
      RUFU-121: replaces the former topic-encoding assertion — even a topic
      value with special characters must NOT appear anywhere in the Stash
      search URL.
      */
      responder = () => ({ statusCode: 200, body: { results: [] } });
      const ps = backend().search("/repos/projectA", { query: "x", topic: "stash & lcm / memory" } satisfies MemorySearchOptions);
      await deliver();
      await ps;
      const searchReq = [...log].reverse().find((r) => r.path?.includes("/events/search"));
      expect(searchReq!.path).not.toContain("topic=");
      expect(searchReq!.path).not.toContain("stash%20&");
    });

    it("omits the topic param when topic is empty or undefined (whole-project scope)", async () => {
      responder = () => ({ statusCode: 200, body: { results: [] } });
      const b = backend();
      const pUndef = b.search("/repos/projectA", { query: "x" } satisfies MemorySearchOptions);
      await deliver();
      await pUndef;
      let searchReq = [...log].reverse().find((r) => r.path?.includes("/events/search"));
      let qs = new URLSearchParams((searchReq!.path!.split("?")[1] ?? "").replace(/^\?/, ""));
      expect(qs.has("topic")).toBe(false);

      const pEmpty = b.search("/repos/projectA", { query: "x", topic: "" } satisfies MemorySearchOptions);
      await deliver();
      await pEmpty;
      searchReq = [...log].reverse().find((r) => r.path?.includes("/events/search"));
      qs = new URLSearchParams((searchReq!.path!.split("?")[1] ?? "").replace(/^\?/, ""));
      expect(qs.has("topic")).toBe(false);
    });

    it("returns the route's traffic VERBATIM — no client-side in-memory filter", async () => {
      //
      // FNXC:StashTopicGap 2026-08-13-16:35:
      // RUFU-068 MUST NOT fabricate a client-side in-memory topic filter to
      // simulate SQL enforcement. This test feeds back BOTH topic results and
      // unrelated results and asserts the client maps everything verbatim —
      // proving the client applies NO post-query filter.
      //
      // FNXC:RUFU121TopicRemoval 2026-08-18-19:53:
      // RUFU-121 closed the former "external gap" by deleting the inert
      // &topic= param entirely; the assertion below now confirms the request
      // carries NO topic param while the verbatim-mapping guarantee is
      // unchanged.
      const b = backend();
      responder = () => ({
        statusCode: 200,
        body: {
          events: [
            { id: 1, content: "stash memory hit", session_id: "fusion-1-a", metadata: { topic: "stash lcm" } },
            { id: 2, content: "gui improvement note", session_id: "fusion-1-b", metadata: { topic: "gui" } },
          ],
        },
      });
      const ps = b.search("/repos/projectA", { query: "memory", topic: "stash lcm" } satisfies MemorySearchOptions);
      await deliver();
      const results = await ps;
      // Request carries NO topic param (RUFU-121 removal)…
      const searchReq = [...log].reverse().find((r) => r.path?.includes("/events/search"));
      expect(searchReq!.path).not.toContain("topic=");
      // …and the results are returned verbatim — the client does not
      // in-memory filter them.
      expect(results).toHaveLength(2);
      expect(results.some((r) => r.snippet.includes("stash memory hit"))).toBe(true);
      expect(results.some((r) => r.snippet.includes("gui improvement note"))).toBe(true);
    });
  });

  describe("capture-time topic tagging", () => {
    it("tags each captured session with its active topic in event metadata", async () => {
      responder = () => ({ statusCode: 200, body: { inserted: 1, deduped: 0 } });
      const promise = backend().capture(
        "fusion-1-a",
        [{ event_type: "message", content: "turn 1" }],
        { taskId: "1", projectRoot: "/repos/projectA", topic: "stash lcm" },
      );
      await deliver();
      const res = await promise;
      expect(res.ok).toBe(true);
      const req = log.find((r) => r.path.includes("/events/batch"));
      const payload = JSON.parse(req!.body ?? "{}");
      expect(payload.events[0].metadata.topic).toBe("stash lcm");
      expect(payload.events[0].metadata.discriminator).toContain("projectA");
      expect(payload.events[0].metadata.session_id).toBe("fusion-1-a");
    });

    it("records no topic tag when none is active (capture stays topic-agnostic for write)", async () => {
      responder = () => ({ statusCode: 200, body: { inserted: 1, deduped: 0 } });
      const promise = backend().capture("fusion-1-a", [{ event_type: "message", content: "x" }], { projectRoot: "/repos/projectA" });
      await deliver();
      await promise;
      const req = log.find((r) => r.path.includes("/events/batch"));
      const payload = JSON.parse(req!.body ?? "{}");
      expect(payload.events[0].metadata).not.toHaveProperty("topic");
    });
  });

  describe("cross-project isolation invariant", () => {
    it("a topic-scoped project-X search never reintroduces project-Y session leakage", async () => {
      //
      // FNXC:StashTopicNoLeak 2026-08-13-16:35:
      // A topic must never weaken, bypass, or mask the Stash server-side
      // `owner_user_id` SQL scope. Here we simulate a correctly scoped route for
      // project A and assert a project-X topic search never contains project B's
      // sessions/discriminator.
      //
      // FNXC:RUFU172WordingSweep 2026-09-01-18:20:
      // RUFU-172 wording sweep: this comment used to call focus a "WITHIN-project read
      // filter". It is not — no backend narrows its result set by topic (RUFU-121 removed
      // the inert &topic=; RUFU-172 uses the focus only as a ranking input). Cross-project
      // isolation is what this test still proves, and it is enforced by the owner_user_id
      // scope, not by any topic filter.
      const b = backend();
      responder = () => ({
        statusCode: 200,
        body: {
          events: [
            { id: 10, content: "Stash & LCM memory plan", session_id: "fusion-1-a", metadata: { discriminator: "projectA-a1b2", topic: "stash lcm" } },
          ],
        },
      });
      const ps = b.search("/repos/projectA", { query: "memory", topic: "stash lcm" } satisfies MemorySearchOptions);
      await deliver();
      const results = await ps;
      expect(results).toHaveLength(1);
      expect(results[0].snippet).toContain("Stash & LCM memory plan");
      expect(results[0].snippet).not.toContain("B secret");
      expect(results[0].path).toContain("fusion-1-a");
      // No project-Y session id may appear in a project-X topic search.
      // FNXC:RUFU121TopicRemoval 2026-08-18-19:53: the former topic-param
      // assertion is replaced — Stash search URLs no longer carry &topic=.
      const searchReq = [...log].reverse().find((r) => r.path?.includes("/events/search"));
      expect(searchReq!.path).not.toContain("topic=");
      expect(results.some((r) => r.path.includes("fusion-2-b"))).toBe(false);
    });

    it("project X's search never surfaces project Y's sessions (owner_user_id isolation preserved)", async () => {
      const b = backend();
      responder = () => ({
        statusCode: 200,
        body: { events: [{ id: 1, content: "X only", session_id: "fusion-1-a", metadata: { discriminator: "projectX-aaaa" } }] },
      });
      const ps = b.search("/repos/projectX", { query: "query" } satisfies MemorySearchOptions);
      await deliver();
      const results = await ps;
      expect(results.every((r) => r.snippet.includes("X only"))).toBe(true);
      expect(results.some((r) => r.path.includes("fusion-2-b"))).toBe(false);
      expect(results.some((r) => r.snippet.includes("Y secret"))).toBe(false);
    });
  });

  describe("searchProjectMemory forwarding + topic-agnostic backends", () => {
    it("searchProjectMemory forwards options (including topic) wholesale to backend.search", async () => {
      const memMod = await import("../memory-backend.js");
      const resolveSpy = vi.spyOn(memMod, "resolveMemoryBackend");
      let received: MemorySearchOptions | undefined;
      const fake = {
        type: "fake",
        name: "Fake",
        capabilities: { readable: true, writable: true, supportsAtomicWrite: false, hasConflictResolution: false, persistent: true },
        read: async () => ({ content: "", exists: false, backend: "fake" }),
        write: async () => ({ success: true, backend: "fake" }),
        search: async (_r: string, options: MemorySearchOptions) => { received = options; return []; },
      } as unknown as import("../memory-backend.js").MemoryBackend;
      resolveSpy.mockReturnValue(fake);
      await searchProjectMemory("/proj", { query: "x", topic: "stash lcm" });
      expect(received).toMatchObject({ query: "x", topic: "stash lcm" });
      resolveSpy.mockRestore();
    });

    it("a topic-agnostic backend (file) ignores topic without post-filtering and returns normal results", async () => {
      const memMod = await import("../memory-backend.js");
      const resolveSpy = vi.spyOn(memMod, "resolveMemoryBackend");
      const fake = {
        type: "file",
        name: "File",
        capabilities: { readable: true, writable: true, supportsAtomicWrite: false, hasConflictResolution: false, persistent: true },
        read: async () => ({ content: "", exists: false, backend: "file" }),
        write: async () => ({ success: true, backend: "file" }),
        search: async (_r: string, options: MemorySearchOptions) => {
          // A topic-agnostic backend sees topic in its options but ignores it
          // (no post-query in-memory filter) and returns its normal results.
          expect("topic" in options).toBe(true);
          return [{ path: "/mem.md", lineStart: 1, lineEnd: 2, snippet: "file hit", score: 1, backend: "file" }];
        },
      } as unknown as import("../memory-backend.js").MemoryBackend;
      resolveSpy.mockReturnValue(fake);
      const results = await searchProjectMemory("/proj", { query: "x", topic: "ignore-me" });
      expect(results.map((r) => r.snippet)).toEqual(["file hit"]);
      resolveSpy.mockRestore();
    });
  });
});

/*
FNXC:RUFU172FocusResolver 2026-08-31-19:41:
RUFU-172: the canonical focus collapse moved from @fusion/engine into core so the recall core
and the engine memory tool share one definition. These cases assert the OBSERVABLE mapping
(not source text) and that both core barrels re-export the same function — a one-sided barrel
export is otherwise silent, because `engine-core` resolves @fusion/core through index.gate.ts.
*/
describe("resolveMemorySearchTopic canonical focus collapse (RUFU-068 semantics, RUFU-172 home)", () => {
  const focusStates = [undefined, null, "", "   ", "\n\t ", "all", "*", "  all  ", " * "] as const;

  it("collapses every 'no focus' state to undefined (whole-project scope)", async () => {
    const { resolveMemorySearchTopic } = await import("../../index.gate.js");
    for (const state of focusStates) {
      expect(resolveMemorySearchTopic(state as string | null | undefined), `state=${JSON.stringify(state)}`).toBeUndefined();
    }
  });

  it("returns the trimmed focus string for an active focus", async () => {
    const { resolveMemorySearchTopic } = await import("../../index.gate.js");
    expect(resolveMemorySearchTopic("stash lcm")).toBe("stash lcm");
    expect(resolveMemorySearchTopic("  pamäťové hladiny LCM  ")).toBe("pamäťové hladiny LCM");
    // Diacritics survive verbatim: the resolver is not an ASCII tokenizer.
    expect(resolveMemorySearchTopic("pamäťové")).toBe("pamäťové");
  });

  it("collapses only a WHOLE 'all'/'*' value, never a substring", async () => {
    const { resolveMemorySearchTopic } = await import("../../index.gate.js");
    expect(resolveMemorySearchTopic("all hands review")).toBe("all hands review");
    expect(resolveMemorySearchTopic("*cache")).toBe("*cache");
  });

  it("exposes the identical function through the direct module and both barrels", async () => {
    const direct = await import("../project-memory.js");
    const gate = await import("../../index.gate.js");
    const full = await import("../../index.js");
    expect(gate.resolveMemorySearchTopic).toBe(direct.resolveMemorySearchTopic);
    expect(full.resolveMemorySearchTopic).toBe(direct.resolveMemorySearchTopic);
  });

  /*
  FNXC:RUFU172BarrelParity 2026-09-02-04:55:
  RUFU-172 added `PER_TURN_RECALL_LANE_T_SHARE_MAX_CHARS` to the recall core. The gate barrel
  enumerates it explicitly while `index.ts` reaches it via `export * from "./memory/recall/index.js"`,
  so a one-sided export would be invisible to static reading yet break the normal (non-gate)
  `@fusion/core` resolution at runtime. This assertion is the only guard against that silent trap
  (planning note #9: there is no automated barrel-diff test); a runtime import proves the constant is
  carried by BOTH barrels, not just the gate copy.
  */
  it("mirrors the lane-T recall share budget through both core barrels", async () => {
    const direct = await import("../recall/per-turn-recall.js");
    const gate = await import("../../index.gate.js");
    const full = await import("../../index.js");
    expect(typeof direct.PER_TURN_RECALL_LANE_T_SHARE_MAX_CHARS).toBe("number");
    expect(gate.PER_TURN_RECALL_LANE_T_SHARE_MAX_CHARS).toBe(direct.PER_TURN_RECALL_LANE_T_SHARE_MAX_CHARS);
    expect(full.PER_TURN_RECALL_LANE_T_SHARE_MAX_CHARS).toBe(direct.PER_TURN_RECALL_LANE_T_SHARE_MAX_CHARS);
  });

  it("carries the resolved focus to the backend as an option without narrowing results in-memory", async () => {
    const { resolveMemorySearchTopic } = await import("../../index.gate.js");
    const focus = resolveMemorySearchTopic("  merge gate flake  ");
    const seen: MemorySearchOptions[] = [];
    const backendModule = await import("../memory-backend.js");
    const resolveSpy = vi.spyOn(backendModule, "resolveMemoryBackend");
    resolveSpy.mockReturnValue({
      type: "file",
      name: "File",
      capabilities: { readable: true, writable: true, supportsAtomicWrite: false, hasConflictResolution: false, persistent: true },
      read: async () => ({ content: "", exists: false, backend: "file" }),
      write: async () => ({ success: true, backend: "file" }),
      search: async (_r: string, options: MemorySearchOptions) => {
        seen.push(options);
        return [
          { path: "/mem.md", lineStart: 1, lineEnd: 2, snippet: "hit", score: 1, backend: "file" },
          { path: "/other.md", lineStart: 5, lineEnd: 6, snippet: "unrelated", score: 1, backend: "file" },
        ];
      },
    } as unknown as import("../memory-backend.js").MemoryBackend);
    const results = await searchProjectMemory("/proj", { query: "merge", limit: 5 }, undefined, focus);
    resolveSpy.mockRestore();
    // The focus reaches the backend as a topic option...
    expect(seen[0]?.topic).toBe("merge gate flake");
    // ...and the result set is returned whole (no post-query in-memory narrowing).
    expect(results.map((r) => r.snippet)).toEqual(["hit", "unrelated"]);
  });
});