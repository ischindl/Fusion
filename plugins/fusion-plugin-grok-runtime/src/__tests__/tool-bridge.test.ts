import { describe, expect, it } from "vitest";
import { startFusionToolBridge, toolsToMcpToolDefs } from "../tool-bridge.js";

describe("tool-bridge", () => {
  it("filters built-ins and maps tool schemas", () => {
    expect(
      toolsToMcpToolDefs([
        { name: "read", description: "builtin", parameters: {} },
        { name: "fn_task_list", description: "List tasks", parameters: { type: "object", properties: {} } },
      ]),
    ).toEqual([
      {
        name: "fn_task_list",
        description: "List tasks",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
  });

  it("starts a bridge that executes Fusion custom tools over HTTP", async () => {
    const bridge = await startFusionToolBridge([
      {
        name: "fn_task_list",
        description: "List tasks",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ text: "FN-1 todo" }),
      },
    ]);
    expect(bridge).not.toBeNull();
    expect(bridge!.toolCount).toBe(1);
    expect(bridge!.mcpServer.name).toBe("fusion-custom-tools");
    expect(bridge!.mcpServer).toMatchObject({
      command: process.execPath,
      env: [expect.objectContaining({ name: "FUSION_GROK_TOOL_BRIDGE_URL" })],
    });

    const env = "env" in bridge!.mcpServer ? bridge!.mcpServer.env : [];
    const bridgeUrl = env.find((e) => e.name === "FUSION_GROK_TOOL_BRIDGE_URL")?.value;
    expect(bridgeUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const res = await fetch(`${bridgeUrl}/tool-call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "fn_task_list", arguments: {} }),
    });
    const body = (await res.json()) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(body.isError).toBe(false);
    expect(body.content?.[0]?.text).toContain("FN-1");

    await bridge!.dispose();
  });

  it("returns null when there are no custom tools", async () => {
    expect(await startFusionToolBridge([])).toBeNull();
    expect(await startFusionToolBridge(undefined)).toBeNull();
  });
});
