---
category: performance
module: packages/core/src/task-store/comments.ts
date: 2026-11-15
problem_type: architecture_pattern
severity: medium
component: task-store
applies_when:
  - "Anyone is about to change `DEFAULT_TASK_ACTIVITY_LOG_ENTRY_LIMIT`, add a byte budget, or bound `action`"
  - "A card's History is silently missing entries that were logged weeks ago, or an in-log counter stopped incrementing"
  - "A `[timing]` figure on a card changes after a retention or trim change"
  - "A retention proposal cites an entry count, a byte count, or the 1 000-entry cap"
  - "Someone proposes dropping the legacy `tasks.log` column, `VACUUM FULL`, or `pg_repack` as a retention fix"
tags:
  - retention
  - task-log
  - task-log-entries
  - byte-budget
  - entry-cap
  - timing
  - eviction
  - policy-decision
related_components:
  - core_task_store
  - engine_triage
  - engine_verification
  - cli_dashboard_tui
---

# Decide the task activity-log retention policy: entry cap vs byte budget, and the fate of `[timing]` entries

**Status: DECIDED.** This record settles the two policy questions RUFU-615 left out of scope and
corrects the statistics that question was framed on. It changes no behavior. Every follow-up it
defers names its precondition here; the cap constant itself carries a pointer back to this file
(`packages/core/src/task-store/comments.ts`).

**Question one — what bounds a card's History:** keep the entry cap **and** add a per-card byte
ceiling, with the byte ceiling operative, expressed in **plain UTF-8 bytes of `action` + `outcome`
in `project.task_log_entries`**, at **1 MiB per card**, enforced in exactly one place: the retention
step inside `appendTaskLogEntries`. Scheduled behind one named precondition.

**Question two — `[timing]` entries:** keep prose plus the read-time regex exactly as shipped. Do
**not** add a typed duration column and **do not** retire the raw lines. The live defect is that
three modules implement the same parse; converging them needs no schema change.

## Why the framing had to be re-measured first

The request this decision answers argued from four numbers. All four are wrong, one by three orders
of magnitude, and the direction of the error is not uniform — two make the current cap look safer
than it is and two make it look more dangerous. Measured values are in § Census; the full verdict
table with `file:line` citations lives in the `premise-check` task document on this card, and the
reproduce-from-scratch SQL lives in § Appendix.

| Claim in the request | Verdict | Measured |
|---|---|---|
| Cap constant is `MAX_LOG_ENTRIES` | **corrected** | `DEFAULT_TASK_ACTIVITY_LOG_ENTRY_LIMIT` — `packages/core/src/task-store/comments.ts:20`. `MAX_LOG_ENTRIES` is two *unrelated* display buffers (`devserver-types.ts`, `dashboard-tui/log-ring-buffer.ts`). |
| Cap value is 1 000 entries | **confirmed** | `1_000`, `comments.ts:20`. |
| History lives in the `tasks.log` column | **corrected** | RUFU-312 moved it to `project.task_log_entries` in migration `0093`. `task-log-entries.ts:1-26`: "A PURE LOG APPEND WRITES NO `tasks` ROW AT ALL." |
| Enforcement is inline array splices | **corrected** | Three units, one live (§ Mechanics). |
| p90 = 4 entries | **corrected, ~180x** | **p90 = 737** board-wide / 449 on the reference board. p50 = 97. |
| max = 77 entries | **corrected, ~13x** | **max = 1 005**; 239 cards sit at or above the cap today. |
| `[timing]` = 60 % of bytes at 96.6 % of rows | **corrected, ~300x** | **0.2 % of bytes, 0.3 % of rows.** |
| RUFU-615 stores the derived sum | **confirmed** | `schema/project.ts:239`, migration `0092`, `reads.ts:1489`/`:2467`. |
| Raw `[timing]` lines are forensics-only | **confirmed for read cost, corrected for eviction** | Both authors *recompute* the figure; nothing accumulates it (§ What eviction costs). |
| Prune runs on a 60-second cycle | **corrected** | `maintenanceIntervalMs: 300_000` (5 min) — `settings-schema.ts:939`. |
| Prune "never fired" on task History | **corrected — it was never in scope** | `pruneOperationalLogsAsync` names `activity_log` (`async-maintenance.ts:89`) and `run_audit_events` (`:105`) only. |
| ≥ 1 live row holds a non-array `log` | **corrected (gone)** | `jsonb_typeof(log)` now returns one class: `array`, 3 434 rows. The `CASE` guard stays correct defensive practice. |
| Measured over 2 417 live rows | **confirmed as provenance** | `docs/storage.md:586` records exactly that census. It is a live measurement; `:630` separately reuses the shape as a benchmark fixture. |

