---
"@runfusion/fusion": patch
---

summary: Align the task Activity view dropdown under its tab instead of drifting to the left of the modal.
category: fix
dev: TaskDetailModal's position:fixed Activity menu now clamps to the layout viewport (document.documentElement.clientWidth/clientHeight) and no longer mixes in window.visualViewport width/offset, which shoved the popup off-anchor under pinch-zoom or an open mobile keyboard.
