---
"@runfusion/fusion": minor
---

summary: The Windows desktop close dialog now offers Minimize to tray, keeping Fusion and the embedded PostgreSQL running in the background.
category: feature
dev: "win32 close dialog gains a Minimize to tray default alongside Exit-and-stop-PostgreSQL / Exit-leave-it-running (or a two-button variant when no embedded runtime is active); tray click restores the window. OS session end still skips dialogs and performs the full stop."
