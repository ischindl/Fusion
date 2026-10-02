import { isPlanReviewSatisfied, PlanningLifecycleLockTransportError, type Task, type TaskPlanningFenceRequirement, type TaskPlanningFailureState } from "@fusion/core";

export const LEGACY_NULL_PLAN_HANDOFF_STALE_MS = 30 * 60 * 1000;

export type PersistedPlanHandoffKind = "planning" | "approved-null" | "legacy-null";

export function isPlanningLifecycleLockTransportError(error: unknown): error is Error {
  return error instanceof PlanningLifecycleLockTransportError
    || (error instanceof Error && error.name === "PlanningLifecycleLockTransportError");
}

/**
 * FNXC:PlanningLifecycleLock 2026-08-23-06:25:
 * Graph boundaries can flatten a typed transport rejection to text. Keep the
 * recovery fallback anchored to the lock's five canonical messages so a generic
 * timeout never changes executor retry classification.
 */
export function isPlanningLifecycleLockTransportFailure(error: unknown, message: string): boolean {
  if (isPlanningLifecycleLockTransportError(error)) return true;
  return /^Planning lifecycle lock (?:acquisition timed out after \d+ms|acquisition failed|cleanup timed out after \d+ms|cleanup failed|transport unavailable: .+)$/i.test(message);
}

/**
 * FNXC:PlanningFenceRecovery 2026-10-02-01:20 (RUFU-288):
 * The durable planning-lane fence refuses with `workflow-principal-fence-unavailable:<role>`, and
 * since RUFU-318 it appends the cause in parentheses while preserving `cause` programmatically.
 * The prefix is matched, not anchored: RUFU-318 deliberately promised that appended diagnostic
 * detail must not break `startsWith` guards, so an classifier anchored to the end of the string
 * would silently lose the class again the next time somebody widens the sentence. That anchored
 * match is precisely how the RUFU-287 incident lost its classification: the same 5 s
 * `pg_advisory_lock` grant timeout that the plan-capture seam classifies as lock transport and
 * retries with backoff was re-wrapped by the fence, fell through every classifier, and terminalized
 * the card as `PLANNING_FAILED_EXHAUSTED` — an authoring verdict for an infrastructure refusal.
 */
export const WORKFLOW_PRINCIPAL_FENCE_UNAVAILABLE_PREFIX = "workflow-principal-fence-unavailable";

const WORKFLOW_PRINCIPAL_FENCE_PREFIX_PATTERN = /^workflow-principal-fence-unavailable(?::([A-Za-z0-9_-]+))?/;
/** Contained (not anchored) form of the five canonical lock messages, for cause-detail text. */
const PLANNING_LIFECYCLE_LOCK_TEXT_PATTERN = /Planning lifecycle lock (?:acquisition timed out after \d+ms|acquisition failed|cleanup timed out after \d+ms|cleanup failed|transport unavailable: [\s\S]+)/i;
const MAX_FENCE_CAUSE_DEPTH = 8;
const FENCE_DETAIL_MAX_CHARS = 300;

export type WorkflowPrincipalFenceFailure = {
  role: string;
  requirement: TaskPlanningFenceRequirement;
  detail: string | null;
};

function fenceDetailText(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > FENCE_DETAIL_MAX_CHARS ? `${trimmed.slice(0, FENCE_DETAIL_MAX_CHARS - 1)}…` : trimmed;
}

/** Parse the fence refusal into role + the availability requirement it refused on. */
export function classifyWorkflowPrincipalFenceFailure(error: unknown, message: string): WorkflowPrincipalFenceFailure | null {
  const prefixMatch = WORKFLOW_PRINCIPAL_FENCE_PREFIX_PATTERN.exec(message);
  if (!prefixMatch) return null;
  const role = prefixMatch[1] ?? "unknown";
  const trailing = message.slice(prefixMatch[0].length).trim();
  const carriedDetail = fenceDetailText(/^\(([\s\S]*)\)$/.exec(trailing)?.[1] ?? (trailing.length > 0 ? trailing : null));

  let causeCarried = false;
  let link: unknown = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; depth < MAX_FENCE_CAUSE_DEPTH && link !== undefined; depth += 1) {
    causeCarried = true;
    if (isPlanningLifecycleLockTransportError(link)) {
      return { role, requirement: "lock-transport", detail: fenceDetailText(link.message) ?? carriedDetail };
    }
    if (link instanceof Error && PLANNING_LIFECYCLE_LOCK_TEXT_PATTERN.test(link.message)) {
      return { role, requirement: "lock-transport", detail: fenceDetailText(link.message) ?? carriedDetail };
    }
    link = link instanceof Error ? link.cause : undefined;
  }
  if (carriedDetail && PLANNING_LIFECYCLE_LOCK_TEXT_PATTERN.test(carriedDetail)) {
    return { role, requirement: "lock-transport", detail: carriedDetail };
  }
  return { role, requirement: causeCarried ? "store-unavailable" : "cause-unknown", detail: carriedDetail };
}

