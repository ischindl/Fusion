---
"@runfusion/fusion": patch
---

summary: Fix the mobile terminal shortcut bar so it truly scrolls horizontally to reach every key.
category: fix
dev: FN-7550's leaf `min-width:0`/`overflow-x:auto`/`touch-action:pan-x` on `.terminal-shortcut-panel` were already correct, but styles.css's mobile `@media(max-width:768px)` lockdown resets `touch-action` to `pan-y` on `*` and re-locks it explicitly on `.modal-overlay:not(.confirm-dialog-overlay)`/`#root`/`html`/`body` — the terminal's own overlay/modal ancestors were never carved back into `pan-x`, so the panel's own correct touch-action was defeated by ancestor-chain intersection on real mobile devices. Added `touch-action: pan-x pan-y` to `.modal-overlay.terminal-modal-overlay`, `.modal.terminal-modal(.terminal-modal--mobile)` (both mobile paths), and `.terminal-status-bar` (FN-7560 footer, same gap). Locked in with a real-CSS `getComputedStyle` layout test (`loadAllAppCss()`) that resolves the panel + full ancestor chain, replacing reliance on a leaf-rule string match that stayed green through this recurrence.
