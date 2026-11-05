---
"@runfusion/fusion": minor
---

summary: Pick which CI evidence a post-merge gate demands, in the workflow editor and Settings → Merge.
category: feature
dev: The workflow editor's post-merge optional-group node gains an **Evidence contract** select (Inherit plus the four kinds; choosing Inherit deletes `evidence` rather than writing an empty shell). Settings → Merge gains **Post-merge evidence reporter** writing project setting `postMergeEvidence` — Automatic, GitHub Actions, OneDev, GitLab, or None — with OneDev's `baseUrl`/`tokenSecret` revealed only for OneDev. Both surfaces read the resolved contract and its derivation reason from the new `GET /api/post-merge-evidence`, which exposes only presence-only endpoint facts; saving the setting invalidates the resolver's per-root cache, so a declaration takes effect without a daemon restart. Kind, provider, and reason lists render from `@fusion/core` exports, so adding a value in core cannot leave a stale UI list behind.