/** Boolean form for callers that only need the class (wedge classification, graph guards). */
export function isWorkflowPrincipalFenceUnavailableFailure(error: unknown, message: string): boolean {
  return classifyWorkflowPrincipalFenceFailure(error, message) !== null;
}

/**
 * The terminal fence park's error prefix. Triage writes it, the wedge classifier names it, and the
 * self-healing sweep selects on it. Requiring the prefix — not just the marker — is what keeps a
 * marker from becoming a trigger: a card that recovered from a fence park keeps its evidence marker
 * (core's stale-planning-failure clear deliberately touches only `status`/`error`), and a stale
 * marker must never re-park or re-alert a card that already moved on.
 */
export const PLANNING_FENCE_PARK_ERROR_PREFIX = "PLANNING_FENCE_UNAVAILABLE:";

export type PlanningPrincipalFenceFailure = NonNullable<TaskPlanningFailureState["principalFence"]> & { requeueCount: number | null };

/** Exhaustive by construction: a new core requirement fails the type check until it is listed. */
const KNOWN_FENCE_REQUIREMENTS: Record<TaskPlanningFenceRequirement, true> = {
  "lock-transport": true,
  "store-unavailable": true,
  "cause-unknown": true,
};

/** Read the persisted fence marker, or null when absent/unreadable (same contract as its siblings). */
export function getPlanningPrincipalFenceFailure(
  task: Pick<Task, "planningFailure">,
): PlanningPrincipalFenceFailure | null {
  const candidate = task.planningFailure?.principalFence as Partial<PlanningPrincipalFenceFailure> | undefined | null;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  if (typeof candidate.role !== "string" || candidate.role.trim().length === 0) return null;
  if (typeof candidate.at !== "string" || !Number.isFinite(Date.parse(candidate.at))) return null;
  if (typeof candidate.firstAt !== "string" || !Number.isFinite(Date.parse(candidate.firstAt))) return null;
  if (typeof candidate.requirement !== "string" || KNOWN_FENCE_REQUIREMENTS[candidate.requirement as TaskPlanningFenceRequirement] !== true) return null;
  return {
    role: candidate.role,
    requirement: candidate.requirement as TaskPlanningFenceRequirement,
    detail: typeof candidate.detail === "string" && candidate.detail.length > 0 ? candidate.detail : null,
    firstAt: candidate.firstAt,
    at: candidate.at,
    attempt: typeof candidate.attempt === "number" && Number.isFinite(candidate.attempt) ? candidate.attempt : null,
    requeueCount: typeof candidate.requeueCount === "number" && Number.isFinite(candidate.requeueCount) ? candidate.requeueCount : null,
  };
}

/**
 * The authoring-exhaustion prefix triage wrote for EVERY planning failure before this build, fence
 * refusals included. The stranded population this sweep exists to heal is exactly that shape —
 * `PLANNING_FAILED_EXHAUSTED: specification failed 3 times — last error: workflow-principal-
 * fence-unavailable:triage` — written with `planningFailure: null` because no fence marker existed
 * yet. Selecting only the new named prefix would leave every already-stranded card stranded, so the
 * legacy sentence qualifies on its own.
 */
const PLANNING_FAILED_EXHAUSTED_PREFIX = "PLANNING_FAILED_EXHAUSTED:";
/** The `— last error: <text>` tail of the exhaustion sentence, capturing the carried error. */
const EXHAUSTED_LAST_ERROR_TAIL = /last error:\s*([\s\S]*)$/;

export type PlanningFencePark = {
  /** Whether this build wrote the named park, or an older build wrote the exhausted sentence. */
  shape: "named" | "legacy-exhausted";
  role: string;
  requirement: TaskPlanningFenceRequirement;
  detail: string | null;
  /** Durable episode start, or null for a markerless legacy park (the row clock is its only base). */
  firstAt: string | null;
  /** Sweep-driven re-queues already spent on this episode. */
  requeueCount: number;
};

/**
 * Read the fence-park evidence for a planning card, or null when the card is not fence-parked.
 *
 * FNXC:PlanningFenceRecovery 2026-10-02-02:05 (RUFU-288):
 * BOTH park shapes are selected from the ERROR TEXT, and the marker is evidence rather than the
 * trigger. That is the deliberate answer to the two ways a park can lack a readable marker: an older
 * build never wrote one (the whole pre-fix stranded population, which is the point of this sweep),
 * and a corrupted `planningFailure` object must not turn a real infrastructure park into an
 * unhealable card. Selecting on the marker alone would have made this sweep a no-op against the
 * exact row shape the incident produced. The error text stays load-bearing in the other direction
 * too: a stale marker on a card that already recovered carries no park sentence, so it can never
 * re-park or re-alert anything.
 */
