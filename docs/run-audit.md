# Run-Audit Catalogue

The run-audit catalogue for the S4 **Reliability, Durability & Observability** delivery-pipeline theme — a durable, single-source-of-truth reference for *who did what, when, and why after the fact* across the delivery pipeline's reliability/observability event surface.

## Overlap wait release

`task:overlap-wait-released` is emitted after the transactional overlap receipt becomes ready. Metadata is limited to task/predecessor IDs, episode/common-file counts, and the fixed `resume`/`briefing` plus freshness enums; paths, diffs, summaries, prompts, and remote URLs remain in the project-scoped receipt. Emission uses the engine bounded best-effort seam, so absent, throwing, rejecting, hanging, or late-settling sinks cannot alter synchronization, validate a plan, start work, or roll back the owner decision. The stateless plan-premise release check and durable receipt—not audit—are authoritative; run-audit is not exactly-once and is never re-emitted by every recovery tick.

`task:overlap-delivery-reconciled` is emitted when a delivered predecessor commit rewritten by an integration-branch rebase is proven equivalent to a commit the execution checkout does contain. Metadata is limited to `taskId`, `blockerTaskId`, `repository`, the original and reconciled SHAs, the fixed proof enum, and the episode count; paths, diffs, summaries, and reviewer prose stay in the project-scoped receipt. Emission uses the same engine bounded best-effort seam, so an absent, throwing, rejecting, hanging, or late-settling sink cannot approve a delivery, alter the refusal, or change the owner decision. Refusals are deliberately not audited: they are bounded, repeated per dispatch, and already named in the deduplicated task-log diagnostic.

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
| `task:auto-merge-finalize-column-mismatch-no-action` | Finalize found a column mismatch but took no action (e.g. blocked/no-action per triple-proof). |
| `task:post-finalize-verification-no-op` | Post-finalize verification ran and found nothing to verify (no-op), recording the check outcome. |
| `task:no-commits-finalize-blocked-incomplete-steps` | Finalize is blocked for a zero-commit task with incomplete workflow steps (FN-6461 lane). |
| `task:empty-merge-finalize-blocked-no-landed-proof` | The AI empty-merge lane vetoes a zero-diff no-op finalize with no landed proof (FN-8141). |
| `task:finalize-unproven-blocked` | Finalize is blocked because finalization has not been proven against the landing truth. |
| `task:merge-boundary-unproven-parked` | A workflow merge boundary could not be proven and its terminal park is recorded with best-effort, time-bounded telemetry that never blocks or stalls the park. |
| `task:finalize-lost-work-blocked` | Finalize is blocked because it would discard work (lost-work guard). |
| `task:auto-recover-stale-merger-status` | Self-healing clears a stale merger status left on a finalize path. |
| `task:merge-admission-deferred-live-execution` | Merge admission found a live executor session, execution lock, or active task signal and deferred without parking the task. Metadata contains task ID plus fixed source, signal, and outcome values only. |
| `task:reconcile-confirmed-merge-checklist` | A confirmed merge reconciled stale non-terminal checklist steps or pending pre-merge results before terminal finalization. Metadata contains task ID, source, counts, prior column, and fixed outcome only. |

## Self-healing reconciliation events

Reconciliation-scoped auto-recover/reclaim events the self-healing sweep surfaces when it repairs board state after the fact.

