---
"@runfusion/fusion": patch
---

summary: A refused inbox read now reaches the agent as a tool error, not as ordinary payload text.
category: fix
dev: fn_read_messages and the executor lane's fn_task_add_dep target lookup answer through the shared store-failure shape, so only the store's typed not-found may call a card missing and the agent log records tool_error.
