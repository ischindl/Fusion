---
"@runfusion/fusion": patch
"runfusion.ai": patch
---

TUI: layered defenses for the resize / wrong-height-layout bug

Materially reduces (but doesn't fully eliminate) the symptom of the header rendering off-screen or the layout taking 1-2 too many rows, especially under tmux/ssh.

- Enter alternate-screen buffer on start; leave on stop. The TUI gets a dedicated fullscreen surface that doesn't share scrollback.
- StatusBar Text children no longer wrap (default `wrap="wrap"` was letting long hotkey + URL strings wrap to 2 rows, throwing the row budget off by 1).
- Controller subscribes to `process.stdout` "resize" and calls `inkInstance.clear()` to reset log-update's frame tracking.
- App-level resize listener + key-based remount on dimension change so React rebuilds the tree from scratch with fresh bounds.
- Root Box gets explicit width + overflow="hidden"; MainHeader outer Box too.
- Settings + Utilities side-by-side now stretch to equal heights (UtilitiesPanel switched from `flexShrink={0}` to `flexGrow={1}`).
