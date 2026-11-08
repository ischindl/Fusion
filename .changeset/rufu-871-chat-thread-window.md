---
"@runfusion/fusion": patch
---

summary: Opening a chat now loads the newest 20 messages instead of up to 50, with a Load older messages control.
category: performance
dev: `CHAT_THREAD_WINDOW` (20) replaces the 50-row opening window in `app/api/chat/chat.ts`; older pages come through the messages route's existing `before`/`beforeId` cursor, so no server change was needed. The per-session transcript cache key stays `(projectId, sessionId)` — window size is deliberately NOT part of the key, because the reattach path has no window to pick with; the single entry now holds the MERGED transcript, so a re-open restores the pages the reader paged in. A re-fetched window can no longer delete older pages it never fetched (`mergeThreadWindow`). Measured basis: one production thread answered 326,556 B for 13 messages, so a dense 50-row window could move over a megabyte on open.
