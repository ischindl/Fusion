---
"@runfusion/fusion": patch
---

summary: The memory test now probes the backend you configured, and memory file saves say where they landed.
category: fix
dev: "`POST /api/memory/test` no longer overwrites `memoryBackendType` with `qmd`; it resolves the configured backend (Stash included, authenticated through the one RUFU-994 secrets reader) and returns `testedBackend` plus a `notice`. `PUT /api/memory/file` and `POST /api/memory/compact` return `storedIn`/`configuredBackend`/`diverges`/`notice` from `describeMemoryFileWrite`. A path-scoped save still writes the local memory workspace, because `MemoryBackend` has no path-scoped write and routing it through `writeMemory()` would put a single file's body into the long-term memory blob."
