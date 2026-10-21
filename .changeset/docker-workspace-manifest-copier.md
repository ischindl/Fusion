---
"@runfusion/fusion": patch
---

summary: Fix `docker build` failing on a plugin whose manifest was not staged, and gate the drift.
category: fix
dev: The Dockerfile pre-stages one `package.json` per workspace package; `plugins/fusion-plugin-antigravity-runtime` was missing, so `pnpm install` could not link it and the image build later died with `TS2688: Cannot find type definition file for 'node'`. `scripts/check-docker-workspace-manifests.mjs` now runs in `test:gate:static` and refuses any workspace member not staged in the Dockerfile.
