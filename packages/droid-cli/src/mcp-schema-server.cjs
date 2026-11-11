#!/usr/bin/env node
// Schema-only MCP server. Reads tool schemas from a JSON file.
// Implements initialize + tools/list, and refuses tools/call.
//
// FNXC:ToolDispatchIntegrity 2026-11-11-04:02:
// RUFU-520. The header used to read "tools/call is never reached because the parent process kills
// the Claude subprocess at message_stop before tool execution (break-early pattern)" and the
// handler was absent, so an unreachable-by-hope path was left unhandled: if the subprocess ever
// does reach tools/call (break-early only fires when a pi-known tool_use was seen, and a guarded
// turn deliberately emits none), the server answered nothing at all and the CLI saw a hanging
// tool call. This server holds no handlers by design, so a call must be refused with an explicit,
// distinguishable error naming the requested tool, and never routed to some other tool's result.
// The marker string matches TOOL_NOT_AVAILABLE_MARKER in tool-surface.ts; it is repeated as a
// literal because this file runs standalone under `node` with no build step and must not gain an
// import of the extension's module graph.
"use strict";

const TOOL_NOT_AVAILABLE_MARKER = "TOOL_NOT_AVAILABLE";

const fs = require("fs");
const readline = require("readline");

const schemaPath = process.argv[2];
if (!schemaPath) {
  process.exit(1);
}

let tools = [];
try {
  tools = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
} catch {
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method === "initialize") {
    const resp = {
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "custom-tools", version: "1.0.0" },
      },
    };
    process.stdout.write(JSON.stringify(resp) + "\n");
  } else if (msg.method === "tools/list") {
    const resp = { jsonrpc: "2.0", id: msg.id, result: { tools } };
    process.stdout.write(JSON.stringify(resp) + "\n");
  } else if (msg.method === "tools/call") {
    const requested = (msg.params && msg.params.name) || "<unknown>";
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32601,
          message: `${TOOL_NOT_AVAILABLE_MARKER}: ${requested} has no handler in this run`,
        },
      }) + "\n",
    );
  }
  // notifications/initialized: no response needed (notification)
});
