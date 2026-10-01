/*
FNXC:ChatRemoteGenerationMirror 2026-09-21-10:45:
RUFU-252. A foreign chat generation is mirrored into an open tab only when BOTH halves of the
bus path hold: the connection must be bridged to the EventEmitters the generation actually fires
on, AND the frame must carry the derived `isGenerating` flag the client mirrors on. The baseline
delivered both for a connection opened AFTER the scoped store existed, which is the contract this
file pins at the composition level: a store created for a secondary project must reach the client
as an enriched `chat:session:updated` frame, and identity dedupe must keep a shared default/scoped
instance from duplicating the frame.

RUFU-252 also closes the half that was missing: a store created AFTER an already-open connection
was invisible to it (`listLiveScopedChatStores()` is read once per connection). Those live-bridge
cases are in the second describe block below.
*/

import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { ChatStore, TaskStore } from "@fusion/core";
import { createSSE, type CreateSSEOptions } from "../sse.js";
import {
  __resetScopedChatStoreCache,
  getOrCreateScopedChatStore,
  onScopedChatStoreCreated,
} from "../chat-project-services.js";

class MockSocket extends EventEmitter {
  destroyed = false;
  setKeepAlive = vi.fn();
  destroy = vi.fn(() => {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  });
}

class MockResponse extends EventEmitter {
  headers = new Map<string, string>();
  writableEnded = false;
  write = vi.fn();
  flushHeaders = vi.fn();
  end = vi.fn(() => {
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.emit("close");
  });
  constructor(readonly socket: MockSocket) {
    super();
  }
  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
}

function createMockTaskStore(): TaskStore {
  return {
    on: vi.fn(),
    off: vi.fn(),
    getResearchStore: vi.fn(() => ({ on: vi.fn(), off: vi.fn() })),
    getSettings: vi.fn(async () => ({})),
    getAsyncLayer: vi.fn(() => null),
  } as unknown as TaskStore;
}

function makeChatStore(): ChatStore {
  return new EventEmitter() as unknown as ChatStore;
}

/** Open one bus connection with a pre-computed chat-store set (what server.ts computes today). */
function openConnection(
  chatStores: ChatStore | ChatStore[],
  options?: CreateSSEOptions,
): { res: MockResponse; socket: MockSocket } {
  const socket = new MockSocket();
  const req = new EventEmitter() as Request & { query: Record<string, string>; socket: MockSocket };
  req.query = { clientId: `live-bridge-${Math.random()}` };
  req.socket = socket;
  const res = new MockResponse(socket);
  createSSE(
    createMockTaskStore(),
    undefined,
    undefined,
    undefined,
    options,
    undefined,
    undefined,
    chatStores,
  )(req, res as unknown as Response);
  return { res, socket };
}

/** Exactly what server.ts passes for an unscoped connection: adopt stores created after opening. */
const liveBridge: CreateSSEOptions = { liveChatStores: { onCreated: onScopedChatStoreCreated } };

/** Minimal TaskStore the scoped-chat registry needs to construct a real ChatStore. */
function projectTaskStore(fusionDir: string): TaskStore {
  return {
    getFusionDir: () => fusionDir,
    getRootDir: () => "/tmp/project",
    getSettings: async () => ({}),
    getAsyncLayer: () => ({}),
  } as unknown as TaskStore;
}

function emitSessionUpdated(chatStore: ChatStore, payload: Record<string, unknown>): void {
  (chatStore as unknown as EventEmitter).emit("chat:session:updated", payload);
}

function frames(res: MockResponse): Array<{ event: string; data: unknown }> {
  const raw = res.write.mock.calls.map((call) => String(call[0])).join("");
  return raw
    .split("\n\n")
    .filter((block) => block.includes("event:"))
    .map((block) => {
      const event = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? "";
      const data = /^data:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? "";
      let parsed: unknown = data;
      try {
        parsed = JSON.parse(data);
      } catch {
        // Heartbeat / non-JSON frames keep their raw body.
      }
      return { event, data: parsed };
    });
}

function frameFor(res: MockResponse, event: string): Array<Record<string, unknown>> {
  return frames(res)
    .filter((frame) => frame.event === event)
    .map((frame) => frame.data as Record<string, unknown>);
}

