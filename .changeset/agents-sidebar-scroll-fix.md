---
"@runfusion/fusion": patch
---

summary: Fix the Agents view sidebar becoming unscrollable when the agent list is taller than the window.
category: fix
dev: `.agents-split-sidebar` is the ViewSidebar root; a leftover `flex-direction: column` host override made the panel content-sized inside a clipped rail, leaving no scroll container. The row layout (panel + resize separator) is restored; ratcheted by agent-css-classes.test.ts.
