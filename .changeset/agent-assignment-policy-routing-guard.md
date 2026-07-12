---
"@runfusion/fusion": minor
---

summary: Add per-agent Assignment Policy; guard every task-routing path so liaison agents can never receive product tasks.
category: feature
dev: New `runtimeConfig.assignmentPolicy` ("auto" | "explicit-only" | "none") enforced via shared `evaluateImplementationTaskBind` at `claimTaskForAgent`, the previously unguarded `checkoutTask`/`assignTask` primitives, `selectNextTaskForAgent` (including the in-progress re-selection branch), scheduler auto-assign pool, heartbeat auto-claim, `fn_delegate_task`, CLI agent-id validation, and dashboard assign/checkout routes. "none" is not bypassable by `override=true`/`executorRoleOverride`. Fixes Runfusion/Fusion#2015.
