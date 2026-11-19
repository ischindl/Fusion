---
"@runfusion/fusion": minor
---

summary: Commits carry a project identity trailer; a commit stamped before its card existed is never counted as delivery.
category: feature
dev: Every commit-identity-emitting surface (the worktree `commit-msg` hook, squash-publish trailer construction, `--amend --no-edit` re-stamps, merge-record commits, and the engine-side revert commit) appends `Fusion-Project-Id: <projectId>` beside the existing `Fusion-Task-Id` trailer, omitting it when the lane cannot resolve a project id rather than writing an empty value. `getCommitTaskOwnership` gains two refusals, `foreign-project` (the commit declares a different project's id) and `anachronistic` (committer time precedes the card's `createdAt` by more than `COMMIT_BIRTH_CLOCK_SKEW_MS`, 15 minutes), and every delivery proof that consults it now refuses accordingly: both `--grep` fast paths, workspace landing, the owned-landed classification, and the worktree-rebind proof. Both checks skip when their input is unknown — no configured project id, no `Fusion-Project-Id` trailer (all pre-existing commits), unreadable committer time, or a missing `createdAt` — so nothing that landed before this change is retroactively refused. No commit is ever re-attributed or renamed, and no git history is rewritten.
