---
"@runfusion/fusion": patch
---

Reduce redundant test/build runs during merge verification:

- **Skip the verification re-run after a no-op in-merge fix.** When the fix
  agent doesn't actually modify the working tree (compared via a git
  `diff HEAD` + `status --porcelain` content fingerprint), there's nothing
  new to verify. The merger now logs "fix agent made no changes — skipping
  verification re-run" and records the attempt as failed without paying the
  multi-minute test/build cost.
- **Skip `pnpm install --frozen-lockfile` when the lockfile hash hasn't
  changed since the last successful install.** A `node_modules/.fusion-install-marker`
  file records the lockfile SHA-256 after a successful install; subsequent
  merge attempts in the same worktree skip install when the lockfile content
  is unchanged, even when `package.json` is staged. Existing
  `shouldSyncDependenciesForMerge` filtering still applies as a first gate.
