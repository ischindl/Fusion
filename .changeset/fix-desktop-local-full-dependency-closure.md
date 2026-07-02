---
"@runfusion/fusion": patch
---

summary: Fix the desktop app crashing on "Local" mode with missing-module errors.
category: fix
dev: electron-builder's pnpm support runs `pnpm list --prod` and drops `deduped` subtrees, so the embedded runtime's `import("@fusion/engine")` closure (@modelcontextprotocol/sdk, the pi-ai provider SDKs, etc.) was never packed into app.asar. The desktop build now stages the complete flat production closure with `pnpm deploy --legacy --config.node-linker=hoisted` and points electron-builder at it via `--projectDir deploy`, so packaging no longer depends on the lossy collector. Also fixes cursor/droid/roadmap plugin exports to expose compiled `dist` on the `import` condition (with `source`→src kept for the bun CLI) so the dashboard server loads them under plain Node, and builds those plugins in the desktop build. Validated by importing @fusion/core|engine|dashboard from the staged deploy and packing a complete 705-package asar.
