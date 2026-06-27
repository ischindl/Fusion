---
"@runfusion/fusion": minor
---

summary: The Browser Verification workflow step now uses the agent-browser tool, checks availability, and logs its actions.
category: feature
dev: Adds a `requiresBrowser` flag to `WorkflowStep`, set on the built-in browser-verification inner node and threaded through `runGraphCustomNode` into `executeWorkflowStep`, which merges the `agent-browser-navigation` skill, runs a bounded non-fatal `agent-browser --version` availability preflight (async exec), and emits start/availability agent-log entries. Absent the flag, prompt-step execution is unchanged.
