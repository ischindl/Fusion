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
  `state-unresolved` when the branch could not be probed) and `gateApproved` says whether a gate
  actually approved the card. Do not read a row with `gateApproved: false` as a false positive — it is
  the same disappearance, just not yet an approved one.

  `task:row-purged-for-resurrection` is the mandatory pre-write for a tombstone hard-delete on the
  resurrection path, so a purged id is always attributable. Metadata: { taskId, operation,
  allowResurrection, forceResurrect, deletedAtPresent, purgedWorkflowStepCount }. Both are written
  transactionally with the mutation they describe, which is what makes the purge fail closed.
  */
  | "task:vanished-approved-work"
  | "task:row-purged-for-resurrection"
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

