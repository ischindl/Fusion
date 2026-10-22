---
"@runfusion/fusion": patch
---

summary: Name the throwing code location when a review step crashes before producing a verdict.
category: fix
dev: `Error.stack` frames (first four, one line) are appended after the original message on the card's History / step output / task error text; run-audit metadata is unchanged and messages owned by positional classifiers (missing-worktree, session contention) stay byte-identical.
