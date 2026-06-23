---
"@runfusion/fusion": patch
---

Prevent task worktree acquisition from returning the project repository root by enforcing a non-root postcondition across resume, pooled, and fresh checkout paths.