export function getPlanningFencePark(
  task: Pick<Task, "status" | "error" | "planningFailure">,
): PlanningFencePark | null {
  if (task.status !== "failed" || typeof task.error !== "string") return null;
  const marker = getPlanningPrincipalFenceFailure(task);
  if (task.error.startsWith(PLANNING_FENCE_PARK_ERROR_PREFIX)) {
    return {
      shape: "named",
      role: marker?.role ?? "unknown",
      requirement: marker?.requirement ?? "cause-unknown",
      detail: marker?.detail ?? null,
      firstAt: marker?.firstAt ?? null,
      requeueCount: marker?.requeueCount ?? 0,
    };
  }
  if (!task.error.startsWith(PLANNING_FAILED_EXHAUSTED_PREFIX)) return null;
  const carried = EXHAUSTED_LAST_ERROR_TAIL.exec(task.error)?.[1] ?? "";
  const fence = classifyWorkflowPrincipalFenceFailure(null, carried.trim());
  if (!fence) return null;
  return {
    shape: "legacy-exhausted",
    role: fence.role,
    requirement: fence.requirement,
    detail: fence.detail,
    firstAt: marker?.firstAt ?? null,
    requeueCount: marker?.requeueCount ?? 0,
  };
}

/**
 * A planning card terminalized by fence refusal with its retry budget spent. This is the shape
 * `reconcile-principal-held-planning` cannot see (it requires `status: "needs-replan"` plus a held
 * triage continuation) and the shape the wedge classifier must stop reporting as `terminal-failed`.
 */
export function isPlanningFenceTerminalPark(
  task: Pick<Task, "status" | "error" | "planningFailure">,
): boolean {
  return getPlanningFencePark(task) !== null;
}

/** Operator-facing sentence naming which fence requirement refused. */
export function describeWorkflowPrincipalFenceRequirement(failure: WorkflowPrincipalFenceFailure): string {
  switch (failure.requirement) {
    case "lock-transport":
      return `planning lifecycle lock unavailable${failure.detail ? `: ${failure.detail}` : ""}`;
    case "store-unavailable":
      return `store write behind the fence failed${failure.detail ? `: ${failure.detail}` : ""}`;
    case "cause-unknown":
      return "the fence could not be consulted and carried no cause";
  }
}

/**
 * Shared persisted-state classifier for planning handoff recovery. It deliberately
 * excludes graph work-item/step-instance evidence, which callers must check at
 * their own store boundary before acting on a `legacy-null` result.
 */
export function classifyPersistedPlanHandoff(
  task: Pick<Task,
    | "status"
    | "paused"
    | "userPaused"
    | "approvedPlanFingerprint"
    | "awaitingApprovalReason"
    | "workflowStepResults"
    | "updatedAt"
    | "steps"
    | "worktree"
    | "firstExecutionAt"
    | "executionStartedAt"
  >,
  options: {
    now: number;
    hasLivePlanningWork: boolean;
    legacyStaleMs?: number;
    requirePersistedSteps?: boolean;
  },
): PersistedPlanHandoffKind | null {
  if (task.paused || task.userPaused || options.hasLivePlanningWork) return null;
  // FNXC:PlanningHandoffRecovery 2026-08-04-06:35 (FN-8768): Manual approval
  // parks and execution evidence outrank stale planning projections. In particular,
  // a retained Plan Review approval must never make an operator-held or already-
  // executing task eligible for planning-handoff recovery.
  if (task.awaitingApprovalReason) return null;
  if (task.firstExecutionAt || task.executionStartedAt) return null;
  // A planning worktree belongs to the planner and may legitimately survive a
  // crashed session. It must not hide a written plan from canonical handoff
  // recovery. Null-status compatibility recovery remains fenced below because
  // at that point a retained worktree is ambiguous execution evidence.
  if (task.status === "planning") return "planning";
  if (task.status != null) return null;
  if (task.worktree) return null;
  if (task.workflowStepResults?.some(isPlanReviewSatisfied)) return "approved-null";
  if (task.approvedPlanFingerprint != null) return null;
  if (task.workflowStepResults?.length) return null;
  if (options.requirePersistedSteps && !task.steps?.length) return null;

  const staleMs = options.legacyStaleMs ?? 0;
  const updatedAt = new Date(task.updatedAt).getTime();
  if (!Number.isFinite(updatedAt) || options.now - updatedAt < staleMs) return null;
  return "legacy-null";
}