Two of these deserve to be called out rather than filed, because they inverted the decision:

> **On the `file:line` citations in this record.** They are captured against the tree *after* this
> record landed, so `comments.ts:20/:21/:68` include this record's own pointer comment (they were
> `:13/:14/:61` before it). Prefer the symbol name when re-checking: line numbers move under any
> edit, including a documentation edit, which is exactly how a citation comes to describe a shape
> that no longer exists.

**The request's numbers would have justified *loosening* the cap; the real numbers say it is
already binding.** 239 of 3 085 cards (7.7 %) sit at or above 1 000 side rows right now, and 113 of
them exceed 1 000 (1 001-1 005). The trim is not a hypothetical guard against a pathological future
card — it is running on real cards today, and the overshoot proves it is enforced per-append, so
concurrent appends to one card overshoot by the entries in the racing inserts.

**The request's `[timing]` number was off by 300x, in the direction that made deleting them look
valuable.** At 60 % of bytes, retiring the raw lines is the obvious win. At 0.2 %, it is not a
retention lever at all, and the real defect in that area — three independent implementations of one
parse rule — has nothing to do with storage.

Before measuring, the repo's own record already refuted the distribution: `docs/storage.md:586`
counts **482 709 log entries over 2 417 rows**, a ~200-entry mean, which cannot coexist with a
77-entry maximum, and `:654` prices "the worst-case log (271 entries, 1.1 MB)". The claimed "375x
headroom" is also not what 1 000 / 77 equals.

## Where the bytes actually are, and which table this policy governs

Three populations, measured apart and never pooled. The policy is forward-looking and therefore
governs the first one only.

| Population | What it is | Cards | Rows | Stored bytes |
|---|---|---|---|---|
| `project.task_log_entries` | **the live History** — the only set the live append trims | 3 085 | 663 110 | 220 MB heap, **350 MB** with indexes |
| `project.tasks.log` (jsonb) | **legacy archive** — pre-cutover data plus compound-writer appends, being copied out | 3 434 | 3 434 | 50.2 MB stored / 205.9 MB plain (4.1:1 TOAST) |
| `project.task_log_rollup` | derived envelope, one row per card | 3 085 | 3 085 | 2.0 MB |

`project.tasks` heap is now **7 200 kB**, which is RUFU-312's own claim read from the other side.
Sizing a forward-looking policy against the legacy column would size it to a shrinking artifact.

**Two columns share the name `timing_total_ms` and they answer differently per card.** Every figure
in this record names which one it means.

| column | rows | null | zero | p50 | p99 | max |
|---|---|---|---|---|---|---|
| `tasks.timing_total_ms` (`schema/project.ts:239`, row-writer author) | 3 434 | 289 | 2 343 | 0 | 36 877 | 271 203 |
| `task_log_rollup.timing_total_ms` (`:1327`, append author) | 3 085 | 0 | 2 283 | 0 | 36 901 | 271 203 |

`pickTaskLogEnvelope` (`task-log-entries.ts:289`) currently picks the **rollup** for 2 676 cards, the
**legacy row** for **395** (11.5 %), and 349 cards have no rollup row at all. Thirteen cards' two
figures disagree. Consequence: a retention change that alters one author's input and not the other
is visibly wrong on 395 cards today, which is why § The enforcement shape requires both authors stay
paired.

## Census: the distribution the policy is sized against

Per-card entries in `project.task_log_entries` (`count(*) GROUP BY project_id, task_id` — never
`rollup.entry_count`, which RUFU-312 authors as the side-row count only, not the reader-visible
merged count):

| Scope | cards | rows | p50 | p90 | p99 | max | cards ≥ 1 000 |
|---|---|---|---|---|---|---|---|
| all projects | 3 085 | 663 103 | 97 | 737 | 1 001 | 1 005 | **239** |
| reference board (`proj_9326d74a133b421a`) | 957 | 165 113 | 85 | 449 | 1 001 | 1 002 | 39 |

Per-card bytes, plain UTF-8 (`sum(octet_length(action) + coalesce(octet_length(outcome),0))`):

| p50 | p95 | p99 | p99.9 | max | total | cards > 1 MiB |
|---|---|---|---|---|---|---|
| 17 755 | 148 793 | 250 813 | 1 494 798 | 3 710 000 | 128 878 873 | **4** |

Four cards out of 3 085 (0.13 %) hold 10.7 MB — **8.3 % of all History bytes on 0.13 % of cards**.
That concentration is what a byte ceiling is for and what an entry cap cannot see.

Per-entry shape: mean **194 B** raw against **184 B** `pg_column_size` — a 5 % delta, so ordinary
entries are stored inline and effectively uncompressed. Max single entry **27 048 B**; 6 727 of
663 112 entries exceed 2 040 B.

