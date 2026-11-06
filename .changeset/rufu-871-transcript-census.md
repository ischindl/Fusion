---
"@runfusion/fusion": patch
---

summary: The retention census now reports how many bytes of LLM conversation live sessions actually hold.
category: internal
dev: Census sources registered without `bytesPerEntry` were priced at a flat 96 B/entry, so two live executor sessions read as 192 bytes however much history they carried — the census reported 3.4 kB of a 5.9 GiB heap. New sources `executor_retained_transcript_bytes` (bytesPerEntry 1, measured content bytes), `executor_retained_transcript_messages`, `executor_retained_transcript_truncated`, `executor_transcript_instances_refused` publish the real figure from every executor instance, not just the first constructed one. The scan is capped (32 sessions x 2000 messages x 64 blocks) and reports `truncated` rather than an unmeasured total.
