---
"@runfusion/fusion": patch
---

summary: Merge and empty-branch proofs spawn one git subprocess per repository instead of one per remote.
category: performance
dev: `resolveTrustedIntegrationRefs` resolves remote-tracking identities with one `git for-each-ref refs/remotes` listing instead of one `rev-parse` per remote, and memoises the set per (repoDir, integrationRef) for 15s. Trusted identities stay limited to configured remotes that have the ref locally.
