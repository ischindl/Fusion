---
"@runfusion/fusion": patch
---

summary: Kill vitest and its process count now cover only the project you are viewing, not another checkout's test workers.
category: fix
dev: Candidates from the vitest probe are attributed by working directory (procfs `cwd`) against the viewed project's checkout plus its managed task-worktree roots, at both `POST /api/kill-vitest` / `GET /api/system-stats` and the terminal dashboard's memory-pressure auto-kill. A candidate is dropped only on proof of foreignness — a cwd that cannot be read (other uid, no process table on macOS, exited mid-scan) stays killable, so hosts without `procfs` behave exactly as before. The TUI learns its managed worktree root from the board's own project store through the new optional `onResolveWorktreesDir` callback. Tests can relocate the process table with `FUSION_PROC_ROOT`, which is honored only under vitest. Documented in `docs/solutions/performance/dashboard-process-attribution-runbook.md`.
