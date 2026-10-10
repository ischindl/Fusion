---
"@runfusion/fusion": patch
---

summary: Git Manager's Push is blocked while the branch is behind origin, and points you at Sync first.
category: fix
dev: The Remotes Push button, `handlePush`, and the push leg of Commit and Push all consult the existing `status.behind` count (a reading as of the last fetch), so a branch that git would reject as non-fast-forward is never offered a plain push. Commit and Push still creates the local commit and skips only the push leg; Sync (`pull --rebase` + push) stays ungated as the remedy. New copy keys: `git.pushBlockedTitle`, `git.pushRequiresSync`, `git.pushRequiresSyncToast`, `git.commitSucceededPushSkipped`, `git.commitAndPushBlockedTitle`.
