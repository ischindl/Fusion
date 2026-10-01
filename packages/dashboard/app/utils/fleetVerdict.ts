import type { Agent } from "../api";
import { describeHeartbeatThrottle } from "@fusion/core/heartbeat-recovery-state";
import {
  getAgentHealthStatus,
  AGENT_HEALTH_LABEL_HEARTBEAT_DISABLED,
  AGENT_HEALTH_LABEL_UNRESPONSIVE,
} from "./agentHealth";

/*
FNXC:FleetVerdict 2026-09-02-05:16 (RUFU-176):
The operator's Slovak ask — „na jeden pohľad potrebujem vidieť, že sa projekt hýbe" (at one glance I need to see the project is moving) —
requires ONE aggregate verdict over the whole roster: active / waiting on a human / no heartbeat / stalled.
The operator's second ask — „prečo je niečo paused a iné stojí" (why is something paused and other things standing still) — is answered per-node
by the org-chart stall line (AgentsView.tsx), not here; this module only counts.

CLASSIFIER INPUT INVARIANT (do not weaken): `classifyFleetVerdict` must receive the roster filtered ONLY by the
system/ephemeral predicate (`showSystemAgents || !isEphemeralAgent(agent)`), never by agent state. The overview bar's
existing `activeAgents` prop is fed `displayActiveAgents`, which is already state-filtered to {active, running};
classifying that list would pin waitingHuman/noHeartbeat/stalled at structural zero and silently lie about the project.
*/

/**
 * Linked-task columns that mean "this card is parked behind a person". `taskColumn` carries the linked task's
 * STATUS (see the `taskColumn` sanitizer in `packages/dashboard/src/routes.ts`), so an agent linked to one of
 * these is blocked on a human, not on its own runtime.
 */
export const AGENT_TASK_HUMAN_HOLD_COLUMNS = [
  "awaiting-approval",
  "awaiting-user-input",
  "awaiting-user-review",
  "awaiting-cli-approval",
] as const;

const HUMAN_HOLD_TASK_COLUMN_SET: ReadonlySet<string> = new Set<string>(AGENT_TASK_HUMAN_HOLD_COLUMNS);

/**
 * RUFU-174 server-derived code (diagnostic-only, response-only on task reads) that names a card held for a
 * person. When the optional `linkedTaskStallCodes` seam is wired, this promotes a linked-task holder to waitingHuman.
 */
export const HUMAN_HOLD_LINKED_TASK_STALL_CODE = "held-human-review";

/** Pause reason whose plain-language meaning is "waiting on a human" rather than "runtime stopped". */
const AGENT_PAUSE_REASON_AWAITING_APPROVAL = "awaiting-approval";

/** The four operator buckets, in precedence order. */
export const FLEET_VERDICT_BUCKETS = ["active", "waitingHuman", "noHeartbeat", "stalled"] as const;
export type FleetVerdictBucket = (typeof FLEET_VERDICT_BUCKETS)[number];

/** Aggregate counts rendered by the verdict strip. */
export interface FleetVerdict {
  active: number;
  waitingHuman: number;
  noHeartbeat: number;
  stalled: number;
}

export interface FleetVerdictContext {
  /** Project-resolved heartbeat multiplier forwarded verbatim to `getAgentHealthStatus` (same two-arg convention as the AgentsView health wrapper). */
  heartbeatMultiplier?: number;
  /** Age-of-data instant for heartbeat staleness; never read from wall-clock inside this module. */
  dataAsOfMs?: number;
  /**
   * RUFU-174 seam — linked task id → server-derived stall codes. Optional and empty by default: "unwired" is an allowed
   * state (the dashboard may not have the linked task's stall codes without a separate read), and the classifier must
   * still work today. Only a human-hold code participates in the verdict; the rest are for the node-level stall line.
   */
  linkedTaskStallCodes?: ReadonlyMap<string, readonly string[]>;
}

/**
 * The roster shape the classifier consumes. `state` is required (it drives precedence step 1); every other field is
 * read defensively so a partial roster entry never throws and never invents a fact.
 */