**Index cost is not optional.** `task_log_entries` carries 117 MB of index against 220 MB of heap
(35 %): `idx_task_log_entries_task_time` 58 MB, `task_log_entries_pkey` 46 MB,
`idx_task_log_entries_dedupe` 13 MB. Per row that is ~332 B of heap plus ~176 B of index for ~194 B
of text — **text is ~38 % of what a row costs**, which is the quantitative reason a byte budget on
text alone under-bounds the operator's actual bill (§ The byte currency).

`[timing]` share, the number that decides question two:

| Scope | rows | `[timing]` | share | bytes | `[timing]` bytes | share |
|---|---|---|---|---|---|---|
| all | 663 121 | 2 104 | **0.3 %** | 128 862 135 | 212 621 | **0.2 %** |
| reference board | 165 119 | 647 | **0.4 %** | 30 297 164 | 79 611 | **0.3 %** |

The worst cards, all cap-pinned and all paused, all one repeating infrastructure sentence:

| card | entries | bytes | lane / status |
|---|---|---|---|
| CODE-012 | 1 000 | 3 710 000 | todo / paused |
| PRGW-004 | 1 000 | 3 710 000 | todo / paused |
| SANE-084 | 1 001 | 1 725 749 | done / paused |
| SANE-129 | 465 | 1 539 219 | done / paused |
| SANE-265 | 415 | 1 010 402 | done / paused |
| DEVO-002 | 1 000 | 501 534 | done / paused |

Inside them: CODE-012 and PRGW-004 carry 1 000 *distinct* rows (only the timestamp differs),
SANE-084 580 distinct of 1 001, DEVO-002 **2 distinct of 1 000** — 500 verbatim copies. None carries
a `dedupe_key` (`count(dedupe_key)` = 0 on all four): they predate or bypass `logEntryOnce`.

Grouped by lane, the cap is binding in every lane, including lanes where a chatty card is
surprising: `done` 201 cards at cap, `todo` 20, `archived` 9, `in-review` 3, `in-progress` 3,
`closed` 1, `parked` 1, **`triage` 1** (a card that reached 1 001 entries while never leaving
intake).

### The combined footprint — what the single-view view hid

The append trims only the side table; `mergeTaskLogViews` caps only at read time. A card therefore
holds legacy entries **and** side rows at the same time:

| project | cards | both views | p99 combined | max combined | combined > 1 000 | combined ~2 000 |
|---|---|---|---|---|---|---|
| reference board | 1 012 | 957 | 2 001 | **2 004** | 86 | 23 |
| proj_e70af3a5 | 456 | 285 | 2 002 | 2 010 | 59 | 17 |
| proj_1849a8ac | 288 | 269 | 2 001 | 2 001 | 69 | 15 |

`side_only` = 0 in every project: every side-row card still carries its legacy array too. **A card can
store roughly 2 000 entries while the operator believes 1 000 is enforced.** That is a present-tense
fact, not a risk.

### Data states, as they resolve today

`jsonb_typeof(log)` returns exactly one class (`array`, 3 434 rows, 0 empty). Side-row owners: 2 954
live non-archived, **130 soft-deleted still holding 18 846 rows / 3.7 MB**, 1 archived sentinel,
0 orphaned. Soft-deleted cards keeping their History is a boundary the policy must state rather than
discover — this decision leaves it standing.

### Read-only discipline and its cost

Every statement ran inside `BEGIN READ ONLY; ... ROLLBACK;` with
`current_setting('default_transaction_read_only')` verified `on`; `SELECT` only — no DDL, no writes,
no `ANALYZE`. No vitest / `.pg.test.ts` lane was pointed at this cluster (the `pg:test:up` recipe in
`docs/testing.md` is for a separate cluster via `FUSION_PG_TEST_URL_BASE`). The side table was
measured first precisely because it is narrow and inline; the legacy column was touched in
aggregate-only form, because any per-row touch decompresses the whole value and `docs/storage.md`
prices that at 4.5-11.5 s of server CPU per full-board read. Two figures reproduced the repo's own
record exactly: `max(octet_length(log::text))` = 3 992 000 B against the 3.99 MB noted at
`task-log-entries.ts:445`, and `0093`'s 313 KB max-single-row class.

## Mechanics: what enforces the cap today