| Event | What it records / when it fires |
| --- | --- |
| `task:auto-recover-paused-abort-park` | Self-healing clears a benign pause-abort operator park and requeues the task. |
| `task:auto-rebound-paused-scope-decay` | Self-healing rebounds a task whose paused scope decayed past its floor, unblocking followers. |
| `task:auto-archive-failure-budget-exhausted` | Historical event retained for reading pre-removal logs; current self-healing does not archive tasks. |
| `task:reclaim-phantom-executor-binding` | Self-healing proves an in-memory executor-active binding is stale and requeues the task. |
| `task:reconcile-orphaned-pending-step-results` | Self-healing rewrites orphaned `pending` workflow-step results (no live session) to `failed`. |
| `task:reconcile-unproven-review-approval` | Self-healing rewrites singular content-review approvals without input proof to recoverable `failed` results. |
| `task:reconcile-stale-duplicate-decision` | Self-healing clears a recurring duplicate-decision pause with no canonical target. |
| `task:reconcile-stale-agent-assignment` | Self-healing clears stale durable Agent.taskId/state drift while preserving file-scope leases. |
| `task:reconcile-engine-downtime-active-timing` | Self-healing shifts active-task anchors to exclude proven stopped-engine wall-clock. |
| `task:reconcile-engine-downtime-active-timing-no-action` | Self-healing finds no active task qualifies for downtime-timing reconciliation (no-action). |
| `task:reconcile-undeclared-column` | Self-healing re-homes a row out of a column its workflow no longer declares. |
| `task:reconcile-wedged-active-merge` | Self-healing reclaims a wedged single-flight merge entry. |
| `task:reconcile-stranded-completed-no-action` | A stranded-completed promoter withholds promotion of an all-steps-done/skipped task with a failure-park provenance (no-action). |
| `task:reconcile-legacy-adoption` | Self-healing startup adopts a pre-cutover legacy task row through the KTD-8 adoption table. |
| `task:reconcile-archived-into-done` | Self-healing moves a live historical archive row or restores a cold snapshot into the task's workflow completion lane. Metadata is limited to the task ID, source, counters, and a fixed outcome. |

### Orphaned git child reaper

`worktree:orphaned-git-child-reaped` records one signal-only termination pass (RUFU-210) over reparented git child processes still holding a removed task worktree as their cwd — the post-mortem shape of the RUFU-194 incident (`git rebase --continue` → `git commit -e` wedged on a missing editor for 1d13h after the worktree was gone). The sweep runs at startup recovery and, cadence-gated with the other git/worktree churn steps, in maintenance batch 1. A candidate must be a `git`-named process under a registered worktrees scan root whose directory is proven removed (readlink failure or the kernel ` (deleted)` cwd suffix) and whose `/proc` starttime proves it is older than the 30-minute grace floor; it receives SIGTERM, then SIGKILL after a 5 s grace, capped at 10 reaps per sweep. The sweep signals processes only — it never mutates task, worktree, or lifecycle state. One row is emitted per deleted worktree path with `target` = the path and metadata limited to `count`, `pids` (capped at 20), `ageMs`, the fixed `reason` (`deleted-worktree-cwd` or `deleted-cwd-suffix`), and `outcome: "reaped"`. Command lines, argv, other-process cwd values, and error prose are never recorded. On a host without `/proc` the sweep emits nothing at all — the absent row is the signal that the host could not be probed.

`worktree:orphaned-git-child-reap-no-action` is the deduped sibling: emitted once per manager lifetime (re-armed after any reap row) when the sweep ran on a probeable host and found no candidates, with `target: "orphaned-git-children"` and metadata `{ count: 0, outcome: "no-action" }`. Both writes use the FN-9175 bounded best-effort seam and are intentionally outside the curated delivery-pipeline event catalogue.

## Durable-agent error-state

Events that make durable-agent error states and their recovery inspectable.

| Event | What it records / when it fires |
| --- | --- |
| `agent:auto-recover-error-state` | A recoverable, non-operator-actionable durable-agent error is cleared by the heartbeat/self-healing sweep and retried. |
| `agent:reset-error-state-on-startup` | An engine restart clears an eligible durable-agent error/exhaustion park and re-arms the heartbeat (startup-only). |
| `agent:error-retry-exhausted` | A durable-agent error retry budget is exhausted and the agent is parked `paused` with pauseReason `error-retry-exhausted`. |
| `agent:error-parked-unrecoverable` | An operator-actionable durable-agent error parks the agent `paused` with pauseReason `error-unrecoverable` for human repair. |
| `agent:heartbeat-move-skipped-soft-delete` | A heartbeat move races a soft-deleted task and is skipped without parking the durable agent. |

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

## Maintenance contract

