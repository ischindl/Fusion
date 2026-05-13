---
"@runfusion/fusion": patch
---

Fix sporadic disappearance of the GitHub linked-task badge on task cards caused by transient WebSocket null merges, render gating that ignored live/batch badge sources, and badge snapshot loss during viewport unsubscribe/resubscribe cycles.