| Site | Unit | Live? | Kind |
|---|---|---|---|
| `appendTaskLogEntries` — select cut-off at `offset(cap)`, then `DELETE ... WHERE seq < cutOff.seq` (`task-log-entries.ts:353-371`) | entries | **yes — the storage bound** | storage eviction |
| `task-mutation-ops.ts:510`, `:668`, `:828`; `human-merge-approval-ops.ts:127`; `overlap-wait-ops.ts:380`; `overlap-wait-reconciliation.ts:166` — six `splice`/`slice` calls | entries | yes, **legacy column only** | storage eviction, wrong table for the policy |
| `mergeTaskLogViews` (`:93-119`, cap slice at `:119`) `merged.slice(merged.length - limit)` | entries | yes, at **read** time | presentation bound — **not retention** |
| `audit-ops.ts` | — | no longer enforces the entry cap at all (it calls `truncateTaskLogOutcome` and routes to `appendTaskLogEntries`) | — |
| `compactTaskActivityLog` (`comments.ts:68`) | entries | **no production caller** — definition plus one re-export (`audit.ts:24`) | **dead seam** |

`compactTaskActivityLog` being dead is worth stating plainly: a byte budget placed there would
change nothing at runtime while leaving the code looking like it had an owner. It is not the target.

**Only `outcome` is truncated** (`DEFAULT_TASK_ACTIVITY_LOG_OUTCOME_LIMIT = 4_000`,
`comments.ts:21`); **`action` has no length bound at all.** The census says that is backwards: the
four largest entries in the whole corpus are 27 041 / 27 038 / 25 630 / 25 583 bytes of `action`
against 7 / 7 / 23 / 19 bytes of `outcome`. The field with a bound is not where the payload sits. The
writer that put them there is a merge lane; the writer that repeats a fat `action` most is
`Specification failed: ${errorMessage}` (`triage.ts:5382`, `:5691`) — 3 107 board-wide copies of one
1 472-byte sentence whose message *is* the failed SQL statement. The repo already named this the
fattest writer (`triage.ts:5681`, `util/durable-diagnostic-log.ts:21`: "7,942 rows … 14.0 MB — the
fat ones, they carry a JS stack") and answered it at the **writer** seam with `logEntryOnce` +
`dedupeKey` (RUFU-643), not at the cap. That is the right seam for repetition and it is why this
decision does not treat the cap as the place to fix chatty writers.

`verification-utils.ts:631` also puts a multi-line command summary into the message that becomes
`action`, which is how an unbounded `action` stays unbounded in practice.

## What eviction costs — the two consequences any policy must pay

Both are present-tense, not hypothetical, and both were confirmed by reading the code.

**1. It silences the live log stream for every cap-pinned card.**
`packages/cli/src/commands/dashboard.ts:3716-3717` computes new entries as
`const newEntries = task.log.slice(lastLogLength); lastLogLength = task.log.length;`. Once the
merged History is pinned at the cap, head-eviction keeps the length constant, the slice returns
nothing, and that card's `log:appended` stream goes permanently silent. **239 cards already sit
there.** Tightening eviction cannot make this worse, but any tightening must not be scheduled as if
this were unaffected — the fix is a precondition, not a nice-to-have.

**2. It moves an operator-visible number, because the figure is recomputed, never accumulated.**
`timedExecutionMs` is answered from the loaded log when a reader holds it and from the newer
envelope when it does not (`reads.ts:1489` board, `:2467` detail), both via the same
`computeTimedExecutionMs`. But *neither author stores an accumulator*: the rollup author calls
`deriveTaskLogProjections` over the **merged** view inside `appendTaskLogEntries`
(`task-log-entries.ts:421`) and the row author does the same over its post-`splice` array. RUFU-615
removed the **read-cost** coupling; the **value** coupling is intact. Evicting entries recomputes a
smaller sum.

**Decided semantics: `timedExecutionMs` means "the sum over retained History", today's answer.**
The alternative ("the sum over all History ever logged") is not merely additive: it requires
accumulate-on-append in *both* authors and is then **contradicted by `replaceTaskLogEntries`**
(`task-log-entries.ts:520`), whose documented meaning is "this is the History now" — an accumulator
would keep a sum over entries that seam just declared were never there. Retained-History semantics
is the only one coherent with a seam that wholesale-replaces History. Consequence, stated so nobody
re-derives it: **because this branch was taken, the byte ceiling needs no eviction-exempt
accounting precondition.** If a later decision reverses it, the byte ceiling additionally waits on
making both authors' sums eviction-exempt.

**A second-order effect the merge creates, classified as a constraint, not a bug.** All **2 104**
`[timing]` side rows have a twin in the legacy array (2 150 legacy `[timing]` entries exist; only 46
are legacy-only). Because the merged view dedupes on `(timestamp, action, outcome)`, trimming side
rows today **does not evict a pre-cutover entry at all** — the legacy copy keeps it, and keeps its
duration in the figure. "Delete the raw entries" therefore does not have one owner or one meaning
until the legacy column is gone, and that removal is operator-decided maintenance this record does
not schedule.

**And one precedent for why the cap is a correctness question, not only a storage one.** Recorded at
`util/durable-diagnostic-log.ts:25-27`: re-stated diagnostics "scroll real delivery history off the
card — which is how RUFU-431's strike counters that live IN that log were silently disarmed." State
that lives in evictable prose is destroyed by eviction, at any cap. The durable lesson is about
where state may live, and it argues against *raising* the cap as a remedy.

## Decision one: entries, bytes, or both

| Option | Bound expressed in | What it protects | What it costs | Breaks if done with no precondition |
|---|---|---|---|---|
| **Keep the entry cap alone** (today) | entries per card, per view | row count, therefore heap **and** the 117 MB of index, both of which scale per row | a 27 KB single `action` is as legal as a 60 B one; 4 cards already hold 8.3 % of all History bytes; theoretical worst case 1 000 x 4 000 chars of `outcome` **plus an unbounded `action`** | nothing breaks — which is why it has survived, and why it under-protects the fat-card case |
| **Replace with a byte ceiling** | bytes per card | exactly one card's bytes | **under-bounds ~62 % of a row's real cost** (heap + index scale per row, not per text byte); a chatty writer of 60-byte entries gets ~5x more lines before it feels the ceiling, so repetition — the actual CODE-012 failure — gets *cheaper* | same silent stream as today, plus a new one: the ceiling must be checked where no read-back exists, so a check computed from `pg_column_size` cannot be evaluated at append time |
| **Keep both, byte ceiling operative** | entries as backstop **and** bytes per card | the fat-card concentration *and* the per-row cost the byte bound cannot see | two bounds to reason about, and one more decision in the append's transaction | the incremental-stream starvation above becomes reachable by tightening instead of by accident |

### The rule

> A card's History in `project.task_log_entries` is bounded by **whichever limit bites first**:
> **1 000 entries** (unchanged, backstop) or **1 MiB of plain UTF-8 bytes across `action` +
> `outcome`** (operative). The newest entries are kept. Both limits are evaluated in one decision
> in one place — the retention step of `appendTaskLogEntries`.

**Why 1 MiB.** Census p99 is 250 813 B. A **4x headroom factor** over p99 gives 1 003 252 B, rounded
up to the binary round number 1 048 576 B, which sits between the measured p99 (250 KB) and p99.9
(1 494 798 B) — i.e. between "never reached by ordinary work" and "reached only by the failure waves
we are trying to bound". At 1 MiB it clips **4 of 3 085 cards today (0.13 %)** and reclaims
~10.7 MB (8.3 % of History bytes). Headroom is deliberately generous because the failure it targets
is a *repeating infrastructure error*, whose per-copy size is set by an external message we do not
control; a tight ceiling would evict real delivery history to make room for the next stack trace,
which is exactly the RUFU-431 shape. Visible shrink factor: the current cap's theoretical worst case
is ~4 MB per view from `outcome` alone with `action` unbounded (and the measured max card, 3 710 000 B,
sits at that bound, confirming the arithmetic), and the *stored* footprint per card reaches 2 010
entries across both views. Against 1 MiB that is a ~4x shrink on the theoretical case and the
4x-headroom choice is what keeps ordinary cards untouched.

**Do not change the 1 000 number here.** The census says the cap's problem is that it is the *only*
bound, not that 1 000 is the wrong value: at p90 = 737 the cap is 1.36x p90, which is tight but not
absurd for a History. Lowering it would destroy delivery history on the 239 pinned cards to buy a
bound the byte ceiling buys far more precisely; raising it increases the RUFU-431 exposure. Both
moves are follow-ups with their own evidence requirements, not this decision.

### The byte currency, and why the choice is not neutral

The ceiling is expressed in **`octet_length` of the UTF-8 text — what the writer is about to insert**
— not in `pg_column_size`, and not in heap footprint. In the new shape this is not a stylistic
choice:

- The natural enforcement point runs **inside the append's own transaction, before the read-back**.
  There it holds the two strings and can compute their UTF-8 length with no database round trip.
  `pg_column_size` is a *storage* answer to a *write-time* question.
- At the measured sizes, the two currencies nearly coincide (mean 194 B raw / 184 B stored) because
  ordinary entries are **not TOASTed** — which is exactly the shape RUFU-312 created. This is the
  opposite calculus from the legacy column, where the bound was a TOAST chunk and every byte was
  amplified by a whole-value rewrite; that rewrite cost is precisely what RUFU-312 deleted, so
  reasoning about `log`-column bytes here would reason about a cost that no longer exists on the
  live path.
- Honest limit of that claim: **the ceiling under-states the operator's bill by ~2.6x** (128.9 MB of
  text against 337 MB of heap + index), and the index alone grows 176 B per entry regardless of text
  size. The entry cap is retained *precisely because* it is the bound that sees per-row cost.
