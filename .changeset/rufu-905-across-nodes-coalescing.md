---
"@runfusion/fusion": patch
---

summary: Open dashboard tabs now share one cross-project project-list read instead of each re-driving it.
category: performance
dev: `GET /api/projects/across-nodes` is single-flighted with a TTL capped at the client's 5 s poll. Tune with `FUSION_PROJECTS_ACROSS_NODES_TTL_MS` (default 2000); set it to `0` and restart to disable the cache entirely and go back to one fan-out per request. Entries are keyed by authenticated principal, so nothing is shared across credentials.
