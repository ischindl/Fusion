---
"@runfusion/fusion": patch
---

summary: Malformed workflow or repository JSON now refuses the review step by name instead of crashing the lane.
category: fix
dev: `readonlyMcpServers` and `repositoryScope` entries are parsed through `parseTrimmedStringList`, which counts non-string elements; the read-only reviewer refuses with `workflow-metadata-invalid:readonlyMcpServers` and a task-log line, and workspace zero-acquire declines instead of throwing. Silent dropping is deliberately not offered: a shrunk read-only allowlist would be an invisible capability change.
