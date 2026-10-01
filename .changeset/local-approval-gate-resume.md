---
"@runfusion/fusion": patch
---

summary: Approving a gated action now lets the task continue instead of failing its next step.
category: fix
dev: resumeAfterDecision resumes a decided agent to `active` instead of `idle`; `idle -> paused` becomes a legal transition so any gate can park an idle agent; and wrapToolsWithActionGate guards `pauseForApproval` in try/catch the way the permanent-agent path already did, so a failed park cannot replace the gate's own rejection.