describe("createSSE scoped chat store mirror (composition level)", () => {
  it("enriches chat:session:updated coming from a scoped store", () => {
    const defaultStore = makeChatStore();
    const scopedStore = makeChatStore();
    const { res } = openConnection([defaultStore, scopedStore]);

    scopedStore.emit("chat:session:updated", {
      id: "chat-scoped",
      inFlightGeneration: { status: "generating", streamingText: "Drafting the plan", replayFromEventId: 7 },
    });

    const [payload] = frameFor(res, "chat:session:updated");
    expect(payload).toBeDefined();
    expect(payload.isGenerating).toBe(true);
  });

  it("preserves every in-flight generation field the client mirrors, unmutated", () => {
    const defaultStore = makeChatStore();
    const scopedStore = makeChatStore();
    const { res } = openConnection([defaultStore, scopedStore]);

    const inFlightGeneration = {
      status: "generating",
      streamingText: "Drafting the plan",
      streamingThinking: "Weighing the tradeoff",
      toolCalls: [{ toolName: "fn_task_planner_add_steering", args: { text: "x" }, isError: false, status: "running" }],
      replayFromEventId: 7,
      updatedAt: "2026-09-21T10:00:00.000Z",
    };
    scopedStore.emit("chat:session:updated", { id: "chat-scoped", inFlightGeneration });

    const [payload] = frameFor(res, "chat:session:updated");
    /*
    The attach path is driven by `replayFromEventId` (it becomes the stream's Last-Event-ID), so the
    enrichment must be ADDITIVE: a derivation that rewrote or dropped the snapshot would silently
    break mid-stream replay for every scoped mirror. There is no `generationId` on the wire, so the
    cursor is the only identity the client has for a generation.
    */
    expect(payload.inFlightGeneration).toEqual(inFlightGeneration);
    // The replay cursor is the ONLY identity-shaped key on the wire — no per-generation identifier
    // exists, so client-side suppression can only be carried by stream state plus that cursor.
    const wireGeneration = payload.inFlightGeneration as Record<string, unknown>;
    expect(Object.keys(wireGeneration).filter((key) => /id$/i.test(key))).toEqual(["replayFromEventId"]);
    expect(payload.isGenerating).toBe(true);
  });

  it("derives isGenerating:false for a scoped row whose generation finished", () => {
    const defaultStore = makeChatStore();
    const scopedStore = makeChatStore();
    const { res } = openConnection([defaultStore, scopedStore]);

    scopedStore.emit("chat:session:updated", { id: "chat-scoped", inFlightGeneration: null });

    const [payload] = frameFor(res, "chat:session:updated");
    expect(payload.isGenerating).toBe(false);
  });

  it("bridges a store that is both the default and a scoped instance exactly once", () => {
    const shared = makeChatStore();
    const { res } = openConnection([shared, shared, shared]);

    shared.emit("chat:session:updated", { id: "chat-shared", inFlightGeneration: null });

    expect(frameFor(res, "chat:session:updated")).toHaveLength(1);
  });

  /*
  FNXC:ChatRemoteGenerationMirror 2026-09-21-10:45:
  `chat:session:created` deliberately stays a raw passthrough. Verified premise at time of writing:
  `ChatStore.createChatSession` builds the row with `inFlightGeneration: null` and emits immediately
  (packages/core/src/chat/chat-store.ts), so a create event can never announce a generation. This
  case pins that decision so a future create-with-generation path fails here instead of quietly
  leaving new generations unmirrored.
  */
  it("leaves chat:session:created un-enriched because creation never carries a generation", () => {
    const scopedStore = makeChatStore();
    const { res } = openConnection([scopedStore]);

    scopedStore.emit("chat:session:created", { id: "chat-new", inFlightGeneration: null });

    const [payload] = frameFor(res, "chat:session:created");
    expect(payload).toEqual({ id: "chat-new", inFlightGeneration: null });
    expect(payload).not.toHaveProperty("isGenerating");
  });
});

