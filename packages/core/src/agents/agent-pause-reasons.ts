/*
 * FNXC:AgentStallDiagnostics 2026-11-19-06:23 (RUFU-247):
 * THE SINGLE SOURCE FOR WHAT AN AGENT'S PAUSE REASON MEANS IN ENGLISH.
 *
 * Why this exists as its own module: a durable agent that goes `paused` stops every card assigned to
 * it, and until RUFU-247 no CLI or agent-facing surface could say WHY. Measured 2026-09-15:
 * `agent-5683bf15` sat `paused` with its last runlog at 2026-09-14T15:54Z, silently parking five of
 * its assigned cards carrying 519,682,059 tokens combined (RUFU-196, RUFU-233, RUFU-227, RUFU-237,
 * RUFU-239). Nothing moved for a day and no lane reported a cause, because the only surface that
 * rendered the reason was the dashboard and the reason itself was a raw code.
 *
 * The blank case is the one that must never render as nothing. That incident's agent carried NO
 * `pauseReason` at all, so a truthiness-guarded render printed neither line and a stopped owner
 * looked identical to an agent that had simply been idle. A stopped agent with a blank reason now
 * classifies as `AGENT_STALL_REASON_UNKNOWN`, which every surface renders as its own honest line.
 *
 * Why the table moved HERE instead of staying dashboard-only: the recovery lanes documented in
 * AGENTS.md (FN-7835 / FN-7844 / FN-7859 / FN-7878, FN-7884) are the writers of these codes, and
 * RUFU-286 adds a throttle-family code to the same registry. When the vocabulary lives in a
 * dashboard file, each new consumer forks its own copy of the words and the surfaces drift; the
 * registry being the single edit point is what lets a new `pauseReason` code reach `fn agent show`,
 * `fn agent list`, the Pi tools, the engine tool, and the dashboard badge from one entry.
 *
 * FNXC:StallReason 2026-09-01-17:48 (RUFU-175) — carried forward from `stallReason.ts`, where this
 * table was born as a t-free shared table so the agent-health pill (which has no `t`) and the stall
 * resolver (whose localized `stall.pausedReason.<code>.*` defaults reuse these exact strings) could
 * not drift. The values double as the English defaults for the resolver's enumerated keys AND as the
 * interpolated `{{reason}}` word for unenumerated codes, so an unknown code still shows its raw
 * string rather than an empty label — the same honest fallback on both surfaces.
 *
 * BROWSER SAFETY IS LOAD-BEARING. The dashboard Vite bundle aliases `@fusion/core` to the
 * types-only leaf (`packages/core/src/types.ts`), and this module is re-exported through it so the
 * resolver and the health pill read the SAME object the CLI reads. That is only possible because
 * this file imports NOTHING at runtime — no `node:*`, no core module, structural input types only.
 * `core-types-browser-leaf.test.ts` walks the value graph and `check-no-node-only-core-imports-in-dashboard.mjs`
 * enforces the boundary. The Node-side helpers that need a store live in
 * `agent-diagnostic-projection.ts`, which the dashboard must never import.
 */

/**
 * Human pause-reason words keyed by the `Agent.pauseReason` code the recovery lanes write.
 *
 * Moved verbatim (codes and values byte-identical) out of
 * `packages/dashboard/app/utils/stallReason.ts` so the CLI, the Pi tools, and the engine tool render
 * the same words the dashboard badge renders. Add a new code HERE — every consumer reads this table,
 * and an unenumerated code still renders honestly through the raw-string fallback in
 * {@link agentPauseReasonLabel}.
 */
export const PAUSE_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "error-unrecoverable": "Paused with an unrecoverable error",
  "error-retry-exhausted": "Automatic retries exhausted",
  "awaiting-approval": "Awaiting approval",
  "heartbeat-model-unavailable": "Heartbeat model unavailable",
  "heartbeat-unresponsive": "Heartbeat unresponsive",
  "budget-exhausted": "Output budget exhausted",
  "migrated-from-terminated": "Recovered from a terminated runtime",
  manual: "Paused by an operator",
  "user-requested": "Paused at your request",
  testing: "Paused for testing",
  "duplicate-decision-required": "Awaiting a duplicate decision",
});

