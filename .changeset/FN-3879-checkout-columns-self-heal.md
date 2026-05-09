---
"@runfusion/fusion": patch
---

Add a compatibility self-heal for legacy task databases that report `schemaVersion >= 20` but are missing checkout lease columns (`checkedOutBy`, `checkedOutAt`, `checkoutNodeId`, `checkoutRunId`, `checkoutLeaseRenewedAt`, `checkoutLeaseEpoch`).

On initialization, missing lease columns are now added idempotently before version-guarded migrations, matching the earlier `nodeId` mitigation pattern and preventing `no such column: checkoutNodeId` crashes in task listing paths.
