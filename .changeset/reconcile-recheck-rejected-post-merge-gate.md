---
"@runfusion/fusion": patch
---

summary: `fn task reconcile` can now re-run a rejected post-merge verification instead of refusing the card.
category: fix
dev: The manual-reconcile arm reached the post-merge resume seam only when the gate had no result row. A gate that reported and was refused (status `failed`) answered `post-merge-evidence-pending` without attempting anything, so `manualRetry` — added by FN-9502 for exactly that arm — had no caller. It is now passed for the rejected-evidence arm; every guard in the seam (workspace lane, missing merge proof, operator hold, live lease, and never seeding over an approval or `pending` row) still refuses, and the idle-continuation fence still bounds repeat retries.
