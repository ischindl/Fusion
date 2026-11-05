---
"@runfusion/fusion": patch
---

summary: Appending to an agent log no longer rereads the whole file, so a long Activity log stops consuming dashboard CPU.
category: performance
dev: No on-disk format change and no change to line numbering or `agentLog:<taskId>:<lineNo>` citation identity. The append now numbers its rows from a bounded 64 KiB trailing window plus a per-file raw newline total fenced on `(dev, ino, size)`, re-seeded by a streaming scan when that fence is cold; at most one whole-file pass remains per process per file, and tracked paths are capped so residency cannot grow with the number of cards a server has touched. Log reads and retention rewrites still read whole content, and an append is still not atomic: a process dying mid-write can leave a truncated final line, and that line stays unnumbered, unpruned, and unreadable as an entry, exactly as before.
