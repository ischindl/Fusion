---
"@runfusion/fusion": patch
---

summary: Landed workspace cards finish on their own; the post-merge gate no longer blocks a lane that cannot report it.
category: fix
dev: Post-merge evidence now has a third state, `not-applicable`, for an absent result on a workspace-shaped card. The required-gate list and the operator bypass target are unchanged, so a real negative verdict still blocks and a waiver is still available where the gate is genuinely owed.
