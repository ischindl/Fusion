---
"@runfusion/fusion": patch
---

Cache per-package test results by content hash to skip unchanged packages across sequential merges.

`scripts/test-changed.mjs` now maintains a per-project cache at `.fusion/test-cache.json`. For each package in a changed-mode run, a SHA-256 is computed from the git blob SHAs of every tracked file in the package directory plus `pnpm-lock.yaml` and `tsconfig.base.json`. If the hash matches a cache entry younger than 7 days the package is excluded from the `pnpm --filter` invocation and tests are skipped. After a successful run the passing hashes are written atomically. Cache lookups are bypassed when `FUSION_TEST_NO_CACHE=1` or `--no-cache` is passed, and never applied to full-suite runs. A new `FUSION_TEST_WORKSPACE_CONCURRENCY` env var controls `--workspace-concurrency` (default `2`).
