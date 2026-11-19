/*
 * FNXC:AgentStallDiagnostics 2026-11-19-06:23 (RUFU-247):
 * THE NODE-SIDE PROJECTION BEHIND EVERY AGENT READ SURFACE.
 *
 * A durable owner agent that stops silently stops every card assigned to it — measured 2026-09-15,
 * one `paused` agent with no recorded reason idled five assigned cards carrying 519,682,059 tokens for
 * a day, and no surface could name the cause. This module is what the five read surfaces share so the
 * answer is worded identically everywhere: `fn agent show`, `fn agent list`, the Pi tools
 * `fn_list_agents` / `fn_agent_show`, and the engine's `fn_list_agents`. It re-exports the pure
 * vocabulary leaf (`agent-pause-reasons.ts`), which is the half the dashboard browser bundle also
 * reads, and adds the half that needs a store: pending-approval counts and the assigned-card inventory.
 *
 * THIS MODULE IS NODE-ONLY AND MUST STAY OUT OF THE DASHBOARD. It reaches `TaskStore`,
 * `ApprovalRequestStore`, and the workflow-IR resolver through imports the browser alias cannot
 * resolve. The dashboard imports ONLY `agent-pause-reasons.ts` (via the `@fusion/core` → `types.ts`
 * alias). Importing this file from `packages/dashboard/app/**` would drag Node builtins into the
 * client bundle — the exact `vite build` failure RUFU-615 produced, documented in
 * `core-types-browser-leaf.test.ts`.
 *
 * The truncation and error-recovery helpers moved here VERBATIM from
 * `packages/cli/src/extension.ts`, where they were private to one surface. Two copies of the
 * truncation bound or the recovery-line shape would let the CLI and the tools disagree about the
 * same agent row, which is the drift this card exists to remove.
 */

import { ApprovalRequestStore } from "./approval-request-store.js";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import {
  resolveWorkflowIrForTask,
  type WorkflowIrResolverStore,
} from "../workflows/workflow-ir-resolver.js";
import type { WorkflowIr } from "../workflows/workflow-ir-types.js";
import { columnsWithFlag } from "../workflows/workflow-lifecycle-traits.js";
import {
  rankAssignedTasksForWakeDelta,
  WAKE_DELTA_ASSIGNED_TASKS_CAP,
  type AssignedTaskLike,
  type AssignedTaskRankTier,
} from "./assigned-task-ranking.js";
import { formatCurrentTaskLine } from "./agent-store.js";
import { describeHeartbeatThrottle } from "./heartbeat-recovery-state.js";
import { agentPauseReasonLabel, classifyAgentStall } from "./agent-pause-reasons.js";

export {
  AGENT_STALL_REASON_UNKNOWN,
  AGENT_STALL_REASON_UNKNOWN_LABEL,
  AGENT_STOPPED_STATES,
  PAUSE_REASON_LABELS,
  agentPauseReasonLabel,
  classifyAgentStall,
  isAgentStateStopped,
  isOperatorActionablePauseReason,
} from "./agent-pause-reasons.js";

export type { AgentPauseReasonRecord } from "./agent-pause-reasons.js";

/* ── Diagnostic line projection ───────────────────────────────────────── */

/**
 * The agent fields the diagnostic lines read. Structural so a CLI row, a tool payload, or a test
 * fixture all satisfy it without importing the `Agent` type.
 */
export interface AgentDiagnosticProjectionInput {
  state?: string | null;
  lastError?: string | null;
  pauseReason?: string | null;
  /** Read only for the `Error Recovery:` line (and the throttle clause inside it). */
  metadata?: Record<string, unknown> | null;
}

/**
 * Identity of the project a read resolved against.
 *
 * FNXC:AgentStallDiagnostics 2026-11-19-06:23 (RUFU-247): `fn agent start <id>` resolved against the
 * current project and printed `Agent agent-5683bf15 not found` for an agent that exists in another
 * project, with no way to inspect it first. Every read therefore names the project it searched, on
 * both the hit path (header) and the miss path, so a cross-project id stops looking like a deleted
 * agent. `name`/`path` are optional because attribution must degrade to id-only rather than fail the
 * read when the project row cannot be resolved.
 */
