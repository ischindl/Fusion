---
category: test-failures
module: postgres-schema
date: 2026-09-09
problem_type: systemic_gap
component: schema-applier state-based migration fallbacks
severity: medium
applies_when:
  - "A migration adds a state-based 'table is missing' repair probe"
  - "A schema test seeds every migration marker into an empty database"
tags:
  - postgres
  - migrations
  - schema-applier
  - patchnode
  - inherited-red
---

# State-based missing-table repair cannot run on an all-markers empty database

## Symptom

`packages/core/src/__tests__/postgres/schema-applier.test.ts` >
`schema-applier: VAL-SCHEMA-008 three-database topology` >
`ensures schemas before hooks when all migration markers are already recorded`

fails deterministically with:

```
PostgresError: function project.fusion_assign_project_id() does not exist
```

raised while `applySchemaBaseline` applies `0071_fn_227_patchnode_entries.sql`.

## Cause

The test creates a database whose ONLY object is `public.fusion_schema_migrations`, seeded with every
numeric marker `0000..SCHEMA_BASELINE_VERSION`, then calls `applySchemaBaseline` expecting a no-op
(`applied: false`) that still ensures the three schemas before plugin hooks run.

FN-227's patchnode step does not trust its own marker. It probes state:

```ts
if (!patchnodeEntriesAlreadyApplied || patchnodeEntriesMissing) { /* apply 0071 */ }
```

On that fixture `to_regclass('project.patchnode_entries') IS NULL`, so the repair path fires and re-applies
`0071`, whose `CREATE TRIGGER ... EXECUTE PROCEDURE project.fusion_assign_project_id()` needs the function
that migration `0006_project_ownership.sql` creates. The fixture's marker says `0006` already ran, so
`0006` is skipped and the function does not exist. The trigger statement aborts the whole baseline
transaction before the hook ever runs.

The general form of the gap: a state-based repair probe assumes "marker recorded, object missing" implies
"the object was lost from an otherwise-populated schema". An empty database with all markers recorded
satisfies that predicate too, while lacking the *prerequisites* of the migration it re-applies. Patchnode is
only the first probe of that shape to error; any earlier probe that reached DDL with inter-migration
dependencies would fail the same way.

## Evidence that this is inherited, not introduced

Both merge parents of the 2026-09-09 `origin/main` sync are red on this test:

- the test exists identically on both sides, and both seed markers with
  `generate_series(0, Number(SCHEMA_BASELINE_VERSION))`;
- ours' `SCHEMA_BASELINE_VERSION = "0072"` and upstream's `"0073"` both include `0071`, so the probe fires
  on each side;
- the `0071` migration file is byte-identical on both sides, as is the `patchnodeEntriesMissing` gate.

Upstream `main` CI at the synced SHA is red across all four test shards plus the pipeline-smoke and
engine-slow tiers, which is consistent with this being an upstream-side failure rather than merge damage.

## Fix options (neither is a test-side appeasement)

1. **Give the schema-ensure step the prerequisite.** The applier already owns "ensure the three schemas
   exist before hooks". Recreating `project.fusion_assign_project_id()` there with
   `CREATE OR REPLACE FUNCTION` makes every state-based repair path self-sufficient, and also repairs a DB
   where the function itself was dropped — the same failure class the missing-table probe exists for. Cost:
   the function DDL then lives in two places and must drift-check against `0006`/`0016`.
2. **Bound the repair probe to its real precondition.** Fire the missing-table repair only when the rest of
   the project schema is present (for example `to_regclass('project.tasks') IS NOT NULL`), so an empty
   registry-only database stays a no-op. Cost: per-probe precondition choice is judgment, and a genuinely
   emptied schema stops self-healing.

Do not "fix" this by deleting the assertion, widening it, or dropping the fixture's premise: the fixture is
deliberately an empty-but-fully-marked database precisely to catch hooks running before schemas exist.

## Merge-sync note

`0072`'s fork-local repair step now records the non-numeric ledger identity
`local-repair-mixed-0065`, so it is invisible to the numeric `generate_series` seed. The fixture inserts that
marker explicitly; without it the repair step applies during this test and reports `applied: true`, which
would look like a second, unrelated defect. Any fix above must keep that explicit row.
