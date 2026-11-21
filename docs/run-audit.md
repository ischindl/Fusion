# Run-Audit Catalogue

The run-audit catalogue for the S4 **Reliability, Durability & Observability** delivery-pipeline theme — a durable, single-source-of-truth reference for *who did what, when, and why after the fact* across the delivery pipeline's reliability/observability event surface.

## Overlap wait release

`task:overlap-wait-released` is emitted after the transactional overlap receipt becomes ready. Metadata is limited to task/predecessor IDs, episode/common-file counts, and the fixed `resume`/`briefing` plus freshness enums; paths, diffs, summaries, prompts, and remote URLs remain in the project-scoped receipt. Emission uses the engine bounded best-effort seam, so absent, throwing, rejecting, hanging, or late-settling sinks cannot alter synchronization, validate a plan, start work, or roll back the owner decision. The stateless plan-premise release check and durable receipt—not audit—are authoritative; run-audit is not exactly-once and is never re-emitted by every recovery tick.

RUFU-1040 added a second executor-lane producer, and it is the lane that mattered. A refusal raised at the implementation entry — the acquisition itself or the external-worktree gate inside `runImplementation` — escaped as a bare `step-failed`, which spent an `executionRearmEpisode` unit and reached the terminal park; that write is what made a waiting card read as finished and re-admitted it. Measured 2026-11-14: RUFU-593 consumed 5 re-arm units in 4 m 10 s (13:02:34 → 13:06:44) before the RUFU-1027 ceiling parked it, rebuilding its worktree every cycle while its predecessor gained nothing. The refusal now reaches `handleGraphFailure` as the typed graph value `overlap-wait-hold` and takes a bounded in-place resume: `graphResumeRetryCount` (shared with base-refresh, cleared on clean completion) instead of a re-arm unit, and no `status`, `error`, pause, or column move. Its row reports `registrationRelease: "retained-wip-lease" rather than `removed`, because a lease on a WIP column cannot wedge its successor while `countsTowardWip` keeps it active — releasing there bought no relief and converted the next attempt into a fresh `worktree:create`, the churn this card deletes. Exhausting that backoff writes NOTHING at all: the wake path stays event-driven (`releaseFileScopeWaitingContinuations` on the holder's committed release), the timer is a backstop, and the absence of a row after exhaustion is honest. RUFU-896's own producer/vocabulary paragraph never reached `main` — its merge carried only code and tests — so this paragraph is also where that gap is closed.

`task:overlap-delivery-reconciled` is emitted when a delivered predecessor commit rewritten by an integration-branch rebase is proven equivalent to a commit the execution checkout does contain. Metadata is limited to `taskId`, `blockerTaskId`, `repository`, the original and reconciled SHAs, the fixed proof enum, and the episode count; paths, diffs, summaries, and reviewer prose stay in the project-scoped receipt. Emission uses the same engine bounded best-effort seam, so an absent, throwing, rejecting, hanging, or late-settling sink cannot approve a delivery, alter the refusal, or change the owner decision. Refusals are deliberately not audited: they are bounded, repeated per dispatch, and already named in the deduplicated task-log diagnostic.

`task:overlap-acquisition-parked` records one bounded park of a card whose worktree acquisition was refused because another card's delivered-file evidence is withheld. It is deliberately outside the curated delivery-pipeline catalogue and documents as prose here. Metadata is ids/counts/fixed enums only: `taskId`, optional `nodeId`, `reason` (`delivery-unavailable` | `stale-dirty-worktree` | `freshness-unproven` | `superseded`), `missingEvidence` (`delivery-evidence-unavailable` | `checkout-freshness-unproven` | `checkout-dirty` | `episode-superseded`), `episodeIds`, `blockerTaskIds`, `repositories`, `episodeCount`, `strikeBudgetConsumed` (always `0`, which is the point of the row), and `registrationRelease` — the values the code actually returns in `OverlapRegistrationRelease`: `removed`, `absent`, `preserved-uncommitted-changes`, `preserved-foreign-commit`, `preserved-subagent-active`, `preserved-worktree-in-use`, `refused-unattributable-path`, `no-registration`, `removal-threw`, `preserved-removal-threw`, and RUFU-1040's `retained-wip-lease` describing what happened to the registration the refused acquisition had already left on the task row. Emission is one row per (task, episodes, reason) episode rather than one per dispatch, so a sustained wait stays countable without re-announcing. Refusal sentences, branch tips, paths, diff text, episode payloads, and error strings never enter the row — the blocker names live on the task-log line, which is the operator-facing surface. Emission uses the FN-9175 bounded seam, so an absent, throwing, rejecting, or hanging sink cannot alter the park, delay it, or replace the bare recoverable sentence the card is parked with.

## Status / purpose

This document is the **run-audit observability catalogue** for the Core Product Vision & Roadmap mission (Mission **M-MSL4E01A-0001-Y9QC**, Milestone **M2 — Roadmap Definition**, Slice **S4 — Reliability, Durability & Observability roadmap**, feature **F-MSL72J0A-000M-GIJN**), **grounded in the M1 vision theme verbatim**:

> "**Reliability, durability, and observability** of the delivery pipeline — tasks, agents, and their delivery are recoverable and inspectable."

See the north-star grounding: [Core Product Roadmap — §4. Reliability, Durability & Observability](./roadmap.md) and [Product Vision — Strategic Themes](./vision.md).

The S4 roadmap near-term item ("Recoverable and inspectable delivery") calls for the pipeline's run-audit behavior to be **inspectable after the fact**. This catalogue is that surface: it centralizes the delivery-pipeline-focus run-audit event names (finalization, self-healing reconciliation, durable-agent error-state) so an operator or agent can answer *"which run-audit events are emitted for delivery-pipeline finalization / durable-agent error-state / self-healing reconciliation, and when?"* without grepping source. It is kept truthful by a parity test that enforces lock-step with the typed catalogue module.

## How to read / query the run-audit surface

Run-audit events are captured via the run-audit store using the discriminated event union type `DatabaseMutationType` in the engine ([`packages/engine/src/util/run-audit.ts`](../packages/engine/src/util/run-audit.ts)). Metadata follows the **ids/outcomes-only** convention — never description prose. All events named below are literal members of that union; the typed catalogue array [`packages/engine/src/run-audit/run-audit-catalogue.ts`](../packages/engine/src/run-audit/run-audit-catalogue.ts) enforces member-validity at compile time, and the parity test (`run-audit-catalogue.test.ts`) keeps this doc and the module in lock-step so neither can drift from the real union.

Query the stored surface through the audit-store read path (project-scoped historical record of emitted mutation events) filtering by the `mutationType` names below and the ids/outcomes-only structured metadata each event records. This catalogue documents *what each event means*; the audit store records *when each was emitted* in a project's history.

## Delivery-pipeline finalization

Events that close a task's delivery: blocked/advanced completion parks, already-merged / already-on-main no-ops, finalize column-mismatch reconciliation, post-finalize verification, finalize-blocking guards, and stale-merger recovery.

| Event | What it records / when it fires |
| --- | --- |
| `task:completed-blocked-parked` | A fully implemented task is parked instead of advancing to review because a live completion blocker applies. |
| `task:completed-blocked-advanced` | The parked completed task's blocker cleared and its work advances to review. |
| `task:auto-recover-already-merged` | Self-healing finds a task already merged into main and records the no-recovery-needed outcome. |
| `task:auto-recover-finalize-already-on-main` | A finalize attempt is skipped because the task's changes are already present on main. |
| `task:auto-merge-skipped-already-done` | Auto-merge is skipped because the task is already done/landed. |
| `task:auto-merge-finalize-column-mismatch-reconciled` | Finalize found the task in a different live column than its target and reconciled the column. |
| `task:auto-merge-finalize-column-mismatch-no-action` | Finalize found a column mismatch but took no action (e.g. blocked/no-action per triple-proof). Bounded restatement: recorded once per (task, refusal-identity) transition — RUFU-431 keys it on the refusal's discriminating metadata and RUFU-450 on a durable episode — while terminal outcomes always write. |
| `task:post-finalize-verification-no-op` | Post-finalize verification ran and found nothing to verify (no-op), recording the check outcome. |
| `task:no-commits-finalize-blocked-incomplete-steps` | Finalize is blocked for a zero-commit task with incomplete workflow steps (FN-6461 lane). |
| `task:empty-merge-finalize-blocked-no-landed-proof` | The AI empty-merge lane vetoes a zero-diff no-op finalize with no landed proof (FN-8141). |
| `task:zero-commit-landing-proof-refused` | A finalization lane refused to finalize a zero-commit card whose checkout still held work, or could not be classified (RUFU-274). Metadata is ids/counts/fixed enums only — never paths or content. |
| `task:zero-commit-landing-proof-deferred` | A finalization lane deferred on a zero-commit card because zero-ness or checkout content could not be proven, instead of finalizing on a guess (RUFU-274). Metadata is ids/counts/fixed enums only. |
| `task:zero-commit-landing-proof-cleared` | A re-probe proved the cause of a durable uncommitted-work hold is gone and the hold was cleared (RUFU-274). Metadata is the task ID, lane and prior reason code only. |
| `task:finalization-landing-proof-refused` | A landing authority refused to finalize a card whose recorded delivery its resolved **default branch** cannot substantiate — the shape RUFU-294 shipped, where the landed sha had 238 merge conflicts against `main`, was reachable only from the sibling ref `remotes/lan/fusion/rufu-293`, and its named files did not exist on `main` while the card still read `done`. Emitted by `enforceDefaultBranchLandingProof` (`packages/engine/src/merge/default-branch-landing-proof-evidence.ts`) from every finalize seam. Carries the closed `refusalCode` set `commit-not-on-integration-branch`, `squash-commit-not-recorded-on-integration`, `patch-equivalence-absent`, `landing-target-not-integration`, `workspace-repo-landing-unproven`, plus `source`, `integrationBranch`, `recordedSha`, `conflictCount`, and the two fixed probe enums. A refusal is a WAIT: no `status` is written and `mergeRetries` is untouched, so a git fact cannot render a card `merge-failed`. Like its zero-commit sibling this row is a refusal, not an outcome, so the `task:merge-*` family stays clean. Emitted by the merger under a `merger` agent id, best-effort: a hostile audit sink cannot change the refusal (`default-branch-landing-proof-door.test.ts` behavior matrix). Metadata is ids/counts/fixed enums only — never a diff, touched-file list, commit subject, review finding, or verdict sentence. |
| `task:finalization-landing-proof-deferred` | The default-branch landing door could not measure — the resolved integration ref does not exist in this repository, or the recorded sha / content probe returned nothing decidable — so it **proceeded unchanged and recorded the fact instead of refusing**. That asymmetry is deliberate: an unreadable repository (a bare clone, a mid-rebase worktree, a board with no `origin/HEAD`) must never manufacture a delivery failure for every card it holds, so only a positive refusal withholds a transition. Metadata is exactly { taskId, source, integrationBranch, integrationRefReadable, recordedSha, reason } with `reason` from `integration-ref-unreadable` and `landing-evidence-incomplete`; no diff, touched file, error text, or review prose. |
| `task:done-landing-unproven` | One finding from the **landed-truth census** (`reconcile-landed-truth`, startup recovery + maintenance batch 1, emitted under the `self-healing` agent id): a card sitting in a `complete`-trait lane whose `mergeDetails` its default branch cannot substantiate — the reconciliation of the two delivery oracles that RUFU-702 measures. The census reports before it heals: `repairExecuted`/`repair` distinguish what it did from what it only observed, and `landedShaOnIntegration` is the count-only discriminator that separates an id-mentioning commit from the card's own work (RUFU-396's lesson), where `null` means the ownership proof could not be read and `0` means it was read and came back empty. A finding is **report-only** — the arm never moves a card, because lifecycle containment (FN-207/FN-217) forbids an automatic move backward out of a terminal lane and only a review `REVISE` may do that; the operator reopens through `task:landing-unproven-reopened`. The one automatic repair is forward-only: `repair: "stale-hold-cleared"` lifts a `LANDING_PROOF_UNPROVEN:` hold the moment the repository agrees the commit is on the default branch, or on the card's own declared target branch (`proofKind: "task-declared-target"`). Carries { taskId, integrationBranch, recordedSha, branchRef, refusalCode, proofKind, conflictCount, landedShaOnIntegration, suppressionReason, repairExecuted, repair }. A third arm is `repair: "suppressed"`: a card the census refuses to **judge** — `suppressionReason` from `human-terminal-auto-merge-off` (the card's own `autoMerge: false`, FN-5147), `operator-held` (a bare operator pause), or `pr-backed` (a live pull request is the landing vehicle, so the host owes its base branch) — records one row with every measurement key `null`, because nothing was probed, and writes no History line and no mailbox notice: its default branch not holding the commit is true but is not a finding. On a measured row `suppressionReason` is `null`, so the key answers rather than goes missing. **One report per episode**: the finding's History row, audit row, and notice are bounded together by a `sourceMetadata.landedTruthCensus` episode stamped at key level (signature = the refusal code, refresh floor = the 6 h notice cooldown), because the notice was deduped per window while the two rows were previously written on *every* maintenance pass that re-measured the same refusal — a 100-card `done` lane producing 100 History rows and 100 audit rows per tick with no event behind them. A signature change (a changed diagnosis) re-announces immediately, and `LANDED_TRUTH_REPORT_BUDGET` caps how many cards one pass may write, rewinding the rotating cursor rather than skipping the remainder. Metadata is ids/counts/fixed enums only; commit subjects, touched paths, task prose, error text, and review findings never enter run-audit. Deliberately absent from the engine's `DeliveryPipelineRunAuditStep` step ordering — it is a census observation, not a delivery-pipeline step. |
| `task:landing-unproven-reopened` | An operator reopened exactly ONE named card out of a terminal lane because its own default branch refuses its recorded delivery — the acting half of the census above, reached by `fn task reconcile <id> --reopen` and authored through the user-attributed move seam. Emitted by `SelfHealingManager.reopenUnprovenLandedTask` only after the door answers `refused`: a `proven` card cannot be reopened through this seam and a `deferred` one never is, because an unreadable repository is not proof of a false landing. Carries { taskId, fromColumn, toColumn, integrationBranch, recordedSha, branchRef, refusalCode, conflictCount, outcome } — ids, columns, counts and fixed enums only; the refusal sentence stays on the card's History row and no diff, commit subject, or error text enters the row. |
| `task:empty-land-contradiction-detected` | An "empty land" verdict was contradicted by read-only branch evidence — the branch still contributes unapplied content, so the merge lane malfunctioned and the work is not reverted/lost (RUFU-293). Metadata is task ID, the detecting `lane`, the fixed `evidence` enum, and counts only. |
| `task:wake-delta-unresolvable-assignment` | A heartbeat withheld an assigned-task id it could not resolve through the authoritative by-id predicate, dropping it from the wake payload, the wake gate, and the persisted `wakeCursor` (RUFU-455). Emitted once per `(agentId, taskId, outcome)` triple per engine process through the bounded seam, never once per collection: the guard runs on every population collection (wake gate, ack writer, inventory read, idle pre-flight), and because `pruneOperationalLogsAsync` reaches run-audit rows only through `task_id IN (SELECT id FROM project.tasks ...)` while a withheld id has no `tasks` row, a row of this type is otherwise unprunable — the immortality RUFU-344 documents for `store:open`. Metadata is ids/counts/fixed enums only: `taskId`, `agentId`, `outcome` from the closed two-value enum `absent`/`tombstone`, `source: "wake-delta"`, `withheldCount` (rows withheld in the collection that produced this report, not a running total), and `storeBound` — whether the emitting store's data layer was project-bound. `storeBound` is the operator's discriminator between the two causes this row cannot otherwise separate: `false` names the store binding (on an unbound layer `taskProjectScope` no-ops, so the list read spans projects and the phantom is published unwithheld), `true` names a read-shape, cache, or timing divergence. There is deliberately no `scope-mismatch` outcome: `Task` carries no project identity, so no predicate can tell a foreign project's row from no row under this binding. Withheld payload text, owner prose, steering text, and error strings never enter run-audit, and no task History line is written — `logEntry` needs a row, and the withheld id is precisely a row that does not exist. |
| `task:finalize-unproven-blocked` | Finalize is blocked because finalization has not been proven against the landing truth. |
| `task:merge-boundary-unproven-parked` | A workflow merge boundary could not be proven and its terminal park is recorded with best-effort, time-bounded telemetry that never blocks or stalls the park. |
| `task:merge-boundary-evidence-recovered` | Self-healing reverified durable unfinished work on a historic proofless boundary park and resumed named implementation remediation. Metadata contains task ID and a fixed outcome only. |
| `task:finalize-lost-work-blocked` | Finalize is blocked because it would discard work (lost-work guard). |
| `task:auto-recover-stale-merger-status` | Self-healing clears a stale merger status left on a finalize path. |
| `task:merge-admission-deferred-live-execution` | Merge admission found a live executor session, execution lock, or active task signal and deferred without parking the task. Metadata contains task ID plus fixed source, signal, and outcome values only. |
| `task:reconcile-confirmed-merge-checklist` | A confirmed merge reconciled stale non-terminal checklist steps or pending pre-merge results before terminal finalization. Metadata contains task ID, source, counts, prior column, and fixed outcome only. |

### Complete-column gate-evidence refusal (RUFU-406)

`task:move-refused-complete-column-gate-evidence` is emitted by the core move seam once per refused move
into a column carrying the `complete` trait, when the move was attributed to a human (`moveSource: "user"`)
and the card's required workflow gates carry no approving evidence — no row at all, `pending`, a
`failed`/`REVISE` row, or a `skipped` row without an audited operator waiver. It is written by
`@fusion/core` through the FN-9177 bounded seam and therefore sits intentionally outside the curated
delivery-pipeline catalogue, like the approval-hold pair below.

The row exists because the pre-existing invariant at this boundary read only the merge **blocker**, which a
`in-progress → done` move never consults: measured 2026-09-29, RUFU-389 and RUFU-337 reached the terminal
lane with zero `code-review` rows and left no row behind, and both had been closed by an agent through
`fn task move` — whose CLI transport hardcodes `moveSource: "user"`, so the audit trail read as a human
action. Metadata is `{ rejectionCode, toColumn, moveSource, moveCallerSurface, callerSessionId?, gateCount,
gateFindings }`: a fixed rejection code, a column, the caller-surface enum (`operator-cli` / `agent-cli` /
`dashboard-http` / `store-direct`, declared by the transport rather than inferred — the CLI classifies its own
process, so an agent shell reporting through `fn task move` no longer reads as an operator at the keyboard), the
session marker only when a process
marker proved it, and counts. `gateFindings` holds at most eight `lane:gateId:state` triples. The refusal
sentence, reviewer findings, verdict text, and paths never enter this row — the sentence lives on the card's
History line, written alongside it.

Without this row a refusal is invisible to the board: the move throws, the mover sees the sentence, and the
card stays put. With it, "how often does a human-attributed move get refused at the completion boundary,
and from which surface?" is one query.

### Empty-land verdict arms (RUFU-293)

The AI merge lane reports "nothing to land" through the git event `merge:ai-empty`, which fires from exactly two arms and now carries a closed `reason` enum so the two are distinguishable in the audit store: `branch-truly-empty` (zero commits ahead of the integration tip, with no durable review blockers — checked before any clean room is built) and `merge-agent-no-squash` (the branch WAS ahead, yet the merge agent produced no squash). Only the second arm can hide an unapplied contribution, so `runAiMerge`'s `outcome: "empty"` handler re-proves the empty premise with read-only git evidence before any finalize wording is written: a proven `ancestor`/`net-zero` contribution keeps the historical FN-8141 "work may have been reverted or lost" refusal verbatim, while a **contradicted** premise is recorded as a merge-lane malfunction under `task:empty-land-contradiction-detected` (table above) instead of accusing the work of being lost. Metadata stays ids/counts/fixed enums (`taskId`, `tipSha`, `reason`); branch content, diffs, and paths never enter the row.

### The integration-ref write window two processes shared (RUFU-1148)

Merge single-flight used to be a fact of one process: `ProjectEngine.activeMergeTaskId` and the merge queue bound one pass per Node process, so a second daemon on the same shared board could sit inside its own merge pass on the same integration branch while the first advanced it. Two events make the durable claim that replaced that belief queryable, and both are **deliberately outside the curated delivery-pipeline table above** (`run-audit-catalogue.test.ts` locks that table table-for-table against `DELIVERY_PIPELINE_RUN_AUDIT_EVENTS`, and this pair is a merge-mechanics fact about a shared branch, not a delivery-stage verdict):

- `merge:integration-land-acquired` — this pass owns the write window for one `(repository, integration branch)` pair. Written on each of the three claim bursts (pre-existing clean-room recovery, base selection, and the land itself).
- `merge:integration-land-contended` — this pass found the window already owned and is waiting instead of failing.

Metadata is exactly `{ taskId, holderTaskId, outcome }` — two ids plus the acquire/outcome enum from the durable lease seam (`acquired`, `reentrant`, `reclaimed-expired`, `conflict`). `holderTaskId` is the row's owner id, so "who was writing when I was refused" is one query and never a read of prose; it is `null` when no holder was named (a fresh or taken-over row). `reclaimed-expired` is one label for both ways a successor takes the row — the predecessor's TTL lapsed, or a released row was reused — because `@fusion/core`'s seam reports them identically. Nothing else is representable: no path, no ref tip, no branch name, no error sentence.

Both are declared in `DatabaseMutationType` and emitted with `domain: "database"`, not in the git union their `merge:` prefix suggests: the fact recorded is one row of the durable lease table — who may move this ref right now — not a git command that ran. Querying "who was writing, who was made to wait" must not have to join two domains, and the git-domain siblings (`merge:ai-clean-room`, `merge:integration-ref-advance`) really do describe repository mutations.

Emission is the FN-9175 bounded seam (`emitBoundedRunAudit`, never `createRunAuditor`), so an absent, throwing, rejecting, or never-settling sink cannot alter, delay, or abort the landing it reports — covered behaviorally in `integration-land-claim.test.ts`. The matching refusal path is `merge:integration-ref-advance` with `reason: "claim-lost" | "tip-moved"` and `rebuild: true`, written when the pre-advance proof refuses a stale candidate rather than forcing it through.

What the pair answers operationally: a card whose merge took unusually long was almost certainly waiting (`contended` rows with a `holderTaskId`), a card that landed immediately after another's crash took an expired row (`acquired` with `reclaimed-expired`), and a card that reached `INTEGRATION_LAND_CLAIM_STUCK` saw a holder that never released for the whole deferral ceiling. The wait itself is durable-but-not-a-failure: it advances `mergeTransientRetryCount` only, never `mergeRetries`, `status`, or `error`.

## Self-healing reconciliation events

Reconciliation-scoped auto-recover/reclaim events the self-healing sweep surfaces when it repairs board state after the fact.

| Event | What it records / when it fires |
| --- | --- |
| `task:auto-recover-paused-abort-park` | Self-healing clears a benign pause-abort operator park and requeues the task. |
| `task:auto-rebound-paused-scope-decay` | Self-healing rebounds a task whose paused scope decayed past its floor, unblocking followers. |
| `task:auto-archive-failure-budget-exhausted` | Historical event retained for reading pre-removal logs; current self-healing does not archive tasks. |
| `task:reclaim-phantom-executor-binding` | Self-healing proves an in-memory executor-active binding is stale and requeues the task. |
| `task:reconcile-orphaned-pending-step-results` | Self-healing rewrites orphaned `pending` workflow-step results (no live session) to `failed`. |
| `task:stale-review-callback-waived` | Self-healing records a receipt-backed waiver for an eligible stale code-review callback. Metadata is ids, receipt presence, fixed actor/reason, prior status, and threshold category only; reviewer output, findings, lease owners, paths, and errors never enter run-audit, and an absent, throwing, or hanging sink cannot change the durable waiver. |
| `task:reconcile-unproven-review-approval` | Self-healing rewrites singular content-review approvals without input proof to recoverable `failed` results. |
| `task:reconcile-stale-duplicate-decision` | Self-healing clears a recurring duplicate-decision pause with no canonical target. |
| `task:reconcile-orphaned-non-convergence-hold` | Self-healing clears a drifted stage-one approval hold (`code-review-non-convergence` or `plan-review-replan-cap`) whose gate evidence no longer exists, in place and without a lifecycle move. |
| `task:reconcile-terminal-branch-conflict-park` | Self-healing clears a stale `branch-conflict-unrecoverable` park on a card that is already in a terminal lane, after re-proving from full git output that its premise is dead (branch ref absent and no registered worktree). Metadata is `{ taskId, column, priorStatus, outcome }` with the single fixed outcome `stale-park-cleared`; the branch name, the park's error sentence, the worktree path and any task prose never enter run-audit, and the row claims nothing about delivery. The clear is in place and never moves a column. |
| `task:reconcile-worktree-pointer` | One row per worktree pointer `reconcileWorktreePointers` cleared: the recorded working directory is absent and git registers no checkout at it or for that branch, so the sweep writes exactly `{ worktree: null }` - `branch`, its commits, git's own admin record, counters and the lane are untouched, and no worktree or branch command runs. Metadata is `taskId`, `column`, `state` (always `stale-pointer`), `outcome` (always `repaired`), and `passCount`; the dead path, the branch name, any tip SHA and any error sentence never enter the row. The sweep is read-bound: one `git worktree list --porcelain` per project per pass, and a pointer whose directory exists is never classified. |
| `task:reconcile-worktree-pointer-no-action` | One row per candidate the same sweep examined and left standing, deduped per `(taskId, state)`. `state` names what the classifier answered (`unclaimed-live-tree`, or a refusal code such as `registry-unreadable`); `outcome` is `owned-elsewhere` when another lane owns the write - the metadata-rebind arm stays the only writer of an adopted path - `write-refused` when the fenced live-row re-read no longer matched, and `no-action` otherwise. Deliberately silent, so the rows that mean something stay countable: a pointer that measures `consistent`, a card with no pointer or in a lane that is not this sweep's, and an entire pass whose registry read failed - a failed subprocess abstains from the pass instead of writing one refusal row per card, because a registry that could not be read must never read as "nothing is registered". |
| `task:reconcile-stale-agent-assignment` | Self-healing clears stale durable Agent.taskId/state drift while preserving file-scope leases. |
| `task:reconcile-engine-downtime-active-timing` | Self-healing shifts active-task anchors to exclude proven stopped-engine wall-clock. |
| `task:reconcile-engine-downtime-active-timing-no-action` | Self-healing finds no active task qualifies for downtime-timing reconciliation (no-action). |
| `task:reconcile-undeclared-column` | Self-healing re-homes a row out of a column its workflow no longer declares. |
| `task:reconcile-wedged-active-merge` | Self-healing reclaims a wedged single-flight merge entry. |
| `task:reconcile-stranded-completed-no-action` | A stranded-completed promoter withholds promotion of an all-steps-done/skipped task with a failure-park provenance (no-action). |
| `task:reconcile-legacy-adoption` | Self-healing startup adopts a pre-cutover legacy task row through the KTD-8 adoption table. |
| `task:reconcile-archived-into-done` | Self-healing moves a live historical archive row or restores a cold snapshot into the task's workflow completion lane. Metadata is limited to the task ID, source, counters, and a fixed outcome. |
| `task:review-remediation-declined` | A review-lane fix round was admitted and then refused (unavailable checkout, zero/exhausted revision budget, operator hold, or a recovery owner that produced no outcome). One row per narrated decline; a round that scheduled work writes nothing. |

### Stranded workflow continuation reclaim

`reconcileStrandedWorkflowContinuations` records what it did to a stranded continuation row: `workflowWorkItem:reconcile-stranded-requeued` when the row becomes claimable again and `workflowWorkItem:reconcile-stranded-retired` when its task can never run it again (deleted, archived, or soft-deleted). Both carry ids/counts only — `taskId`, `workItemId`, `nodeId`, `kind`, `priorState`, the fixed `reason`, and `stalenessMs` — never `lastError` prose or node config. A suppressed action emits nothing. Since RUFU-547 both rows also carry `deferralWidthMs` (the re-check width in force for the wedge, which a re-queue clears on the row but preserves on the card) and `announceSuppressedBy` (`durable-episode` | `in-process-memo` | `none`), so a query can answer "why did this reclaim produce no card history line?" without reading the sweep.

RUFU-263 made the sweep read the row's `blockedReason` before acting, because `held` is not one condition: a wait the store's own claim predicate can re-take (`workflow-principal-*`, `workflow-named-principal-*`, `workflow-role-pool-*`), an FN-514 delivery lock (`workflow-human-merge-approval*`), and a file-scope wait whose blocker the task still names (`file-scope:<blockerId>`) are all owned by another seam, so the sweep leaves them untouched and writes no row at all.

`workflowWorkItem:reconcile-stranded-no-action` is the deduped sibling for the two conditions the sweep must keep re-checking without re-firing every pass: a dependency wait with no dedicated releaser (`dependency:<taskId>`, `dependency-configuration-blocked`) and an unclaimable hold it has already announced once. The sweep stamps the row's own `retryAfter` on a 30-minute → 2-hour → 6-hour ladder. Metadata adds `reason` and `nextCheckAt` to the same id/count set, plus RUFU-547's `deferralWidthMs` and `announceSuppressedBy`; before this event the only trace of these conditions was one `[recovery] workflow continuation re-queued` task-log line per ~15-minute pass (RUFU-220: 782 identical lines while the card never moved). All three rows use the FN-9175 bounded best-effort seam and are intentionally outside the curated delivery-pipeline event catalogue, whose member-shape guard accepts lowercase event prefixes only.

**What the row is not, and what carries the bound instead (RUFU-547).** An earlier revision of this page stated the stamped `retryAfter` was "both the bound and the evidence - it survives a restart". That was true of the deferral and false of the two things readers assumed it covered. The row is the artifact this sweep and the re-holding seam keep re-creating: the re-queue write nulls `retryAfter` in the same pass that announces, and `holdPlanReviewNoOpContinuation` re-holds the wait through `replaceActiveTaskWorkflowContinuation`, whose insert leaves the column at its default. So the ladder's width, read off that column, was `NaN` on almost every pass and answered rung 0 forever (the measured ~38-minute cadence: one rung plus pass granularity), while the once-per-condition memo - a process-local `Set` - was empty for every new process. Measured 2026-11-11: two byte-identical `[recovery]` lines three seconds apart on one card, which one shared `Set` cannot produce.

Both numbers now live on the CARD, in `tasks.source_metadata` under the key `strandedContinuationReclaim`, because the card is the identity that survives a row replacement. The episode is `{ signature, nodeId, deferralWidthMs, announcedConditions[], lastAt }`: `signature` is `self-healing:stranded-reclaim:<nodeId>` (a foreign signature under the same key reads as no episode), `nodeId` names the WEDGE, `deferralWidthMs` is that wedge's monotonic high-water, and `announcedConditions` is a FIFO ledger capped at 8 entries whose keys are `strandedHoldConditionKey` signatures. Reads are structural: a malformed episode degrades to "no durable episode" - today's floor - and never to a fabricated rung or a silence. Writes go through the key-preserving `sourceMetadataPatch` channel so `duplicateOfTaskIds`, `handoffFrom` and the planning episodes survive, and the write happens after the guarded row transition, never inside it, because a bookkeeping write must not be able to lose, block, or reverse a recovery. That rule cuts both ways and one of its first tests came from this change itself: an episode write or clear that a store cannot perform (the method absent, or the write throwing) is absorbed and logged, never allowed to escape the branch, because an escape lands in the per-item catch and silently cancels the *recovery's* own event row and card line. Measured while covering this: a reveal whose store had no task-row writer cleared the row correctly and emitted nothing at all. Losing the ledger costs the next episode its cadence; losing a reveal record costs this reveal the only two surfaces an operator can read, so the degradation always takes the first. A durable announce suppresses the card line for 24 hours; past that a still-stuck wedge gets exactly one more honest line ("still stranded") and no row transition. The episode is cleared by RUFU-299's reveal, which ends the deferral it described, and by an operator Retry, which is the sanctioned answer to "look at this again now".

### Stranded deferral horizon

RUFU-299 bounded that ladder. The rung width was always written ahead of `now`, so a hold parked at the 6-hour rung vanished from `listDueWorkflowWorkItems` — which gates on `retry_after <= now OR retry_after IS NULL` — and the sweep that had just named the wedge could not see the row until the rung expired. A wait whose blocker never clears was therefore re-measured four times a day at best, and its deferral looked like a healthy quiescent card. The horizon is now seven days from a durable episode anchor, `workflow_work_items.deferred_since` (migration `0095`), which the sweep stamps at the first deferral and re-stamps — never slides forward — on every later one. The anchor cannot be derived from `retry_after` (that is the thing being bounded) or from `updated_at` (the sweep's own transition writes bump it every deferral), so it is its own column; the horizon is a code constant, not a setting, because the value is a safety bound and no project should be able to dial it away. At the horizon the sweep refuses its own cadence control: `action: "reveal"` clears `retryAfter` and the anchor under a compare-and-set, which re-parks the card into its own hold and re-raises its stall/wedge within one pass, so a stuck wait can no longer hide from an operator for longer than a week.

Two events carry the episode, both ids/counts/outcomes-only and both outside the curated catalogue like their siblings. `workflowWorkItem:reconcile-stranded-defer-sustained` marks a deferral that re-applied the already-saturated top rung — the point where the ladder stops being the explanation — and adds `deferralAgeMs` and `rungMs`; `deferralAgeMs` is `null` when a pre-anchor row saturated without one, which is unknown rather than a zero-age episode. It is written on **every** saturated pass and is deliberately not deduped, because "how many times has the widest rung been applied?" must be a `COUNT` query; it is not the retry-storm shape the memos bound, since a saturated row sits in the future for the whole rung, capping it near four rows per card per day. `workflowWorkItem:reconcile-stranded-revealed` marks the refusal itself and adds `deferralAgeMs`; it is written only after the compare-and-set is confirmed against the persisted row, so it cannot over-count a lost race, and clearing the anchor is what makes it once per episode. Each episode also gets exactly one `[recovery]` card-history line at saturation and one at reveal; both are bounded by the memo pair above, and since RUFU-547 the durable half means a restart no longer costs a re-announced line - the process-local memo is now only the strictly additive second source that keeps a failed episode write from resurrecting a line the live process already wrote.

Two corrections to the audit that motivated this work belong here, because both would misdirect the next reader. The notification gap was never `reconcileReviewStallWedgeNotifications` "reading through the same blinded due-read" — that sweep queries task rows by column and never touches the due-gate, so it stayed healthy and RUFU-285's `converge` still fired. The gap was self-inflicted and invisible: the deferral's own `retryAfter` write removed the card from the next pass, which is why the wedge re-check could not fire. The second correction is that RUFU-285's `converge` action must keep precedence: widening the stranded sweep to requeue a dependency hold whose task row is itself wedged would be a second requeue authority for one wedge, and two authorities are how RUFU-220's storm happened. The horizon therefore adds no new mover — only the one the classifier already owns.

### Orphaned git child reaper

`worktree:orphaned-git-child-reaped` records one signal-only termination pass (RUFU-210) over reparented git child processes still holding a removed task worktree as their cwd — the post-mortem shape of the RUFU-194 incident (`git rebase --continue` → `git commit -e` wedged on a missing editor for 1d13h after the worktree was gone). The sweep runs at startup recovery and, cadence-gated with the other git/worktree churn steps, in maintenance batch 1. A candidate must be a `git`-named process under a registered worktrees scan root whose directory is proven removed (readlink failure or the kernel ` (deleted)` cwd suffix) and whose `/proc` starttime proves it is older than the 30-minute grace floor; it receives SIGTERM, then SIGKILL after a 5 s grace, capped at 10 reaps per sweep. The sweep signals processes only — it never mutates task, worktree, or lifecycle state. One row is emitted per deleted worktree path with `target` = the path and metadata limited to `count`, `pids` (capped at 20), `ageMs`, the fixed `reason` (`deleted-worktree-cwd` or `deleted-cwd-suffix`), and `outcome: "reaped"`. Command lines, argv, other-process cwd values, and error prose are never recorded. On a host without `/proc` the sweep emits nothing at all — the absent row is the signal that the host could not be probed.

`worktree:orphaned-git-child-reap-no-action` is the deduped sibling: emitted once per manager lifetime (re-armed after any reap row) when the sweep ran on a probeable host and found no candidates, with `target: "orphaned-git-children"` and metadata `{ count: 0, outcome: "no-action" }`. Both writes use the FN-9175 bounded best-effort seam and are intentionally outside the curated delivery-pipeline event catalogue.

### Vanished task-directory detection

`task:vanished-approved-work` records one finding from `reconcile-vanished-task-dirs` (RUFU-283): a `.fusion/tasks/<ID>/task.json` mirror whose id resolves on **no** board read. It exists because RUFU-225 kept its mirror, its `in-review` column, an `APPROVE_WITH_NOTES` code-review verdict and 3 unmerged commits while resolving on no board read, and the board's silence was the only report — the integrity report is row-only (`status: "ok"` was correct), and FN-6783's orphan re-import needs a fully absent id plus a 7-day window the mirror never reached.

The literal names the class the operator must never lose silently — approved work with an unmerged branch — and `reason` says which neighbourhood the disappearance is: `row-missing-branch-unmerged` / `row-tombstoned-branch-unmerged` (work still reachable), `row-missing-branch-missing` / `row-tombstoned-branch-missing` (work already lost), `row-tombstoned-branch-unprobed` and `state-unresolved` when the branch could not be probed. The last two are one label apart but not the same finding (RUFU-690): the first says a soft-delete tombstone already accounts for the row — and soft deletion stamps the `archived` sentinel together with `deletedAt` by design, so this is the ordinary shape of a deleted card, measured at 211 of 229 reported ids in one three-hour window — while `state-unresolved` says no table holds the id and nothing explains its disappearance. Row evidence is consulted before branch evidence in the ladder for exactly that reason; putting the un-probeable test first made the most common and least alarming finding wear the most alarming label.

**Emission cadence (RUFU-523).** One row per **distinct finding signature per 6-hour window**, not one per sweep pass. The signature is `reason|branchRef|unmergedCommitCount|gateApproved` (`vanishedWorkAuditSignature`), and the window is `WEDGE_RENOTIFY_COOLDOWN_MS` — the same constant the mailbox key buckets by, so the durable row and the operator notice re-announce a standing finding on one clock. The first report of any finding is unconditional; a signature change (a late branch push moving `unmergedCommitCount`, a branch ref that finally disappears, a gate verdict that appears, a reclassification of the row evidence) records immediately; an unchanged finding records again when the window re-arms. Guard state is per project database (a `WeakMap` keyed by the store), in-memory, and never a lifecycle dependency, so an engine restart re-announces a standing finding once — the same accepted bound as RUFU-442 and RUFU-431. What the bound may not do is hide a finding's age: because the re-report carries the *same* signature, the finding's original age stays readable from the **first** row's timestamp. Only the row is bounded — `detectVanishedTaskDirs`'s per-pass summary (`scanned`/`candidates`/`probed`/`findings`/`alerted`/`suppressed`) stays disk truth for the pass that ran.

This replaced an unconditional per-pass row, measured against production 2026-10-03 01:30: 939 rows over 125 distinct tasks in 7.5 hours, 64 rows inside one 15-minute window, i.e. about one re-report of every stable finding per maintenance pass. RUFU-283 had already made the notice idempotent and left the row growing. Consequence for every reader of this table: `count(*)` over this mutation type counts findings again, and the sibling refusal family (`task:auto-merge-finalize-column-mismatch-no-action`) was already bounded at its own funnel by RUFU-431 with a finer metadata-derived key — see below.

### Approval-hold pair invariant (RUFU-297)

`task:move-cleared-approval-hold` is emitted post-commit by the core move implementation when a **user-driven move out of a review lane** clears an approval hold whose evidence the reopen hooks just destroyed (or the gated-session pause shape the move supersedes). Metadata: `{ priorStatus, awaitingApprovalReason, fromColumn, toColumn, moveSource, outcome: "cleared" }` — the reason-code enum (`"none"` for the bare marker), never hold prose or error text. It is written by `@fusion/core` through the FN-9177 bounded seam, so — like the vanished-work pair — it sits intentionally outside the curated delivery-pipeline catalogue. The row is the audit proof of the pair invariant at the move seam: a `step-wiping` review exit with **no** such row means the move preserved the evidence (plan-approval release, graph remediation, `preserveStatus`, `userPaused`) — the invariant's second half.

`task:reconcile-orphaned-non-convergence-hold` is the sweep-side twin (defect B): a card can hold
`status: "awaiting-approval"` + `awaitingApprovalReason: "code-review-non-convergence" | "plan-review-replan-cap"`
after its `workflowStepResults` were already destroyed, whose only pre-existing exit was merging the card —
exactly what the escalation hold was meant to defer. RUFU-297 shipped this event for the Code Review
class alone, so every card carrying the other drifted shape stayed silently merge-blocked; RUFU-314 widened
it to both (its `mutationType` declaration is unchanged — only its description, and the `reasonCode` values
that actually occur). The `reconcile-orphaned-non-convergence-holds` sweep clears either drifted shape
**in place** (no lifecycle move) when no pre-merge step result carries the `failed`/`advisory_failure`
evidence any more, skipping live sessions, pauses, and merge-active work. Discovery is `listTasks` over
every unarchived lane, not `getReviewTasks()`, because the cap park is authored from the planning/executor
lane — the wider scan still only clears in place.
Metadata: `{ taskId, column, priorStatus, reasonCode, outcome }` — five keys, pinned exactly by
`self-healing-orphaned-non-convergence-holds.pg.test.ts`. `reasonCode` is the fixed hold-reason enum (which
ladder parked the card — the two shapes are otherwise identical rows). The row carries no `phase`, no
`source`/`taskLineageId` envelope, and no rendered `awaitingApprovalReason` copy: RUFU-314 put the emit on
the FN-9175 seam (`emitBoundedRunAudit` directly, synthetic `self-healing` run id) precisely because the
run-auditor wrapper it replaced forwarded those envelope keys and no-op'd silently with no run context.
Neither value is prose — the `reasonCode` enum names both — so the closed set is what operators query.
The bounded seam is covered behaviorally, not by inspection: `non-executor-run-audit-sink-health.test.ts`
runs both reason codes through absent / throwing / rejecting / hanging / late-settling sinks and asserts the
clear, the task-log entry, and the pass count are identical in every mode while each non-absent mode still
lands exactly one closed-shape row.

Metadata is ids/counts/fixed enums only: `taskId`, `reason`, `branchRef`, `unmergedCommitCount`, `gateApproved` (whether a gate actually approved the card — `false` is a still-live card that vanished, not a false positive), and `salvageTarget`. Mirror prose, status text, step results, and error strings are never recorded — the mirror is read defensively for `column`/gate rows and discarded. `target` is `task:<ID>` and `agentId` is `self-healing`. The row is written before the mailbox notice, so a mailbox outage still leaves a queryable record; `unmergedCommitCount: null` is the honest "unknown", never a zero.

The matching operator notice is a `system:vanished-work:<taskId>:<reason>:<bucket>` mailbox message (`sendMessageOnce`, 6-hour bucket), not a `NotificationService` wedge: wedge dedupe and cooldown hang off the task row, which by definition does not exist here. **The notice is gated by reason; the audit row is not.** A tombstone with nothing proven on its branch (`row-tombstoned-branch-missing`, `row-tombstoned-branch-unprobed`) is recorded and left unannounced, because the delete that produced the tombstone is itself the explanation, the id stays reserved, and `deleteTask(id, { allowResurrection: true })` is the way back; paging on it measured ~700 messages a day (15,101 system messages since 2026-09-24) against 11 cards with proven unmerged commits and 18 with no row anywhere. Alarm is kept for proven unmerged work on any row shape and for every reason where no row exists at all. `vanishedFindingRequiresOperatorNotice` owns the rule, and the sweep emits at debug (not warn) for a suppressed finding, because the audit row — not the log — is its record. See [`docs/solutions/reliability/vanished-task-directory-rufu-225.md`](solutions/reliability/vanished-task-directory-rufu-225.md).

`task:row-purged-for-resurrection` is the purge half of the same defect. `deleteTask(id, { allowResurrection: true })` physically removes a soft-delete tombstone, which is the only path that can reuse a vanished id, and it used to delete the `task_workflow_selection` / `workflow_steps` children first and the parent second with no audit row at all. The audit write now shares the parent-delete transaction (`emitBoundedRunAudit` is not usable there — a rolled-back delete must not leave its forensic row behind), so an unaudited removal is unreachable by ordering and a failed audit write raises `TombstonePurgeUnauditedError` with the tombstone intact. Metadata is `taskId`, `operation` (`createTask`/`duplicateTask`/`refineTask`), `allowResurrection`, `forceResurrect`, `deletedAtPresent`, and `purgedWorkflowStepCount`. This is an intentionally **awaited, unbounded** transactional writer (class C), not the bounded best-effort seam.

Both events are deliberately outside the curated delivery-pipeline event catalogue above: neither is a delivery-pipeline step, and `reconcile-vanished-task-dirs` repairs nothing. Their shape is pinned by `packages/core/src/__tests__/vanished-task-detection.test.ts`, `packages/engine/src/__tests__/vanished-task-detection-sweep.test.ts`, and `packages/core/src/__tests__/tombstone-purge-audit.test.ts` instead.

### Lane-capability bind revalidation and repair (RUFU-272)

`task:lane-capability-declined` is emitted by the heartbeat wake gate when a wake carrying an explicitly assigned card re-runs the bind verdict and the lane is capability-ineligible for it. The decline suppresses only this dispatch — the binding is untouched — so without this row the only trace was a warn log and the card sat in the lane's todo forever. Metadata: `{ outcome: "declined", taskId, agentId, column, code }`, emitted through the FN-9175 bounded seam under the wake's real `runId`, deduped with a 10-minute cooldown per (lane, card, policy, code); the decline sentence is never recorded.

`code` names WHICH question refused (RUFU-369): `lane-capability-mismatch` is the executor-side verdict (may this lane
ever touch a card in this lane-class), while `review-candidacy-mismatch` is the reviewer-side one (does this card owe a
review right now — a recorded `code-review` verdict, `noCommitsExpected: true`, a terminal lane, a plan-only fast lane,
or zero board evidence all exclude it). The code joins the dedup key deliberately: a lane whose refusal changes reason
must be announced again, and the two classes are different operator decisions. Both ride the same row, the same cooldown
map, and the same no-mutation settle contract — a candidacy decline moves no card, fails nothing, strikes nothing, and
never unbinds. Which arm refused is readable from the code, so no exclusion prose enters the row: the sentence naming
the reason (`No commits expected: true`, `code-review already approved`) is written to the engine heartbeat log, and the
review-ledger refusal witness keeps its own shared prefixed reason sentence so its signature dedup stays intact.

The same decline now settles the review attempt it refused, and RUFU-682 is why. When the refused attempt is one the
review dispatch sweep opened, the decline closes that reviewer-run row as `failed` with reason
`lane-capability-declined:<assignmentPolicy>/[<roles,…>]` — the lane's policy signature, produced by `laneCapabilityDeclinePolicy`
through the reason builder `reviewerRunLaneDeclineReason`; measured live: `lane-capability-declined:auto/[reviewer]` (witness closer:
`declineReviewerRunForLane`, which refuses to settle a row another reviewer opened). That reason is what the sweep reads
back as a recorded refusal: it classifies the card as **`capability-declined`**, announces the sentence once per card per policy
episode through the card's History, and routes no further dispatch to that binding, so the refusal is the last dispatch the lane ever
receives under that signature. It is **not** a `reviewer-busy` park: the card stays un-parked with no error, because the refusal is a
routing fact about one binding, not a fault in the card. The signature is what lifts it — editing the lane's **roles** or its
`runtimeConfig.assignmentPolicy` changes the signature, so the previous refusal stops proving anything and dispatch re-arms on the next
tick; the lane's binding is not part of the signature, and changing it alone does not re-arm.
No new event is emitted, because the existing row already names the defect; what was missing was that the row's evidence lived where
the deciding loop could not read it. The refusal itself stays countable through the ledger: `select rework_round, status, failure_reasons
from project.task_reviewer_runs where task_id = '<ID>' and failure_reasons like '%lane-capability-declined:%' order by rework_round` counts
the refusals (`failure_reasons` is a text column holding a JSON array, and `rework_round` is the attempt number), and
the sweep's per-tick `emptyClasses()` map reports the card count under `capability-declined`.

The repair half is the self-healing sweep `reconcile-lane-capability-misbind` (registered after the agent-link mirror sweeps), the **only** mutation owner for this defect class. It writes exactly one of three events per outcome, all under the fixed `runId: "lane-capability-reconcile"`: `task:reconcile-lane-capability-misbind-rebound` (`{ outcome: "rebound", taskId, priorAgentId, nextAgentId, column, candidateCount }`) when the card moved to an auto-eligible lane via the `updateTask({ assignedAgentId })` assignment seam; `task:reconcile-lane-capability-decline-frozen` (`{ outcome: "frozen", taskId, priorAgentId, column, code, candidateCount: 0 }`) once per card when no eligible lane exists — the freeze is the named `lane-capability-mismatch` external block, so a re-runs-stable sweep emits it at most once across passes; and `task:reconcile-lane-capability-misbind-no-action` (`{ outcome: "suppressed", suppressedCount }`) at most once per pass when candidates existed but every one hit an absolute guard (live session, pause, user-pause, existing freeze). Metadata is ids/counts/fixed enums only — never decline prose, policy text, or errors. Live-session, paused, and user-paused cards are never touched and no lifecycle column move ever happens; branch, worktree, and step progress survive the rebind by construction. Shape is pinned by `packages/engine/src/__tests__/self-healing-lane-capability.test.ts` and `packages/engine/src/__tests__/lane-capability-reconciliation.pg.test.ts`.

### The planning fence that terminalized a card it should have retried (RUFU-288)

`task:reconcile-planning-fence-park` is written once per automatic planning re-queue of a card the durable principal fence refused, and `task:reconcile-planning-fence-park-no-action` once per parked card this pass examined and deliberately left alone. The pair exists because the failure they recover was previously indistinguishable from a planning defect: a `pg_advisory_lock` grant timeout was re-wrapped as `workflow-principal-fence-unavailable:triage`, matched no classifier, spent triage's whole recovery budget on an identical refusal, and left the card terminal (`PLANNING_FAILED_EXHAUSTED: … last error: workflow-principal-fence-unavailable:triage`, planning failure cleared) carrying an authoring verdict for an infrastructure refusal. Since RUFU-288 the same refusal is retried with backoff inside a dispatch, re-probed across dispatches by the `reconcile-planning-fence-parks` sweep (startup + maintenance batch 1, after the planning-admission-stall pass), and named to the operator by the `planning-fence-unavailable` wedge descriptor while it waits.

Both rows carry the same metadata — `{ taskId, column, stalenessMs, requeueCount, requirement, outcome }` — through the FN-9175 bounded seam under `agentId: "self-healing"` and a synthetic `runId`, so a slow or hostile audit sink can neither fail the repair nor delay the re-queue. `requirement` is the recovery-relevant axis: `lock-transport` (the per-task planning lifecycle lock timed out or failed — the RUFU-288 incident class), `store-unavailable` (a non-lock dependency broke underneath the fence), `cause-unknown` (the fence refused with no readable cause, which includes a card terminalized by a build that persisted no marker and whose surviving sentence named only the fence family). It replaces the free-form refusal sentence rather than duplicating it, so the incident class is countable without storing error text; the sentence itself, the carried cause, branch tips, and any error message are never recorded. `requeueCount` is the surviving half of the automatic budget: it is counted **across** dispatches, so a permanently broken fence cannot loop a card back into planning forever, while triage's own `attempt` stays bounded **within** one dispatch. Both live in `planningFailure.principalFence`, and the marker is an episode record only — no read path or badge derives from it, so a card that has moved on carries it inertly.

`outcome` is the discriminator that makes the no-action row worth querying, and it is a fixed enum: `requeued` (the mutation row's value), `fence-still-unavailable` (the probe itself refused, so the park stays — deduped per card, requirement, and re-queue count, because a sustained outage otherwise records one row per pass while hiding whether any card is still affected), `live-session`, `operator-held`, `auto-merge-off`, `workflow-unresolvable`, `lane-vocabulary-unreadable`, `left-planning-lane`, `requeue-budget-exhausted`, and `raced` (the lane move, pause, forced retry, or another writer got there first inside the task advisory lock). A genuine authoring exhaustion is never selected by this sweep at all — it stays in the generic `terminal-failed` lane with its existing auto-recovery — which is what makes the fence row a signal rather than a matcher that fires on every planning failure.

**The operator-visible half of the pair.** While a fence park waits, the card is alertable through its own wedge descriptor, `planning-fence-unavailable`, with a cause sentence that names the requirement and the transport detail (`timed out waiting for another planning pass on this card to finish (planning lifecycle lock acquisition timed out after 5000ms)`) instead of the raw engine sentence. Two decisions in that descriptor are load-bearing. It is a **new** descriptor class, so the generic `terminal-failed` alert ladder — including the automatic-recovery budget that withholds all failure-alert channels while retries are owed (see [`docs/agents.md`](agents.md)) — is untouched and a genuine planning defect still pages exactly as before; and the alert is **not** suppressed while automatic recovery is owed, because unlike a budgeted terminal park there is no re-dispatch coming to prove an attempt — the card waits in its planning lane for a re-probe — so withholding the alert would have made this class less visible than the one it replaced. Suppression is kept only for its genuine owners: a live planning retry, an already-surfaced planning stall, and a terminal planning park. The descriptor is derived from the park shape and not from the marker alone, which is what lets it name a card stranded by a build that persisted no marker at all; a card that has moved on, and prose that merely mentions the fence, yield nothing. The alert also has no retry-ladder twin: the `task:review-stall-*` ladder refuses to terminalize this class, so `in-review-stall-deadlock` can never freeze a card waiting on the fence. Shape is pinned by `packages/engine/src/__tests__/self-healing-planning-fence-park.test.ts`, with the refusal-side classification in `packages/engine/src/__tests__/triage-planning-fence-failure.test.ts` and the operator-facing sentence in `packages/engine/src/notification/__tests__/task-wedge-planning-fence.test.ts`.

### The planner refused its own deterministic output twice (RUFU-485)

`task:deterministic-spec-rejection-parked` is written once when planning stops after the deterministic spec checker refused the SAME verdict twice in a row; `task:reconcile-deterministic-spec-rejection-parks` is written once per automatic re-admission of such a card, and `task:reconcile-deterministic-spec-rejection-parks-no-action` once per parked card the owner sweep examined and deliberately left alone. The three exist because the failure they describe was invisible in three different ways at once. RUFU-482's planner wrote a scanned-section note whose path token ended in an ellipsis, the checker refused it verbatim, the planner regenerated the identical sentence, and the card then spent a bounded retry cadence, a Plan Review replan charge, and one of its three re-seed cycles on copies of the same input before landing `failed` with `recoveryRetryCount: null` and `nextRecoveryAt: null` — a state whose error sentence named a remedy no automated lane could take, whose retry fields named no owner (triage discovery excludes `failed`, the stranded-hold sweep answers `retry-owned` for any failed card, and the recovery-owner read can only report "no owner" from two nulls), and whose wedge copy told the operator to inspect the error. Its author and its reviewer each waited for the other.

The park row carries `{ taskId, rejectionIdentity, rejectionCount, outcome: "parked" }` — ids, a digest, a count, and a fixed outcome. `rejectionIdentity` is the hash of the deterministic verdict alone, never the whole specification: this branch is reached only when the planner rewrote the artifact, so a spec-wide digest in the identity would make every reachable refusal a new episode and the bound unreachable over the exact shape it was written for. Two parks for the same card can therefore be joined on `rejectionIdentity` to answer "did it really refuse the same thing again?", which the diagnostic sentence answers only for one card. The diagnostic, the spec fingerprint, and the refused spec content never enter the audit store — they live on the card's History line and in its `sourceMetadata.deterministicSpecRejection` episode, which is where an operator reads them. The park consumes no re-seed cycle and writes no column: `PLANNING_RESEED_CYCLE_EXHAUSTED:` remains the disposition for a failure that DRIFTS from refusal to refusal, and folding the two together is how a deterministic refusal gets read as an unbounded-retry planning defect.

The owner sweep's premise is content, not elapsed time: a deterministic checker is a function of the specification, so unchanged bytes guarantee the same verdict and a re-admission would spend a planner session to learn nothing. It re-reads the authoritative `PROMPT.md` and fingerprints it with the same normalization the refusal recorded, re-admits (`status: "needs-replan"`, `error: null`, borrowed retry counters cleared, no column move) exactly ONCE per distinct content by stamping the repaired bytes into the episode, and refuses everything else through a fixed enum: `spec-unchanged`, `already-repaired` (this content already spent its one re-admission), `spec-unreadable` (a premise that cannot be read never parks the card deeper — the sweep's only write is a repair), `live-session`, `operator-held`, `auto-merge-off`, `lane-vocabulary-unreadable`, `left-planning-lane`, and `raced`. No-action rows are deduped per card and outcome, and a successful repair drops the card's withheld memos so a later park can report a fresh refusal. The pair deliberately stays out of the curated delivery-pipeline tables — the same precedent as `task:planning-reseed-cycle` and `task:planning-admission-stalled` — and is found by mutation type. While a park waits it is alertable through its own wedge descriptor, `deterministic-spec-validation-exhausted`, which is a new class rather than the generic `terminal-failed` one precisely because that generic key is what makes automatic recovery claim a card it can only re-refuse, and the withholding rule then suppresses the only message that named the fix. Shape is pinned by `packages/engine/src/__tests__/deterministic-spec-park-ownership.test.ts` and `packages/engine/src/notification/__tests__/task-wedge-deterministic-spec.test.ts`, with the authoring side in `packages/engine/src/__tests__/triage-deterministic-spec-identity.test.ts`.

### Worktree registrations nested inside a scratch tree (RUFU-290)

A `git worktree add` whose target sits **inside** another registered worktree is invisible to every directory walk, because the child is not an entry of any sweep root — it is an entry of the parent's tree. The two reapers that can see it therefore read the registration inventory (`git worktree list --porcelain`) instead of the filesystem: the registration-driven half of `cleanupStaleTempMergeWorktrees` reaps nested scratch children deepest-first while the parent clean-room is still alive, and the landing lane's nested leg reaps what sits below the exact path a landing just force-removed. Four rows describe that surface, all outside the curated delivery-pipeline catalogue, all through the FN-9175 bounded best-effort seam so a slow or hostile sink can neither change what was reaped nor delay a landing.

`worktree:tempdir-sweep` is the per-path row and gained three `reason` values with this pass: `nested-registration` (a registration below a scratch authority was deregistered), `outside-containment` (a scratch-shaped registration — its own entry name or an ancestor segment is `.ai-merge` — sits outside every Fusion authority, so it is **reported and never touched**; the inventory is repo-global and this sweep's authority ends at Fusion's scratch roots, which is what keeps 80-odd unrelated worktrees on a shared common dir out of reach), and `registration-residue-pruned` (the child's directory was already gone and `git worktree prune` cleared the record). Paths stay on these rows only.

`worktree:merge-temp-nested-removed` and `worktree:merge-temp-nested-deferred` are the aggregate counters, one pair per owning scratch entry so the row names the authority that admitted it: `{ authority: "clean-room-root" | "tmpdir" | "task-worktree", foundCount, removedCount, failedCount }` and `{ authority, deferredCount, deferredReason: "active-session" | "resume-reserved" }`. A deferral is announced because it is a deliberate decision to leave a registration in place under a live session or a resume reservation; entries under the age floor are counted, not announced, since one row per pass per fresh clean-room would be noise and the enumeration half is silent for the same class.

`worktree:post-landing-nested-registration` is the only row that can show a **landed** card still leaking registrations, which is the failure mode a forced parent removal creates: deleting the parent tree recursively removes the child's directory without deregistering it. Metadata is `{ foundCount, removedCount, residuePrunedCount, residueRemainingCount, failedCount, deferredCount, deferredReason?, outcome: "cleared" | "partial" | "deferred" }`, where `residuePrunedCount` counts records whose directory vanished with the parent and prune then cleared, and `residueRemainingCount` is what the re-read still finds. Outcome precedence is failure → deferral → residue: a deferred child is also still registered, so testing residue first would make `deferred` unreachable and would label a deliberate safety decision as a partial cleanup. Nested cleanup never changes the merge outcome — a non-`cleared` row means an actionable leak, not a failed landing. Workspace lanes report per-member tallies combined into one row **before** task-directory retirement branches, because one preserved sibling repository stops retirement while a sibling that *was* removed can still have leaked. Paths, branch names, verdicts, and error text never enter metadata.

What these rows are **not** is a capacity signal: reaping a phantom registration frees no `maxWorktrees` unit, because worktree capacity derives from persisted task rows and the in-memory holder registry, neither of which consults the registration inventory (see [`docs/architecture.md`](architecture.md) → "Worktree and naming helpers"). Shape is pinned by `packages/engine/src/__tests__/worktree-nested-registrations.test.ts`, the sweep halves in `packages/engine/src/__tests__/self-healing-tempdir-sweep.test.ts` and its `.real-git.test.ts` sibling, and the landing leg in `packages/engine/src/__tests__/post-landing-worktree-cleanup.test.ts`.

### The branch-conflict park a card carried into `done` (RUFU-439)

`task:reconcile-terminal-branch-conflict-park` is written once per terminal-lane card whose
`branch-conflict-unrecoverable` park this pass re-proved dead. The event exists because the relief was
structurally unreachable rather than merely slow: `reclaimSelfOwnedBranchConflicts` — the only sweep that
owns this park — builds its candidates from the `hold`, `countsTowardWip`, and review lanes and never
reads a `complete`-role column, so a card that reached the terminal lane while wearing the badge had no
automated claimant at all. Six cards sat in `done` for ~23.4 days on an error naming a worktree that
existing nowhere in git; the upstream attribution defect that created false parks was separately fixed
(`cae9a8c398`), and a fix to a decision clears nothing that the decision already parked.

The clear is **in place and only in place**. The sweep writes `{ status, error, paused, pausedReason }`
plus pause accounting and never writes `column`, so lifecycle containment holds: `done` stays terminal and
the deliverable is the badge's disposition, not a relocation back into execution. What makes the write
safe is that it is earned per card, at execution time, from evidence a sweep may not assume: the branch
ref must probe `absent` through the tri-state `show-ref`-based probe, AND a full
`git worktree list --porcelain` read must find no registration for it. A probe that FAILS is `unknown`,
never absence — every pre-existing worktree-list helper in the engine swallows its error and returns an
empty inventory, so none of them can serve as absence proof, and this sweep reads the inventory itself for
exactly that reason. A card whose premise is still live, a card parked by an operator
(`userPaused`), a card wearing any other `pausedReason`, and a card in a non-terminal lane are all left
byte-identical and emit no row.

Metadata is `{ taskId, column, priorStatus, outcome }` with the single fixed outcome
`stale-park-cleared`, emitted through the FN-9175 bounded seam so a slow or hostile sink can neither
change the clear nor delay the pass. The branch name, the park's error sentence, and the worktree path are
deliberately absent, and `stale-park-cleared` is worded to claim only that the badge's premise died: it is
never a delivery verdict. That distinction is measured, not theoretical — of the six cards, zero had any
commit whose `Fusion-Task-Id` trailer named them (the only commits mentioning two of the ids carried other
ids' trailers), so no closure on these cards could have rested on a delivery claim even though a grep for
the id strings would have looked productive.

### Declined review remediation narration (RUFU-351)

`task:review-remediation-declined` records the refusal to schedule a fix round for a failed pre-merge review gate. Before it existed the refusal was an `executorLog` line and nothing else, so a card could sit in review for days — holding its branch, worktree, and file-scope lease — while its History tab still read the reviewer's old `REVISE` sentence as though a round were coming. Metadata is the closed set `taskId`, `column`, `code`, `gate`, `scannedCount`; `code` is one of `operator-task-hold`, `checkout-unavailable`, `revision-budget-zero-or-invalid`, `revision-budget-exhausted`, `producer-refused`, `skipped-without-narration`, `recovery-threw`. `target` and `taskId` are the declined card, `agentId` is the synthetic `self-healing`, and `runId` is synthetic (`review-remediation-declined:<taskId>`) because no agent run refused anything — the sweep did. The decline sentence, reviewer findings, gate prose, and error text never enter the row; the sentence lives on the card's History line, which is the surface an operator actually reads. Emission is the FN-9175 bounded seam, and the card-log write is attempted first and fails soft: an unwritable History must not cost the operator the audit row, and must not abort the pass for the remaining candidates.

Two rules bound the noise, both mirroring RUFU-273's report-only discipline:

- **Honest absence.** A round that *scheduled* work writes no sentence and no row, and a card the sweep never declined writes neither. Absence is the signal that remediation is running, so it is never filled with a placeholder; symmetrically, `skipped-without-narration` and `recovery-threw` exist precisely so that "we do not know why" is fail-visible instead of silent. That code keeps its meaning only because the recovery helper marks the same witness at **every hand-off to an owner that narrates**: the empty-review terminal close (`No reviewable content — terminal park recorded for <step>`) and the convergence ladder's human-escalation rungs (`Review convergence exhausted — awaiting operator action`, `Review convergence stopped — no pending remediation work`) each write their own durable card sentence and still return `skipped`, so an already-explained card must not also read as an unexplained decline. The ladder's silent `"declined"` hand-off is the one that leaves the witness alone, because there the silence is real.
- **One narrator per condition.** A decline already narrated by its owning surface stays engine-log-only: `lane-mismatch`, `auto-merge-ineligible`, `paused`, `terminal-status`, `executing` and `no-failed-step` are operator-visible by construction, while `no-verdict-owned`, `convergence-ladder-owned` and `blocker-family-mismatch` belong to the verdict-less re-seed pre-pass, the convergence ladder's stage-3 escalation, and the merge-PR blocker surface. This is why the graph-terminal leg keeps its own long-standing sentence (`… — remediation was not scheduled`) and gained no new one: a second explanation on one card for one condition is the defect, not the fix. That no is pinned as a **no-regression guard** in `packages/engine/src/__tests__/self-healing-review-remediation-declined.test.ts` — it is not symptom proof and must not be read as such. Forensics on the motivating card measured that the graph leg had already narrated it durably while the operator was reading a different surface.

The deduplication mechanism is a single narration witness per candidate, declared once before the delegated recovery is called: a recovery that narrates its own decline sets the witness and the sweep's fallback stays silent. Re-declaring the witness inside the `try` shadows it and makes the `recovery-threw` guard structurally inert, which the sweep's FNXC note names explicitly. The witness is a record that **the card is explained**, not a log of one function's own writes, so the helper sets it in its narrated-decline seam *and* at each delegated hand-off whose owner narrated (see Honest absence above); the earlier narrower marking made the sweep overwrite an empty-review terminal park or a convergence escalation with a false "card left in review" line plus a false `skipped-without-narration` row. Production always wires the typed recovery, and that lane is what the witness guards; a runtime wired to the legacy boolean callback has no witness channel, so a decline it hides still surfaces as `skipped-without-narration` — fail-visible by design.

Shape is pinned by `packages/engine/src/__tests__/self-healing-review-remediation-declined.test.ts` (narrated classes, silence classes, witness dedup, one audit row per decline, hostile card log) and by the refusal-text leaf rows in the same file that pin the exact operator sentence.

## Durable-agent error-state

Events that make durable-agent error states and their recovery inspectable.

| Event | What it records / when it fires |
| --- | --- |
| `agent:auto-recover-error-state` | A recoverable, non-operator-actionable durable-agent error is cleared by the heartbeat/self-healing sweep and retried. |
| `agent:reset-error-state-on-startup` | An engine restart clears an eligible durable-agent error/exhaustion park and re-arms the heartbeat (startup-only). |
| `agent:error-retry-exhausted` | A durable-agent error retry budget is exhausted and the agent is parked `paused` with pauseReason `error-retry-exhausted`. |
| `agent:error-parked-unrecoverable` | An operator-actionable durable-agent error parks the agent `paused` with pauseReason `error-unrecoverable` for human repair. |
| `agent:heartbeat-move-skipped-soft-delete` | A heartbeat move races a soft-deleted task and is skipped without parking the durable agent. |
| `agent:unresponsive-recovery-cancelled` | An `unresponsive-recovery` episode, or the recovery wake it queued, stood down because run history proves the agent is alive. Metadata is ids and timestamps only: `agentId`, the `stuckRunId` that stopped ticking, the `completingRunId` that closed completed after it, that run's `completedAt`, and `reason` (`episode-start` at the decision, `queued-wake-fire-time` when the wake fired only after a clean completion landed). |

`agent:throttle-cooldown-armed` records the heartbeat arming one bounded re-probe after a run failed on a
provider throttle envelope (HTTP 429 `rate_limit_error` / `Rate limit exceeded` / `~~429~~`) rather than
parking the agent. Metadata is ids/counts/fixed enums only: `agentId`, the shared attempt count `attempt`,
the `limit`, the computed `backoffMs`, and fixed `source: "run-failure"`; the provider envelope, model
identifiers, and account text never enter the row. The row is written once per arming failure — subsequent
failures in the same episode raise the streak and widen `backoffMs` on the floor-doubling-cap ladder, and
an exhausted budget parks `error-retry-exhausted` (the sibling row above) instead of re-arming. While the
cooldown is live, heartbeat run entry skips the run with `resultJson.reason: "throttle-cooldown"` and emits
no audit row of its own — the wait is already represented by the arming row plus the agent's own recovery
metadata (`agent-heartbeat-throttle-cooldown.test.ts` pins both). The skip deliberately consumes no unit of
the shared retry budget; only a re-probe that actually runs and fails does. The write uses the FN-9175
bounded best-effort seam, so an absent, throwing, or hanging audit sink can neither delay the failure path
nor turn a transient throttle into a durable park, and the event is intentionally outside the curated
delivery-pipeline event catalogue.

## Idle heartbeat backoff (RUFU-268)

`agent:heartbeat-idle-ladder` records one CHANGE to an unassigned agent's idle streak — not one row per
deferred tick — so a long idle episode costs a handful of rows. Metadata is ids/counts/a duration only:
`agentId`, `outcome` (`advanced` when an acknowledged no-work heartbeat stretched the cadence, `cleared`
when a run found work), `priorStreak`, `streak`, and the resulting `stepMs` (0 on a clear). The row is
written from the single ladder writer (`recordAcknowledgedCompletion`), which is also the only place that
touches `runtimeConfig.heartbeatIdleStreak` / `heartbeatLastNoWorkAt`, so the row and the persisted row
cannot disagree about which rung the agent sits on. The write uses the FN-9175 bounded best-effort seam: an
absent, throwing, or hanging audit sink costs at most one idle episode's telemetry, never a dispatch. The
pair to read alongside it is the heartbeat run's own `resultJson.reason`:

- `idle_preflight_noop` — an admissible idle tick (timer source, no assignment at run start, and a delta
  confined to the auto-claim candidate table) was answered by the compact one-line question and spent no
  heartbeat session. The row still carries `heartbeatDoneAccepted` and the `wakeCursor` the next tick proves
  its silence against, so a cheap tick is as well-attested as a full one.
- a missing reason on a completed no-task run means the full path ran, which is what every non-idle outcome
  (assigned work, an unread message, a room entry, a new steering comment, an ambiguous or failed compact
  answer, a manual wake) still does.

The event is deliberately outside the curated delivery-pipeline event catalogue and documents as prose
here.

## Event-driven dispatch latency

`task:dispatch-latency-observed` (FN-519) answers "why did this card wait?" after the fact. Before
it, the binding gate existed only in a log line persisted nowhere, so a stall could not be attributed
to any of its five possible causes: a deliberate added wait, necessary I/O, real contention, a
missing signal, or provider latency.

Metadata is ids, bounded enums, and one duration only: optional `taskId` and `nodeId`, plus
`wakeOrigin` (`local-publication`, `remote-notification`, `capacity-release`, `owner-cleanup`,
`catch-up`, `periodic-backstop`), `phase` (`admission`, `claim`, `session-preparation`,
`node-entry`), `outcome` (`claimed`, `refused`, `no-candidate`), an optional rounded `observedMs`,
and an optional fixed `reasonCode` (`capacity`, `worktree-capacity`, `paused`, `awaiting-approval`,
`dependency`, `external-block`, `planner-live`, `deferred-deadline`, `lost-claim`,
`transport-degraded`). It never contains prompts, titles, task content, reviewer prose, error text,
blocker prose, connection URLs, or secrets.

Two reading notes. A `wakeOrigin` of `periodic-backstop` in a row means the EVENT path did not
deliver, which is the signal that a wake was lost or a transport is degraded; a `reasonCode` of
`transport-degraded` names that condition explicitly rather than leaving it silent. `observedMs` is a
wall-clock observation within ONE process and is never a duration computed between unsynchronized
clocks, so cross-process figures are presented as observations rather than measured latencies.

Emission uses the FN-9175 bounded engine seam (`emitBoundedRunAudit`) and is deduplicated on a
stable `(task, node, phase, outcome, reasonCode)` signature — deliberately excluding the duration, so
a persisting refusal collapses to one row while a CHANGED refusal reason is always reported and a
claim is never suppressed. It is never awaited before a claim or a handoff: the diagnostic that
measures dispatch latency must not be able to create any. Hostile-sink behaviour at the owning call
site is covered by `packages/engine/src/__tests__/dispatch-latency.test.ts`.

### The reviewer attempt that outlived its session (RUFU-559)

`task:reconcile-stranded-reviewer-runs` records one pass over reviewer attempts that are still occupying a
card's live slot after the liveness floor. A reviewer run row used to have no liveness reconcile at all, so an
attempt whose session died with the engine stayed `status='running'` indefinitely — measured on production: 275
such rows, not one of them live, the oldest 19 days old, with 20 in-review cards held by one. Because the review
dispatch sweep derives its anti-loop budget from those committed rows, a zombie reads as an unfinished attempt
and the stall classifier disposes the card as `completed-review-status-none`; every guard in the chain was
behaving correctly while the whole review lane sat still.

Age only selects a candidate. Death is proved with the canonical liveness triple (active session registry paths
for the task, the executing-task lock, `isTaskActive`), and the row is never deleted: it takes a terminal status
through the ledger's one-way completion, so a verdict that lands during the pass wins and the pass reports
`already-settled`. The close reason carries the shared `engine-lost:` prefix, which is also the prefix exempted
from the dispatch attempt budget — an attempt the engine orphaned was never an attempted review, and counting it
would turn "stranded" into "attempts exhausted, parked forever". Metadata is ids/counts/fixed enums only:
`taskId`, `reviewerRunId`, `reworkRound`, `stalenessMs`, `outcome` (`closed` / `already-settled` /
`live-session` / `unparseable-start`), `source`. The registered sweep runs at startup and in maintenance batch 2,
alongside `reconcile-orphaned-pending-step-results`, whose FN-8492 rules it deliberately mirrors.

### The heartbeat review that had nowhere to publish (RUFU-531)

`task:review-verdict-recorded` is emitted once per heartbeat-lane review verdict that actually persisted a
pre-merge `code-review` row. The event exists because the lane previously had no verdict surface at all: U10/R9
deleted `fn_review_step` and nothing replaced it, so a reviewer could finish a real review and publish nothing.
The card kept its `no recorded code review verdict` merge blocker, the dispatch sweep counted each wake as a
`stalled-attempt`, and three wakes parked the card - while `agent-log.jsonl` held the completed reviews (RUFU-259:
six finished reviews, zero verdict rows). The row is what makes that class countable instead of anecdotal: N
`completed` wakes for a card with zero `task:review-verdict-recorded` rows and a `pending` gate is the signature.

Emission is the FN-9175 bounded seam (`emitBoundedRunAudit`, never `createRunAuditor`), under the reviewer's own
agent id and the wake's run id, so an absent, throwing, rejecting, or hanging sink cannot change the recorded
verdict. The row is written only on the `recorded` disposition - a refusal (`archived-carrier`, `content-drift`,
`already-proven`, `verdict-contradiction`, `fingerprint-unavailable`, `tip-state-unavailable`,
`workspace-unsupported`, `worktree-missing`, `no-live-gate`, `gate-not-pending`, `revise-without-finding`,
`task-not-owned`, or a `no-writer` / `fence-refused` / `aborted` / `scope-superseded` / `persist-error` persist
disposition) records
nothing here, because those outcomes are already carried on the card's History line and would otherwise double-count
a review that never delivered. That closed set is declared once, as `ReviewVerdictRefusalCode` in
`packages/engine/src/review/record-review-verdict.ts`; every guard arm names exactly one of them and none is a
fall-through.

The same seam also answers the wake-side question, so the refusal classes are visible before an agent spends a turn
on them: a task-scoped heartbeat wake asks `heartbeatReviewVerdictGateOpens` and injects `fn_record_review_verdict`
at all only over a live, non-workspace, non-superseded pre-merge `code-review` row that is `pending` or verdict-less
`failed` and carries neither `reviewInputFingerprint` nor `remediationArchivedAt`. An agent that finishes a review
and finds no such tool is being told one of those five things about its card - the sentence it must report, rather
than a verdict it cannot write.

Metadata is ids and fixed enums only: `taskId`, `reviewerAgentId`, `verdict` (`APPROVE` / `APPROVE_WITH_NOTES` /
`REVISE`), `fingerprintState` (`fingerprint` when the review-input digest bound, `empty` when the branch genuinely
delivered nothing and the row carries the shared `empty-review-input:v1` sentinel, `absent-revise` when the probe
could not measure and only a blocking verdict was writable), and `ledgerClosed` (true only when this call settled
this card's live reviewer-run row). The fingerprint digest itself, the one-line summary, the findings, and any error
text stay on the durable step row and never enter run-audit - reviewer prose in a store that anything with query
access can read is exactly the leakage rule this event honors. Like RUFU-279's `memory:*` trio and RUFU-462's
`runtime:heap-ceiling`, the event is declared in the engine's `DatabaseMutationType` but deliberately outside the
curated delivery-pipeline catalogue table above, which `run-audit-catalogue.test.ts` locks table-for-table.

## Review-lane decline attribution (RUFU-478)

`task:review-dispatch-declined` records the one review-lane state an operator could previously read only in a
log file: a project whose review lane has cards waiting and **no enabled reviewer to hand them to**.
`ReviewDispatchSweep` already said it out loud — `E4: no enabled reviewer agent exists; review-lane cards stay
undispatched by design.` — on a 5-minute cooldown, and wrote nothing durable. Measured on a deployed node: 214
identical warn lines across ~7 hours, none naming a project, while 12 of 24 projects genuinely have no enabled
reviewer agent. That made an operator's *configuration* state indistinguishable from a dead engine, and after
log rotation the evidence was gone entirely.

The row is written once per project episode, from `runPass()` immediately after the reviewer pool resolves,
and deduped on `(projectId, reasonCode)` — a lane that stays unconfigured for a week costs one row, not one
per 15 s tick. When the same sweep later resolves a NON-empty pool the episode is cleared, so a project whose
reviewer was enabled and then removed produces a NEW row instead of being suppressed by its own first episode.

`target` is the **project id** and `task_id` is **NULL by design**: the decline belongs to a project, not a
card, and a card-scoped row would make "which projects" a scan over every waiting card. A host whose store
cannot name a project falls back to the stable literal `unknown-project` rather than an empty string, which
would satisfy the NOT NULL column and still be unattributable. Metadata is ids, counts and one fixed reason
code: `reasonCode` (the only live value is `no-enabled-reviewer`), `enabledReviewerCount`, `waitingCount`, and
`candidateTaskIds` capped at 20 in the sweep's own oldest-waiting-first order. **No reviewer names, roster
contents, warn sentences, or error text are ever recorded** — configuration prose in a store anything with
query access can read is the same boundary every other row here honors.

Two absences make the row trustworthy rather than decorative. A decline always means a waiting card: the pass
returns before the pool is ever resolved when the candidate list is empty, so `waitingCount` is a measured
queue depth and an idle lane writes nothing. And a broken roster read is never reported as a configuration
gap: the pass has no try/catch around the pool resolution, so a rejecting `listAgents()` leaves the tick before
this row can be written (`review-dispatch-decline-attribution.test.ts` pins both).

**Which seam writes it, and why that is not an implementation detail.** The recorder awaits
`emitBoundedRunAuditWithOutcome`, the *outcome* lane, whose write is direct and settles before the tick
returns. The `dispatch-latency.ts` recorder one file away deliberately takes the *void* lane instead, because
its whole contract is "never delay the lane it measures" — and since RUFU-453 that lane hands the row to the
sink drain, so an accepted emit is **not yet a durable row**. Here the record's entire value is being queryable
after the fact, which is the same reason the `store:open` provenance row chose the awaited variant. The await is
bounded at 2 s and deduped to one write per episode, so it adds no per-tick latency, and the sweep never
branches on the result — telemetry still cannot change a dispatch.

The operator queries, both directions:

```sql
-- Which projects' review lanes cannot run, and since when?
select target, min(timestamp), max(timestamp), count(*)
  from project.run_audit_events
 where mutation_type = 'task:review-dispatch-declined'
 group by target
 order by max(timestamp) desc;

