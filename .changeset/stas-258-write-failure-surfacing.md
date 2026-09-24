---
"@fusion/engine": patch
"@fusion/dashboard": patch
"@runfusion/fusion": patch
---

summary: A tool call whose write never reached the task store now returns a flagged failure with retry guidance.
category: fix
dev: One failure shape for every attempted-and-failed store write — `storeErrorResult` (code `STORE_UNAVAILABLE`, text ending `Retry the call; if it fails again`) for an outage, `storeWriteFailure` (code `STORE_REFUSAL`) when the store refused the operation on purpose; the split is the observation record `storeWriteFailure` (stage: tool write-path, outcome: refusal-vs-outage classified by the domain-phrase test). 21 registered tools across engine, dashboard planner and the CLI extension now return that shape with `isError: true`. Two guards hold it: `tool-write-failure-boundary.test.ts` scans the registration surfaces for an attempted write reporting its failure as a success row or hand-composing a store-failure shell, and `tool-write-failure-boundary-drive.test.ts` imports the real registration modules, drives every exported `fn_` tool's own handler with a store that refuses every write verb and answers reads in two stances, pins the per-tool outcome so a refusal cannot become a silent no-op, and refuses to report a lane as clean without saying which store it ran against. Guardred-at-base: the drive fails at 57/41 unflagged sites before the conversion. Out of scope and recorded: the read half of the invariant (STAS-256/STAS-259) — `fn_task_logs_read` and `fn_read_messages` still report a failed read as informative text.
