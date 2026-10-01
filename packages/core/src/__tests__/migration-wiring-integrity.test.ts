/*
FNXC:Lifecycle 2026-07-16-22:40:
Migration wiring integrity — the class guard for the FN-8141 crash. Migrations are
registered EXPLICITLY in schema-applier.ts (not auto-discovered), so a new .sql
file that is not wired through a version constant + bookkeeping check silently
never runs (documented hazard). PR #2260 tripped the adjacent trap: it added a
column to the model + 0000 baseline and bumped nothing, so existing DBs never got
it.

FNXC:ReviewConvergence 2026-08-22-18:58:
These assertions used to live inside src/__tests__/postgres/schema-applier.test.ts, whose comment
claimed they "run in the merge gate" — they did not: the gate runs four named files via
`test:unit-gate` plus two *.pg.test.ts files, and that PostgreSQL-integration file is in neither.
The drift it was meant to catch then landed twice (0064, then FN-149's 0065 with the ceiling left
at 0064), and the second one made every Fusion startup fail: the binary applied 0065, recorded it,
then rejected its own database through assertBinaryNotOlderThanDatabase.

They are moved here — a file with no PostgreSQL dependency, no fixtures and no timers, reading only
the migrations directory and the applier source — precisely so `test:unit-gate` can run them
deterministically in milliseconds. Gate admission evidence: a bootable `main` is the cheapest thing
this repository can verify, and this exact drift broke it. Keep this file DB-free; anything needing
a live database belongs in the PostgreSQL suite instead.
*/

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SCHEMA_BASELINE_VERSION } from "../postgres/schema-applier.js";

const applierSource = readFileSync(
  fileURLToPath(new URL("../postgres/schema-applier.ts", import.meta.url)),
  "utf8",
);

describe("schema-applier: migration wiring integrity", () => {
  const migrationsDir = fileURLToPath(new URL("../postgres/migrations", import.meta.url));
  const migrationFiles = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

  it("advances SCHEMA_BASELINE_VERSION to the highest-numbered migration file", () => {
    const highest = migrationFiles[migrationFiles.length - 1]!.slice(0, 4);
    // A new column that ships a migration file must also bump the baseline marker
    // (else the "all markers recorded" fast-path and upgrade bookkeeping drift, and
    // the stale-binary guard rejects the database this very binary just migrated).
    expect(SCHEMA_BASELINE_VERSION).toBe(highest);
  });

  it("wires every migration .sql file into the applier so none silently never runs", () => {
    // The applier references each migration by its exact basename in a path
    // constant. A file present on disk but absent from the source is unwired.
    const unwired = migrationFiles.filter((f) => !applierSource.includes(f));
    expect(unwired).toEqual([]);
  });
});

/*
FNXC:PostgresSchema 2026-09-15-22:37:
Drift probes run on databases sitting at any upgrade point, so a probe that asks whether a relation exists and
reads that same relation in the same statement is a boot crash rather than a repair. PostgreSQL resolves every
relation name in a statement at ANALYSIS time, before any branch is evaluated, so guarding a range-table read
with `CASE WHEN to_regclass(...) IS NULL THEN false ELSE ... END` in the same statement still raises 42P01
when the relation is absent, and a throw inside applySchemaBaseline means the project cannot boot at all.
RUFU-239 removed the one live instance; these scans keep the class from returning, because the failure it
prevents is every project failing to start rather than one query answering wrongly.

Scan A encodes the defect itself: no SQL fragment may test a relation for existence AND reference that same
relation as a range table entry. Deciding presence and reading the relation must be separate statements, so
the read only reaches the server when it can succeed.

Scan B bounds the blast radius: every schema-qualified range reference in the applier must be consciously
allowlisted, whether or not it carries an existence test, because a statement written against a relation a
real database may lack fails the same way either way. A new unlisted reference therefore has to be looked at
instead of shipping.

Comments are stripped before scanning — the same convention as the engine's tombstone guard — so prose can
never satisfy a structural scan, and each scan asserts its own pattern is still live, because a scanner whose
regular expressions stopped matching anything would report a clean repository.
*/
describe("schema-applier: drift probes stay analysis-safe on absent relations", () => {
  const stripComments = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

  /** Every backtick-quoted fragment: `sql` templates and sql.raw(...) bodies alike. */
  const sqlFragments = (source: string): string[] => source.match(/`[^`]*`/g) ?? [];

  const RELATION_RE = /to_regclass\(\s*'(project|central|archive)\.([^']+)'\s*\)/gi;
  const RANGE_REF_RE = /\b(from|join|update|insert\s+into|delete\s+from)\s+(project|central|archive)\.([A-Za-z0-9_"]+)/gi;
  const normalizeRelation = (schema: string, relation: string): string => `${schema}.${relation}`.toLowerCase();
  const normalizeRef = (keyword: string, schema: string, relation: string): string =>
    `${keyword.replace(/\s+/g, " ").toLowerCase()} ${normalizeRelation(schema, relation)}`;
  const describeFragment = (fragment: string): string => fragment.replace(/\s+/g, " ").trim().slice(0, 140);

  const fragments = sqlFragments(stripComments(applierSource));

  it("does not test a relation for existence in the same statement that reads it", () => {
    let existenceTests = 0;
    const violations: string[] = [];
    for (const fragment of fragments) {
      const existenceTested = new Set<string>();
      for (const match of fragment.matchAll(RELATION_RE)) {
        existenceTests += 1;
        existenceTested.add(normalizeRelation(match[1]!, match[2]!));
      }
      for (const match of fragment.matchAll(RANGE_REF_RE)) {
        const relation = normalizeRelation(match[2]!, match[3]!);
        if (existenceTested.has(relation)) {
          violations.push(`${relation} in: ${describeFragment(fragment)}`);
        }
      }
    }
    // Liveness: if the existence-test pattern ever stops matching, the scan below is vacuously clean.
    expect(existenceTests).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it("keeps every schema-qualified range reference inside an explicit allowlist", () => {
    /*
    FNXC:OverlapWaitSynchronization 2026-09-15-22:37:
    The single approved reference is migration 0078's retired-phase row probe. It is safe only because a
    separate to_regclass statement decides presence first and the applier issues this fragment when that probe
    reported the relation present — the two-step shape RUFU-239 introduced. Adding a relation here means
    promising the same discipline; the alternative, and the default for any probe, is a catalog-only predicate
    over pg_class/pg_namespace. Matching is lowercase because PostgreSQL folds unquoted identifiers.
    */
    const approvedRangeRefs = new Set(["from project.task_overlap_waits"]);

    const observed: string[] = [];
    const unapproved: string[] = [];
    for (const fragment of fragments) {
      for (const match of fragment.matchAll(RANGE_REF_RE)) {
        const ref = normalizeRef(match[1]!, match[2]!, match[3]!);
        observed.push(ref);
        if (!approvedRangeRefs.has(ref)) {
          unapproved.push(`${ref} in: ${describeFragment(fragment)}`);
        }
      }
    }
    expect(unapproved).toEqual([]);
    // A stale allowlist is how the next writer re-adds a reference nobody reviewed.
    for (const approved of approvedRangeRefs) {
      expect(observed).toContain(approved);
    }
  });
});
