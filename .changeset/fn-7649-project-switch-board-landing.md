---
"@runfusion/fusion": patch
---

summary: Switching projects now lands on the Board instead of Settings when the last-visited view was Settings.
category: fix
dev: Extended resolveLandingTaskView in useViewState.ts to resolve "settings" (in addition to "command-center") to "board" for the auto-restored/hydrated landing view only; deep links (?view=settings) and explicit navigation still open Settings.