-- Is THIS card sitting behind a decline, and which project owns it?
select target, timestamp
  from project.run_audit_events
 where mutation_type = 'task:review-dispatch-declined'
   and metadata->'candidateTaskIds' @> '["RUFU-0000"]'::jsonb;
```

Read the row as **diagnosis, not repair**. The fix is an operator action in Agents — create or enable a
reviewer for that project — and the engine deliberately does not paper over the gap by inventing a reviewer or
routing the review elsewhere. A project with two or more enabled reviewers dispatches (since RUFU-530 every
enabled reviewer is a slot), so it writes no decline row; `multiple-enabled-reviewers` was never emitted and is
retired, so it is not a "missing" arm waiting to be re-added. Like `task:review-verdict-recorded`, RUFU-279's
`memory:*` trio and RUFU-462's `runtime:heap-ceiling`, this event is declared in the engine's
`DatabaseMutationType` but deliberately **outside** the curated delivery-pipeline catalogue table above, which
`run-audit-catalogue.test.ts` locks table-for-table — that is why it is documented here as prose and not as a
table row.

## Suspended-run diagnostics

`task:workflow-run-suspended` is emitted by the executor whenever a graph run ends in the `suspended`
disposition. It carries no task error by design, so it is the only durable trace of a card that waits at
the same node on every dispatch. Before RUFU-372 the row named the node and a `reason` of `capacity` and
nothing else, which made a board that suspended 185 times in an hour across 27 cards countable but not
diagnosable: a full WIP pool, a full worktree pool, and a scheduler-owned seam all read identically.

Two additions make the row answer the question instead:

| key | meaning |
|---|---|
| `suspendSource` | Fixed enum naming the refusal that parked the run: `scheduler-seam` (a hold→wip boundary the scheduler owns — no capacity pool was consulted at the seam itself), `column-capacity` (a real `capacity-exhausted` transition rejection), or `capacity-rejection-without-facts` (a rejection written before this change or restored from a payload that dropped the block). |
| `capacityColumn`, `capacityOccupants`, `capacityLimit` | The gate that refused and how full it was, forwarded from the refusal's structured `CapacityRejectionFacts` (the moving task is excluded from `occupants`). Present only on a real pool refusal — they are the refusal's own numbers, never a later recount. |
| `reason` | The deferral class, from one shared vocabulary: `capacity` (a transient resource refusal whose remedy is to wait for a slot), `scheduler-owned-seam` (a structural hold→wip crossing only the release sweep may make), `pause`, `hold`. Before RUFU-372's second revision the first word covered both, and measured 2026-11-02 that mislabelled 98 of 152 rows on a card whose project held zero in-progress cards. |
| `capacityGate` | WHICH ceiling bound: `columnWip` (an explicit per-column WIP config), `schedulerAgentActive` (the assigned agent is active and already at its `maxConcurrentRuns`), `maxConcurrent` (the cross-project read-through ceiling), or `unknown`. It names the knob an operator can turn, which the counts alone never identified. |
| `capacityUsed` | Occupancy at the measurement instant — the refusal's own triple on a refusal row, one live snapshot elsewhere. `null` when no gate binds. |
| `capacityHeldBy` | Holder ids, capped at **5** on this row (`CAPACITY_HOLDER_ID_CAP`). The durable park episode on the card carries a wider cap of 20 (`WIP_ADMISSION_HOLDER_ID_CAP`) — a different surface with a different bound, so size a "who holds my slot" query off the row's 5. `[]` means the pool was consulted and is genuinely empty; the key's ABSENCE means holders were never recorded. Those two sentences are different claims and the card face renders them apart. |
| `capacityOldestHolderAgeMs` | Age of the longest-held occupant, or `null`. Answers "is a slot busy or just wedged?" — 5 s old is normal churn, 2 d 19 h is the incident shape. |
| `capacityComputeOutcome`, `capacityStoreOutcome`, `capacityAgentGateError` | Fixed enums describing how much of the snapshot could be taken at all: `complete` / `partial` / `timed-out` / `threw`, `ok` / `failed` / `not-required`, `store-rejected` / `unavailable`. The failure of the diagnostic is itself reportable, because a diagnostic that fails silently is what left 185 rows unanswerable. `unavailable` means no agent ledger was reachable at all — agent rows live on `AgentStore`, never on the `TaskStore` the other inputs come from, so both production wirings resolve a reader explicitly (the executor's own store, else the task store's `getIntakeOwnerAgentStore()`); a row that says `unavailable` names missing wiring, not an empty agent set. |

The keys are emitted by ONE site (`execute-workflow-graph.ts`'s suspended branch) through the bounded
wrapper, which owns a wall-clock bound, never rethrows, and resolves its own store/settings/IR reads inside
that bound — a deferral `catch` may perform at most one await and it must be the wrapper's, because in this
file a throw from that catch converts an explain-wait into a terminal `task:graph-failed` park. A refusal
row never re-samples the pool: a second count would describe a different instant than the refusal it
reports. A seam row pays for exactly one snapshot, and `unknown` beside nulls is treated as an answer —
while a `pause` row, a `hold` row, and every structural-hold sentinel row grow no capacity keys at all,
since keys there would claim a limit was consulted when none was. A static scan
(`capacity-gate-facts-call-site-ratchet.test.ts`) forbids both the
raw compute spelling and any direct await of the facts provider.

Two rules keep the surface honest. **Absence is meaningful**: a non-capacity row carries no capacity block at
all — `pause`, `hold`, and the principal-routing / human-merge sentinels. The sentinel test runs on the
marker's `irHash` and BEFORE the reason test, because the reason is not a safe proxy for the class:
the principal-routing and overlap-wait holds suspend with `reason: "capacity"`, and only the human
merge-delivery barrier suspends with `hold`. Classifying on the reason alone therefore gave the principal
sentinel a `capacityGate: "unknown"` beside a row a `reason=capacity` monitor also counts — the exact
misleading-unknown plus inflated-monitor pair this event exists to delete. Inventing `occupants: 0`
for a branch that never asked a pool would be a fabricated measurement.
**Counts describe the first sample of an ongoing wait**: RUFU-442's notice signature stays
over node, reason, and column boundary only, so a card polling a full pool keeps one row rather than one
row per poll. Folding the fluctuating occupant count into wait identity would restore the flood this event
exists to bound — which is also why `capacityHeldBy` and `capacityOldestHolderAgeMs` stay out of it.

### Dedupe authority moved onto the card (RUFU-393)

RUFU-372 made the row diagnosable; it did not make it *bounded*. A capacity suspension is re-observed on every
dispatch, and until RUFU-393 the only bound was an in-process memo (`noteWorkflowRunSuspended`) that a restart
wipes and that puts nothing on the card — so `SKEN-009` recorded **16 536** refusals for the same
`todo → in-progress` crossing across 2 d 19 h at ~3/minute while its `column`, `status` and `updated_at` never
moved. The row is now gated by a **durable episode** on the card itself
(`sourceMetadata.wipAdmissionStall`, written through key-level `sourceMetadataPatch`), and one accepted episode
write accompanies exactly one audit row, so the two surfaces cannot disagree about how many times a wait has
been reported. A repeated dispatch whose episode is unchanged writes neither.

| key | meaning |
|---|---|
| `stallCode` | The gate that is holding the crossing, from the closed vocabulary: `scheduler-seam`, `column-capacity`, `downstream-full`, `move-rejected-or-no-slot`, `no-downstream-capacity-column`, `awaiting-planning`, `awaiting-approval`, `plan-premise-unmet`. Present when this row accompanied an accepted episode write. |
| `stallCount` | How many *records* this one wait has produced — the refresh-floor count, not wall-clock passes. |
| `stallFirstAt` | ISO instant of the first refusal in the episode. Age is read here, never from `task.updatedAt` (RUFU-350's trap: naming a card bumps the shared clock). |
| `stallPoolId` | The capacity pool the refusal was measured against, or `null` when no pool was consulted — the same honest-absence rule as the `capacity*` block above. |

**The bound is arithmetic, not intent**: an unchanged episode re-emits at most once per
`WIP_ADMISSION_STALL_REFRESH_FLOOR_MS` (15 minutes), so one card cannot exceed four records an hour no matter
how often the sweep or a dispatch runs, and one hour of per-minute passes produces exactly four rows
(boundaries at t=0, 15, 30, 45 min) — pinned by test, not by comment. None of these four keys enters the notice
signature: `stallCount` increments on every accepted refresh, and RUFU-442's measured failure was a bound whose
key changed each cycle.

The sweep publishes its own arm verdicts onto the same episode (`publishWipAdmissionHold`), which is why the
code list above carries more members than the graph seam alone can observe: `downstream-full` and
`move-rejected-or-no-slot` are measured by `runHoldReleaseSweep` against the real pool and the in-transaction
move, and they arrive under the graph's node id when a graph episode already owns the signature, so one
identity stays one identity whoever measured it last. Arms with no gate to name — `timer-not-elapsed`, and the
`manual` / `external-event` human waits — publish nothing at all.

**`move-rejected-or-no-slot` means the move, and nothing else** (RUFU-758). The sweep forwards the refusal its
release primitive actually returned, so a card refused by its own plan-premise contract records
`plan-premise-unmet` — the plan document was unreadable, malformed, stale, exhausted, or overtaken by the
card's own delivery. It is neither a pool nor a move: the premise door refuses before any slot is requested,
so the pool facts riding the same episode show the lane with room, and those facts are what make the old
capacity reading refutable from the row alone. `move-rejected-or-no-slot` is now the label for a refusal that
carries no code at all — no reservable slot, the in-transaction capacity-exhausted transition, or a live row
that paused or left its column under the move lock.

The mapping from refusal code to gate is total by construction (`Record<WipAdmissionRejection, …>`), because
the alternative is not a wrong label but silence: `publishWipAdmissionHold` returns before writing anything
when it cannot name a gate, so an unmapped refusal would cost the card its badge, its History line and this
row. `plan-premise-unmet` ranks at PARITY with `downstream-full` and `column-capacity`, and that rank is what
keeps the newest refusal winning — the sweep reports a capacity arm or a release refusal per pass, never both,
so a higher rank would keep advertising a plan problem after the plan had been repaired, and a lower one would
let a single earlier `downstream-full` mask a real premise refusal forever. The episode itself is not a run-audit row and
holds no prose: it is card state, and the parked marker is never a refusal (FN-7648's durable refusals stay
confined to `promoteHeldTask` / `releaseHeldByEvent`).

This event stays deliberately outside the curated delivery-pipeline catalogue and documents as prose here.

Still not carried, and the reason this section is not called a solution: **who holds the slots**. Holder
identity is not in the refusal, so the row answers "which gate, how full" but not "which cards occupy it".

## The release sweep that ran out of budget before reaching the card (RUFU-807)

RUFU-807: `task:hold-release-starved` records one armed card that a truncating hold/release pass never
evaluated. It is a different fact from `task:hold-release-declined`, which reports a card the sweep *reached*
and refused for a named reason — so the pair answers "did the scheduler look at me, and if so, what did it
conclude?", which is the question RUFU-805 could not answer. That card sat in `todo` for five hours with its
plan review armed while every pass truncated past it, and each release surface — `fn task promote`,
`fn_task_promote`, the dashboard move, `fn task retry` — answered that its review "is queued for this card
and will run". Only the first half of that sentence was true.

Prevention ships ahead of reporting: the sweep now orders its budget by partition, evaluating armed
(continuation-backed) cards before the rest, so a card whose plan review is already queued is not competing
for budget with cards that merely sit in a `hold` lane. The read behind that partition is membership, not
content — `TaskStore.listActiveTaskContinuationTaskIds`, bounded and folded into the queue-order read that
already ran, because the planner's own admission gate reads the same continuation table and a costlier sweep
lane was measured to collapse first (RUFU-382: 30 min, 45 rows, zero releases). Partitioning is a priority,
not a budget raise: the per-pass wall-clock bound (`SWEEP_BUDGET_MS`, 10 s) is untouched, and the only new
number is `MAX_ARMED_PRIORITY_IDS` (200) — the cap on how many armed cards the front partition may hold,
not a cap on how many cards the pass evaluates.

Metadata is `taskId`, `column`, the fixed `code` `release-sweep-budget-starved`, `stallCount`,
`unevaluatedCount`, and `oldestDeferredAgeMs` only when the pass could age the deferred tail. The `outcome`
/ `source` / `stallPoolId` block that RUFU-372 added to the *suspend* row is deliberately not replicated:
this pass never reached the card, so it knows no refusal, no gate, and no pool. `target` plus `agentId:
"scheduler"` and a per-card `runId` (`hold-release:starved:<taskId>`) are explicit, because RUFU-430 lost
13 926 rows to a row that could not be found by the usual query.

Cadence is carried by the card, not the process: the episode lives in `sourceMetadata.holdReleaseStarvation`,
written at KEY level through the same discipline as RUFU-393's park, so an unchanged observation re-emits at
most once per 15 minutes and one truncating pass names at most 100 cards — half its own partition budget —
so the diagnostic can never charge more than half the budget it exists to explain (RUFU-871's shape). The
clear is one site for all three lanes the card can leave: any real column change clears the episode at the
core move seam. A Manual Retry clears it as its own first act, alongside RUFU-393's and RUFU-826's markers,
because a fresh budget makes the claim false immediately and an operator who asked for a retry is exactly who
must not keep seeing "not reaching you".

The badge is armed-only by construction: the starved set is the intersection of the truncation tail with the
armed partition, never every held card. Naming all deferred cards would put "the dispatcher is not reaching
me" on every ordinary queue-waiter and kill the signal. And this stall code is deliberately **wedge-silent**
— the card face and the bounded audit row are its surfaces. The wedge discovery path never reaches a
card in a planning lane that writes no `status`/`error`/`pausedReason`, and review-lane delivery revalidation
clears wedges for cards in `hold`-trait lanes, so a wedge would only double-announce in the mailbox a cause
the card already names.

This event stays deliberately outside the curated delivery-pipeline catalogue and documents as prose here.

## Resume-placement coherence diagnostics

RUFU-300: `task:resume-placement-mismatch` records one classified pin/column disagreement observed while an
automatic re-entry decided where to place a run. It exists because the two facts it joins are visible to
nobody else at once: `workflowIrPinColumnId`/`workflowIrPinNodeId` (what the run's pin claims) and
`task.column` (where the card actually is). The measured motivating case, RUFU-292, carried
`workflowIrPinNodeId: "parse"` with `workflowIrPinColumnId: "in-progress"` while sitting `column: "todo"`
for 6 h 33 min — `updatedAt` moving, zero new agent-log lines, and no row, History line, or badge anywhere
recording the contradiction.

Two producers write it, and they are the same seam rather than two opinions: `announceResumePlacement`
on a dispatched graph run (`workflow-graph-executor.ts` / `execute-workflow-graph.ts`), and the
`reconcile-pin-column-coherence` self-healing sweep for a card nobody dispatches — a wedged card emits no
run, so without the sweep the row would exist only for cards that keep getting picked up.

| key | meaning |
|---|---|
| `taskId`, `column` | The card, and its column at the moment of re-entry. |
| `workflowIrPinColumnId`, `workflowIrPinNodeId` | What the pin claims, `null` when that half of the triple is absent — a half-null pin is reported as it is, never guessed at. |
| `placedNodeId` | The node the resolver chose. `null` when the caller keeps its own fallback. |
| `placementSource` | Fixed enum of what justified the placement: `continuation`, `column`, `after-released-gate`, `ledger-progress`, or `start`. |
| `mismatchKind` | Fixed enum: `pin-at-release-seam`, `pin-ahead-of-column`, or `pin-behind-column`. |
| `outcome` | `awaiting-scheduler-release` for the legal seam park, `announced` for genuine incoherence. |
| `source` | `coherence-sweep`, present only on rows written by the self-healing sweep. |

**A legal park is never an alarm, and that distinction is the event's whole shape.** The KTD-2 refusal
(`workflow-column-boundary.ts`) writes the pin *before* it refuses a `hold → wip` crossing, so
`pin(in-progress) / column(todo)` is the designed signature of a card waiting for the scheduler — the only
mover across that boundary. Such a card reports `pin-at-release-seam` with
`outcome: "awaiting-scheduler-release"` and claims nothing about delivery; only `pin-ahead-of-column` with
no live release reason, and `pin-behind-column`, are incoherence. Without the enum every capacity-bound
card would announce forever and the signal would die the way the pre-RUFU-372 `reason: "capacity"` row did.

Bounding follows the `reconcile-stranded-*` convention: one row per `(card, mismatch signature)` episode,
where the signature is `(kind, pinNodeId, pinColumnId, column)` and carries no growth counter, so a
sustained wedge collapses instead of re-announcing per pass. Marking happens *before* the emits, so a sink
that explodes cannot turn a bounded notice into a flood, and a pass with no sink wired consumes no episode
— the first sink-less pass would otherwise swallow every later real announcement. Emission is the FN-9175
bounded seam, so an absent, throwing, rejecting, or hanging sink cannot change the placement.

**Neither event may carry step-result content.** No `workflowStepResults` body, verdict text, review
findings, prompt text, blocker sentence, or error string enters the row; the sentence a human reads lives
on the card's History line. It complements `task:workflow-run-suspended` and never duplicates it: that row
says a run suspended and which gate refused, this row says the card's own pin disagrees with its column
and how that disagreement was classified. The companion notice — the bounded
`[workflow-graph] ... resume skipped released gate(s): ...` History line recording that a placement left a
released gate behind — is deliberately task-log only, because a released gate is skipped on nearly every
resume of a planned card and an audit row per skip is the 185-rows-an-hour flood shape.

The event is intentionally outside the curated delivery-pipeline event catalogue; its shape is pinned by
`packages/engine/src/__tests__/pin-column-coherence.test.ts` and
`packages/engine/src/__tests__/resume-placement-after-passed-gate.test.ts`.

## Planning re-seed ceiling

RUFU-768: `task:planning-reseed-cycle` records one planning escalation for one card, either the cycle
that was granted or the ceiling that stopped it. Metadata is ids/counts/fixed enums only (`taskId`,
`cycles`, `limit`, `outcome` from `re-seeded`/`parked`). Planning transport text, generated spec text,
and error prose never enter the row; the parked card carries its reason as its own task `error` with the
`PLANNING_RESEED_CYCLE_EXHAUSTED:` prefix and a History entry, which is the operator-facing record.
The row exists because the park is the whole point of the fix: without it a stopped card is a plain
`failed` row indistinguishable from any other planning failure. The event is deliberately outside the
curated delivery-pipeline catalogue, following the same precedent as `task:planning-admission-stalled`,
which is why it is documented here as prose rather than as a catalogue table row.

## Planning window outcome accounting

RUFU-1069: `task:planning-window-outcome` records one planning-continuation drain pass over the due window in which the pass examined rows and dispatched none of them. Metadata is counts, ids, and fixed outcome buckets only: `limit`, `examinedCount`, `examinedTaskIds` (capped at 20, order preserved because the order is the rank the store returned), `dispatchedCount`, `capacityDeferredCount`, `claimRefusedCount`, `supersededCount`, `inFlightLeakCount`, `plannerLiveDeferredCount`, `pausedSkipCount`, `approvalSkipCount`, `orphanCount`, `throwCount`, `dueSetTruncated`, `windowHeadTaskId`, `windowHeadItemId`. Error text, card text, prompts, spec text, lease owners, and paths never enter the row; the throw bucket is a count, never a message.

The event exists because the class it describes was uncountable by construction. `admitPlanningContinuation()` returned a `boolean`, and four of its arms returned `true` while doing nothing: an in-memory run key still held for a task whose due row is by definition unleased; a same-slot hand-off whose result was discarded; a shared-capacity or compare-and-set refusal; and a dispatch that threw (the planning-lifecycle advisory-lock grant timeout) and escaped a drain that awaited `deps.dispatch` with no per-item guard. Each of those left the row `runnable`, `retryAfter` NULL and lease NULL, so the next 2 s pass re-read it, refused it again silently, and refused it again forever. Every sibling starvation class in this file already had an event. This one had none, so its cardinality was literally zero.

One record per stalled window, re-emitted at most once per 15 minutes **per accounting instance** (one per runtime and project), matching RUFU-393's stall-record floor: at four rows an hour a sustained starvation stays countable, at one row per pass it would be 43 200 a day for one wedged window. The counts describe that one pass and are not folded into the wait identity, which is why a refresh re-measures rather than accumulates. A window that dispatched anything emits nothing, so the row set answers "how often did planning admission examine work and move none of it?" and nothing else.

The bound is keyed on the **class**, never on the window head. The first cut deduped on `windowHeadItemId`, and that is not a bound: the drain now arms every examined non-dispatch row, so the armed head drops out of the due set and the next pass reads a different `items[0]`. At the shape this card was measured on — 219 due rows, the whole window refusing at the 45 s capacity horizon — a head-keyed floor emitted roughly one row per twenty rows examined, near 880 an hour, which is RUFU-442's defect restated: a bound whose key changes every cycle is no bound. `windowHeadTaskId` and `windowHeadItemId` therefore describe the recorded pass and are metadata only.

The row is attributed to the window head's card (`taskId`, and `target` likewise) because retention reaches a run-audit row only through `task_id`: `pruneOperationalLogsAsync` deletes by task, so a taskless row is immortal and `store:open` had to be given an explicit bounded per-project exception for exactly that reason (RUFU-344). Attribution to the head card is the self-clearing choice — the row is collected with the card it describes — so no new retention exception was added, and a summary that cannot name a head card writes no row at all rather than writing an uncollectable one.

The paired card-side record is one History line per `(card, reason)` written through the store's once-seam with dedupe key `planning-window-outcome:<outcome>`, saying which admission refused this card and how long it is deferred. It writes no column, status, pause or stall field and releases no lease: like the row, it is a record and not a state change. The write is started **detached** while the drain is still walking the window and flushed once at the end of the pass under a single deadline, because `logEntryOnce` opens a transaction and takes the per-task advisory lock: awaited inline it put one store round-trip per examined row inside a pass meant to run every two seconds, so a contended store would have re-created, in the reporting path, the starvation this card removes from the dispatch path (RUFU-453's rule — best-effort telemetry never sits on the owning lane's critical path).

Like `task:planning-admission-stalled` and `task:planning-reseed-cycle`, this event sits deliberately outside the curated delivery-pipeline catalogue that `run-audit-catalogue.test.ts` locks table-for-table — a drain pass that dispatched nothing is not a delivery-pipeline step every card is expected to pass through — which is why it is documented as prose. It is declared in the engine's `DatabaseMutationType` because its emitter reaches the sink through `emitBoundedRunAudit` (FN-9175), so an absent, throwing, rejecting, or never-settling sink cannot cost a dispatch or delay the drain that is reporting it.

## Post-merge evidence refusal episode

RUFU-450 adds no new event type: it bounds how often the existing `task:auto-merge-finalize-column-mismatch-no-action`
row is written by the pending-evidence arm of auto-merge finalization. Before this, that arm restated an
unsatisfiable refusal at the poll rate — five rows inside one measured minute for one card that had been waiting
for days — because the only bound was a process-local signature that reset on every engine restart. The refusal is
now a durable episode on the card (`sourceMetadata.postMergeEvidenceRefusal`), keyed by which gate, which evidence
state, and which post-merge gate re-seed refusal produced it, and the audit row is written only on the passes
whose episode write was accepted: an unchanged refusal records at most once per 15 minutes, while any change of
gate, state, or refusal records immediately. The row's metadata is untouched — the same `taskId`, `previousColumn`,
`targetColumn`, `commitSha`, `status`, `blockedBy`, `overlapBlockedBy` and `reason` fields it carried before this
change, one of which (`reason`) is the blocker sentence RUFU-431 already keys its in-process bound on. The episode
adds nothing to the row: the gate id, evidence state, re-seed refusal, and notification outcome live on the card's
History line and in `sourceMetadata`, not in run-audit — which is why bounding this row needed no new event. A second event for the same fault was
deliberately not added: it would split the very count this bound exists to make honest.

Nothing was added to the `DatabaseMutationType` union in `packages/engine/src/util/run-audit.ts` either, and that
union must not be read as the authoritative catalogue — several emitted merge events are absent from it
(`task:auto-merge-finalize-post-merge-gate-unreachable`, `task:merge-unrun-gate-park-repaired`, the
`merge:publish-before-finalize` pair), so a missing entry there is not evidence an event does not exist. What the
union does declare, this change reuses: the refusal's outcome vocabulary is the fixed `PostMergeGateReseedReason`
enum returned by `resumeMissingPostMergeGate` (`gate-not-resumable`, `rerun-budget-exhausted`, `no-post-merge-node`,
`unsupported-store`, `operator-held`, …) paired with the gate's evidence state (`missing` / `not-approved`); the
episode stores both verbatim under `gateId` / `state` / `reseedReason`. The notification word on a History line
comes from `PostMergeEvidenceNoticeOutcome` — `delivered`, `unavailable`, or `not-sent` for an arm that has no
terminal notice to send — and it states what the mailbox actually did rather than implying a hand-off.

The row remains outside the curated delivery-pipeline catalogue, following the same precedent as
`task:planning-reseed-cycle`, because the episode is a record of a wait rather than a step of the delivery
pipeline. Two queries answer the operator's questions now: the row count per card answers "how often did the lane
refuse this card", and `sourceMetadata.postMergeEvidenceRefusal` answers "which refusal, since when, and how many
times" — which the row alone could not, because it carried no wait identity at all. No dashboard surface reads
either the row or the episode; both are read through the store, which is why this section lives here rather than in
`docs/dashboard-guide.md`.

The same pass can now also settle the wait instead of only counting it. When a required post-merge gate has no
report and the delivery surface shows the task ref gone or fully contained in the merge target, the landing durable,
and no producer left that could be dispatched, the gate resolves `not-applicable` with reason `producer-unreachable`
and the card finalizes; the card's History records which gate was released on which git verdict. A refusal that stays terminal (a workspace lane, a
lane with no post-merge node, an exhausted re-run budget, an unsupported store) still notifies the operator once
per six-hour window as before, and now also writes its own History line naming the observation and the mailbox
outcome it actually had.

## Store-open provenance

RUFU-344: `store:open` records one process that opened a `TaskStore`, so a mutation on a shared database can be
attributed to the writer that made it. Metadata is ids/paths only (`pid`, `ppid`, `execPath`, `entry`, `cwd`,
`nodeVersion`) and the row's `target` is the bound project id, or `unscoped` for a layer bound to the legacy default
partition. The emitter sits at the single store-open site — `initImpl` in
`packages/core/src/task-store/lifecycle-ops.ts` — and the promise is **per store open, not once per process**:
`TaskStore.init()` runs its body on every call, so a second open by the same process records a second row, and every
host that opens its own store — engine runtime, dashboard/CLI extension host, desktop, and the PostgreSQL test harness
— is stamped. Connection material (database URL, provider, pool sizing) is deliberately excluded: `entry` and `cwd`
already answer "which process", and run-audit carries no credential or connection string.

The row is deliberately **not** a row in the curated delivery-pipeline catalogue: `run-audit-catalogue.test.ts` locks
that table table-for-table against this document, the catalogue enumerates delivery-pipeline events, and store
provenance is not one — the same precedent as `task:planning-admission-stalled` and `task:planning-reseed-cycle`,
which are likewise documented here as prose. It is also invisible to the task-keyed and agent-keyed reads:
`queryRunAuditEvents` narrows only by `task_id` / `run_id` / `agent_id` / `domain` / `mutation_type` inside a project,
this row's `task_id` is NULL, and its `agent_id` is the synthetic `store` — deliberately not `system`, which already
authenticates real engine-authored mutations — so it surfaces on no card's history and under no real agent's runs.
It is found by mutation type, which is precisely how the writer of a shared-database mutation gets attributed. The
symptom suite asserts that nullability and key set directly.

**Awaited but bounded.** The write is `await`ed through the bounded **outcome** seam (`emitBoundedRunAuditWithOutcome(store, …, { log })`),
never through a direct `recordRunAuditEvent` call. An unawaited write is lost exactly where the event matters most: a
one-shot `fn` CLI invocation opens the store, does its work, and exits, so a void write that has not landed dies with
the process and no later reader can reconstruct it. Awaiting the *unbounded* call would instead make an unreachable
audit store a lifecycle dependency of opening the store, which FN-9175/FN-9177 forbid. The bounded seam resolves both:
absent, synchronously throwing, rejecting, never-settling, and late-settling sinks all let `init()` resolve, and the
rejection reaches the operator as a `phase: "init:store-open-stamp"` warning through the seam's own logger instead of
an unhandled rejection. RUFU-453 chose the outcome variant over the plain void seam for one reason: the void seam is
the one that hands the row to the sink drain, and queueing a row is contradictory with awaiting it — the caller would
be told "recorded" about a row still in memory in the process most likely to vanish. The outcome seam writes directly
and settles before returning, which is what this row's own purpose requires. The behavior is pinned by
`packages/core/src/__tests__/postgres/store-open-provenance.pg.test.ts` and
`packages/core/src/__tests__/excluded-awaited-run-audit-store-sites.test.ts`.

**Retention.** The general rule deletes a run-audit row only through a row that owns it (task → agents → runs →
sessions → continuations → work items → worklogs). A `store:open` row owns nothing, so under that rule alone it is
immortal — one row per store open, i.e. one per `fn` CLI invocation and one per PostgreSQL test-harness boot, forever.
`pruneOperationalLogsAsync` therefore carries a bounded exception for this one mutation type, keyed `storeOpenAuditEvents`
in its per-table result: aged `store:open` rows are deleted for the project the retention pass is bound to, under the
same window every other run-audit retention uses, and never across projects. The project is provable without a task
because the emitting data layer is project-bound (the partition trigger assigns `project_id`); a pass with no bound
project deletes only the `__legacy_unscoped__` partition, which is where a row written by an unbound layer lands, so
such a row is collectable rather than stranded. Rows of any other mutation type with no owning task stay uncapped by
design; this exception is not a general taskless sweep.

## Build provenance at boot

RUFU-359: `build:provenance-stale` records one boot of a Fusion source-workspace installation whose
**loaded artifact file** is older than the `HEAD` of the git checkout that owns it. It exists because a
long-lived deployment otherwise has no way to answer "is the fix I just merged actually running?":
measured on the operator's live install, the deploy worktree's branch sat 5 commits behind `main`, the
running `bin.js` bundle carried no embedded revision, and the 80 MB boot log held no version or age line,
so several open cards reasoned about a defect that was not in the running code. The row is what makes
"this deployment warned" distinguishable from "this deployment is current" without a task, a card, or an
operator reading a terminal.

**Emitted on exactly one verdict.** A boot that measures fresh, measures inside the 60-second build grace,
or cannot resolve `HEAD` writes no row and logs nothing, and an installation that is not owned by a Fusion
source workspace writes nothing at all. The row therefore has no false-positive population: it appears
only when the running bundle is proven stale against a repository that Fusion itself owns. Only the two
long-lived operator surfaces emit it — `fn daemon` and `fn dashboard`. `fn serve` and every one-shot
command emit nothing by design.

Metadata is timestamps/counts only: `bundleMtime` (artifact mtime, ISO), `headSha` (40-hex `HEAD`),
`headTime` (HEAD committer time, ISO), `ageMs` (how much newer HEAD is than the bundle), and
`commitsBehind` (a number, or the literal `"unavailable"` when `rev-list` gave no usable count — never a
misleading `0`). `target` is the artifact's **basename** (`bin.js`), not its path. The row never carries an
absolute filesystem path, a HEAD ref name, git stderr, the rendered warning sentence, or the operator
remedy; those live in the boot log, which is the operator-facing record. `agentId` is the synthetic `boot`
with `runId` `build-provenance`, and `domain` reuses `git` — the verdict is computed entirely from git
plumbing (`rev-parse`, `log`, `rev-list`) and every existing `domain: "git"` query is `taskId`-scoped, so a
taskless boot row cannot be pulled into an existing surface. `verification:resource-bound-engaged` is the
precedent for a reused domain plus a synthetic agent/run pair rather than a widened `RunAuditDomain`, which
stays a closed four-member set.

The row is deliberately **not** a row in the curated delivery-pipeline catalogue: `run-audit-catalogue.test.ts`
locks that table table-for-table against this document, the catalogue enumerates delivery-pipeline events,
and boot provenance is not one — the same precedent as `store:open`, `task:planning-admission-stalled`, and
`task:planning-reseed-cycle`. Like them it is found by mutation type.

**Ownership is the false-positive defence.** Before any subprocess exists, the probe requires
`pnpm-workspace.yaml` plus a root `package.json` named `fusion-workspace`, and then requires
`git rev-parse --show-toplevel` to resolve to that same root or a directory inside it. A published
`@runfusion/fusion` installed under a host project's `node_modules` therefore answers `unknown` with
**zero** git invocations and zero stat calls, so a user who commits to their own repository can never
receive "your Fusion build is stale" measured against *their* `HEAD`, and a vendored Fusion checkout
inside an unrelated repository cannot trigger it either. The zero-git-call and zero-row guarantees for that
shape are asserted in `packages/core/src/__tests__/build-provenance.test.ts`, including fixtures that build
the packaged-install and vendored trees on disk rather than mocking the filesystem.

**Bounded and retention-honest.** Emission goes through the FN-9177 bounded seam (`emitBoundedRunAudit`),
never a direct `recordRunAuditEvent` call, so an absent, throwing, rejecting, or hanging audit store cannot
change the boot verdict, delay startup, or lose the operator's log line. The row is taskless and keeps the
general retention rule (collect only through an owning task), so it persists beyond the retention window
like other taskless rows; its volume is bounded by how often a proven-stale owned installation boots, and
because staleness ends at the next rebuild the population is self-limiting. If it ever needs pruning,
the `storeOpenAuditEvents` branch in `pruneOperationalLogsAsync` is the shape to copy.

## The sink drain: how a best-effort row is queued, counted, and spilled (RUFU-453)

Measured 2026-09-30 21:35Z on production: 1332 `[run-audit] timed out recording` lines in the last 20 MB of the
redeploy log, and RUFU-451's `task:reconcile-workspace-partial-land-no-action` proof row had never been written even
though the sweep demonstrably ran. The seam kept its contract exactly — nothing blocked, nothing failed — and the
evidence disappeared with no counter and no surface. The cause was never query time: a standalone audit insert costs
about 1.3 ms (measured p50 on an idle pool, p95 1.68 ms), but it has to check out one of `DEFAULT_POOL_MAX = 3`
runtime-pool connections, and under ordinary engine load the wait for a slot beats the 2 s emit bound. One test
measured that wait directly: with every slot held by a 2 s `pg_sleep`, an audit insert took 1993 ms — the timer was
never racing a slow write, it was racing a queue for a connection.

The fix sits **below** the sink, so the seam's rule ("no retry, backoff, or queueing") stays literally true at the
seam: `emitBoundedRunAudit` hands the row to a per-store drain and returns. `packages/core/src/run-audit/audit-sink-writer.ts`
coalesces a 25 ms window into one batched insert of up to 50 rows (measured 8.1x the throughput of single-row writes
and 50x fewer pool check-outs per row — the second number is what relieves a pool of 3), keeps at most 1000 rows in
memory, runs one drain at a time, and reports a write that passes 2 s without ever abandoning it. Queue overflow
spills the **newest** row rather than growing without bound. The row's primary key is assigned at submit, so a
spilled-then-replayed row collides with `(project_id, id)` instead of duplicating. The pool size is deliberately
unchanged: contention, not capacity, was the binding constraint, and raising it multiplies per-store connections in
embedded multi-project hosts without removing the queue.

**Every accepted row is accounted, and there is no `dropped` counter.** The vocabulary is `accepted`, `coalesced`,
`written`, `batches`, `batchFailures`, `queueDepth`, `queuePeak`, `timedOut`, `lateRecorded`, `slowWrites`,
`maxLatencyMs`, `spilledToDeadLetter`, `deadLetterSuppressed`, and `pid`. `timedOut` means a write still in flight
past the bound, and `lateRecorded` counts the ones that then actually landed — that pair is the incident's shape made
queryable, because the old warn line asserted a loss that usually had not happened.

**The backup lives where PostgreSQL cannot reach it.** A refused batch is retried once and then appended as JSONL to
`<rootDir>/.fusion/logs/run-audit-dead-letter.jsonl` — one line per row because every `fn` process on the host
appends to the same file — under a byte cap (8 MB by default, `FUSION_RUN_AUDIT_DEAD_LETTER_MAX_BYTES`, measured
against the file's existing size so a shared cap stays shared). A byte-level failure is counted as `writeFailures`,
never thrown. Replay runs once at writer construction and is otherwise an explicit operator action
(`TaskStore.replayRunAuditSinkDeadLetter()`); it archives by rename only after a fully clean pass, so a refused
replay keeps its evidence on disk. The automatic pass is deliberately not on the emit path.

**What the seam still refuses to do.** `emitBoundedRunAuditWithOutcome` keeps writing directly and awaiting, because
its callers branch on whether the row landed — `recorded` must keep meaning "settled", not "queued". The same rule
moved one emit site the other way: `store:open` is now emitted through `emitBoundedRunAuditWithOutcome`, since a row
whose entire purpose is to be durable before a one-shot CLI exits contradicts its own `await` if it is queued.
`recordRunAuditEvent`, `recordRunAuditEventBackend`, and `recordRunAuditEventWithinTransaction` are untouched.
`FUSION_RUN_AUDIT_BUFFERED=0` is the kill switch and restores the direct bounded write. `store.close()` drains under
its own 2 s deadline before the connections go away.

**The consequence for readers, stated plainly:** an accepted emit is not yet a durable row. Any reader that counts
rows a producer in the same process just emitted — a spec asserting on a sweep's audit, or an operator refreshing a
surface a heartbeat wrote a frame earlier — takes the drain's bounded hand-off first
(`TaskStore.flushRunAuditSink({ timeoutMs? })`). That hand-off is what makes "what did this pass record?" a question
with an answer instead of a race against a 25 ms window; the shared PostgreSQL harness drains in `afterEach` so a
previous test's still-queued telemetry cannot land inside the next test's freshly wiped database.

The operator surface is `GET /api/diagnostics/run-audit-sink` (see
[Run-audit sink diagnostics](diagnostics.md#run-audit-sink-diagnostics-get-apidiagnosticsrun-audit-sink)), which
reports the daemon's own queue with its `pid` — every process owns its writer, so per-process numbers are never a
cluster total — plus the backup file's path, bytes, and row count. `available: false` beside `buffered` distinguishes
"switched off or not durable" from "nothing queued", and reading the rows themselves is an explicit `?rows=1`.

Bounds are env-tunable for a host whose pool is genuinely different (`FUSION_RUN_AUDIT_SINK_QUEUE_MAX`,
`FUSION_RUN_AUDIT_SINK_BATCH_MAX`, `FUSION_RUN_AUDIT_SINK_FLUSH_WINDOW_MS`,
`FUSION_RUN_AUDIT_SINK_WRITE_BOUND_MS`). Pinned by `packages/core/src/__tests__/audit-sink-writer.test.ts`,
`packages/core/src/__tests__/run-audit-dead-letter.test.ts`, and the symptom fixture
`packages/core/src/__tests__/postgres/run-audit-sink-saturation.pg.test.ts`, which saturates a real runtime pool and
proves `workflowWorkItem:reconcile-stranded-no-action` survives both the drain and a spill-plus-replay into the real
table.

## Maintenance contract

Adding a new catalogued run-audit event requires updating **both** the typed catalogue module (`packages/engine/src/run-audit/run-audit-catalogue.ts`) **and** this doc together — the parity test (`packages/engine/src/__tests__/run-audit-catalogue.test.ts`) fails if the documented event set and the catalogue module's set ever diverge, keeping the observability surface truthful as the real `DatabaseMutationType` union evolves. Removing an event likewise requires updating both in the same change.

### Core barrel parity

`@fusion/core` has two barrels: `packages/core/src/index.ts` (the package barrel) and `packages/core/src/index.gate.ts`, which the `engine-core` merge-gate vitest project aliases `@fusion/core` to and bundles into one file per run (FN-7667, to keep gate forks from transforming the whole graph). The gate barrel deliberately re-exports everything except a named list of modules the curated gate files never touch. That makes an unmirrored export a silent failure, not a build error: a module-scope import of a missing symbol binds `undefined` **inside `engine-core` only**, so a call site throws there and stays green everywhere else — including `pnpm typecheck`, `pnpm build`, and every other vitest project. Measured on RUFU-453: the drain hand-off `submitRunAuditToSinkWriter` was added to the package barrel only, the engine seam's synchronous hand-off threw, best-effort callers swallowed it, and 55 audits in `merger-merge-lifecycle.test.ts` vanished as `recordRunAuditEvent` called 0 times with no error naming the cause. Two defenses are in place: the seam treats an unresolvable hand-off helper as "write the row directly", so a barrel gap cannot silence telemetry, and `packages/core/src/__tests__/gate-barrel-run-audit-parity.test.ts` compares the two barrels' `run-audit/*` export lists directly. Mirror ordinary run-audit barrel additions into the gate barrel; if a module genuinely stays out of the gate closure, say why where the exclusion is recorded.

### Emit-seam policy

All engine telemetry must use `emitBoundedRunAudit` from `packages/engine/src/util/emit-bounded-run-audit.ts`. It is best-effort and never load-bearing for lifecycle correctness: absent/non-function, synchronously throwing, rejecting, never-settling, and late-settling sinks are absorbed without altering the owning branch. The seam swallow-logs and bounds each write; it intentionally adds no retry, backoff, or queueing. Since RUFU-453 the queue exists — but one level **below** the sink, in the store's drain, so the seam itself still contains none of it; see [The sink drain](#the-sink-drain-how-a-best-effort-row-is-queued-counted-and-spilled-rufu-453).

This applies to executor, run-auditor, self-healing, merger, PR reconciliation, scheduler, project-engine, plugin, mission-loop, hold-release, goal diagnostics, overseer advisor, mesh-lease, in-process runtime, credential rotation, and workflow-column-boundary emitters. `packages/engine/src/merge/merge-write-fence.ts` retains its bespoke non-`RunAuditEventInput` recorder. New engine emitters must ship with a behavioral sink-health regression covering hostile sink states, not only a source-routing assertion.

### Core emit-seam policy

Core best-effort emitters use `packages/core/src/run-audit/emit-bounded-run-audit.ts`. This is a deliberate copy of the engine seam because `@fusion/core` cannot import `@fusion/engine`; it synchronously invokes a valid sink, then absorbs throws, rejection, timeout, and late settlement without making telemetry lifecycle-load-bearing. `emitBoundedRunAudit` is the default void seam. `emitBoundedRunAuditWithOutcome` returns `recorded`, `absent`, `failed` (with the original error), or `timed-out` where a forensic throw ordering or caller-visible skipped payload depends on the audit result; workflow-switch torn reconciliation and phantom committed-reservation reconciliation use it. FN-9181 applies FN-9178's class-A decision to detached recall capture: `memory:capture-recorded` and `memory:capture-failed` are bounded, while the injectable `deps.audit` adapter remains a test seam with its existing bare-metadata contract. Transactional writers and explicitly awaited durability/ordering writers remain unbounded. `packages/core/src/__tests__/core-run-audit-sink-health.test.ts` and `core-run-audit-emitter-isolation.test.ts` respectively enforce hostile-sink behavior and source routing.

### Awaited core exclusion decision

FN-9178 classified awaited sites with hostile-sink characterization tests. RUFU-344 adds `store:open` as a class-C site that is awaited **through the bounded seam** rather than directly: it claims a durable forensic record before the open returns, and a void write would not survive a one-shot CLI exit, while the seam's settle-or-timeout bound keeps telemetry out of the store-open lifecycle; `init()` resolves for an absent, throwing, rejecting, never-settling, and late-settling sink. Since RUFU-453 the awaited void seam also *queues* (see [The sink drain](#the-sink-drain-how-a-best-effort-row-is-queued-counted-and-spilled-rufu-453)), so an awaited site uses `emitBoundedRunAuditWithOutcome` to keep its direct write — which is where `store:open` now sits, still bounded, still never a lifecycle dependency. FN-9180 routed the class-A `task-deleted-outbox:catch-up`, `:reconciliation-fallback`, `:lease-fenced`, and `:retention-pruned` rows through `emitBoundedRunAudit`; each remains awaited at its post-acknowledgement, post-cursor, or post-DELETE position so bounded telemetry preserves ordering. FN-9181 routed detached recall capture through the same bounded seam. `task:workflow-switch-torn` and `task:reconcile-phantom-committed-reservation` are class B and use the bounded outcome seam because their throw/result payload depends on audit outcome. `task:bypass-review`, `task:resume-step`, and both resurrection-blocked records are class C and intentionally unbounded: they claim persistence before return, destructive cleanup, or a forensic throw.

All `recordRunAuditEventWithinTransaction(tx, ...)` calls and the `recordRunAuditEventBackend(tx, ...)` transactional call are permanently out of scope. Their audit row shares a transaction with the mutation it describes; bounding would split that atomicity. The full matrix and evidence pointers are in the FN-9178 `decision` task document; `excluded-awaited-run-audit-store-sites.test.ts`, `excluded-awaited-run-audit-layer-sites.test.ts`, and the core routing ratchet pin this boundary.

### Review convergence events

`task:review-finding-disputed`, `task:review-convergence-escalation`, `task:review-arbitration`, and `task:review-convergence-human-escalation` record review-cycle progression. `task:review-convergence-escalation` includes the fixed `escalationSource` outcome (`dedicated`, `execution-fallback`, or `none`); its `hasModelTarget` flag is true only when a distinct model pair was resolved and persisted. Metadata contains only ids, counts, and fixed outcomes; provider/model identifiers, dispute rationales, findings, reviewer feedback, and arbiter output are never recorded. All five emission sites use the FN-9175 bounded best-effort seam, so hostile telemetry cannot alter or block the ladder, arbitration release, or dispute result.

`task:review-empty-content-parked` records the one-time terminal close for a provably empty Code Review input. Its metadata is limited to task and workflow-step ids, the resting column, and the fixed failed outcome; reviewer prose and findings remain off audit rows. The empty-merge finalize-blocked events also include the fixed `parkedStatus: "failed"` outcome. These writes use bounded best-effort emission and are intentionally outside the curated delivery-pipeline event table.

`task:review-input-recaptured` records a positive review lane that proved its own checkout fast-forwarded and re-bound its identity to the final reviewed content. `task:merge-stale-content-review-rerouted` records a singular stale-content merge refusal, from merge admission or self-healing, that attempted graph-owned review re-entry. Self-healing may recover the bounded-retry rejection, raw merge-door blocker, retry-exhausted park, or the engine's own review-stall deadlock park; the first three only after re-seeding the stale lane. Metadata uses task and workflow-step ids, fixed reroute reason/source, and fixed park outcome fields (`parkShape`, `parkCleared`, `mergeRetriesReset`) only.

RUFU-343 corrects `parkShape` to the closed set `retry-rejected`, `raw-blocker`, `retry-exhausted`, `stall-deadlock` and adds one fixed `reason` value, `park-release`. The shape names the terminal that wrote the park, and a review-stall deadlock park reports itself: its `error` is a container written by the stall watchdog that embeds the earlier merge-retry sentence, so a marker read by prefix would have attributed the card to a merge-retry terminal that never wrote the row. `park-release` is the fourth way this row can be written and it burns no review cycle — the seed lane asked the real merge door what is blocking now and the door named nothing, which proves the parked sentence false (the approval fingerprint equals the door's own recomputed content identity), so the row records the pause lift and the retry-budget reset with `parkShape` set, `parkCleared: true`, `mergeRetriesReset: true`, and no `workflowStepId`. An engine-authored park is therefore admissible, releasable, and disprovable; an operator pause, a `userPaused` card, and a soft-deleted card remain refused on every read. Neither event records fingerprints, diffs, paths, findings, or reviewer prose. Both use the FN-9175 bounded best-effort seam.

| Event | Metadata |
| --- | --- |
| `review-remediation-appended` | Task id, gate id, wave, and count only. |
| `review-remediation-parked` | Task id and fixed park outcome only. |

### External block lifecycle

`task:external-block-parked` records a task entering a durable external freeze, and `task:external-block-cleared` records operator Retry publishing its exact resume continuation. Metadata is IDs and fixed classifications only: task id, origin, code, source, column, and resume node id. The `project-configuration` origin and `dependency-readiness` source use the same event pair for proven repeating worktree initialization failures. Command strings, diagnostics, repository paths, and worktree-state tokens remain on `Task.externalBlock` or its private worktree record and are never copied into run-audit metadata. Both writes use the bounded best-effort emitter and are intentionally outside the curated delivery-pipeline event catalogue.

`task:step-session-abort-contained` records an interrupted step-session repair that retains the current lifecycle lane, checkout, node, and completed step progress. Its metadata is IDs, counts, and fixed outcomes only: task id, current column, abort trigger, recovery outcome, and completed-step count; it never includes failure text or step names. The executor emits it through the bounded best-effort seam, and it is intentionally outside the curated delivery-pipeline event catalogue.

`task:merge-unrun-pre-merge-gate-rerouted` records a merge-admission, self-healing, or graph-failure-sink attempt to seed the earliest enabled pre-merge gate that has no result or a verdict-less failure. It uses the FN-9175 bounded best-effort emitter and records only `taskId`, `nodeId`, `workflowStepId`, fixed `reason`, fixed `source` (`merge-gate`, `self-healing`, or `graph-failure`), and `missingGateCount`; it excludes reviewer prose, findings, fingerprints, blocker text, and errors. RUFU-217 extends the fixed `reason` enum additively with `verdictless-seeded` (the earliest seedable gate was a verdict-less failed gate, re-seeded within budget) and `rerun-budget-exhausted` (the gate's persisted per-task per-gate rerun budget is spent, so the card will surface to the operator instead of reseeding); `missingGateCount` keeps its existing meaning of the resolved required-gate count, and no metadata keys were added. RUFU-490 extends it additively once more with `continuation-hold-budget-exhausted` (the gate slot is held by a continuation no lane is serving, and that gate has already been refused for `MAX_CONTINUATION_HOLD_GATE_RERUN_ATTEMPTS` distinct holders, so the lane stops writing its repeated-identical refusal and says the bound is spent instead). `active-continuation` keeps its exact meaning — a refusal this bound has not yet spent — and no metadata keys were added. The two exhausted reasons name different failures and no consumer maps one onto the other: `rerun-budget-exhausted` counts deaths of the gate itself, `continuation-hold-budget-exhausted` counts holders that never let the gate run.

`task:merge-unrun-gate-retry-deferred` records the bounded auto-merge retry seam deferring instead of terminalizing a merge refusal whose message embeds the canonical never-ran-gate sentence (RUFU-276). The refusal is the FN-9191 deferral class, so the retry writes no `status`, `error`, or `mergeRetries` and burns no retry budget; this row is the only durable trace of the deferral. It uses the FN-9175 bounded best-effort emitter and records only `taskId`, `nodeId`, fixed `source` (`merge-retry`), and fixed `outcome` (`deferred`); the refusal sentence, blocker text, and errors are excluded. It is intentionally outside the curated delivery-pipeline event catalogue.

`task:merge-unrun-gate-park-repaired` records one self-healing repair pass that actually cleared a review-lane card an earlier build had already terminalized over a never-ran gate (`status: "failed"` with an `AUTO_MERGE_RETRY_REJECTED:` or raw not-run refusal, and at least one required pre-merge gate holding no result row at all). The repair seeds a fresh run of that gate through the same idle-seed call the FN-9243 lane uses — the seed itself keeps its own `task:merge-unrun-pre-merge-gate-rerouted` row — and this row records the park outcome. It uses the FN-9175 bounded best-effort emitter and records only `taskId`, `workflowStepId`, `missingGateCount` (required gates with zero result rows, not the resolved required-gate count), fixed `source` (`self-healing`), and fixed `outcome`, which since RUFU-318 is **`repaired` only** — a withheld repair moved to its own event rather than sharing this row. The parked sentence, review findings, and errors are excluded. It is intentionally outside the curated delivery-pipeline event catalogue.

`task:merge-unrun-gate-park-no-action` is RUFU-318's withheld-repair companion for the same arm: the seed was refused, or the fenced park clear found the live row had drifted, so the repair was NOT made and the card stays parked. Before it, a refusal was recorded only as a `-repaired` row carrying a refusal outcome, deduped on an unbucketed in-process key — one row per engine lifetime, with no task-log line and no notice, while the seed-attempt row `task:merge-unrun-pre-merge-gate-rerouted` (which records the attempt regardless of outcome) made the lane look healthy. That silence is how a nine-day withheld repair stayed undiagnosed: with nothing on the card and one swallowed audit row, the only evidence left pointed at the guard list, so the refusal was read as a guard decision. RUFU-318's own forensics found the real cause was further upstream — the card's id resolved on no board read at all (only its on-disk mirror survived, which is RUFU-283's `task:vanished-work` class), so the arm never enumerated it and no refusal row of either kind could exist. The pair makes "refused" and "absent" distinguishable; the seed-attempt row alone could not. The row records only `taskId`, `workflowStepId` (the gate named by the seed result or the park's own missing-gate list), `missingGateCount`, fixed `parkShape` (`retry-rejected` | `raw-blocker`), fixed `outcome` (`seed-refused` | `signature-drift`), fixed `refusalReason` (the closed refusal vocabulary: the seed's `rerun-budget-exhausted` / `active-continuation` / `continuation-hold-budget-exhausted` / `no-unrun-gate` / `no-review-route` / `not-singular` / `operator-held` / `workflow-selection-changed`, plus `park-signature-drift`), fixed `notice` (`delivered` | `suppressed` | `unavailable` | `failed`), fixed `source` (`self-healing`), and `withheldAgeMs` — the park's age measured from its own `updatedAt`, present only when the clock parses. The refusal sentence, blocker text, review findings, and errors are excluded; the discriminated seed result makes a success reason unrepresentable in a refusal row. The key is bucketed by the shared `WEDGE_RENOTIFY_COOLDOWN_MS` (6 h) window, so a refusal persisting across passes is re-announced per window instead of once per process, and it never shares an identity with the `-repaired` row. It is emitted through the FN-9175 bounded seam and is intentionally outside the curated delivery-pipeline event catalogue. The same pass writes a `[unrun-gate-park-withheld]` History line through the store's windowed once-seam (`logEntryOnce`, fallback `logEntry` + bounded process-local key) so the refusal is readable on the card without the audit store, and one mailbox notice per window (`system:unrun-gate-park-withheld:<taskId>:<outcome>:<refusalReason>:<gate>:<window>`) — deliberately not a `NotificationService` wedge, because a card already holding a `terminal-failed` wedge has no new stall code to introduce.

`task:graph-failure-after-handoff-honored` records the graph-failure sink honoring a completed handoff instead of terminalizing it: an execute-family node (execute / step-execute) failed for a row that was already in the workflow's resolved review lane with all plan steps done, `status`/`error` null, and not user-paused, so the card is left exactly as found (under `autoMerge: false`, `in-review` is terminal-until-human). Emitted through the bounded best-effort seam with IDs and a fixed reason only: `taskId`, `nodeId` (the failing execute-family node, `"unknown"` when the graph recorded none), `column` (the resolved review lane the card is honored in), and fixed `reason: "work-complete-handoff"`; the benign log sentence, failure text, and token totals never enter run-audit. It is intentionally outside the curated delivery-pipeline event catalogue.

### Execution re-arm of a stuck step (RUFU-308)

`task:execution-rearmed` records that a failed `step-execute` node was granted re-entry at the same node without a lifecycle move — the row is the only durable proof the re-entry happened, because an execution re-arm deliberately writes no lane change. It is emitted through the FN-9175 bounded best-effort seam (agent id from the engine run context, falling back to `executor`, with a synthetic `execution-rearm:<taskId>` run id) and records only `taskId`, `nodeId`, fixed `reason` from the closed set `step-failed` / `self-healing-stranded-recovery` / `self-healing-session-recovery` / `self-healing-worktree-reclaim` / `unclassified`, `attempt`, `attemptLimit`, fixed `evidence: "occupied"`, and fixed `outcome: "rearmed"`. `evidence` can only ever read `occupied` because that is the sole verdict that grants the action; the per-checkout verdict list (`repo=empty` etc.) stays on the task-log sentence and never enters run-audit, which holds no path, diff, or error text. It is intentionally outside the curated delivery-pipeline event catalogue. RUFU-1027 added the reachability contract, and the query that finds this class again: within one card's episode the `attempt` key must read 1, 2, 3, 4 and then be followed by exactly one `task:execution-rearm-exhausted`. A run of `attempt: 1` rows with no exhaustion row is not a healthy card recovering repeatedly - it is the bound being recomputed from fields the bounded loop itself rewrites (measured: 327 such rows on one card in 24 h while the ceiling of 4 was never once reached). The register therefore lives in `sourceMetadata.executionRearmEpisode`, where the stale-merge-state cleanup cannot delete it, and the signature names only node, step ledger, and evidence class.

`task:execution-rearm-exhausted` records the one terminal park that ends a bounded re-arm episode: the card is left in its current lane with `EXECUTION_REARM_EXHAUSTED:` and one operator notice. It records only `taskId`, `nodeId` (`"unknown"` when the graph recorded none), fixed `reason` (`no-progress` when re-arms produced no step progress, `no-evidence` when recovery passes kept finding no worktree evidence to preserve), `attempt`, `refusal`, `attemptLimit`, `refusalLimit`, `column` (the lane the card stays in), and fixed `outcome: "exhausted"`. The park is sticky, so a card that keeps being polled after exhaustion writes no further row and no further notice; the notice dedupe is `logEntryOnce`, not an in-process set. Exhaustion detail sentences, error text, and worktree paths are excluded. It is intentionally outside the curated delivery-pipeline event catalogue.

`task:execution-rearm-park-marker-cleared` records a DISTURBANCE, not a lifecycle decision (RUFU-1028): a writer
that does not own the park cleared the badge the park is announced with, while the episode that binds the card
stayed in place. The measurement that motivated it: an exhausted card parked at 15:36:29 with its History line
appended, a generic unclassified-failure retry ran at 15:53:25, the execute-preflight stale-merge cleanup nulled
`status` and `error`, and the next pass restarted the identical question at attempt 1 — 44
`task:execution-rearmed` rows in 109 minutes, ceiling exhaustions at 15:36 and 15:52, and a third unbounded
stretch after 16:04. Neither `cleanupMergeStateForReverification` nor the review-scoped `task-column-restart`
was designed to stop at that boundary and neither ever did; what was missing is that a single pass is invisible
while the reset is self-cancelling, so this row names the observation and nothing else. Metadata is
ids/counts/fixed enums only — `taskId`, `outcome` (`marker-cleared`), `observedFrom` (`rearm-claim` /
`merge-reset`), `resetSource` (`execute-preflight` / `lane-return` / `unknown`), `attempt`, `refusal`,
`attemptLimit`, `refusalLimit`, `parkHeld` — with no error sentence, no reset message, no path, and no step-
ledger text. The announcement is bounded by the task-History write it accompanies, so a reset that runs on every
dispatch cannot announce on every dispatch; the audit row appears only when that append was accepted, which is
the `logEntryOnce` window and nothing else. Telemetry never releases the park: the row records a question an
earlier pass asked and no later pass answered, which is what a disturbance is.

### Assignee transfer teardown and heartbeat wake dedup

`task:assignee-transfer-abort` records one bounded row per ownership-transfer teardown decision (RUFU-260). It fires whenever a card with a previous owner is re-assigned or un-assigned, so the row documents what the engine did about the previous owner's live execution session rather than merely that ownership moved. The row targets the task id and sets `agentId` to the **previous** owner with a synthetic run id, so operator support can answer "why did this agent's session die mid-card?" by querying either the card or the agent. Metadata is IDs and fixed outcomes only: `outcome` (the fixed enum `aborted` — the previous owner had a live surface and it was torn down with `abortSource = abort-in-flight:assignee-transfer`; `column-binding-deferred` — the live session is staffed by a column-agent principal equal to the previous owner, so the column binding governs and the existing watcher keeps the session; `no-live-surface` — the card had no in-flight session or child process to dispose), `previousOwnerId`, `newOwnerId` (`null` for an un-assignment), and `reviewLaneSessionPreserved` — true only when the card sat in a review lane and a live prompt-lane (workflow-step) session was deliberately left running instead of aborted, because an assignee change must not destroy the review gate's own session (an interrupted review emits no verdict and wedges that required pre-merge gate for operator bypass). A deferred or no-live-surface teardown records the same row: it is a completed outcome, not a failure. Assignee display names, task titles, prompts, session or worktree content, worktree paths, and error prose are never recorded; the greppable abort reason lives in the abort provenance, not in metadata. The write uses the FN-9175 bounded best-effort seam, so an absent, throwing, or hanging audit sink can never delay or fail the teardown nor hold the per-task disposal barrier that the new owner's heartbeat wake awaits. It is intentionally outside the curated delivery-pipeline event catalogue.

`task:heartbeat-wake-deduped` records a heartbeat wake that found a run already in flight for the same `(agent, goal)` pair and returned that run's identity instead of starting a second concurrent session on the same goal (RUFU-260). Metadata is IDs and a fixed outcome only: `outcome: "deduped"`, `taskId` (the goal the wake was asked to work), and `runId` — the pre-existing in-flight run whose identity the caller received. Target is the task id and `agentId` is the waking agent. The goal's text, prompt content, agent names, and run output are never recorded. The audit sink is the `TaskStore` (the `AgentStore` has no audit surface) and the bounded seam absorbs an absent sink as `absent`, which is never a failure of the wake; a dedup decision is recorded without ending, moving, or re-claiming the run that is already in flight. It is intentionally outside the curated delivery-pipeline event catalogue.

`agent:assignment-wake-suppressed` records a heartbeat wake the assignment lane withheld because the identical observable delta had already been delivered to that agent inside the suppression window (RUFU-411). This is the ONLY suppression on the assignment lane and it is shared by both delivery arms — the immediate `agent:assigned` arrival and the deferred arrival re-evaluated at the run-completion edge — so the two arms cannot disagree about what "nothing changed" means. It exists because the storm it reports was invisible in both directions: the card carried no trace of a wake (the run exited as a correct no-op), and the engine carried no trace of the wakes it had already delivered, so "why did this agent burn every slot on a card with nothing to do?" was unanswerable after the fact. Metadata is IDs, counts, and fixed enums only: `outcome: "unchanged-delta"`, `taskId` (the goal the wake was withheld for), `arm` (`immediate` | `drain`, which of the two arrival paths asked the question — they fail differently in the field: the immediate arm needs a fresh `agent:assigned` event, the drain arm needs only a completion edge), `priorFiredAt` (ISO instant of the delivery being repeated, which is what makes the wait measurable), and `suppressedCount` (how many arrivals this one row stands for). Target is the task id and `agentId` is the agent whose wake was withheld, with a synthetic run id, so the row is answerable from either the card or the agent. Comment ids, card titles, prompt text, rendered wake deltas, and error prose are never recorded. One row is written per suppression EPISODE, never zero and never one per poll: the first suppression of a given (agent, goal, delta) always announces itself, and an ongoing episode re-announces at most once per window, which is what keeps 50 polls of a parked card from flooding the store while `suppressedCount` still reports how many arrivals the collapsed row stood for. The `TaskStore` is the sink (the `AgentStore` has no audit surface) and the write uses the FN-9175 bounded best-effort seam, so an absent, throwing, or hanging sink can never alter, delay, or replace the dispatch decision it is reporting on — a telemetry failure must not become the wake storm it exists to measure. This event is deliberately NOT a new key or a new value on `task:heartbeat-wake-deduped`: that event's dedupe is keyed by the in-flight run and is orthogonal by contract, and mixing a delivered-nothing suppression into it would make neither countable. It is intentionally outside the curated delivery-pipeline event catalogue.

### Plan Review replan session budget
`task:plan-replan-session-failure-budget` records one accounting decision inside a live Plan Review `REVISE` episode — the window where the graph has already granted a spec-revision replan and the planner session is expected to rewrite `PROMPT.md`. RUFU-251 added it because a planner session that ended without producing a specification update consumed none of the Plan Review replan budget: it rebound through the filesystem-twin recovery counter only, and a card could loop plan → Plan Review → replan indefinitely while each turn consumed zero budget. Metadata is IDs, counts, and fixed outcomes only: `taskId`, `revisionKey` (the Plan Review revision key, `plan-review`), `attempt` (the turn this decision lands on, including the turn being decided), `cap` (the same ceiling the graph's remediation seam enforces, derived from the Plan Review workflow/node budget, `planReviewReplanCap`, and the shared absolute revision cap — never a second ledger), `remaining`, and fixed `outcome`:

- `consumed` — the session failure was charged to the shared revision-keyed ledger, so the card stays inside the bounded replan loop.
- `exhausted` — the turn was refused; the card is parked through the existing `plan-review-replan-cap` operator surface and no further planner session is dispatched.
- `spec-complete-recycled` — the planner session ended with the specification already complete and valid, so the card is released back to the Plan Review gate instead of consuming a turn. No marker is written for this shape, because the marker grammar is also the counter grammar.

The whole event is `REVISE`-episode scoped, and RUFU-527 is the change that had to keep it that way while widening what may be released: the release door no longer asks for a reviewer projection, so this ledger's own episode test is the only thing standing between a no-projection release and a charged turn. A card whose `workflowStepResults` is empty (Plan Review never ran, or recorded no row) that releases a complete unchanged spec therefore writes NO row of this event at all — the recycled emit sits inside the episode branch, not on the release path — and a query for this event answers only "what did the Plan Review ledger decide", never "did a plan release". Counts of one therefore mean one ledger decision, and the absence of a row is the honest signal for both an unplanned-card release and a first-pass plan; release notices live on the card's History line, not here.

The emitted row never contains prompt text, reviewer feedback, validation diagnostics, error text, or paths. A charged turn is additionally recorded as a `Workflow revision key: plan-review` task-log marker — the same ledger shape the graph's remediation seam appends — which is what makes the two accounting paths agree without a second persisted field. `SPEC_STALENESS_RECOVERY_EXHAUSTED:` is the operator-visible park sentence for the sibling bound RUFU-251 added (the scheduler's spec-staleness rebound now shares the planning recovery budget instead of writing unbounded `needs-replan` states); it is a task error prefix, not an event type. Both events are intentionally outside the curated delivery-pipeline event catalogue.

### Task branch base resolution

<!--
FNXC:TaskBaseResolution 2026-09-16-03:55:
RUFU-245 anchors every fresh task branch to the LOCAL integration ref (the local default branch)
and records the acquisition decision on the existing FN-9164 event. Divergence is proven from
already-available refs only — the resolver never fetches/pulls/merges, because reconciling a
diverged local default is an operator decision. The refusal sentence carries the branch names for
the operator, so the run-audit row must stay ids/outcomes-only and never echo them.
-->
`worktree:workspace-repo-base-branch` is the single base-resolution event (FN-9164). RUFU-245 added the acquisition-decision row: the worktree-acquisition gate emits exactly one row per fresh create with `stage: "acquire"` and `source: "local-integration"`, before any branch creation. `repoRelPath` is optional and present only for workspace per-repo resolutions; single-repo resolutions omit it. The `outcome` enum is `resolved-local-base` (branch anchored to the local integration SHA), `refused-diverged` (local and remote-tracking integration refs are proven to have diverged, acquisition refused), `skipped-remote-unresolvable` (the remote side could not be read, so acquisition proceeds fail-open), and `skipped-remote-rebase-disabled` (`worktreeRebaseBeforeMerge === false`, no remote participates). Metadata stays ids/counts/fixed enums only — `taskId`, optional `repoRelPath`, `stage`, `source`, `outcome`, optional `fallbackReason` — and branch/ref names and SHAs never enter metadata or `target`. The emit uses the existing bounded best-effort seam and is intentionally outside the curated delivery-pipeline event catalogue.

`TASK_BASE_DIVERGED:` is the operator-visible refusal sentence for proven divergence, not a new event type. It means the local integration ref (e.g. `main`) and its remote-tracking counterpart (e.g. `origin/main`) each carry commits the other lacks — proven with `git merge-base --is-ancestor` against already-fetched refs, never a fresh fetch. Remedy: the operator pulls (or pushes) the local default branch to reconcile it with the remote, then retries the card. All four acquisition entry points — the executor (`run-implementation`), the durable-agent heartbeat, the merger, and the workflow graph-node custom-node entry — surface the identical refusal and park the task `failed` with it; none of them consumes the branch-conflict `recoveryRetryCount` budget, emits the acquisition-exhaustion message, or calls `onTaskAcquisitionExhausted`, because divergence is a human reconciliation decision, not a retryable branch conflict. Ahead-only, behind-only, and aligned repos are never refused: a strictly-behind linear remote still receives the FN-8839 post-create linear rebase; only a rebase target proven to have diverged is skipped (the fresh branch keeps its local base).

<!--
FNXC:WorkspaceRootMember 2026-09-28-08:41 (RUFU-390): documents the reuse event emitted when a
configured workspace member resolves to the workspace root repository.
-->
`worktree:workspace-root-member-reused` records one workspace acquisition in which the configured member directory resolved to the workspace root repository (git walked up from `<root>/<member>` to `<root>`), so the member entry was repointed at the registered worktree that already holds the task branch instead of creating a second worktree of the same repository and branch. Metadata is ids and a fixed outcome only (`taskId`, `repoRelPath`, `outcome`); the reused path and branch name live on the task row and the task log, never in this row. The emit uses the FN-9175 bounded seam, so telemetry cannot alter or delay the acquisition.

### Cross-project handoff

<!--
FNXC:CrossProjectHandoff 2026-09-09-11:37:
RUFU-203 transfer audit pair. The success event distinguishes `created` from `deduplicated` so a
retried transfer that correctly reused its deterministic claim is visible as a no-op, not a second
handoff; the failure event's fixed reason enum is the only representation of the refusal — error
prose (which can embed project paths or store messages) never enters run-audit.
-->
`task:cross-project-handoff` records a completed cross-project transfer (copy-with-cross-reference) from the source project's store, and `task:cross-project-handoff-failed` records a refused or failed attempt. Metadata is ids/counts/fixed outcomes only: `sourceProjectId`, `sourceTaskId`, `targetProjectId`, `targetTaskId` (when a target card exists or was reused), `outcome` (`created` / `deduplicated` on success, `failed` on failure), `attachmentCount` and `skippedAttachmentCount` on success, and a fixed `reason` enum on failure (`target-unresolvable`, `attachment-copy-failed`, `store-write-failed`). Neither event records titles, descriptions, attachment names, or error text. Both use the FN-9175 bounded best-effort seam so a hostile telemetry sink cannot alter or delay the transfer response, and they are intentionally outside the curated delivery-pipeline event catalogue.

`task:reconcile-absent-branch-landed` records an ownership-trailer-proven review card finalized after its branch was cleaned up. `task:reconcile-absent-branch-unproven` records a skipped absent-branch candidate. Metadata is IDs and fixed outcomes only: task id, source (`self-healing` or `manual`), branch/base branch identifiers, merge SHA/strategy or fixed reason, and ownership-proof classification; it never contains commit subjects, diffs, or reviewer text. Both emissions use the FN-9175 bounded best-effort engine seam, so hostile sinks cannot alter reconciliation. The unproven event is deduplicated per manager only after its audit write records successfully, allowing a failed audit write to be retried.

### Compaction honesty event

`task:compaction-no-progress` records a context compaction that pi ran to completion (it returned a summary and appended the CompactionEntry) but deterministically did not shrink the context (tokens-after >= tokens-before), so the executor must not treat it as reclaimed headroom. Both executor lanes that consume `compactSessionContext` emit it — the loop-detected compact-and-resume recovery and the token-cap callback — distinguished only by their `source` (`loop-recovery` / `token-cap`). Metadata is ids/counts/fixed enums only: `source`, `tokensBefore`, `tokensAfter`, and `basis` (`pi-reported` when pi supplied the after-count, `pure-estimate` when it was recomputed with pi's per-message estimator). No summary text, prompt content, or error prose is ever recorded. Both lanes emit through the FN-9175 bounded best-effort seam so a hostile telemetry sink can neither block the refusal nor change the recovery decision, and the event is intentionally outside the curated delivery-pipeline event catalogue.

### Chat session handoff

<!--
FNXC:ChatHandoff 2026-09-10-01:13:
RUFU-199 Direct-chat handoff audit pair, catalogued here because `docs/run-audit.md` is the audit
reference a query starts from. The success event covers BOTH the briefed and the degraded primer —
honest degradation still creates the handoff — so `degraded-created` is a success outcome, not a
failure. The failure event fires before any rows are written (a refusal) or after the archival
compensation (child discarded, source left active), which is why `outcome` and `refusalCode` are
separate keys rather than one merged code.
-->
`chat:handoff-session-created` records a Direct-chat handoff that completed (the source was archived and a continuation session was created), and `chat:handoff-session-failed` records a refused handoff (before any rows are written) or the archival-failure compensation (the half-built child is discarded and the source stays active). A created row is filed under the continuation the operator now types into (`chat:<childSessionId>`); a failed row is filed under the source they clicked (`chat:<sourceSessionId>`), because that is the session whose action failed. Metadata is ids/counts/fixed enums only: `fromSessionId`, `toSessionId` on success, `outcome` (`created` / `degraded-created` on success, `refused` / `archival-failed` on failure; `summarizer-failed` is declared in the contract but unreachable in v1, since a briefing failure degrades rather than refuses), a fixed `refusalCode` (`not-found`, `disabled`, `room-unsupported`, `cli-backed-unsupported`, `task-planner-unsupported`, `source-not-active`, `generation-in-progress`, `unknown-model`, `archival-failed`), plus `messageCount` and `summaryChars` where measured. Neither event records the conversation transcript, the generated briefing text, or a refusal sentence — those live on the primer message row and the HTTP error respectively. Both emit through the FN-9175 bounded best-effort seam (`emitBoundedRunAudit`, `agentId: "chat-handoff"`) so telemetry can never decide whether a handoff lands, and they are intentionally outside the curated delivery-pipeline event catalogue.

### Stale in-flight chat generation recovery

<!--
FNXC:ChatInterruptedRecovery 2026-09-22-00:55:
Catalogued here because `docs/run-audit.md` is the audit reference a query starts from, and this pair
was undocumented until RUFU-256: the sweep landed in RUFU-144 and gained materialize + auto-continue
later, but its audit rows were never written down. Two facts are easy to get wrong when querying. The
row is filed once per sweep PASS under the literal `chat-sessions` target, not per `chat:<sessionId>`,
so the affected ids ride in metadata and are capped at 20. And `materializedCount` counts rows actually
persisted, so it is legitimately below `count` when an interrupted row could not be written even though
its stale flag was cleared. The restart auto-continue is deliberately NOT an audit event — its input is
transcript content, which is never audit metadata — so a query must not go looking for one.
-->
`chat:stale-in-flight-generation-cleared` records a pass of the `reconcile-stale-in-flight-chat-generations` sweep (registered in both startup recovery and maintenance batch 1) that cleared at least one stale `project.chat_sessions.in_flight_generation` flag, and deduped `chat:stale-in-flight-generation-no-action` records a pass where candidates existed but none had aged past the floor. A generation is a candidate when its session is generating and its staleness reference — the snapshot's `startedAt`, falling back to the session's `updated_at` for legacy rows that predate `startedAt` — parses as a finite time and is older than the 30-minute floor; a row whose age cannot be proven is **never** cleared. Metadata is ids/counts/outcomes only: `count` (flags cleared), `sessionIds` capped at 20 (so a wide fan-out still reports the true `count` with a truncated id list), `outcome` (`cleared` / `no-action`), and `materializedCount` — the cleared checkpoints that carried evidence of work (streamed text, streamed thinking, or a completed tool call) and were therefore recovered as an `interrupted` assistant row rather than silently dropped. `materializedCount` is never greater than `count`: the flag is cleared before the row is written, so a session whose interrupted row failed to persist counts in `count` but not in `materializedCount`, and an evidence-free checkpoint is intentionally a plain clear with nothing to resume. The no-action row is emitted once per manager and re-armed by the next cleared pass, so a sustained queue of young generations produces one row instead of one per sweep. Payload text — streamed text, thinking, tool arguments, tool results — is never recorded; recovered prose lives only on the message row, where the interrupted notice, auto-expanded Thinking, and Retry render it. Each materialized session is additionally reported to a dashboard-injected handler so Chat can continue that turn exactly once, and that continuation writes no run-audit row of its own — its durable evidence is the visible `restart-recovery` user row it appends to the transcript, which is what makes an automatic turn auditable by an operator reading the thread rather than querying telemetry. Both events use the FN-9175 bounded best-effort seam (`emitBoundedRunAudit`, `agentId: "self-healing"`, `runId: "chat-in-flight-generation-reconcile"`, `domain: "database"`, `target: "chat-sessions"`), so a hostile telemetry sink can neither delay nor alter recovery, and they are intentionally outside the curated delivery-pipeline event catalogue.

### Verification resource bound events

<!--
FNXC:VerificationResourceBound 2026-09-10-13:09:
RUFU-212 audit pair, catalogued here because `docs/run-audit.md` is the audit reference a query
starts from. The engaged event fires once per verification spawn that actually ran inside the
resource envelope (a bare fallback emits nothing — the absent row is the signal that the host
could not be bounded); the sustained event marks a bounded verification that stayed running long
enough to be worth operator attention (>= 120s). Both file under agentId `verification` and domain
`sandbox`, are intentionally outside the curated delivery-pipeline event catalogue, and use the
FN-9175 bounded best-effort seam so telemetry can never alter, delay, or fail the verification.
-->
`verification:resource-bound-engaged` records that a verification-class spawn (tags `tool`, `deterministic`, or `fix-repair`) ran with the resource envelope applied, and `verification:resource-bound-sustained` records the same run reporting its duration from the lane's existing exit path once that duration reaches the sustained threshold. Metadata is ids/counts/fixed buckets only: `lane`, `rung` (`scope` / `priority`), `quotaBucket` (the applied CPU quota as a share of the whole machine: `none` / `lt-25` / `25-50` / `50-75` / `gte-75`), numeric `cpuIoWeight` and `memoryMaxMb` only when those dimensions are set, and on the sustained event `durationBucket` (`lt-2m` / `2-5m` / `5-15m` / `gte-15m`) plus the raw `durationMs`. The target is the task id when the lane carries one, else `lane:<tag>`. Neither event records the verification command line, file paths, working directories, or error text.
`task:external-block-parked` records a task entering a durable external freeze, and `task:external-block-cleared` records operator Retry publishing its exact resume continuation. Metadata is IDs and fixed classifications only: task id, origin, code, source, column, and resume node id. Raw error prose remains on `Task.externalBlock` and is never copied into run-audit metadata. Both writes use the bounded best-effort emitter and are intentionally outside the curated delivery-pipeline event catalogue.

`task:step-session-abort-contained` records an interrupted step-session repair that retains the current lifecycle lane, checkout, node, and completed step progress. Its metadata is IDs, counts, and fixed outcomes only: task id, current column, abort trigger, recovery outcome, and completed-step count; it never includes failure text or step names. The executor emits it through the bounded best-effort seam, and it is intentionally outside the curated delivery-pipeline event catalogue.

`task:merge-unrun-pre-merge-gate-rerouted` records a merge-admission or self-healing attempt to seed the earliest enabled pre-merge gate that has no result. It uses the FN-9175 bounded best-effort emitter and records only `taskId`, `nodeId`, `workflowStepId`, fixed `reason`, `source`, and `missingGateCount`; it excludes reviewer prose, findings, fingerprints, blocker text, and errors.

### Absent-branch landed reconciliation

`task:reconcile-absent-branch-landed` records an ownership-trailer-proven review card finalized after its branch was cleaned up or when a still-present branch has no remaining task-owned unlanded commits. `task:reconcile-absent-branch-unproven` records a skipped absent-branch candidate. Metadata is IDs and fixed outcomes only: task id, source (`self-healing` or `manual`), branch/base branch identifiers, merge SHA/strategy or fixed reason, and ownership-proof classification; it never contains commit subjects, diffs, or reviewer text. Both emissions use the FN-9175 bounded best-effort engine seam, so hostile sinks cannot alter reconciliation. The unproven event is deduplicated per manager only after its audit write records successfully, allowing a failed audit write to be retried. `fn task reconcile <id>` and the automatic self-healing absent-branch sweep both call the same `SelfHealingManager.reconcileLandedReviewTask` fence, so a manual reconcile and an automatic one can never disagree about what "landed" means.

Since RUFU-1097 the unproven row additionally answers *which gate*, for the one refusal class that already knew: when `reason` is `workflow-approval-blocked`, it carries `gateId`, `gateState` (`missing` / `not-approved` / `stale-content` / `unprovable-content` / `approved`), and the selected row's `gateStatus` and `gateVerdict`. All four are **spread, never defaulted** — a refusal that names no gate (`missing`, and the stale-content / unprovability sentences, which carry no gate id) grows none of these keys, because an absent key means "this refusal names no gate" while `gateStatus: null` would mean "the gate was consulted and has no result row". Those are different claims and must not share a spelling. The values are derived, not re-decided: the id comes from `parsePreMergeGateApprovalBlocker` on the door's own sentence and the carrier from `evaluatePreMergeAdmissionDecision`, which re-reads the LATEST row, so this row, the CLI sentence and the card's History line all quote one measurement. Reviewer `notes` (where a close's entire justification lives), verdict text, blocker sentences and error prose stay off the row.

Workspace discharge (RUFU-357): `task:reconcile-workspace-landed-review` records one commit-free finalization of a workspace (multi-repository) review card by the same fence — the shape the saneca board measured as 16 parked `in-review` cards whose summed unique commits across root and sub-repositories were zero while the fence answered only `workspace`. Exactly one row is written per successful discharge, after the compare-and-set write, and a refusal writes no row. Metadata is IDs, counts, and fixed outcomes only: `taskId`, `source`, `repoCount`, `dischargedCount`, `repoBasis` (repository key to `zero-ahead`, `absent`, or `landed`), `basisSource`, and the fixed `outcome` `"discharged"`; per-repository base names, branch tips, landing SHAs, refusal reasons, and all prose stay on the card's History line and the CLI/HTTP response, never in this row. Discharge eligibility stays with the fence (manual surfaces only today; the automatic sweep still skips workspace cards), and the event is deliberately outside the curated delivery-pipeline tables above — the same precedent as `task:planning-reseed-cycle` and `task:merge-publish-before-finalize` — documented here as prose and found by mutation type.

Recorded-delivery closeout (RUFU-599): the same mutation type has a second writer, and the row distinguishes the two by `basisSource` alone. `basisSource: "probed"` is the RUFU-357 discharge above — that pass measured every repository itself. `basisSource: "recorded"` is the closeout of a card the workspace land lane had already finalized commit-free: its `repoBasis` entries are that lane's recorded ancestry observations (`zero-ahead` for a repository whose branch tip git had found already an ancestor of its own integration branch, `absent` for a declared repository holding no artifact of the card), read off `mergeDetails.workspaceCommitFreeBasis` by `classifyCommitFreeWorkspaceDelivery`; the closeout runs no probe of its own to re-derive them. Never infer the provenance from which basis words appear or from a missing key — answering "measured now" versus "read off the row" is the key's whole purpose. A recorded basis is accepted as landing proof only when it is complete: a recorded `commit-free delivery:` kind, at least one `zero-ahead` repository, a recorded branch tip for every `zero-ahead` entry, and no `unproven` repository at all; `mergeConfirmed` and `noOpMerge` are never read as proof by that predicate. The closeout writes no `mergeDetails`, authors no commit SHA, waives no gate, and emits its row only after the durable close. A card that still owes required post-merge evidence keeps answering `post-merge-evidence-pending` with no row at all, and `fn task reconcile` plus the dashboard's reconcile action render the closeout as its own success sentence rather than collapsing it into the probe-verified discharge.


### Operator comment delivery (RUFU-259)

Every operator-facing comment write path (task comment, steering, review-address, PR address-feedback, Planner Chat
steering, `fn task comment`, `fn task steer`) hands the body to one resolved agent through the core delivery seam,
and each attempt records exactly one row: `task:comment-delivery` for the routed and transport outcomes, or
`task:comment-delivery-unowned` when the outcome is `unrouted` (no agent on the card, its column, its workflow, or
the lane pool could be named). The split exists so "nobody was told" is a queryable class of its own rather than a
value buried inside the general stream.

Metadata is ids/counts/fixed enums only: `source` (which surface accepted the comment), `kind`
(`comment` | `steering`), `commentId`, `via` (`assignee` | `column-binding` | `workflow-binding` | `triage-pool` |
`executor-pool` | `none`), `outcome` (`delivered` | `already-delivered` | `unrouted` | `no-message-store` |
`send-failed`), `unroutedReason` (`pool-empty` | `pool-ambiguous`, or `none`), the `skippedRungs` walk record,
`poolSize`, and `messageStoreAvailable`; a successful write adds `messageId` and a failed hand-off adds
`noticeDelivered`. The comment text, the rendered inbox body, and any error message are never recorded. `agentId`
and `runId` are the fixed synthetic `task-comment-delivery` identity, with `runId` =
`task-comment-delivery:<taskId>:<commentId>` so all rows for one comment group by that comment.

Emission goes through the core bounded seam (`emitBoundedRunAudit`), so an absent, throwing, or hanging audit sink
cannot fail a comment, delay the operator's response, or change the delivery outcome; the durable
`sendMessageOnce` inbox write is the only guarantee the seam makes. The undelivered cases additionally notify the
operator on the mailbox (deduped per comment) and log a non-delivery entry on the card, because a stored comment
that nobody was given is an outcome the operator has to be able to see without querying the audit store.

### Merge-boundary evidence recovery (FN-9345)

Missing implementation proof is normally repaired through the workflow's durable task log and graph remediation path before merge admission. On startup and periodic maintenance, `task:merge-boundary-evidence-recovered` records a historic proofless park only after durable unfinished work, lifecycle ownership, liveness, and auto-merge policy are re-verified. These repairs intentionally do not put boundary reason prose, foreach identities, paths, review output, or external capability diagnostics in run-audit metadata. If recovery cannot prove an executable owner, the existing terminal `task:merge-boundary-unproven-parked` event remains the fail-closed audit surface and retains its ids/counts/fixed-outcomes-only contract.

### The stall park that owned the verdict it was waiting for (`36a88363e2` + `65b0dec011`)

<!--
FNXC:CommitOwnership 2026-11-19-16:39 (RUFU-394):
This section was headed `(RUFU-391)`. The two commits that introduced `task:review-no-verdict-park-repaired`
carry that trailer, but RUFU-394 measured that both were committed 2h46m and 2h47m BEFORE this board
issued the id — the task-id reservation ledger's last committed row at 09:17:14Z was `RUFU-390`, and
`RUFU-391`'s row was created at 12:03:28Z — and that the live card of that id specifies an unrelated
surface (project-default workflow editing). The section is therefore headed by the commits that own the
behavior, because in this project no card does.
-->

`task:review-no-verdict-park-repaired` is written once per pass that re-seeds a required pre-merge gate whose latest row has no authored verdict and then lifts the in-review stall-deadlock park around that same card. Metadata is `taskId`, `workflowStepId`, fixed `source` (`self-healing`) and `outcome` (`cleared`/`signature-drift`) only — no findings, verdicts, blocker sentences, or error text.

`outcome:"cleared"` means the park's pause marker, park error, `status` and `error` were all dropped in one `updateTaskAtomic` write whose guard re-derived the SAME signature that admitted the seed: the deadlock pause reason, the park's own error prefix still on the row, no `userPaused`, and a required gate still verdict-less. Anything else is `signature-drift` and writes no field, so a card that changed shape underneath the recovery keeps its terminal evidence for an operator. If the re-run fails to converge again, the stall detector parks it again with fresh evidence — this event records one attempt, not a disarm.

### The stall park that froze a card applying review corrections (RUFU-280)

A Code Review `REVISE` refuses the merge door for exactly as long as the corrections take, and the refusal sentence does not change while the executor works through them — the shape the in-review stall deadlock ladder reads as a frozen card. Past the threshold it parked healthy cards `failed` with "stuck in the review lane with no executor or merger owning it", the one sentence an operator acts on to intervene in work that was running normally. The ladder now defers that terminal action while the state holds: `task:review-stall-surfaced` and `task:review-stall-observed` are unchanged, so the wait stays visible and countable, it simply is not treated as a deadlock. This event records the repair pass that un-parks the cards the earlier build already froze.

`task:merge-review-revision-park-cleared` is written once per card whose mis-parked stall deadlock is cleared in place (`status`, `error`, and the pause marker dropped, and the merge retry budget reset to what a lane that never judged this content had asked for; no column move, no progress loss). The sweep `reconcile-review-revision-stall-parks` runs at startup and in maintenance batch 1, immediately after `reconcile-orphaned-non-convergence-holds`. Admission requires the engine's own deadlock signature — the `in-review-stall-deadlock` pause marker plus that build's exact park sentence — and a live re-read under the shared task advisory lock that still finds the card awaiting revision. RUFU-447 widened that admission with the predicate it shares: any pending step counts, not only one carrying `step.remediation` provenance, and the whole deferral expires `REVIEW_REVISION_PARK_DEFER_HORIZON_MS` (6 h) after the authored row was written — so a card whose remediation append never landed is still un-parked, while a card that simply stopped working is eventually terminalized rather than deferred without end. A card whose pending work has since finished keeps its park: that is a different fault with its own recovery owner, and an operator pause is never lifted here. Cards parked by a pre-widening build stay parked — the sweep reads the predicate, not a migration list, so an old park whose revision work is already complete is the operator's to Retry, which is what its History line says. Admission is the sibling repairs' full consent-and-liveness gate rather than a pause-and-signature subset: the pass resolves settings and returns without reading the board under a global or engine pause, refuses any card `allowsAutoMergeProcessing` rejects (project auto-merge Off with no per-task `autoMerge: true` opt-in, or a manual open PR), and stands down while an executor lock, a live session path, a durable agent's active run, or the merge queue owns the card — the facts a synchronous callback can see are re-checked inside the guarded write, so a consent flip during the pass cannot be stepped on. A withheld card emits no row of its own: the clear never happened, so there is nothing to record, and the pass reports the withheld count in its log line instead.

Metadata is `taskId`, `workflowStepId` (the gate whose authored `REVISE` the card is answering), fixed `source` (`self-healing`) and `outcome` only — no findings, verdicts, blocker sentences, or error text.

The row is telemetry and stays that way. The emit is the FN-9175 bounded seam, and its conformance is proven behaviorally rather than assumed: an absent, throwing, rejecting, or never-settling sink leaves the cleared `status`/`error`/pause marker, the reset retry budget, the task-history entry, and the pass count identical, with the refusal visible only as the seam's own bounded warning. One emit per cleared card, no retry, no queue.

What the row cannot do is explain the repair on the card, so the durable explanation is written **before** the state changes, and the order inside one card is intention-then-action-then-observation: the history entry, the guarded clear, the audit row. The lifetime of that line is the reason. A cleared card no longer carries the admission signature, so the sweep never reads it again and a history entry that was never written is never rewritten — the loss is permanent, unlike a missing audit row. A refused history write therefore aborts that one card before its state changes: the park stays, the signature stays, and the next pass retries both the line and the clear, which is strictly better than a repair that succeeded but cannot be explained. Each card holds its own failure boundary for the same reason — read, admit, log, clear, and record sit under one guard, so one card's refusing write cannot end the pass, because an aborted pass is indistinguishable from a board with nothing on it.

### Naming the park cycle a stall release did not break (RUFU-398)

`task:in-review-stall-deadlock-disposed` is the only durable record that the engine froze a Review card on a repeated stall. It is written by the stall sweep through `createRunAuditor` under `agentId: "self-healing"` and the synthetic run id `self-healing-stall-deadlock:<taskId>`, with metadata `code`, `reason`, `repetitionCount`, `threshold`, `branch` and `worktree`. The stall-disposition family is not part of the curated delivery-pipeline catalogue and this card does not add it; this section is prose only.

RUFU-398 adds three ids/counts/booleans-only keys to the deadlock arm: `priorParkCount` (how many earlier auto-disposed lines on the card's own History already carry this same code and reason), `mergeRetriesAtPark` (the card's merge retry counter at the instant of the park, defaulting to 0), and `episodeHasMergeAttempt` (whether that counter was above zero). Both halves are sampled inside the fenced compute callback rather than read back afterwards, and that ordering is the contract: the store appends the park's own History line only after the callback returns, so the first park of an episode reads `priorParkCount: 0` instead of counting itself; and every arm that lifts this pause resets `mergeRetries` together with the pause marker and the park's `status`/`error`, so a later reader cannot tell a real merge attempt from a cosmetic un-park unless the counter was captured while the park was being written. The criterion the three answer, in one sentence: **clearing the pause is not a release — a release counts only once a merge attempt has actually run.** A re-park that reads `priorParkCount` of one or more beside `episodeHasMergeAttempt: false` is therefore the queryable class "this stall-park release survived zero merge cycles", which previously required reading task mirrors by hand.

The keys are observability-only. They do not appear on the observation arm (which writes no row at all) or on `task:in-review-stall-terminal-provider-error`, they change no threshold, no log sentence and no pause payload, and they do not alter whether or when the engine parks. The transient merge-retry counter is deliberately not consulted — it is a second counter with its own reset semantics, and folding it in would be a `mergeRetries`-provenance redesign, not a measurement.

### The gate that refused to report, recorded with no new row (RUFU-657)

**owed-verdict** is this card's name for a required pre-merge gate whose latest workflow-step row is
`status: "skipped"` with no `verdict`, no honest `notRunReason`, no `bypassedBy` and no
`remediationArchivedAt`: a run that ended while owing an authored verdict. The registered discriminator for
it is `required-gate-refused-owed-verdict`, and the one predicate that decides the shape is
`isVerdictLessSkippedOwedVerdictRow` in `packages/core/src/merge/pre-merge-approval.ts`. The stall codes are
`rerun-armed` and `rerun-exhausted`. The shape is documented as an invariant in
[`architecture.md`](architecture.md) — «A required gate that refuses to report is witnessed, bounded, and
bypassable».

This card adds **no mutation type, no event name, and no metadata key**. The reason is a decision, not an
oversight: the stall ladder already emits the two rows that could carry this state, and both read `code`
from the classifier rather than from a per-class emitter. `task:in-review-stall-deadlock-disposed` gains
`code: "rerun-armed"` or `code: "rerun-exhausted"` exactly where it would previously have recorded the
undifferentiated «merge-blocker» for the same card, beside the `reason`, `repetitionCount`, `threshold` and
RUFU-398's episode keys. The observation arm writes no row at all, as it already did, so a card that merely
waits stays free of rows while its History line and stall chip stay readable. The classifier arm is consent-gated
by the ladder's existing rule, so a card whose automatic merge processing the operator switched off still
produces no stall rows of any code.

So the query for «which cards are sitting on a review that never reported?» stays one query and gains a
filter, not a new family: filter the deadlock arm's `metadata->>'code'` on `rerun-armed` / `rerun-exhausted`. What the row
cannot answer is deliberately left to the card face and its History line, because the only facts that make
the class actionable — which gate, how many attempts its own row carries, and that the remaining remedy is
the operator's audited bypass — live on the workflow-step result the row points at, and copying them into
audit would be a second copy of a counter that only the reviewer's next verdict can move.

### Publishing a landing the completion gate would not acknowledge (RUFU-346)

Required post-merge evidence can block completion after the merge is already durable. Before this change the post-merge publish was a step that ran strictly *after* finalization, so every blocked or deferred arm returned or threw before it: the local integration ref had advanced, `origin` was never offered the landing, and the hosted gate that the card is waiting on cannot report against a ref the remote does not have. The wait was self-blocking — the missing evidence could never arrive because the publish that would let it arrive was gated behind the evidence.

The publish now runs inside finalization, before the refusal. Both events are written by the merger lane (`agentId: "merger"`, `runId: merge-<taskId>`, `target: <taskId>`, `domain: "git"`):

- `task:merge-publish-before-finalize` — the push step was reached. Metadata is `taskId`, `outcome` (`pushed`, or `not-pushed` when the push step ran and did not advance the remote ref) and `landingProof` (`lane` when the lane proved the landing in-process, `recorded` when only the durable `mergeDetails` record proved it). The transport detail stays on the `push:origin` row the push itself still writes; this row only explains why a push exists on a card that never completed.
- `task:merge-publish-before-finalize-unavailable` — a candidate existed and something stopped the push before it ran, which is the half that answers "why is landed work not on the remote?". Metadata is `taskId`, `hold` (fixed vocabulary: `policy-disabled`, `global-pause`, `task-paused`, `auto-merge-off`, `destination-changed`, `landing-proof-unproven`, `task-unavailable`, `authorization-unavailable`, `merge-aborted`, `push-failed`), `landingProof`, `landingProven`, and `reachedPush` (was the push step entered before the hold took effect). `push-failed` is the defensive member: a publish that *raised* inside the push step. A push that reports its own failure without raising records `outcome: not-pushed` on the published row instead, because the push did run.
- RUFU-396: `task:already-merged-never-delivered` records the self-healing reclaim sweep proving that a card whose branch tip was already merged never delivered **its own** work, so the stale worktree/branch/base metadata is reclaimed instead of the card being refused as a foreign-tip misbinding. The event exists because the refusal it replaces was terminal: the base can mention a card's id from commits that card never authored (a squash merge re-stamping another lineage's landed commit), and each such refusal burned one unit of the bounded branch-conflict budget until the card parked `branch-conflict-recovery-exhausted` with its work still to do. Metadata is ids/counts/fixed outcomes only (`taskId`, `branchTip`, `baseBranch`, `stampedBaseCommitCount`, `ownLandedCommitCount`, `declaredScopePathCount`, `outcome` from `reclaimed`/`metadata-clear-refused`); declared scope paths, commit subjects, touched paths, findings, and refusal sentences never enter the row. It is deliberately outside the curated delivery-pipeline catalogue, documents as prose here, and is emitted through the FN-9175 bounded seam, so telemetry cannot change the reclaim outcome. The rescue fires only on a **proven** absence: an undeclared scope, an unreadable commit, or an approved content review for that card leaves the previous verdict in place and emits nothing.

Neither row carries a remote URL, ref tip, error message, finding, or spec sentence; a failed push keeps its detail in the engine log and its own `push:origin` row. Emission is the bounded seam (FN-9175), so telemetry can never replace the blocked-finalization refusal the caller has to see. A pass that COMPLETED publishes too but records neither row here — the card is done and `push:origin` is its record — and a pass that was never blocked on required evidence emits nothing at all.

These two events are deliberately **not** in the curated delivery-pipeline event catalogue. That catalogue is the lifecycle record of a card moving through delivery and `run-audit-catalogue.test.ts` locks it table-for-table against the `## Delivery-pipeline finalization` section above; this pair records a git-transport decision taken on a card that never reached the completion leg, alongside the other prose-documented exceptions (`task:external-block-parked`, the chat-lane compaction pair, the worktree-base decision rows). Do not add rows for them to that table.

### A publish the project's own policy withheld (RUFU-338)

"Push to remote after merge" is off by default, so the ordinary merge in a default-configured project simply does not publish. Before this change that decision wrote nothing anywhere: the pair above fires only on the arms that refuse or defer completion on required post-merge evidence, and `push:origin` is written only by a push that actually ran. A card whose landed work stayed local because of a setting was therefore indistinguishable from a merge lane that died before it dispatched anything — the operator's only tool was reading the policy source (RUFU-337 F-4).

`task:merge-publish-policy-skipped` is that missing record, written by whichever lane decided not to publish, under the same identity the pair above uses (`agentId: "merger"`, `runId: merge-<taskId>`, `target: <taskId>`, `domain: "git"`). Metadata is `taskId`, `lane` (`single-repo` or `workspace`) and `reasonCode` — `setting-disabled` (the operator's switch is off) or `merge-strategy-suppressed` (publishing is on, but the pull-request strategy owns the transport). The two codes sit behind one hold code upstream precisely because their remedies are opposite. No remote URL, ref tip, branch name, or error text enters the row, and the single-repo lane also writes one task-log line naming the setting and the reason, so the card itself answers the question without a query.

The bound is **one publish-policy record per withheld publish — never zero, never two**. The evidence-blocked arm already carries `task:merge-publish-before-finalize-unavailable` naming `hold: "policy-disabled"` plus its visible refusal, so it is deliberately not given a second row; the arm that would otherwise leave no trace at all is the one that records here. Both arms are under test, because that sentence is only honest if each owning arm is asserted. Like RUFU-346's pair, this event is deliberately outside the curated delivery-pipeline catalogue and documents as prose here — do not add a row for it to that table.

### Which remote a publish actually touched (RUFU-366)

`push:origin` is the automatic post-merge publish row (the event NAME describes the lane, not the target, and is deliberately retained: every existing operator query, dashboard surface, and doc keys on it, and renaming it would break historical continuity for a naming-purity gain). Its `remote` key used to be filled from `settings.pushRemote ?? "origin"`, so the row said `origin` whether an operator had chosen that remote or had never configured anything — the record could not distinguish intent from a missing setting, and a missing setting also meant a real push to a server nobody picked.

Two keys answer those two questions separately now:

- `remote` is the target **actually offered** (`null` when nothing was offered). It is never a fabricated default.
- `remoteConfigured` is what configuration named — the configured publish remote, or the literal `"unset"`.

`outcome` gains `"refused"`, and it is the shape an unconfigured publish produces: `outcome: "refused"` with `reason: "publish-remote-unset"`, `remote: null`, and `remoteConfigured: "unset"`. A refusal is a **configuration refusal, not a transport failure** — it runs zero git commands, the merge still finalizes, and the card's History carries the canonical sentence `'merge.pushRemote is not configured — publishing the merge result requires an explicit publish remote (e.g. "lan" or "lan main"); nothing was pushed.'`. The remedy is an operator writing the setting, which is why it is not modelled as a `MergePublishHold` code: a hold reads as transient, this does not.

The confirmed-landing recovery lane — the pump-driven retry for a merge whose push was believed missed — deliberately writes **nothing at all** when the remote is unset: no `push:origin` row, no `pushRecovery` retry record, and no `branchAttempts` cooldown slot, because a per-pump-pass History line would spam and an unset remote is not a transport failure whose retry budget should be burned. That silence is an accepted observability tradeoff, and its discoverable surfaces are the settings themselves and the `refused` rows the two merge lanes write.

Metadata stays ids/outcomes-only in the family's own sense: the configured remote name is the one string the row exists to carry. Remote URLs, ref tips, credentials in a remote URL, review findings, and error prose never enter the row; a failed push keeps its detail in the engine log and in `stderrPreview`.

### The merge episode that a moving trunk kept discarding (RUFU-1100)

`merge:ai-tip-advance-rebuild` records one **accepted** rebuild of an AI-merge clean room whose only
changed input was the integration branch's tip. One row exists per rebuild, and no row exists for a
rebuild caused by anything else.

The event exists because the livelock it now bounds was invisible. On RUFU-702 (2026-11-18) a card sat
`in-review` through three tip-driven rebuilds over 2h20m: each advance of `main` discarded an approved
squash, the finding dispositions, the spent corrective budget, **and** the auto-merge retry race, so the
mechanism that was supposed to notice the loop was the thing each loop reset. The whole episode left one
engine log line per cycle and no audit row, so 40 passes were indistinguishable from a slow merge. A
second symptom of the same blindness was on the board face: the card showed `merging` and had advanced
`updatedAt`, and the review-stall classifier exempts `in-review` cards whose `updatedAt` moved — active
bookkeeping, not a stall — so the wedge alert could not fire either.

Metadata is `{ taskId, priorTipSha, liveTipSha, rebuildCount, reason, outcome }`:

- `priorTipSha` / `liveTipSha` are the two integration heads the rebuild moved between. They are
  content-addressed identifiers, which is what puts them in a row at all: this family's contract forbids
  prose and paths, and a SHA is neither. They are also the pair an operator needs in order to tell "the
  trunk moved" apart from "this card's branch moved", which is the distinction the whole event is for.
- `rebuildCount` is the durable count of consecutive tip-driven rebuilds inside the rolling window, read
  from the same increment the carry writes. It is not derived from `mergeRetries` and not from
  `MAX_CONCURRENT_ADVANCE_RETRIES`, which bounds a different cause (losing the landing compare-and-set to
  a concurrent advance) and is per-invocation.
- `reason` is `"tip-advanced"` for a tolerated rebuild and `"ceiling-reached"` for the pass that spent the
  code-owned ceiling. `outcome` is `"episode-carried"` or `"parked"` beside it, never independently.

**Consumer rule: one accepted rebuild writes exactly one row, and a row is never written for a rebuild
that was not accepted.** The emit happens after the compare-and-set that carries the episode, and the
`rebuildCount` increment inside that same write is the dedupe witness — a re-dispatch that observes no
drift never reaches the emit, so an engine restart can neither double-count a drift nor forget the bound,
and no process-local set is involved. `parked` is terminal for the episode: the card goes `failed` with the
retry race spent once in that same statement, no bounce, no re-review, and no automatic claimant. Reading
`episode-carried` rows without a following `parked` row therefore means the card is still waiting on a
trunk, which is the state the ceiling is a stop for. Cause-(a) invalidations — a changed source head, a
dismissed finding, an orphan writer — deliberately write **no** row of this type; they keep their own
wipe, and a row here would credit a wipe to the trunk.

This member is intentionally **outside** the curated `DELIVERY_PIPELINE_RUN_AUDIT_EVENTS` catalogue, which
`run-audit-catalogue.test.ts` locks table-for-table against that document's delivery-pipeline tables: the
row is a merge-window diagnostic about how often a base moved, not a delivery-pipeline stage. Precedent for
prose-only membership is `self-healing/sweep-failure-audit.ts` and the RUFU-462 boot heap-ceiling row. It is
also outside the AGENTS.md Run Audit list, since that list enumerates catalogue members. Emission goes
through the FN-9175 bounded seam (`emitBoundedRunAudit`), so an absent, throwing, rejecting, or hanging sink
cannot alter, delay, or fail the merge it is reporting on.

### Long-term memory budget maintenance (RUFU-279, RUFU-665)

`memory:long-term-over-budget` records a long-term `MEMORY.md` (project scope, or one durable agent's
own memory) that exceeds the code-owned byte budget; `memory:long-term-consolidated` records a rewrite
that actually landed; `memory:long-term-consolidation-failed` records a maintenance pass that refused
to write. Over-budget findings are rate-limited per file by a size/entry-count signature plus a 6-hour
cooldown, so a card that stays in the same condition reports once per window instead of once per
15-minute maintenance batch. A sweep with no breach and no failure writes no row at all.

Metadata is ids/counts/fixed enums only: `scope` (`project`/`agent`) with `agentId` when scoped to an
agent, measured `bytes`, `budgetBytes`, `overByBytes`, `entryCount`, booleans `duplicatesFound`,
`conflictsFound`, `tooLarge`, `overBudget`, `stillOverBudget`, counts `duplicateSectionsCollapsed` and
`conflictsRetained`, and the fixed `stage` enum
`read`/`too-large`/`backup`/`backup-scope`/`concurrent-write`/`write`/`verify`. Because the rewrite is
backup-first and loss-free, a `consolidated` row is also proof that a memory backup covering that file
was created in the same pass; `bytesBefore`/`bytesAfter` and `entryCountBefore`/`entryCountAfter` name
both sides of the change. Entry headings, entry text, diff text, file paths, and error messages are
never recorded — the durable memory content is precisely what an operator would have to redact.

**The cold tier adds no new event, only keys** (RUFU-665). An over-budget file whose sections are all
distinct used to be unfixable by any legal rewrite, so `stillOverBudget: true` was a permanent state and
a `-failed` row named the only remedy the pass had (collapse duplicates) — an instruction that could not
be followed. `memory:long-term-over-budget` now also answers *which* of the two remedies can still work:
`collapseCanConverge` and `retirementCanConverge`. Both false is the honest exhaustion case; either true
means a later pass can land. The pair is also what separates "we refused to open this file" from "we
opened it and could not fix it": the maintenance cost bound (`MEMORY_LONG_TERM_MAINTENANCE_MAX_BYTES`,
8 MiB) skips a file without parsing it, and before these booleans an above-ceiling breach and an
all-distinct parsed breach wrote the same nothing-can-be-done row. A ceiling skip claims NEITHER remedy —
an un-parsed file proves nothing about either — while a parsed over-budget file reports
`retirementCanConverge: true`, so `tooLarge: true` beside both false can now only mean the sweep never
read the file. The ceiling itself stays a skip: reclassifying it as a cost bound on *rewriting* rather
than on *reading* is a separate decision about how much of a 13 MB file maintenance may hold in memory
per pass. `memory:long-term-consolidated` gained `hotTargetBytes` (the sub-budget
convergence target the hot file is shrunk to, deliberately below `budgetBytes` so a converged file does
not re-breach on the next append), `rolledUpSections` and `rolledUpBytes`. `rolledUpBytes` is the
retirement delta **only** — `bytesBefore - bytesAfter` would also count the collapse, which the row
already reports separately as `duplicateSectionsCollapsed`, and "how much did retirement free?" is the
one number an operator needs in order to decide whether to trust the cold tier. A converged roll-up flips
`stillOverBudget` to false, which is the durable proof that the sweep converged rather than merely
reported.

What the cold tier's own identity is *not*: its **filename** appears only in the file itself and in the
`long-term memory consolidated` debug line, never in a queryable row. `ARCHIVE-YYYY-MM-DD.md` is a dated
path, and a dated path is exactly the value the memory audit contract keeps out of run-audit — so the row
counts how many sections moved and how many bytes they carried, and says nothing about where they went.
The cold tier is also never a maintenance target, and therefore emits no rows of its own: retiring into a
file that the same sweep later measures would move the byte ceiling onto the archive, which is the loop
this card exists to close.

The three events are deliberately absent from the curated `run-audit-catalogue.ts` delivery-pipeline
list: that catalogue is locked table-for-table against the delivery surface, and these rows are
background maintenance telemetry with no delivery pipeline to describe.
`packages/engine/src/__tests__/memory-long-term-audit-contract.test.ts` pins the declaration, the
documentation, and that exclusion together.

### A stale acquisition-conflict park re-validated against live git (RUFU-356)

`task:reconcile-stale-acquisition-conflict` records the sweep clearing a card that `status: "failed"`
was holding terminal because its stored error said the branch was already checked out somewhere, while
`task:reconcile-stale-acquisition-conflict-no-action` records a candidate it examined and left parked.
The premise of such an error is a fact about git, and git moves: RUFU-278 stayed undispatchable for
hours after its worktree path, its registration, and its `.git/worktrees/` administration directory had
all three disappeared, because the only remaining record of the conflict was the sentence itself. The
sweep therefore re-derives the conflict from live git (the same collision inspection the acquisition
path runs on every attempt) and acts only on a premise it can prove is gone.

Metadata is ids and fixed enums only, on both events: `taskId`, `column`, `priorStatus`, `code`, and
`outcome`. `code` is the closed re-derivation vocabulary — what a probe said (`premise-cleared`,
`live-registration`, `foreign-unmerged`, `probe-unknown`) or what a candidate gate said (`paused`,
`workspace-task`, `wrong-lane`, `probe-threw`) — so one query over
`task:reconcile-stale-acquisition-conflict-no-action` answers "why is this card still parked" without
reading the row. A surviving worktree path and a live branch registration share `live-registration`
because both are the same physical refusal; a tip already merged, a tip attributed to the card, and a
branch that no longer exists all report `premise-cleared`, which is also the only code that can clear.
A refusal is deduped per `(card, code)`, so a card that keeps refusing for the same reason reports once
per process rather than once per hourly pass, while a new reason for the same card is announced.

**`recovery-park-hold` (RUFU-395)** is the gate code for a card sitting on its own branch-conflict
exhaustion park. Every re-encounter of that park is now silent by contract — no task-row write, no
History line, no park row, no refusal row — so without this code the suppression would be literally
unobservable and "why is this card not moving" would have no answer. It is emitted once per card rather
than once per pass, which is what keeps the silence from becoming a void. The same change made
`priorStatus` honest on this family: it previously hardcoded `"failed"`, while a card parked on the
exhaustion hold is `paused`, and a diagnostic that misreports the state it is describing is worse than
none.

### The branch-conflict exhaustion register (RUFU-395)

`task:branch-conflict-recovery-parked` is emitted once per exhaustion park from any of its six sources,
with `boundedPasses` carrying **this recovery family's own** refusal count from
`sourceMetadata.branchConflictRecoveryEpisode`. It never carries `task.recoveryRetryCount`, which is
also written by planning's stale-branch recovery, the executor's worktree-failure path, triage's
planning budget, and `recordRetry`: a park row that reported that field could state a pass count the
branch-conflict family never produced (`after 26 bounded passes (budget 3)` was measured against a
single unmerged commit). A park persists no counter at all, so the reported number cannot exceed the
declared budget from any source.

`branch-worktree:irreducible-pause` gains `recoverySuppressed: true` plus `boundedPasses` on a pass
that found the hold already standing, which is the only trace such a pass leaves. Its metadata stays
ids/counts/fixed outcomes; the refusal sentence, the branch name, the worktree path, and any reviewer
prose stay out of both events, and both travel the FN-9175 bounded seam, so telemetry can neither
change nor delay a park.

The branch name, the worktree path, the refusal sentence, and any commit SHA are never recorded. That
is not tidiness: the probe returns an enum precisely so no caller can decide from prose, and the
sentence it replaced is exactly the artefact this sweep exists to stop trusting. Both events are
deliberately outside the curated delivery-pipeline catalogue and document as prose here.

### Scheduler pass stall

`scheduler:pass-stalled` records one scheduling pass whose re-entrance guard had to be forced open, emitted once per stall episode (not per interval tick) from `Scheduler.reportStuckPass`. Metadata is `leg` (the pass leg reached, from the closed set `idle` / `board-read` / `mission-symbol-locks` / `hold-release-sweep` / `post-sweep-reread` / `advisory-reporters`), `inFlightMs` rounded to whole seconds, `thresholdMs`, and the fixed `outcome` `guard-forced-open`. `target` and `runId` carry the project id; the board's root path never enters the row.

The row exists because the log line is not durable: the process log was measured truncating in place on 2026-10-30, which destroyed every force-open reading that day. Emission goes through the FN-9175 bounded seam, so an absent, throwing, rejecting, or hanging sink cannot delay or change the dispatch decision that follows the force-open. This event is deliberately outside the curated delivery-pipeline catalogue and is documented here as prose.

### Boot heap ceiling observation (RUFU-462)

`runtime:heap-ceiling` records one boot of a dashboard process whose V8 heap ceiling nobody chose: no
`--max-old-space-size` in `execArgv` and none in `NODE_OPTIONS`, so V8 used its platform default. On the
host that motivated this row the board was killed 28 times under the supervisor at 3.90–4.03 GB heap
(`Ineffective mark-compacts near heap limit`) while `/api/health` answered `ok` on every one of those
probes, because the health payload reported uptime, RSS, and event-loop delay while omitting the one
number that explained the deaths. The condition was therefore knowable only from a body count, and the
cardinality of "how many boots came up unconfigured?" existed nowhere.

The row is written by `reportHeapCeilingAtBoot()` (`packages/dashboard/src/heap-ceiling-notice.ts`), whose
sole call site is `createServer()` — the same function the CLI boot, the embedded desktop host, and tests
all go through, so one wiring covers every boot shape instead of maintaining a second copy of the
decision. It is emitted once per boot, fire-and-forget, through the FN-9177 bounded core seam
(`emitBoundedRunAudit`), so an absent, throwing, rejecting, or hanging audit sink cannot alter, delay, or
fail the boot that is reporting it. Only the default case writes a row: a ceiling a launch site declared
gets a log line and no audit row, because a declared value is not a condition worth counting and a quiet
row set is what makes this one countable.

Metadata is a byte count, one fixed three-value enum, and one boolean — `heapLimitBytes`, `source`
(`execArgv` / `NODE_OPTIONS` / `v8-default`), and `isV8Default`. The row describes the *site* and never its
*contents*: `source` says which launch site carried the flag, while the raw `NODE_OPTIONS` string is never
recorded. That variable legitimately carries connection strings and credential arguments on some hosts,
and the audit store is readable by anything with query access to it, so quoting it would turn an
observability row into a secret-leak surface. `runId` is `runtime:heap-ceiling:boot:<pid>`, which names the
process without putting a filesystem path or launch-environment text into metadata.

Like RUFU-279's `memory:*` trio, this event is deliberately absent from the curated delivery-pipeline
catalogue: `run-audit-catalogue.test.ts` locks that list table-for-table against the category tables above,
and a process's memory ceiling is not a delivery-pipeline step, so this section is written in prose rather
than as a table row. It is declared in `@fusion/core`'s `RunAuditMutationType` — the same placement as
RUFU-259's dashboard-emitted `task:comment-delivery` pair — because the emitter reaches its sink through
the core seam, not the engine's `DatabaseMutationType`.

### The task list read that was not bound to a project (RUFU-871 slice 2, staged)

`task:unbound-list-read` records a task LIST read executed on a shared-PostgreSQL data layer that
carries no bound project. `project.tasks` is one table partitioned by `project_id` and task identity is
project-local, so that read returns every project's cards into a process that serves one — the measured
mechanism behind a dashboard that grew with uptime at zero live execution (72 341 retained copies of one
foreign project's sentence; strings were 84.6% of the heap). Slice 1 put the partition into the query of
every list read it enumerated; this row is how the reads nobody enumerated yet get counted.

It is a **record**, not a refusal, and that staging is the contract. `TASK_LIST_READ_SCOPE_ENFORCEMENT`
in `packages/core/src/postgres/task-list-read-scope.ts` is the single flip point, and the promotion
condition is written beside it: promote to `"throw"` only once production traffic shows the violating
call-site set is empty or every site is bound. The violating set has been enumerated by hand for three
reads (slice 1) and not for the rest; the PostgreSQL suite's own harness runs an unbound layer over a
per-test cloned database — a legitimate own-database reader, and one this environment cannot run — so a
throw today would be an unmeasured new outage class on a process that already gets watchdog-killed
(RUFU-462), which is a worse outcome than one more diagnostic row.

Metadata is `{ reader, backendMode, enforcement }`: the `module:export` that performed the read (the
bindable site the row exists to name), a fixed backend-mode enum, and the enforcement level in force so a
later flip stays distinguishable in the data. It carries no task id, no row content, and no payload text —
the defect is precisely that this read pulls other projects' content, so a diagnostic that copied any of it
into the audit store would double the leak it reports. One row per violating read **site** per 15-minute
window (`UNBOUND_TASK_LIST_READ_NOTICE_FLOOR_MS`), never per call and never per row: RUFU-393's lesson is
that a bound whose key grows each cycle is a row flood, so the window is the bound and the counter never
enters the dedupe key. The same fact is written once as a warning line naming the remedy
(`createTaskStoreForBackend({ rootDir, projectId })`), because the remedy has to reach someone who never
queries the audit store.

Emission goes through the FN-9177 bounded core seam (`emitBoundedRunAudit` over
`recordRunAuditEvent(layer, …)`), so an absent, throwing, rejecting, or hanging sink cannot alter, delay,
or fail the read that is being reported — the guard must never itself become a lifecycle dependency. The
discriminator is the layer's existing `backend` descriptor (published only by `createAsyncDataLayer` from
`PostgresConnections`), not a new configuration flag: a legacy SQLite store has no async layer at all and
keeps `taskProjectScope`'s documented no-op cross-project read, emitting nothing.

Like RUFU-462's `runtime:heap-ceiling`, this event is deliberately absent from the curated delivery-pipeline
catalogue — a read-path diagnostic is not a delivery-pipeline step — so this section is prose rather than a
table row, and it is declared in `@fusion/core`'s `RunAuditMutationType` because the emitter reaches its
sink through the core seam, not the engine's `DatabaseMutationType`.

### The planning claim a dead turn left behind (RUFU-470)

`task:reconcile-abandoned-planning` records one reclaim of a planning-lane card that was still wearing
`status:"planning"` after the planner turn that wrote that status had died, and
`task:reconcile-abandoned-planning-session-no-action` records one card the same pass examined and left
alone. The sweep is `reconcileAbandonedPlanningSessions` (`packages/engine/src/self-healing.ts`), the only
owner of that shape.

The shape existed because three owners each waited on another. Triage's poll sweep clears every aged
`planning` card, but is suppressed while the processor's `processing` claim is held; triage's re-discovery
admits a `needs-replan` card only while no planner claim is held; and the in-memory eviction that could
release the claim refuses whenever any planner bookkeeping is retained — which is exactly what a dead turn
leaves behind. RUFU-467 sat in that deadlock for 73 minutes on a live engine, and was freed only when its
own hung promise chain resumed. Nothing on the board could answer "why is this card still planning?",
which is the question both rows exist to answer.

Metadata is ids, counts, and fixed enums only — `taskId`, `column`, `claimAgeMs`, `sessionSilenceMs`,
`ceilingMs`, `terminatedSessionCount`, `outcome` (`reclaimed` or `refused`), and `reason`. `claimAgeMs` is
measured from the claim's own start stamp and `sessionSilenceMs` from the last planner-lane agent-log row;
both are the measurement the decision rested on, and neither is `task.updatedAt`, which any writer bumps.
`terminatedSessionCount` counts planner turns the reclaim proved cancelled and disposed, and it is present
on a withheld signal too, because the termination really did happen even when the sweep stood down before
writing the status. Spec text, prompt content, error prose, session identifiers, and paths never enter
either row.

`reason` is a closed vocabulary, and it is the whole diagnostic: `live-session` (one FN-8492 triple leg is
positive, so the card is running), `abort-unproven` (the turn could not be proven cancelled, so nothing was
cleared), `finalize-in-flight` (a Plan Review or finalize handoff owns the card — FN-1312),
`triage-owned-unpinned` (aged but unclaimed, so triage's own poll sweep owns it within one poll),
`continuation-active` (the graph owns the next move), `paused`, `human-review-deferred`, `premise-held`
(the lane or one of the two bounds could not be measured), and `race-lost` (another writer moved the card
under the lock). Refusals dedupe per `(taskId, reason)` for the life of the process and re-arm on a
successful reclaim, so a sustained refusal stays countable without re-announcing every pass.

Both arms go through the FN-9175 bounded seam (`emitBoundedRunAudit`, never `createRunAuditor`), so
 telemetry can never become the reclaim's lifecycle dependency: an absent, throwing, rejecting, or hanging
 sink leaves the release, the status write, and the History line identical. Like `task:planning-reseed-cycle`
 and `task:planning-admission-stalled`, these two are deliberately outside the curated delivery-pipeline
 catalogue — a stalled planning wait is not a step of the delivery pipeline — and are found by mutation
 type.

### Project runtime unload (RUFU-871)

`project:runtime-toggled` records one operator switch of a project's runtime unload switch, in either
direction. `runtimeEnabled: false` unloads the project's engine runtime: no scheduler pass, no triage
poll, no self-healing maintenance, no heartbeat dispatch, no planner-overseer poll, no
workflow-continuation pump, no cron or maintenance sweep. It is not `globalPause` or `enginePaused` —
those are consulted at the END of a scheduler pass, so the pass and every read it performs keep
running; measured, passes ran 51–183 s per project (max 584 s) across ~25 projects in one process at
~435 DB transactions/second with zero UI requests, which is what held `/api/tasks/page` at 11–26 s
against `/api/health` at 0.09 s. The row exists because the switch has no observable live effect: a
project that silently does nothing is indistinguishable from a dead engine, and the UI badge only
proves what the browser that set it believes.

Metadata is the closed set `projectId`, `priorRuntimeEnabled`, `runtimeEnabled`, `source` — ids, two
booleans, and one fixed enum (`operator-api` | `operator-ui` | `settings-write`), where `source` is
declared by the transport that wrote the switch and never inferred from prose. No project name, no
reason text, no disarmed-lane list. `target` is the project id and `runId` is
`project-runtime-toggle:<projectId>:<timestamp>`, so one switch is one row and a row is attributable
without carrying who typed it. Emission uses the FN-9177 bounded core seam from the dashboard route
(`POST /api/projects/:id/runtime`), so an absent, throwing, rejecting, or hanging sink cannot fail the
switch it reports — the setting write is the durable act, and it lands first.

Disarming never aborts anything: a scheduler pass already in flight finishes normally, which is the
no-data-corruption condition behind the switch. Read paths are never gated, so the project's board,
cards, and history keep answering through the same `TaskStore` while its lanes stand down.

Like `runtime:heap-ceiling`, this event is deliberately absent from the curated delivery-pipeline
catalogue: an operator unloading a project is not a step of the delivery pipeline, so this section is
prose and not a table row. It is declared in `@fusion/core`'s `RunAuditMutationType` because the emitter
reaches its sink through the core seam, not the engine's `DatabaseMutationType`.

### Complete-lane boundary refusals and findings (RUFU-349)

Two rows belong to the invariant "a card enters a complete-trait column only through
merge-confirmed finalization or the no-merge mover". Both are declared in
`@fusion/core`'s `RunAuditMutationType` and both are deliberately absent from the curated
delivery-pipeline catalogue, which is locked table-for-table against the curated rows above.

`task:column-entry-refused-complete-column` records the graph refusing, at node entry, to move a
card forward into a complete-trait column. Node entry is a column-boundary write under
`bypassGuards: true`, so before this refusal existed a node drawn inside the Done column completed
the card BEFORE its gate had produced a verdict, and once the card stood in the terminal lane the
finalizer's evidence fences short-circuited and a later REVISE could never retract the move. The
node is not skipped: it runs in place, so its verdict still goes durable and the repair path stays
reachable. Metadata is `taskId`, `workflowId`, `nodeId`, `fromColumn`, `toColumn`, and a fixed
`code` (`complete-column-node-entry-refused`) - ids, lanes, and one enum. It carries no gate-finding
count on purpose: this refusal is structural and consults no evidence, so a count would claim a
measurement the code never takes. Emission is the FN-9175 bounded seam; a hostile or absent sink
cannot alter the refusal it reports. The authoring counterpart refuses the same shape at save time
(`store.assertWorkflowIrTraitsValid`), naming the offending node, while LOAD stays tolerant so an
already-persisted workflow can still be opened and repaired.

`task:complete-lane-gate-evidence-finding` records one report-only pass over a card ALREADY standing
in a complete-trait column whose required gate evidence refuses or is absent. It is the operator's
only durable answer to "which cards are wrongly in Done?": `fn task reconcile` refuses those cards
(now under the named reason `complete-lane-gate-evidence`, previously the meaningless `not-in-review`)
and lifecycle containment forbids hauling them backward, so visibility is the only repair available.
Metadata is `taskId`, `column`,
`workflowId`, `lane`, `state`, `gateCount`, `recordCount`, and a fixed `outcome` (`reported`) - ids,
counts, and two closed enums drawn from the shipped classifier's own vocabulary. Gate findings, verdict
text, reviewer prose, and the refusal sentence never enter this row; the sentence lives on the card's
History line and the mailbox notice.

The two lanes reach that row by different authorities, which is the distinction that made the sweep
worth having. The **refusing-row** half (`failed`/`REVISE`, a `skipped` with no waiver, an in-flight row
that never settled) comes from the move-side classifier, the same one that refuses a crossing. The
**still-owed** half - gate enabled and ZERO result rows - cannot come from that classifier at all, because
its post-merge `missing` is deliberately never a refusal (at move time the gate has not had its chance to
run, and `getTaskMergeBlocker` already refuses delivery for that shape). So the sweep asks
`getRequiredPostMergeEvidenceDecision` instead - the same requirement authority the merge door consults -
and maps its outcome onto the row's `state` (`resumable` -> `missing`, blocked `pending` -> `in-flight`,
blocked `skipped` -> `unwaived-skip`, blocked `failed`/`not-approved`/`duplicate` -> `not-approved`). Two
consequences follow from reusing that authority rather than re-deriving it, and both are load-bearing: a
card is a candidate only with `mergeDetails.mergeConfirmed === true` (an unlanded card in `done` is the
move guard's population, and two authorities announcing one card is how a report becomes noise), and the
board-level exemptions stay silent - no CI evidence reporter, a delivery shape with no post-merge phase, a
verdict that precedes the contract, or a producer that can never run again (RUFU-430 / RUFU-450). Without
those exemptions the sweep would name every landed card on a reporter-less board, which is precisely the
~700-notices-a-day defect RUFU-283 recorded.

Both rows are bounded, and in two different places, which is the distinction worth keeping: the
refusal row is naturally rare because a compliant graph never attempts the crossing, while the finding
row would otherwise fire once per maintenance tick forever on a card whose state is not self-clearing.
The finding's bound lives on the card, in the key-level `sourceMetadata.completeLaneEvidenceEpisode`,
and is honoured before every emission - an episode write that was refused is not followed by a row. Its
signature carries the lane, gate ids, and state and deliberately excludes every counter, because a bound
whose identity changes each cycle is not a bound. The cadence floor is 15 minutes, so a sustained finding
is at most four records per hour per card, and `recordCount` is how an operator sees a standing condition
age rather than disappear. The mailbox notice is bounded by a DIFFERENT window on purpose - one message per
`(card, lane + state, UTC day)` through the idempotent `sendMessageOnce` seam, on the day bucket of the
sweep's own clock - so the durable record can keep ageing while the alarming surface stays at one message a
day; a `sendMessageOnce` outage leaves the row and the card's History line intact and writes no row of its
own, because "nobody was paged" and "nothing was recorded" must stay distinguishable.

### Retracting an artifact the registry already accepted (RUFU-433)

`artifact:retracted` records one artifact retraction and one operator restore. It is declared in
`@fusion/core`'s `RunAuditMutationType` and is deliberately absent from the curated delivery-pipeline
catalogue: an artifact-registry correction is not a delivery-pipeline step, so this section is prose rather
than a table row, following the RUFU-462 and RUFU-279 precedent.

The event exists because a retraction is deliberately invisible everywhere else. A review artifact is
merge-grade input that executors, reviewers, and the operator read before deciding to merge; withdrawing
one moves no card, changes no gate verdict, clears no pause, and deletes nothing — not the row, not its
file on disk, not the History line it leaves on the parent card. Without this row the artifact simply
stops appearing in every default read, which is indistinguishable from it never having been registered.
The row is what makes "a claim was made here and then withdrawn" answerable after the fact.

One seam writes it: `retractArtifactImpl` (`packages/core/src/task-store/task-artifacts-ops.ts`), reached
through `store.retractArtifact` and `store.restoreArtifact`. Both the `fn_artifact_*` tool lane and the
dashboard HTTP route call that seam rather than writing the tombstone columns themselves, so neither can
emit the row twice nor skip it. Emission is the FN-9177 bounded core seam (`emitBoundedRunAudit`), so an
absent, throwing, rejecting, or hanging audit sink cannot alter, delay, or fail the retraction it reports.

Metadata is the closed set `artifactId`, `outcome` (fixed enum `retracted` | `restored`), `actorType`
(fixed enum `agent` | `user` | `system`), `reasonChars` (a count), and `taskId` when the artifact has a
parent card. Ids, one count, and fixed enums only. The reason **sentence** never enters metadata: it is
operator-facing prose, and it lives on the tombstone columns and on the parent card's History line, which
is the surface a reader of that card actually consults. `reasonChars` is what lets a query ask "were
retractions explained substantively or with filler?" without any text reaching the audit store at all.

An idempotent repeat emits nothing. When the same actor re-retracts an already-retracted artifact, nothing
changed, so the seam writes no tombstone, no History line, no audit row, and publishes no event — a retry
of a half-delivered tool call therefore cannot drift the tombstone clock or double-narrate the withdrawal.
`runId` is `artifact-retraction:<artifactId>:<action>`, which resolves both halves of one artifact's trail
without putting the artifact's title or content into a lookup key.

### The planning-lifecycle holder that outlived its code (RUFU-600)

`task:planning-lifecycle-orphan-reclaimed` and `task:planning-lifecycle-orphan-withheld` record one pass
each of the `reconcile-planning-lifecycle-orphan-holders` sweep (startup + maintenance batch 2, beside
`reconcile-abandoned-planning-sessions`) over sessions that still hold a card's planning-lifecycle advisory
key after the code that asked for it has gone. The acquisition path now proves its own teardown, so what is
left for a sweep to find is a holder another process, or an older build, abandoned. PostgreSQL offers no
lever over a foreign advisory holder except ending its session — `pg_advisory_unlock` releases only the
calling session's keys and `pg_cancel_backend` cannot unhold an idle-in-transaction one — so the sweep's
only action is `pg_terminate_backend`, which is why eligibility is a conjunction rather than an age guess:
the holder must carry the `fusion-planning:` prefix this product stamps on the `application_name` it opened
with (a client outside this product is never a candidate at any age, in the sweep or in the release route),
named the card it opened for, sit past the 15-minute floor PostgreSQL measures from the session's own state
change, not be running a statement, not be a session this process registered as live, belong to a card with
no planning or execution liveness signal, and still be the same pid the key reports when it is re-read
immediately before the act. The age floor and the card-liveness veto are enforced by the shared release
surface itself (`releasePlanningLifecycleAdvisoryKey`, whose floor constant
`PLANNING_LIFECYCLE_RELEASE_AGE_FLOOR_MS` the sweep imports rather than restates), so a caller cannot reach
a terminate by forgetting to check, and a route cannot lower the floor from a request body.

Metadata is a closed set of ids/counts/fixed outcomes — `taskId`, `holderLabel`, `pid`, `holderState`,
`ageMs`, `outcome` — emitted through the FN-9175 bounded seam under the synthetic `self-healing` run id.
Holder identity comes from `application_name` and never from a lock row: an advisory key is a `hashtext()`
digest and cannot name a card. A holder that names nothing reports `taskId: null` and is skipped rather than
guessed, so the withheld row's `outcome` vocabulary (`already-free`, `holder-moved`, `session-live`,
`card-live`, `terminate-refused`, `release-unproven`, `skipped`) is also the answer to "why is this session
still holding my card". Each refusal the shared release surface answers with folds onto that closed
vocabulary rather than widening it — a holder too young to be dead or a session that turned out to be
running reports `session-live`, a card that shows planning or execution liveness or a caller who cannot prove
it idle reports `card-live`, and a holder this product did not open or one the key no longer names reports
`holder-moved` — so one query still answers the operator's question without a new mutation type per reason.
`ageMs` is PostgreSQL's own measurement of the session state change, not a value
this process computed, and it is the number an operator needs when deciding to reclaim by hand through the
card's `planning-lock` route.

The sweep writes no `column`, no `status`, no `paused` and no `pauseReason`: a reclaimed key only stops
refusing the next acquirer, and the normal scheduler releases the card. Refusals dedupe per
`(card, outcome)` for the lifetime of the process, so a sustained refusal stays countable without
re-announcing every pass, and an accepted reclaim always also writes one task-history line, because the
operator's question is always about one specific card. Like RUFU-462's `runtime:heap-ceiling`, both events
are deliberately absent from the curated delivery-pipeline catalogue, which `run-audit-catalogue.test.ts`
locks table-for-table against this file.

### The leg a lane never materialised (RUFU-425)

`worktree:lane-leg-refusal` records the one event where a workspace lane was asked for a verdict it is
not able to give: a declared member leg under `task.workspaceWorktrees` whose directory is empty, absent,
or is not its own repository. Git resolves upward from such a path, so `rev-parse HEAD` answers with the
enclosing superproject's commit and `git status --porcelain` reports the folder containing the leg. That
affordance produced two recorded wrong verdicts on a six-lane project — a verification gate that wrote
`pass` with a green suite run in an empty directory, and an emptiness proof that answered `empty` and so
released a file-scope lease and authorised a worktree removal — while the only evidence of either was an
out-of-band operator probe of the folder itself, because nothing on the card distinguished "zero commits
ahead and clean" from "nothing here at all".

The row is written by `recordLaneLegRefusal`
(`packages/engine/src/worktree/lane-leg-refusal.ts`), the single place a refusal reaches the board, and
both of its durable effects are emitted there: one task-history line and this audit row. A refusal that
recorded only its audit row would reproduce the exact defect the card was raised for — a false green
whose only trace is a filesystem fact — so the History line carries what the row deliberately omits: the
classification's plain-language description, the refusal code, the seam that recorded it, the recorded
path, the directory's entry count (`unreadable` when the directory could not be read), and how many legs
the card declared. Metadata is ids, fixed enums and counts only — `taskId`, the refusing `repository`,
`code` from the closed refusal-code set, `source` from `deterministic-verification` / `checkout-emptiness`,
`legCount`, and `entryCount` (nullable) — because the refusal code is what a query groups on. A path is
not a dimension anybody groups by, and putting the recorded path there would name a filesystem location in
a store readable by anything with query access. `target` is the repository KEY from the task record, and
an emit without a run context lands under the synthetic `lane-leg-gate` agent and run id.

Emission is the FN-9175 bounded seam (`emitBoundedRunAudit` from `packages/engine/src/util/run-audit.ts`,
the wrapper that adds `phase`/`source`/`taskLineageId`), so an absent, throwing, rejecting, or hanging
audit sink cannot alter, delay, or replace the verdict being reported — pinned in
`packages/engine/src/worktree/__tests__/lane-leg-refusal.test.ts` by asserting a rejecting sink leaves the
refusal and the returned verdict identical. Bounded emission is not a courtesy here: the checkout-emptiness
prover answers `unknown` on the scheduler's admission path for every pass of a refused leg, so a prover
that awaited its own telemetry would have made an unreachable audit store a scheduling dependency. The
announcement is therefore bounded per path while the protective verdict is not.

The event is deliberately absent from the curated delivery-pipeline catalogue, which
`run-audit-catalogue.test.ts` locks table-for-table against this file: a lane that cannot be measured is
not a delivery step, and adding a row there would make an unmaterialised checkout look like a stage every
card is expected to pass through. Like RUFU-462's `runtime:heap-ceiling` and RUFU-279's `memory:*` trio,
it is documented in prose and declared in the typed catalogue module only. The paired surfaces — the
verification gate's `verificationFailure.reason: "lane-legs-not-materialized"`, the executor's
`LANE_LEGS_NOT_MATERIALIZED:` error prefix, and the invariant itself — are in *Architecture → Lane-leg
measurement invariant*.

### A Stash read that was refused rather than empty (RUFU-994)

`memory:stash-read-refused` records one refusal per (Stash server, code) per 15-minute window, at the
moment a project-memory read gave up. The event exists because a refused read and an empty memory store
were the same answer. On the host that motivated it, the Stash container log showed
`/api/v1/me/sessions/events/semantic-search` answered `401 Unauthorized` 2 334 times and the keyword
search likewise, while `POST /api/v1/me/sessions/events/batch` from the same process answered `201
Created` 8 320 times. Fusion reported none of that: every read surface — per-turn recall, the proactive
cue block, `fn_memory_search`, the Review Read path, `exists()` — fails closed to `[]` / `""` / `false`
by design, so "we were not allowed to look" was indistinguishable from "this project has stored
nothing". The operator's own requirement names the pair: *a recall that failed for auth must be
distinguishable from an entry where there really is nothing to find.*

The cause was an asymmetry in one argument, not in the transport: every write caller runs
`resolveStashMemorySettings(store, settings)` and so reaches the transport with the resolved global
`stash-api-key` secret, while every read path passed raw settings, whose `stashApiKey` is the schema
default empty string. The transport's `if (apiKey)` header rule then sent no `Authorization` header at
all. The refusal was real, correct on the server's side, and invisible on ours.

Metadata is four keys: `endpoint` (fixed enum `keyword-search` | `semantic-search` | `recent-events` | `read` |
`exists` — RUFU-1152 added `recent-events` for the lane that answers a query with no terms, so a refusal on a
broad recall no longer appears as a keyword-search refusal; `read()` and `exists()` keep their own surface ids
and record once each),
`code` (the closed read-outcome vocabulary in
[`docs/memory-backend-integration.md`](memory-backend-integration.md) § 3 — `key-unresolved`,
`refused-auth`, `refused-capability`, `rejected-request`, `unreachable`, `malformed`), `keyResolved`
(boolean), and `resultCount` (number). Nothing else may enter the row. Two codes are absent by
decision: `ok` writes no row, and neither does `no-match`, because `no-match` is the honest empty answer
and auditing it would bury the refusals under exactly the traffic the operator is trying to count —
`memory:stash-read-refused` therefore means "refusals", never "reads". `key-unresolved` is kept distinct
from `refused-auth` because they name different knobs: the first means Fusion sent no credential
(configuration), the second means Stash refused one it received (a wrong, revoked, or ungranted key).
Collapsing them would send the operator to the wrong one.

Neither the Stash URL nor the server's refusal sentence appears anywhere in the row, and `target` is the
fixed literal `stash-memory`. A Stash URL may legitimately carry credentials in its userinfo segment and
the audit store is readable by anything with query access to it — the same rule FN-9059 states for remote
URLs — so the URL stays the diagnostics map's internal dedupe key, and the sentence lives in the log line
where an operator is already looking. The `runId` names the (endpoint, code) pair instead of a server.

Emission is `reportStashReadOutcome()` in `packages/core/src/memory/memory-backend-stash.ts`, called from
the four core read entries (`readProjectMemoryWithBackend`, `searchProjectMemory`,
`buildProactiveMemoryCueBlock`, `buildPerTurnMemoryRecallCue`) — the places that already hold a
`TaskStore`, which satisfies both the resolver's duck type and the audit sink host, so no second store is
opened for telemetry. It is fire-and-forget through the FN-9177 bounded core seam: an absent, throwing,
rejecting, or never-settling sink leaves the recall result, the log line, and the recorded code identical
(pinned in `packages/core/src/memory/__tests__/stash-read-auth-transport.test.ts`), and the dedupe marker
advances even when the sink fails, so a broken audit store cannot become a row flood.

The bound is deliberate: a busy chat lane recalls every turn, so an unbounded emit on a standing
misconfiguration would write one row per turn. Fifteen minutes matches RUFU-393's stall-record floor, which
keeps a sustained refusal countable at four rows a day per (server, code) instead of one per message. The
same window carries one `log.warn` naming the code and endpoint class, and `GET /api/memory/backend` plus
`POST /api/memory/test` return the last outcome code as `stashReadOutcome` so the answer is available in
the memory settings surface the operator already opens.

Like RUFU-462's `runtime:heap-ceiling`, RUFU-279's `memory:*` trio and RUFU-871's
`task:unbound-list-read`, this event sits deliberately OUTSIDE the curated delivery-pipeline catalogue that
`run-audit-catalogue.test.ts` locks table-for-table against the category tables above: whether a memory
read was refused is not a delivery-pipeline step, and a row there would imply every card is expected to
pass through it. It is declared in `@fusion/core`'s `RunAuditMutationType` (the placement RUFU-259
established for core- and dashboard-emitted rows), because its emitter reaches the sink through the core
seam rather than the engine's `DatabaseMutationType`.

### A Stash read that dropped another project's rows (RUFU-1008)

`memory:stash-read-scope` records one filtered read per (Stash server, project, outcome) per 15-minute
window. It is the sibling of `memory:stash-read-refused` above and answers a different question: the
refusal row says *we were not allowed to look*; this row says *we looked, and the answer was not all
ours.*

Stash partitions memory by **owner**, and one operator has exactly one owner id, so every Fusion project
of that operator shares one read domain. Measured on the host that motivated this card: one Stash daemon
answered a `RUFU-1008` project's query with rows whose `metadata.discriminator` was `VLLM`'s and `GEDA`'s.
The read path now verifies each row's identity and drops what is not ours (see
[`docs/memory-backend-integration.md`](memory-backend-integration.md) § 4), which creates a new failure
mode the refusal row cannot describe: a query answered with **zero** usable rows because every row was
crossed out. "Nothing stored" and "everything was filtered away" were about to become the same empty
answer again, one step further along from the RUFU-994 pair.

Metadata is a closed six keys: `outcome` (fixed enum `all-own` | `dropped-foreign` | `dropped-unidentified`),
`matchedCount`, `ownCount`, `droppedForeignCount`, `droppedUnidentifiedCount` (numbers), and `limit`
(the row cap the caller asked for). Since RUFU-1146 the read asks for a window wider than that cap (see
[`docs/memory-backend-integration.md`](memory-backend-integration.md) § 4), so `limit` is still the page
the caller asked for while `matchedCount` counts what the server answered from that window — the ratio
between them is what makes the over-fetch measurable, and no other key changed. `dropped-foreign` wins over `dropped-unidentified` when a read dropped
both classes, and the two counts are reported separately so an operator can tell "the account is shared"
from "the server stopped returning `metadata`" — the first is expected on a multi-project host, the second
means recall is going blind and is the one that needs attention. `all-own` writes **no** row, matching
RUFU-994's `ok` / `no-match` silence: the common healthy read must not generate telemetry, or the drops
would drown in traffic the operator is trying to count.

There is deliberately **no `endpoint` key**, unlike the refusal row. Counts are taken after both the
keyword and the semantic branch have been scoped, so naming an endpoint would attribute a number to a
request the classification does not distinguish. No dropped row's id, text, or uri appears; no other
project's discriminator or name appears; the Stash URL appears nowhere in the row or in `target`, for the
same reason the refusal row omits it — a Stash URL may carry credentials in its userinfo segment and the
audit store is readable by anything with query access to it. `target` is the fixed literal `stash-memory`.

Emission is `reportStashReadScope()`, reached through `reportStashReadScopeForRoot()` from the same four
core read entries RUFU-994 instrumented (`readProjectMemoryWithBackend`, `searchProjectMemory`,
`buildProactiveMemoryCueBlock`, `buildPerTurnMemoryRecallCue`). It is one `log.warn` plus one row per
(server, project, outcome) per window — the same 15-minute floor, because a chat lane recalls every turn
and an unbounded emit would write one row per turn on a host where the sharing is permanent rather than a
misconfiguration. Emission goes through the FN-9177 bounded core seam: an absent, throwing, rejecting, or
never-settling sink leaves the recall result, the log line, and the recorded counts identical, and the
dedupe marker advances even when the sink fails (`packages/core/src/memory/__tests__/stash-read-scope.test.ts`).

The same counts reach the operator through `stashReadScope` on `GET /api/memory/backend` and
`POST /api/memory/test`, keyed by (configured server, **this** project's discriminator) so one project's
drops never appear on another project's page, and rendered by one shared component
(`MemoryStashScopeNotice`) that both memory surfaces mount — Settings → Memory and the Memory view cannot
word it differently. It says nothing when nothing was dropped.

Like RUFU-462's `runtime:heap-ceiling` and RUFU-279's `memory:*` trio, this event sits deliberately OUTSIDE
the curated delivery-pipeline catalogue that `run-audit-catalogue.test.ts` locks table-for-table: whether a
memory read had to discard another project's rows is not a delivery-pipeline step. It is declared in
`@fusion/core`'s `RunAuditMutationType`, because its emitter reaches the sink through the core seam.

### The graph row no consumer would take (RUFU-1050)

`task:reconcile-unclaimed-graph-work` records one repair performed by the owning pass
`reconcile-unclaimed-graph-work` (registered in startup recovery and maintenance batch 1) over a workflow
continuation that every existing consumer had already declined.

The population was measured at 136 todo cards on one board. A card in that shape holds a live planning item
— `state: "runnable"`, `waitReason: "planning"` — while its `task.status` is NULL. Three owners each
declined it for a reason that is individually correct and collectively a hole: the hold/release sweep
releases a planning wait only when `status` carries a value that is not `"planning"`, so a NULL status
fails its status test; the continuation drain reads only the FIFO due page, and a row deferred off that
page is invisible to it; the stranded-reclaim sweep reads only `retryAfter`, which a planning wait does not
set. Nothing dispatched it, and the release surface's sentence for it read "…and will run", so the card
promised a run that no code path existed to deliver.

The pass is a hand-off pass, not a second admission lane, and the row is what proves the difference. Its
three verbs are the authorities that already own each repair: a cleared deferral/lease through the CAS
`transitionWorkflowWorkItem` followed by a kick of the existing continuation handle; an execution re-arm
delegated whole to `attemptExecutionRearm` with the honest `self-healing-stranded-recovery` reason; and a
`needs-replan` write under the planning lifecycle lock, which is triage's own re-admission request. It
never moves a column, never seeds a continuation, and withholds absolutely whenever the FIFO page cannot be
read at all — a pass that cannot tell "queued behind 20 rows" from "never going to be taken" has no
business clearing a queue.

Metadata is ids, two fixed enums, and one counter: `taskId`, `column`, `code` (the decision from the closed
seam vocabulary), `action` (`redrive` / `rearm` / `replan` / `name-terminal`), `itemId`, `nodeSeam`,
`owner`, `outcome`, and `redriveCount`. Decision prose, prompt text, spec bodies, worktree paths, and error
text never enter the row.

`outcome` is the delegated authority's answer, written AFTER the hand-off rather than before it, and it is one
of four values: `repaired` (the authority took the hand-off and reported success), `announced`
(`name-terminal`, which reports a verdict and changes nothing by design), `already-owned` (a legitimate
refusal — another claimant holds the row), and `authority-refused` (the hand-off did not land). The first cut
wrote `repaired` eagerly for every action, so a card whose re-arm the execution authority refused carried a
durable row claiming a repair that had not happened, and `name-terminal` — which repairs nothing by
definition — claimed one too. A record that over-claims is worse than no record: it is durable evidence
pointing at a repair nobody can find. The refusal token the authority returned (`no-work-evidence`,
`not-eligible`, `cas-lost`, …) goes on the card's History line, never in the row.

### The withheld half of that row (RUFU-1050 code review)

`task:reconcile-unclaimed-graph-work-no-action` records one verdict the same pass examined and refused to act
on. The name was already used in the code's own comments, which is exactly the problem: the idiom in this
repository is that a refusal gets a paired `-no-action` event (RUFU-273's `task:planning-admission-stalled`,
RUFU-288's fence park, RUFU-356's acquisition conflict), and this class documented the idiom while emitting
only the acted half. The measured board produced what the review found: a query for the fleet of unclaimed
cards returned zero rows, and the pass's own result tally was dropped by both registrations
(`reconcileUnclaimedGraphWork().then(() => undefined)`), so "nothing happened" and "nothing was claimable"
were the same silent thing and got diagnosed with hand-written SQL.

The pair restores the two facts a refusal has to carry: what was refused, and who owns the card instead. Its
event name is deliberately absent from the curated delivery-pipeline catalogue, exactly like its acted half,
and is documented here as prose so `run-audit-catalogue.test.ts` stays in lock-step.

Metadata is the acted row's closed set plus two durations — `taskId`, `column`, `code`, `action` (always
`none`), `itemId`, `nodeSeam`, `owner`, `outcome` (always `withheld`), `stalenessMs`, `retryAfterMs`,
`redriveCount` — and again no prose.

Three bounds keep a recorded refusal from becoming the row flood it was designed to avoid:

- **Healthy work emits nothing at all.** `not-aged`, `not-planning-lane`, `live-session`, `operator-held`, and
  `auto-merge-off` are counted in the pass result and write no row, no History line, and no episode. RUFU-273
  and RUFU-372 each measured what happens when a sweep announces healthy cards or a card a human is
  deliberately holding: the store fills with cards that are fine and the stall stops being findable.
- **The bound is the card's own episode, not process memory.** `lastAction` and `lastReportedAt` ride the
  `unclaimedGraphWork` episode the pass already owns, so a sustained stall re-announces at most once per the
  six-hour floor *across restarts*. RUFU-318's bound was a process-local key, which limits a sustained stall
  to one row per boot rather than one per window — on a board that crash-loops, that is a flood with a
  healthy-looking cadence. An episode with no `lastReportedAt` (written before this pair of keys existed)
  counts as never announced, so an upgraded board reports the stalls it already has instead of inheriting
  silence.
- **The key never grows.** The repeat identity is `(code, action)` — never a counter or a measurement —
  because RUFU-442 measured what a bound keyed on a changing field does: every poll becomes a first
  occurrence. A code or action change always re-announces, since `due-unclaimed` and `terminal-node-orphan`
  are different questions about the same card.

The same bound gates `action: "name-terminal"`, the one acted verb that writes no repair and is therefore
pure announcement: without it, a card whose remedy is a human produces one row per pass forever. The repair
verbs (`redrive`, `rearm`, `replan`) are never gated there — each is bounded by the authority it hands off
to.

A pass that examined anything also logs its totals (`examined / redriven / rearmed / replanned / named /
withheld`), at `warn` when it acted and `debug` otherwise; zero-candidate passes stay silent. The level split
follows the diagnostics rule for this subsystem, and the vocabulary is `log/debug/warn/error` — this logger
has no `info`, and calling the missing method threw inside the pass's own `try/catch`, which is how a
totals line turned into a swallowed warning on every pass until the falsification run caught it.

The card's own History line is written through `logEntryOnce` (falling back to `logEntry` on a store
without it) under `[unclaimed-graph-work]`, deduped per (card, code, action) on a six-hour floor, so the
operator reading the card sees the same measurement the row carries. Its episode carrier is
`sourceMetadata.unclaimedGraphWork`, written KEY-level, whose `signature` is stamped by the decision seam
itself and never rebuilt by a reader: the redrive budget compares against that exact string, and RUFU-1027's
bound-that-was-not-a-bound came from exactly two writers spelling one key differently.

Two consumers depend on this event's shape staying boring. The operator's Retry clears the episode through
core's shared `buildManualRetryResetPatch` — the key is declared in core's `task-core` for that reason and
that reason only, since core cannot import the engine — and `classifyPlanningStrandedRetry` reads the same
episode as the *evidence* that admits the card to a non-destructive re-arm on all four surfaces. A register
the Retry cannot clear would make the pass refuse a card the operator had just released, and a classifier
that admitted on `status === null` instead would re-plan every healthy newly-triaged card on the board.

This event sits deliberately OUTSIDE the curated delivery-pipeline catalogue that
`run-audit-catalogue.test.ts` locks table-for-table against the category tables above: a repair pass over a
row nobody claimed is not a step every card is expected to pass through, and a catalogue row would imply
one. It is declared in the engine's `DatabaseMutationType` because its emitter reaches the sink through the
engine's `emitBoundedRunAudit` seam, and — like every row in this file — it cannot alter, delay, or fail
the repair it reports: an absent, throwing, rejecting, or hanging sink leaves the transition, the re-arm,
and the History line identical.

### The planning-lane worktree pointer whose owner had to prove it (RUFU-893)

`task:reconcile-planning-lane-worktree-identity-no-action` records one pass in which
`SelfHealingManager.reconcileTaskWorktreeMetadata` examined a planning-lane card, could not prove from
live git that its `worktree`/`branch` pointers were dead, and therefore left them standing. Before this
the sweep's planning-lane half cleared those two fields on one observation — whether a directory existed
at the persisted path — while three different code paths (the acquisition error park, the completion
fan-out, the archive disposer) already answered the same question with a tri-state ref probe. The
measured cost was five cards sitting in `todo` with a branch whose `refs/heads/` entry had been pruned:
no owner existed for a planning-lane card with a neutral status, since `reconcile-missing-worktree-merge-active`
is restricted to `in-review` merge-active cards, `reconcile-stale-acquisition-conflict` candidates only
from a card's own rebound lane, `reconcileTerminalBranchConflictParks` reads only complete-role lanes, and
`reconcile-orphaned-workspace-worktree` is workspace-only. A pointer whose premise is a fact about git must
be released by a git measurement, which is now the only thing that releases it.

Metadata is ids and fixed enums only: `taskId`, `column`, `code`, `outcome`, and `outcome` is always the
fixed `"withheld"`. **No branch name, no worktree path, no sha, and not one word of the refusal sentence
enter the row** — those four are the measurement an operator needs, and they live on the card's History
line, which is where the reader already is. A refusal is deduped per `(card, code)`, so a card that keeps
refusing for the same reason reports once rather than once per pass, while a new reason for the same card
is announced; the pass additionally logs its own totals (`examined / kept / cleared / refused`), so "the
sweep found nothing" and "the sweep refused everything it found" are different sentences in the log.

`code` is the closed refusal vocabulary: `ref-divergent` (the branch still carries commits the integration
branch never saw, so the pointers are the only record of unlanded work — the History line names the
commit count), `probe-unknown` (git refused to answer, and an unreadable repository is not proof of
absence), `lane-vocabulary-unreadable` (the role-resolved lane set could not be read, or reads fine but
places this card's lane nowhere this sweep owns), `held-or-live` (operator pause, checkout claim, or
external block stands behind the identity), `workspace-card` (`workspaceWorktrees` is non-empty),
`operator-branch` (`classifyTaskBranchOrigin` resolved the pointer as operator-supplied), and
`unmanaged-path-present` (the persisted directory exists but is not the managed per-id path, so only this
card knows it). `ref-divergent` and `probe-unknown` are the two codes the pre-change tree had no word
for at all, and they are the two that cost real work: a `git branch -D` of a branch whose commits were
never merged is unrecoverable by any later sweep.

The clear arm keeps its existing name and patch shape — `task:auto-recover-worktree-metadata-cleared` with
`{ worktree: null, branch: null, branchWriteOrigin: "engine" }` — as do the rebind and `scopeOverride` arms
and the FN-5256 `task:auto-recover-worktree-metadata-skipped-active` skip; the sweep still has exactly one
owner and this event is the only literal `run-audit.ts` gained. No refusal path deletes anything: no ref,
no directory, no `.git/worktrees/` administration entry, no column move, no `status`/`error` write, no
pause, no stall reason. The four emissions also moved onto `emitBoundedRunAudit`, so an absent, throwing,
rejecting, or hanging sink cannot stop a transition it is only reporting.

This event sits deliberately OUTSIDE the curated delivery-pipeline catalogue that
`run-audit-catalogue.test.ts` locks table-for-table: a planning-lane card is not expected to be refused, so
a catalogue row would imply a step every card passes through. It is documented as prose here, declared in
the engine's `DatabaseMutationType`, and emitted under the synthetic `self-healing` agent and run id.

### The self-healing pass that died silently (RUFU-898)

`sweep:pass-failure` records one pass-level abort of a self-healing maintenance sweep, and
`sweep:candidate-failure` records one card whose own repair threw inside a sweep that carried on. Both are
authored by `emitSweepFailureAudit` (`packages/engine/src/self-healing/sweep-failure-audit.ts`), a thin
wrapper over the FN-9175 bounded seam (`emitBoundedRunAudit`, never `createRunAuditor`), so telemetry can
never become a recovery pass's lifecycle dependency: an absent, throwing, rejecting, or hanging sink leaves
the pass's return value, its card writes, and its History lines identical.

A sweep that catches its own exception logs one console line and returns `0`. On the board that is
byte-identical to a healthy pass that found no work, so the only thing an operator could observe was "the
cards never moved", and the only way to learn a recovery pass had died was to open the daemon console. Two
instances were measured before this was written, and both were already documented as *fixed* — as test
failures. RUFU-405's own note in `no-verdict-review-stall-park.test.ts` records that a missing store seam
threw, this sweep's outer catch collapsed the whole pass into one log line, and three assertions silently
lost their meaning "with no visible cause"; the card repaired the test fake and left the product's silence
in place. RUFU-470's sweep then arrived with the same shape one day later: a card whose release seam threw
was neither recovered (`task:reconcile-abandoned-planning`) nor declined (`-session-no-action`), because
that family's nine-code refusal vocabulary has no code meaning "this candidate threw" — by design, a
throwing candidate never reaches a decision.

The two events stay separate because the two states are not interchangeable. A pass-level abort means zero
cards were reached; a candidate failure means the pass is still working and exactly one named card is not.
`sweep:pass-failure` therefore carries `sweep`, `outcome: "aborted"`, and `candidateFailureCount` — the
count of candidate rows this same pass already wrote, which is what distinguishes an early abort (`0`) from
a pass that died after doing damage. Its `target` is the sweep name and it carries **no** `taskId`: a pass
spans every card on the board, so naming one card would be a false claim about which one died. A retention
reader that skips a row with no task is the correct reading of that row, and no card is the subject of a
whole-board crash. `sweep:candidate-failure` carries `sweep`, `taskId`, and `stage`, with `target` equal to
the card id.

`sweep` is keyed on the **method** name (`recover-review-tasks-with-failed-pre-merge-steps`), not the
maintenance-batch registration name (`reconcile-review-revival`), because the method name is the string a
reader greps. It is a closed literal union (`SWEEP_FAILURE_SWEEPS`) rather than a free string, as is
`stage` (`SWEEP_FAILURE_STAGES`: `candidate-repair`, `revive`, `no-verdict-recovery`); the metadata builder
accepts neither field as a free string, so a call site cannot coin a code by typos.

Error class, message, stack, filesystem paths, and SQL fragments never enter either row. The seam accepts
the caught value as `unknown` and reads nothing from it — a structural claim, so it is proven behaviorally:
`sweep-failure-audit.test.ts` injects an error whose sentence contains a plausible path, an SQL fragment,
and a token, then asserts the emitted row deep-equals the three-key shape and that none of those substrings
appears anywhere in the serialized row. The console line keeps the sentence, exactly as RUFU-273's
`recovery-threw` precedent does.

Dedup is RUFU-318's bucket, keyed by the shared core `WEDGE_RENOTIFY_COOLDOWN_MS` (6 hours) and not by a
copy of that constant: the window's bucket is part of the key, so an expired entry expires by key shape
rather than needing an expiry table. Claim order is prune-then-check — a pass that dies every maintenance
poll for a week stays bounded at four records a day rather than growing the memo forever — and the memo is
in-process per `SelfHealingManager`, the same honest bound the neighbouring refusal dedupe carries.
`sweep:candidate-failure` is keyed by `(card, window)`, so two broken cards produce two rows and one broken
card produces one per window, never one per pass.

These events are a **third fact** and are deliberately added to no existing `-no-action` reason vocabulary.
That vocabulary means "this card was examined and a decision was reached"; these rows mean "the examination
or its repair died", and folding a death into a decision is precisely the laundering this file keeps
refusing. The nearest neighbour is `reviewRemediationDeclineCode`'s `recovery-threw`, which narrates the
CARD — and fires only in the half where no other owner narrated its own hand-off, which is exactly the half
that left the arm with no row at all. That is why the sweep-level row is unconditional for the arm.

To extend the family: any other self-healing pass with a swallow-and-continue catch calls the same two
helpers, and the whole job is adding its method name to `SWEEP_FAILURE_SWEEPS` and its arm to
`SWEEP_FAILURE_STAGES`. A new sweep never joins an existing sweep's vocabulary, and the window bound is a
property of the family, so it is not re-measurable per sweep — the property `sweep-failure-audit.test.ts`
proves is that a third sweep joining the family inherits the bound without restating it.

Both rows sit deliberately OUTSIDE the curated delivery-pipeline catalogue that `run-audit-catalogue.test.ts`
locks table-for-table against the category tables above (47 documentation rows, 47 catalogue events — a
48th documentation row without a catalogue entry breaks that test): a pass that died is not a step every
card is expected to pass through, and a catalogue row would imply one. They are declared in the engine's
`DatabaseMutationType` because their emitter reaches the sink through the engine's bounded seam. The `sweep:`
prefix is also disjoint from every prefix already in use, which is what lets a harness that counts *all*
audit rows for a sweep keep its expectations — RUFU-405 had to annotate exactly such a count (`reclaimRows`)
because a new row inside `reconcileAbandonedPlanningSessions` renumbered it.

### The sweep that could not prove its project root (RUFU-804)

`worktree:repo-root-refused` records one self-healing pass that ran **zero** git commands because it could not
prove its registered project root is a Git repository. It is authored in
`SelfHealingManager.surfaceRepoRootRefusal` (`packages/engine/src/self-healing.ts`) over the FN-9175 bounded
seam (`emitBoundedRunAudit`), with the fixed agent id `self-healing`, the fixed synthetic run id
`repo-root-probe`, and the git domain.

The event exists because two states used to produce identical evidence. Measured on one continuous production
era (daemon pid 4051354 on :4040, boot 2026-10-28 09:31:39Z, 473,765 log lines read at 11:04Z, era continuity
proven by health `uptime` 5,443 s against process `etimes` 5,457 s), the stale-active-branch reclaim sweep
logged `Stale active branch reclaim sweep failed: Command failed: git branch --list 'fusion/*'` followed by
`fatal: not a git repository` plus the `GIT_DISCOVERY_ACROSS_FILESYSTEM not set` line, **7 times — exactly once
per sweep invocation** — while its own success line `Reclaimed <n> stale active fusion branch(es) with no
usable worktree` appeared **0 times** (the bare substring `Reclaimed` matches 21 lines in the same era, all
belonging to two other sweeps, so the needle is not form-dead). `Worktree prune failed: Command failed: git
worktree prune` appeared **2 times** from the same missing precondition. The mechanism was reproduced with a
control: both commands fail at the workspace root `saneca-ws` and succeed in its member
`saneca-ws/lager-manager`, so the failing root is a **workspace folder that is not itself a repository while
its members are**. Because the reclaim sweep's whole per-card loop sat inside one `try`, the first git call
threw before any candidate was examined and the broad catch returned `0` — writing no reclaim row and no
History line. A reader therefore could not distinguish "the sweep ran and found nothing to reclaim" from "the
sweep could not look at all", which is the distinction an operator needs in order to act.

One event serves the whole root-git family; sweep identity is a fixed metadata enum (`sweep`:
`stale-active-branch-reclaim` | `maintenance-worktree-prune`) rather than a second event name — the
single-event style the orphaned-git-child no-action pair already uses — so a reviewer has one refusal
vocabulary to query. The metadata is a closed set of ids, counts and fixed enums only: `sweep`, `reason`
(`missing-root` | `not-repo` | `dubious-ownership` | `git-missing` | `timeout` | `unknown`), `rootState`
(`present` | `missing`), `candidateTaskCount` (the cards whose stale `worktree`/`branch` pointer could **not**
be reclaimed, counted from task rows and never from git), and `outcome: "refused"`. `target` is the fixed
sentinel `project-repo-root`.

`missing-root` is deliberately distinguishable from `git-missing`, and the order of the two probe steps is what
buys it: existence is checked **before** detection, because the shared classifier maps a missing working
directory to `ENOENT` → `git-missing` — a false claim that the git binary is missing, which would send the
operator to reinstall git instead of to fix the project registration.

The repository path, git's stderr, the detection sentence and the command line never enter `target` or
metadata. That is not a redaction policy applied after the fact: the operator sentence that *may* name the path
is produced by the probe (`operatorMessage`) and is handed only to the repeat-suppressed daemon log, which is
the last statement in the surfacing helper. The path has no route into the audit call at all, and
`self-healing-repo-root-refusal.test.ts` asserts the emitted row deep-equals the five-key shape with neither a
path nor an error substring present.

Emission is bounded, not per-pass: a row accompanies the pass whenever at least one durable per-card History
line was actually appended by the RUFU-643 once-seam, and otherwise fires once per manager lifetime through a
per-sweep latch that re-arms on a pass that proves the root — so a root that breaks again after being fixed is
news again. The latch is keyed **per sweep**, because two sweeps refusing inside one maintenance batch are two
distinct facts and a single shared latch made the second refusal silent again, which is the exact evidence gap
this event removes. Zero-candidate refusals are the normal case for the prune pass, which runs at the hourly
churn cadence, so an unbounded row would be an audit flood for one repeated fact. The in-process latch is never
the only bound — the durable per-card once-seam is what survives the supervised dashboard restarts that defeat
in-memory gates.

These rows sit deliberately OUTSIDE the curated delivery-pipeline catalogue that `run-audit-catalogue.test.ts`
locks table-for-table against the category tables above: a sweep that could not inspect its own project root is
not a step every card is expected to pass through, and a documentation **table row** for it would fail that
test — this section is prose for exactly that reason.

### The prompt-mode step that ran out of its budget (RUFU-684)

`task:workflow-step-timeout` records one PROMPT-MODE workflow-step session attempt that reached its
per-attempt budget and was disposed — one row per attempt, so a step that times out twice writes two rows,
never one row about the step. The emitter is the timeout branch of `executeWorkflowStep`
(`packages/engine/src/executor/execute-workflow-step.ts`), and the write is DETACHED:
`void emitBoundedRunAudit(...)` over the FN-9175 bounded seam, never an await. A step that has already
burned its budget must be disposed at once, so a stalled audit sink may not delay that disposal, and the
two-attempt fail-closed contract must not become a consumer of telemetry health. `workflow-step-timeout-run-audit.test.ts`
proves the promise behaviorally: absent, throwing, rejecting, hanging, late-resolving, and late-rejecting
sinks all leave the returned disposition, the session disposal, and the secondary-attempt decision
byte-identical, and raise no unhandled rejection.

The event exists because the class was invisible rather than rare. Before it, the only artifact of a timeout
was a `logEntry` line, and `tasks.log` is capped with its overflow deleted — the retention census this card
opened with read the surviving mirrors and found 361 primary timeouts across 95 cards in the retained agent
logs against ZERO durable rows, i.e. a lower bound, not a rate. On the same board the surviving History
windows held 456 timeout lines and 298 second-attempt re-arms while the durable `tasks.workflowStepResults`
carried the canonical timeout sentence in one row, because an expired primary that the secondary rescued
then approves leaves no terminal trace at all. Nothing countable survived: neither the rate, nor its
distribution by lane, nor whether a timeout is common or pathological, could be answered after retention.

Metadata is a closed ids/counts/fixed-enum set: `{ taskId, lane, workflowStepId, attemptKind, budgetMs,
phase, outcome }`, plus `repoRelPath` on the per-repository workspace review path, which opens one session
per repository and so legitimately writes several rows in one episode — without that key a two-repository
timeout would count as one. `lane` is the shared five-value vocabulary of
`packages/core/src/workflows/workflow-step-timeout-lane.ts` (`plan-review`, `code-review`,
`post-merge-verification`, `completion-summary`, `other-prompt-step`), and `attemptKind` is `primary`,
`same-model-retry`, or `configured-fallback` — the same three attempts the retry contract names, so "timed
out once" and "timed out twice" are distinguishable without reading prose. `outcome` says which side of the
fail-closed bound the row sits on: `attempt-remaining` for a timed-out primary (one documented attempt is
still unspent — it is NOT a claim that a second session was created, since a graph cancellation can still
intervene) and `budget-exhausted` for a timed-out secondary. Prompt text, model output, review notes,
findings, fingerprints, and the engine's own timeout sentence never enter the row.

`lane`, `workflowStepId`, `budgetMs` and `attemptKind` are exactly what `scripts/workflow-step-timeout-census.mjs`
needs to answer the question that motivated the card, and the census reads the same classifier through
`@fusion/core` rather than re-deriving it: a census script cannot import the engine's executor, so an
engine-only predicate would leave the measurement and the budget decision spelling the lanes differently by
construction. `phase` is the node's own `pre-merge`/`post-merge`, or `unspecified` when the caller had none
— defaulting an absent phase to `pre-merge` would turn an unknown into a claim about which side of the
merge the attempt ran on. When no run context is available (per-repository workspace reviews, resumed runs,
non-run callers) the row still lands under the synthetic identity `workflow-step-timeout` with run id
`workflow-step-timeout:<taskId>:<workflowStepId>:<attemptKind>`, following RUFU-259's
`task-comment-delivery` and FN-8600's synthetic `triage` precedent: a row that only survived when a run
happened to be trackable would leave the population this event was created to count exactly as invisible as
it was before.

The row sits deliberately OUTSIDE the curated delivery-pipeline catalogue that
`run-audit-catalogue.test.ts` locks table-for-table against the category tables above — a timeout is not a
step every card is expected to pass through, and a catalogue row would imply one. This is the same placement
as RUFU-531's `task:review-verdict-recorded`, RUFU-279's `memory:*` trio, and RUFU-462's
`runtime:heap-ceiling`: documented here in prose, declared in the engine's `DatabaseMutationType`, kept out
of the locked tables. To count the class, group the rows by lane and attempt kind:

```sql
SELECT metadata->>'lane', metadata->>'attemptKind', count(*)
FROM run_audit_events
WHERE mutation_type = 'task:workflow-step-timeout'
GROUP BY 1, 2
ORDER BY 3 DESC;
```
