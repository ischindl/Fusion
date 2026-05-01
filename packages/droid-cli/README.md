# @fusion/droid-cli

First-party Fusion pi extension package that routes pi provider requests through the `droid` CLI subprocess using stream-json NDJSON.

## Provider

- Provider ID: `droid-cli`
- Binary: `droid` (must be installed and authenticated on PATH)
- Registration: package extension entrypoint in `index.ts`

## Capabilities

- Subprocess streaming bridge for text/thinking/tool events
- Model auto-discovery from Droid CLI at provider startup with in-process caching
- Session resume support (`--resume` / `--session-id`) to avoid replaying prior turns
- MCP schema bridge for exposing pi custom tools as schema-only definitions
- Tool mapping and break-early control so pi remains the tool executor
- Thinking effort mapping from pi reasoning options to Droid CLI flags

## Development

```bash
pnpm --filter @fusion/droid-cli test
pnpm --filter @fusion/droid-cli exec tsc --noEmit
```
