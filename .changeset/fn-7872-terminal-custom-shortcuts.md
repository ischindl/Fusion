---
"@runfusion/fusion": minor
---

summary: Let users define custom terminal shortcut buttons (label + injected sequence) from the terminal Preferences panel.
category: feature
dev: Adds a customShortcuts list to the client-local terminalPreferences (kb-terminal-preferences localStorage), a decodeTerminalShortcutSequence escape decoder (\n/\t/\r/\e/\x1b/\\), custom shortcut buttons in TerminalModal's shortcut panel injecting via the focus-preserving sendLiteralShortcut path, and add/edit/remove management UI in the preferences panel. Client-only; no server schema.