/*
FNXC:AgentStallDiagnostics 2026-11-19-06:23 (RUFU-247):
The three honest stall cases need different operator actions, so they must be distinguishable in the
output and never collapse into a blank line:
  - `error-unrecoverable`  → operator-actionable park (credentials / OAuth scope / model access /
    hard billing). Only a human repairs it; automatic recovery deliberately does not retry it.
  - `error-retry-exhausted` → the shared retry budget is spent. `fn task retry`-style manual Retry is
    the exit, so the operator action is a click, not a credential repair.
  - `unknown`             → the lane paused the agent and recorded no reason. Nothing here can say
    what happened, so the line says exactly that and points at the logs instead of guessing.
*/

/** The sentinel code for a stopped agent whose `pauseReason` is null, undefined, or blank. */
export const AGENT_STALL_REASON_UNKNOWN = "unknown";

/** What the `unknown` sentinel renders as. States the gap; never invents a cause. */
export const AGENT_STALL_REASON_UNKNOWN_LABEL =
  "no pause reason recorded (inspect agent logs/runlog)";

/**
 * Agent states in which the agent is NOT working, so a card assigned to it is stalled.
 *
 * `paused` covers operator holds, recovery parks, and approval waits; `error` covers a lane that
 * died before it could transition. Both must answer "why", because both idle every assigned card.
 */
export const AGENT_STOPPED_STATES: ReadonlySet<string> = Object.freeze(new Set(["paused", "error"]));

/** The structural minimum this classifier reads. `Agent` widens these; plain fixtures stay valid. */
export interface AgentPauseReasonRecord {
  /** Raw `Agent["state"]`; unknown strings are simply not stopped states. */
  state?: string | null;
  /** Raw `Agent.pauseReason` — null, undefined, and blank all mean "nothing was recorded". */
  pauseReason?: string | null;
}

/** Whether an agent state means the agent is not currently working its assigned cards. */
export function isAgentStateStopped(state: string | null | undefined): boolean {
  return typeof state === "string" && AGENT_STOPPED_STATES.has(state);
}

/**
 * The pause reason code to show for an agent, or `null` when there is nothing to show.
 *
 * - Non-blank recorded `pauseReason` → that code verbatim, whatever the state (a reason the lane
 *   wrote is a fact, and a running agent that still carries a stale reason should keep showing it).
 * - Stopped (`paused` / `error`) with null / undefined / blank reason → {@link
 *   AGENT_STALL_REASON_UNKNOWN}. This is the RUFU-247 rule: the blank case is a finding, not an
 *   absence of output.
 * - Everything else → `null`, so a healthy agent's row stays compact.
 */
export function classifyAgentStall(
  record: AgentPauseReasonRecord | null | undefined,
): string | null {
  if (!record) return null;
  const reason = record.pauseReason;
  if (typeof reason === "string" && reason.trim() !== "") return reason;
  if (isAgentStateStopped(record.state)) return AGENT_STALL_REASON_UNKNOWN;
  return null;
}

/**
 * The human words for a pause-reason code.
 *
 * Known code → table label; the `unknown` sentinel → the explicit no-reason-recorded sentence;
 * anything else → the raw code. The raw-string passthrough is the same honest fallback the dashboard
 * resolver promises for unenumerated codes, so a code this table has never heard of (a sibling
 * card's new throttle-family entry, an older build's spelling) still names itself instead of
 * rendering blank.
 */
export function agentPauseReasonLabel(code: string): string {
  if (code === AGENT_STALL_REASON_UNKNOWN) return AGENT_STALL_REASON_UNKNOWN_LABEL;
  return PAUSE_REASON_LABELS[code] ?? code;
}

/**
 * Whether a classified code needs an operator who can repair credentials/billing, as opposed to a
 * retry. Surfaced as a predicate rather than a rendered sentence, so each surface picks its own
 * remedy wording instead of re-deriving a cause from prose.
 */
export function isOperatorActionablePauseReason(code: string | null | undefined): boolean {
  return code === "error-unrecoverable";
}