export type FleetRosterAgent = Partial<Agent> & Pick<Agent, "state">;

const EMPTY_FLEET_VERDICT: FleetVerdict = { active: 0, waitingHuman: 0, noHeartbeat: 0, stalled: 0 };

function isFleetActive(agent: FleetRosterAgent): boolean {
  return agent.state === "active" || agent.state === "running";
}

function isWaitingOnHuman(agent: FleetRosterAgent, context: FleetVerdictContext): boolean {
  if (typeof agent.pendingApprovalCount === "number" && agent.pendingApprovalCount > 0) return true;
  if (agent.pauseReason === AGENT_PAUSE_REASON_AWAITING_APPROVAL) return true;
  if (agent.taskColumn && HUMAN_HOLD_TASK_COLUMN_SET.has(agent.taskColumn)) return true;
  if (agent.taskId && context.linkedTaskStallCodes) {
    const codes = context.linkedTaskStallCodes.get(agent.taskId);
    if (codes?.includes(HUMAN_HOLD_LINKED_TASK_STALL_CODE)) return true;
  }
  return false;
}

/**
 * Roster-only agent states that name their own stall reason (`Paused: …` / the error text from `getAgentHealthStatus`).
 * These are the agent's own runtime facts; the module never re-derives heartbeat timings to decide "stalled".
 */
function isRuntimeStalled(agent: FleetRosterAgent): boolean {
  return agent.state === "paused" || agent.state === "error";
}

/*
FNXC:FleetVerdict 2026-09-02-05:24 (RUFU-176):
"no heartbeat" answers the operator's „koľku mu chýba do heartbeatu" — there is no heartbeat to countdown to.
Three label/roster facts mean that, in order: the beat is overdue (`Unresponsive`, agentHealth's own threshold verdict),
the beat is switched off (`Heartbeat Disabled`), or no beat has EVER been recorded. Only the third is read from the
roster directly (`lastHeartbeatAt` absent) because that is a presence fact, not a timing threshold — this module never
re-derives agentHealth's staleness math. A paused/errored agent with no beat is EXCLUDED here so it falls to `stalled`
instead: its reason is "it was stopped", not "it has no cadence" (precedence would otherwise mislabel it).

Bucket reconciliation, deliberate: the `stall-reason-decision` governing note (exit b) lists `Unresponsive` under
`stalled`. An Unresponsive agent that reaches this bucket is never active-state (precedence takes those first), so the
agent in question is IDLE with an overdue beat — labeling that "stalled" would claim it is stuck when the honest
answer is "its heartbeat is missing". The PROMPT Step-1 rule (label membership) therefore wins this one edge; exit (b)
is honoured in full where it actually governs, i.e. the authority provenance (no RUFU-175 import, no re-derived timings).
*/
function hasMissingHeartbeat(agent: FleetRosterAgent, context: FleetVerdictContext): boolean {
  if (isRuntimeStalled(agent)) return false;
  if (!agent.lastHeartbeatAt) return true;
  const { label } = getAgentHealthStatus(
    agent as Parameters<typeof getAgentHealthStatus>[0],
    context.heartbeatMultiplier,
    context.dataAsOfMs,
  );
  return label === AGENT_HEALTH_LABEL_UNRESPONSIVE || label === AGENT_HEALTH_LABEL_HEARTBEAT_DISABLED;
}

/**
 * Resolve one agent to exactly one bucket (first match wins). Kept exported because the org-chart stall line needs the
 * same authority to decide "this node is not moving, name why" without re-deriving a second classification.
 *
 * Precedence is LOCKED so the strip's four counts stay disjoint: active → waitingHuman → noHeartbeat → stalled.
 * An agent no bucket explains (healthy idle with a fresh heartbeat, or "Starting…") belongs to none — that is the
 * honesty invariant `sum(buckets) <= roster.length`, and it is why the fourth bucket never renders a fabricated zero.
 */
