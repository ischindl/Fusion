---
"@runfusion/fusion": patch
---

summary: Delivered zero-diff workspace cards land instead of stalling until the engine freezes them.
category: fix
dev: `resolveWorkspaceMergeReadiness` now admits a task with `noCommitsExpected` and an acquired entry for every confirmed-scope repository as a landing obligation. Its no-op arm only covered a workspace declaring zero repositories, so a commit-free workspace that declared and acquired members matched none of the three obligation disjuncts (fresh diff, net-zero commits, `landedSha`) and was refused as unexplained emptiness. Per-repository delivery proof is written by the existing `landOneRepo` zero-ahead short-circuit (`merge:ai-empty`), so no sha is fabricated.
