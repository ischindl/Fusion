---
"@runfusion/fusion": patch
---

Fix workflow graph merge-node failures so merge-seam aborts are not misclassified as pause/resume aborts. Non-paused merge failures now route to the bounded auto-merge retry path instead of being parked failed with no merge retry count.
