/**
 * RUFU-334 — the Claude runtime lane cannot inherit a working directory.
 *
 * FNXC:AgentCwdBoundary 2026-10-18-10:31:
 * Both Claude transports (`streamViaCli` → `spawnClaude`, `streamViaAcp` → the bridge
 * child + ACP `session/new`) used to end their cwd chain with `?? process.cwd()`.
 * This extension is loaded *inside* the engine/dashboard process, so that value is the
 * server's launch directory — a live production deployment checkout on the incident
 * host — and every Claude turn ran a write-capable `claude` there with no task or
 * agent attribution. These cases pin the replacement contract: a working directory is
 * a caller obligation, its absence is a named error raised before any child exists,
 * and an absolute path survives verbatim (transport identity depends on it).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// The ACP driver validates the injected bridge path with existsSync; keep the rest of
// node:fs real so process-manager's system-prompt file handling stays exercised.
const fsSpies = vi.hoisted(() => ({ writeFileSync: vi.fn(), unlinkSync: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: () => true, writeFileSync: fsSpies.writeFileSync, unlinkSync: fsSpies.unlinkSync };
});

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as FakeChild;
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = vi.fn();
    proc.pid = 4242;
    return proc;
  }),
}));

// scriptedUpdates lets the fake prompt() replay a real ACP translation turn.
let scriptedUpdates: Array<Record<string, unknown>> = [];

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

import { spawn } from "node:child_process";
import { ClientSideConnection } from "@agentclientprotocol/sdk";
import { resolveRequiredCwd, MissingAgentCwdError } from "../cwd-contract.js";
import { spawnClaude } from "../process-manager.js";
import { streamViaCli } from "../provider.js";
import { streamViaAcp } from "../acp-driver.js";

const MODEL = { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" } as never;
const CTX = { messages: [{ role: "user", content: "hi" }] } as never;
/** A checkout that is provably NOT this process's directory. */
const CHECKOUT = "/work/fusion-checkouts/fusion-rufu-334";
const BRIDGE = "/fake/claude-code-cli-acp";

const flush = () => new Promise((r) => setTimeout(r, 30));
const spawnCalls = () => vi.mocked(spawn).mock.calls as unknown as Array<[string, string[], Record<string, unknown>]>;
const acpConnections = () =>
  vi.mocked(ClientSideConnection).mock.instances as unknown as Array<{
    newSession: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
  }>;

/** Every string the transports handed to a child spawn or to ACP `session/new`. */
function valuesSentToChildren(): string[] {
  const values: string[] = [];
  for (const [, args, opts] of spawnCalls()) {
    values.push(...args.map(String));
    for (const v of Object.values(opts ?? {})) if (typeof v === "string") values.push(v);
  }
  for (const conn of acpConnections()) {
    for (const call of conn.newSession?.mock.calls ?? []) {
      for (const v of Object.values((call[0] ?? {}) as Record<string, unknown>)) if (typeof v === "string") values.push(v);
    }
  }
  return values;
}

beforeEach(() => {
  scriptedUpdates = [];
  vi.mocked(spawn).mockClear();
  vi.mocked(ClientSideConnection).mockClear();
});

describe("resolveRequiredCwd — the shared contract", () => {
  it("refuses a missing directory and names the lane that forgot it", () => {
    expect(() => resolveRequiredCwd(undefined, "streamViaAcp")).toThrow(MissingAgentCwdError);
    expect(() => resolveRequiredCwd(undefined, "streamViaAcp")).toThrow(/"streamViaAcp" requires an explicit working directory/);
    expect(() => resolveRequiredCwd("   ", "spawnClaude")).toThrow(/"spawnClaude"/);
  });

  it("refuses a relative directory, because spawn would resolve it against the process directory", () => {
    // A relative path is the same leak wearing a relative spelling.
    expect(() => resolveRequiredCwd("kb-worktrees/prod-deploy", "streamViaCli")).toThrow(/not an absolute path/);
  });

  it("returns an absolute directory verbatim — no resolve(), no normalize()", () => {
    // acp-driver.ts reuses a warm bridge only while `warm.cwd === cwd`, so a normalised
    // value here would strand the warm entry while the caller still believes it matched.
    const unnormalised = "/work/fusion-checkouts/fusion-rufu-334/nested/../";
    expect(resolveRequiredCwd(unnormalised, "streamViaCli")).toBe(unnormalised);
  });
});

