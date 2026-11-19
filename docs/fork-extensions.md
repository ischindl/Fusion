# Fork extensions — what this build adds, and how we keep contributing upstream

This repository is a private build of [Runfusion/Fusion](https://github.com/Runfusion/Fusion) that
carries a large private base (1269 commits as of 2026-11-19, including this document's own commit)
on top of upstream. That base is
**not** a fork of the product's direction: almost all of it is lifecycle depth (self-healing, merge
correctness, review convergence) plus a set of capabilities upstream deliberately does not ship.

This file is the single place that records **which capabilities are ours**, with evidence, and
**how we keep shipping pull requests upstream** while carrying that base. Both halves exist because
the two failure modes are separate: drifting so far that we can no longer contribute, and silently
re-adding something upstream already excluded.

### The geometry, as measured

| Fact | Value |
| --- | --- |
| Our `main` | `ac71d02915`, dated 2026-11-19 |
| `origin/main` (upstream tip) | `eb7eef49d5`, dated 2026-10-26 |
| `merge-base origin/main main` | `eb7eef49d5` — upstream's own tip |
| Commits we carry on top | **1269** |
| Distinct task ids in those commits | **756** (five id prefixes: `CWE FN FUSI RUFU STAS`) |
| Commits upstream has that we lack | **0** |

The fourth and fifth rows are the whole point of recording this: the merge-base *is* upstream's tip,
so the divergence is **one-directional**. We are not missing an upstream fix, and "rebase onto
upstream" would not be a sync — it would be a rewrite of the private base (see *The contribution
line*). It also means an upstream commit we want is not behind a merge; it is behind nothing.

Upstream's tip is 23 days stale relative to this document. That is a choice, not drift: we consume
upstream by cherry-picking into `pr/*` branches, not by pulling.

---

## The boundary of record

Upstream states the boundary itself. `packages/core/src/postgres/migrations/0085_drop_excluded_upstream_feature_schema.sql`
(`origin/main`, comment authored 2026-09-18) describes *their* published binary as:

> "This binary is a permanently feature-reduced fork that never implements some upstream migration
> slots (0074, 0076, 0079-0083): project notes, whiteboards, workflow-identity archive tables, and
> task-level human-approval/pause/queue-boost columns. A database that ever ran a full-featured
> build carries that schema forever, inert but present."

Their migration then relocates those tables into a `deprecated_excluded_features` schema rather
than deleting them. **We are the full-featured build that migration names.** That sentence is the
authoritative, upstream-authored list of the product-level split, and it is why the table below is
not a matter of opinion.

We do not carry migration `0085` at all — there is nothing for us to move out of the way.

The slot census across `0084`–`0090` (measured 2026-11-19, filename identity) says where the schema
divergence actually sits: `0084` and `0085` are upstream-only, `0086`–`0089` are **filename-identical
in both builds**, and `0090` is ours. So the two trees share four consecutive migrations and differ on
three — the split is not a wall, it is a seam, and it is a seam that has already moved once (see the
`0089` correction below, which the last revision of this file got wrong).

## Capabilities that exist here and not upstream

Verified per-symbol against `origin/main` (not by path, which over-reports through renames). "Hits"
counts non-test files containing the anchor identifier.

| Capability | Anchor | This build | `origin/main` | Schema slot |
| --- | --- | --- | --- | --- |
| Human plan-approval gate | `humanPlanApproval` | 32 files | **0** | `0080` |
| Human merge-approval gate | `humanMergeApproval` | 28 files | **0** | `0083` |
| Project notes | `AsyncNoteStore` | 4 files | **0** | `0074` |
| Whiteboards | `AsyncWhiteboardStore` | 4 files | **0** | `0076` |
| Per-turn memory recall | `perTurnRecall` | 4 files | **0** | — |
| Operator language directive | `operatorLanguage` | 14 files | **0** | — |
| Review-lane entry ledger + dispatch sweep | `ReviewDispatchSweep` | 4 files | **0** | `0091` |
| Verification resource envelope | `applyVerificationResourceBound` | 3 files | **0** | — |
| Chat liveness reconciliation | `classifyChatInFlightLiveness` | 6 files | **0** | — |
| Workflow identity + project model lanes | schema slot only, no symbol claimed | — | — | `0079` |