- Precedent for byte discipline, and its limit: `LOG_RECENT_INLINE_BYTE_BUDGET = 2_040`
  (`task-log-projections.ts:54`) is the house choice for a bounded **column** and was chosen to stay
  TOAST-inline. A growing **row set** needs a different bound than a bounded column; do not reuse
  2 040 as a per-card ceiling, and do not read that constant as precedent for one.

### The enforcement shape, aimed at the seam that is actually live

1. **One trim decision, in one unit pair, in the retention step of `appendTaskLogEntries`** — the
   only place that both knows the card's footprint and already runs in the append's own transaction.
   Today's `offset(cap)` cut-off becomes a cut-off computed over both limits (keep the newest rows
   while count <= 1 000 **and** cumulative bytes <= 1 MiB).
2. `mergeTaskLogViews`' slice **stays** as a presentation bound and must never be described as
   storage retention. It caps what a reader sees, not what a card holds.
3. **The six legacy trim sites** (`task-mutation-ops.ts:510,:668,:828`,
   `human-merge-approval-ops.ts:127`, `overlap-wait-ops.ts:380`,
   `overlap-wait-reconciliation.ts:166`) are named here so a follow-up cannot miss one. They stay
   length-based — they write the legacy column, whose footprint the chosen ceiling does not govern —
   but a follow-up must either fold them into the shared decision or waive them in writing.
