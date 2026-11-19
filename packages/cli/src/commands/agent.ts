import {
  AgentStore,
  AGENT_VALID_TRANSITIONS,
  agentPauseReasonLabel,
  classifyAgentStall,
  collectAgentAssignedCards,
  formatAgentAssignedCardLines,
  formatAgentDiagnosticLines,
  formatCurrentTaskLine,
  formatProjectAttributionLine,
  isAgentStateStopped,
  truncateAgentDiagnosticText,
  withAgentPendingApprovalCounts,
} from "@fusion/core";
import type { AgentAssignedCardsResult, AgentState } from "@fusion/core";
import { resolveAgentStoreBase } from "../project-context.js";

/**
 * Create an initialized AgentStore for the given project.
 *
 * FNXC:PostgresCutover 2026-07-04: borrow the PostgreSQL AsyncDataLayer from
 * the resolved project store so AgentStore runs in backend mode (the SQLite
 * runtime was removed under VAL-REMOVAL-005), mirroring extension.ts getAgentStore.
 */
async function createAgentStore(projectName?: string): Promise<{ store: AgentStore; cleanup: () => Promise<void> }> {
  const base = await resolveAgentStoreBase(projectName);
  const agentStore = new AgentStore({ rootDir: base.rootDir + "/.fusion", asyncLayer: base.asyncLayer });
  try {
    await agentStore.init();
    return { store: agentStore, cleanup: base.cleanup };
  } catch (error) {
    closeAgentStoreSafely(agentStore);
    await base.cleanup();
    throw error;
  }
}

/**
 * FNXC:CliAgentControl 2026-07-08-00:00:
 * Close the AgentStore best-effort, tolerating a store that is already
 * closed (or was never fully opened). `AgentStore.close()` already tolerates
 * a "database is not open" error internally; this wrapper additionally
 * guards against any other unexpected close-time error so a teardown failure
 * never masks the command's real result or blocks process exit.
 */
function closeAgentStoreSafely(agentStore: AgentStore): void {
  try {
    agentStore.close();
  } catch {
    // Best-effort teardown — never let a close failure block exit.
  }
}

/**
 * FNXC:CliAgentControl 2026-07-08-00:00:
 * Root cause of FN-7704: `fn agent stop`/`fn agent start` did their state
 * transition correctly but the CLI process never exited on its own —
 * `resolveProject()` cached an unclosed `TaskStore` and `createAgentStore()`
 * never closed the `AgentStore` it opened (see `agentStoreDbCache` in
 * @fusion/core's agent-store.ts). SQLite-level blocking is already bounded
 * (`busy_timeout` = 5s + a ~1s lock-recovery window in packages/core/src/db.ts),
 * so the previously observed 60s hang was the CALLER's subprocess timeout,
 * not a DB lock — the command's work finished, but a lingering handle kept
 * the event loop alive so the process never exited, and a recovery watcher
 * driving these commands as subprocesses would force-kill every single
 * retry at the same 60s ceiling, blocking recovery entirely.
 *
 * The fix has two parts, both implemented in this file:
 *   1. Deterministic teardown — close the `AgentStore` (via
 *      `closeAgentStoreSafely`) on EVERY exit path (success, already-in-
 *      target-state, not-found, invalid-transition, and unexpected error),
 *      and resolve the project path without leaking a `TaskStore` at all
 *      (`resolveProjectPathOnly` in project-context.ts).
 *   2. A bounded fast-fail guard (`withBoundedTimeout`) around the store
 *      mutation itself, so that if the operation genuinely cannot complete
 *      quickly the CLI fails fast with a clear, actionable error and a
 *      non-zero exit instead of hanging until an external caller kills it.
 *      The default deadline is intentionally short relative to the 60s
 *      caller-side ceiling this bug was measured against, and is
 *      operator-overridable via `FUSION_AGENT_CMD_TIMEOUT_MS` for
 *      constrained environments.
 */
const DEFAULT_AGENT_CMD_TIMEOUT_MS = 10_000;

function getAgentCmdTimeoutMs(): number {
  const raw = process.env.FUSION_AGENT_CMD_TIMEOUT_MS;
  if (!raw) return DEFAULT_AGENT_CMD_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AGENT_CMD_TIMEOUT_MS;
}

/** Raised when a store mutation exceeds the bounded fast-fail deadline. */
export class AgentCommandTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCommandTimeoutError";
  }
}

/**
 * Race a store mutation against a bounded deadline so a stuck/contended
 * operation fails fast with a clear error instead of hanging the CLI
 * process. See the FNXC:CliAgentControl block above for rationale.
 */