The two human-approval gates are the largest product-level difference: upstream automates plan and
merge decisions; here each one is an operator boundary with its own audit event, notification, and
bypass path. `docs/settings-reference.md` and `docs/workflow-steps.md` describe the runtime
behaviour; this file records only who owns the capability.

## What the base actually consists of

The capability table below is a *claim list* — one row per product-level feature we assert is ours.
It is not an inventory, and 1269 commits are not visible in ten rows. This section is the inventory,
so that "what do we have that upstream doesn't" is answerable without reading git log.

Measured 2026-11-19 over `merge-base origin/main main..main` for the file-touch and depth numbers; the
thematic bucket table below it is still the 2026-11-16 pass, because its patterns are subject keywords
and re-running it with reworded patterns would move numbers without measuring anything. Two honesty
limits on the numbers: a
**file-touch** counts a file every time any commit modifies it, so it weights churn rather than
feature size; and the thematic buckets match on commit *subject* keywords, so a commit that touches
three areas is counted in all three. Use them to see where the mass is, not to measure features.

### Where the work landed

| Area | File touches | What it says |
| --- | --- | --- |
| `packages/dashboard` | 5697 | The largest single mass. Operator surfaces: board, task detail, modals, terminals. |
| `packages/engine` | 3051 | The lifecycle depth: lanes, scheduler, executor, merger, self-healing sweeps. |
| `packages/core` | 2334 | Domain model, store, migrations, the invariants the engine reads. |
| `docs` | 1069 | Includes `docs/solutions/` — see depth below. |
| `packages/i18n` | 1018 | Translation churn on an existing upstream package, **not** a fork capability. |
| `.changeset` | 860 | Release-note discipline, one file per shipped change. |
| `plugins` | 381 | Plugin surfaces on an existing upstream tree. |
| `packages/cli` | 351 | `fn` CLI and the pi extension. |
| `scripts` | 152 | The structural gates this repo enforces (non-Latin scan, comment-assertion scan, prompt byte-stability). |

`packages/i18n`, `plugins`, and `packages/cli` all exist upstream too (53 vs 48, 976 vs 959, 340 vs
311 tracked files). Their churn here is ours, the *package* is not — do not cite them as fork
capabilities.

### What the commits are about

Overlapping buckets, by commit subject:

| Theme | Commits |
| --- | --- |
| merge / squash / push correctness | 190 |
| review / verdict / gate | 149 |
| dashboard & UI | 138 |
| chat & sessions | 119 |
| test quarantine, flakes, gate admission | 132 |
| worktree & branch lifecycle | 78 |
| workflow graph / nodes / continuations | 74 |
| durable agents & heartbeats | 66 |
| memory / recall / stash | 34 |
| overlap waits & file-scope coordination | 26 |
| run-audit telemetry | 17 |
| schema & migrations | 11 |
| self-healing sweeps | 9 |

Read the last two rows against the first five, not by size. `self-heal` at 9 is a floor, not a
ceiling: self-healing sweeps are *named* in 9 subjects but the sweeps themselves are mostly authored
under merge, review, and worktree subjects — the sweep count understates that subsystem by design.

### Schema we carry that upstream does not

The sharpest evidence of divergence, because a migration file either exists here or it does not:
**19 migration files present here and absent upstream** (97 here vs 80 upstream, plus a `meta/`
directory counted in neither).

