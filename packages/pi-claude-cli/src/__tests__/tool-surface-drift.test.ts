import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * RUFU-520. Back-to-back proof that tool-surface drift cannot survive between two calls.
 *
 * The defect was not a wrong handler inside pi: pi selects a handler by the requested name. It was
 * the surface this extension declared to the Claude CLI. `ensureMcpConfig` answered from
 * `cachedMcpConfig?.configPath` whenever its own derivation came up empty or threw, so a later call
 * ran with an earlier call's tool list, and the model - told by the engine prompt that
 * `fn_task_show` existed but seeing only `read` in the schema file - called `read` with a fabricated
 * `/fusion/fn_read_messages` path. The board then consumed a fabricated observation.
 *
 * These tests drive the real extension entry (register -> streamSimple) with the transport stubbed,
 * so what is asserted is exactly what the bridge would hand the subprocess: the config path and the
 * tool list. Nothing here mocks the derivation being tested.
 */

const { streamViaCli, streamViaAcp, writeMcpConfig } = vi.hoisted(() => ({
  streamViaCli: vi.fn(() => ({ kind: "cli" })),
  streamViaAcp: vi.fn(() => ({ kind: "acp" })),
  writeMcpConfig: vi.fn(
    (toolDefs: Array<{ name: string }>, hash: string) => `/tmp/fusion-mcp-${hash}.json`,
  ),
}));
vi.mock("../provider.js", () => ({ streamViaCli }));
vi.mock("../acp-driver.js", () => ({ streamViaAcp }));
vi.mock("../process-manager.js", () => ({
  validateCliPresenceAsync: vi.fn(async () => ({ ok: true })),
  validateCliAuthAsync: vi.fn(async () => ({ ok: true })),
  killAllProcesses: vi.fn(),
}));
vi.mock("../mcp-config.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../mcp-config.js")>();
  return { ...real, writeMcpConfig };
});

import register from "../../index.js";

interface FakeSession {
  /** Names pi reports as active for this turn (the set it declares to the model). */
  active: string[];
  /** The runtime registry as pi reports it. */
  registry: unknown;
}

const BUILTIN = { name: "read", description: "Read a file", parameters: { type: "object" } };

function toolInfo(name: string) {
  return {
    name,
    description: `schema for ${name}`,
    parameters: { type: "object", properties: { id: { type: "string" } } },
    exposure: "direct",
  };
}

/** A system message declaring these tools, as pi's own transcript deltas carry them. */
function systemDelta(added: string[], removed: string[] = []) {
  return {
    role: "system" as const,
    content: "",
    toolsAdded: added.map((name) => ({ name, description: `declared ${name}`, parameters: {} })),
    toolsRemoved: removed.map((name) => ({ name })),
  };
}

function registerStreamSimple(session: FakeSession) {
  let streamSimple: ((model: unknown, context: unknown, options?: unknown) => unknown) | undefined;
  const pi = {
    registerProvider: (_name: string, cfg: { streamSimple: typeof streamSimple }) => {
      streamSimple = cfg.streamSimple;
    },
    on: vi.fn(),
    getAllTools: () => session.registry,
    getActiveTools: () => session.active,
    setActiveTools: vi.fn(),
  } as never;
  register(pi);
  if (!streamSimple) throw new Error("extension registered no provider");
  return streamSimple;
}

const MODEL = { id: "claude-sonnet-4-5" } as never;

/** Call the provider and report what the bridge would receive. */
function call(
  streamSimple: ReturnType<typeof registerStreamSimple>,
  messages: unknown[],
): { mcpConfigPath: unknown; declaredTools: string[] } {
  streamSimple(MODEL, { messages }, { cwd: process.cwd() });
  const args = streamViaCli.mock.calls.at(-1) as unknown as [
    unknown,
    { tools?: Array<{ name: string }> },
    { mcpConfigPath?: string },
  ];;
  return {
    mcpConfigPath: args[2]?.mcpConfigPath,
    declaredTools: (args[1]?.tools ?? []).map((tool) => tool.name),
  };
}

