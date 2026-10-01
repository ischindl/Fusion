---
"@runfusion/fusion": patch
---

summary: Task, planner, and Direct Chat tabs show a generation started elsewhere live, and hidden tabs resync when shown again.
category: fix
dev: `chat:session:updated` bus payloads carry the derived `isGenerating` flag (store rows only had `inFlightGeneration`), and clients keep `isGenerating ?? inFlightGeneration.status === "generating"` as a wire-compat fallback before triggering the existing attach path. An unscoped `/api/events` connection now also subscribes to the scoped-`ChatStore` registry (`onScopedChatStoreCreated`), so stores created after the connection opened are bridged instead of being snapshotted once at connect time, and every bridged listener plus the registry subscription is detached at connection teardown. The task planner Chat tab gained its own `/api/events` subscription; duplicate-attach suppression is carried by the client's live stream state — the `(sessionId, replayFromEventId)` replay-cursor marker is retired wherever that stream ends, because every new generation re-opens at cursor 0 — because the in-flight payload carries no generation identifier. A terminal frame closes only the stream the mirror itself opened, so a send started in the same tab keeps its own completion path (and its queued-message dispatch).