| Slots | Owned by |
| --- | --- |
| `0074`, `0076` | project notes, whiteboards (upstream moved these to `deprecated_excluded_features`) |
| `0075`, `0077`, `0078`, `0090` | the overlap-wait / file-scope machinery, incl. owner-FK repair |
| `0079` | workflow identity + project model lanes |
| `0080`, `0083` | human plan-approval and human merge-approval gates |
| `0081`, `0082` | task pause accounting, task queue order (`queueBoost`) |
| `0091` | review-lane entry ledger |
| `0092`, `0093`, `0094` | task-log entries and projections, search-vector scope |
| `0095` | `workflow_work_items.deferred_since` |
| `0096` | global task-id claim |
| `0097` | artifact retraction |
| `local_repair_mixed_0065` | a one-off repair, not a feature — do not cite it as one |

Four of those 19 slots are the overlap-wait machinery. That is the same machinery upstream reserved
schema for and never built (see the correction below), and it is why a fork merge involving
`task_overlap_waits` needs review rather than auto-resolution.

### Depth, which no capability row shows

| | This build | `origin/main` |
| --- | --- | --- |
| test files | 4769 | 3693 |
| `docs/solutions/` documents | 203 | 134 |

~1076 more test files and 69 more written solutions than upstream, over the same tree. This is the
part of the base that is invisible in a feature diff and is the main reason the base cannot be
re-derived by re-implementing the rows in the table above.

## Deliberately *not* claimed

Recorded so nobody re-claims them during a merge review. Each of these looks fork-unique by path
and is not — upstream has the same concept, so a "our fork adds X" claim would be false:

Counts below use the same method as the table (non-test `.ts`/`.tsx` files carrying the anchor
identifier), so the two halves of this file are comparable.

- **Knowledge graph** — `KnowledgeGraph`: 29 files here, 23 upstream. Shared.
- **Long-term memory** — `longTermMemory`: 3 files here, 1 upstream. Present upstream; shared.
- **Migration `0086`** (`fn_9429_stale_review_callback_waiver_receipts`) is upstream's, at upstream's
  slot. An earlier revision of this file claimed it as *our* `0089` "re-issued under our numbering
  during a merge"; measured 2026-11-19 both builds carry `0086_fn_9429_...sql` and our `0089` is
  `0089_fn_9529_file_scope_lease_release.sql`, which is **filename-identical to upstream's `0089`**.
  The claim was true of an older tree and survived the merge that made it false — the exact silent
  rot this file exists to prevent.

### Claim corrected 2026-11-16: overlap waits are no longer shared

