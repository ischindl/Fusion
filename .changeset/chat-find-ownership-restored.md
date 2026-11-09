---
"@runfusion/fusion": patch
---

summary: Ctrl+F inside an open chat searches that conversation again, even without clicking in the chat first.
category: fix
dev: The Ctrl/Cmd+F ownership test compared `target.closest(".chat-view")` against a ref that FN-379 had moved off the element carrying the `chat-view` class, so the comparison could never be true and thread Find only worked after a pointer event landed inside the chat body pane. Find now resolves the chat host shell from that ref (`closest(".chat-view")`), restoring FN-110's ownership contract; `chatViewRef` stays on `.chat-view__body` because the floating-width measurement needs the pane. Guarded by the existing `ChatView.virtualization` and `ChatView.content-search` suites: 6 of the 7 previously failing Find assertions in the latter went green. Its `opens conversation Find…` case now reaches a second, unrelated staleness — `leaveDirectDetail()` clicks `chat-back-btn`, which `ChatView.tsx` renders only when `!dockedSidebarVisible`, and FN-379 also deleted the `chat-docked-sidebar-toggle` that same helper clicks first. That helper is stale, not the Find contract, and is left untouched.
