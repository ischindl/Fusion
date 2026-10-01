---
title: "A drift probe that names an absent relation in the same statement it guards crashes boot with 42P01"
date: 2026-09-15
category: database_issue
problem_type: database_issue
applies_when: "A schema-applier drift probe or migration reads a relation that a real database may not have yet."
module: "@fusion/core"
component: postgres-schema-applier
tags:
  - postgresql
  - migrations
  - drift-probe
  - to_regclass
  - analysis-time-resolution
  - boot-failure
symptoms:
  - "PostgresError: relation \"project.task_overlap_waits\" does not exist during applySchemaBaseline"
  - "code 42P01 from parse_relation.c / parserOpenTable, raised on a database that never had the relation"
  - "the database bookkeeping already records every migration version, so the failing statement runs only on the drift-probe path"
root_cause: "The probe guarded a read of project.task_overlap_waits with to_regclass('project.task_overlap_waits') inside the SAME statement, but PostgreSQL resolves relation names at analysis time, before any branch is evaluated, so the guard cannot prevent the read from being planned"
resolution_type: code_fix
---

## Problem

`applySchemaBaseline` runs every drift probe even when the version bookkeeping says the baseline is fully
applied. Migration `0078`'s probe asked whether `project.task_overlap_waits` existed and read that same table
in one statement:

```sql
SELECT CASE WHEN to_regclass('project.task_overlap_waits') IS NULL THEN false ELSE
  EXISTS (SELECT 1 FROM project.task_overlap_waits WHERE phase IN ('revalidation-pending', 'repair-required'))
  OR EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_task_overlap_wait_phase'
      AND pg_get_constraintdef(oid) LIKE '%revalidation-pending%'
  )
END AS needed
```

The author's intent was "if the table is missing, there is nothing to drain". PostgreSQL does not evaluate
statements that way.

## Symptoms

- `PostgresError: relation "project.task_overlap_waits" does not exist`, `code: '42P01'`,
  `file: 'parse_relation.c'`, `routine: 'parserOpenTable'`.
- Thrown from `packages/core/src/postgres/schema-applier.ts` inside `applySchemaBaseline`, so it is not a
  background job failing quietly — a throw there means the project cannot boot.
- Reproduced by the database shape a fresh three-database topology produces: the ledger rows exist, the
  product relations do not.

## What Didn't Work

Reasoning that the `CASE` short-circuits. PostgreSQL parses and analyzes the whole statement before executing
any of it, so `FROM project.task_overlap_waits` is resolved during analysis and raises `42P01` whether or not
the `WHEN` branch would ever have been taken. No in-statement expression can defer that resolution: the branch
only suppresses the read's *result*, never its *name resolution*.

## Solution

Decide presence in its own statement, then let TypeScript decide whether the reading statement is ever sent.

```ts
// Presence first — catalog-only, safe on any database.
const tablePresent = (await tx.execute(sql`
  SELECT to_regclass('project.task_overlap_waits') IS NOT NULL AS present
`))[0]?.present ?? false;

// The read only reaches the server when it can succeed.
const rowDrift = tablePresent
  ? (await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM project.task_overlap_waits WHERE phase IN ('revalidation-pending', 'repair-required')
      ) AS needed
    `))[0]?.needed ?? true
  : false;

// The constraint half never needed the relation at all — the catalog already knows.
const constraintDrift = tablePresent
  ? (await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'project'
           AND t.relname = 'task_overlap_waits'
           AND c.conname = 'ck_task_overlap_wait_phase'
           AND pg_get_constraintdef(c.oid) LIKE '%revalidation-pending%'
      ) AS needed
    `))[0]?.needed ?? true
  : false;
```

The application block is gated on presence too. Deferring without recording the marker is the correct
disposition: the drain's effect is idempotent, so a later boot that does have the relation applies it as
normally as the first boot would.

Do **not** record the version marker to make the absent case pass. That would report a migration that never
ran and let the retired phases return silently on the next database that gains the relation.

## Why This Works

`to_regclass` is a catalog lookup on a text name, so it never triggers relation analysis. Splitting the
question into two statements moves the branch from SQL (where names are already resolved) into TypeScript
(where the second statement is simply never sent). The constraint half needed no relation at all: reading
through `pg_constraint` joined to `pg_class`/`pg_namespace` answers the same question from the catalog, which
also namespace-qualifies a lookup that had previously matched `conname` cluster-wide.

## Prevention

- **Structural ratchet** in `packages/core/src/__tests__/migration-wiring-integrity.test.ts`, the DB-free file
  that already reads the applier source and runs in `test:unit-gate`. Comments are stripped first, so prose
  cannot satisfy it:
  - Scan A rejects any SQL fragment that both `to_regclass`-tests a relation and references that same relation
    as a range table entry.
  - Scan B requires every schema-qualified range reference in the applier to appear in an explicit allowlist,
    seeded with the single deliberately two-step-gated read. An unlisted new reference fails, and so does a
    stale allowlist entry.
  - Both scans assert their own patterns still match, so a broken regular expression cannot report a clean
    repository.
- **Never guard a range-table reference inside its own statement.** Either test presence in a separate round
  trip, or express the question so it never names the relation at all — `pg_class`/`pg_namespace`/`pg_constraint`
  lookups are the cheaper default for "does this object have this shape?" probes.
- **A probe's job is to answer, not to succeed.** When a probe cannot answer because the object is absent, the
  honest answer is "defer, marker unrecorded".
- **Migration `.sql` files are outside the ratchet's reach.** Files under
  `packages/core/src/postgres/migrations/` name their relations bare by design; what makes that safe is the
  applier block that reads them. A migration whose target relation may be absent needs its applier block
  presence-gated, and that gate is what Scan B watches.
- **Pin both detection halves, independently.** A probe that is always false is indistinguishable from a
  working probe on a healthy database. Each half is covered by a case that goes red when that half is disabled:
  a stale 0077-era eight-phase `CHECK` for the constraint half, and a retired-phase row whose constraint
  already reads clean (installed `NOT VALID`, so the row survives) for the row half.