async function withBoundedTimeout<T>(
  operation: () => Promise<T>,
  context: { id: string; action: string },
): Promise<T> {
  const timeoutMs = getAgentCmdTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new AgentCommandTimeoutError(
              `Timed out after ${timeoutMs}ms waiting for agent ${context.id} to ${context.action}. ` +
                `The operation may still complete in the background; retry, or increase the deadline via FUSION_AGENT_CMD_TIMEOUT_MS.`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Stop (pause) a running agent.
 * Transitions state from running/active to paused.
 *
 * Note: Agent `metadata.skills` (array of skill names) controls which skills
 * are injected into the agent session at execution time when the agent is
 * assigned to a task. Skills are resolved by `buildSessionSkillContext`.
 */
export async function runAgentStop(id: string, projectName?: string): Promise<void> {
  const owned = await createAgentStore(projectName);
  const agentStore = owned.store;

  async function exitWithStore(code: number): Promise<never> {
    closeAgentStoreSafely(agentStore);
    await owned.cleanup();
    return process.exit(code);
  }

  try {
    const agent = await agentStore.getAgent(id);
    if (!agent) {
      console.error(`Agent ${id} not found`);
      return await exitWithStore(1);
    }

    // Already paused — nothing to do
    if (agent.state === "paused") {
      console.log();
      console.log(`  Agent ${id} is already paused`);
      console.log();
      return;
    }

    // Validate transition locally
    const validTargets = AGENT_VALID_TRANSITIONS[agent.state as AgentState];
    if (!validTargets || !validTargets.includes("paused")) {
      console.error(`Cannot stop agent ${id} — current state '${agent.state}' cannot transition to 'paused'`);
      return await exitWithStore(1);
    }

    try {
      // FNXC:AgentLifecyclePause 2026-07-19-00:00: CLI stop mutates only the
      // agent row. It must not cascade to an assigned task's user/system pause.
      await withBoundedTimeout(() => agentStore.updateAgentState(id, "paused"), { id, action: "stop (transition to paused)" });
    } catch (err) {
      console.error(`Failed to stop agent ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return await exitWithStore(1);
    }

    console.log();
    console.log(`  ✓ Agent ${id} stopped`);
    console.log();
  } finally {
    closeAgentStoreSafely(agentStore);
    await owned.cleanup();
  }
}

/**
 * Start (resume) a stopped/paused agent.
 * Transitions state from paused to active.
 */
export async function runAgentStart(id: string, projectName?: string): Promise<void> {
  const owned = await createAgentStore(projectName);
  const agentStore = owned.store;

  async function exitWithStore(code: number): Promise<never> {
    closeAgentStoreSafely(agentStore);
    await owned.cleanup();
    return process.exit(code);
  }

  try {
    const agent = await agentStore.getAgent(id);
    if (!agent) {
      console.error(`Agent ${id} not found`);
      return await exitWithStore(1);
    }

    // Already active/running — nothing to do
    if (agent.state === "active" || agent.state === "running") {
      console.log();
      console.log(`  Agent ${id} is already running (${agent.state})`);
      console.log();
      return;
    }

    // Validate transition locally
    const validTargets = AGENT_VALID_TRANSITIONS[agent.state as AgentState];
    if (!validTargets || !validTargets.includes("active")) {
      console.error(`Cannot start agent ${id} — current state '${agent.state}' cannot transition to 'active'`);
      return await exitWithStore(1);
    }

    try {
      // FNXC:AgentLifecyclePause 2026-07-19-00:00: CLI start is not task
      // unpause; assigned-task pause ownership remains independent.
      await withBoundedTimeout(() => agentStore.updateAgentState(id, "active"), { id, action: "start (transition to active)" });
    } catch (err) {
      console.error(`Failed to start agent ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return await exitWithStore(1);
    }

    console.log();
    console.log(`  ✓ Agent ${id} started`);
    console.log();
  } finally {
    closeAgentStoreSafely(agentStore);
    await owned.cleanup();
  }
}

/*
FNXC:AgentStallDiagnostics 2026-11-19-06:23 (RUFU-247):
`fn agent stop|start` could change an agent's state, but nothing could ANSWER the question an operator
asks first: "this lane is not moving cards — why?" Measured 2026-09-15: one durable owner sat `paused`
with NO pauseReason for a day while five assigned cards holding 519,682,059 tokens did nothing, and the
fields carrying the truth (`state`, `pauseReason`, `lastError`) were readable by no CLI surface at all —
the dashboard rendered some of them, the CLI none, and the Pi tools each projected their own subset.

These two read verbs answer it through the SAME core projection, so the three honest stall cases — an
operator-actionable park, a retry-budget exhaustion, and a stopped lane whose reason was never recorded
(`unknown`) — print identically here, in the Pi tools, and in the engine tool. Nothing here pauses,
resumes, or classifies: it formats what the projection says.
*/

/** Minimal TaskStore surface the stall read needs (assigned cards, workflow lanes, approvals). */
type AgentReadStore = Parameters<typeof collectAgentAssignedCards>[1]["store"] & {
  /** Present on the real TaskStore; used only to name the bound card's lane. */
  getTask?: (id: string) => Promise<{ column: string } | null>;
};

export interface AgentReadContext {
  agentStore: AgentStore;
  store: AgentReadStore;
  project: { projectId: string; projectName: string };
  cleanup: () => Promise<void>;
}

/**
 * Open both stores a stall read needs on ONE project resolution, so the owning project is known (a
 * miss must name it) and one connection pool answers the agent row and the card rows. Teardown stays
 * the caller's `closeAgentStoreSafely` + `cleanup()` on every exit path (FN-7704).
 */
async function createAgentReadContext(projectName?: string): Promise<AgentReadContext> {
  const base = await resolveAgentStoreBase(projectName);
  const agentStore = new AgentStore({ rootDir: `${base.rootDir}/.fusion`, asyncLayer: base.asyncLayer });
  try {
    await agentStore.init();
    return {
      agentStore,
      store: base.store as unknown as AgentReadStore,
      project: base.project,
      cleanup: base.cleanup,
    };
  } catch (error) {
    closeAgentStoreSafely(agentStore);
    await base.cleanup();
    throw error;
  }
}

/** What `fn agent show` renders, assembled once so the text and `--json` cannot disagree. */
export interface AgentShowModel {
  id: string;
  name: string;
  roles: string[];
  state: string;
  reportsTo?: string;
  taskId?: string;
  project: { projectId: string; projectName?: string };
  pendingApprovalCount: number;
  /** Pre-formatted stall lines (Last Error / Pause Reason / Error Recovery). */
  diagnosticLines: string[];
  assigned: AgentAssignedCardsResult;
  /** The bound card's resolved lane, or null when its row could not be read. */
  boundTaskColumn?: { column: string } | null;
}

/** `fn agent list` keeps a row scannable; `fn agent show` carries the full text. */
const AGENT_LIST_ERROR_MAX_CHARS = 120;

/**
 * Render an agent's stall card. Line order is stable (identity, ownership, stall facts, work held)
 * because operators grep it and a recovery watcher may parse `--json`.
 */
export function formatAgentShowLines(model: AgentShowModel): string[] {
  const roles = model.roles.length > 0 ? model.roles.join(",") : "unknown";
  const lines = [
    `Agent ${model.id} — ${model.name}`,
    `  Roles: ${roles}`,
    `  State: ${model.state}`,
  ];
  if (model.reportsTo) lines.push(`  Reports to: ${model.reportsTo}`);
  lines.push(formatProjectAttributionLine(model.project));
  // The bound card's LANE separates "executing this" from "a stale id"; an unreadable row prints as
  // the formatter's own `(unresolved)` rather than a lane invented from the agent row.
  if (model.taskId) lines.push(formatCurrentTaskLine(model.taskId, model.boundTaskColumn ?? null));
  lines.push(...model.diagnosticLines);
  lines.push(`  Pending approvals: ${model.pendingApprovalCount}`);
  const assignedLines = formatAgentAssignedCardLines(model.assigned);
  if (assignedLines.length === 0) {
    lines.push("  Assigned cards: none open");
  } else {
    lines.push(`  Assigned cards: ${model.assigned.totalOpen} open`);
    lines.push(...assignedLines.map((line) => `    ${line}`));
  }
  return lines;
}

/** One compact `fn agent list` row: the same facts, one line, shortened error. */
export function formatAgentListRow(
  agent: { id: string; name: string; roles?: string[]; state: string; lastError?: string | null },
  facts: { pauseReason?: string | null; pendingApprovalCount: number; assignedOpen: number },
): string {
  const roles = agent.roles && agent.roles.length > 0 ? agent.roles.join(",") : "unknown";
  const stall = classifyAgentStall({ state: agent.state, pauseReason: facts.pauseReason });
  const parts = [
    agent.id,
    agent.name,
    `[${roles}]`,
    agent.state,
    // A stall fact prints only when there IS one; a healthy row stays short.
    ...(stall ? [`${stall} (${agentPauseReasonLabel(stall)})`] : []),
    `approvals:${facts.pendingApprovalCount}`,
    `cards:${facts.assignedOpen}`,
  ];
  if (agent.lastError) {
    parts.push(`error:${truncateAgentDiagnosticText(agent.lastError, AGENT_LIST_ERROR_MAX_CHARS)}`);
  }
  return `  ${parts.join("  ")}`;
}

/** Show one agent's stall state, the project that owns it, and the cards it is holding. */
export async function runAgentShow(
  id: string,
  projectName?: string,
  options: { json?: boolean } = {},
): Promise<void> {
  const owned = await createAgentReadContext(projectName);

  async function exitWithStores(code: number): Promise<never> {
    closeAgentStoreSafely(owned.agentStore);
    await owned.cleanup();
    return process.exit(code);
  }

  try {
    const agent = await owned.agentStore.getAgent(id);
    if (!agent) {
      /*
      FNXC:AgentStallDiagnostics 2026-11-19-06:23 (RUFU-247):
      An id absent HERE says nothing about another project, so the miss names the project actually
      searched and states that the search covered one project. A bare "not found" read as "exists
      nowhere", which sent operators hunting through boards that never held the lane.
      */
      console.error(`Agent ${id} not found in project "${owned.project.projectName}" (${owned.project.projectId}).`);
      console.error("This lookup searched one project only — retry with --project <name> to search another.");
      return await exitWithStores(1);
    }

    const [withApprovals] = await withAgentPendingApprovalCounts([agent], owned.store as never);
    const assigned = await collectAgentAssignedCards(agent.id, {
      store: owned.store,
      boundTaskId: agent.taskId ?? null,
    });
    const boundTask = agent.taskId && owned.store.getTask
      ? await owned.store.getTask(agent.taskId).catch(() => null)
      : null;
    const model: AgentShowModel = {
      id: agent.id,
      name: agent.name,
      roles: agent.roles ?? (agent.role ? [agent.role] : []),
      state: agent.state,
      reportsTo: agent.reportsTo,
      taskId: agent.taskId,
      project: owned.project,
      pendingApprovalCount: withApprovals?.pendingApprovalCount ?? 0,
      // Non-compact: a detail view always shows a recorded reason, even on a non-stopped state.
      diagnosticLines: formatAgentDiagnosticLines(agent, { compact: false }),
      assigned,
      boundTaskColumn: boundTask ? { column: boundTask.column } : null,
    };

    console.log();
    if (options.json) {
      console.log(JSON.stringify(model, null, 2));
    } else {
      for (const line of formatAgentShowLines(model)) console.log(line);
    }
    console.log();
  } finally {
    closeAgentStoreSafely(owned.agentStore);
    await owned.cleanup();
  }
}

/** List every agent with the same stall facts, one row each. */
export async function runAgentList(
  projectName?: string,
  options: { json?: boolean; includeEphemeral?: boolean } = {},
): Promise<void> {
  const owned = await createAgentReadContext(projectName);

  try {
    const agents = await owned.agentStore.listAgents({ includeEphemeral: options.includeEphemeral === true });
    const withApprovals = await withAgentPendingApprovalCounts(agents, owned.store as never);

    const rows = [];
    for (const agent of withApprovals) {
      const assigned = await collectAgentAssignedCards(agent.id, {
        store: owned.store,
        boundTaskId: agent.taskId ?? null,
      });
      rows.push({ agent, assigned });
    }

    console.log();
    if (options.json) {
      console.log(JSON.stringify({
        project: owned.project,
        agents: rows.map(({ agent, assigned }) => {
          const stall = classifyAgentStall({ state: agent.state, pauseReason: agent.pauseReason });
          return {
            id: agent.id,
            name: agent.name,
            roles: agent.roles ?? (agent.role ? [agent.role] : []),
            state: agent.state,
            pauseReason: agent.pauseReason ?? null,
            // null means "nothing stalled", a different fact from the `unknown` stall code.
            stallCode: stall,
            stallLabel: stall ? agentPauseReasonLabel(stall) : null,
            lastError: agent.lastError ?? null,
            pendingApprovalCount: agent.pendingApprovalCount ?? 0,
            assignedOpen: assigned.totalOpen,
            assignedCards: assigned.cards,
          };
        }),
      }, null, 2));
    } else if (rows.length === 0) {
      console.log(`  No agents in project "${owned.project.projectName}".`);
    } else {
      for (const { agent, assigned } of rows) {
        console.log(formatAgentListRow(agent, {
          pauseReason: agent.pauseReason ?? null,
          pendingApprovalCount: agent.pendingApprovalCount ?? 0,
          assignedOpen: assigned.totalOpen,
        }));
      }
      const stopped = rows.filter(({ agent }) => isAgentStateStopped(agent.state)).length;
      console.log(`  ${rows.length} agent(s) in project "${owned.project.projectName}"; ${stopped} stopped.`);
    }
    console.log();
  } finally {
    closeAgentStoreSafely(owned.agentStore);
    await owned.cleanup();
  }
}
