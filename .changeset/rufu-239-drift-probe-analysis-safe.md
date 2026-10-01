---
"@runfusion/fusion": patch
---

summary: Startup no longer fails on databases missing the overlap-wait table; the drain defers until it exists.
category: fix
dev: Migration 0078's drift probe now decides relation presence in its own statement and only then reads the rows, so a guarded read can no longer raise PostgreSQL 42P01 at analysis time. A database without the relation defers the drain with its version marker unrecorded and applies it on a later boot. A comment-stripped static ratchet in migration-wiring-integrity.test.ts (unit gate) now rejects any applier statement that existence-tests and reads the same relation, and allowlists every schema-qualified range reference.
