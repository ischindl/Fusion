---
"@runfusion/fusion": patch
---

summary: Board paints sooner by queueing dashboard reads instead of firing ~20 at once.
category: performance
dev: New `app/api/client/read-scheduler.ts` bounds concurrent GETs to 4 and dispatches `/tasks/page`, `/tasks/board-workflows` and `/settings/global` first; mutations bypass the queue. No server change.