Adding a new catalogued run-audit event requires updating **both** the typed catalogue module (`packages/engine/src/run-audit/run-audit-catalogue.ts`) **and** this doc together — the parity test (`packages/engine/src/__tests__/run-audit-catalogue.test.ts`) fails if the documented event set and the catalogue module's set ever diverge, keeping the observability surface truthful as the real `DatabaseMutationType` union evolves. Removing an event likewise requires updating both in the same change.

### Emit-seam policy

All engine telemetry must use `emitBoundedRunAudit` from `packages/engine/src/util/emit-bounded-run-audit.ts`. It is best-effort and never load-bearing for lifecycle correctness: absent/non-function, synchronously throwing, rejecting, never-settling, and late-settling sinks are absorbed without altering the owning branch. The seam swallow-logs and bounds each write; it intentionally adds no retry, backoff, or queueing.

This applies to executor, run-auditor, self-healing, merger, PR reconciliation, scheduler, project-engine, plugin, mission-loop, hold-release, goal diagnostics, overseer advisor, mesh-lease, in-process runtime, credential rotation, and workflow-column-boundary emitters. `packages/engine/src/merge/merge-write-fence.ts` retains its bespoke non-`RunAuditEventInput` recorder. New engine emitters must ship with a behavioral sink-health regression covering hostile sink states, not only a source-routing assertion.

### Core emit-seam policy

Core best-effort emitters use `packages/core/src/run-audit/emit-bounded-run-audit.ts`. This is a deliberate copy of the engine seam because `@fusion/core` cannot import `@fusion/engine`; it synchronously invokes a valid sink, then absorbs throws, rejection, timeout, and late settlement without making telemetry lifecycle-load-bearing. `emitBoundedRunAudit` is the default void seam. `emitBoundedRunAuditWithOutcome` returns `recorded`, `absent`, `failed` (with the original error), or `timed-out` where a forensic throw ordering or caller-visible skipped payload depends on the audit result; workflow-switch torn reconciliation and phantom committed-reservation reconciliation use it. FN-9181 applies FN-9178's class-A decision to detached recall capture: `memory:capture-recorded` and `memory:capture-failed` are bounded, while the injectable `deps.audit` adapter remains a test seam with its existing bare-metadata contract. Transactional writers and explicitly awaited durability/ordering writers remain unbounded. `packages/core/src/__tests__/core-run-audit-sink-health.test.ts` and `core-run-audit-emitter-isolation.test.ts` respectively enforce hostile-sink behavior and source routing.

### Awaited core exclusion decision

FN-9178 classified awaited sites with hostile-sink characterization tests. FN-9180 routed the class-A `task-deleted-outbox:catch-up`, `:reconciliation-fallback`, `:lease-fenced`, and `:retention-pruned` rows through `emitBoundedRunAudit`; each remains awaited at its post-acknowledgement, post-cursor, or post-DELETE position so bounded telemetry preserves ordering. FN-9181 routed detached recall capture through the same bounded seam. `task:workflow-switch-torn` and `task:reconcile-phantom-committed-reservation` are class B and use the bounded outcome seam because their throw/result payload depends on audit outcome. `task:bypass-review`, `task:resume-step`, and both resurrection-blocked records are class C and intentionally unbounded: they claim persistence before return, destructive cleanup, or a forensic throw.

All `recordRunAuditEventWithinTransaction(tx, ...)` calls and the `recordRunAuditEventBackend(tx, ...)` transactional call are permanently out of scope. Their audit row shares a transaction with the mutation it describes; bounding would split that atomicity. The full matrix and evidence pointers are in the FN-9178 `decision` task document; `excluded-awaited-run-audit-store-sites.test.ts`, `excluded-awaited-run-audit-layer-sites.test.ts`, and the core routing ratchet pin this boundary.

### Review convergence events

`task:review-finding-disputed`, `task:review-convergence-escalation`, `task:review-arbitration`, and `task:review-convergence-human-escalation` record review-cycle progression. `task:review-convergence-escalation` includes the fixed `escalationSource` outcome (`dedicated`, `execution-fallback`, or `none`); its `hasModelTarget` flag is true only when a distinct model pair was resolved and persisted. Metadata contains only ids, counts, and fixed outcomes; provider/model identifiers, dispute rationales, findings, reviewer feedback, and arbiter output are never recorded. All five emission sites use the FN-9175 bounded best-effort seam, so hostile telemetry cannot alter or block the ladder, arbitration release, or dispute result.