describe("spawnClaude — refusal before the child exists", () => {
  it("throws a named error and never spawns when no directory is given", () => {
    expect(() => spawnClaude("claude-sonnet-4-5", undefined, {})).toThrow(MissingAgentCwdError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns in the declared checkout", () => {
    spawnClaude("claude-sonnet-4-5", undefined, { cwd: CHECKOUT });
    expect(spawnCalls()[0][2].cwd).toBe(CHECKOUT);
  });
});

describe("streamViaCli — no serve-root inheritance", () => {
  it("throws synchronously for a bare call and spawns nothing", () => {
    // Synchronous, not a stream error: the caller learns the lane mis-steered before any
    // child exists, and `stream.error` would leave an emitted stream to inspect.
    expect(() => streamViaCli(MODEL, CTX)).toThrow(MissingAgentCwdError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("still refuses when the caller passes other options but no directory", () => {
    expect(() => streamViaCli(MODEL, CTX, { sessionId: "sess-1" } as never)).toThrow(MissingAgentCwdError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("forwards an explicit checkout verbatim into the child's cwd", async () => {
    const controller = new AbortController();
    streamViaCli(MODEL, CTX, { cwd: CHECKOUT, signal: controller.signal } as never);
    expect(spawnCalls()[0][2].cwd).toBe(CHECKOUT);
    controller.abort();
    await flush();
  });
});

describe("streamViaAcp — neither the bridge child nor session/new inherits the process directory", () => {
  const savedReuse = process.env.FUSION_CLAUDE_ACP_REUSE;
  afterEach(() => {
    if (savedReuse === undefined) delete process.env.FUSION_CLAUDE_ACP_REUSE;
    else process.env.FUSION_CLAUDE_ACP_REUSE = savedReuse;
  });

  it("throws synchronously, spawning no bridge and opening no session", () => {
    expect(() => streamViaAcp(MODEL, CTX, { bridgePath: BRIDGE })).toThrow(MissingAgentCwdError);
    expect(spawn).not.toHaveBeenCalled();
    expect(acpConnections()).toHaveLength(0);
  });

  it("passes the declared checkout to the bridge child AND to session/new", async () => {
    scriptedUpdates = [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } }];
    streamViaAcp(MODEL, CTX, { bridgePath: BRIDGE, cwd: CHECKOUT } as never);
    await flush();

    const bridgeSpawn = spawnCalls()[0];
    expect(bridgeSpawn[2].cwd).toBe(CHECKOUT);
    const conn = acpConnections()[0];
    expect(conn.newSession.mock.calls[0][0].cwd).toBe(CHECKOUT);
  });

  it("treats a changed directory as a different warm session, and never sends process.cwd()", async () => {
    process.env.FUSION_CLAUDE_ACP_REUSE = "1";
    const turn1 = { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] } as never;
    const turn2 = { messages: [...(turn1 as unknown as { messages: unknown[] }).messages, { role: "user", content: "again" }] } as never;
    const turn3 = { messages: [...(turn2 as unknown as { messages: unknown[] }).messages, { role: "assistant", content: "ok" }] } as never;
    scriptedUpdates = [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "one" } }];

    streamViaAcp(MODEL, turn1, { bridgePath: BRIDGE, cwd: CHECKOUT, sessionId: "conv-cwd" } as never);
    await flush();
    expect(acpConnections()).toHaveLength(1);

    // Same session id, same directory, new message → the warm connection is reused, so
    // session/new must NOT be re-issued: identity comparison runs on the verbatim string.
    streamViaAcp(MODEL, turn2, { bridgePath: BRIDGE, cwd: CHECKOUT, sessionId: "conv-cwd" } as never);
    await flush();
    expect(acpConnections()).toHaveLength(1);
    expect(acpConnections()[0].newSession).toHaveBeenCalledTimes(1);

    // A different checkout cannot reuse the warm connection — it must re-open with the
    // new path rather than keep the old one or fall back to the process directory.
    const other = "/work/fusion-checkouts/fusion-other-task";
    streamViaAcp(MODEL, turn3, { bridgePath: BRIDGE, cwd: other, sessionId: "conv-cwd" } as never);
    await flush();

    const newSessionArgs = acpConnections().flatMap((c) => c.newSession.mock.calls.map((call) => call[0].cwd));
    expect(newSessionArgs).toContain(other);
    expect(newSessionArgs.some((cwd) => cwd === process.cwd())).toBe(false);
    for (const child of vi.mocked(spawn).mock.results.map((r) => r.value as EventEmitter)) child.emit("close", 0);
  });

  it("never names this process's directory in any spawn argv, spawn option, or session/new payload", async () => {
    scriptedUpdates = [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } }];
    streamViaCli(MODEL, CTX, { cwd: CHECKOUT } as never);
    streamViaAcp(MODEL, CTX, { bridgePath: BRIDGE, cwd: CHECKOUT } as never);
    await flush();

    const sent = valuesSentToChildren();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent).not.toContain(process.cwd());
    for (const child of vi.mocked(spawn).mock.results.map((r) => r.value as EventEmitter)) child.emit("close", 0);
  });
});

afterEach(() => {
  // The CLI lane leaves a fake child reading from a live PassThrough; release it so a
  // later file in this worker does not inherit a pending stream.
  for (const child of vi.mocked(spawn).mock.results.map((r) => r.value as FakeChild | undefined)) {
    child?.stdout?.end?.();
    child?.emit?.("close", 0);
  }
});
