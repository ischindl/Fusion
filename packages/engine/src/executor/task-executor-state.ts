/**
 * FNXC:CodeOrganization 2026-08-04-07:10:
 * TaskExecutor instance state fields peeled to a base class (U4) so executor.ts keeps
 * thin method facades only. Fields are protected (not private) so TaskExecutor methods
 * and runtime tests that poke (executor as any).fieldName keep working.
 */
import type {
  Agent,
  AgentStore,
  TaskStore,
  Task,
  RunMutationContext,
  MergeResult,
  ThinkingLevel,
  WorkflowColumnAgent,
  ApprovalRequestStore,
  WorkspaceConfig,
} from "@fusion/core";
import {
  registerHostRetentionSource,
  type HostRetentionSourceKind,
} from "@fusion/core";
import type { ImplementationExit } from "./implementation-exit.js";
import type { ForeachActiveContext } from "../workflows/workflow-node-handlers.js";
import { ModelRegistry, type AgentSession } from "@earendil-works/pi-coding-agent";
import { CliTaskSession } from "../cli-agent/task-session.js";
import { TokenCapDetector } from "../errors/token-cap-detector.js";
import { StepSessionExecutor } from "../execution/step-session-executor.js";
import type { PausedAbortProvenance } from "./paused-abort-provenance.js";
import type { ActiveExecutorSessionState, TaskExecutorOptions } from "./task-executor-options.js";
import type { WorkflowAgentCapacity } from "../agents/workflow-agent-capacity.js";
import { invalidateWorkspaceConfigCache } from "./workspace-config-resolver.js";

let retentionSourcesRegistered = false;
let retentionExecutorHostsSkippedCount = 0;
/** How many later hosts were skipped by the once-per-process registration above (0 in production). */
export function readRetentionExecutorHostsSkipped(): number {
  return retentionExecutorHostsSkippedCount;
}