/*
FNXC:ChatRemoteGenerationMirror 2026-09-21-10:45:
RUFU-252 gap B. These cases run the REAL scoped-store registry, because the defect lived in the
handover between that registry and an open connection: `listLiveScopedChatStores()` was read once
per connection, so a project opened later in another tab was bridged by nobody.
*/
describe("createSSE live scoped chat store bridge", () => {
  beforeEach(() => {
    __resetScopedChatStoreCache();
  });

  it("mirrors a scoped store created after the connection opened", () => {
    const defaultStore = makeChatStore();
    const { res } = openConnection([defaultStore], liveBridge);

    // The project is touched for the first time WHILE the connection is already open.
    const lateStore = getOrCreateScopedChatStore(projectTaskStore("/tmp/fusion-late-project"));
    emitSessionUpdated(lateStore, { id: "chat-late", inFlightGeneration: { status: "generating" } });

    const payloads = frameFor(res, "chat:session:updated");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ id: "chat-late", isGenerating: true });
  });

  it("bridges the store that replaced a cached one (engine booted after first resolution)", () => {
    const defaultStore = makeChatStore();
    const store = projectTaskStore("/tmp/fusion-replaced-project");
    const { res } = openConnection([defaultStore], liveBridge);

    getOrCreateScopedChatStore(store);
    const replacement = makeChatStore();
    getOrCreateScopedChatStore(store, replacement);

    emitSessionUpdated(replacement, { id: "chat-replacement", inFlightGeneration: { status: "generating" } });

    const payloads = frameFor(res, "chat:session:updated");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ id: "chat-replacement", isGenerating: true });
  });

  it("does not duplicate a frame when the published instance was already bridged", () => {
    const shared = makeChatStore();
    const store = projectTaskStore("/tmp/fusion-shared-project");
    const { res } = openConnection([shared], liveBridge);

    // Snapshot bridged `shared`, then the registry publishes the very same instance.
    getOrCreateScopedChatStore(store, shared);
    emitSessionUpdated(shared, { id: "chat-shared", inFlightGeneration: null });

    expect(frameFor(res, "chat:session:updated")).toHaveLength(1);
  });

  it("detaches the late store and stops adopting once the connection closes", () => {
    const defaultStore = makeChatStore();
    const { res, socket } = openConnection([defaultStore], liveBridge);

    const lateStore = getOrCreateScopedChatStore(projectTaskStore("/tmp/fusion-first-project"));
    const detached = vi.spyOn(lateStore, "off");
    const framesBeforeClose = res.write.mock.calls.length;

    socket.emit("close");

    expect(detached).toHaveBeenCalledWith("chat:session:updated", expect.any(Function));

    // A project opened after this tab went away must not keep the dead connection writing.
    const afterCloseStore = getOrCreateScopedChatStore(projectTaskStore("/tmp/fusion-after-close-project"));
    emitSessionUpdated(afterCloseStore, { id: "chat-after-close", inFlightGeneration: { status: "generating" } });
    emitSessionUpdated(lateStore, { id: "chat-first", inFlightGeneration: { status: "generating" } });

    expect(res.write.mock.calls.length).toBe(framesBeforeClose);
  });

  /*
  The live bridge is an UNSCOPED-connection feature. A project-scoped stream that adopted every
  newly created store would forward another project's chat rows into a stream the client asked to
  be filtered to one project, so the boundary is pinned from both sides.
  */
  it("keeps a project-scoped connection bound to its own store", () => {
    const scopedStore = makeChatStore();
    const { res } = openConnection([scopedStore], { projectId: "proj_a" });

    const otherProjectStore = getOrCreateScopedChatStore(projectTaskStore("/tmp/fusion-proj-b"));
    emitSessionUpdated(otherProjectStore, { id: "chat-proj-b", inFlightGeneration: { status: "generating" } });

    expect(frames(res).filter((frame) => JSON.stringify(frame.data).includes("chat-proj-b"))).toHaveLength(0);

    emitSessionUpdated(scopedStore, { id: "chat-proj-a", inFlightGeneration: { status: "generating" } });
    expect(frameFor(res, "chat:session:updated")).toHaveLength(1);
  });

  /*
  Server wiring guard (same source-scan precedent as server-postgres-store-construction.test.ts):
  the behavior above is reachable only if the unscoped connection declares the bridge and the
  project-scoped one does not.
  */
  it("wires the bridge on the unscoped connection only", () => {
    const serverSource = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    const unscopedCallStart = serverSource.indexOf("createSSE(", serverSource.indexOf("if (!projectId) {"));
    const scopedCallStart = serverSource.indexOf("createSSE(", unscopedCallStart + 1);
    expect(unscopedCallStart).toBeGreaterThan(-1);
    expect(scopedCallStart).toBeGreaterThan(unscopedCallStart);

    expect(serverSource.slice(unscopedCallStart, scopedCallStart)).toContain(
      "liveChatStores: { onCreated: onScopedChatStoreCreated }",
    );
    expect(serverSource.slice(scopedCallStart)).not.toContain("liveChatStores");
  });
});
