---
"@runfusion/fusion": patch
---

Fix periodic dashboard event-loop stalls caused by synchronous shell-outs and filesystem reads on hot request paths.

Two distinct sources, both replaced with async equivalents:

- **`pgrep -f vitest`** ran via `execSync` in `getVitestProcessIds` (`/api/system-stats`, `/api/kill-vitest`) and `killVitestProcesses` (TUI memory-pressure check). On a busy machine `pgrep` walking the process table can take 100ms+; `execSync` blocks the entire Node event loop for that duration, so every concurrent dashboard request hangs while pgrep runs. The TUI variant fired on every memory-pressure tick (every 2s when over threshold), the dashboard variant fired on every system-stats poll (every 5s while the modal is open). Both now use `execFile` with a callback wrapped in a Promise.
- **`discoverDashboardPiExtensions`** (called from 3 `/api/settings/pi-extensions` routes) did 6+ blocking `existsSync`/`readFileSync` calls per invocation across legacy and fusion settings paths. Converted to `fs.promises.readFile`/`access` and parallelized via `Promise.all`.