4. **A trim keeps its pairing.** The rollup re-derivation follows the trim in the same append
   (`task-log-entries.ts:374-388`, whose `writeTaskLogRollup` at `:414` calls
   `deriveTaskLogProjections` over the merged view at `:421`) and must stay after it, or the
   envelope describes pre-trim History. And **every statement that still writes the `log` column
   must keep writing both derived columns in the same statement** via `withTaskLogProjections`
   (`task-log-projections.ts:404`) — the contract
   `task-log-projection-pairing.test.ts` scans for. With 395 cards answering from the row author,
   breaking the pairing is not a latent bug; it is a visible one.
5. **`action` gets a length bound** — same 4 000-character limit as `outcome`, same notice shape
   (`... action truncated to <N> characters ...`), so the field that carries 27 KB today is bounded
   like the field that carries 23 B. This is the highest-value/lowest-cost item in the whole decision
   and it is independent of the ceiling.
6. **Rejected: putting the budget on `compactTaskActivityLog`.** It has no production caller; the
   live trim is the `seq`-ordered delete at `task-log-entries.ts:353-371`.

### What happens to the legacy column under this policy

The ceiling governs **`project.task_log_entries` only** — not the merged footprint. That is a
deliberate, stated under-bound: the legacy array is a shrinking archive, its trim sites keep it at
1 000 entries, and the durable answer to the combined ~2 000-entry card is the legacy column's
eventual drop. This record **does not** schedule that drop, `VACUUM FULL`, or `pg_repack`;
`docs/storage.md` reserves all three to an operator-decided maintenance window and RUFU-312
deliberately refused to automate them. A card can therefore still hold ~2 000 entries after this
policy lands, and the honest framing is that the ceiling bounds the *growing* half.

### Deliberately not decided here, and why

- **Raising or lowering 1 000** as a one-line change: different evidence bar, and the census argues
  against both directions (§ The rule).
- **`operationalLogRetentionDays`** (`settings-schema.ts:1184`, default 30): a different system —
  `activity_log` and `run_audit_events`. Its prune has never touched task History and must not.
- **`agentLogFileRetentionDays`** (`:1192`, default 0 = disabled): the per-task `agent-log.jsonl`
  files, a filesystem artifact with its own liveness rule. Not the same History.
- **`TASK_DETAIL_ACTIVITY_LOG_LIMIT = 500`** (`routes.ts:113`, threaded to
  `register-task-workflow-routes.ts:1180`): payload truncation for one HTTP response. Presentation,
  not retention.
- **The in-process retention census** (`packages/dashboard/src/lib/retention-census.ts`,
  `scripts/check-retention-coverage.mjs`): dashboard heap, not the database. See the heap-growth
  runbook.
- **`MAX_LOG_ENTRIES` in `devserver-types.ts` and `dashboard-tui/log-ring-buffer.ts`**: same name,
  unrelated display buffers. The TUI ring buffer's value is **also 1 000**
  (`log-ring-buffer.ts:12`), so a find-and-replace on `1000` or on the name `MAX_LOG_ENTRIES` edits
  an in-process display buffer that this policy does not govern — grep by the qualified constant
  name `DEFAULT_TASK_ACTIVITY_LOG_ENTRY_LIMIT`, never by the number.

