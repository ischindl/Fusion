---
"@runfusion/fusion": patch
---

Convert the heartbeat executor's dynamic `import("./agent-session-helpers.js")`
and `import("./session-skill-context.js")` calls to static imports. This makes
missing or partial engine dist surface at module load time (matching the
existing static `pi.js` import) instead of failing mid-heartbeat with a
confusing `ERR_MODULE_NOT_FOUND`.
