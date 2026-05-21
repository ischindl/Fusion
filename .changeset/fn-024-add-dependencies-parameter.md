---
"@fusion/engine": minor
---

Add optional dependencies parameter to fn_task_update tool. Executors can now programmatically modify task dependency arrays during execution with `fn_task_update({ id: "FN-XXX", dependencies: ["FN-001", "FN-002"] })`. The parameter is optional and backward-compatible; omitting it preserves existing dependencies. Includes validation for self-dependency and non-existent task IDs. Eliminates the need for direct task.json editing workarounds.
