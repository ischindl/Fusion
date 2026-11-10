/**
 * FNXC:CodeOrganization 2026-07-20-10:00:
 * Run-audit domain types peeled from types.ts.
 */

// ── Run Audit Types ───────────────────────────────────────────────────────────

/** Domain categories for run-audit events.
 *  - "database": TaskStore mutations (task updates, comments, etc.)
 *  - "git": Git operations (commits, branches, merges)
 *  - "filesystem": File system mutations (file reads/writes, attachments)
 *  - "sandbox": Sandbox backend lifecycle events for user-configured command execution */
export type RunAuditDomain = "database" | "git" | "filesystem" | "sandbox";

export type RunAuditMutationType =
  | "mergeQueue:enqueue"
  | "mergeQueue:lease-acquired"
  | "mergeQueue:lease-released"
  | "mergeQueue:lease-expired"
  | "task:handoff"
  | "task:handoff-invariant-violation"
  /*
  FNXC:ApprovalHoldMoveClear 2026-09-25-11:12 (RUFU-297 defect A):
  `task:move-cleared-approval-hold` is emitted post-commit by `moveTaskInternal` when a user-driven
  move out of a review lane clears an approval hold whose evidence the reopen hooks just destroyed
  (or the gated-session pause shape that move supersedes). Metadata: { priorStatus, awaitingApprovalReason
  (the reason-code enum, or "none" for the bare marker), fromColumn, toColumn, moveSource, outcome:
  "cleared" } — status, a fixed code, columns, and a fixed outcome; never hold prose or error text. The row is
  the audit proof of the hold/evidence pair invariant at the move seam; its ABSENCE next to a
  step-wiping review exit is what distinguishes defect A from a legitimate hold-preserving move
  (plan-approval release, graph remediation, preserveStatus, userPaused).
  */
  | "task:move-cleared-approval-hold"
  /*
  FNXC:CompleteColumnGateEvidence 2026-10-11-20:10 (RUFU-406):
  `task:move-refused-complete-column-gate-evidence` is emitted once per refused move into a `complete`
  column: an operator-attributed move (board drag, `fn task move`, or a direct store call that declared
  itself a user move) whose required workflow gates carry no approving evidence — zero rows, `pending`, a
  failed/`REVISE` row, or a `skipped` row with no audited bypass. Measured 2026-09-29: RUFU-389 and RUFU-337
  reached the terminal lane exactly this way and left no row behind, because the pre-existing invariant
  consulted only the merge BLOCKER, which an `in-progress -> done` move never reads.
  Metadata: { rejectionCode, toColumn, moveSource, moveCallerSurface, callerSessionId (only when a session
  marker proved it), gateCount, gateFindings ( `lane:gateId:state` triples, capped at 8) } — a fixed code,
  a column, fixed caller/gate-state enums, and counts. Never gate prose, reviewer findings, verdict text,
  file paths, or the refusal sentence (that lives on the card's History line). Emitted through the FN-9177
  bounded seam, so an absent, throwing, or hanging sink cannot change the refusal.
  */
  | "task:move-refused-complete-column-gate-evidence"
  /*
  FNXC:CompleteLaneBoundary 2026-11-08-13:36 (RUFU-349):
  `task:column-entry-refused-complete-column` is emitted by the graph's column boundary once per node
  entry that would have moved a card FORWARD into a complete-trait column. That move was the mechanism
  behind 21 `done` cards whose required post-merge gate reported `failed/REVISE` or had no result row:
  node entry writes the node's column before any verdict exists, and once the card stands in the
  complete lane the finalizer's evidence fences short-circuit, so a later REVISE cannot retract it.
  The refusal is STRUCTURAL and never consults the gate-evidence classifier, so this row deliberately
  carries NO gate-finding count — an evidence count here would be an unbacked field. Deliberately
  outside the curated delivery-pipeline catalogue (`docs/run-audit.md` documents it in prose, as
  RUFU-338/RUFU-346/RUFU-768 do).

  FNXC:CompleteLaneBoundary 2026-11-08-15:16 (RUFU-349, Code Review finding P2):
  Metadata: { taskId, workflowId, nodeId, fromColumn, toColumn, code } — one card, one graph, two columns,
  and the fixed code `complete-column-node-entry-refusal`. An earlier revision of this block promised
  `targetColumnTrait`, `phase`, `moveSource`, and `lifecycleReason`, which the emitter never writes: a
  documented field nobody writes is worse than an undocumented one, because the next operator queries it,
  gets zero rows, and concludes the refusal never happened. `code` is a constant here — its value is the
  point, since it distinguishes this structural refusal from the evidence refusal a mover gets — and the
  node's `config.phase` and the target's trait are readable from the graph the row already names.
  Never IR text, node config, prompts, gate findings, or the refusal sentence.
  */
  | "task:column-entry-refused-complete-column"
  /*
  FNXC:CompleteLaneBoundary 2026-11-08-13:36 (RUFU-349):
  `task:complete-lane-gate-evidence-finding` is emitted by the report-only
  `reconcile-complete-lane-gate-evidence` sweep for a merge-confirmed card ALREADY in a complete-trait
  column whose required gate evidence refuses or is still owed. Lifecycle containment forbids moving
  those cards backward and no verdict may be fabricated, so the repair is operator visibility, and
  before this sweep `fn task reconcile` answered them with `not-in-review`, which names nothing true.
  Deliberately outside the curated catalogue; documented as prose in `docs/run-audit.md`.

  FNXC:CompleteLaneBoundary 2026-11-08-15:16 (RUFU-349, Code Review finding P2):
  Metadata: { taskId, column, workflowId, lane, state, gateCount, recordCount, outcome } — ids, counts,
  and two closed enums taken from the shipped classifier's own vocabulary (`lane` pre-merge/post-merge,
  `state` missing/in-flight/not-approved/unwaived-skip). The row is NOT unconditional: it is emitted only
  for a pass whose key-level `sourceMetadata.completeLaneEvidenceEpisode` write was accepted, because that
  episode is what bounds the row and a bound that can be bypassed by a refused write is decorative (the
  RUFU-393 rule). `recordCount` is how a standing condition is seen ageing rather than vanishing. The
  mailbox notice is a separate, per-(card, state, UTC-day) write and is deliberately not reported back
  into this row — a mailbox outage must not change what was recorded, so `noticeDelivered` is not a field.
  Gate findings, verdict text, reviewer prose, and the refusal sentence never enter this row; the sentence
  lives on the card's History line and the notice.
  */
  | "task:complete-lane-gate-evidence-finding"
  | "overseer:intervention"
  /*
  FNXC:VanishedTaskDetection 2026-09-24-00:40 (RUFU-283):
  `task:vanished-approved-work` is emitted once per operator-visible finding by the
  `reconcile-vanished-task-dirs` sweep. Metadata: { taskId, reason, branchRef, unmergedCommitCount,
  gateApproved, salvageTarget } — ids, a fixed reason enum, counts and one derived ref; never mirror
  content, prompt text, log prose or error text.

  The literal names the class the operator must never lose silently (approved work with an unmerged
  branch), which is why it stays even though the sweep also reports the neighbouring classes: `reason`
  carries the taxonomy (`row-missing|row-tombstoned` × `branch-unmerged|branch-missing`, plus
  `row-tombstoned-branch-unprobed` and `state-unresolved` when the branch could not be probed, the
  former when a soft-delete tombstone already accounts for the row) and `gateApproved` says whether a
  gate actually approved the card. Do not read a row with `gateApproved: false` as a false positive — it
  is the same disappearance, just not yet an approved one. One row is written per finding and the row is
  unconditional, but only the alarming reasons also raise a mailbox notice: the two tombstone classes
  with no proven unmerged commit stay audit-only, so "nobody was paged" and "nothing was recorded" remain
  distinguishable from this table alone.

  `task:row-purged-for-resurrection` is the mandatory pre-write for a tombstone hard-delete on the
  resurrection path, so a purged id is always attributable. Metadata: { taskId, operation,
  allowResurrection, forceResurrect, deletedAtPresent, purgedWorkflowStepCount }. Both are written
  transactionally with the mutation they describe, which is what makes the purge fail closed.
  */
  /*
  FNXC:PlanningAdmissionStall 2026-09-25-19:31 (RUFU-273 Step 3):
  The planning-admission stall pair, one row per outcome of a `reconcile-planning-admission-stall` pass.
  `stalled` NOMINATES a card (its row now carries an episode code); `stalled-no-action` is a candidate the
  pass examined and deliberately left alone, with `outcome` naming why (`premise-held`,
  `recovery-backoff`, `triage-owned`, `already-named`). Without the second row "the sweep ran and had
  nothing to say" is indistinguishable from "the sweep never ran" — the same ambiguity RUFU-297 removed
  for approval holds. Metadata is ids/counts/fixed codes only: `taskId`, `column`, `code`, `ageMs`,
  `staleBranchCommitCount`, `outcome`, `scannedCount`. The branch is represented by its COMMIT COUNT,
  never a tip sha, and no spec text or blocker prose enters either row.
  */
  | "task:planning-admission-stalled"
  | "task:planning-admission-stalled-no-action"
  /*
  FNXC:CommentDelivery 2026-09-27-17:36 (RUFU-259):
  `task:comment-delivery` records one comment's routing attempt and `task:comment-delivery-unowned` the
  one case where no agent could be resolved at all. Before these rows existed a comment could be dropped
  (an `on-heartbeat` recipient skipped by the wake path, or a card nobody owns) while the write surface
  still answered 200, so nothing in the system distinguished "steering landed" from "steering
  evaporated". Metadata is ids/counts/fixed enums only (`source`, `kind`, `commentId`, `via`, `outcome`,
  `unroutedReason`, `skippedRungs`, `poolSize`, `messageStoreAvailable`, optional
  `messageId`/`noticeDelivered`); the comment body is operator prose and is never recorded.
  */
  | "task:comment-delivery"
  | "task:comment-delivery-unowned"
  /*
  FNXC:ReviewRemediationDeclineNarration 2026-09-27-06:25 (RUFU-351):
  One row per declined review remediation that a card was narrated for. RUFU-274 sat blocked in review
  with a failed Code Review gate while the revival sweep silently declined to schedule its fix: the
  decline existed nowhere an operator could read it. `code` names the class from a fixed enum
  (`checkout-unavailable`, `revision-budget-zero-or-invalid`, `skipped-without-narration`,
  `recovery-threw`), `gate` is the failed gate's identifier, and `column` is the card's column at
  decline time. Metadata is ids/counts/fixed enums only — `taskId`, `column`, `code`, `gate`,
  `scannedCount`; refusal sentences, findings, reviewer prose, and exception text never enter this row.
  A `superseded` probe emits NO row: a newer round owns the row, so nothing was declined.
  */
  | "task:review-remediation-declined"
  | "task:vanished-approved-work"
  | "task:row-purged-for-resurrection"
  /*
  FNXC:StoreOpenProvenance 2026-10-31-22:15 (RUFU-344):
  `store:open` is written by `initImpl` — the single body behind `TaskStore.init()` — once per store
  open, and its only job is to name the PROCESS that opened the shared project database. FN-7910 is
  the motivating incident: a stale binary opened the store, its init passes evacuated Ideas cards,
  and every row that writer left said only `agentId:"system"`, so the mutation could not be
  attributed afterwards. The stamp is the LAST await of a completed open, so it names the process behind
  the mutations a store makes afterwards; a store open that never completes stamps nothing, because the
  stamp is itself a write on the connection whose stall is being diagnosed — which is why
  `docs/architecture.md` still calls a bare 30 s `[taskstore-boot]` expiry un-attributable.

  Metadata is ids/paths only and exactly these six keys: `pid`, `ppid`, `execPath`, `entry`
  (`process.argv[1]`, `"unknown"` when absent), `cwd`, `nodeVersion`. Nothing content-y is legal here:
  no error text, no log line, no task title, no connection URL that could carry credentials, and no
  extra key — the row is written on every store open (every CLI invocation, every test harness), so
  anything else is multiplied across the whole fleet. `target` carries the bound project id
  (`"unscoped"` when the layer is project-agnostic) because the column is NOT NULL, and `task_id`
  stays NULL because opening a store is not a task mutation.

  Restored, not new: the event shipped in a628a13888 and was lost in 5ae6332563 when the SQLite
  dual-path collapse deleted its `insertRunAuditEventRow` call site while the `AGENTS.md` bullet
  describing it stayed. Tests that read unfiltered `runAuditEvents` must filter by `mutationType`
  instead of asserting exact counts, because one row now appears per store open.
  */
  | "store:open"
  /*
  FNXC:BuildProvenance 2026-11-01-03:18 (RUFU-359):
  `build:provenance-stale` is emitted once per boot by `reportBuildProvenance` when the LOADED
  artifact is provably older than the HEAD of the Fusion workspace that owns it, i.e. the operator is
  running an old build. It is the machine-readable twin of the `[engine] build provenance: … STALE`
  boot line, written because a TUI repaint can erase the console line while the fact is still true.
  Metadata is ids/counts/timestamps only and exactly five keys: `bundleMtime`, `headSha`, `headTime`,
  `ageMs`, `commitsBehind` (an integer, or the literal `"unavailable"` when `rev-list` failed — never
  a fake `0`). `target` is the artifact BASENAME, never an absolute path. Remedy text is not metadata:
  the boot line owns the operator-action sentence, and the commit sha is an id, not prose. The row is
  written ONLY on `stale` — `fresh` and `unknown` (ownership unproven, stat failed, toplevel outside
  the verified root, git missing, HEAD unparseable) emit nothing at all, which is what lets a
  package-installed copy under a host project's repository stay row-free instead of warning about
  commits that are not Fusion's. Emitted through the FN-9177 bounded seam, so an absent, throwing, or
  hanging audit sink cannot delay or fail startup.
  */
  | "build:provenance-stale"
  /*
  FNXC:HeapCeilingObservability 2026-10-01-11:34 (RUFU-462):
  One row per boot of a dashboard process whose V8 heap ceiling nobody chose. On the host that motivated
  this event the board was OOM-killed 28 times at 3.90-4.03 GB under the supervisor while `/api/health`
  answered `ok` every time, because the process had been launched without `NODE_OPTIONS` and V8 therefore
  used its ~4.09 GB platform default; no surface named the ceiling, so the condition was only discoverable
  from a body count. Metadata is a byte count, a fixed three-value site enum, and one boolean:
  `{ heapLimitBytes, source, isV8Default }`. The raw `NODE_OPTIONS` string is launch-environment content
  and never enters the row — a connection string in that variable would otherwise be readable by anyone
  with query access to the audit store, and `source` names the SITE rather than its contents.
  Emitted through the FN-9177 bounded core seam, so an absent or hostile audit sink cannot alter boot.
  Deliberately OUTSIDE the curated delivery-pipeline catalogue, the same exclusion RUFU-279's `memory:*`
  trio carries: a process's memory ceiling is not a delivery-pipeline step, so `docs/run-audit.md`
  documents it in prose and keeps it out of the category tables that the catalogue's table-for-table
  lock-step guard compares against `DELIVERY_PIPELINE_RUN_AUDIT_EVENTS`.
  */
  | "runtime:heap-ceiling"
  /*
  FNXC:ProjectRuntimeOff 2026-11-07-15:56:
  One row per OPERATOR switch of a project's runtime unload switch (`settings.runtimeEnabled`), in
  both directions. The row exists because the switch has no live effect the operator can see: a
  project that silently does nothing is indistinguishable from a dead engine, and the UI badge only
  proves what the browser that set it believes. Metadata is the closed set `projectId`,
  `priorRuntimeEnabled`, `runtimeEnabled`, `source` (fixed enum `operator-api` | `operator-ui` |
  `settings-write`) — ids and fixed booleans/enums only. No project name, no reason text, no lane
  list, and it is emitted through the FN-9177 bounded core seam so an absent or hostile audit sink
  cannot fail the switch it reports. Deliberately OUTSIDE the curated delivery-pipeline catalogue,
  the same exclusion `runtime:heap-ceiling` carries: an operator unloading a project is not a
  delivery-pipeline step. See `docs/run-audit.md` → Project runtime unload.
  */
  | "project:runtime-toggled"
  /*
  FNXC:TaskListReadProjectScope 2026-11-07-05:20 (RUFU-871 slice 2, staged):
  One row per violating READ SITE per 15-minute window when a task LIST read runs on a
  shared-PostgreSQL layer with no bound project — the shape that pulled other projects'
  task/log/steering strings into a one-project process (measured 84.6% of heap, 72 341 copies
  of one foreign sentence). The row is the enumeration the promotion to a hard refusal needs:
  until production traffic shows the violating call-site set empty or every site bound, the
  guard records instead of throwing, because a throw with an unmeasurable blast radius on a
  process that already gets watchdog-killed is a new outage class, not a diagnostic.
  Metadata is `{ reader, backendMode, enforcement }` — a code-site name, two fixed enums — and
  never a task id, row content, or payload text: the defect IS this read pulling other
  projects' content, so a diagnostic that copied it into the audit store would double the leak
  it reports. Emitted through the FN-9177 bounded core seam, so an absent, throwing, or
  hanging sink cannot alter the read it is reporting.
  Deliberately OUTSIDE the curated delivery-pipeline catalogue (RUFU-462's and RUFU-279's
  exclusion): a read-path diagnostic is not a delivery-pipeline step, so `docs/run-audit.md`
  documents it in prose and keeps it out of the tables locked to
  `DELIVERY_PIPELINE_RUN_AUDIT_EVENTS`.
  */
  | "task:unbound-list-read"
  | (string & {});

