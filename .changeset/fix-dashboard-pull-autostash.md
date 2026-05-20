---
"@runfusion/fusion": patch
---

Dashboard git pull now autostashes dirty local changes (including untracked files) before pulling and reapplies them on success. If reapplying conflicts, the stash is preserved and the operation reports `stashConflict` with the stash label so the user can resolve later from the Stashes view. Previously a dirty working tree caused the pull to fail outright with no recovery path.
