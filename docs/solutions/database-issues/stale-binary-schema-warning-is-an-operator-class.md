---
title: "A database newer than this binary is a warn-only operator class, not a card failure"
date: 2026-11-05
problem_type: database_issue
module: "@fusion/core"
component: postgres/schema-applier
tags:
  - stale-binary-schema
  - postgres
  - migrations
  - fork-maintenance
  - operator-action
  - warn-only
symptoms:
  - "the boot log carries a line starting with `[stale-binary-schema]` naming two migration numbers"
  - "an agent lane reads that line and reports its own card as broken"
  - "a store-backed tool is blamed for a failure that a retry of the tool cannot change"
root_cause: "a database carries a fusion_schema_migrations version above this binary's SCHEMA_BASELINE_VERSION, which is the normal state of a feature-reduced build opening a database a newer build migrated; the condition needs an operator who runs the right build, and the only line reporting it used to carry no stable token, no addressee, and no attribution"
resolution_type: code_fix
---

## Problem

`assertBinaryNotOlderThanDatabase` (`packages/core/src/postgres/schema-applier.ts`) compares the highest
numeric row in `fusion_schema_migrations` against `SCHEMA_BASELINE_VERSION`, this binary's claim about the
newest migration it knows. When the database is above that claim, a *different, newer* Fusion migrated it.

That is not corruption and not a bug. This product line is a permanently feature-reduced build that routinely
opens a database holding migration slots it will never implement. The correct outcome is: keep going, and tell
the operator which build to run. Before RUFU-480 the line did keep going, but the sentence it printed said
only "this binary only knows up to N" — no addressee, no remedy, no stable token to grep — so an agent lane
that saw it had nothing to point at and no way to learn how many cards it had touched. The same checkout also
still exported `StaleBinarySchemaError`, a class nothing constructs, whose message asserted the exact opposite
of the shipped policy: that the store "refuses to open", that the operator should `brew upgrade fusion`, and
that a retry is the remedy.

## What Didn't Work

- **The hard refusal (`StaleBinarySchemaError`), removed 2026-10-05.** Throwing bricked *every* store open
  while the mismatch stood — including an ordinary upgrade-then-rollback, where the older binary is the one
  the operator deliberately chose. It also converted a healthy read-only boot into a failed card, which is
  the mis-diagnosis this class keeps having. The class is now deleted and tombstoned
  (`packages/engine/src/__tests__/legacy-tombstones.test.ts`) so the refusal policy cannot quietly return.
- **Leaving the exported class as "harmless dead code".** It was re-exported from three barrels and JSDoc'd
  "Thrown when…", so it read as live policy and pointed every reader at the wrong remedy. Dead code that
  states the opposite of the real rule is not harmless.
- **A run-audit event for the condition.** Rejected on purpose: the store opens successfully, so there is no
  failure to record, and a warn-only condition has no task lifecycle consequence to attribute. The log line
  plus its token is the record.
- **Adding the hint to `formatPostgresSchemaBackendBootError` or the pi-extension tool-error channel.** Both
  only format an error the boot path *threw*. This guard throws nothing, so a hint there is unreachable code
  that would duplicate the stale-*package* surface.

## Solution

One line, carrying the whole story, at the one place that can see the condition:

```text
[stale-binary-schema] Database has schema migration 0096 applied; this binary's ceiling is 0095. Continuing: unknown tables/columns are ignored rather than written to. Operator action: run a build whose schema ceiling is at least 0096. This is not a card failure, and retry cannot change it.
```

- **`stale-binary-schema` is the count key.** It is interpolated from `STALE_BINARY_SCHEMA_CLASS` in
  `schema-applier.ts` and must never be reworded: grepping it is the only way to count the cards this
  condition touched. It is deliberately *not* a barrel export — a log marker is consumed by grep and by this
  document, not by imports.
- **Both numbers are always present.** The database's highest applied version and this binary's ceiling, so
  the direction of the mismatch is readable without opening a migrations directory.
- **The addressee is the operator, and only the operator.** Running a build whose ceiling is at least the
  database's version is the whole remedy. An agent must never attempt it: a Fusion task session dies with the
  process it would upgrade, so it cannot run an upgrade or relaunch and keep going, and repository policy
  forbids performing a release from inside a task. See the card's own boundary — this class is named and
  surfaced, never fixed by the lane that saw it.
- **Severity stays `warn`.** The store opens, so raising it to an error would invent the failure mode the
  2026-10-05 decision removed.

**What an agent should do on seeing the line:** treat the card as healthy, do not retry the tool (the retry
cannot change it), do not open a duplicate card for the version numbers, and name the condition in the
completion summary so the operator sees which lane is running behind.

## How to Count the Cards It Touched

The warning sets **no** task error and moves **no** card, so the board alone cannot answer "how many cards did
this hit". Grep the token, then intersect with the board:

```bash
grep -rl "stale-binary-schema" <rootDir>/.fusion/tasks/*/agent-log.jsonl
grep -rn "stale-binary-schema" <runtime root>/.fusion/logs/
```

Then read the current board with `fn_task_list` (or `fn_task_search`) to see which of those cards are still
non-done, and use the failed-card filter only to catch lanes that mis-read the warning as a failure. A card
that merely mentions the token in prose is not evidence of harm — the harm is a lane that stopped working, so
check what the lane did next, not only that the line appeared.

## Do Not Confuse With

| Shape | Difference | Write-up / owner |
| --- | --- | --- |
| A renumbered migration that silently never runs | No warning at all; the marker check passes and the DDL is skipped, so the symptom is a missing column on reads | [`postgres-migration-number-is-the-identity.md`](postgres-migration-number-is-the-identity.md) |
| A schema-version constant left below the highest migration block | The SQLite ancestor of the same class; the newest block never executes on the upgrade path | [`schema-version-constant-must-equal-highest-migration.md`](schema-version-constant-must-equal-highest-migration.md) |
| The installed *package* is older than the released one | A CLI/package-version comparison, not a database fact; no store boot is involved | RUFU-247's stale-package surface (`packages/cli/src/update-check.ts`) |
| A DDL-bootstrap failure at store open | The boot genuinely throws, so tools really are refused and an error really is returned | RUFU-473's DDL-bootstrap failure path |

## Why This Works

The guard already had the right behaviour — warn and continue. The failure was communicable, not structural: an
un-addressed sentence cannot be acted on and cannot be counted. Naming the class with one fixed token makes the
condition queryable across every log surface at once, naming both versions makes the direction readable, and
naming the operator as the only addressee stops the lane that sees it from burning retries or filing a card
about its own health. Deleting the unreachable refusal class removes the competing explanation rather than
adding one.

## Prevention

- One warn line per condition, and it must carry the addressee, both measurements, and the stable token. If a
  condition is only describable by a human reading two numbers and comparing them, it is not yet countable.
- Delete the refusal path when you make a condition warn-only, and tombstone the symbol. A dead error class
  whose message asserts the old policy is a live source of mis-diagnosis.
- Never let an agent lane attempt an operator-only remedy. If the fix is "run a different build", the deliverable
  is the sentence that says so.
- See also [`postgres-migration-number-is-the-identity.md`](postgres-migration-number-is-the-identity.md) — a
  database newer than this binary logs the warn-only stale-binary warning naming both versions; it is neither a
  refusal nor a card failure, while a renumbered migration is silent and does corrupt delivery.
