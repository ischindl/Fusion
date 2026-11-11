---
title: "PR monitor rendered an uncomputed mergeability as CONFLICTING and a dead relay as a report"
date: 2026-11-11
problem_type: reliability
module: "pi-subagents schedule (operator host tooling)"
component: pr-monitor-fusion-upstream
tags:
  - pr-monitor
  - pi-subagents
  - scheduled-workflow
  - mergeability
  - unknown-state
  - attestation
  - report-truthfulness
applies_when: "editing the pr-monitor schedule, workflow script, or relay agent; adding a scheduled collector; or diagnosing a monitor report that contradicts `gh pr view`"
---

## The shape (RUFU-580)

A 2-hourly schedule reported seven PRs as `CONFLICTING`. On every one of those fires GitHub answered
`mergeable: UNKNOWN`, which means "GitHub has not computed it yet", and the PRs were in fact clean into their base.
The same schedule also delivered the previous fire's report when its relay child died. Two defects, one root: the chain
had no way to tell "not computed" from "computed", and no way to tell a measurement from a copy of one.

## The chain

```
pi-subagents scheduler
  -> schedule.json  target.kind=workflow-script, raw JS body
     -> runs.run("pr-monitor", ...)   relay child, agent def .pi/agents/pr-monitor.md
        -> bash: node pr-monitor-state.mjs     the deterministic collector
           stdout line 1 -> relayed back -> script regex -> report -> operator
           stdout line 2 -> ATTEST <16 hex>  -> latest-report.attest
           also: baseline.json, latest-report.txt, latest-report.bytes, monitor-log.txt
```

`pr-monitor-state.mjs` was already deterministic, tested, and git-tracked, and it already knew the merge-state rules
better than any prose could. Nothing in the chain read its output as structure. The schedule body parsed its **first
stdout line** with one regex accepting `NO CHANGE|CONFLICTING|CHANGED|ALL MERGED|MONITOR|ERROR`. A line could be a
report or a crash and nothing downstream could tell.

## Three causes

1. **Unknown collapse at the carriage layer.** The field contract for GitHub mergeability is
   `packages/dashboard/src/github.ts`: `GhPrMergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN"`. `UNKNOWN` also
   represents "no value received" — `gh-cli.ts` reads `mergeable ?? "UNKNOWN"`, so an absent field and an uncomputed
   field arrive as the same string. The collector then persisted that carried value and re-confirmed it on later fires,
   while the rule that matters is in `packages/core/src/cli/gh-cli.ts`: a conflict may be diagnosed only from explicit
   conflict text or a *refreshed* `CONFLICTING`/`DIRTY`, never from `UNKNOWN` or a carried value
   (`docs/fork-extensions.md`: `MERGEABLE` + `BLOCKED` is clean-but-unapproved; `CONFLICTING` + `DIRTY` is a real
   rebase job). The rendering followed the carriage, not the rule.
2. **Unverified relay hop.** The workflow accepted whatever the child said if it matched the regex. A child that
   timeout-crashes at the model provider emits an error sentence beginning `API Error: 503 ...`, which matches a
   permissive regex. If it crashes before saying anything, the fallback re-read `latest-report.txt` and delivered that
   line as current. The runner recorded `state: "completed"` in both cases, so the schedule looked healthy and the
   report was not a measurement.
3. **Unbounded retry.** `attemptLoopMaxRounds: 3` and `failureMaxRounds: 2` were inherited from a builtin delegate.
   Each retry burned one model turn against a failing provider; the same fire also produced a compaction deadlock
   (see `pi-second-compaction-deadlock-deterministic-tier3.md`).

## Fix

The relay cannot be deleted: a scheduled fire is a **public execution** and pi-subagents refuses `runs.host` there
(`host-mode steps are not available in public scheduled execution mode`), so no other component may run the collector.
What the relay lacks in trustworthiness is replaced by measurement.

**`pr-monitor-state.mjs`**

- Loud entrypoint (`failLoud` / `checkEntrypoint`): missing `gh`, or a state dir that cannot be written, exits non-zero
  printing `MONITOR ERROR: <cause>` on both std streams, writes nothing, and uses `writeSync` because pipe writes
   followed by `process.exit(1)` drop the message. A failing-but-installed `gh` is *not* loud: that is a degraded read,
   which deserves a report, not a silence.
- Per-fire attestation: `emitReport` is the only writer of a report and stamps
  `ATTEST sha256(<line>|<iso instant>|<head sha>)[:16]` into `latest-report.attest` alongside the line. A process that
  did not run cannot know the token.
