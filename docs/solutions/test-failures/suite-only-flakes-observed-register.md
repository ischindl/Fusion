---
category: test-failures
module: testing
date: 2026-08-01
problem_type: suite_only_flake
component: PostgreSQL test infrastructure
severity: medium
applies_when:
  - "A test fails under full-suite parallelism but passes when run alone"
  - "A first flake sighting is in a file whose remaining coverage is substantial"
  - "Capturing evidence before a file-level quarantine decision"
  - "A merge-gate canary is evicted from the blocking gate after a flake sighting"
tags:
  - flake
  - postgres
  - full-suite
  - quarantine
---

# Observed suite-only flakes register

This register has **4 active observation records** (entries 1, 2, 13, and 14): **2 active first sightings**, **1 reproduced-but-unattributed observation**, and **1 quarantined second sighting**. Entries 7 and 15 are closed and retained for cross-reference only. It also has **1 merge-gate eviction record** (entry 6) and **8 archived closed records**. Only the active section drives quarantine and escalation decisions; the other sections preserve historical evidence.

<!--
FNXC:TestFlakeRegister 2026-08-19-11:14:
The flat register mixed closed narratives with open records, making it unusable as a quarantine-on-sight decision aid. Sections make the active decision surface explicit while entry numbers and heading text remain frozen for inbound anchors and cross-reference stability. Active status lines must distinguish first sightings from reproduced escalations and name the evidence owners retained by each record.
-->

<!--
FNXC:TestFlakeRegister 2026-09-03-22:23:
FN-9146 (the named evidence owner of active records 1 and 2 and the retained-evidence owner for
entries 1, 2, and 13) was archived on 2026-09-03 without a named successor. A register that names
an archived owner as live lies about ownership — the exact failure FN-9146 was created to fix — so
the status lines and the common-shape summary now record the archived-owner fact and the unowned
pending-next-sighting state. The pinned validator assertions in
scripts/__tests__/observed-flake-register.test.mjs were updated in the same change.
-->

## Active observation records

### 1. Project identity returns no stored identity

- **Status:** Active reproduced-but-unattributed observation — evidence owner FN-9146 (archived 2026-09-03; record unowned pending next sighting).

- **File:** `packages/core/src/__tests__/postgres/project-identity.test.ts`
- **Exact test:** `project-identity async (PostgreSQL integration) > returns null when no identity is stored`
- **Observed tree/SHA:** `origin/main` at `7927c7b58a`
- **Observed frequency:** 1-in-3 full-core-suite runs.

| run | result |
|---|---|
| full core suite (1st) | **1 failed** / 4824 passed |
| full core suite (2nd) | 4825 passed |
| full core suite (3rd) | 4825 passed |
| file alone ×2 | 6 passed, 6 passed |

**Evidence gathering pending 2026-08-16 (FN-9125):** Current-sha diagnosis did not reproduce this historical first sighting: three six-worker full-core lanes and a twelve-worker PostgreSQL-directory run retained full output without this subject failing. The harness uses a shared golden template plus per-module copies, but no direct evidence tied this identity's null read to shared state. This is not superseded or resolved: the required complete loaded failure capture is absent. Core PostgreSQL quarantine is policy-forbidden, so FN-9126 owns CI/host-specific activity instrumentation, full failure capture, and the escalation decision.

| verification | result |
|---|---|
| full core ×3, 6 workers | subject passed; unrelated settings-revision-attribution failure |
| PostgreSQL directory, 12 workers | subject passed; unrelated satellite-store ordering failure |

**Second sighting — reproduced 2026-08-16 (FN-9126):** A credential-free, sterile-environment PostgreSQL-directory pass at 27 workers reproduced the registered assertion as a timeout at `packages/core/src/__tests__/postgres/project-identity.test.ts:41:3` on `3c235ce275b626a73da4fe508ac76fd6f5fbd686`. The typed, executor-authored per-run evidence is durable in task FN-9126, document key `evidence`; it records the 100-connection server ceiling and all run counters without retaining runner output. This is an escalation, not a resolution: core-config quarantine remains policy-forbidden by the gate-policy assertion, so FN-9131 owns root-cause diagnosis and a structural fix.

| run | result |
|---|---|
| PostgreSQL directory, 27 workers (run 1) | subject passed; 173 files; 1335 passed / 31 failed / 4 skipped |
| PostgreSQL directory, 27 workers (run 2) | **subject timeout reproduced**; 173 files; 942 passed / 46 failed / 382 skipped |

<!--
FNXC:PostgresFlakeDiagnosis 2026-08-19-12:25:
FN-9146 requires every active core PostgreSQL record to retain its own complete campaign verdict. Each per-run row carries the lane shape, selected subject result, wall-clock, whole-lane outcome, and measured cluster capacity so later sightings cannot collapse evidence from a different identity or mistake an unsampled run for pressure evidence.
-->

**Campaign outcome 2026-08-19 (FN-9146):** The pre-registered A×4/B×3/C×3/D×2 campaign completed at `ed2cbd08a13f02f1fa5e19d5072c471bb972a315` on PostgreSQL 15.15. The exact null-read identity timed out at its inherited 15s budget in A02–A04. Snapshots peaked at 73, 62, and 71 backends, below the 97 ordinary slots, and showed concurrent DDL/checkpoint/object-lock/WAL waits. Those records do not name a causal lifecycle seam: connection exhaustion, template ownership, drop contention, and the deliberately-unwired budget primitive remain unproven. Entry 1 stays active and reproduced-but-unattributed under FN-9146; no structural change, timeout/retry, or core-PG quarantine was made. Complete combined output and teardown JSONL for A01–D02 are durable FN-9146 task attachments, with parsed checkpoints in its task documents.

**Capacity-evidence remediation 2026-08-19 (FN-9146):** C01–C03's original green default-core logs had no activity snapshot, so they cannot substantiate a peak. One sampled replacement per affected shape (C01R–C03R) completed green with an external 250ms `pg_stat_activity` count sampler: 28/31/30 observed backends across 583/491/508 samples. The table labels retain the pre-registered C identities and disclose their sampled replacements; these are new measurements, not retroactive values for the original C logs. Each replacement retained full runner output, teardown JSONL, and sampler output in FN-9146's durable evidence checkpoint; after C03R, the dead-owner golden template was dropped and the leftover count returned to zero.

| run | shape / workers | wall | subject result | whole-lane result | cluster capacity (`max`/ordinary; peak) |
|---|---|---:|---|---|---|
| A01 | directory / 27 | 235.8s | pass | 25 files / 45 tests red | 100/97; 73 |
| A02 | directory / 27 | 220.2s | **captured: 15s timeout** | 60 files / 42 tests red | 100/97; 73 |
| A03 | directory / 27 | 205.5s | **captured: 15s timeout** | 35 files / 31 tests red | 100/97; 62 |
| A04 | directory / 27 | 224.2s | **captured: 15s timeout** | 36 files / 39 tests red | 100/97; 71 |
| B01 | directory / 12 | 110.8s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 26 |
| B02 | directory / 12 | 119.2s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 36 |
| B03 | directory / 12 | 121.1s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 28 |
| C01 / C01R | core default | 163.5s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 28 (583 samples) |
| C02 / C02R | core default | 136.6s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 31 (491 samples) |
| C03 / C03R | core default | 141.1s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 30 (508 samples) |
| D01 | configured pg gate / 4 forks | 3.6s | not selected | green, 2 files / 10 pass | 100/97; not sampled |
| D02 | configured pg gate / 4 forks | 3.7s | not selected | green, 2 files / 10 pass | 100/97; not sampled |

### 2. Schema applier retains registered dependents

- **Status:** Active first sighting — evidence owner FN-9146 (archived 2026-09-03; record unowned pending next sighting).

The FN-9128 harness-isolation fix does not close this record because no reproduced failure explained the original assertion mechanism.

