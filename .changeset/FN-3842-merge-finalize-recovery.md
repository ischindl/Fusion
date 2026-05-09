---
"@runfusion/fusion": patch
---

Fix auto-merge failing when task content is already on `main` under a different commit SHA. The phantom-merge guard in `commitOrAmendMergeWithFixes` previously failed any merge where `git merge --squash` produced no diff, even when the work had legitimately landed on `main` (e.g., after an in-merge fix or rebased branch). The finalize logic now treats already-merged branches as success via a defense-in-depth chain: trailer-on-HEAD short-circuit, then merge-base ancestor short-circuit, then a hardened squash-restore fallback that detects `already up to date` reports. High-resolution diagnostics are emitted on the phantom-guard branch for any future regressions.
