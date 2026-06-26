---
"@runfusion/fusion": patch
---

summary: Restore horizontal swiping on Agent Detail tabs on mobile touch devices.
category: fix
dev: Adds `.agent-detail-tab` touch-action pan-x coverage because the global mobile pan-y lock is non-inherited.