export abstract class TaskExecutorState {
  /**
   * FNXC:CodeOrganization 2026-08-04-08:05:
   * Constructor-injected store/rootDir/options live on the state base (U4) so pure
   * worktree facades and bags can share them without TaskExecutor parameter properties.
   */
  protected store!: TaskStore;
  protected rootDir!: string;
  protected options: TaskExecutorOptions = {};
  protected activeWorktrees = new Map<string, Set<string>>();
  /**
   * FNXC:WorkflowAgentRouting 2026-08-07-03:46:
   * Workflow stage reservations are intentionally independent from heartbeat slots.
   * Constructed in wireTaskExecutorLifecycle so direct graph admission and triage share the same class.
   */
  protected workflowAgentCapacity!: WorkflowAgentCapacity;
  /**
   * FNXC:WorkflowAgentRouting 2026-08-07-03:46:
   * Process-local index carrying a durable work item's narrow authority to the model tool gate.
   * Keyed by task for the live graph turn; removed in graph cleanup. isLive revalidates the exact record.
   */
  protected activeWorkflowAuthorities = new Map<string, {
    agentId: string;
    taskId: string;
    runId: string;
    workItemId: string;
    nodeInstanceId: string;
    /** Direct graph runs have no work-item row; claimed continuations must recheck it per tool call. */
    requiresDurableFence: boolean;
    kind: "task-assignee" | "review-node-override";
  }>();
  /**
   * FNXC:WorkflowAgentRouting 2026-08-07-03:46:
   * Live fenced principal per task for execute/review session identity (exact graph-selected agent).
   * `agent` is the admission-time row so session identity does not depend on a second getAgent round-trip.
   */
  protected activeWorkflowPrincipals = new Map<string, { agentId: string; nodeInstanceId: string; agent?: Agent }>();
  /**
   * FNXC:AgentActivityStream 2026-08-09-13:59 (restored 2026-08-15-22:15 after wave-18 shell-ification dropped it):
   * Node-scoped routed-principal retention (`taskId\0nodeId` -> agentId) that outlives release-principal,
   * because the graph can emit a terminal gate result AFTER the per-attempt reservation is released while
   * the activity outbox must still attribute that gate to the exact routed principal (FN-8864).
   */
  protected workflowGateActivityPrincipals = new Map<string, string>();
  protected executing = new Set<string>();
  /** Deferred terminal-park callbacks currently in flight (restart-recovery intent chain). */
  protected deferredTerminalParksInFlight = new Set<string>();
  protected resumingUnpaused = new Set<string>();
  protected approvalSuspended = new Set<string>();
  protected approvalResumeAfterUnwind = new Set<string>();
  protected recoveringCompleted = new Set<string>();
  protected capturedReflectionTaskIds = new Set<string>();
  /** Task ids that already had their Stash memory capture attempted (completion-gated). */
  protected capturedMemoryTaskIds = new Set<string>();
  protected workflowRerunPending = new Set<string>();
  protected workflowLifecycleMovesInFlight = new Set<string>();
  protected pendingTaskDisposals = new Map<string, Promise<void>>();
  protected unregisterTaskMoveDisposer: (() => void) | undefined;
  protected activeSessions = new Map<string, ActiveExecutorSessionState>();
  protected activeStepExecutors = new Map<string, StepSessionExecutor>();
  protected activeStepExecutorSeenSteeringIds = new Map<string, Set<string>>();
  protected effectiveColumnAgentByTask = new Map<string, string>();
  protected activeWorkflowStepSessions = new Map<string, AgentSession>();
  protected activePlanningWorkflowSessions = new Set<string>();
  protected activeWorkflowStepSessionSeenSteeringIds = new Map<string, Set<string>>();
  protected activeConfiguredCommandControllers = new Map<string, Set<AbortController>>();
  protected authoritativeAssignedAgentStore: AgentStore | null = null;
  protected activeWorkflowGraphAbortControllers = new Map<string, AbortController>();
  protected activeCliTaskSessions = new Map<string, CliTaskSession>();
  protected readonlyWorkflowStepAuditDone = false;
  protected activeSubagentSessions = new Map<string, Set<AgentSession>>();
  protected pausedAborted = new Set<string>();
  protected pausedAbortProvenance = new Map<string, PausedAbortProvenance>();
  protected completionFinalizedTaskIds = new Set<string>();
  protected depAborted = new Set<string>();
  protected stuckAborted = new Map<string, boolean>();
  protected userCanceledTaskIds = new Set<string>();
  protected graphExecuteSelfRequeued = new Set<string>();
  protected loopRecoveryState = new Map<string, { attempts: number; pending: boolean }>();
  protected spawnedAgents = new Map<string, Set<string>>();
  protected tokenUsageBaselines = new Map<string, { inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number; totalTokens: number }>();
  protected branchConflictErrorCount = new Map<string, number>();
  protected completedTaskWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  protected workflowRerunWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  protected pendingEphemeralDeletions = new Set<string>();
  protected workspaceConfig: WorkspaceConfig | null | undefined = undefined;