`task:review-empty-content-parked` records the one-time terminal close for a provably empty Code Review input. Its metadata is limited to task and workflow-step ids, the resting column, and the fixed failed outcome; reviewer prose and findings remain off audit rows. The empty-merge finalize-blocked events also include the fixed `parkedStatus: "failed"` outcome. These writes use bounded best-effort emission and are intentionally outside the curated delivery-pipeline event table.

`task:review-input-recaptured` records a positive review lane that proved its own checkout fast-forwarded and re-bound its identity to the final reviewed content. `task:merge-stale-content-review-rerouted` records a singular stale-content merge refusal, from merge admission or self-healing, that attempted graph-owned review re-entry. Self-healing may recover the bounded-retry rejection, raw merge-door blocker, or retry-exhausted park only after re-seeding the stale lane; metadata uses task and workflow-step ids, fixed reroute reason/source, and fixed park outcome fields (`parkShape`, `parkCleared`, `mergeRetriesReset`) only. Neither event records fingerprints, diffs, paths, findings, or reviewer prose. Both use the FN-9175 bounded best-effort seam.

| Event | Metadata |
| --- | --- |
| `review-remediation-appended` | Task id, gate id, wave, and count only. |
| `review-remediation-parked` | Task id and fixed park outcome only. |

### External block lifecycle

`task:external-block-parked` records a task entering a durable external freeze, and `task:external-block-cleared` records operator Retry publishing its exact resume continuation. Metadata is IDs and fixed classifications only: task id, origin, code, source, column, and resume node id. The `project-configuration` origin and `dependency-readiness` source use the same event pair for proven repeating worktree initialization failures. Command strings, diagnostics, repository paths, and worktree-state tokens remain on `Task.externalBlock` or its private worktree record and are never copied into run-audit metadata. Both writes use the bounded best-effort emitter and are intentionally outside the curated delivery-pipeline event catalogue.

`task:step-session-abort-contained` records an interrupted step-session repair that retains the current lifecycle lane, checkout, node, and completed step progress. Its metadata is IDs, counts, and fixed outcomes only: task id, current column, abort trigger, recovery outcome, and completed-step count; it never includes failure text or step names. The executor emits it through the bounded best-effort seam, and it is intentionally outside the curated delivery-pipeline event catalogue.

`task:merge-unrun-pre-merge-gate-rerouted` records a merge-admission, self-healing, or graph-failure-sink attempt to seed the earliest enabled pre-merge gate that has no result or a verdict-less failure. It uses the FN-9175 bounded best-effort emitter and records only `taskId`, `nodeId`, `workflowStepId`, fixed `reason`, fixed `source` (`merge-gate`, `self-healing`, or `graph-failure`), and `missingGateCount`; it excludes reviewer prose, findings, fingerprints, blocker text, and errors. RUFU-217 extends the fixed `reason` enum additively with `verdictless-seeded` (the earliest seedable gate was a verdict-less failed gate, re-seeded within budget) and `rerun-budget-exhausted` (the gate's persisted per-task per-gate rerun budget is spent, so the card will surface to the operator instead of reseeding); `missingGateCount` keeps its existing meaning of the resolved required-gate count, and no metadata keys were added.

`task:graph-failure-after-handoff-honored` records the graph-failure sink honoring a completed handoff instead of terminalizing it: an execute-family node (execute / step-execute) failed for a row that was already in the workflow's resolved review lane with all plan steps done, `status`/`error` null, and not user-paused, so the card is left exactly as found (under `autoMerge: false`, `in-review` is terminal-until-human). Emitted through the bounded best-effort seam with IDs and a fixed reason only: `taskId`, `nodeId` (the failing execute-family node, `"unknown"` when the graph recorded none), `column` (the resolved review lane the card is honored in), and fixed `reason: "work-complete-handoff"`; the benign log sentence, failure text, and token totals never enter run-audit. It is intentionally outside the curated delivery-pipeline event catalogue.

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
