---
"@runfusion/fusion": patch
---

summary: Workspace cards whose member worktree disappeared now name the repository instead of failing with a raw git error.
category: fix
dev: `captureWorkspaceReviewEvidence` asserts that each member entry is its own repository top-level before measuring anything, and throws `WorkspaceMemberEvidenceError` with `reasonCode` `member-worktree-missing` or `member-base-unresolvable`. The merge-content descriptor carries that classification in `repositories.reason` (previously every failure collapsed into `workspace-evidence-capture-failed`, which is all the sweep and the operator could ever see), and finalize reports it too. Path identity is realpath-compared, so a symlinked workspace root is not falsely refused.
