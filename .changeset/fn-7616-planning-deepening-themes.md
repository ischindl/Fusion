---
"@runfusion/fusion": minor
---

summary: Planning Mode's "go deeper" prompt now suggests plan-specific topics instead of generic buckets.
category: feature
dev: AI completion payload gains optional `deepeningThemes`; the deepening checkpoint prefers them (via buildDeepeningCheckpointOptions) and falls back to the existing regex-derived themes when absent.
