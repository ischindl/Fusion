import { DASHBOARD_USER_ID, type Message, type MessageCreateInput } from "@fusion/core";
import {
  COMPLETE_LANE_EVIDENCE_SWEEP_NAME,
  type CompleteLaneEvidenceFinding,
} from "./complete-lane-evidence-detection.js";
import { deliverMailboxMessageOnce } from "./mailbox-delivery.js";

/*
FNXC:CompleteLaneBoundary 2026-11-08-13:36 (RUFU-349):
One mailbox notice per card per UTC day, through the same idempotent `sendMessageOnce` seam the heap-ceiling
and retention notices use. Deliberately NOT a `NotificationService` wedge: a card already resting in a
terminal lane grows no new stall code, so wedge dedupe — which hangs off a stall transition — would swallow
the announcement forever.

The notice is a convenience layered on top of the durable record. It is built and sent by a caller-injected
callback so the sweep's write order stays auditable: the run-audit row and the card's History line are
already durable before this runs, and a mailbox outage cannot undo either of them.

FNXC:CompleteLaneBoundary 2026-11-08-15:16 (RUFU-349, Code Review finding P2):
This factory used to take the `TaskStore` and reach the mailbox through `store.getMessageStore?.()`. No
`TaskStore` has that method — the mailbox lives on `ProjectEngineRuntime` and is handed to self-healing as
`options.messageStore` — so the duck-type resolved to `undefined` on every pass and the notice was
unreachable in production while every test that injected a fake `noticeFor` callback stayed green. A report
whose alarming half cannot fire is the RUFU-318 invisible-refusal defect in the other direction. It now
takes the mailbox itself, which is the convention every sibling engine notice already uses
(`unrun-gate-park-notice.ts`, `vanished-task-detection.ts`, `auto-merge-finalization.ts`), so the caller
cannot pass an object that has no mailbox on it, and the write goes through `deliverMailboxMessageOnce`,
which bounds a missing, throwing, rejecting, or stalled store to `unavailable` (RUFU-249's rule: an optional
notice may never delay or alter the recovery it reports).
*/
export interface CompleteLaneEvidenceMailbox {
  sendMessageOnce?(input: MessageCreateInput, idempotencyKey: string): Promise<{ message: Message; inserted: boolean }>;
}

/** The notice's idempotency key: one announcement per card per state per UTC day. */
export function completeLaneEvidenceNoticeKey(
  finding: CompleteLaneEvidenceFinding,
  dayBucket: string,
): string {
  return [
    "complete-lane-evidence",
    finding.taskId,
    finding.findings[0]?.state ?? "unknown",
    dayBucket,
  ].join(":");
}

export function createCompleteLaneEvidenceNoticeSender(
  messageStore: CompleteLaneEvidenceMailbox | null | undefined,
): (finding: CompleteLaneEvidenceFinding) => Promise<boolean> {
  return async (finding) => {
    const dayBucket = new Date(finding.now).toISOString().slice(0, 10);
    const gateList = finding.findings
      .map((item) => `'${item.gateId}' (${item.lane}, ${item.state})`)
      .join(", ");
    const first = finding.findings[0];

    const outcome = await deliverMailboxMessageOnce(
      messageStore ?? undefined,
      {
        fromId: "system",
        fromType: "system",
        toId: DASHBOARD_USER_ID,
        toType: "user",
        type: "system",
        content:
          `Card ${finding.taskId} sits in column '${finding.column}' without approving gate evidence: `
          + `${gateList}. Nothing was moved and no verdict was invented - an operator decision is required.`
          + `\n\nSweep: ${COMPLETE_LANE_EVIDENCE_SWEEP_NAME}`,
        metadata: {
          kind: "complete-lane-gate-evidence-finding",
          taskId: finding.taskId,
          column: finding.column,
          lane: first?.lane,
          state: first?.state,
          gateCount: finding.findings.length,
        },
      },
      completeLaneEvidenceNoticeKey(finding, dayBucket),
    );
    return outcome === "delivered";
  };
}
