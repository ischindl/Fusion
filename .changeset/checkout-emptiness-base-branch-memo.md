---
"@runfusion/fusion": patch
---

summary: Overlap scheduling resolves the repository default branch once per 10 s instead of once per pass.
category: performance
dev: `proveDormantCheckoutEmptiness` no longer forks `git symbolic-ref --short refs/remotes/origin/HEAD` on every call. The git-derived answer is memoized per repository behind the existing `CHECKOUT_EMPTINESS_PROOF_TTL_MS` (10 s) window, with single-flight and `invalidateIntegrationBranchMemo(rootDir)`. A configured `integrationBranch`/`baseBranch` is still read live on every pass and forks nothing. Ratcheted by `git-proof-fork-count.test.ts`.
