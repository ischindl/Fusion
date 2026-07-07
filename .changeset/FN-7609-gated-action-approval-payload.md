---
"@runfusion/fusion": patch
---

summary: Approval cards now show the gated command/arguments and dedupe repeated pending requests.
category: fix
dev: Permanent-agent gate persists approvalDedupeKey in targetAction.context and a payload-bearing summary (buildAgentGatedActionSummary); MailboxView renders GatedActionApprovalDetails for source="agent-gating".
