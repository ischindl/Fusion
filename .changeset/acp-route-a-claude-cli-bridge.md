---
"@runfusion/fusion": minor
---

Route Fusion's Claude CLI path through the ACP bridge (`claude-code-cli-acp`) instead of `claude -p` (Route A, dormant behind an OFF-by-default kill-switch).

- **U10** — forward `mcpServers` on ACP `session/new` through the runtime contract (`AgentRuntimeOptions.mcpServers` + the plugin's `newAcpSession`); defaults to `[]` so existing read-only ACP "ask" turns are unchanged.
- **U11** — `streamViaAcp`: the `pi-claude-cli` provider can drive Claude through the bundled ACP bridge, returning the same `AssistantMessageEventStream` as the `-p` path. Dispatched only when `FUSION_CLAUDE_ACP=1` and a bridge path are present, so the live `-p` path is byte-for-byte untouched by default. Full-history prompting, schema-only MCP forwarding with break-early on pi-known tools, control-char/size sanitization, env allow-list, process-registry registration, and inactivity timeout.
- **KTD10** — the ACP runtime plugin publishes its identity-pinned bundled bridge path on load so the kill-switch needs no manual path; it does not enable the transport.

The Claude-via-pi OAuth path is unchanged. Live verification confirmed the bridge gates tool execution behind `session/request_permission` (forwarded MCP tools and native tools do not execute when cancelled). Remaining for a follow-up: picker/auth/status surface (U12), workflow `model`-node verification (U13), and production rollout.