## Decision two: what is left to decide about `[timing]` entries

**The question as asked has already been half-answered by shipping.** The request asks whether
`[timing]` entries "should live in a structured side table at all". They do: RUFU-312's `0093` put
**every** History entry, `[timing]` included, into typed columns, and `task_log_rollup` already
carries a per-task numeric `timing_total_ms`. Presenting "extract a structured timing store with a
backfill" as an untried option would be presenting the shipped shape as a proposal, one migration
older than this card. The live remainder is narrower:

1. does each event's duration need its **own typed column**, so it stops being regex-parsed out of
   prose;
2. can the raw `[timing]` **text lines be dropped**;
3. what is the **per-event** figure worth beyond the per-task scalar the rollup already answers.

**What they are today.** Twelve writer call sites in five engine modules
(`merger.ts` x4, `execution/verification-utils.ts` x4, `worktree/worktree-acquisition.ts` x2,
`executor/run-implementation.ts`, `merge/merger-ai.ts`) emit free-form sentences in three duration
shapes (`in Nms`, `after Nms`, `(Nms)`). The rule lives in `computeTimedExecutionMs`
(`packages/core/src/tasks/log-timing.ts:20`) and takes the **first** `ms` number in `action` joined
with `outcome` — including failure lines, whose durations are summed into the same operator-visible
figure. **Three modules implement that parse independently**: the leaf itself; `sumTimedLogEntries`
in `packages/dashboard/src/sse.ts:276`, which has never converged on the leaf; and
`extractTimingEvents` / `getTimedDurationMs` / `summarizeTimingLabel` in
`packages/dashboard/app/utils/taskTiming.ts:14,:25,:44`. `deriveTaskLogProjections` uses the leaf
(`task-log-projections.ts:298`) at both authoring lanes; `serialization.ts` is a re-export.

**What the per-event figure is worth, measured rather than assumed.** It is not zero:
`TaskTokenStatsPanel.tsx:123-130,:200-203` renders a per-event list and a "Longest timing event"
row, which the per-task scalar cannot answer. So question three's answer is "one real operator-visible
surface", and any option that removes per-event durations removes that row.

**Parse error rate, from the census rather than from impression.** Of 2 104 `[timing]` entries:
**0 contain no `ms` token** (contribute nothing) and **0 contain more than one** (where the
first-match rule could attribute the wrong number). The maximum token count is 1. On the entire live
corpus the first-match rule is exact, including on failure lines — because today's twelve writers
each phrase one duration per sentence.

### Options and the verdict

