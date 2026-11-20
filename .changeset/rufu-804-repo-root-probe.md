---
"@runfusion/fusion": patch
---

summary: Branch reclaim and worktree prune now say when the project folder is not a Git repository.
category: fix
dev: Two self-healing sweeps ran `git` with the registered project root as working directory without
proving that path is a repository, so a project whose root is a non-Git workspace folder (its members
are repositories) threw `fatal: not a git repository` on every pass, the failure was swallowed by a
broad catch, and the pass returned 0 with no reclaim audit row and no card History line — making
"nothing to reclaim" indistinguishable from "could not look at all". Both sweeps now spend one bounded
probe (`packages/engine/src/self-healing/repo-root-probe.ts`, built on the existing
`detectGitRepository` seam, existence checked before detection so an absent folder is not misreported
as a missing git binary) before any git spawn. A proven root behaves exactly as before; an unproven
root now produces one refusal row (`worktree:repo-root-refused`, ids/counts/enums only, never the
repository path or git's stderr), one durable card History line per six-hour window that survives
supervised restarts, and one repeat-suppressed daemon sentence. No lane move, no status/error write,
no pause, and no stall or approval-hold reason is introduced.
