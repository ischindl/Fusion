---
"@runfusion/fusion": patch
---

summary: Chat agents can delete tasks again, and every chat delete is attributed honestly.
category: fix
dev: The chat-lane `fn_task_delete` tool no longer stamps the target id as the caller task (which the self-delete guard read as a self-delete); it omits the caller id and sends `callerKind: "agent-tool"`, so chat deletes persist `callerTaskId: null` and notify the operator like other agent-tool lanes.
