---
"@runfusion/fusion": minor
---

summary: Show user-defined custom terminal shortcuts in the embedded Task Detail terminal's mobile key bar.
category: feature
dev: SessionTerminal now reads the shared terminalPreferences.customShortcuts (FN-7872, kb-terminal-preferences localStorage) and renders each as a mobile accessory-bar button that injects decodeTerminalShortcutSequence(value) via the focus-preserving keepFocus + sendInput path, clearing sticky Ctrl; buttons update live on the storage event and are suppressed in read-only/replay sessions. Mobile-only; no new store; TerminalModal and the preferences helper are unchanged.