This list previously said *"Overlap waits / file-scope coordination — `overlapWait` present upstream
(28 files). Shared."* **That is false as of the current `origin/main`.** `git grep -l overlapWait
origin/main -- '*.ts' '*.tsx'` returns exactly one file, `packages/core/src/postgres/schema-applier.ts`
— upstream retains the **schema** and has no implementation, while this build carries 4 non-test
implementation files. The old number was true when it was written and was never re-measured; a claim
about another repository rots silently, because nothing in CI fetches that repository.

Overlap waits are therefore **not** in the unclaimed list and must not be cited as "upstream already
has it" in a merge review. A second data point measured 2026-11-19 sharpens that: upstream carries
`0084_fn_332_overlap_sync.sql`, whose heading is our `FNXC:OverlapWaitSynchronization` with a later
stamp (2026-09-17 vs our 2026-09-09) and folded-in owner-FK hardening — the same schema we ship at
`0075_fn_332_overlap_sync.sql`. The two files are **not** byte-identical (their CHECK-constraint phase
list and FK clauses differ), so it is a re-issued variant rather than a copy, and the reading is an
inference from the shared heading and the older stamp on our side, not a proven cherry-pick. Either
way the asymmetry is the same one: upstream took the *schema* under its own numbering and left the
*implementation* here (4 non-test files here, 1 upstream). A merge that touches `task_overlap_waits`
therefore has to reconcile two independently-numbered migrations for one table, which is why the rule
below says review, not auto-resolve.

They are not promoted into the capability table above either: promotion requires a named anchor file
plus a matching `CLAIMED_CAPABILITIES` entry in
`packages/engine/src/__tests__/fork-extensions-doc.test.ts`, and the honest anchor here is still
being chosen — the machinery spans the core store, the dispatch gate, and the release path. What
this correction does change is the upstreaming decision: this is the largest piece of lifecycle
depth we carry that upstream has *declared interest in by reserving its schema slots* and does not
have, which makes it the strongest candidate to ship as a `pr/*` branch.

## Re-measuring (run this before editing any number above)

Every count in this file is a `git grep` against a ref, and every one of them is wrong the moment
upstream moves or this build grows. Reproduce rather than trust:

```bash
git fetch origin main
git merge-base --is-ancestor origin/main main && echo "strictly ahead (no upstream commits missing)"
git rev-list --count $(git merge-base origin/main main)..main   # commits we carry

hits() { git grep -l "$1" "$2" -- '*.ts' '*.tsx' 2>/dev/null \
          | grep -viE 'test|spec|__tests__' | wc -l; }
for a in humanPlanApproval humanMergeApproval AsyncNoteStore AsyncWhiteboardStore \
         perTurnRecall operatorLanguage ReviewDispatchSweep \
         applyVerificationResourceBound classifyChatInFlightLiveness; do
  printf '%-32s here %3s upstream %3s\n' "$a" "$(hits $a main)" "$(hits $a origin/main)"
done
```

The block above covers the geometry and the claim table. Everything else in this file is measured by
these commands, added 2026-11-19 when the stale `0089` claim proved that the first block alone leaves
half the file unverifiable:

```bash
BASE=$(git merge-base origin/main main)
hits() { git grep -l "$1" "$2" -- '*.ts' '*.tsx' 2>/dev/null \
          | grep -viE 'test|spec|__tests__' | wc -l; }   # same helper as the block above
git rev-list --count $BASE..main                                   # commits we carry
git log --format='%s' $BASE..main | grep -oE '\b[A-Z]{2,}[A-Z0-9]*-[0-9]+\b' | sort -u | wc -l
git log --format='' --name-only $BASE..main | grep -v '^$' > /tmp/touches.txt
for a in packages/dashboard packages/engine packages/core docs packages/i18n .changeset \
         plugins packages/cli scripts; do
  printf '%-20s %s\n' "$a" "$(grep -c "^$a" /tmp/touches.txt)"
done
for d in packages/i18n plugins packages/cli; do                    # exists-upstream sanity check
  printf '%-14s here %s upstream %s\n' "$d" "$(git ls-files "$d" | wc -l)" \
    "$(git ls-tree -r --name-only origin/main -- "$d" | wc -l)"
done
MIG=packages/core/src/postgres/migrations
printf 'migrations here %s upstream %s ours-only %s\n' \
  "$(git ls-files "$MIG/*.sql" | wc -l)" \
  "$(git ls-tree -r --name-only origin/main | grep -cE "^$MIG/.*\.sql$")" \
  "$(comm -23 <(git ls-files "$MIG/*.sql" | xargs -n1 basename | sort) \
              <(git ls-tree -r --name-only origin/main -- $MIG | xargs -n1 basename | grep '\.sql$' | sort) | wc -l)"
for n in 0084 0085 0086 0087 0088 0089 0090; do                    # the slot census, name identity
  printf '%s  my %s  upstream %s\n' "$n" \
    "$(git ls-files "$MIG/${n}*" | xargs -n1 basename 2>/dev/null)" \
    "$(git ls-tree -r --name-only origin/main -- $MIG | grep "/${n}" | xargs -n1 basename 2>/dev/null)"
done
printf 'test files here %s upstream %s\n' "$(git ls-files '*.test.ts' '*.test.tsx' | wc -l)" \
  "$(git ls-tree -r --name-only origin/main | grep -cE '\.test\.(ts|tsx)$')"
printf 'solutions here %s upstream %s\n' "$(git ls-files 'docs/solutions/**/*.md' | wc -l)" \
  "$(git ls-tree -r --name-only origin/main | grep -cE '^docs/solutions/.*\.md$')"