export function resolveFleetVerdictBucket(
  agent: FleetRosterAgent,
  context: FleetVerdictContext = {},
): FleetVerdictBucket | undefined {
  if (isFleetActive(agent)) return "active";
  if (isWaitingOnHuman(agent, context)) return "waitingHuman";
  if (hasMissingHeartbeat(agent, context)) return "noHeartbeat";
  if (isRuntimeStalled(agent)) return "stalled";
  return undefined;
}

/*
FNXC:FleetVerdict 2026-09-02-06:20 (RUFU-176):
The operator's second ask — „prečo je niečo paused a iné stojí" — is a per-node question, and the org-chart node answers
it with one plain-language line. This resolver names WHY an agent is not moving as a stable CODE plus its evidence, and
never as English prose: the codes are either raw `agent.pauseReason` values (the engine writes `manual`,
`budget-exhausted`, `error-retry-exhausted`, `error-unrecoverable`, `heartbeat-model-unavailable`,
`heartbeat-unresponsive`, `migrated-from-terminated`, `user-requested`, `testing`) or the fleet-synthesized codes below.
Keeping prose out of this module is what lets the node translate them under `agents.stallReason.<code>` (literal `t()`
keys per known code in `AgentsView`, with a `useColumnLabel`-style raw-code fallback only for a never-seen `pauseReason`)
instead of shipping a second untranslated string table, and it honours exit (b) of
the stall-reason decision: `getAgentHealthStatus` stays the health-label authority and no RUFU-175 resolver is imported.

Synthesized codes (never written by the engine, so they cannot collide with a raw `pauseReason`):
`state-error`, `held-human-review`, `heartbeat-disabled`, `never-beat`, `paused`.
*/

/** Fleet-synthesized stall codes; the rest of `FleetStallReason.code` values are raw engine `pauseReason` strings. */
export const FLEET_STALL_CODES = {
  awaitingApproval: "awaiting-approval",
  stateError: "state-error",
  /*
  FNXC:ProviderThrottleIsTransient 2026-09-30-14:40 (RUFU-286):
  Synthesized, like `state-error`, and it splits that one code in two: an agent the provider is
  rate limiting and an agent whose run genuinely failed both sit in `state: "error"`, but only the
  second one has an operator action. The BUCKET is untouched (still `stalled`, still one agent), so
  the strip's four counts cannot shift — this only names WHY, which is what the node's line reads.
  */
  rateLimited: "rate-limited",
  paused: "paused",
  heldByPerson: "held-human-review",
  heartbeatDisabled: "heartbeat-disabled",
  neverBeat: "never-beat",
} as const;

/** Why one agent is not moving. `code` is translated by the caller; `detail` is tooltip-only evidence. */
export interface FleetStallReason {
  /** The bucket this agent counts in, returned so a caller never resolves the verdict twice and cannot drift from it. */
  bucket: Exclude<FleetVerdictBucket, "active">;
  /** Stable code, translated by the caller under `agents.stallReason.<code>`; falls back to the raw code when uncataloged. */
  code: string;
  /** Longer evidence for a tooltip only — an error string or `getAgentHealthStatus().reason`. Never a headline. */
  detail?: string;
  /** Linked-task id, present when the reason is about a card this agent is parked on. */
  taskId?: string;
  /** Linked-task column, present only for the `held-human-review` code that came from the card's column, so a tooltip can name which hold. */
  taskColumn?: string;
}

/**
 * Name why one agent is not moving, or return `undefined` when it is moving (or too young to tell).
 *
 * Guarded by the bucket itself: a reason is only ever produced for an agent the classifier already counts as
 * `waitingHuman` / `noHeartbeat` / `stalled`, so the node's line can never contradict the strip's count. An agent in
 * `active`/`running` state is deliberately silent even when its linked card sits on a human-hold column — it is busy.
 *
 * Order inside the buckets is actionable-reason-first: an approval the operator can grant outranks the engine's
 * `awaiting-approval` pause, a failed run outranks a generic pause, and a stopped runtime outranks task linkage.
 */
