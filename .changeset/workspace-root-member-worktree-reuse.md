---
"@runfusion/fusion": minor
---

summary: Workspace projects stop dead-locking when a configured member is the root repository itself.
category: fix
dev: `acquireWorkspaceRepoWorktree` now asks whether a configured member directory is its own git repository. When it resolves to the workspace root repository instead — `<root>/<member>` has no `.git` and `git rev-parse --show-toplevel` walks up to `<root>` — the member would need a second worktree of a repository whose `fusion/<id>` branch is already checked out, which git refuses. The member entry is now repointed at the registered worktree that already holds the branch (idempotent reuse, no `git worktree add`, `worktree:workspace-root-member-reused` audit row plus a task-log line), and the ordinary creation path still runs when nothing holds the branch. Members that are their own repository are byte-identical. This unblocks the saneca shape: 42 cards carried `Workspace repository preparation failed for saneca during acquire`, 26 of them with a verdict-less Code Review row and an `in-review-stall-deadlock` park, at one lifecycle move per 40 minutes.
