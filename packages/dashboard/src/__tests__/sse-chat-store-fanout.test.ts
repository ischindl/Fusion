/*
FNXC:ChatRemoteGenerationMirror 2026-09-17-19:25:
A bus connection without a projectId must bridge EVERY live chat store, not just the default
one: chat mutations fire on per-project scoped ChatStore instances, so an open global chat view
was deaf to scoped generations (no working mirror, no live rows). These cases pin fan-out, the
identity dedupe, and detach-on-close for the whole set.
*/

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { ChatStore, TaskStore } from "@fusion/core";
import { createSSE } from "../sse.js";

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

function createMockStore(): TaskStore {
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

function openWithChatStores(chatStore: ChatStore | ChatStore[]): { res: MockResponse; socket: MockSocket } {
  const socket = new MockSocket();
  const req = new EventEmitter() as Request & { query: Record<string, string>; socket: MockSocket };
  req.query = { clientId: `fanout-${Math.random()}` };
  req.socket = socket;
  const res = new MockResponse(socket);
  createSSE(createMockStore(), undefined, undefined, undefined, undefined, undefined, undefined, chatStore)(
    req,
    res as unknown as Response,
  );
  return { res, socket };
}

function writtenSse(res: MockResponse): string {
  return res.write.mock.calls.map((c) => String(c[0])).join("");
}

describe("createSSE chat store fan-out", () => {
  it("bridges chat:session:updated from every store in the set", () => {
    const a = makeChatStore();
    const b = makeChatStore();
    const { res } = openWithChatStores([a, b]);
    a.emit("chat:session:updated", { id: "chat-a", inFlightGeneration: { status: "generating" } });
    b.emit("chat:session:updated", { id: "chat-b", inFlightGeneration: { status: "generating" } });
    const out = writtenSse(res);
    expect(out).toContain('"id":"chat-a"');
    expect(out).toContain('"id":"chat-b"');
    expect(out).toContain('"isGenerating":true');
  });

  it("bridges a shared store identity exactly once", () => {
    const shared = makeChatStore();
    const { res } = openWithChatStores([shared, shared]);
    shared.emit("chat:session:updated", { id: "chat-shared", inFlightGeneration: null });
    const out = writtenSse(res);
    expect(out.match(/chat-shared/g)?.length).toBe(1);
  });

  it("detaches every store when the connection closes", () => {
    const a = makeChatStore();
    const b = makeChatStore();
    const offA = vi.spyOn(a, "off");
    const offB = vi.spyOn(b, "off");
    const { socket } = openWithChatStores([a, b]);
    socket.emit("close");
    expect(offA).toHaveBeenCalledWith("chat:session:updated", expect.any(Function));
    expect(offB).toHaveBeenCalledWith("chat:session:updated", expect.any(Function));
  });

  it("keeps the single-store form working", () => {
    const only = makeChatStore();
    const { res } = openWithChatStores(only);
    only.emit("chat:session:updated", { id: "chat-only", inFlightGeneration: null });
    expect(writtenSse(res)).toContain("chat-only");
  });
});
