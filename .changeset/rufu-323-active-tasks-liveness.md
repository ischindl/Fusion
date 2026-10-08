---
"@runfusion/fusion": patch
---

summary: Switching a project's isolation mode is no longer refused because of finished (failed) cards.
category: fix
dev: The busy-project check now reads the executor's live worktree-holder count instead of the size of its in-memory worktree map, and a committed terminal graph-failure park releases its worktree binding. Child-process and remote-node runtimes keep forwarding their own engine's metric, so a remote node on an older build still reports its own count.
