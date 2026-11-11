import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * RUFU-520. The schema-only MCP server holds no handlers, so a `tools/call` must be answered with
 * an explicit refusal naming the requested tool. The server's previous header claimed the method
 * was unreachable and shipped no handler at all, which meant the one shape of turn that can reach
 * it - a turn where break-early never fired, exactly the guarded case - hung on a silent server
 * instead of reporting a distinguishable failure.
 *
 * This drives the real `.cjs` over stdio with `node`, the same way the Claude CLI does, because the
 * behavior under test is the process's wire output.
 */

const SCRIPT = resolve(__dirname, "..", "mcp-schema-server.cjs");

function drive(schemaTools: unknown[], requests: object[]): Record<string, unknown>[] {
  const dir = mkdtempSync(join(tmpdir(), "rufu520-schema-"));
  const schemaPath = join(dir, "tools.json");
  writeFileSync(schemaPath, JSON.stringify(schemaTools));
  try {
    const out = execFileSync(
      process.execPath,
      [SCRIPT, schemaPath],
      { input: requests.map((request) => JSON.stringify(request)).join("\n") + "\n", encoding: "utf-8" },
    );
    return out
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TOOLS = [{ name: "fn_task_show", description: "d", inputSchema: { type: "object" } }];

describe("mcp-schema-server tools/call refusal", () => {
  it("answers initialize and tools/list as before", () => {
    const responses = drive(TOOLS, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);

    expect(responses[0]).toMatchObject({ id: 1, result: { serverInfo: { name: "custom-tools" } } });
    expect(responses[1]).toMatchObject({ id: 2, result: { tools: TOOLS } });
  });

  it("refuses tools/call with the marker and the requested name", () => {
    const responses = drive(TOOLS, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "fn_task_show", arguments: { id: "FN-1" } },
      },
    ]);

    const refusal = responses.find((response) => response.id === 7);
    expect(refusal).toBeDefined();
    const error = refusal?.error as { code: number; message: string };
    expect(error).toBeDefined();
    expect(error.message).toContain("TOOL_NOT_AVAILABLE");
    expect(error.message).toContain("fn_task_show");
    // A refusal must not arrive shaped like a result, or a caller could read it as a tool's output.
    expect(refusal?.result).toBeUndefined();
  });

  it("refuses a call for a tool the schema never declared, naming it anyway", () => {
    const responses = drive(TOOLS, [
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "fn_list_agents", arguments: {} },
      },
    ]);

    const error = responses.find((response) => response.id === 3)?.error as { message: string };
    expect(error.message).toContain("TOOL_NOT_AVAILABLE");
    expect(error.message).toContain("fn_list_agents");
  });

  it("refuses a call with no name rather than staying silent", () => {
    const responses = drive(TOOLS, [
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: {} },
    ]);

    const error = responses.find((response) => response.id === 4)?.error as { message: string };
    expect(error.message).toContain("TOOL_NOT_AVAILABLE");
  });

  it("keeps ignoring notifications without emitting a response", () => {
    const responses = drive(TOOLS, [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 5, method: "tools/list" },
    ]);

    expect(responses.map((response) => response.id)).toEqual([5]);
  });
});
