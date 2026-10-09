---
"@runfusion/fusion": patch
---

summary: Fix the card actions menu closing the instant it opened on a scrolled board.
category: fix
dev: The card's ⋯ menu renders through the shared `UiMenu`, which focuses its first item without `preventScroll` by default. That focus scroll reached TaskCard's capture-phase scroll listener, which treats any scroll as an outside click, so the portaled menu dismissed itself on the tick it opened. `TaskContextMenu` now passes the `preventScrollOnFocus` opt-in that `ListItemContextMenu` already uses, agreeing with the menu's own `preventScroll: true` focus entry.
