---
"@runfusion/fusion": patch
---

summary: Open dashboard tabs now share one board-workflows read instead of each re-driving it.
category: performance
dev: `GET /api/tasks/board-workflows` is single-flighted per authenticated principal with a TTL capped at the client's 5 s poll. Tune with `FUSION_BOARD_WORKFLOWS_TTL_MS` (default 2000); set it to `0` and restart to disable coalescing and go back to one full read per request. The response shape and lane assignment are unchanged; a card can render one lane behind for at most the TTL window.
