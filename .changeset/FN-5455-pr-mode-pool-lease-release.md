---
"@runfusion/fusion": patch
---

PR-mode merge cleanup (`cleanupMergedTaskArtifacts`) now releases the `WorktreePool` lease for the merged task worktree before removing it, preventing stranded lease bookkeeping after pull-request merges (FN-5420 / FN-4954 follow-up).