- Uncomputed mergeability is rendered as a state, not a caveat: `mergeObserved()` separates a value ever seen from an
  uncomputed field, so a never-observed PR prints `mergeability unresolved: #NNNN (never observed)` and only a genuine
  carry prints "shown value is last known, may be stale".
- Verdict by delta, conflict by provenance, list by current state — three independent authorities (see below).

**schedule body**

- Accepts only shapes the collector prints: `NO CHANGE: `, `#NNNN: `, `ALL MERGED `, `ALL-MERGED`. The old
  alternatives `CHANGED`, `MONITOR` and `ERROR` are gone; the collector never emits `CHANGED` and a test asserts it.
- A relayed report is accepted only when an independent read-only child re-reads `latest-report.txt` +
  `latest-report.attest` and the token matches. Token match plus a different relayed line delivers the file's line
  (this is also the fix for the relayed-line truncation logged 2026-09-11). Token mismatch is a loud error, never a
  silent pass. No attestation at all (an older monitor) falls back to the file line labelled `(unverified)`.
- `MONITOR RUNTIME FAILURE:` from the relay is loud **with no fallback read**, because the state file still holds the
  previous fire's line and re-delivering it dresses a dead monitor in last run's numbers.
- Retries forced to zero on every launch; failure details containing merge-state vocabulary are withheld and replaced
  by `detail withheld (it carried merge-state wording)`.

## Invariants that keep it honest

| Claim | Authority |
| --- | --- |
| Itemized state | fresh GitHub read this fire, plus the local merge-tree oracle |
| Conflict word | explicit conflict text, or a refreshed conflicting state this fire |
| Verdict word | diff against the persisted baseline |

Independent on purpose: a steady unresolved state says `NO CHANGE` while still naming the PR, and a steady genuine
conflict stays itemized under `NO CHANGE`. A change too small to move the rollup still prints its `#NNNN: ` line. A PR
dropped from the tracked set changes the denominator and may never read as `ALL MERGED`.

## Verification

- Collector suite: 68 -> 123 assertions, `node --test` 0 failures; stub `gh`/`git` on `PATH`, state dir relocated via
  `PR_MONITOR_STATE_DIR`, so the production baseline is never touched.
- Ladder harness `pr-monitor-workflow.check.mjs`: 27 assertions, reads the **live** manifest rather than a fixture, and
  its last case runs pi-subagents' own `validateWorkflowScript`.
- One supervised manual fire: exit 0 in 25.0 s, empty stderr, all five hops byte-identical (stdout, `latest-report.txt`,
  `latest-report.attest`, `monitor-log.txt`, `latest-report.bytes`). `gh pr view` run independently at the same moment
  agreed: `MERGEABLE` + `BLOCKED` for the same PRs the line named.
- Schedule lifecycle byte-preserved: `trigger`, anchor, `nextRunAt`, `paused`, `overlap`, `catchUp`, `lastRunId`, `args`
  identical to the pre-change backup; only `target.workflowScript` changed.

## Prevention worth keeping

- **A manifest edited on disk is never re-validated.** pi-subagents validates `workflowScript` on the *request* path
  only. The first version of the new body used an `async function` helper, which `validateWorkflowScript` rejects
  ("workflowScript does not support nested async functions") — that body would have sat in `schedule.json` and silently
  stopped firing, and nothing would have complained for hours. Run the installed package's validator over any hand-
  edited body: `~/.pi/agent/npm/node_modules/pi-subagents/bundle/chunk-*.js` exports `validateWorkflowScript`.
- **Report invariants must be machine-checked.** The suite now forbids a conflict token anywhere in a line built from
  uncomputed inputs, and forbids the word `CHANGED` in collector output. Prose rules for wording rot; assertions do not.
- **Never let a crash-shaped string satisfy a report-shaped matcher.** Match the vocabulary the producer can emit, and
  keep an unmistakable failure sentinel (`MONITOR RUNTIME FAILURE`) out of that vocabulary.
- **An empty output is a failure mode of every LLM hop.** The old fallback turned one into a success.

## Related

- `docs/solutions/reliability/pi-second-compaction-deadlock-deterministic-tier3.md` — same fire, the other symptom
- `packages/core/src/cli/gh-cli.ts` — "never diagnose a PR conflict from UNKNOWN or a carried value"
- `packages/dashboard/src/github.ts` — `GhPrMergeable`
- `docs/fork-extensions.md` — what `MERGEABLE`+`BLOCKED` and `CONFLICTING`+`DIRTY` mean
