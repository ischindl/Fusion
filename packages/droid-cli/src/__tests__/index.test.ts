import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ToolDescriptor = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

const runtimeMocks = vi.hoisted(() => {
  return {
    streamViaCli: vi.fn(() => ({ push: vi.fn(), end: vi.fn() })),
    discoverDroidModels: vi.fn(async () => ["droid-pro", "droid-max"]),
    validateCliPresenceAsync: vi.fn(async () => ({ ok: true })),
    validateCliAuthAsync: vi.fn(async () => undefined),
    killAllProcesses: vi.fn(),
    toolsFromContext: vi.fn((tools?: readonly ToolDescriptor[]) =>
      Array.isArray(tools)
        ? tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          }))
        : [],
    ),
    writeMcpConfig: vi.fn((_: unknown, hash: string) => `/tmp/droid-mcp-${hash}.json`),
  };
});

/*
 FNXC:ToolDispatchIntegrity 2026-11-11-04:02:
 RUFU-520. The surface derivation is deliberately NOT mocked: this file tests that the extension
 entry asks the live session which tools it may execute, so the real `reconcileToolSurface` from the
 droid runtime plugin has to answer. Only the transport and the file writer are faked.
*/
vi.mock("@fusion-plugin-examples/droid-runtime", async () => {
  const surface = await import("../../../../plugins/fusion-plugin-droid-runtime/src/tool-surface.js");
  return {
    ...runtimeMocks,
    reconcileToolSurface: surface.reconcileToolSurface,
    TOOL_NOT_AVAILABLE_MARKER: surface.TOOL_NOT_AVAILABLE_MARKER,
  };
});

