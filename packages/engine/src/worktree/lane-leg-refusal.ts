/*
FNXC:LaneLegGate 2026-11-11-22:55 (RUFU-425):
One refusal, one sentence on the card, one audit row — at every gate that refuses.

The reason this is a shared writer rather than three inline `logEntry` calls is the failure the card
started from: a lane leg that measured the wrong repository produced a GREEN verdict with no evidence
behind it. A guard that refuses silently is only slightly better, because the operator sees a card
that will not advance and no sentence explaining that its member directory is empty. Both halves of
the record are therefore written here and nowhere else: the History line names the path an operator can
`ls`, while the run-audit row stays ids/counts/enums so a path never enters the audit store.

Both writes are best-effort by design. The gate's refusal is the lifecycle decision; a board write that
throws, rejects, or never settles must not convert a refusal into a crash, and must not be awaited as a
condition of refusing.
*/
import type { TaskStore } from "@fusion/core";
import { emitBoundedRunAudit, type RunAuditSinkHost } from "../util/emit-bounded-run-audit.js";
import { generateSyntheticRunId, type EngineRunContext } from "../util/run-audit.js";
import { describeLaneLegRefusal, type LaneLegRecord, type LaneLegRefusalCode } from "./lane-legs.js";

/** Which gate refused, so a query can tell the three seams apart without reading prose. */
export const LANE_LEG_REFUSAL_SOURCES = [
  "deterministic-verification",
  "checkout-emptiness",
] as const;

export type LaneLegRefusalSource = (typeof LANE_LEG_REFUSAL_SOURCES)[number];

export interface LaneLegRefusalNotice {
  code: LaneLegRefusalCode;
  repository: string;
  /** The recorded path of the refused leg. History-only: never part of the audit row. */
  path: string;
  legs: readonly LaneLegRecord[];
}

/** A store that can write card History and carry an audit row; `Pick` keeps the seam honest about arity. */
export type LaneLegRefusalStore = Pick<TaskStore, "logEntry"> & RunAuditSinkHost;

/** The card sentence for one refusal. Exported so a surface can render the same words it stores. */
export function laneLegRefusalSentence(notice: LaneLegRefusalNotice, source: LaneLegRefusalSource): string {
  const entryCount = notice.legs.find((leg) => leg.repository === notice.repository)?.entryCount;
  const measured = entryCount === null || entryCount === undefined ? "unreadable" : `${entryCount} entries`;
  return [
    `Lane-leg gate refused: ${describeLaneLegRefusal(notice.code, notice.repository)}`,
    `${notice.code} at ${source}; recorded path ${notice.path || "(none)"} (${measured}), ${notice.legs.length} leg(s) declared.`,
    "This gate produced no verdict — nothing here is evidence that the work is absent or complete.",
  ].join(" ");
}

/**
 * Record one refusal: exactly one History line and one `worktree:lane-leg-refusal` row.
 *
 * Never throws and never blocks the refusal it is describing.
 */
export async function recordLaneLegRefusal(
  store: LaneLegRefusalStore,
  taskId: string,
  notice: LaneLegRefusalNotice,
  source: LaneLegRefusalSource,
  runContext?: EngineRunContext,
): Promise<void> {
  const refusedLeg = notice.legs.find((leg) => leg.repository === notice.repository);
  try {
    await store.logEntry(taskId, laneLegRefusalSentence(notice, source), undefined, runContext);
  } catch {
    // History is the operator's view of the refusal, not a precondition of it.
  }

  const entryCount = refusedLeg?.entryCount;
  void emitBoundedRunAudit(store, {
    taskId,
    agentId: runContext?.agentId ?? "lane-leg-gate",
    runId: runContext?.runId ?? generateSyntheticRunId("lane-leg-gate", taskId),
    domain: "git",
    mutationType: "worktree:lane-leg-refusal",
    target: notice.repository,
    metadata: {
      taskId,
      source,
      code: notice.code,
      repository: notice.repository,
      legCount: notice.legs.length,
      entryCount: typeof entryCount === "number" ? entryCount : null,
    },
  });
}