  /*
  FNXC:RetentionCensus 2026-11-06-09:02 (RUFU-871): make the executor's own retained set measurable.
  The dashboard's heap was being recycled every 1.8-3.3 h with `fusion_retention_coverage_ratio` at 7.5e-7:
  2,756 B tracked against a 3.67 GiB residual, because every registered source lived in `packages/dashboard`
  while the task-keyed structures that actually accumulate sit HERE. The census registry is now in
  `@fusion/core` (see `packages/core/src/retention-census.ts`) so both halves of one process report into one
  census, and these sources are the engine's half of that attribution.

  What this is meant to answer, and what it is not: the question is cardinality, not weight. If one of these
  collections keeps growing while the board is idle, it never released a finished task and its value — an
  `AgentSession`, a `StepSessionExecutor`, a CLI session — is what pins the megabytes of step text the heap
  snapshot showed (133k strings >= 4 KiB, 134 of them ~203 KiB each, all agent lane prose). Bytes are
  therefore reported as `entries x MAP_ENTRY_OVERHEAD_BYTES`, the documented floor, and deliberately NOT as a
  walk of the held objects: the probe contract in the census module is cheap and O(1), and summing transcript
  lengths would be an O(live sessions x transcript) prose walk on the scrape path. A source whose entry count
  climbs while its byte line stays a straight multiple of the overhead is the honest signal that the weight
  lives inside the values, which is the finding this instrument exists to produce.

  Registration is once per process, bound to the FIRST TaskExecutor host, because the source id is a metric
  label and two hosts publishing the same id would make `..._bytes{source}` meaningless. Production builds
  exactly one TaskExecutor, so the guard is a lie-proofing measure rather than a feature; a second host's
  maps are simply not reported, and `retentionExecutorHostsSkipped` counts how often that happened.
  */
  protected registerExecutorRetentionSources(): void {
    /*
    FNXC:SessionTranscriptMetering 2026-11-06-22:55 (RUFU-871):
    Joined BEFORE the once-only guard: the guard makes the other 27 sources belong to whichever executor
    constructed first, which on a multi-project dashboard prices one project's maps and reports another
    project's live sessions as absent. Transcripts are the class the operator asked about (whole LLM history
    held in RAM although `agent_runs` and `agent-log.jsonl` already persist it), so they publish per-instance
    through a registry and the figure is the aggregate over every project.
    */
    registerTranscriptCollector(() => ({
      bytes:
        measureTranscriptBytes(() => this.activeSessions.values())
        + measureTranscriptBytes(() => this.activeWorkflowStepSessions.values()),
      messages:
        measureTranscriptMessages(() => this.activeSessions.values())
        + measureTranscriptMessages(() => this.activeWorkflowStepSessions.values()),
    }));
    if (retentionSourcesRegistered) {
      retentionExecutorHostsSkippedCount += 1;
      return;
    }
    retentionSourcesRegistered = true;
    const entries = (coll: { size: number } | undefined): number => coll?.size ?? 0;
    const source = (id: string, kind: HostRetentionSourceKind, read: () => number): void => {
      registerHostRetentionSource({ id, kind, read });
    };
    source("executor_active_sessions", "session", () => entries(this.activeSessions));
    /*
    FNXC:SessionTranscriptMetering 2026-11-06-22:55 (RUFU-871):
    `bytesPerEntry: 1` because the read() value IS a byte figure — the default 96 B/entry overhead priced two
    live sessions at 192 bytes no matter how much conversation they held, which is how the census came to
    report 3.4 kB of a 5.9 GiB heap. The message count carries no bytes so it cannot double-count the same
    transcript.
    */
    registerHostRetentionSource({
      id: "executor_retained_transcript_bytes",
      kind: "session",
      bytesPerEntry: 1,
      read: registeredTranscriptBytes,
    });
    registerHostRetentionSource({
      id: "executor_retained_transcript_messages",
      kind: "session",
      bytesPerEntry: 0,
      read: registeredTranscriptMessages,
    });
    registerHostRetentionSource({
      id: "executor_retained_transcript_truncated",
      kind: "counter",
      bytesPerEntry: 0,
      read: () => (transcriptScanWasTruncated() ? 1 : 0),
    });
    registerHostRetentionSource({
      id: "executor_transcript_instances_refused",
      kind: "counter",
      bytesPerEntry: 0,
      read: transcriptCollectorsRefusedCount,
    });
    source("executor_step_executors", "registry", () => entries(this.activeStepExecutors));
    source(
      "executor_step_executor_seen_steering",
      "registry",
      () => entries(this.activeStepExecutorSeenSteeringIds),
    );
    source(
      "executor_workflow_step_sessions",
      "session",
      () => entries(this.activeWorkflowStepSessions),
    );
    source(
      "executor_workflow_step_seen_steering",
      "registry",
      () => entries(this.activeWorkflowStepSessionSeenSteeringIds),
    );
    source("executor_planning_sessions", "session", () => entries(this.activePlanningWorkflowSessions));
    source("executor_cli_task_sessions", "session", () => entries(this.activeCliTaskSessions));
    source("executor_subagent_sessions", "session", () => entries(this.activeSubagentSessions));
    source(
      "executor_configured_command_controllers",
      "registry",
      () => entries(this.activeConfiguredCommandControllers),
    );
    source("executor_completed_watchdogs", "registry", () => entries(this.completedTaskWatchdogs));
    source("executor_rerun_watchdogs", "registry", () => entries(this.workflowRerunWatchdogs));
    source(
      "executor_gate_activity_principals",
      "registry",
      () => entries(this.workflowGateActivityPrincipals),
    );
    source("executor_pending_disposals", "registry", () => entries(this.pendingTaskDisposals));
    source("executor_token_usage_baselines", "counter", () => entries(this.tokenUsageBaselines));
    source("executor_captured_memory_tasks", "registry", () => entries(this.capturedMemoryTaskIds));
    source(
      "executor_captured_reflection_tasks",
      "registry",
      () => entries(this.capturedReflectionTaskIds),
    );
    source("executor_completion_finalized", "registry", () => entries(this.completionFinalizedTaskIds));
    source("executor_graph_execute_requeued", "registry", () => entries(this.graphExecuteSelfRequeued));
    source("executor_loop_recovery_state", "registry", () => entries(this.loopRecoveryState));
    source("executor_spawned_agents", "registry", () => entries(this.spawnedAgents));
    source("executor_user_canceled_tasks", "registry", () => entries(this.userCanceledTaskIds));
    source("executor_paused_aborted", "registry", () => entries(this.pausedAborted));
    source("executor_dep_aborted", "registry", () => entries(this.depAborted));
    source("executor_stuck_aborted", "registry", () => entries(this.stuckAborted));
    source("executor_branch_conflict_errors", "registry", () => entries(this.branchConflictErrorCount));
    source("executor_executing", "registry", () => entries(this.executing));
    source("executor_pending_ephemeral_deletions", "registry", () => entries(this.pendingEphemeralDeletions));
  
    /*
    FNXC:RetentionCensus 2026-11-06-12:36 (RUFU-871): the step-output producer sources are registered here too,
    so they exist on `/metrics` from engine start. They are module-level, not per-host, and the registry refuses
    a duplicate id, so this is a no-op for every executor after the first.
    */
    registerStepOutputRetentionSources();
}

