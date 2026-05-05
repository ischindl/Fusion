---
"@runfusion/fusion": patch
---

fix: declare node-pty as a runtime dependency so `npx runfusion.ai` can start the embedded terminal on a clean install. Previously node-pty was only present transitively via the workspace `@fusion/dashboard` devDependency, which is stripped at publish time — fresh users hit a 503 "PTY module could not be loaded" when opening the dashboard terminal. The package-config test guard has been tightened to catch this regression.
