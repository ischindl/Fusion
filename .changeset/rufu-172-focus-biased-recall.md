---
"@runfusion/fusion": minor
---

summary: A chat conversation's focus now aims proactive memory recall at that topic while whole-project memory keeps its share.
category: feature
dev: `buildPerTurnMemoryRecallCue` takes an optional `focus` and, when it resolves to an active topic (canonical resolver `resolveMemorySearchTopic` moved from engine to `@fusion/core`; empty/`all`/`*`/whitespace mean no focus), runs a second whole-project search on the RAW focus text (lane T). Lane T entries lead the deduped cue, are capped at `PER_TURN_RECALL_LANE_T_SHARE_MAX_CHARS` (60% of the unchanged 800-char budget) and `topK-1` slots so lane P (keyword search) always contributes; lane T search failure degrades to lane P only, lane P failure keeps the `""` silent-skip contract. The no-focus path is byte-identical to before. Chat and CLI lanes pass the operator's focus only when `experimentalFeatures.chatFocus` is on (CLI resolves it through the `purpose:"chat"` session's linked ChatSession, checked before any chat-store read); the executor lane honestly carries no focus (tasks have no focus field). `fn_memory_search`'s `topic` description and three stale FNXC/doc claims corrected: no backend filters by topic (RUFU-121 removed the inert `&topic=`); the focus is a ranking bias, not a filter.
