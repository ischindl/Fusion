---
"@runfusion/fusion": patch
---

summary: A card whose branch contains its own merge commit is no longer stranded as foreign unmerged work.
category: fix
dev: Bare-branch reclaim now attributes the `git cherry` unique revision set instead of the whole `base..branch` range, so both sides of the reclaim equality count the same commits. Foreign commits merged into the branch are still refused.