for a in KnowledgeGraph longTermMemory overlapWait; do             # the *not* claimed half
  printf '%-18s here %3s upstream %3s\n' "$a" "$(hits $a main)" "$(hits $a origin/main)"
done
```

Read the slot census line by line, not by count: two builds sharing a slot *number* says nothing until
the filename next to it is compared, and two builds sharing a *file* say nothing until it is diffed —
our `0075` and upstream's `0084` are one table with two numbers and different constraint text.

The `origin/main` column is the one that goes stale without any test noticing — see the overlap-wait
correction above. The upstream column going to zero is not automatically a win: check *which* file
survives before concluding upstream dropped a feature. A single surviving `schema-applier.ts` hit
means upstream kept the tables and dropped the code, which is a different claim than either "shared"
or "absent".

## Keeping this file current

The mistake this section prevents is a *silent* one: taking an upstream commit that assumes an
excluded feature is absent, or re-adding a feature upstream moved to `deprecated_excluded_features`.

1. **When a capability lands or is removed**, update its row. The row is the claim; the anchor is
   the proof. If you cannot name an anchor symbol, the capability does not belong in the table.
2. **When you merge upstream**, screen for the excluded-feature vocabulary before judging a commit
   cheap: `git show <commit> | grep -icE '^\+.*archiv'`. Our archive-lane retirement (FN-9187) plus
   upstream's retained `archived` lifecycle column is the largest silent-conflict generator in this
   tree: it produces **no textual conflict** and fails only at typecheck
   (`Property 'archived' does not exist on type 'LifecycleColumns'`). Textual conflict counts
   therefore *understate* merge cost.
3. **`packages/engine/src/__tests__/fork-extensions-doc.test.ts`** is the drift guard. It asserts every
   claimed anchor file and its identifier still resolve in this build, that upstream's
   `0085_drop_excluded_upstream_feature_schema.sql` relocation migration never appears here (we are
   the build it moves features *out of*), that our own schema slots `0074`/`0076`/`0079`/`0080`/`0083`
   are present, and that this file stays linked from `README.md`. It also pins the *unclaimed* list,
   so the knowledge graph, long-term memory, and overlap waits cannot be re-claimed as ours without
   updating both places. A capability you delete without updating the table fails CI rather than
   rotting into a false README claim.

## The contribution line

Carrying 1269 private commits does **not** block upstream PRs, because upstream PRs are not cut from
our `main`. Every open PR here is a small cross-repo branch from `ischindl/Fusion` whose base is a
recent `origin/main` commit and whose commit count is 1–8. Verified: no `pr/*` branch has our `main`
as an ancestor.

Rules that keep this true:

1. **Cut `pr/*` branches from `origin/main`, then cherry-pick the shippable commits.** Never from our
   `main` — that would put 1269 commits in the PR diff.
2. **Never rebase our `main` onto `origin/main`.** That is a different operation from rule 1 and it
   destroys the private base. Rebasing a *small* `pr/*` branch onto current `origin/main` is normal,
   safe, and the fix for a stale `CONFLICTING` PR.
3. **Expect upstream CI to disagree with our private conventions.** Example already shipped: the
   lifecycle-column census went red on every PR because our FN-9187 archive retirement left a quoted
   `"archived"` mailbox-folder literal that upstream's census counts as an unmigrated board column
   (fixed in PR #3630 by hoisting the literal to a named constant).
4. **Read `mergeable` and `mergeStateStatus` as different facts.** `MERGEABLE` + `BLOCKED` means the
   branch is clean and only reviews/checks are missing. `CONFLICTING` + `DIRTY` is the only state
   that needs a rebase.

---

See also: `docs/architecture.md` (lifecycle invariants), `docs/settings-reference.md` (model and
approval precedence), `docs/upstream/` (upstream research notes).
