---
"@runfusion/fusion": minor
---

Add executable custom workflows with a visual graph node editor. Author a workflow as a graph (start → prompt/script/gate steps → end) in a new React Flow–based editor, then select it per task or set a project default. Selected workflows compile to the existing WorkflowStep engine and run at the pre/post-merge boundaries — no changes to the scheduler/executor/merger. Non-linear graphs are rejected with a clear message and reserved for the (deferred) graph interpreter.

Prompt nodes carry an execution profile: run on a chosen model, as a named agent, as a skill invocation, or as a named project script (CLI) with the prompt passed via FUSION_NODE_PROMPT — plus per-node retries and an auto-approve toggle. "User input" nodes pause the run with a needs-input badge on the task card and a banner in the task modal; replying in comments and unpausing resumes the workflow with the answer.

CLI nodes can run arbitrary commands (not just named scripts); the first run of an exact command pauses the task for explicit user approval. The task modal's input/approval banner is interactive — reply-and-resume for user-input nodes, approve-and-run for CLI commands.
