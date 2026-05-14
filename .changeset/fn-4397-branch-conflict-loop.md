---
"@runfusion/fusion": patch
---

Fix FN-4068 branch-conflict recovery hot loop: prevent repeated "Branch conflict recovery required" emissions and add a per-task tripwire that hard-pauses after 5 repeats.