export interface ProjectAttribution {
  projectId: string;
  projectName?: string;
  projectPath?: string;
}

/** Render `Project: <name> (<id>)`, falling back to id-only when the name is unavailable. */
export function formatProjectAttributionLine(project: ProjectAttribution): string {
  return project.projectName
    ? `Project: ${project.projectName} (${project.projectId})`
    : `Project: ${project.projectId}`;
}

/** Bound kept byte-identical with the pre-RUFU-247 `extension.ts` helper. */
const AGENT_DIAGNOSTIC_LAST_ERROR_COMPACT_CHARS = 180;
const AGENT_DIAGNOSTIC_LAST_ERROR_FULL_CHARS = 500;
const AGENT_DIAGNOSTIC_PAUSE_REASON_CHARS = 180;

/** Truncate with the shared ellipsis, moved verbatim from `extension.ts`. */
export function truncateAgentDiagnosticText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

/**
 * The `Error Recovery:` line, moved verbatim from `extension.ts` (RUFU-286's shape preserved).
 *
 * RUFU-286: takes the agent record (not just `metadata`) so the throttle clause comes from the one
 * shared reader. `describeHeartbeatThrottle` is what decides whether a re-probe is pending at all;
 * re-deriving `cooldownUntilAt > now` here would be a second authority whose expiry could drift from
 * the two engine lanes that read it.
 */
export function formatAgentErrorRecoveryLine(agent: AgentDiagnosticProjectionInput): string | null {
  const metadata = agent.metadata;
  const heartbeatRaw = metadata?.heartbeatErrorRecovery;
  const heartbeat = heartbeatRaw && typeof heartbeatRaw === "object" ? heartbeatRaw as Record<string, unknown> : null;
  const heartbeatAttempts = typeof heartbeat?.consecutiveAttempts === "number" && Number.isFinite(heartbeat.consecutiveAttempts)
    ? Math.max(0, Math.floor(heartbeat.consecutiveAttempts))
    : undefined;

  const durableRaw = metadata?.durableErrorRecovery;
  const durable = durableRaw && typeof durableRaw === "object" ? durableRaw as Record<string, unknown> : null;
  const durableAttempts = typeof durable?.attempts === "number" && Number.isFinite(durable.attempts)
    ? Math.max(0, Math.floor(durable.attempts))
    : undefined;
  const attempts = Math.max(heartbeatAttempts ?? 0, durableAttempts ?? 0);
  const hasRecoveryMetadata = heartbeatAttempts !== undefined || durableAttempts !== undefined;
  if (!hasRecoveryMetadata) {
    return null;
  }

  const details: string[] = [`attempts ${attempts}`];
  if (durable?.exhausted === true) details.push("exhausted");
  if (typeof durable?.nextRetryAt === "string") details.push(`next ${durable.nextRetryAt}`);
  /*
  FNXC:ProviderThrottleIsTransient 2026-09-30-14:17 (RUFU-286):
  A provider throttle is transient back-off with an armed re-probe, so a reader must be able to
  tell "waiting on the provider until <ISO>" from an exhausted park that needs a restart. The
  streak is the pressure signal: attempts 1, throttle 4 in a row is a sustained provider limit,
  not a blip, and that distinction is what `fn agent errors` was built to answer.
  */
  const throttle = describeHeartbeatThrottle(agent);
  if (throttle?.kind === "throttle-cooldown") {
    details.push(`throttle cooldown until ${throttle.retryingAt} (streak ${throttle.throttleStreak})`);
  } else if (throttle?.kind === "throttle-exhausted") {
    details.push(`throttle retries exhausted (streak ${throttle.throttleStreak})`);
  }
  return `Error Recovery: ${details.join(", ")}`;
}

