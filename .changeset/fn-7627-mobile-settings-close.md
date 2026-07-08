---
"@runfusion/fusion": patch
---

summary: Add a close button to the Settings screen on mobile.
category: fix
dev: The embedded Settings header now renders a mobile-only `modal-close` control gated on `isEmbedded && viewportMode === "mobile"`, wired to the existing `onClose` prop (navigates back to the board and refreshes app settings). Desktop/tablet embedded and the standalone modal presentation are unchanged.
