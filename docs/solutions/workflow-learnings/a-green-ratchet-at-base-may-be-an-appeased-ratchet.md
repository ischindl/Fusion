---
category: workflow-learnings
module: scripts/lifecycle-column-census
tags: [lifecycle-columns, census, ratchets, baseline, false-green]
problem_type: measurement-hazard
applies_when: dispatched against a ratchet whose reproduction may no longer reproduce
---

# A strict ratchet that is green at your base may be green because someone appeased it

Recorded 2026-11-12 on RUFU-546, a card whose entire premise was "`node scripts/lifecycle-column-census.mjs
--strict` exits 1 on `main`". At the dispatched base commit it exited **0**. Read literally, that says the
symptom is already fixed and the card is a no-op. It was not fixed. The ledger
`scripts/lib/lifecycle-column-census-baseline.json` had been re-recorded with `--strict --update-baseline`,
so `byFile` had grown entries for the very files whose guards had just risen — 3 for `hold-release.ts`, 1
each for `human-merge-approval-ops.ts`, `moves.ts`, `task-comment-delivery.ts`, `TaskContextMenu.tsx`.
Seven guards, seven allowances, zero failures, and not one of those seven guards had ever been read.

## Why the exit code cannot tell the two states apart

`--strict` compares a per-file count against the committed ledger. Both of these produce exit 0:

- the guards were disposed of, so the counts fell and the ledger was re-recorded **after** that;
- the guards were left in place and the ledger was re-recorded **around** them.

The ledger records a number per file. It has no field for "was this guard examined", because that is not a
fact a scanner can compute — a disposition lives in the source as a resolver call or a `DELIBERATE-LITERAL`
marker. So the command that can silence the ratchet is the same command that records finished work, and it
takes one flag to tell them apart: `--triage`, which buckets every remaining guard as documented or
**unexamined**. Green plus "0 unexamined" means finished. Green plus "7 unexamined" means appeased.

The companion trap is at the reporting end: the headline "`N unexamined guard(s) remain (no deferral
note)`" is printed by `describeBacklogState` and, by design, **changes no count and no exit code**. A card
that quotes that number as its proof of redness is quoting a line the ratchet does not gate on.

## The measurements that separate the two cases

Before writing "already fixed", or "still broken", run all four and record stdout:

| command | what it proves |
|---|---|
| `node scripts/lifecycle-column-census.mjs --strict` | whether a count exceeds its allowance right now |
| `node scripts/lifecycle-column-census.mjs --triage` | whether the remaining guards carry any recorded disposition |
| `git log --oneline -- scripts/lib/lifecycle-column-census-baseline.json` | who last moved the ledger, and whether a commit with source dispositions exists beside it |
| `node scripts/lifecycle-column-census.mjs --json` | the per-file counts to compare against the ledger by hand |

A ledger commit with no matching source commit in the same change is the signature. `--strict` green
**plus** `--triage` printing unexamined guards is not a completed ratchet; it is a ratchet with its teeth
in the drawer.

## Two ledger facts that look like your defect and are not

- **`deliberateByFile` is not ratcheted.** Only a rise in `byFile` fails. Reviewed-marker counts therefore
  drift silently whenever `main` moves: re-recording on RUFU-546 printed
  `packages/engine/src/scheduler.ts \0 in-progress` 4 to 3 although neither commit touched `scheduler.ts`
  (byte-identical between base and branch, `diff` empty). Attribute such a drop by citing the file's last
  touching commits in the re-record message, or the next reader will assume the card broke it.
- **`--compare` red in a file you never opened is a classifier disagreement, not your guard.** The mode
  asserts the AST parser is a superset of the regex, so it also reports the regex's over-matches:
  `feature.status === "done"` in the mission reconciler reads as a column guard to the per-line regex and
  correctly not as one to the parser. Prove it is not yours by showing the named file has an empty diff
  against your base, and say so — `--compare` is not wired into `pr-checks.yml` or any gate, so it cannot
  block a card and must not be "fixed" by touching the instrument.

## Siblings

[lifecycle-conversions-that-score-as-wins](./lifecycle-conversions-that-score-as-wins.md) records the
conversion shapes the census miscounts; [a-falling-count-is-not-evidence](./a-falling-count-is-not-evidence.md)
records the metric counterpart; [probe-the-instrument-the-way-ci-runs-it](./probe-the-instrument-the-way-ci-runs-it.md)
records whether the invocation you used can fail at all. This one is narrower: the ledger is the instrument's
memory, and a memory rewrite is indistinguishable from progress from the exit code alone.
