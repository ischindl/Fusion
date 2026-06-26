---
"@runfusion/fusion": minor
---

summary: Add `fn mcp` CLI to manage MCP servers, import Claude Desktop config, and export Fusion MCP JSON.
category: feature
dev: New `packages/cli/src/commands/mcp.ts`; reuses @fusion/core resolveEffectiveMcpServers, validation, and import/export; sensitive fields stored as secret references via SecretsStore, never plaintext.
