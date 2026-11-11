---
"@runfusion/fusion": patch
---

summary: Fix CLI-bridge tool calls being answered by the wrong tool when the session could not execute the named one.
category: fix
dev: The claude-cli and droid-cli bridges now derive the declared tool surface from the live session (registry intersected with active tools) instead of transcript replay or a cached MCP config, refuse an unavailable tool with a visible TOOL_NOT_AVAILABLE line, and make the schema-only MCP server return an error for tools/call.