export function resolveFleetStallReason(
  agent: FleetRosterAgent,
  context: FleetVerdictContext = {},
): FleetStallReason | undefined {
  const bucket = resolveFleetVerdictBucket(agent, context);
  if (!bucket || bucket === "active") return undefined;

  const approvalCount = typeof agent.pendingApprovalCount === "number" && agent.pendingApprovalCount > 0
    ? agent.pendingApprovalCount
    : undefined;
  if (approvalCount || agent.pauseReason === AGENT_PAUSE_REASON_AWAITING_APPROVAL) {
    return { bucket, code: FLEET_STALL_CODES.awaitingApproval };
  }

  /*
  FNXC:ProviderThrottleIsTransient 2026-09-30-14:40 (RUFU-286):
  Ranked immediately above `state-error` for the same reason agentHealth ranks its label there: the
  cooldown is a fact about the SAME `state: "error"` row, and reading `lastError` off that row is the
  misdiagnosis this task exists to remove. The deadline goes in `detail` (tooltip-only) because a
  headline is one short phrase; the shared reader supplies it, so no timing is re-derived here.
  */
  // Injected clock, like every other timing judgement in this module: an elapsed cooldown must read as
  // elapsed in a fixture whose `dataAsOfMs` is fixed, never against the wall clock.
  const throttle = describeHeartbeatThrottle(agent, context.dataAsOfMs ?? Date.now());
  if (throttle?.kind === "throttle-cooldown") {
    return { bucket, code: FLEET_STALL_CODES.rateLimited, detail: `Auto-retry scheduled for ${throttle.retryingAt} (attempt ${throttle.throttleStreak})` };
  }

  if (agent.state === "error") {
    return { bucket, code: FLEET_STALL_CODES.stateError, detail: agent.lastError };
  }

  if (agent.state === "paused") {
    return { bucket, code: agent.pauseReason || FLEET_STALL_CODES.paused };
  }

  if (agent.taskId && context.linkedTaskStallCodes?.get(agent.taskId)?.includes(HUMAN_HOLD_LINKED_TASK_STALL_CODE)) {
    return { bucket, code: FLEET_STALL_CODES.heldByPerson, taskId: agent.taskId };
  }

  /*
   Both human-hold signals resolve to the one code the RUFU-174 ledger already emits, which is what "no second
   classifier authority" means in practice: the column the card sits on names WHICH person has the ball, and the node
   already shows that column on its task chip, so the line itself says only "a person has the ball".
  */
  if (agent.taskColumn && HUMAN_HOLD_TASK_COLUMN_SET.has(agent.taskColumn)) {
    return { bucket, code: FLEET_STALL_CODES.heldByPerson, taskId: agent.taskId, taskColumn: agent.taskColumn };
  }

  const health = getAgentHealthStatus(
    agent as Parameters<typeof getAgentHealthStatus>[0],
    context.heartbeatMultiplier,
    context.dataAsOfMs,
  );
  if (health.label === AGENT_HEALTH_LABEL_HEARTBEAT_DISABLED) {
    return { bucket, code: FLEET_STALL_CODES.heartbeatDisabled, detail: health.reason };
  }
  if (health.label === AGENT_HEALTH_LABEL_UNRESPONSIVE) {
    return { bucket, code: "heartbeat-unresponsive", detail: health.reason };
  }
  if (!agent.lastHeartbeatAt) {
    return { bucket, code: FLEET_STALL_CODES.neverBeat, detail: health.reason };
  }

  return undefined;
}

/**
 * Count the roster into the four operator buckets.
 *
 * @param agents roster filtered ONLY by the system/ephemeral predicate — see the input invariant above.
 * @param context heartbeat multiplier, age-of-data instant, and the optional RUFU-174 linked-task seam.
 */
export function classifyFleetVerdict(
  agents: readonly FleetRosterAgent[],
  context: FleetVerdictContext = {},
): FleetVerdict {
  if (agents.length === 0) return { ...EMPTY_FLEET_VERDICT };

  const verdict: FleetVerdict = { ...EMPTY_FLEET_VERDICT };
  for (const agent of agents) {
    const bucket = resolveFleetVerdictBucket(agent, context);
    if (bucket) verdict[bucket] += 1;
  }
  return verdict;
}