/** Input for recording a run-audit event. */
export interface RunAuditEventInput {
  /** ISO-8601 timestamp when the event occurred. Defaults to current time if not provided. */
  timestamp?: string;
  /** Task ID associated with this event (if applicable). */
  taskId?: string;
  /** Agent ID that performed the mutation. */
  agentId: string;
  /** Heartbeat run ID that initiated this mutation. */
  runId: string;
  /** The domain/category of the mutation. */
  domain: RunAuditDomain;
  /** Type of mutation (for example "task:update", "task:move", "task:handoff", "task:handoff-invariant-violation", "mergeQueue:enqueue", "git:commit", or "file:write"). */
  mutationType: RunAuditMutationType;
  /** Target of the mutation (e.g., task ID, file path, branch name). */
  target: string;
  /** Optional structured metadata about the mutation (compact, actionable data). */
  metadata?: Record<string, unknown>;
}

/** A persisted run-audit event record. */
export interface RunAuditEvent {
  /** Unique event identifier */
  id: string;
  /** ISO-8601 timestamp when the event occurred */
  timestamp: string;
  /** Task ID associated with this event (if applicable) */
  taskId?: string;
  /** Agent ID that performed the mutation */
  agentId: string;
  /** Heartbeat run ID that initiated this mutation */
  runId: string;
  /** The domain/category of the mutation */
  domain: RunAuditDomain;
  /** Type of mutation (e.g., "task:update", "git:commit", "file:write") */
  mutationType: RunAuditMutationType;
  /** Target of the mutation (e.g., task ID, file path, branch name) */
  target: string;
  /** Optional structured metadata about the mutation */
  metadata?: Record<string, unknown>;
}

/** Filter options for querying run-audit events. */
export interface RunAuditEventFilter {
  /** Filter by heartbeat run ID. */
  runId?: string;
  /** Filter by task ID. */
  taskId?: string;
  /** Filter by agent ID. */
  agentId?: string;
  /** Filter by domain. */
  domain?: RunAuditDomain;
  /** Filter by mutation type. */
  mutationType?: RunAuditMutationType;
  /** Start of time range (inclusive). */
  startTime?: string;
  /** End of time range (inclusive). */
  endTime?: string;
  /** Maximum number of events to return. */
  limit?: number;
}

