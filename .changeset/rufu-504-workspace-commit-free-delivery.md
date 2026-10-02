---
"@runfusion/fusion": patch
---

summary: A workspace card whose work was already merged in every repository now completes instead of being refused.
category: fix
dev: `finalizeWorkspaceTask` records a proven commit-free delivery (`mergeDetails.mergeConfirmed`, `noOpMerge`, `workspaceCommitFreeBasis`) so the shared merge-proof door accepts it; no landing sha is written, and one `git merge-base --is-ancestor` probe per repository is now shared by the empty-merge guard and the delivery decision (`packages/engine/src/merge/workspace-commit-free-delivery.ts`).