describe("RUFU-520 tool-surface drift across back-to-back calls", () => {
  beforeEach(() => {
    streamViaCli.mockClear();
    streamViaAcp.mockClear();
    writeMcpConfig.mockClear();
  });

  it("re-declares the surface when the session's active set changes mid-session", () => {
    const session: FakeSession = {
      active: ["read", "fn_task_show"],
      registry: [toolInfo("fn_task_show"), toolInfo("fn_task_list")],
    };
    const streamSimple = registerStreamSimple(session);

    const first = call(streamSimple, [
      systemDelta(["read", "fn_task_show"]),
      { role: "user", content: "go" },
    ]);
    expect(first.declaredTools).toEqual(["read", "fn_task_show"]);
    expect(first.mcpConfigPath).toBeTypeOf("string");

    // Mid-session the runtime swaps which tools this session may execute and pi records the delta.
    session.active = ["read", "fn_task_list"];

    const second = call(streamSimple, [
      systemDelta(["read", "fn_task_show"]),
      { role: "user", content: "go" },
      systemDelta(["fn_task_list"], ["fn_task_show"]),
      { role: "user", content: "continue" },
    ]);

    // The name that just lost authority is gone from both the config and the prompt-facing list,
    // and the name that gained it is present even though no earlier turn ever declared it.
    expect(second.declaredTools).toEqual(["read", "fn_task_list"]);
    expect(second.mcpConfigPath).toBeTypeOf("string");
    expect(second.mcpConfigPath).not.toBe(first.mcpConfigPath);
  });

  it("declares nothing rather than the previous turn's config when the registry is unreadable", () => {
    const session: FakeSession = { active: ["read", "fn_task_show"], registry: [toolInfo("fn_task_show")] };
    const streamSimple = registerStreamSimple(session);

    const first = call(streamSimple, [systemDelta(["read", "fn_task_show"]), { role: "user", content: "go" }]);
    expect(first.mcpConfigPath).toBeTypeOf("string");

    // The failure that used to be answered with `cachedMcpConfig?.configPath`.
    session.registry = undefined;
    const writesBefore = writeMcpConfig.mock.calls.length;

    const degraded = call(streamSimple, [
      systemDelta(["read", "fn_task_show"]),
      { role: "user", content: "go" },
    ]);

    expect(degraded.mcpConfigPath).toBeUndefined();
    expect(degraded.declaredTools).toEqual(["read"]);
    expect(writeMcpConfig.mock.calls.length).toBe(writesBefore);

    // And the failure is not sticky: a later call that can read the session re-declares the tools.
    session.registry = [toolInfo("fn_task_show")];
    const recovered = call(streamSimple, [
      systemDelta(["read", "fn_task_show"]),
      { role: "user", content: "go" },
    ]);
    expect(recovered.mcpConfigPath).toBeTypeOf("string");
    expect(recovered.declaredTools).toEqual(["read", "fn_task_show"]);
  });

  it("writes no config at all on the first call when the session has no custom tools", () => {
    const session: FakeSession = { active: ["read"], registry: [] };
    const streamSimple = registerStreamSimple(session);

    const only = call(streamSimple, [systemDelta(["read"]), { role: "user", content: "go" }]);

    expect(writeMcpConfig).not.toHaveBeenCalled();
    expect(only.mcpConfigPath).toBeUndefined();
  });

  it("reuses the config file only while the derived surface is byte-identical", () => {
    const session: FakeSession = { active: ["read", "fn_task_show"], registry: [toolInfo("fn_task_show")] };
    const streamSimple = registerStreamSimple(session);
    const messages = [systemDelta(["read", "fn_task_show"]), { role: "user", content: "go" }];

    const first = call(streamSimple, messages);
    const writesAfterFirst = writeMcpConfig.mock.calls.length;
    const second = call(streamSimple, [...messages, { role: "user", content: "and again" }]);

    expect(second.mcpConfigPath).toBe(first.mcpConfigPath);
    expect(writeMcpConfig.mock.calls.length).toBe(writesAfterFirst);
  });

  it("hands the ACP route the same reconciled surface as the -p route", () => {
    process.env.FUSION_CLAUDE_ACP = "1";
    process.env.FUSION_CLAUDE_ACP_BRIDGE = "/usr/bin/true";
    try {
      const session: FakeSession = {
        active: ["read", "fn_task_list"],
        registry: [toolInfo("fn_task_show"), toolInfo("fn_task_list")],
      };
      const streamSimple = registerStreamSimple(session);

      streamSimple(MODEL, { messages: [systemDelta(["read", "fn_task_show"]), { role: "user", content: "go" }] }, { cwd: process.cwd() });

      const callArgs = streamViaAcp.mock.calls.at(-1) as unknown as [
        unknown,
        unknown,
        { mcpServers?: Array<{ args?: string[] }> },
      ];
      expect(callArgs).toBeDefined();
      // The ACP spec carries the tool list in the schema file it points at, not inline.
      const schemaPath = callArgs[2]?.mcpServers?.[0]?.args?.[1];
      expect(typeof schemaPath).toBe("string");
      const declared = JSON.parse(readFileSync(String(schemaPath), "utf-8")).map(
        (tool: { name: string }) => tool.name,
      );
      // The replay names fn_task_show, which this turn no longer executes; only the live surface is
      // offered to the bridge.
      expect(declared).toEqual(["fn_task_list"]);
    } finally {
      delete process.env.FUSION_CLAUDE_ACP;
      delete process.env.FUSION_CLAUDE_ACP_BRIDGE;
    }
  });
});
