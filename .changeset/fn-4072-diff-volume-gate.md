---
"@runfusion/fusion": patch
---

Add a pre-commit diff-volume gate for auto-resolved squash merges. Fusion now compares each file's staged squash delta against the branch's net delta and blocks the merge in `in-review` when a non-allowlisted file silently loses too much branch content.

Add three new project settings for tuning the gate: `mergeDiffVolumeMinLines` (default `20`), `mergeDiffVolumeThreshold` (default `0.2`), and `mergeDiffVolumeAllowlist` (default `[]`).
