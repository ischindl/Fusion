---
"@runfusion/fusion": patch
---

Harden per-worktree DB hydration so missing `.fusion/` scratch state is bootstrapped and retried before degrading with `unable to open database file`.
