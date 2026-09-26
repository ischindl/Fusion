---
"@runfusion/fusion": patch
---

summary: Fix CLI/fn-extension tool denial on large boards: the transient TaskStore boot skips unneeded backlog passes.
category: fix
dev: `createTaskStoreForBackend` gains `skipPatchnodeReconcileOnInit`; `TaskStore.init()` accepts `{skipArchiveReintegrationOnInit, skipPatchnodeReconcileOnInit}` (defaults keep the full host-path backlog). Boot failures now deny agent tools under `deniedFor: "taskstore-boot-unavailable"` instead of `agent-permission-policy-unavailable`.
