---
"@runfusion/fusion": patch
---

Fix a Planning Mode reliability bug where creating a single task could fail with a browser-level `Failed to fetch` error when post-create side effects threw or rejected before the dashboard finished responding.
