import { describe, it, expect, vi, beforeEach } from "vitest";

const registerProvider = vi.fn();
const on = vi.fn();
const getAllTools = vi.fn(() => [{ name: "read" }, { name: "bash" }, { name: "custom_tool", description: "c", parameters: {} }]);
const setActiveTools = vi.fn();
const streamViaCli = vi.fn(() => ({ mocked: true }));
const writeMcpConfig = vi.fn(() => "/tmp/droid-mcp.json");
const toolsFromContext = vi.fn(() => [{ name: "custom_tool", description: "c", inputSchema: {} }]);

vi.mock("../../src/provider.js", () => ({ streamViaCli }));
vi.mock("../../src/mcp-config.js", () => ({
  getCustomToolDefs: vi.fn(() => [{ name: "custom_tool", description: "c", inputSchema: {} }]),
  toolsFromContext,
  writeMcpConfig,
}));
vi.mock("../../src/process-manager.js", () => ({
  validateCliPresenceAsync: vi.fn(async () => ({ ok: true })),
  validateCliAuthAsync: vi.fn(async () => true),
  killAllProcesses: vi.fn(),
  discoverDroidModels: vi.fn(async () => ["droid-pro", "droid-max", "droid-pro"]),
}));

describe("droid-cli extension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers provider id droid-cli with deduped discovered models", async () => {
    const mod = await import("../../index.js");
    mod.default({ registerProvider, on, getAllTools, setActiveTools } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(registerProvider).toHaveBeenCalledTimes(1);
    const [providerId, config] = registerProvider.mock.calls[0];
    expect(providerId).toBe("droid-cli");
    expect(config.models.map((m: { id: string }) => m.id)).toEqual(["droid-pro", "droid-max"]);
  });

  it("wires MCP config into streamSimple and reuses cache for same tool set", async () => {
    const mod = await import("../../index.js");
    mod.default({ registerProvider, on, getAllTools, setActiveTools } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const config = registerProvider.mock.calls[0][1];
    const model = { provider: "droid-cli", id: "droid-pro" };
    const context = { tools: [{ name: "custom_tool", description: "c", parameters: {} }] };
    config.streamSimple(model, context, { sessionId: "s1" });
    config.streamSimple(model, context, { sessionId: "s2" });

    expect(streamViaCli).toHaveBeenCalledTimes(2);
    const firstCall = (streamViaCli as unknown as { mock: { calls: Array<unknown[]> } }).mock.calls[0] ?? [];
    const firstCallOptions = firstCall[2] as { mcpConfigPath?: string } | undefined;
    expect(firstCallOptions?.mcpConfigPath).toBe("/tmp/droid-mcp.json");
    expect(writeMcpConfig).toHaveBeenCalledTimes(1);
  });

  it("activates all tools on session_start", async () => {
    const mod = await import("../../index.js");
    mod.default({ registerProvider, on, getAllTools, setActiveTools } as never);
    const sessionStart = on.mock.calls.find((c) => c[0] === "session_start")?.[1];
    await sessionStart();
    expect(setActiveTools).toHaveBeenCalledWith(["read", "bash", "custom_tool"]);
  });
});
