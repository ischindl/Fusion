---
"@runfusion/fusion": patch
---

Fix the dashboard auto-merge toggle blanking on mobile by keeping board stabilization tied to viewport events instead of a one-shot resize listener.

The in-review board now stays visible when auto-merge is toggled across Android mobile, iOS mobile, tablet, and desktop layouts, with regression coverage for populated and empty columns plus rollback and error-boundary paths.
