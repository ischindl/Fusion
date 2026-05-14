---
"@runfusion/fusion": patch
---

Branch-conflict detection now clears stale cached task metadata (`worktree`, `branch`, `baseCommitSha`) when live branch/worktree mappings are missing, and classifies branch tips already reachable from `main` as `tip-already-merged` instead of reporting main's forward progress as stranded commits. This fixes FN-4471-class false-positive `branch-conflict-unrecoverable` parking.