/**
 * The diagnostic lines for one agent: `Last Error:`, `Pause Reason:`, `Error Recovery:`.
 *
 * Contract preserved byte-for-byte from the private `extension.ts` helper that five surfaces now
 * share (FN-7859: list rows stay compact and healthy agents show nothing; error/paused agents always
 * explain themselves; `Pause Reason: <code>` keeps its prefix so existing pins stay green). Two
 * additions RUFU-247 makes:
 *
 * 1. The code is followed by ` — <human words>` when the shared table knows it, so a raw code is no
 *    longer the whole answer. The prefix stays byte-identical; only a suffix is appended.
 * 2. A stopped agent with a blank reason prints `Pause Reason: unknown — no pause reason recorded
 *    (inspect agent logs/runlog)` instead of printing nothing. That blank case is precisely how
 *    `agent-5683bf15` idled 519M tokens of work unnoticed: a truthiness guard made "the lane recorded
 *    nothing" and "nothing happened" render identically.
 *
 * @param compact keep healthy-agent rows short (true = only stopped agents get lines, shorter `lastError`)
 */
export function formatAgentDiagnosticLines(
  agent: AgentDiagnosticProjectionInput,
  options: { compact: boolean },
): string[] {
  const shouldShowStateDetails = !options.compact || agent.state === "error" || agent.state === "paused";
  if (!shouldShowStateDetails) {
    return [];
  }

  const parts: string[] = [];
  if (agent.lastError) {
    const maxChars = options.compact ? AGENT_DIAGNOSTIC_LAST_ERROR_COMPACT_CHARS : AGENT_DIAGNOSTIC_LAST_ERROR_FULL_CHARS;
    parts.push(`Last Error: ${truncateAgentDiagnosticText(agent.lastError, maxChars)}`);
  }

  const stallCode = classifyAgentStall(agent);
  if (stallCode) {
    const code = truncateAgentDiagnosticText(stallCode, AGENT_DIAGNOSTIC_PAUSE_REASON_CHARS);
    parts.push(`Pause Reason: ${code} — ${agentPauseReasonLabel(stallCode)}`);
  }

  const recoveryLine = formatAgentErrorRecoveryLine(agent);
  if (recoveryLine) {
    parts.push(recoveryLine);
  }
  return parts;
}

/* ── Pending-approval counts ──────────────────────────────────────────── */

/** The store surface the approval-count read needs. `TaskStore` satisfies it. */
export interface AgentApprovalCountStore {
  getAsyncLayer(): AsyncDataLayer | null;
}

/**
 * Pending approval counts per actor, read through the shared `ApprovalRequestStore`.
 *
 * Ported from `withPendingApprovalCounts` in `register-agent-core-routes.ts` so the dashboard route
 * and the CLI/tool surfaces ask one implementation the same question. The zero-fallback on ANY
 * failure is the ported semantics, not a new policy: a read that failed is reported as "no pending
 * approvals" rather than making an agent unreadable, because a count is decoration on the stall
 * answer and must never become one.
 */
export async function loadAgentPendingApprovalCounts(
  store: AgentApprovalCountStore,
  actorIds?: Iterable<string>,
): Promise<Map<string, number>> {
  const wanted = actorIds ? new Set(actorIds) : null;
  /*
  FNXC:AgentStallDiagnostics 2026-11-19-06:23 (RUFU-247):
  One zero-fill shape for BOTH no-count paths — a store with no PostgreSQL layer and a failed approval
  read answer identically, because every caller renders the same `?? 0` and a difference here would
  make "no approvals" and "could not ask" print as different numbers. The read runs OUTSIDE the
  constructor guard so a throwing layer lands in the same catch as a throwing query.
  */
  const zeroed = (): Map<string, number> => {
    const zeros = new Map<string, number>();
    if (wanted) for (const id of wanted) zeros.set(id, 0);
    return zeros;
  };
  try {
    const layer = store.getAsyncLayer();
    if (!layer) return zeroed();
    const approvalStore = new ApprovalRequestStore(null, { asyncLayer: layer });
    const counts = await approvalStore.getPendingCountsByActor();
    if (!wanted) return counts;
    const scoped = new Map<string, number>();
    for (const id of wanted) scoped.set(id, counts.get(id) ?? 0);
    return scoped;
  } catch {
    return zeroed();
  }
}

