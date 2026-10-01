---
"@runfusion/fusion": patch
---

summary: Transfer-to-project picker no longer hangs on "Loading projects": bounded wait, Retry, honest empty state.
category: fix
dev: Project-list fetches are abortable and an aborted read no longer poisons the shared /projects/across-nodes dedupe entry; target candidates seed from the SWR projects cache while the bounded cross-node sweep runs; the timeout surfaces a named error with Retry instead of a permanent spinner; an empty dropdown explains a zero-target install; Escape closes only the innermost open layer (the header project switcher no longer dismisses the dialog underneath in one keystroke); the in-modal picker is no longer suppressed at ≤768px phone widths.
