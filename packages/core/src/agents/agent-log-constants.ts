import type { AgentLogEntry } from "../types.js";

export const AGENT_LOG_FILENAME = "agent-log.jsonl";

/*
 * FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
 * This is the INLINE bound — the largest `detail` a JSONL row may carry — measured in UTF-16 code units
 * (`String.length`), matching its name. Payload past it is spilled out-of-line and addressed by a pointer
 * (`agents/agent-log-detail-spill.ts`), so the row size no longer scales with the payload.
 *
 * The value stays 4 096 deliberately. It is the bound every existing row-shape pin was measured against, and
 * a larger inline bound would collide numerically with `AGENT_LOG_TAIL_WINDOW_BYTES` (64 KiB,
 * `agent-log-file-store.ts`), whose whole purpose is to keep one append's tail read inside a window that a
 * bounded row comfortably fits.
 */
export const AGENT_LOG_TOOL_DETAIL_LIMIT = 4_096;

export const AGENT_LOG_TOOL_TYPES = new Set<AgentLogEntry["type"]>([
  "tool",
  "tool_result",
  "tool_error",
]);

/*
 * The bounded inline PREFIX — not a truncation.
 *
 * FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
 * This function used to be the lossy cut that destroyed coordination evidence: it returned
 * `detail.slice(0, LIMIT)` plus the prose notice
 * `[tool output truncated to keep dashboard log views responsive]`, and because it ran on the write path AND
 * on the read path, the excess existed in no copy and the loss marker itself was uncountable prose. Both
 * producers now call `spillAgentLogDetail`, which keeps this prefix and persists the remainder; nothing on
 * any write or read path may paste a marker into a persisted row again.
 *
 * It returns `undefined` exactly when there is nothing to persist, so callers can spread conditionally.
 *
 * FNXC:AgentLogging 2026-07-15-16:05:
 * FN-7995 keeps failed `tool_error` detail persisted even when verbose tool output is disabled; its storage
 * bound stays identical to the other tool detail types so diagnostic stacks remain safe for JSONL reads.
 */
export function inlineAgentLogToolDetail(
  detail: string | null | undefined,
  type: AgentLogEntry["type"],
): string | undefined {
  if (detail == null) return undefined;
  if (!AGENT_LOG_TOOL_TYPES.has(type)) return detail;
  if (detail.length <= AGENT_LOG_TOOL_DETAIL_LIMIT) return detail;
  return detail.slice(0, AGENT_LOG_TOOL_DETAIL_LIMIT);
}

/**
 * The JSONL file name `AgentStore` uses for one run's log.
 *
 * FNXC:AgentLogDetailSpill 2026-11-06-00:46 (RUFU-340):
 * Extracted from `AgentStore.runLogPath` because spill reclamation must derive a run body's referrer from the
 * producer directory's own path (`run/<agentId>/<runId>` → this file name in the agents directory). A second
 * spelling of the convention would let reclaim compute a referrer that never existed and then delete a body
 * whose log it in fact never read — the exact failure Decision 12 forbids. One home, both readers.
 */
export function agentRunLogFileName(agentId: string, runId: string): string {
  return `${agentId}-runlogs-${runId}.jsonl`;
}

export function buildAgentLogSourceRef(taskId: string, lineNo: number): string {
  return `agentLog:${taskId}:${lineNo}`;
}
