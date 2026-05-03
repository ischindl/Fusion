---
"@runfusion/fusion": patch
---

Avoid nested `.fusion/.fusion` regressions by hardening project-root path handling and stop the CLI binary status probe from executing outdated global `fn` installs just to read their version.