- **Owner:** FN-9128 (archived); FN-9146 (archived 2026-09-03) retains the campaign evidence; record unowned pending next sighting.
- **File:** `packages/core/src/__tests__/postgres/schema-applier.test.ts`
- **Exact test:** `schema-applier: VAL-SCHEMA-001 final-schema parity (table counts) > retains unreplaced registered dependents for every delete action`
- **Original observed tree:** PR [#2828](https://github.com/Runfusion/Fusion/pull/2828) merged-with-main.
- **Investigation tree/SHA:** `7380be699cfeb37f4fe706455cb07ef274d6cf31`.

The original failure block was not retained, so its mode cannot be reconstructed. FN-9128 ran the requested full-output campaign and **did not reproduce the registered test**: isolated control passed (45.6s); loaded core at default 6 workers (134.2s), 4 workers (159.0s), 8 workers (128.8s), and 12 workers (146.3s), plus a sampled 12-worker run (155.0s), all passed the schema-applier file and registered identity. The loaded runs retained unrelated settings-attribution failures at every fan-out; the 12-worker unsampled run also retained two unrelated command-center-activity failures. Those failures are not attributed to this entry.

DDL microbenchmarks of the pre-fix pristine shape measured `CREATE DATABASE` 44.5–106.9ms, pool connect 7.7–13.9ms, `applySchemaBaseline` 372.4–388.2ms, and forced drop 42.8–310.1ms. The registered four-action loop consequently pays about 1.5s of baseline DDL before its body. A 500ms all-database `pg_stat_activity` sample during the 12-worker run observed database-wide `DataFileWrite`, checkpoint, WAL, catalog-object, and advisory-lock waits; it did not establish a registered-test causal failure.

**Resolved 2026-08-16 (FN-9128):** The absence of a reproduced failure is recorded honestly, but measured repeated DDL and the bypassed shared lifecycle justified a structural isolation fix. The subject now uses `pg-test-harness`: first-apply and upgrade contracts use `createEmptyPgTestDatabase`, while schema-present parity and FN-8419 rekey contracts (including the registered four-action loop) use serialized `createBaselinedPgTestDatabase` clones, making their later apply a marker check instead of repeated DDL. Regression coverage proves both fixture states and that the registered path selects the baselined helper. No timeout, retry, assertion/title, skip, or quarantine change was made.

| run | result |
|---|---|
| full core suite on #2828 merged-with-main | **failed** (failure block unavailable) |
| file alone ×2 on the same tree | 75 passed, 75 passed |
| file alone on `origin/main` | passed |
| FN-9128 isolated + loaded campaign | registered test passed in every listed shape |

**Evidence gathering pending 2026-08-16 (FN-9125):** Current-sha loaded reproduction did not fail this assertion. This file still owns an inline unique `CREATE DATABASE` plus full baseline path rather than the shared template harness, but that is a distinct cost profile, not evidence that it caused the historical dependent-registration failure. This is not superseded or resolved: the required complete loaded failure capture is absent. FN-9128 exclusively owns entry 2's CI allocation/profile investigation and full failure capture; core PostgreSQL quarantine is policy-forbidden.

| verification | result |
|---|---|
| full core ×3, 6 workers | subject passed; unrelated settings-revision-attribution failure |
| PostgreSQL directory, 12 workers | subject passed; unrelated satellite-store ordering failure |

**Campaign outcome 2026-08-19 (FN-9146):** The exact registered dependents identity passed every subject-containing lane (A×4/B×3/C×3); D01–D02 do not select this file. The historical mode remains unattributed. Entry 2 stays active under FN-9146; the next sighting follows normal escalation and core PostgreSQL quarantine remains policy-forbidden. Complete combined output and teardown JSONL for A01–D02 are durable FN-9146 task attachments, with parsed checkpoints in its task documents.

**Capacity-evidence remediation 2026-08-19 (FN-9146):** C01–C03's original green default-core logs had no activity snapshot, so they cannot substantiate a peak. One sampled replacement per affected shape (C01R–C03R) completed green with an external 250ms `pg_stat_activity` count sampler: 28/31/30 observed backends across 583/491/508 samples. The table labels retain the pre-registered C identities and disclose their sampled replacements; these are new measurements, not retroactive values for the original C logs. Each replacement retained full runner output, teardown JSONL, and sampler output in FN-9146's durable evidence checkpoint; after C03R, the dead-owner golden template was dropped and the leftover count returned to zero.

| run | shape / workers | wall | subject result | whole-lane result | cluster capacity (`max`/ordinary; peak) |
|---|---|---:|---|---|---|
| A01 | directory / 27 | 235.8s | pass | 25 files / 45 tests red | 100/97; 73 |
| A02 | directory / 27 | 220.2s | pass | 60 files / 42 tests red | 100/97; 73 |
| A03 | directory / 27 | 205.5s | pass | 35 files / 31 tests red | 100/97; 62 |
| A04 | directory / 27 | 224.2s | pass | 36 files / 39 tests red | 100/97; 71 |
| B01 | directory / 12 | 110.8s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 26 |
| B02 | directory / 12 | 119.2s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 36 |
| B03 | directory / 12 | 121.1s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 28 |
| C01 / C01R | core default | 163.5s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 28 (583 samples) |
| C02 / C02R | core default | 136.6s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 31 (491 samples) |
| C03 / C03R | core default | 141.1s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 30 (508 samples) |
| D01 | configured pg gate / 4 forks | 3.6s | not selected | green, 2 files / 10 pass | 100/97; not sampled |
| D02 | configured pg gate / 4 forks | 3.7s | not selected | green, 2 files / 10 pass | 100/97; not sampled |

### 7. Mission store PostgreSQL teardown hook

- **Status:** Closed 2026-08-23 — file-level quarantine (second sighting of a different test in the same file); quarantine RESCUED and lifted 2026-09-02 by `9b29c6beab` (PR #3549); RETIRED 2026-09-06 by `82c635384d` (deletion ratchet — file, ledger row, and the core exclude key removed together, so vitest defaults apply). Measured conflict left for follow-up: the 2026-09-02 lift deleted the ledger row, no non-merge commit in `9b29c6beab..82c635384d^` re-added it, yet the row was present at `82c635384d^` — a merge reintroduced it, so the ratchet fired against a quarantine this record already recorded as rescued. The file is gone for good as far as this record is concerned; the retirement is not evidence that the rescue was wrong.

- **File:** `packages/core/src/__tests__/postgres/mission-store.pg.test.ts`
- **Exact test:** `MissionStore (PostgreSQL backend mode)` suite `afterAll` hook (`h.afterAll`).
- **Observed tree/SHA:** `32f677bbc207e421fd260ae2ba22fcefeeef4d86` (FN-8979 worktree).
- **Observed frequency:** first observation in a direct targeted rerun; 61 tests in the file passed.

| run | result |
|---|---|
| targeted file with `--silent=passed-only` | passed (exit 0) |
| targeted file with dot reporter | **afterAll hook timed out** at 15s; 61 tests passed |

The timeout occurred after all test assertions and is unrelated to FN-8979's canonical mission-blocker contract. This file retains substantial coverage, so this first observation is recorded rather than quarantined. A second sighting requires the normal file-level quarantine decision.

**Evidence gathering pending 2026-08-17 (FN-9136):** The shared-harness teardown is serial (store, layer, admin client, `DROP DATABASE WITH (FORCE)`, temporary directory), so a loaded close/drop block remains a plausible historical mechanism. FN-9136's seven-pair per-fork `TRUNCATE` reuse campaign was rejected because its experimental fork cleanup leaked dead-owner databases; that rejection preserves isolation but does not resolve this original loaded timing symptom. FN-9127 retains CI/host-specific phase instrumentation and full failure capture ownership; core PostgreSQL quarantine is policy-forbidden.

| verification | result |
|---|---|
| targeted dot reporter ×3 | 61 tests passed; afterAll passed |
| full core ×3, 6 workers | subject passed; unrelated settings-revision-attribution failure |

**Instrumented outcome 2026-08-16 (FN-9127): entry 7 remains unreproduced and is now self-diagnosing.** The default-off teardown recorder was measured on `beb8ae67dba1ed122cab94a4641e875ccebd21f1` against PostgreSQL 15.15 (`max_connections=100`, 97 ordinary slots). It writes synchronous JSONL records and its in-flight phase/teardown watchdogs fire before the inherited 15s hook is aborted, so a phase that never settles still leaves timing plus `pg_stat_activity` evidence. The durable campaign tables and full snapshot rows are retained in task document `FN-9127/evidence`; `/tmp/fn-9127-*.log` and `/tmp/fn-9127-diag-*.jsonl` are scratch copies only.

| instrumented shape | result | measured worst phase | watchdog / snapshot |
|---|---|---:|---|
| subject dot ×3 | all passed | `dropDatabase` 154ms | no / none |
| full core, 4 workers | unrelated settings attribution failure | 1,439ms globally | no / none |
| full core, 6 workers | unrelated settings attribution failure | 1,576ms globally | no / none |
| full core, 8 workers | unrelated settings attribution failure | 1,905ms globally | no / none |
| full core, 12 workers | unrelated settings attribution + schema-applier timeout | `dropDatabase` 3,582ms globally | 30 / 30 |

The 12-worker snapshots show 21 backends and concurrent template `CREATE DATABASE`/`DROP DATABASE WITH (FORCE)` work, including `IPC/CheckpointDone` and `IPC/ProcSignalBarrier`; they do not implicate this mission-store suite. FN-9130 measured advisory admission as a non-remedy: uniform pooling regressed to 49 watchdogs / 5,068ms and drop-only wiring to 27 / 3,361ms against the 4–5 / 3,284ms baseline. A bounded deferred-drop reaper also failed the end-to-end criterion: watchdogs became zero by construction, but two green runs took 117.2s and 122.4s versus the 108.1s baseline maximum, and a later run timed out in unrelated loaded setup. The reaper was reverted. FN-9136 then rejected candidate C after its golden-template gate passed: the required seven-pair 12-worker campaign left pooled `fusion_pool_*` databases owned by dead fork PIDs because the experiment lacked an awaited fork-exit flush and direct imports degraded to the shared `local` identity. The isolation failure required removing all harness wiring regardless of wall time. FN-9134 supplied a pre-registered report-only lane metric and completed its required seven-pair alternating control/candidate campaign at 12 workers. The control/candidate medians were 137.81s/146.91s, candidate pairs 02–06 were red, and every sample observed 32 or 33 surviving `fusion_test_%` databases (pair 04 increased 32 to 33). The tool's `no-improvement` verdict and the automatic non-zero-leak rejection removed the prototype and all of its wiring/tests together. The full per-run JSONL/log evidence is retained in task document `FN-9134/evidence`; this remains unresolved rather than becoming a quarantine or timeout change. No teardown behavior was changed: there is no evidence-backed cause for this entry's historical 15s afterAll abort. This first-sighting record remains retained; a second sighting follows the normal escalation. Core PostgreSQL files cannot be quarantined inline because the gate-policy assertion requires `quarantinedCoreTests` to remain empty; that is an owner-escalated decision.

**Campaign outcome 2026-08-19 (FN-9146):** The registered `afterAll(h.afterAll)` hook did not fail in every lane that selected this file. A02 instead timed out in `beforeAll(h.beforeAll)`, so its registered `afterAll` did not run and is recorded as not reached rather than passed; it is explicitly not entry-7 evidence. D01–D02 do not select the file. The historical afterAll mode remains unattributed. Entry 7 was subsequently closed on 2026-08-23 when the entire file was quarantined on a second sighting of a different test; see the note at the end of this entry. Complete combined output and teardown JSONL for A01–D02 are durable FN-9146 task attachments, with parsed checkpoints in its task documents.

**Capacity-evidence remediation 2026-08-19 (FN-9146):** C01–C03's original green default-core logs had no activity snapshot, so they cannot substantiate a peak. One sampled replacement per affected shape (C01R–C03R) completed green with an external 250ms `pg_stat_activity` count sampler: 28/31/30 observed backends across 583/491/508 samples. The table labels retain the pre-registered C identities and disclose their sampled replacements; these are new measurements, not retroactive values for the original C logs. Each replacement retained full runner output, teardown JSONL, and sampler output in FN-9146's durable evidence checkpoint; after C03R, the dead-owner golden template was dropped and the leftover count returned to zero.

| run | shape / workers | wall | subject result | whole-lane result | cluster capacity (`max`/ordinary; peak) |
|---|---|---:|---|---|---|
| A01 | directory / 27 | 235.8s | pass | 25 files / 45 tests red | 100/97; 73 |
| A02 | directory / 27 | 220.2s | not reached: `beforeAll` timeout (not registered `afterAll`) | 60 files / 42 tests red | 100/97; 73 |
| A03 | directory / 27 | 205.5s | pass | 35 files / 31 tests red | 100/97; 62 |
| A04 | directory / 27 | 224.2s | pass | 36 files / 39 tests red | 100/97; 71 |
| B01 | directory / 12 | 110.8s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 26 |
| B02 | directory / 12 | 119.2s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 36 |
| B03 | directory / 12 | 121.1s | pass | green, 176 files / 1385 pass / 1 skip | 100/97; 28 |
| C01 / C01R | core default | 163.5s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 28 (583 samples) |
| C02 / C02R | core default | 136.6s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 31 (491 samples) |
| C03 / C03R | core default | 141.1s | pass | green, 580 files / 5686 pass / 3 skip | 100/97; 30 (508 samples) |
| D01 | configured pg gate / 4 forks | 3.6s | not selected | green, 2 files / 10 pass | 100/97; not sampled |
| D02 | configured pg gate / 4 forks | 3.7s | not selected | green, 2 files / 10 pass | 100/97; not sampled |

**Closed 2026-08-23.** This observation is no longer active: the entire file was quarantined on 2026-08-23 because a different test in it (`serializes concurrent claims on the same task (Greptile P1 race)`) received a second loaded-lane sighting. See `scripts/lib/test-quarantine.json` for the ledger reason.

**Rescued 2026-09-02 (`9b29c6beab`, PR #3549).** The quarantine was lifted before the 2026-09-06 deletion deadline as a genuine rescue, not appeasement: the race test's 250ms wall-clock sleep was replaced with a deterministic `pg_blocking_pids()` blocking-graph probe over `pg_stat_activity` (the lock-wait rescue path the ledger reason named), and the file's ledger entry plus the `packages/core/vitest.config.ts` exclude were removed in the same commit. The file is live in the suite again; the deletion deadline above is moot. Note the commit message does not mention the rescue — the evidence is in the test-file diff.


### 13. Handoff-to-review atomicity PostgreSQL setup hook

- **Status:** Active first sighting — recorded 2026-08-23, unattributed.

- **File:** `packages/core/src/__tests__/postgres/handoff-to-review-atomicity.pg.test.ts`
- **Exact test:** `handoff-to-review transactional invariant (PostgreSQL)` suite `beforeAll(h.beforeAll)` setup hook (line 35).
- **Observed tree/SHA:** `39812f4898` (observed locally as `82c37ee3fd`, the same tree before an upstream rewrite) with uncommitted `packages/engine/src/executor/{execute-core,execute-workflow-graph}.ts` changes plus one new engine test. Those changes are engine-only; the subject is a core PostgreSQL file and imports nothing from them.
- **Observed frequency:** 1 sighting, on the FIRST `pnpm test:gate` invocation of the session; not reproduced in 8 subsequent runs across three shapes.

| run | shape | result |
|---|---|---|
| gate (1st of session) | `pnpm test:gate` | **`beforeAll` hook timed out** at the inherited 15s budget; 6 passed / 4 skipped in the lane |
| gate ×2 | `pnpm test:gate` | green, 715 tests each (4 lanes: 200 / 433 / 10 / 72) |
| pg-gate ×3 | `pnpm --filter @fusion/core run test:pg-gate` | 2 files / 10 tests passed each run |
| isolated ×3 | target file alone, `vitest.pg.config.ts` | 1 file / 4 tests passed each run |

**Evidence gap disclosed:** the original failing run's output was piped through `tail`, so only the summary and the `FAIL` identity lines survive; the full runner output was not retained. The identity is unambiguous (file, suite, `beforeAll` hook, 15s budget, `:35:3`), but this record cannot supply a full log for the failing run. The eight verification runs above were captured in full.

This is the same mode already characterized by entry 6 and by entry 7's A02 lane: a 15s `beforeAll` abort on the DDL-heavy per-file schema-template setup that the one shared Postgres serializes. Two properties make this sighting narrower than the shapes those entries measured. It occurred under the CAPPED gate lane — `PG_MAX_WORKERS = 4` and only two selected files — which `FNXC:PgTestWorkerCap 2026-07-18-18:00` established as the DB-safe ceiling (measured: 6 forks all time out, 4 forks pass in ~42s). And it occurred on the first gate invocation after the cluster had been idle, with every later run in the same shell green, which points at cold-cluster startup cost landing inside the first file's setup budget rather than at fork oversubscription. That correlation is a HYPOTHESIS, not a measurement: reproducing it means stopping the embedded cluster, which was not done because this host also runs a live Fusion instance.

Quarantine was not available as an alternative. Core PostgreSQL files cannot be quarantined inline — the gate-policy assertion requires `quarantinedCoreTests` to remain empty — and a merge-gate eviction of a transactional-invariant file is the owner-escalated decision described in the policy section below. The file carries only 4 tests, which is thin against the usual first-sighting coverage argument, but they are the atomicity invariant for handoff-to-review and one of just two files in the blocking PG lane; recording preserves that rather than trading it away over a single unreproduced cold-start abort. A **second sighting** follows normal escalation.


### 14. Merge-node paused-abort retry sequence

- **Status:** Quarantined 2026-08-29 after a second sequence-only sighting — rescue owner FN-9283 (mission M-MTU4YAJI-0001-PAJK), deletion-ratchet deadline 2026-09-12 (quarantinedAt + 14d).
- **File:** `packages/engine/src/__tests__/reliability-interactions/merge-node-paused-abort-retryable.test.ts`
- **Exact test:** `merge-node paused-abort retry classification (FN-6735) > re-enqueues benign paused merge graph failure at node %s without operator-action failure` (parameterized `it.each`; the observed case was `%s` = `merge`, plus 12 sibling sequence failures).
- **Observed tree/SHA:** first sighting `f3e1e7d1f`; second sighting during FN-249 verification after `2ab621ac6`.
- **Observed frequency:** Two file-sequence failures; the selected exact subject passed in isolation after each.

| run | result |
|---|---|
| first file as `engine-reliability` | **13 failed / 44 passed**; paused-abort retry and implementation-incomplete sibling assertions missed their expected recovery writes |
| first selected exact subject alone | passed (exit 0) |
| second file as `engine-reliability` | **13 failed / 44 passed** with the same recovery-write misses |
| second selected exact subject alone | passed (exit 0) |

The failure remains sequence-only evidence, not an attribution to FN-249: its changed user-cancellation path is not enabled by this fixture, and the selected pre-existing engine-abort subject passes in isolation. Per the mandatory deletion ratchet, the second sighting is quarantined in `scripts/lib/test-quarantine.json` and the matching `engine-reliability` exclude; no timeout, retry, or assertion was changed. Rescue requires a root-cause fix that proves the file's recovery coverage is stable.


### 15. Notification-service whole-file invocation memory exhaustion

- **Status:** Closed 2026-09-04 by the RUFU-186 fix-landed close (AGENTS.md record-authority; see Closure below). The whole-file invocation is safe — the suite is network-dead with a permanent connect-tripwire guard; no quarantine was ever created and none is owed.
- **File:** `packages/engine/src/notification/__tests__/notification-service.test.ts`
- **Exact identity:** a whole-file invocation pathology — `vitest run src/notification/__tests__/notification-service.test.ts` with no `-t` filter, i.e. the three describes `NotificationService deferred failure notifications`, `NotificationService manual dispatch dedupe`, and `NotificationService workflow transition notifications` in one file run. Not a single-case flake, but deterministic: every whole-file run dies at the START of describe 3's `NotificationService workflow transition notifications > does not add a manual-hold workflow notification when the failed status already represents the task update`. Count correction: the file collects **31 cases** (20 / 2 / 9); the "77 `it(` cases" figure circulating from the RUFU-180 evidence trail is a substring-grep artifact (`it(` also matches `emit(` etc.).
- **Observed tree/SHA:** `8803ecff6a` (RUFU-181 branch tip); base repro `dfc1f5ff05` with the three production files checked out to base dies identically; RUFU-180 observations on `fusion/rufu-180`.
- **Observed frequency:** 13 review-lane OOM-killed verification dispatches on 2026-09-03 01:33Z–19:27Z (RUFU-180), plus this card's three whole-file repros and one `-t`-filtered repro — all deterministic kills, no green whole-file run observed at any tree tried.

| run | result |
|---|---|
| per-describe `-t` (all three commands below) | **green** — 20 / 2 / 9 passing, each in seconds |
| whole file, unbounded | kernel journal `Out of memory: Killed process … (node-MainThread) … anon-rss:62094756kB` (RUFU-180); RUFU-181 diagnostic-run orphans killed at `anon-rss:68476596kB`, `64535016kB`, `63674596kB`, `68467460kB` |
| whole file, bounded (`systemd-run --user --scope -p MemoryMax=6G -p MemorySwapMax=0` + `NODE_OPTIONS=--max-old-space-size=4096`, wall bound 600 s) | `Memory cgroup out of memory: Killed process … anon-rss:6177920kB` ~17 s in; a 1 Hz RSS probe shows a flat ~553 MB plateau through every preceding test, then the probe never ticks again after the death case STARTS — event-loop starvation with ~350 MB/s growth |
| `-t` filtered describe 2 → describe 3 only | **reproduces** the same cgroup kill at the same case |
| `-t` filtered describe 1 + 3, describe 1 + 2, each describe alone, describe 2 + death case alone | green |

**[Superseded 2026-09-04 — the root cause WAS named and fixed by RUFU-186; see Closure below. The text below is preserved as the pre-fix record.]**

Localized, root cause NOT named. The wedge re-arm floor (`armPendingWedgeTimer`'s `Math.max(1, min(delayMs, wedgeNotificationSettleMs))` on `held`/`rearmed`) is exonerated at describe 3's default `wedgeNotificationSettleMs = 300_000`, and a small-heap-capped run GC-thrashes rather than producing a V8 heap OOM — the runaway allocation is transient garbage too fast for the event loop to service timers, not a single big object. The ordering dependency is real and currently irreducible below "describe 2 runs before describe 3": D1+D3 is green even though it contains every test D2+D3 runs inside describe 3, and D2 + the death case alone is green. A small-heap `--cpu-prof` capture showed only the launcher's module-load profile (test workers never flushed), so no allocation-site evidence exists yet.

**Second-sighting escalation:** a second sighting moves this to `scripts/lib/test-quarantine.json` + the one-line `"src/notification/__tests__/notification-service.test.ts"` exclude in the `engine-default` project of `packages/engine/vitest.config.ts` in one lockstep commit (AGENTS.md, no discretion). Note quarantine also removes the `-t` workaround below (no CLI flag lifts a configured exclude), which is why recording is the first-sighting path.

**Interim remedy — the review lane must use these bounded commands** while this is unfixed (each is the review-lane verification for this file's subject and produces a verdict). **[Superseded 2026-09-04:** the whole-file invocation is the normal invocation again; commands retained as the historical remedy.**]**

```
pnpm --filter @fusion/engine exec vitest run src/notification/__tests__/notification-service.test.ts -t "NotificationService deferred failure notifications"
pnpm --filter @fusion/engine exec vitest run src/notification/__tests__/notification-service.test.ts -t "NotificationService manual dispatch dedupe"
pnpm --filter @fusion/engine exec vitest run src/notification/__tests__/notification-service.test.ts -t "NotificationService workflow transition notifications"
```

Never run the whole file unbounded on a shared host. The host-safe bounded repro is: `systemd-run --user --scope -p MemoryMax=6G -p MemorySwapMax=0 --quiet env NODE_OPTIONS=--max-old-space-size=4096 timeout 600 pnpm --filter @fusion/engine exec vitest run src/notification/__tests__/notification-service.test.ts`.

**The `pnpm test` trap:** while unfixed, a card whose diff touches this test file with NO non-test source change in the engine module graph (docs-only, or test-comment-only) does NOT trip the wide-fan-out guard in `scripts/test-changed.mjs` — `changedSourceFilesAffectingPackage` filters every path through `isTestFilePath` — so `pnpm test` runs `vitest run --changed <base>`, collects this file whole-file, and reproduces the kill inside the bounded lane (heap-capped at `ENGINE_SCOPED_AFFECTED_HEAP_MB = 6144`, so it dies as a heap-OOM/red lane, never 62 GB RSS). Substitute: `pnpm test:gate` for cross-cutting coverage plus the three `-t` runs above for subject coverage. `pnpm test` becomes safe again only once this file is fixed or quarantined. The file is NOT in the curated `engine-core` merge-gate allow-list and stays out (gate criteria: fast/deterministic/curated). **[Superseded 2026-09-04:** the fix removes the whole-file hazard, so `pnpm test` is safe again for this file and the substitute guidance no longer applies; the file stays out of the curated gate allow-list.**]**

#### Closure 2026-09-04 (RUFU-186 — fix landed, no quarantine owed)

**Named root cause (supersedes the pre-fix localization above).** The pathology was a test-isolation defect, not in-file state: the harness's in-memory settings default `{ ntfyEnabled: true, ntfyTopic: "topic" }` with no `ntfyBaseUrl`, so `NotificationService` constructs a real production `NtfyNotificationProvider` whose base URL defaults to `https://ntfy.sh`. The file never stubbed `fetch`, so dispatches performed real HTTPS requests from the vitest worker; on Node 26.7.0 undici's fetch negotiates HTTP/2 over TLS, and Node's native `Http2Session::SendPendingData → CopyDataIntoOutgoing` enters a geometric-doubling `operator new[]` loop (interposer capture: 51.5 GB requested across 35 events ≥ 4 MB), ~350 MB/s RSS growth, event-loop starvation (the 1 Hz probe stops ticking), kernel/cgroup kill. Attribution evidence: task documents `allocation-site-evidence(-2)` (native site) and `g18-js-caller-attribution` (JS caller; the earlier AWS-SDK/`NodeHttp2Handler` hypothesis was falsified by direct stack evidence — the h2 client is Node's own fetch). The "describe 2 before describe 3" ordering trigger was reinterpreted: what accumulates across describes is the real-egress attempt count, not cross-describe residue (E1–E4 eliminations confirmed; no product-code defect — CI had meanwhile been receiving real pushes to a public topic named `topic`, which the fix also eliminates).

**Fix (commit `66f3c00af`, test-only).** `packages/engine/src/notification/__tests__/notification-service.test.ts` is now network-dead: `vi.stubGlobal("fetch", recordingFetch)` (sibling convention: `chat-recall-provisioner.test.ts`, `__tests__/mock-provider.test.ts`) plus a case asserting the real dispatch path reaches `https://ntfy.sh/topic` through the fake (a stronger assertion than the old accidental live call). Permanent regression guard: a module-top connect tripwire on `node:net`/`tls`/`http2` (via `createRequire`) records and synchronously refuses any non-loopback socket attempt — a refused connect cannot feed the native storm — and `afterAll` fails the run naming every attempt. Guard demonstrated red-before (stub line disabled → tripwire names 13 `tls->ntfy.sh:443` attempts, exit 1 in 7.4 s, bounded, no storm) and green-after.

**Symptom-gate evidence (host-bounded: `systemd-run --user --scope -p MemoryMax=6G -p MemorySwapMax=0` + `NODE_OPTIONS=--max-old-space-size=4096` + `timeout`).** Bounded whole-file runs 32/32 green ×3 consecutively, cgroup peaks 548/557/549 MB (the pre-fix shape climbs ~350 MB/s from the same ~550 MB plateau to a kill at ~15 s; A/B on the identical pair command: unfixed 5,503 MB/6 MB-heap kill vs fixed flat ≤300 MB green in 5.8 s). The three `-t` per-describe commands stay green (20 / 3 / 9); the scoped `src/notification/__tests__` suite is 113/113 green; the file now collects **32** cases (the new guard case joined describe 2). **Lockstep:** register intro 5→4 active, `scripts/__tests__/observed-flake-register.test.mjs` drops entry 15 from its pinned `deepEqual` list in this same commit, `scripts/lib/test-quarantine.json` is untouched (lockstep count 0 → 0) — the fix-landed branch retires the record without the quarantine that a second sighting would otherwise have forced. Profiling method and the safe bounded-run recipe are durable in [`vitest-worker-allocation-storm-profiling.md`](vitest-worker-allocation-storm-profiling.md).

### Common shape and investigated result

FN-9125 established that former entry 3 was not PostgreSQL-suite-adjacent: `plugin-runner.test.ts` used an in-memory mocked TaskStore and had no PostgreSQL/harness import. FN-9135 did not identify a root cause, but FN-9141's completed shuffled worker-reuse campaign reproduced and structurally fixed the logger mock-history fixture defect; the suite and its renamed-complete-lane dispatch coverage remain active. Entries 2 and 13 remain active, unreproduced PostgreSQL observations; entry 7 was closed on 2026-08-23 when the whole file was quarantined on a second sighting of a different test. FN-9146 completed the later A×4/B×3/C×3 campaign without the entry 2 or entry 13 exact identities failing. Entry 1 reproduced under FN-9126 and again under FN-9146's A02–A04 lanes, but remains unattributed rather than structurally fixed. The golden-template/advisory-lock lifecycle and schema-applier's inline baseline path are concrete architecture facts, not a demonstrated cause of these assertions. Core policy forbids inline PG quarantine: FN-9146's retained evidence for entries 1, 2, and 13 is durable, but FN-9146 was archived on 2026-09-03 without a named successor, so those records are presently unowned; the next sighting follows normal escalation from an unowned state. entry 7 was closed on 2026-08-23 (see above). No source or fan-out change is justified before a diagnostic names a causal lifecycle seam. Entry 13 is a further unreproduced instance of that same 15s setup-hook mode, narrowed to the capped four-fork gate lane on a cold cluster. Entry 6 instead records a merge-gate eviction after a loaded-lane setup-hook timeout; `FNXC:PgTestTemplateDb 2026-07-19-17:20` and `FNXC:PgTestWorkerCap 2026-07-18-18:00` are already-landed mitigations for that mode, not new diagnoses to re-open. The Planning Mode entries are separate frontend timing observations.



## Merge-gate eviction records

### 6. Sync workflow IR default canary setup hook

- **Status:** Merge-gate eviction 2026-08-16 by FN-8928.

- **File:** `packages/core/src/__tests__/postgres/sync-workflow-ir-is-always-default.pg.test.ts`
- **Exact test:** `resolveTaskWorkflowIrSync ignores a task's real workflow (PostgreSQL)` suite `beforeAll` setup hook.
- **Observed tree/SHA:** FN-8912 evidence; local confirmation tree `51437558ac352dad3481e0dbe9622fa51af4c599`.
- **Observed frequency:** 1 observed merge-gate sighting in FN-8912; not reproduced locally. This is an **evicted merge-gate canary**, not a first-sighting register exception.

| run | result |
|---|---|
| FN-8912 loaded `pnpm test:gate` | **setup hook timed out** at the inherited 15s budget; direct scoped rerun passed |
| shape A: capped `test:pg-gate` ×5 | 3 files / 13 tests passed each run |
| shape B: isolated target ×3 | 1 file / 3 tests passed each run |
| shape C: uncapped default-config PostgreSQL directory ×5 | 153 files / 1263 passed plus 1 skipped each run |

FN-8928 evicted the file from the blocking gate under the AGENTS.md gate rule; default-core discovery preserves its regression coverage. Shape C was clean, so no quarantine escalation was required. A later non-blocking-core failure is an ordinary on-sight quarantine decision. `FNXC:PgTestTemplateDb 2026-07-19-17:20` (run-shared golden template) and `FNXC:PgTestWorkerCap 2026-07-18-18:00` (four-fork PG-gate cap) are already-landed mitigations for this same 15s setup-hook timeout mode.

## Policy and escalation

Quarantine is file-level, while the first-sighting exception preserves coverage in files retaining 6 / 75 / 80 passing tests. Under that exception, recording preserves valuable coverage. A **second sighting** of a registered test is an on-sight quarantine: add it to `scripts/lib/test-quarantine.json` and the matching Vitest `exclude` in one lockstep commit; this register entry is then evidence for the ledger `reason`.

Merge-gate eviction records follow a separate branch: the gate can no longer be reddened by that file, while the non-blocking suite retains coverage. A further failure there is an ordinary on-sight quarantine. For PostgreSQL files, quarantine is legitimate only once the file is also gone from the blocking `test:pg-gate` script, because a ledger row naming a file the blocking lane still runs is itself a gate-policy violation; that lane decision is what makes it an owner decision escalated as its own task rather than an inline edit. Records dated before 2026-09-08 phrase the same rule as "`quarantinedCoreTests` remains empty" — that named core-config array was removed by the 2026-09-06 deletion ratchet (`82c635384d`), so read those passages as the rule above, not a live identifier.

Capture **full runner output** before recording or quarantining a failure—for example, tee it to a file. Never pipe a dot reporter through `tail`: the summary survives while the `FAIL` identity lines needed for a quarantine entry are exactly what gets truncated.

Source: [Runfusion/Fusion issue #2862](https://github.com/Runfusion/Fusion/issues/2862).



## Archive — closed records

Archived records are historical evidence only and never authorize a quarantine decision.

### 3. Plugin runner complete-lane lifecycle hook

- **Status:** Closed 2026-08-17 by FN-9141 — rescued (fixture defect).

- **File:** `packages/engine/src/__tests__/plugin-runner.test.ts`
- **Historical exact test:** `PluginRunner > task lifecycle hooks > should invoke onTaskCompleted when the complete lane is RENAMED`
- **Observed tree/SHA:** PR [#2799](https://github.com/Runfusion/Fusion/pull/2799) merged-with-main.

| run | result |
|---|---|
| full engine suite on #2799 merged-with-main (1st) | **8 failed** (7 in this file + 1 inherited) |
| full engine suite, same tree (2nd) | 1 failed (the inherited one only) |
| file alone | 80 passed |
| full engine suite on `origin/main` ×2 | clean |

Seven tests failed in `plugin-runner.test.ts`, but only this one identity survived capture: `--reporter=dot | tail -3` truncated the `FAIL` lines and retained only the summary.

**Quarantined 2026-08-16 (FN-9125):** Source inspection proved this unit file uses a local mocked TaskStore and has no PostgreSQL or harness import, so it does not belong to the database cluster. Three current full-engine lanes did not reproduce it, but the historical loaded failure lacks enough identities for a structural repair. The deletion-ratchet ledger and engine-default exclude were added together; assertions and timeouts are unchanged.

| verification | result |
|---|---|
| full engine ×3, 6 threads | subject passed; 35–36 unrelated baseline-red files remained |
| targeted plugin-runner | covered by subsequent quarantine-ledger verification |

**Retained after investigation 2026-08-17 (FN-9135):** FN-9135 temporarily lifted the paired default-lane exclusion and captured full verbose output for two runs each at 2, 6, and 8 workers. The subject passed every run and the 82-test isolated control; the loaded lane's unrelated baseline-red files did not identify a product or harness cause. The fixed microtask flush, duplicate helper, registry singleton, and hook timeout were investigated, but no root-cause defect or qualifying rescue was demonstrated. The test file, ledger row, and default-lane exclusion therefore remain together until the 2026-08-30 ratchet deadline, preserving plugin loading/contribution/runtime/hot-reload coverage and the remaining `onTaskCompleted` lifecycle-dispatch coverage.

| FN-9135 loaded reproduction | subject result | whole-lane result |
|---|---|---|
| 6 workers, run 1 (247.08s) | pass | 40 failed / 794 passed files; unrelated baseline-red |
| 8 workers, run 1 (197.47s) | pass | 40 failed / 794 passed files; unrelated baseline-red |
| 2 workers, run 1 (577.55s) | pass | 39 failed / 795 passed files; unrelated baseline-red |
| 6 workers, run 2 (230.06s) | pass | 39 failed / 795 passed files; unrelated baseline-red |
| 8 workers, run 2 (188.61s) | pass | 39 failed / 795 passed files; unrelated baseline-red |
| 2 workers, run 2 (590.97s) | pass | 39 failed / 795 passed files; unrelated baseline-red |

**Rescued 2026-08-17 (FN-9141):** FN-9141 completed the terminal new-strategy campaign with shuffled files/tests, worker reuse without per-file isolation, and a temporary byte-for-byte repeated subject. The completed two-worker lane reproduced a named test-fixture defect: a neighbouring worker-reused file can call `vi.clearAllMocks()` after `PluginRunner` has initialized, erasing `createLogger.mock.results` before the hot-reload warning assertion reads it. The assertion already catches the real `stopPlugin` rejection/warning contract; the repair keeps its logger instance in a hoisted stable reference and explicitly proves cleanup cannot erase that reference. The ledger row and default-lane exclusion remain removed together. No timeout, retry, assertion weakening, skip, polling, or permanent worker-policy change was used.

| FN-9141 new-strategy reproduction | seed | workers | isolation | duration | subject result | whole-lane result |
|---|---:|---:|---:|---:|---|---|
| shuffled, worker-reuse loaded engine-default | 914141 | 2 | disabled / worker reuse | 900.1s (campaign bound) | 82 passed | terminated before summary; unrelated `project-engine` timeouts after subject completed |
| shuffled, repeated-subject loaded engine-default | 914142 | 8 | enabled; temporary byte-for-byte subject repeat | 222.66s | original 82 passed; repeat 82 passed | complete: 48 failed / 787 passed / 1 skipped files; 117 failed / 11230 passed / 14 skipped / 1 todo tests; no subject failure |
| shuffled, worker-reuse, repeated-subject loaded engine-default | 914143 | 2 | disabled / worker reuse; temporary byte-for-byte subject repeat | 1548.60s | reproduced one hot-reload warning fixture failure; repeat passed | complete: 224 failed / 611 passed / 1 skipped files; 1801 failed / 9534 passed / 26 skipped / 1 todo tests; unrelated loaded failures also present |

The rescue retains plugin loading, contribution accessor, runtime compatibility, hot-reload, and lifecycle-hook assertions, including the renamed-complete-lane `onTaskCompleted` dispatch that would have been uniquely lost under deletion. The direct regression now covers the worker-reused cleanup sequence that caused the reproduced warning assertion failure.

### 4. Planning Mode direct task handoff

- **Status:** Closed 2026-08-10 by FN-8936 — superseded.

- **File:** `packages/dashboard/app/components/__tests__/PlanningModeModal.planning-flow.test.tsx`
- **Exact test:** `PlanningModeModal sequential flow > creates the task directly and offers task and session-list handoffs`
- **Observed tree/SHA:** `4e21f53996` (FN-8757 worktree)
- **Observed frequency:** first observation in the targeted file run.

| run | result |
|---|---|
| targeted file run | **1 failed** / 56 passed; `mockCreateTaskFromPlanning` was not called and jsdom reported unimplemented `window.scrollTo()` |
| isolated exact test | passed |

The failure is unrelated to the mobile question footer: it exercises the completed-plan Proceed handoff, while FN-8757 changes only the active-question footer. The file retains substantial coverage, so this first sighting is recorded rather than quarantined; a second sighting requires the normal file-level quarantine.

**Superseded 2026-08-10 (FN-8936):** The second sighting moved the file to the deletion-ratchet ledger. Investigation classified the direct handoff as a detached test-node hydration race, not a product create-state race; the suite was rescued by settling hydration and re-querying the live Proceed action before every previously unsafe direct click. The ledger and Vitest exclusion were removed together after exact and loaded-file proof, without timeout/retry/assertion appeasement.

### 5. Planning Mode mobile plan-tab selection

- **Status:** Closed 2026-08-10 by FN-8936 — suite re-admitted.

- **File:** `packages/dashboard/app/components/__tests__/PlanningModeModal.planning-flow.test.tsx`
- **Exact test:** `PlanningModeModal sequential flow > uses full-view Questions and Plan preview tabs on mobile`
- **Observed tree/SHA:** `main` at `4ff41a723c` with the Planning Mode task-creation fix uncommitted.
- **Observed frequency:** first observation in a targeted three-file dashboard run.

| run | result |
|---|---|
| targeted three-file dashboard run | **1 failed** / 198 passed; React reported an update outside `act(...)`, and the Plan tab still had `aria-selected="false"` immediately after `fireEvent.click` |

The failure exercises the pre-existing mobile tab transition, while the task-creation fix changes the completed-plan Proceed handoff. The file retains substantial coverage, so this first sighting is recorded rather than quarantined; a second sighting requires the normal file-level quarantine.

**Suite re-admitted 2026-08-10 (FN-8936):** This first-sighting mobile observation did not receive a second failure. The shared file-level quarantine was removed only after the direct-handoff root cause was structurally fixed and the unexcluded loaded suite, including this mobile coverage, passed.

### 8. Planning Mode duplicate-response generation reconciliation

- **Status:** Closed 2026-08-16 by FN-9116 — resolved (product race).

- **File:** `packages/dashboard/app/components/__tests__/PlanningModeModal.planning-flow.test.tsx`
- **Exact test:** `PlanningModeModal sequential flow > silently reconciles duplicate-response generation conflicts on $viewport with $label`

<!-- FNXC:TestFlakeRegister 2026-08-16-10:52: Parametrized `it.each` cases are registered by their source-template title because the register validator checks raw test-file hierarchy segments. The concrete failing `'mobile'` row (`a durable next question`) and earlier contaminated `'desktop'` row remain recorded below as evidence. -->
- **Observed tree/SHA:** `main` at `8ee2ace2c1` (dashboard bare-run repair batch).
- **Observed frequency:** one clean sighting — solo standard-lane run (`node scripts/run-quality-tests.mjs`, lane `app:backfill-3`) on a quiet machine; the earlier `'desktop'`-row failure ran concurrently with a full bare vitest run and live peer-session edits to planning API files, so it is recorded as context, not as an independent clean sighting.

| run | result |
|---|---|
| solo standard lane (quiet machine) | **1 failed** (`'mobile'` row) / rest of lane passed |
| targeted file run immediately after | 58/58 passed |
| earlier busy-machine standard lane | **1 failed** (`'desktop'` row); targeted rerun 58/58 passed |

This file now carries THREE distinct register/ledger histories (entries 4 and 5 above plus this one) and one prior FN-8936 stabilization. Under the AGENTS.md repeated-quarantine rule this is a subsystem product-race smell: the duplicate-response generation reconciliation path (FN-8756 banner suppression / duplicate-generation dedup) should be investigated as a product race rather than stabilized a fourth time. Filed as a Fusion task; a second clean sighting of this exact test is an ordinary on-sight quarantine.

**Resolved 2026-08-16 (FN-9116): Product race.** `handleSubmitResponse` caught a duplicate response-generation rejection, awaited `fetchAiSession(sessionId)`, then wrote its old session snapshot after a newer writer could already own the UI. The fix captures the response load and turn epochs before the response await, so an A → B → A reload cannot let the old A response adopt the new A load epoch. Every reconciliation/fallback write drops when a newer load, response, stream event, or recovery transition owns the view.

Crucially, an accepted SSE `onError` is a turn boundary only after stale-event rejection. Its recovery captures that turn token across fetch and auto-retry awaits; a later response cannot be overwritten by an old reconnect, retry failure, or permanent error, and reconciliation from the errored turn cannot overwrite the recovery. The loading-poll error path now also claims its recovery turn *before* auto-retry: a successful retry returns early, so claiming afterward had left a held reconciliation authorized to overwrite recovery loading state.

FN-9116 adds deterministic ordering coverage for desktop and mobile rows across durable-question, result-only plan-review, generating snapshots, A → B → A reload/rejection, `onError`-before-reconciliation, `onError` recovery losing ownership to a later response, and loading-poll recovery landing before a held reconciliation. The non-duplicate actionable-error assertions remain intact and passing. Response actions now settle hydration and query the live control before dispatch, removing the detached hydration-node test seam without changing product semantics.

- **Resolved tree/SHA:** `d5f29bbdbc` (FN-9116 worktree; final documentation commit follows).

| verification | result |
|---|---|
| targeted planning-flow file ×3 | **passed** (76 tests each run) |
| shared-helper sibling suites ×1 | **passed** |
| `app:backfill-3` run 1 | **passed** (5,693 tests) |
| `app:backfill-3` run 2 | **passed** (5,693 tests) |
| `app:backfill-3` run 3 | **passed** (5,693 tests) |
| `pnpm lint`, `pnpm verify:fast`, `pnpm build` | **passed** |

The flake is structurally removed rather than stabilized: every hydration/recovery writer now has an ownership boundary before it can overwrite a newer turn. This is a published behavior fix, so FN-9116 includes a patch changeset.

### 11. Settings revision attribution reset-ordering assertion

- **Status:** Closed 2026-08-16 by FN-9129 — resolved (reset-ordering assertion).

- **File:** `packages/core/src/__tests__/settings-revision-attribution.test.ts`
- **Exact test:** `settings revision attribution > round-trips every explicit provenance variant through committed JSONB revisions`
- **Owner:** FN-9129
- **Observed tree/SHA:** retained FN-9128 logs; remediation started at `5e5422de6e57ead4f0c4a253b47b59063c1f9fe3`.
- **Observed frequency:** 5/5 retained loaded full-core runs (default, 4, 8, 12, and sampled 12 workers), not 4/5.

| run | result |
|---|---|
| FN-9128 loaded campaign | **failed 5/5**; retained `/tmp/fn-9128-core-*.log` |
| FN-9129 isolated pre-fix | **failed**; `/tmp/fn-9129-solo-1.log` |
| FN-9129 full core, 4 workers ×3 | subject passed after repair; first run had unrelated satellite-store failure, remaining two runs clean |
| FN-9129 full core, 12 workers ×1 | passed after repair; co-observed command-center cases passed |

Verbatim observed failure:

```
FAIL  src/__tests__/settings-revision-attribution.test.ts > settings revision attribution > round-trips every explicit provenance variant through committed JSONB revisions
AssertionError: expected [ { id: 'fusion-system', …(1) }, …(4) ] to deeply equal [ { kind: 'human', …(1) }, …(4) ]
```

**Resolved 2026-08-16 (FN-9129):** This was not configuration-provenance loss. A direct table dump retained in the FN-9129 `evidence` task document and `/tmp/fn-9129-instrumented.log` showed all five explicit actors physically persisted among 19 rows. The shared harness intentionally restarts identities between tests; consequently `ORDER BY sequence ASC` has duplicate values across reset boundaries, and the test's `.slice(before.length)` count window selected previous system rows. The assertion now identifies each explicit write by its test-owned `taskPrefix`, retains its immutable revision UUID, and re-reads only those IDs; regression coverage adds a post-snapshot background system write to prove it cannot enter the provenance assertion. This preserves the provenance invariant without retries, waits, quarantines, timeout changes, or a broad harness mutation.

The two command-center durable-agent activity cases observed once at 12 workers are classified as co-observed identity-reuse risk, not this subject's cause: the repaired 12-worker campaign passed them. Core PostgreSQL quarantine remains forbidden and `quarantinedCoreTests` remains empty.

### 9. Create Room picker loaded-lane state ordering

- **Status:** Closed 2026-08-16 by FN-9120 — resolved (product race).

- **File:** `packages/dashboard/app/components/__tests__/CreateRoomModal.test.tsx`
- **Exact test:** `CreateRoomModal > shows loading, empty, no-match, populated, and selected-member picker states`
- **Observed tree/SHA:** `7527d2651f` (FN-9120 baseline).
- **Observed frequency:** 2/2 loaded `dashboard-app-quality-backfill` shard-2 runs failed; a targeted rerun had passed before this investigation.

| run | result |
|---|---|
| loaded backfill shard 2 | **failed** — 1 failed / 2,134 passed; full output retained |
| loaded backfill shard 2 with picker instrumentation | **failed** — same assertion; fetch calls were exactly 1/2/3 and the member list still rendered Alpha/Beta after typing `zzz` |
| new ordering tests against unfixed component | **failed** — stale project result overwrote current roster; rejected load rendered no-agents copy |

**Resolved 2026-08-16 (FN-9120): both a timing-sensitive test assertion and a product race.** The original third phase synchronously asserted after `userEvent.type` while the loaded lane still rendered populated rows, even though its once queue had not shifted. Independently, the production effect had no cleanup or request identity, so a close/reopen, project change, or unmount could let a stale fetch write roster/loading/error state; initial `loadingAgents=false` also exposed terminal empty copy before the first effect.

The component now owns an explicit idle/loading/loaded/failed phase and fences each request with an epoch plus cleanup. A current successful reload removes selected IDs absent from its roster. The test uses controlled deferred promises in a single persistently-mounted modal, proves close/reopen/project ordering, failure and unmount fencing, duplicate-name/selection reconciliation, and desktop/mobile empty-state copy invariants without retries, sleeps, waits around the old assertion, or mock re-pinning.

### 10. Planning Mode loaded-turn affordance ownership

- **Status:** Closed 2026-08-16 by FN-9117 — resolved (product ownership race).

- **Files:** `packages/dashboard/app/components/__tests__/PlanningModeModal.planning-flow.test.tsx`, `PlanningModeModal.ui-interactions.test.tsx`
- **Exact cases:** `opens Plan preview without submitting and preserves the current mobile answer on return`; `can restart initial planning after stopping its first generation`; `can refine a stopped initial plan into the first question`; both desktop/mobile rows of `keeps five substantive choices and one Other usable on %s`; `submits an answer after deferred same-session hydration on %s`; and FN-9117's `keeps post-Stop plan review when a pre-Stop loading poll resolves on %s`.
- **Observed tree/SHA:** original reports at `9a9e591b72`; completed remediation tree `603373b93a`.

**Resolved 2026-08-16 (FN-9117): Product ownership race, not a timeout defect.** `QuestionForm` rendered from `workspaceQuestion`, while submit formerly branched on a closed-over `view`; a late hydration could therefore drop an enabled Next action. It also restored every new `initialResponse` object identity, overwriting a dirty same-question draft and disabling the mobile Next-question path. FN-9117 binds submit to the live session/question state and preserves a dirty same-question draft.

The Stop audit also confirmed the recovery-poll ownership hazard: Stop invalidates loading state then can restore the same session id for a question or summary terminal view. FN-9116's load-and-turn fence now rejects a poll started before that boundary. FN-9117 adds real-modal desktop and mobile deferred-poll coverage: fake timer time starts the 8-second poll, a deferred stale durable question resolves after Stop, and post-Stop plan review remains intact. The pre-FN-9116 source had effect-cleanup cancellation once terminal React state committed; the epoch fence closes the earlier render/cleanup interval structurally. No timeout, retry, widened wait, sleep, weakened assertion, or quarantine was used.

This completes the two Stop reports rather than deferring them as unreproduced. A same-session `ai_session:updated` rehydrate was the remaining transient-unmount path: `loadSession` cleared `workspaceQuestion` before its fetch resolved, unmounting `QuestionForm` and discarding the dirty answer. It now preserves an active question/plan-review workspace only for a refresh of that same session; a different session still enters the neutral loader. The real-modal deferred-hydration test uses per-character `userEvent.type` on desktop and the mobile Other choice, then asserts the exact `respondToPlanning` payload after the controlled commit.

It is the companion to entries 4, 5, and 8: FN-8936 fixed detached test-node handoff; FN-9116 fences duplicate-response and recovery writers; FN-9117 ensures visible question controls use the live turn and retain operator drafts.

| verification | result |
|---|---|
| targeted planning-flow + ui-interactions ×3 | **passed** (84 planning-flow tests, 20 UI-interaction tests) |
| all `PlanningModeModal.*` sibling suites | **passed** |
| `test:quality:app:backfill` aggregate attempt | shards 1–3 passed; initial 300s bound ended during shard 4, which passed when run directly |
| `test:quality:app:backfill` aggregate attempts 2–3 | blocked by repeated unrelated `CreateRoomModal` search-state failures; filed as FN-9121 with full logs `/tmp/fn-9117-backfill-run-{2,3}.log` |
| `pnpm lint`, `pnpm verify:fast`, `pnpm build` | **passed** |

No UI surface changed; this was a state-ownership and regression-coverage repair. The existing patch changeset remains applicable because Planning Mode behavior is user-visible.

### 12. Satellite approval audit lifecycle ordering assertion

- **Status:** Closed 2026-08-16 by FN-9132 — resolved (product ordering defect).

- **File:** `packages/core/src/__tests__/postgres/satellite-stores.pg.test.ts`
- **Exact test:** `PostgreSQL satellite stores (U6 consolidated, shared harness) > PostgreSQL satellite DB-injected stores (VAL-DATA-016) > ApprovalRequestStore: replayed/conflicting decisions 409, grants expire, ownership enforced`
- **Owner:** FN-9132
- **Observed tree/SHA:** deterministic pre-fix reproduction on `b31be1ba7c7415b9ee20c4c76875c961be73a0c3`; structural fix begins at `c3e3a2648a`.
- **Observed frequency:** co-observed in retained FN-9125 12-worker PostgreSQL-directory, FN-9129 4-worker full-core run 1, and FN-9130 loaded-measurement evidence.

Verbatim observed failure:

```
FAIL  src/__tests__/postgres/satellite-stores.pg.test.ts > PostgreSQL satellite stores (U6 consolidated, shared harness) > PostgreSQL satellite DB-injected stores (VAL-DATA-016) > ApprovalRequestStore: replayed/conflicting decisions 409, grants expire, ownership enforced
AssertionError: expected [ 'approved', 'created' ] to deeply equal [ 'created', 'approved' ]
```

| run | result |
|---|---|
| retained FN-9125 PostgreSQL directory, 12 workers | **failed** with the verbatim ordering assertion |
| retained FN-9129 full core, 4 workers run 1 | **failed** with the verbatim ordering assertion |
| FN-9132 deterministic one-worker frozen-Date repro, pre-fix | **failed**; both rows existed with identical `createdAt` values |
| FN-9132 targeted lifecycle, project-isolation, satellite, and dashboard-route suites | **passed** post-fix |
| FN-9132 PostgreSQL directory, 12 workers | **passed**; 173 files, 1370 tests passed, 1 skipped |

**Resolved 2026-08-16 (FN-9132):** This was a product ordering defect in `getApprovalAuditHistory`, not PostgreSQL DDL contention, harness identity reuse, or test timing. `appendAuditEvent` creates deterministic IDs containing the event type, while the read ordered tied timestamps by `id ASC`; that lexically placed `approved` before `created`. The read now applies a lifecycle rank derived from `APPROVAL_REQUEST_AUDIT_EVENT_TYPES`, followed by ID only as a final total-order tiebreak. Regression coverage freezes `Date` around real create/decide/complete writes and proves tied approved, denied, and completed states, distinct timestamps, mixed ties, project isolation, and the public store delegate. No timeout, retry, worker-count, skip, assertion weakening, or quarantine change was made; `quarantinedCoreTests` remains empty.

This resolves the previously unclassified “unrelated satellite-store ordering failure” mentions in entry 1's 12-worker verification table, entry 2's 12-worker verification table, and entry 11's FN-9129 4-worker run table. Those sightings are now classified separately from their entries' identity and DDL investigations.

**Terminal negative 2026-08-17 (FN-9131):** The reproduced 27-worker PostgreSQL-directory symptom was investigated with a cluster-shared connection-budget primitive. The first harness wiring and a follow-up that queued registry over-subscription while retaining leases both made the loaded run worse (135 failed files in 174.1s, then 144 failed files in 223.3s); the subject itself was not the only failure. The harness wiring was reverted, the primitive remains characterized independently, and FN-9139 owns a setup-safe admission boundary. No quarantine, timeout change, test retry, skip, worker cap, or assertion change was made.

---

## Entry: `self-healing-pending-wedge-notification` marker-selection count (first sighting)

- **Status:** Closed 2026-08-23 — file-level quarantine (second sighting); quarantine RESCUED and lifted 2026-09-02 by `9b29c6beab` (PR #3549); RETIRED 2026-09-06 by `82c635384d` (deletion ratchet — file, ledger row, and engine exclude line removed together), on the same resurrected-row basis recorded under record 7 above.
- **File:** `packages/engine/src/__tests__/self-healing-pending-wedge-notification.test.ts`
- **Exact test:** `reconcile pending wedge notifications > selects elapsed markers and audits the completion outcome verbatim`
- **Owner:** unowned — first sighting, recorded rather than quarantined because the file's remaining coverage (4 tests over the pending-wedge reconciler) is substantial and quarantine is file-level.
- **Observed tree/SHA:** `ea48af7ab5`, during a full `@fusion/engine` suite run while auditing pre-existing failures.
- **Observed frequency:** once, suite-only. Passes deterministically in isolation.

Verbatim observed failure:

```
FAIL  |engine-default| src/__tests__/self-healing-pending-wedge-notification.test.ts > reconcile pending wedge notifications > selects elapsed markers and audits the completion outcome verbatim
AssertionError: expected 2 to be 1 // Object.is equality
 ❯ src/__tests__/self-healing-pending-wedge-notification.test.ts:50:62
```

| run | result |
|---|---|
| full engine suite (967 files), `ea48af7ab5` | **failed** with the verbatim count assertion |
| same file in isolation, same tree | **passed** (4/4) |
| full engine suite, baseline `3f448f7292` | not observed |

Reads as cross-test state bleed into the reconciler's marker selection (an expected-1 selection saw 2),
not a timing wait — so no timeout, retry, or assertion change was made. A SECOND sighting is an
ordinary on-sight quarantine with no further discretion, per the standing rule in AGENTS.md.

**Second sighting 2026-08-23, quarantine lifted 2026-09-02 (`9b29c6beab`, PR #3549).** The second
sighting arrived on a full engine-suite run at `a97aa84a20` and the file was quarantined on sight
(ledger entry plus a `packages/engine/vitest.config.ts` exclude, with a 2026-09-06 deletion
deadline). The quarantine was then lifted as a genuine rescue, not appeasement: the test now pins
its own clock (`vi.useFakeTimers()` plus `vi.setSystemTime`) and restores real timers in
`afterEach`, removing the cross-suite timer-state bleed this entry hypothesized — no timeout was
widened, no retry added, and no assertion relaxed. The ledger entry and the engine vitest exclude
were removed in the same commit and the file is live in the suite again. The commit message does
not mention the rescue — the evidence is in the test-file diff.

---

## Entry: `spec-drift-reconciler` exponential-backoff case (quarantined 2026-09-09)

- **Status:** Quarantined 2026-09-09 after a second timer-driven sighting — FN-9272's selected engine test command observed three persistence attempts after the second 1-second fake-timer advance where the test expects two; no open rescue owner, deletion-ratchet deadline 2026-09-23 (quarantinedAt + 14d).
- **File:** `packages/engine/src/__tests__/spec-drift-reconciler.test.ts`
- **Exact test:** `SpecDriftReconciler > backs a persistent outage off exponentially instead of re-firing every second`
- **Observed tree/SHA:** `a97aa84a20`, full `@fusion/engine` suite run.
- **Observed frequency:** once in a full-suite run; also failed once when run in the same command as `self-healing-pending-wedge-notification.test.ts`, and passes deterministically alone (10/10) and in other pairings.

Verbatim observed failure context:

```
FAIL  |engine-default| src/__tests__/spec-drift-reconciler.test.ts > SpecDriftReconciler > backs a persistent outage off exponentially instead of re-firing every second
```

Both this and the quarantined `self-healing-pending-wedge-notification` case are timer-driven
reconciler tests that fail only alongside other suites, which points at shared fake-timer or
cross-file state rather than a product defect. No timeout was widened, no retry added, and no
assertion relaxed. A SECOND sighting is an ordinary on-sight quarantine with no further discretion,
per the standing rule in AGENTS.md. That second sighting occurred 2026-09-09 during FN-9272
verification (a parser-only change that does not touch the reconciler), so the file is quarantined
in `scripts/lib/test-quarantine.json` with the matching `engine-default` exclude under the deletion
ratchet; rescue requires a root-cause fix proving the reconciler coverage is stable.

---

## Entry: `PlanningModeModal.planning-flow` under dashboard lane sharding (first sighting)

- **File:** `packages/dashboard/app/components/__tests__/PlanningModeModal.planning-flow.test.tsx`
- **Exact tests:** a DIFFERENT case failed on each of two consecutive full-lane runs —
  `PlanningModeModal sequential flow > keeps the newer session when delayed duplicate reconciliation returns 'a durable question' on 'mobile'`, then
  `PlanningModeModal sequential flow > can refine a stopped initial plan into the first question`.
- **Owner:** unowned — first sighting for this file. Recorded rather than quarantined: the file carries 83 tests and quarantine is file-level.
- **Observed tree/SHA:** `c82e420ba0`, via the package's real command `pnpm --filter @fusion/dashboard test` (the `run-quality-tests.mjs` lane runner), lane `app:backfill-3` (`--project dashboard-app-quality-backfill --shard=3/4`), concurrency 2, 6144MiB heap per lane.
- **Observed frequency:** twice in two full-lane runs, each time a different case; passes 83/83 in isolation every time.

Verbatim observed failure (second run):

```
FAIL  |dashboard-app-quality-backfill| app/components/__tests__/PlanningModeModal.planning-flow.test.tsx > PlanningModeModal sequential flow > can refine a stopped initial plan into the first question
TestingLibraryElementError: Unable to find an element by: [data-testid="planning-plan-review"]
```

| run | result |
|---|---|
| lane runner, default (fail-fast), `c82e420ba0` | **failed** on the delayed-duplicate-reconciliation case |
| lane runner, `--all --no-fail-fast`, same tree | **failed** on the refine-stopped-plan case |
| isolated `vitest run <file>`, same tree, repeatedly | **passed** 83/83 |

The moving target plus a "cannot find element" shape points at render/settle timing under a loaded
shard, not a product defect — a wait that is adequate on an idle machine and not under four
concurrent 6GB lanes. No timeout was widened, no retry added, no assertion relaxed. A SECOND sighting
of the *same* case is an ordinary on-sight quarantine per the standing rule in AGENTS.md; because the
case moves, the honest rescue is a deterministic settle signal in this file's harness rather than a
longer wait.

---

## Entry: dashboard `api:backfill-*` lanes — PostgreSQL contention under lane concurrency (pattern, not a single test)

- **Files:** no fixed set. Across three consecutive full-lane runs on the same tree, a DIFFERENT file failed each time:
  - run 1: `app/components/__tests__/PlanningModeModal.planning-flow.test.tsx`
  - run 2: `src/__tests__/routes-branch-groups.test.ts`, `src/__tests__/routes-planning.test.ts`
  - run 3: `src/__tests__/register-signal-routes.test.ts`, `src/__tests__/server-view-preload.test.ts`
- **Command:** `pnpm --filter @fusion/dashboard test -- --all --no-fail-fast` (the `run-quality-tests.mjs` lane runner: 15 lanes, concurrency 2, 6144MiB heap per lane).
- **Observed tree/SHA:** `cc19584cc4`.
- **Every one passes in isolation**, including re-running the exact multi-file command that had just failed.

Failure shape in run 3 (`api:backfill-1`, `api:backfill-2`):

```
Error: Hook timed out in 15000ms.
fnlvl=warn [dashboard-github-tracking-reconciler] … pass failed (other passes still run): Failed query: select … from "project"."tasks" …
```

The hook timeout arrives alongside PostgreSQL `Failed query` warnings. Those warnings were FIRST READ
as proof of connection exhaustion; that reading was WRONG and is retracted here. The warnings come from
a background github-tracking reconciler still polling an already-torn-down store, i.e. noise that
follows the timeout rather than causing it. Measured 2026-08-23: a live `dashboard-api-quality-backfill`
lane peaked at **14 backend connections against `max_connections=100`**. There is no connection
shortage. Two attempts to act on the exhaustion theory were reverted — lowering the harness `poolMax`
from 5 to 2 took core's PostgreSQL suite from 1 failure to 11, matching FN-9131, where a shared
connection-budget primitive also made a loaded run worse.

This is suite infrastructure, not a defect in any of the five files above, and chasing the file that
happened to lose the race on a given run is whack-a-mole.

Scale for context: run 3 executed roughly 15,200 tests across 15 lanes and failed 2.

### Reproduction attempt 2026-08-23 — did NOT reproduce

Re-run on a quiet 28-core machine at `7e59494448`, after this session's 816 cross-package test failures
were fixed:

| Run | Result |
| --- | --- |
| `--group api` alone (3 lanes) | **passed** — 156 files, 1,437 tests, 0 hook timeouts, 0 gate degradations |
| full runner, all 15 lanes | **passed** — 23,584 tests, 0 hook timeouts, 0 gate degradations, 0 failed files |

Two candidate mechanisms were tested and NEITHER is supported by evidence:

1. **DDL admission saturation.** `pg-ddl-admission.ts` waits up to `acquireTimeoutMs` (default 10s),
   then degrades and runs the DDL anyway, against a 15s `hookTimeout` — mechanically enough to overrun.
   But both runs emitted **zero** `[pg-ddl-admission] degraded` warnings, so the gate never saturated.
   Unsupported; do not cite it as the cause without a run that actually shows the warning.
2. **CPU oversubscription.** The api group spends `import 191.63s` against `tests 45.01s`, and
   `hookTimeout` is wall-clock, so a starved worker overruns setup without any database involvement.
   This remains the leading candidate purely because it survives the disproofs above — the original
   sightings occurred while several agent subprocesses ran concurrently, and the clean 2026-08-23 runs
   had a quiet machine. It is UNPROVEN: no run has yet captured the failure with CPU pressure recorded.

**Next attempt should capture, at the moment of failure:** per-worker CPU wait, the gate's
`observe()` degradation counters, and which hook overran. Without those, any fix is a guess.

**Not quarantined deliberately, and nothing deleted.** Quarantine is file-level and the failing file
moves, so quarantining would evict healthy coverage without touching the cause. Deleting the files was
considered and rejected: they are 112 tests pinning FN-8823 (shared-branch-group merge boundaries),
FN-7438, FN-7611, FN-8341, and FN-8442, including an explicit guard against a hand-rolled
`promoteBranchGroup` mock. No timeout was widened, no retry added, and no assertion relaxed anywhere in
this investigation.

One genuinely structural failure WAS found and fixed rather than recorded here: the lane runner's own
self-tests spawned `pnpm --filter @fusion/dashboard test`, re-entering the suite from inside it. See
`cc19584cc4`.

---

## Entry: `executor-prompt` pause-resume agent-creation count (first sighting)

- **File:** `packages/engine/src/__tests__/executor-prompt.test.ts`
- **Exact test:** `TaskExecutor pause behavior > resumes unpaused in-progress task with no active session`
- **Owner:** unowned — first sighting, recorded rather than quarantined because the file's remaining 113 tests are substantial coverage and quarantine is file-level.
- **Observed tree/SHA:** `5769d5cd6` plus the then-uncommitted main-checkout-guard narrowing (guard classification, its audit metadata, and the workspace prompt string) — none of which this test exercises.
- **Observed frequency:** once, and only when the file ran in the same vitest command as five other executor/workspace files. Passes deterministically alone (114/114).

Verbatim observed failure:

```
FAIL |engine-default| src/__tests__/executor-prompt.test.ts > TaskExecutor pause behavior > resumes unpaused in-progress task with no active session
AssertionError: expected 0 to be greater than or equal to 2
 ❯ src/__tests__/executor-prompt.test.ts:1047:51
```

| run | result |
|---|---|
| six files in one command (`task-done-refusal-x-invariant`, `executor-workspace`, `executor-prompt`, `verify-worktree-invariants-missing`, `executor-workspace-config-propagation`, `executor-workspace-capture`) | **failed** — 1 failed / 147 passed |
| `executor-prompt.test.ts` alone, same tree | **passed** (114/114) |

The assertion counts `createFnAgent` calls after a resume and observed ZERO, so the resume path never
reached agent creation at all — reads as module-mock ownership racing across files that share the
`@fusion/core` agent-factory mock, not a wait that needs lengthening. No timeout was widened, no retry
added, and no assertion relaxed. A SECOND sighting is an ordinary on-sight quarantine with no further
discretion, per the standing rule in AGENTS.md.

### 15. `packages/cli/src/__tests__/package-config.test.ts` > `shipped agent skills` > `keeps computer-use in the published skill tree`

- **File:** `packages/cli/src/__tests__/package-config.test.ts`
- **Exact test:** `shipped agent skills > keeps computer-use in the published skill tree`
- **Owner:** unowned — first sighting, recorded rather than quarantined because the file's remaining 41 tests are substantial coverage and quarantine is file-level.
- **Observed tree/SHA:** deterministic (not a flake-shape): reproduced on pure `origin/main 2adc171f2c` (fresh probe worktree) and on the v0.78.0-beta.1 merge tree — 1 failed / 41 passed both ways.
- **Root cause:** host `npm` is 12.0.2, whose `npm pack --dry-run --json` emits a keyed object (`{"<name>": {...}}`) while the test parses npm 10/11 array shape (`packed[0].files`) → `TypeError: Cannot read properties of undefined (reading 'files')` at `package-config.test.ts:565`. Upstream CI (older npm) stays green.

Verbatim observed failure:

```
FAIL  src/__tests__/package-config.test.ts > shipped agent skills > keeps computer-use in the published skill tree
TypeError: Cannot read properties of undefined (reading 'files')
 ❯ src/__tests__/package-config.test.ts:565:46
```

A proper fix normalizes both npm-JSON shapes test-side (upstream-owned); no assertion was relaxed locally. A SECOND sighting on npm<12 hosts, or any evidence the packlist semantics itself regressed, is an ordinary on-sight quarantine with no further discretion, per the standing rule in AGENTS.md.

### 16. `prepare-graph-node-execution` FN-282 tests vs FN-288 invariant change (deterministic upstream-main failures)

- **Files/tests:** `packages/engine/src/__tests__/planning-before-worktree.test.ts` > `prepareGraphNodeExecution skips read-only acquisition (workspace=false|true)`; `packages/engine/src/__tests__/workspace-file-overlap-parity.test.ts` > `workspace implementation base-refresh enablement > forwards refresh from write-capable code and skips read-only graph preparation`
- **Owner:** upstream. FN-282 (d18d8c7b99) authored both tests and the prepare-graph-node-execution skip contract; FN-288 (8803ecff6a) then rewrote `prepare-graph-node-execution.ts` so `requiresWorktree:true` proceeds through `store.getTask` before any read-only short-circuit, and did NOT update these two tests. The tests encode the pre-FN-288 contract, so they fail deterministically at `origin/main 8803ecff6a` itself (verified by file-identity: post-merge code+tests are byte-identical to upstream, and the assertion contradicts line 46 of the merged source).
- **Why upstream main stays green:** these files are outside the thin merge-gate allow-list; `full-suite.yml` is push-to-main non-blocking.
- **Observed tree/SHA:** reproduced on the v0.78.0-beta.2 merge tree and by identity argument on pure `8803ecff6a`; failures: `expected "vi.fn()" to not be called at all, but actually been called 1 times` (getTask / ensureGraphCustomNodeWorktree).
- No assertion was relaxed locally. The fix is upstream-owned: re-express the two tests against the FN-288 invariant (read-only nodes never arrive with `requiresWorktree:true`, or move the plan short-circuit above the `getTask` line in the implementation if that is the intent).

### 17. `pg-backup-migration-bookkeeping.pg.test.ts` FN-9255 restores on a host where PATH pg client tools (18.6) are newer than the embedded server (15.18) (environment-dependent, deterministic here)

- **File/tests:** `packages/core/src/__tests__/postgres/pg-backup-migration-bookkeeping.pg.test.ts` > `restores the exact migration version set captured with project data`; `reports unavailable and leaves bookkeeping untouched for a legacy pair`; `leaves bookkeeping untouched for a central-only restore`
- **Owner:** environment (this host) with an upstream hardening gap. This machine runs the Fusion **embedded** PostgreSQL (native `15.18.0-beta.17` under `~/.fusion/pg-test-server`, clusters on ports 25432/54329/5433) plus docker PG15/16 clusters; `pg_dump`/`pg_restore` from PATH are **18.6**. Verified: `pg_dump` 18.6 writing against a 15.18 source embeds `SET transaction_timeout = 0;` (a PG17+ GUC) in the dump preamble, and `pg_restore` replaying that dump into the 15.18 server fails with `could not execute query: ERROR: unrecognized configuration parameter "transaction_timeout"`. CI stays green because it pairs client tools of the same major as the server.
- **Observed tree/SHA:** reproduced on the v0.78.0-beta.2 merge tree with `FUSION_PG_TEST_URL_BASE=postgresql://localhost:25432`; error: `pg_restore failed: Command failed: /usr/bin/pg_restore --format=custom ... --single-transaction .../fusion-pg-*.dump`.
- **Production implication (this host):** production is the same embedded 15.18 server and `pg-backup.ts` resolves `pg_dump`/`pg_restore` from PATH (upstream deliberately does not bundle them), so dashboard-created backups here carry the PG17+ SET and FN-9255 restores would fail the same way until either PATH tools match the server major or upstream resolves the embedded-native `bin/` binaries first. Operator workaround: put the embedded-native client bin first on PATH (`~/.fusion/pg-test-server/native/15.18.0-beta.17-linux-x64/bin`).
- **Action:** do NOT appease. On a version-matched host this becomes an ordinary on-sight quarantine; the durable fix is upstream-owned (pin/embedded-native tools or a client-major guard in `pg-backup.ts`).

### 18. `AgentDetailView.core.test.tsx` skill-badge state under full-suite load (first sighting)

- **File:** `packages/dashboard/app/components/__tests__/AgentDetailView.core.test.tsx`
- **Exact test:** `AgentDetailView — core > renders assigned skills as readable badges with full id tooltip`
- **Owner:** unowned — first sighting, recorded rather than quarantined because the file's remaining 53 tests are substantial coverage and quarantine is file-level.
- **Observed tree/SHA:** v0.78.0-beta.3 merge tree (pre-merge HEAD `26e41764c0` + staged merge of `dd808ed2c6`), full `npx vitest run` in `packages/dashboard` (log `/tmp/dash-test2.log`). The identical tree passed this file in the FIRST full merged run (`/tmp/dash-test.log`) and the file passes deterministically in isolation (53/53), so the shape is suite-only load/timing nondeterminism, not a code regression. Test also exists on `origin/main` untouched.
- **Symptom:** badge renders `data-skill-state="unknown"` instead of `"auto-available"` at `AgentDetailView.core.test.tsx:482` — reads as the async skill-catalog lookup losing the render race under suite load, not an assertion needing widening.

Verbatim observed failure:

```
FAIL  |dashboard-app-quality-backfill| app/components/__tests__/AgentDetailView.core.test.tsx > AgentDetailView — core > renders assigned skills as readable badges with full id tooltip
Error: expect(element).toHaveAttribute("data-skill-state", "auto-available") // element.getAttribute("data-skill-state") === "auto-available"
Expected the element to have attribute:
  data-skill-state="auto-available"
Received:
  data-skill-state="unknown"
 ❯ app/components/__tests__/AgentDetailView.core.test.tsx:482:23
```

No timeout was widened, no retry added, no assertion relaxed. A SECOND sighting is an ordinary on-sight quarantine with no further discretion, per the standing rule in AGENTS.md.

**Second sighting (2026-09-07) → quarantined.** Reproduced identically (`data-skill-state="unknown"` at `:482`) in a `npx vitest run app/components/__tests__/` subset run on the v0.78.0-beta.4 merge tree (this session, 2026-09-07 ~09:22 UTC; the run failed 4 files, this test among them, while a same-day 2-file run passed it). The file now carries a `quarantinedDashboardTests` exclusion and a `scripts/lib/test-quarantine.json` row (`quarantinedAt: 2026-09-07`); deletion clock runs to 2026-09-21 unless rescued with a root-cause fix.
