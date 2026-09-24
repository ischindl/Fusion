---
"@runfusion/fusion": patch
---

summary: A busy embedded terminal now keeps its newest output instead of discarding the whole backlog.
category: fix
dev: `capOutputBacklog` and `capResizeSuppressedBacklog` subtracted the dropped bytes from the session's byte counter once, after the drain loop, so the 256 KiB byte disjunct in the loop condition could never turn false and the queue was emptied chunk by chunk whenever real ~4 KiB PTY chunks hit the byte ceiling before the chunk-count ceiling. Both caps now decrement as each chunk is dropped, so they stop at the ceiling with the oldest output removed and the newest retained; the drift-resync branch still covers a counter that disagrees with the queue.
