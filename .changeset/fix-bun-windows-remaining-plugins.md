---
"@runfusion/fusion": patch
---

summary: Fix the Windows CLI binary failing to build in release.
category: fix
dev: The bun `--compile --conditions=source` build could not resolve @fusion-plugin-examples/paperclip-runtime (statically imported by dashboard runtime-provider-probes.ts) because it lacked a `source` export condition and fell through to `import`→`dist/index.js`, absent on the Windows runner. Added `"source": "./src/index.ts"` to paperclip and the remaining example plugins that export `import`→dist (agent-browser, even-cards, even-realities-glasses, whatsapp-chat), matching hermes/openclaw. Verified by cross-compiling bun-windows-x64 with all plugin dist removed.
