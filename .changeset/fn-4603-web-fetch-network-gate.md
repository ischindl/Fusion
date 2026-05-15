---
"@runfusion/fusion": patch
---

Action-gate: `fn_web_fetch` is now classified under the `network_api` approval category, matching `fn_research_run`. Projects with `network_api: require-approval` will now prompt for approval before agents fetch external URLs. Previously fell through to exempt and bypassed the policy (FN-4603).
