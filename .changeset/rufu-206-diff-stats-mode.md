---
"@runfusion/fusion": patch
---

summary: Stats-only task diff answers card file-change badges with one git call plus a 10s cache, no board-wide diff stalls.
category: performance
dev: `GET /api/tasks/:id/diff?stats=1` replaces the per-file `git diff -- <path>` fan-out with one whole-tree `diff --numstat` joined onto the own-task path set, behind a 10s server stats cache keyed on lane identity.
