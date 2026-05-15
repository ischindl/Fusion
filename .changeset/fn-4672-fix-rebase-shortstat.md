---
"@runfusion/fusion": patch
---

Fix self-healing stale merge metadata repair so rebase/cherry-pick merges compute shortstat from `rebaseBaseSha..commitSha` instead of tip-only `git show`, preventing correct aggregate stats from being overwritten.
