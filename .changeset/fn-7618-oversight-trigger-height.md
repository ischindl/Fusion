---
"@runfusion/fusion": patch
---

summary: Task-detail Oversight button now matches Priority/Execution-mode height on desktop.
category: fix
dev: `.detail-oversight-menu-dropdown` (the popover-positioning wrapper) is now `inline-flex; align-items: stretch` so it participates in `.detail-meta-inline-controls`'s stretch, and `.detail-oversight-menu-trigger` gets `align-self: stretch` to fill it — matching Priority/Execution-mode's direct-child stretch behavior without any new hardcoded height.