  /** Workspace mode is memoized per executor host; a real settings transition must refresh it live. */
  public invalidateWorkspaceConfig(): void {
    this.workspaceConfig = undefined;
    invalidateWorkspaceConfigCache(this);
  }
  protected childSessions = new Map<string, AgentSession>();
  protected totalSpawnedCount = 0;
  protected tokenCapDetector = new TokenCapDetector();
  protected _modelRegistry?: Promise<ModelRegistry>;
  protected _approvalRequestStore?: ApprovalRequestStore;
  protected currentRunContexts = new Map<string, RunMutationContext>();
  protected outerConcurrencyClaims = new Set<string>();
  protected graphToolFailureRunCursors = new Map<string, number>();
  protected graphStepSessionPinned = new Set<string>();
  protected graphStepRunOnce = new Map<string, Promise<{ taskDone: boolean; modifiedFiles: string[]; exit?: ImplementationExit }>>();
  protected graphStepActiveContext = new Map<string, ForeachActiveContext>();
  protected graphRethinkNarrations = new Map<string, string>();
  protected graphColumnAgentResolver = new Map<string, (nodeId: string) => WorkflowColumnAgent | undefined>();
  protected graphUnattendedRuns = new Set<string>();
  protected graphSeamGoverningNodeId = new Map<string, string>();
  protected graphSeamThinkingLevel = new Map<string, ThinkingLevel>();
  protected graphSeamSkillName = new Map<string, string>();
  protected mergeRequester?: (taskId: string, options?: { signal?: AbortSignal; graphOwnedPostMergeTraversal?: boolean }) => Promise<MergeResult>;
  /** ProjectEngine-owned fence for automatic failed no-verdict review recovery. */
  protected rerouteFailedNoVerdictPreMergeReview?: (task: Task) => Promise<"rerouted" | "pending" | "changed" | "unavailable" | "not-applicable">;
  protected sessionContentionHoldAttempts = new Map<string, number>();
  /**
   * FNXC:CodeOrganization 2026-08-04-07:40:
   * Process-wide graph-routing set lives on the state base (U4). Instance getter keeps
   * host.graphRouting / host.constructor.processWideGraphRouting bag access unchanged.
   */
  protected static processWideGraphRouting = new Set<string>();
  protected get graphRouting(): Set<string> {
    return (this.constructor as typeof TaskExecutorState).processWideGraphRouting;
  }
}
import { registerStepOutputRetentionSources } from "./step-output-retention.js";
import {
  measureTranscriptBytes,
  measureTranscriptMessages,
  registerTranscriptCollector,
  registeredTranscriptBytes,
  registeredTranscriptMessages,
  transcriptCollectorsRefusedCount,
  transcriptScanWasTruncated,
} from "./session-transcript-retention.js";
