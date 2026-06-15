import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// Synthetic ACP session/update sequence the mocked prompt() will replay.
let scriptedUpdates: Array<Record<string, unknown>> = [];

// Driver validates the bridge path with existsSync — make the fake path "exist".
vi.mock("node:fs", () => ({ existsSync: () => true }));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = vi.fn();
    proc.pid = 4242;
    return proc;
  }),
}));

// Mock the ACP SDK: ClientSideConnection.prompt() replays scriptedUpdates onto
// the client handler, then resolves — so we exercise the real translation logic.
vi.mock("@agentclientprotocol/sdk", () => ({
  PROTOCOL_VERSION: 1,
  ndJsonStream: vi.fn(() => ({})),
  ClientSideConnection: vi.fn(function (this: Record<string, unknown>, factory: () => { sessionUpdate: (p: unknown) => Promise<void> }) {
    const handler = factory();
    this.initialize = vi.fn(async () => ({ protocolVersion: 1 }));
    this.newSession = vi.fn(async () => ({ sessionId: "s1" }));
    this.prompt = vi.fn(async () => {
      for (const u of scriptedUpdates) await handler.sessionUpdate({ update: u });
      return { stopReason: "end_turn" };
    });
  }),
}));

const { MockStream } = vi.hoisted(() => {
  const MockStream: unknown = vi.fn(function (this: Record<string, unknown>) {
    const events: Array<Record<string, unknown>> = [];
    this.push = vi.fn((e: Record<string, unknown>) => events.push(e));
    this.end = vi.fn();
    this._events = events;
  });
  return { MockStream };
});

vi.mock("@earendil-works/pi-ai", () => ({
  AssistantMessageEventStream: MockStream,
  calculateCost: vi.fn(),
}));

import { streamViaAcp } from "../acp-driver.js";

const MODEL = { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" } as never;
const CTX = { messages: [{ role: "user", content: "hi" }] } as never;
const OPTS = { bridgePath: "/fake/claude-code-cli-acp", cwd: "/tmp", mcpServers: [], bridgeEnv: { HOME: "/h", PATH: "/b" } };

function eventsOf(stream: { _events: Array<Record<string, unknown>> }) {
  return stream._events;
}
const flush = () => new Promise((r) => setTimeout(r, 30));

describe("streamViaAcp — ACP→pi translation (U11)", () => {
  beforeEach(() => { scriptedUpdates = []; });

  it("translates agent_message_chunk text into pi text events + done(stop)", async () => {
    scriptedUpdates = [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } },
    ];
    const stream = streamViaAcp(MODEL, CTX, OPTS) as unknown as { _events: Array<Record<string, unknown>> };
    await flush();
    const types = eventsOf(stream).map((e) => e.type);
    expect(types).toContain("start");
    expect(types).toContain("text_start");
    expect(types.filter((t) => t === "text_delta").length).toBe(2);
    const done = eventsOf(stream).find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done!.reason).toBe("stop");
  });

  it("breaks early on a tool_call: emits toolcall_start + done(toolUse), no execution", async () => {
    scriptedUpdates = [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "let me check" } },
      { sessionUpdate: "tool_call", toolCallId: "t1", _meta: { claudeCode: { toolName: "mcp__custom-tools__fn_task_list" } }, rawInput: {} },
      // anything after the tool call must be ignored (break-early)
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "SHOULD NOT APPEAR" } },
    ];
    const stream = streamViaAcp(MODEL, CTX, OPTS) as unknown as { _events: Array<Record<string, unknown>> };
    await flush();
    const types = eventsOf(stream).map((e) => e.type);
    expect(types).toContain("toolcall_start");
    const done = eventsOf(stream).find((e) => e.type === "done");
    expect(done!.reason).toBe("toolUse");
    // break-early: the post-tool text delta must not have been translated
    const deltas = eventsOf(stream).filter((e) => e.type === "text_delta").map((e) => e.delta);
    expect(deltas.join("")).not.toContain("SHOULD NOT APPEAR");
  });

  it("does NOT break early on an internal ToolSearch; breaks on the real fn_* tool (U9 sequence)", async () => {
    // Claude emits ToolSearch (not pi-known) to load the deferred MCP tool FIRST,
    // then the real mcp__custom-tools__fn_task_list. The old code aborted on
    // ToolSearch; the gated code must wait for the real tool (P0 fix).
    scriptedUpdates = [
      { sessionUpdate: "tool_call", toolCallId: "ts1", _meta: { claudeCode: { toolName: "ToolSearch" } }, rawInput: { query: "x" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "found it, calling" } },
      { sessionUpdate: "tool_call", toolCallId: "real", _meta: { claudeCode: { toolName: "mcp__custom-tools__fn_task_list" } }, rawInput: {} },
    ];
    const stream = streamViaAcp(MODEL, CTX, OPTS) as unknown as { _events: Array<Record<string, unknown>> };
    await flush();
    // The text AFTER ToolSearch must have been processed (we didn't abort on ToolSearch)
    const deltas = eventsOf(stream).filter((e) => e.type === "text_delta").map((e) => e.delta);
    expect(deltas.join("")).toContain("found it");
    // And we broke on the real tool
    expect(eventsOf(stream).some((e) => e.type === "toolcall_start")).toBe(true);
    const done = eventsOf(stream).find((e) => e.type === "done");
    expect(done!.reason).toBe("toolUse");
  });

  it("ends with done even when the turn produces no content", async () => {
    scriptedUpdates = [];
    const stream = streamViaAcp(MODEL, CTX, OPTS) as unknown as { _events: Array<Record<string, unknown>> };
    await flush();
    expect(eventsOf(stream).some((e) => e.type === "done")).toBe(true);
  });
});
