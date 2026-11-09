---
"@runfusion/fusion": patch
---

summary: Mailbox badge and Inbox read their counts together instead of one after another, so cold loads wait less.
category: performance
dev: `GET /messages/unread-count` and `GET /messages/inbox` now dispatch their three independent aggregates in one wave instead of awaiting each PostgreSQL round trip in sequence; measured median for the 119-byte unread-count response was 1,56 s against a 0,07 s authenticated in-memory endpoint. Response shapes are unchanged.