const flushAsyncRegistration = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("droid-cli extension entrypoint", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    runtimeMocks.discoverDroidModels.mockResolvedValue(["droid-pro", "droid-max"]);
    runtimeMocks.validateCliPresenceAsync.mockResolvedValue({ ok: true });
    runtimeMocks.validateCliAuthAsync.mockResolvedValue(undefined);
    runtimeMocks.toolsFromContext.mockImplementation((tools?: readonly ToolDescriptor[]) =>
      Array.isArray(tools)
        ? tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          }))
        : [],
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers provider droid-cli synchronously without starting droid probes or discovery", async () => {
    const registerProvider = vi.fn();
    const mockPi = {
      registerProvider,
      on: vi.fn(),
      getAllTools: vi.fn(() => []),
      setActiveTools: vi.fn(),
    };

    const mod = await import("../../index");
    const result = mod.default(mockPi as never);
    await flushAsyncRegistration();

    expect(result).toBeUndefined();
    expect(runtimeMocks.validateCliPresenceAsync).not.toHaveBeenCalled();
    expect(runtimeMocks.validateCliAuthAsync).not.toHaveBeenCalled();
    expect(runtimeMocks.discoverDroidModels).not.toHaveBeenCalled();

    expect(registerProvider).toHaveBeenCalledTimes(1);
    const [providerId, config] = registerProvider.mock.calls[0] as [string, {
      baseUrl: string;
      api: string;
      apiKey: string;
      models: unknown[];
      streamSimple: Function;
    }];

    expect(providerId).toBe("droid-cli");
    expect(config.baseUrl).toBe("droid-cli");
    expect(config.api).toBe("droid-cli");
    expect(config.apiKey).toBe("unused");
    expect(config.models).toEqual([]);
    expect(typeof config.streamSimple).toBe("function");
  });

  it("runs validation once when a droid stream is actually used", async () => {
    const registerProvider = vi.fn();
    const mockPi = {
      registerProvider,
      on: vi.fn(),
      getAllTools: vi.fn(() => []),
      setActiveTools: vi.fn(),
    };

    const mod = await import("../../index");
    mod.default(mockPi as never);
    const config = registerProvider.mock.calls[0]?.[1] as {
      streamSimple: (model: unknown, context: unknown, options?: Record<string, unknown>) => unknown;
    };

    config.streamSimple({ id: "droid-pro" }, { messages: [] }, {});
    config.streamSimple({ id: "droid-pro" }, { messages: [] }, {});
    await flushAsyncRegistration();

    expect(runtimeMocks.validateCliPresenceAsync).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.validateCliAuthAsync).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.discoverDroidModels).not.toHaveBeenCalled();
  });

  it("discovers provider models only when explicitly requested", async () => {
    const mod = await import("../../index");

    await expect(mod.discoverDroidProviderModels()).resolves.toEqual([
      expect.objectContaining({ id: "droid-pro", name: "droid-pro", contextWindow: 200_000, maxTokens: 8_192 }),
      expect.objectContaining({ id: "droid-max", name: "droid-max", contextWindow: 200_000, maxTokens: 8_192 }),
    ]);

    expect(runtimeMocks.discoverDroidModels).toHaveBeenCalledTimes(1);
  });

  it("activates all registered tools on session_start", async () => {
    const sessionStartHandlers: Array<() => Promise<void>> = [];
    const mockPi = {
      registerProvider: vi.fn(),
      on: vi.fn((event: string, handler: () => Promise<void>) => {
        if (event === "session_start") sessionStartHandlers.push(handler);
      }),
      getAllTools: vi.fn(() => [{ name: "find" }, { name: "grep" }]),
      setActiveTools: vi.fn(),
    };

    const mod = await import("../../index");
    mod.default(mockPi as never);
    await flushAsyncRegistration();

    expect(sessionStartHandlers).toHaveLength(1);
    await sessionStartHandlers[0]();

    expect(mockPi.setActiveTools).toHaveBeenCalledWith(["find", "grep"]);
  });

  it("warns but still registers provider when cli presence check fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    runtimeMocks.validateCliPresenceAsync.mockResolvedValue({
      ok: false,
      error: { message: "droid CLI missing" },
    } as any);

    const mockPi = {
      registerProvider: vi.fn(),
      on: vi.fn(),
      getAllTools: vi.fn(() => []),
      setActiveTools: vi.fn(),
    };

    const mod = await import("../../index");
    mod.default(mockPi as never);
    const config = mockPi.registerProvider.mock.calls[0]?.[1] as {
      streamSimple: (model: unknown, context: unknown, options?: Record<string, unknown>) => unknown;
    };
    config.streamSimple({ id: "droid-pro" }, { messages: [] }, {});
    await flushAsyncRegistration();

    expect(warnSpy).toHaveBeenCalledWith("[droid-cli] droid CLI missing");
    expect(runtimeMocks.validateCliAuthAsync).not.toHaveBeenCalled();
    expect(mockPi.registerProvider).toHaveBeenCalledWith("droid-cli", expect.objectContaining({ models: [] }));
  });

  it("falls back to empty models when discovery throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    runtimeMocks.discoverDroidModels.mockRejectedValue(new Error("boom"));

    const mod = await import("../../index");
    await expect(mod.discoverDroidProviderModels()).resolves.toEqual([]);

    expect(warnSpy).toHaveBeenCalledWith(
      "[droid-cli] model auto-discovery failed; registering provider with empty model list",
      expect.any(Error),
    );
  });

  it("wires context tools to mcp config and passes mcpConfigPath into streamViaCli", async () => {
    const registerProvider = vi.fn();
    // RUFU-520: the transcript names the tools that were declared; the session's registry plus its
    // active set decide which of them this run may execute. State both, as a real session does.
    const tools = [
      {
        name: "fn_web_fetch",
        description: "Fetch URL",
        parameters: { type: "object", properties: { url: { type: "string" } } },
      },
    ];
    const mockPi = {
      registerProvider,
      on: vi.fn(),
      getAllTools: vi.fn(() => [{ ...tools[0], exposure: "direct" }]),
      getActiveTools: vi.fn(() => ["fn_web_fetch"]),
      setActiveTools: vi.fn(),
    };

    const mod = await import("../../index");
    mod.default(mockPi as never);
    await flushAsyncRegistration();

    const config = registerProvider.mock.calls[0]?.[1] as {
      streamSimple: (model: unknown, context: unknown, options: Record<string, unknown>) => unknown;
    };

    const context = { messages: [{ role: "system", content: "Use current tools", toolsAdded: tools }] };

    config.streamSimple({ id: "droid-pro" }, context, { temperature: 0.2 });

    expect(runtimeMocks.toolsFromContext).toHaveBeenCalledWith(tools);
    expect(runtimeMocks.writeMcpConfig).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.streamViaCli).toHaveBeenCalledWith(
      { id: "droid-pro" },
      expect.objectContaining({ ...context, systemPrompt: "Use current tools", tools }),
      expect.objectContaining({ temperature: 0.2, mcpConfigPath: expect.stringContaining("/tmp/droid-mcp-") }),
    );
  });

  it("declares an active registered tool the transcript never mentioned", async () => {
    // RUFU-520, the drop direction: a tool the session has active must be declared even when no
    // earlier turn named it, or the prompt offers a coordination tool the schema cannot back.
    const registerProvider = vi.fn();
    const mockPi = {
      registerProvider,
      on: vi.fn(),
      getAllTools: vi.fn(() => [
        { name: "fn_task_show", description: "Show a task", parameters: { type: "object" }, exposure: "direct" },
      ]),
      getActiveTools: vi.fn(() => ["fn_task_show"]),
      setActiveTools: vi.fn(),
    };

    const mod = await import("../../index");
    mod.default(mockPi as never);
    await flushAsyncRegistration();

    const config = registerProvider.mock.calls[0]?.[1] as {
      streamSimple: (model: unknown, context: unknown, options?: Record<string, unknown>) => unknown;
    };

    config.streamSimple({ id: "droid-pro" }, { messages: [] }, {});

    expect(runtimeMocks.writeMcpConfig).toHaveBeenCalledTimes(1);
    const declared = runtimeMocks.toolsFromContext.mock.calls.at(-1)?.[0] as unknown as Array<{ name: string }>;
    expect(declared.map((tool) => tool.name)).toEqual(["fn_task_show"]);
  });

  it("declares no custom tool when the session has none active", async () => {
    // RUFU-520. The deleted subject of this file's earlier "falls back to getCustomToolDefs" case
    // was the registry fallback that declared every registered tool regardless of the session's
    // authority. The replacement truth: registered-but-not-executable is never declared.
    runtimeMocks.toolsFromContext.mockReturnValue([]);

    const registerProvider = vi.fn();
    const mockPi = {
      registerProvider,
      on: vi.fn(),
      getAllTools: vi.fn(() => [{ name: "ls" }, { name: "fn_task_show" }]),
      getActiveTools: vi.fn(() => []),
      setActiveTools: vi.fn(),
    };

    const mod = await import("../../index");
    mod.default(mockPi as never);
    await flushAsyncRegistration();

    const config = registerProvider.mock.calls[0]?.[1] as {
      streamSimple: (model: unknown, context: unknown, options?: Record<string, unknown>) => unknown;
    };

    config.streamSimple({ id: "droid-pro" }, { messages: [] }, {});

    expect(runtimeMocks.writeMcpConfig).not.toHaveBeenCalled();
    const callArgs = runtimeMocks.streamViaCli.mock.calls.at(-1) as unknown as [unknown, { tools?: unknown[] }];
    expect(callArgs[1]?.tools).toEqual([]);
  });

  it("does not reuse an earlier call's config when the registry becomes unreadable", async () => {
    // RUFU-520 primary refusal, asserted on the droid clone so both bridges prove the same
    // invariant: an unprovable surface declares nothing rather than inheriting a stale list.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registerProvider = vi.fn();
    const registry: unknown[] = [
      { name: "fn_task_show", description: "Show a task", parameters: { type: "object" }, exposure: "direct" },
    ];
    const mockPi = {
      registerProvider,
      on: vi.fn(),
      getAllTools: vi.fn(() => registry),
      getActiveTools: vi.fn(() => ["fn_task_show"]),
      setActiveTools: vi.fn(),
    };

    const mod = await import("../../index");
    mod.default(mockPi as never);
    await flushAsyncRegistration();

    const config = registerProvider.mock.calls[0]?.[1] as {
      streamSimple: (model: unknown, context: unknown, options?: Record<string, unknown>) => unknown;
    };
    const messages = [
      {
        role: "system",
        content: "prompt",
        toolsAdded: [{ name: "fn_task_show", description: "Show a task", parameters: {} }],
      },
    ];

    config.streamSimple({ id: "droid-pro" }, { messages }, {});
    const first = (runtimeMocks.streamViaCli.mock.calls.at(-1) as unknown as [unknown, unknown, { mcpConfigPath?: string }])[2];
    expect(first?.mcpConfigPath).toEqual(expect.stringContaining("/tmp/droid-mcp-"));

    registry.push(1 as never);
    (mockPi.getAllTools as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    runtimeMocks.streamViaCli.mockClear();
    config.streamSimple({ id: "droid-pro" }, { messages }, {});

    const degraded = runtimeMocks.streamViaCli.mock.calls.at(-1) as unknown as [unknown, unknown, { mcpConfigPath?: string }];
    expect(degraded[2]?.mcpConfigPath).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("TOOL_NOT_AVAILABLE"));

    // Not sticky: the next call that can read the session re-declares the tool.
    (mockPi.getAllTools as ReturnType<typeof vi.fn>).mockReturnValue(registry.slice(0, 1));
    runtimeMocks.streamViaCli.mockClear();
    config.streamSimple({ id: "droid-pro" }, { messages }, {});

    const recovered = runtimeMocks.streamViaCli.mock.calls.at(-1) as unknown as [unknown, unknown, { mcpConfigPath?: string }];
    expect(recovered[2]?.mcpConfigPath).toEqual(expect.stringContaining("/tmp/droid-mcp-"));
    warnSpy.mockRestore();
  });
});