| Option | What it is | Cost, in surfaces and migrations | What the operator gets |
|---|---|---|---|
| **1. Keep prose + read-time regex as shipped** | the status quo, named deliberately | none | nothing new; the parse stays exact at the measured 0 % error rate; three duplicate implementations stay |
| 2. Keep prose, add a typed per-event duration column on `task_log_entries`, filled at append, parse becomes fallback | per-event structure without deleting the human record | `ALTER TABLE project.task_log_entries ADD COLUMN duration_ms integer` — one column on an **existing** `project` table, so **no** new-table RLS/FORCED RLS/`fusion_project_isolation`/`fusion_assign_project_id` obligation (that set is owed only by a *new* table, per `0093`'s own comments), but still **a migration numbered above the current ceiling `SCHEMA_BASELINE_VERSION = "0097"`**, explicitly registered in `schema-applier.ts` (a `.sql` file dropped in the directory silently never runs), 12 writer call sites to pass the value, and **3 parse sites** collapsing to 2 (the sum stays derivable from prose as the fallback); a backfill if history is wanted, for which `0093` is the copy-with-marker precedent | the panel's per-event rows stop depending on phrasing; new writers can log timings without inheriting the regex contract |
| 3. Additionally retire the raw `[timing]` prose lines | the only option that shrinks History | everything in option 2, plus the semantics change below | **0.2 % of History bytes** |

> **Verdict: Option 1.** Keep prose plus the read-time regex exactly as shipped. Add no typed
> duration column. Do not retire the raw lines. Separately, converge the three parse implementations
> onto `computeTimedExecutionMs` — that is the actual defect, and it needs **no migration at all**.

Reasoning, in the order that matters:

- **Option 3 fails on arithmetic.** It reclaims 0.2 % of bytes. It also *cannot work as intended*
  today: since all 2 104 side `[timing]` rows have a legacy twin, deleting side rows does not shrink
  the merged History at all until the legacy column is dropped — and that drop is operator-only
  maintenance.
- **Option 3 additionally moves a number an operator reads.** Because both authors *recompute*
  (see § What eviction costs), the raw lines still determine `timedExecutionMs` on every write.
  Making them truly droppable means first deciding the accumulate-vs-recompute question the opposite
  way, and that decision is **contradicted by `replaceTaskLogEntries`' documented "this is the
  History now" contract** (`task-log-entries.ts:520`). We decided retained-History semantics; option
  3 requires the other answer, so option 3 is closed by this record's own decision one.
- **Option 2 has no evidence behind it.** Its premise is that parsing prose out of the record is
  unreliable. Measured: 0 of 2 104 entries are missed and 0 are ambiguous. It would also freeze a
  convention that is still healthy — the reason the parse is exact is that all twelve writers follow
  one phrasing rule, and a typed column does not enforce that rule on the *prose* the panel still
  shows as the label.
- **The real defect is duplication, not storage.** Three independent implementations of one rule
  (leaf, `sse.ts`, `taskTiming.ts`) is how a figure gets to disagree with itself; `sse.ts:276`'s
  comment already records that it duplicates the REST path to avoid a flicker. Converging on the
  leaf is a refactor with no migration, no backfill, and no schema risk.

**Falsifier — the condition under which this recommendation flips.** Reopen question two if a future
census finds either (a) the share of `[timing]` entries with **zero or more-than-one** `ms` token
exceeds **1 %** (measured **0.0 %** of 2 104), which means writers have started phrasing multiple or
no durations per sentence and the first-match rule is now attributing wrong numbers; or (b) the
`[timing]` **byte share exceeds 5 %** (measured **0.2 %**), which would make keeping them a storage
question after all. Condition (a) is the one to watch: it is cheap for a new writer to violate by
embedding an external tool's output, which already quotes durations, into a `[timing]` line.

## Boundaries — what this record does not govern

- **Not where History lives or how the two views merge.** Locked by RUFU-312;
  `docs/storage.md` → "Task History beside the task row" owns the storage shape, the backfill and
  catch-up, the read-shape benchmark, and the operator-only maintenance list. Linked, not restated.
- **Not the read-path projection design.** `task-log-projections.ts` and RUFU-615's landed artifacts
  own `deriveTaskLogProjections`, `withTaskLogProjections`, and the envelope caps
  (`LOG_RECENT_MATCH_ARRAY_CAP = 16`, `LOG_RECENT_INLINE_BYTE_BUDGET = 2_040`). Those caps bound a
  **column**, their overflow semantics are theirs, and this policy does not reach them — but note
  the interaction it must not break: a trim changes the merged view the envelope is derived over.
- **Not the read shapes.** `docs/solutions/performance/list-tasks-derive-optout-and-memo.md` owns
  `excludeLog` / `slim` / `derive`. Relevant because the board lane excludes `log` while
  `readLiveTaskRows` still selects it for `hasAutoHealableVerificationBufferFailure`, which
  pattern-matches log **content** no bounded envelope carries — so that lane keeps seeing History an
  eviction policy shortens. That is a consumer of this policy, not a subject of it.
- **Not the dashboard heap.** `docs/solutions/performance/dashboard-heap-growth-runbook.md` and the
  in-process retention census own in-process caches.
- **Not the engine's diagnostic repetition problem.** RUFU-643's `logEntryOnce` / `dedupeKey` seam
  (`util/durable-diagnostic-log.ts`) is the owner of chatty writers, and it is the *right* owner.
  This policy bounds what survives, not what may be written.
- **No lifecycle, lane, or move semantics.** No card changes column, status, or pause state because
  of a retention decision, and nothing here may schedule the legacy-column drop, `VACUUM FULL`, or
  `pg_repack`.
- **Marker scanners that read *old* entries** (a window is not a scan): `self-healing.ts`,
  `healing/stale-task-reporter.ts`, `notification/notification-service.ts`, `triage.ts`,
  `executor/pending-review-block.ts`, `merge/merger-ai.ts`, `agents/agent-reflection.ts`,
  `eval/evaluator-evidence.ts`, `surfacing-sweeps.ts`, `project-engine.ts`,
  `workflows/workflow-graph-executor.ts`. A tightened bound shortens what they can see; that is the
  follow-up's blast radius to re-check, not a subject decided here.

## Appendix — reproduce the census

The verbatim SQL is the `census` task document on card RUFU-633 (saved alongside `premise-check`,
the claim-by-claim verdict table with `file:line` citations, and `adr`, this record). Session
discipline for anyone re-running it: `BEGIN READ ONLY; ... ROLLBACK;`, `SELECT` only, no `ANALYZE`,
never a vitest / `.pg.test.ts` lane against the reference cluster, and measure the side table before
the legacy column because any per-row touch of `log` decompresses the whole value.
