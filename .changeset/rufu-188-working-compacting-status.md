---
"@runfusion/fusion": minor
---

summary: Streaming replies now show "Working (compacting…)" while the engine compacts context.
category: feature
dev: The chat stream gains a non-persisted `phase` side-channel event (`compacting` active/inactive pairs) around the pre-overflow compaction gate on direct sends; room replies are unchanged. `useChat` and the planner chat expose it as `streamingPhase` and the shared streaming placeholder renders the new label.
