/*
FNXC:AssignmentWakeDedup 2026-11-04-21:07 (RUFU-411):
An assignment wake (`task_assigned`) used to be dispatched on trust: every arrival of an `agent:assigned`
event, and every deferred wake drained at the run-completion edge, started a full heartbeat session even
when the observable delta was byte-for-byte identical to the wake that had just finished. Measured on
2026-09-29, agent-5683bf15 received 109 identical-delta wakes against one card in 18 minutes (~8-17 s after
each previous session's `fn_heartbeat_done`, accelerating to a 1-2 s hot loop); each one cost a model
session and each one correctly no-op'd. Agents cannot fix this themselves — the agent-side dedup rule makes
the session exit, and the exit is exactly the event that re-arms the completion-edge re-fire.

This module is the pure half of the fix: the identity of the observable delta, and the bounded-window
decision. It performs no I/O so the policy is unit-testable without a store, a clock, or a session.

Policy shipped: ONE delivery per (agent, goal, observable delta) per window. The window is deliberately
finite rather than a permanent per-goal latch: a permanent latch strands a legitimate re-assignment after
an aborted run until the (default 1 h) timer tick, which trades a wake storm for a silent starvation.
Strictening the policy to "never again until the delta changes" is a one-line change to
`ASSIGNMENT_WAKE_SUPPRESSION_WINDOW_MS` — nothing else in the lane encodes the bound.
*/

/** Default bound for "the same delta was already delivered" — see the policy note above. */
export const ASSIGNMENT_WAKE_SUPPRESSION_WINDOW_MS = 5 * 60 * 1000;

/**
 * Everything the assignment-wake lane can observe about a wake, minus prose.
 *
 * Deliberately NOT included: the rendered wake delta, task titles, prompt text, or any payload body.
 * The operator-facing phrase "1 pending (from this task)" is a rendering produced by
 * `formatAssignedTasksWakeDeltaSection` downstream of these inputs, so keying on the inputs stays
 * stable when the rendering changes and cannot be steered by card content.
 */
export type AssignmentWakeDelta = {
  /** The durable agent the wake would start. */
  agentId: string;
  /** The goal (card) the wake is about. */
  taskId: string;
  /** Agent state as observed by the wake path; absent reads as `"unknown"` rather than crashing the key. */
  agentState?: string | null;
  /** The card the agent is currently bound to (`agent.taskId`); distinct from `taskId` after a rebind. */
  boundTaskId?: string | null;
  /** Steering/comment ids this wake would deliver. Ids only — never bodies. */
  triggeringCommentIds?: string[];
  /** Which comment class the ids came from; meaningless when there are no ids. */
  triggeringCommentType?: string | null;
};

/** The last delivered assignment wake for one agent, as the scheduler records it. */
export type AssignmentWakeRecord = {
  /** The goal the delivered wake was about — diagnostics and the suppression audit row, not a key input. */
  taskId: string;
  signature: string;
  firedAtMs: number;
};

/**
 * FNV-1a, 32-bit. Non-cryptographic by design: the input is ids and fixed enums, the output is a map key
 * and an audit-adjacent discriminator, never an authorization decision.
 */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Canonical identity of an assignment wake.
 *
 * Canonicalisation rules that the invariants depend on:
 * - comment ids are de-duplicated and sorted, so the same set arriving in a different order is the same delta;
 * - `undefined` and `[]` are the same thing ("no comments"), and with no ids the comment class is dropped
 *   from the key entirely, so a wake that omits the type and one that says `"steering"` do not split;
 * - agent, goal, agent state, and bound task are always in the key, so any of those changing is a new delta.
 *
 * The result is length-bounded regardless of how many comment ids a card carries.
 */
export function buildAssignmentWakeSignature(delta: AssignmentWakeDelta): string {
  const commentIds = Array.from(new Set((delta.triggeringCommentIds ?? []).filter((id) => typeof id === "string" && id.length > 0))).sort();
  const commentKey = commentIds.join("|");
  const commentTypeKey = commentIds.length > 0 ? (delta.triggeringCommentType ?? "steering") : "";
  const canonical = [
    `agent=${delta.agentId}`,
    `goal=${delta.taskId}`,
    `state=${delta.agentState ?? "unknown"}`,
    `bound=${delta.boundTaskId ?? ""}`,
    `ctype=${commentTypeKey}`,
    `cids=${commentKey}`,
  ].join(";");
  return `aw1:${fnv1a32(canonical)}`;
}

/**
 * True when this exact delta was already delivered to this agent inside the window, i.e. starting a
 * session now could only repeat a session that already ended having said "nothing to do".
 *
 * Fail-open by construction: an unknown agent (cold engine start), a non-finite timestamp, or a
 * non-positive window all answer `false` and let the wake through. A suppression that strands real work
 * is the expensive failure; a repeated wake is the cheap one, and the window still bounds it.
 */
export function isAssignmentWakeSuppressed(input: {
  prior?: AssignmentWakeRecord | null;
  delta: AssignmentWakeDelta;
  nowMs: number;
  windowMs?: number;
}): boolean {
  const { prior, delta, nowMs } = input;
  if (!prior) return false;
  if (!Number.isFinite(prior.firedAtMs) || !Number.isFinite(nowMs)) return false;
  const windowMs = input.windowMs ?? ASSIGNMENT_WAKE_SUPPRESSION_WINDOW_MS;
  if (!(windowMs > 0)) return false;
  if (nowMs - prior.firedAtMs >= windowMs) return false;
  return prior.signature === buildAssignmentWakeSignature(delta);
}