/**
 * Attach `pendingApprovalCount` to each agent, exactly as the dashboard route did before the port
 * (zero for every agent when the read fails).
 */
export async function withAgentPendingApprovalCounts<T extends { id: string }>(
  agents: T[],
  store: AgentApprovalCountStore,
): Promise<Array<T & { pendingApprovalCount: number }>> {
  const counts = await loadAgentPendingApprovalCounts(store, agents.map((agent) => agent.id));
  return agents.map((agent) => ({ ...agent, pendingApprovalCount: counts.get(agent.id) ?? 0 }));
}

/* ── Assigned-card inventory ──────────────────────────────────────────── */

/**
 * The store surface the inventory read needs: the assigned-task read plus the two reads the
 * workflow-IR resolver drives. `TaskStore` satisfies it; an in-memory fake only has to.
 */
export interface AgentAssignedCardStore extends WorkflowIrResolverStore {
  getTasksByAssignedAgent(agentId: string, options?: { pausedOnly?: boolean }): Promise<AssignedTaskLike[]>;
}

/** One assigned card as an operator reads it. */
export interface AgentAssignedCardRow {
  taskId: string;
  column: string;
  tier: AssignedTaskRankTier;
  /** Ranker annotations (`bound`, `lease: held-by-other`). */
  labels: string[];
  titleSnippet: string;
  /** Whether this is the card the agent currently holds. */
  isBoundTask: boolean;
}

export interface AgentAssignedCardsResult {
  cards: AgentAssignedCardRow[];
  /** Open assigned cards BEFORE the cap — the number that makes `truncated` honest. */
  totalOpen: number;
  truncated: boolean;
  notActionableCount: number;
  operatorPausedCount: number;
  enginePausedCount: number;
}

/**
 * Inventory the cards an agent owns, so "which cards died with this agent" is a read and not a scan
 * of task JSON for `assignedAgentId`.
 *
 * The threading mirrors the heartbeat Wake Delta block in
 * `packages/engine/src/agent-heartbeat.ts`, and copies its two load-bearing rules rather than
 * paraphrasing them:
 *
 * - The terminal (workflow Complete-column) filter uses trait flags resolved per task IR, not the
 *   literal `"done"` pair, so a renamed board does not show finished work as stranded.
 * - Store rows are passed to the ranker VERBATIM. Both `paused` and `userPaused` ride on the row and
 *   the ranker treats either as parked; reshaping rows field-by-field re-creates RUFU-264's tick
 *   where seven operator hard-cancels were offered as actionable work.
 *
 * A read that fails degrades to an empty inventory with a warning-free empty result — the same
 * fail-soft posture the heartbeat uses, because the inventory decorates the stall answer and a
 * missing task read must not make an agent unreadable.
 */
