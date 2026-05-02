---
"@runfusion/fusion": patch
---

Add mouse-wheel scrolling to the dashboard TUI. Wheel scrolls the focused pane in the task detail logs, Git view (commits/branches/worktrees lists), and Files view (tree selection or preview viewport depending on focus). Uses xterm SGR mouse reporting (`?1000h` + `?1006h`) without motion tracking so Shift+drag native text selection still works.
