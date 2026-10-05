# Fork extensions — what this build adds, and how we keep contributing upstream

This repository is a private build of [Runfusion/Fusion](https://github.com/Runfusion/Fusion) that
carries a large private base (~780 commits) on top of upstream. That base is **not** a fork of the
product's direction: almost all of it is lifecycle depth (self-healing, merge correctness, review
convergence) plus a set of capabilities upstream deliberately does not ship.

This file is the single place that records **which capabilities are ours**, with evidence, and
**how we keep shipping pull requests upstream** while carrying that base. Both halves exist because
the two failure modes are separate: drifting so far that we can no longer contribute, and silently
re-adding something upstream already excluded.

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

## Capabilities that exist here and not upstream

Verified per-symbol against `origin/main` (not by path, which over-reports through renames). "Hits"
counts non-test files containing the anchor identifier.

| Capability | Anchor | This build | `origin/main` | Schema slot |
| --- | --- | --- | --- | --- |
| Human plan-approval gate | `humanPlanApproval` | 32 files | **0** | `0080` |
| Human merge-approval gate | `humanMergeApproval` | 34 files | **0** | `0083` |
| Project notes | `AsyncNoteStore` | 4 files | **0** | `0074` |
| Whiteboards | `AsyncWhiteboardStore` | 4 files | **0** | `0076` |
| Per-turn memory recall | `perTurnRecall` | 11 files | **0** | — |
| Operator language directive | `operatorLanguage` | 19 files | **0** | — |
| Review-lane entry ledger + dispatch sweep | `ReviewDispatchSweep` | 2 files | **0** | `0088` |
| Verification resource envelope | `applyVerificationResourceBound` | 3 files | **0** | — |
| Chat liveness reconciliation | `classifyChatInFlightLiveness` | 6 files | **0** | — |
| Workflow identity + project model lanes | schema slot only, no symbol claimed | — | — | `0079` |

The two human-approval gates are the largest product-level difference: upstream automates plan and
merge decisions; here each one is an operator boundary with its own audit event, notification, and
bypass path. `docs/settings-reference.md` and `docs/workflow-steps.md` describe the runtime
behaviour; this file records only who owns the capability.

### Deliberately *not* claimed

Recorded so nobody re-claims them during a merge review. Each of these looks fork-unique by path
and is not — upstream has the same concept, so a "our fork adds X" claim would be false:

- **Knowledge graph** — `KnowledgeGraph` appears in 51 upstream files vs 55 here. Shared.
- **Long-term memory** — `longTermMemory` present upstream. Shared.
- **Overlap waits / file-scope coordination** — `overlapWait` present upstream (28 files). Shared.
- **Migration `0089`** (`fn_9429_stale_review_callback_waiver_receipts`) is upstream's `0086`
  re-issued under our numbering during a merge, not an addition of ours.

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

Carrying ~780 private commits does **not** block upstream PRs, because upstream PRs are not cut from
our `main`. Every open PR here is a small cross-repo branch from `ischindl/Fusion` whose base is a
recent `origin/main` commit and whose commit count is 1–8. Verified: no `pr/*` branch has our `main`
as an ancestor.

Rules that keep this true:

1. **Cut `pr/*` branches from `origin/main`, then cherry-pick the shippable commits.** Never from our
   `main` — that would put ~780 commits in the PR diff.
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