export async function collectAgentAssignedCards(
  agentId: string,
  options: {
    store: AgentAssignedCardStore;
    boundTaskId?: string | null;
    cap?: number;
  },
): Promise<AgentAssignedCardsResult> {
  const empty: AgentAssignedCardsResult = {
    cards: [],
    totalOpen: 0,
    truncated: false,
    notActionableCount: 0,
    operatorPausedCount: 0,
    enginePausedCount: 0,
  };
  try {
    const assignedOpen = await options.store.getTasksByAssignedAgent(agentId);
    // One IR cache for the whole pass: the same card's workflow is read at most once.
    const irCache = new Map<string, WorkflowIr>();
    const flagsByColumnId = new Map<string, { complete?: boolean }>();
    for (const assignedTask of assignedOpen) {
      const ir = await resolveWorkflowIrForTask(options.store, assignedTask.id, irCache).catch(() => undefined);
      if (!ir) continue;
      /*
      FNXC:AgentStallDiagnostics 2026-11-19-06:23 (RUFU-247):
      Flag resolution is guarded PER CARD, not once for the pass. `columnsWithFlag` reaches
      `TraitRegistry.resolveColumnFlags`, which iterates `column.traits` — and `traits` is optional on
      the column type, so an IR that omits it throws. One such workflow would otherwise take the whole
      assigned-card inventory down with it, which is precisely the silent-blank failure this card exists
      to remove. A card whose flags cannot be read stays unclassified (its lane still prints).
      */
      try {
        for (const id of columnsWithFlag(ir, "complete")) {
          flagsByColumnId.set(id, { ...flagsByColumnId.get(id), complete: true });
        }
      } catch {
        // Unresolvable flags: leave this card's column unclassified rather than poison the pass.
      }
    }
    const ranked = rankAssignedTasksForWakeDelta(assignedOpen, {
      agentId,
      boundTaskId: options.boundTaskId ?? null,
      cap: options.cap ?? WAKE_DELTA_ASSIGNED_TASKS_CAP,
      ...(flagsByColumnId.size > 0 ? { flagsByColumnId: flagsByColumnId as never } : {}),
    });
    return {
      cards: ranked.ranked.map((line) => ({
        taskId: line.task.id,
        column: line.task.column,
        tier: line.tier,
        labels: line.labels,
        titleSnippet: line.titleSnippet,
        isBoundTask: Boolean(options.boundTaskId) && line.task.id === options.boundTaskId,
      })),
      totalOpen: ranked.totalOpen,
      truncated: ranked.truncated,
      notActionableCount: ranked.notActionableCount,
      operatorPausedCount: ranked.operatorPausedCount,
      enginePausedCount: ranked.enginePausedCount,
    };
  } catch {
    // A store without the read, or a failing one, degrades to "no inventory" rather than failing the row.
    return empty;
  }
}

/**
 * Full-card inventory lines for `fn agent show` / `fn_agent_show`:
 * `1. RUFU-247 [ready_todo] todo — card title snippet`.
 *
 * An empty inventory prints an explicit line rather than nothing, because "this owner has no cards"
 * is a different operator answer from "the task read failed and printed nothing" — the silence that
 * made the RUFU-247 stall unfindable.
 */
export function formatAgentAssignedCardLines(result: AgentAssignedCardsResult): string[] {
  const lines: string[] = [];
  for (let index = 0; index < result.cards.length; index += 1) {
    const card = result.cards[index]!;
    const labels = card.labels.length > 0 ? ` (${card.labels.join(", ")})` : "";
    lines.push(`${index + 1}. ${card.taskId} [${card.tier}] ${card.column} — ${card.titleSnippet}${labels}`);
  }
  if (result.notActionableCount > 0) {
    lines.push(
      `Parked and not shown: ${result.notActionableCount} ` +
        `(operator ${result.operatorPausedCount}, engine ${result.enginePausedCount})`,
    );
  }
  if (result.truncated) {
    lines.push(`Showing ${result.cards.length} of ${result.totalOpen} open assigned cards.`);
  }
  return lines;
}

/**
 * One-line compact inventory for list-shaped surfaces:
 * `Assigned cards: RUFU-247 [todo], RUFU-233 [in-progress] +3 more` — ids plus columns only, capped.
 */
export function formatAgentAssignedCardsCompact(result: AgentAssignedCardsResult): string | null {
  if (result.cards.length === 0 && result.totalOpen === 0) return null;
  const shown = result.cards.map((card) => `${card.taskId} [${card.column}]`).join(", ");
  const hidden = Math.max(0, result.totalOpen - result.cards.length);
  const suffix = hidden > 0 ? ` +${hidden} more` : "";
  if (!shown) return `Assigned cards: ${result.totalOpen} open (none actionable)`;
  return `Assigned cards: ${shown}${suffix}`;
}

/** Re-exported so surfaces format the bound-card line without importing the store module. */
export { formatCurrentTaskLine };
