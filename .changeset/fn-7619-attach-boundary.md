---
"@runfusion/fusion": patch
---

summary: fn_task_attach now refuses to read files outside the task worktree boundary.
category: security
dev: Adds a path-containment guard (confine to ctx.cwd) before readFile in the fn_task_attach tool; rejects traversal/absolute/@-prefixed escaping paths. Regression tests in packages/cli/src/__tests__/extension.test.ts. Fixes FN-7619 (flagged out-of-scope during FN-7608).
