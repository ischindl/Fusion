import type { Agent, MessageCreateInput, ParticipantType } from "../types.js";
import { DASHBOARD_USER_ID, isEphemeralAgent } from "../types.js";
import { emitBoundedRunAudit, type RunAuditSinkHost } from "../run-audit/emit-bounded-run-audit.js";

/*
FNXC:CommentDelivery 2026-09-27-17:32 (RUFU-259):
An operator comment on a card used to be an append to a JSON array plus, at best, a wake hint. That
is not delivery: the wake path skipped `messageResponseMode: "on-heartbeat"` recipients entirely, so the
body sat in a row nobody was about to read while the writer reported success; and a wake that did fire
carried only a count and an id the woken agent could not resolve into a body (RUFU-251 measured four
`fn_task_show` calls that returned no comment text while the wake counter kept advancing).

This module is the delivery seam: resolve exactly one recipient, then make the body durable in that
agent's inbox before anything claims the comment was "delivered". The message — not the wake — is the
contract: `sendMessageOnce` is idempotent per (task, comment), so a retried write cannot double-deliver,
and an `on-heartbeat` recipient reads the body at its next heartbeat instead of losing it.
`metadata.wakeRecipient` on a user-authored message is what still forces an immediate wake for the
agents that support it (the hook only honors the override for `fromType === "user"`, so agent-authored
steering never force-wakes a peer).

Routing is deterministic and single-recipient: a role pool with more than one candidate is NOT fanned
out, because operator steering addressed to "the executor" is one instruction and two agents acting on
it independently is a conflict, not redundancy. An unresolvable recipient is surfaced — an operator
mailbox notice, a task log entry on the card the operator typed into, and a bounded run-audit row —
never swallowed, because the writer's HTTP response is not something the woken agent can act on.

There is deliberately no sourceMetadata delivery marker: the durable message row already names the
recipient, the sender, the comment id, and the time, and a second per-comment record would be a second
writer of the same fact with no reader.
*/

/** Which lane the card was sitting in when the comment was written. */
export type TaskCommentLane = "planning" | "work";

/**
 * How the recipient was resolved: one rung of the ladder, fixed enum, audit-visible.
 *
 * FNXC:CommentDelivery 2026-09-27-18:05 (RUFU-259): the five rungs are the spec's ladder — the card's
 * own assignee, the agent the selected workflow binds to the card's column, the agent it binds to the
 * planning lane, then a lane's unique triage / unique executor agent. A reviewer answering "who got my
 * comment?" reads this value, so it names the rung rather than a generic "pool".
 */
export type TaskCommentRecipientVia =
  | "assignee"
  | "column-binding"
  | "workflow-binding"
  | "triage-pool"
  | "executor-pool"
  | "none";

/** Why the last rung of the ladder could not resolve a recipient. Fixed enum, audit-visible. */
export type TaskCommentUnroutedReason = "pool-empty" | "pool-ambiguous";

/**
 * Why an earlier rung was walked past. Recorded even when a later rung succeeds, so the audit row can
 * tell "no binding existed" apart from "a binding existed but declined" or "the executor pool was
 * ambiguous so the triage pool got the comment instead".
 */
export type TaskCommentRungSkip =
  | "dangling-assignee"
  | "binding-deferred"
  | "binding-not-found"
  | "pool-empty"
  | "pool-ambiguous";

/** What the delivery seam actually did. Fixed enum, audit-visible. */
export type TaskCommentDeliveryOutcome =
  | "delivered"
  | "already-delivered"
  | "unrouted"
  | "no-message-store"
  | "send-failed";

/** The operator/agent-facing write surfaces that hand a comment to this seam. Fixed enum for audit attribution. */
export type TaskCommentSource =
  | "dashboard-comment"
  | "dashboard-steer"
  | "review-address"
  | "pr-address"
  | "planner-chat"
  | "cli-comment"
  | "cli-steer";

/** Body cap for the delivered copy. An operator paste stays readable without an unbounded inbox row. */
const MAX_DELIVERED_COMMENT_CHARS = 8_000;

/** The role that owns each lane's work. Planning is triage; every other lane is executor work. */
export function taskCommentLaneRole(lane: TaskCommentLane): "triage" | "executor" {
  return lane === "planning" ? "triage" : "executor";
}

/*
FNXC:CommentDelivery 2026-09-27-19:15 (RUFU-259):
A comment's `author` is free text, but the vocabulary written across the seven surfaces is closed:
`"user"` (dashboard + CLI defaults), `"agent"` or an `agent-…` id (engine-side writers, `--author`
passes an id), and `"system"`. Only a user sender may force an immediate wake, and only a resolvable
sender can collect a reply, so the two actor lanes map explicitly and an unrecognized author stays
human — the failure mode of defaulting the other way is an operator's own steering silently losing its
wake, which is the defect this card exists to kill.
*/
export function taskCommentAuthorType(author?: string): ParticipantType {
  const trimmed = author?.trim();
  if (!trimmed || trimmed === "user" || trimmed === "cli" || trimmed === "operator") return "user";
  if (trimmed === "agent" || trimmed.startsWith("agent-")) return "agent";
  if (trimmed === "system") return "system";
  return "user";
}

/** Compact non-cryptographic hash, used only to keep an id-less comment's delivery key stable per body. */
function textFingerprint(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

/**
 * The id the delivery key, audit row, and notice are all stamped with.
 *
 * FNXC:CommentDelivery 2026-09-27-19:20 (RUFU-259): comments get their id on write, so an empty one is
 * a legacy row. Falling back to a content hash keeps two id-less comments distinct in the inbox instead
 * of collapsing every one of them onto the same idempotency key — which would silently drop the second
 * comment while still answering 200.
 */
export function taskCommentDeliveryId(comment: { id?: string; text?: string; createdAt?: string }): string {
  const trimmed = comment.id?.trim();
  if (trimmed) return trimmed;
  return `no-id-${textFingerprint(`${comment.createdAt ?? ""}|${comment.text ?? ""}`)}`;
}

/** A column's permanent agent binding, as declared in the selected workflow's IR. */
export interface TaskCommentColumnBinding {
  agentId: string;
  /** `defer` applies only when the card carries no agent/model selection of its own. */
  mode?: "defer" | "override";
}

export interface TaskCommentRecipientInput {
  /** The card's own agent assignment, when one exists. */
  assignedAgentId?: string | null;
  /** Permanent agent bound to the column the card is sitting in. */
  columnBinding?: TaskCommentColumnBinding | null;
  /**
   * Permanent agent bound to the workflow's planning lane (its intake or pre-wip hold column) — the
   * "bound planner". Reached only after the card's own column binding, which names the agent doing the
   * work in front of it.
   */
  workflowBinding?: TaskCommentColumnBinding | null;
  /** True when the card carries its own agent or model selection, which a `defer` binding yields to. */
  taskOwnAgentSetting?: boolean;
  /** Defaults to the work lane; only a card still in planning is different. */
  lane?: TaskCommentLane;
  /** Candidate agents. Ephemeral task-workers are filtered here, so a caller may pass a raw list. */
  pool: readonly Agent[];
}

export interface TaskCommentRecipient {
  /** The single agent that must receive the body, when one resolved. */
  agentId?: string;
  via: TaskCommentRecipientVia;
  /** Set only when `via` is "none". */
  unroutedReason?: TaskCommentUnroutedReason;
  /** Rungs walked past on the way to `via`. A skipped rung never blocks a lower one: a deferred
   * column binding must not cost a card its unique lane agent. */
  skippedRungs: TaskCommentRungSkip[];
  /** How many candidates the deciding pool held; a count only, never names. */
  poolSize: number;
}

function findPoolAgent(pool: readonly Agent[], agentId: string): Agent | undefined {
  return pool.find((agent) => agent.id === agentId);
}

/** Walk one binding rung: `undefined` when it does not apply, with the reason recorded. */
function bindingRung(
  binding: TaskCommentColumnBinding | null | undefined,
  taskOwnAgentSetting: boolean | undefined,
  pool: readonly Agent[],
  skipped: TaskCommentRungSkip[],
): string | undefined {
  if (!binding?.agentId) return undefined;
  if (binding.mode === "defer" && taskOwnAgentSetting) {
    skipped.push("binding-deferred");
    return undefined;
  }
  if (findPoolAgent(pool, binding.agentId)) return binding.agentId;
  // A binding that names a deleted, or purely ephemeral, agent must not swallow the ladder.
  skipped.push("binding-not-found");
  return undefined;
}

/**
 * Resolve the one agent who owns this card's next action.
 *
 * Ladder: the card's explicit assignee, the permanent binding on the column the card is in, the
 * permanent binding on the workflow's planning lane, then a role pool holding exactly ONE durable
 * agent for the lane — the lane's own role first, the other role second, so an ambiguous executor pool
 * still delivers to a uniquely-identified planner instead of reporting failure on the observed
 * RUFU-251 shape. Anything else is `none` with a reason — never a guess, and never a fan-out.
 *
 * FNXC:CommentDelivery 2026-09-27-18:05 (RUFU-259): the card's own column binding is tried before the
 * planning-lane binding because it names the agent standing at the card's actual position; the
 * planning-lane binding is the fallback for a card whose own column carries none.
 */
export function resolveTaskCommentRecipient(input: TaskCommentRecipientInput): TaskCommentRecipient {
  const pool = (input.pool ?? []).filter((agent) => agent && !isEphemeralAgent(agent));
  const lane = input.lane ?? "work";
  const skippedRungs: TaskCommentRungSkip[] = [];

  const assigned = input.assignedAgentId?.trim();
  if (assigned) {
    if (findPoolAgent(pool, assigned)) return { agentId: assigned, via: "assignee", skippedRungs, poolSize: 0 };
    skippedRungs.push("dangling-assignee");
  }

  const columnBound = bindingRung(input.columnBinding, input.taskOwnAgentSetting, pool, skippedRungs);
  if (columnBound) return { agentId: columnBound, via: "column-binding", skippedRungs, poolSize: 0 };

  const workflowBound = bindingRung(input.workflowBinding, input.taskOwnAgentSetting, pool, skippedRungs);
  if (workflowBound) return { agentId: workflowBound, via: "workflow-binding", skippedRungs, poolSize: 0 };

  const preferred = taskCommentLaneRole(lane);
  const order: readonly ("triage" | "executor")[] = [preferred, preferred === "triage" ? "executor" : "triage"];
  let terminal: { reason: TaskCommentUnroutedReason; poolSize: number } | undefined;
  for (const role of order) {
    const candidates = pool.filter((agent) => agent.roles?.includes(role) || agent.role === role);
    if (candidates.length === 1) {
      return {
        agentId: candidates[0].id,
        via: role === "triage" ? "triage-pool" : "executor-pool",
        skippedRungs,
        poolSize: 1,
      };
    }
    const reason: TaskCommentUnroutedReason = candidates.length === 0 ? "pool-empty" : "pool-ambiguous";
    skippedRungs.push(reason);
    // The lane's own role is the honest terminal reason and reports its size; a fallback pool only
    // explains why the preferred rung was walked past.
    if (role === preferred) terminal = { reason, poolSize: candidates.length };
  }

  return {
    via: "none",
    unroutedReason: terminal?.reason ?? "pool-empty",
    skippedRungs,
    poolSize: terminal?.poolSize ?? 0,
  };
}

/** The delivery seam's only required message-store capability. */
export interface TaskCommentMessageSink {
  sendMessageOnce(input: MessageCreateInput, idempotencyKey: string): Promise<{ message: { id: string }; inserted: boolean }>;
}

/** The card-log capability used to make an undeliverable comment visible where it was typed. */
export interface TaskCommentLogSink {
  logEntryOnce(
    id: string,
    input: { action: string; outcome?: string; dedupeKey: string; windowMs: number },
  ): Promise<unknown>;
}

/** How long an identical undeliverable-comment log line stays deduplicated. */
const COMMENT_LOG_DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface TaskCommentDeliveryInput {
  taskId: string;
  comment: {
    /** Comment id from the unified `comments` row; the same id the wake advertises. */
    id: string;
    text: string;
    author?: string;
    /** Sender identity. Only a "user" sender may force an immediate wake. Derived from `author` when absent. */
    authorType?: ParticipantType;
    createdAt?: string;
    kind?: "comment" | "steering";
  };
  recipient: TaskCommentRecipient;
  /** Which write surface invoked the seam; recorded in audit, never as prose. */
  source: TaskCommentSource;
  /** Absent when the host has no messaging transport (e.g. a store without an `AsyncDataLayer`). */
  messageSink?: TaskCommentMessageSink | null;
  /** Bounded run-audit sink; a `TaskStore` satisfies it. */
  auditHost?: RunAuditSinkHost;
  /** Card-log writer; optional, because delivery must not need it. */
  logSink?: TaskCommentLogSink | null;
}

export interface TaskCommentDeliveryResult {
  outcome: TaskCommentDeliveryOutcome;
  via: TaskCommentRecipientVia;
  unroutedReason?: TaskCommentUnroutedReason;
  /** Carried through from the resolution so a caller can report why a rung did not apply. */
  skippedRungs?: TaskCommentRungSkip[];
  recipientAgentId?: string;
  /** Display name of the recipient, attached by the host from the agent pool so a caller can report a person, not an id. */
  recipientLabel?: string;
  /** Inbox row that carries the body, when one was written (or already existed). */
  messageId?: string;
  /** Operator-facing notice row written for a comment that could not be delivered. */
  noticeMessageId?: string;
}

/**
 * Plain-language report of what a hand-off achieved, for the surfaces that answer in text (the CLI and
 * chat tools) rather than in JSON.
 *
 * FNXC:CommentDelivery 2026-09-27-20:20 (RUFU-259 Step 4):
 * Every write surface used to answer "added" and stop there, which is the sentence this card exists to
 * retire: an add that reaches nobody is not a delivery. The wording states the recipient when the body
 * really landed, and states the failure in the operator's terms when it did not — never a silent success.
 */
export function describeTaskCommentDelivery(result: TaskCommentDeliveryResult | null | undefined): string {
  const recipient = result?.recipientLabel ?? result?.recipientAgentId;
  switch (result?.outcome) {
    case "delivered":
    case "already-delivered":
      return `Delivered to ${recipient ?? "the responsible agent"} (${result.via}).`;
    case "unrouted":
      return `Not delivered: ${UNROUTED_DELIVERY_SENTENCE[result.unroutedReason ?? "pool-empty"]} The operator has been notified.`;
    case "no-message-store":
      return "Not delivered: this project has no message store, so the comment is saved but cannot be handed to anyone. The operator has been notified.";
    case "send-failed":
      return "Not delivered: the inbox write failed. The operator has been notified.";
    default:
      return "Not delivered: the hand-off could not be attempted. The comment is saved but nobody has been told.";
  }
}

/*
FNXC:CommentDelivery 2026-09-27-21:10 (RUFU-259 Step 4):
Both terminal reasons are reported in the operator's terms because both were previously invisible. An
ambiguous pool is the one worth spelling out: the seam deliberately refuses to guess, and "nobody
received it because we could not tell who should" reads very differently from "nobody is available".
*/
const UNROUTED_DELIVERY_SENTENCE: Record<TaskCommentUnroutedReason, string> = {
  "pool-empty": "no agent is responsible for it — it has no assignee, no column or workflow binding, and no durable agent in that lane",
  "pool-ambiguous": "more than one agent could have received it, and guessing would have delivered it to the wrong one",
};

/** Build the inbox body the recipient can act on without any further lookup. */
export function renderTaskCommentMessage(input: {
  taskId: string;
  text: string;
  author?: string;
  createdAt?: string;
  kind?: "comment" | "steering";
}): string {
  const body = input.text ?? "";
  const clipped = body.length > MAX_DELIVERED_COMMENT_CHARS
    ? `${body.slice(0, MAX_DELIVERED_COMMENT_CHARS)}\n\n… (body clipped at ${MAX_DELIVERED_COMMENT_CHARS} of ${body.length} characters)`
    : body;
  const kind = input.kind ?? "comment";
  const clock = input.createdAt ?? "unknown time";
  return [
    `Operator ${kind} on ${input.taskId} from ${input.author ?? "unknown"} at ${clock}:`,
    "",
    clipped,
    "",
    `Reply on the card itself (dashboard comment box on ${input.taskId}, or \`fn task comment ${input.taskId} "…"\`) — other agents cannot read your inbox.`,
    `Every comment on this card: fn_task_show(id: "${input.taskId}", commentIds: ["…"]) — pass the id named in this message.`,
  ].join("\n");
}

/**
 * Deliver one comment to one resolved recipient.
 *
 * Best-effort by construction: every store interaction is optional and failures are reported through
 * the returned outcome rather than thrown, because a comment whose delivery telemetry failed is still
 * a comment the operator wrote. The durable `sendMessageOnce` write is the only guarantee this seam
 * makes, and it is idempotent per (task, comment id) under `task-comment:<taskId>:<commentId>`.
 *
 * FNXC:CommentDelivery 2026-09-27-18:10 (RUFU-259): a comment that reaches nobody is the failure this
 * task exists to kill, so no branch of this function exits silently. `unrouted` writes an operator
 * notice plus a task log entry and records `task:comment-delivery-unowned`; a missing transport or a
 * failed write records `task:comment-delivery` with its outcome and the same operator notice, because
 * a 200 response nobody is looking at is not an announcement.
 */
export async function deliverTaskComment(
  input: TaskCommentDeliveryInput,
): Promise<TaskCommentDeliveryResult> {
  const { taskId, comment, recipient, source, messageSink } = input;
  const kind = comment.kind ?? "comment";
  const commentId = taskCommentDeliveryId(comment);
  const authorType = comment.authorType ?? taskCommentAuthorType(comment.author);
  const base: Pick<TaskCommentDeliveryResult, "via" | "unroutedReason" | "recipientAgentId" | "skippedRungs"> = {
    via: recipient.via,
    unroutedReason: recipient.unroutedReason,
    recipientAgentId: recipient.agentId,
    skippedRungs: recipient.skippedRungs,
  };

  const audit = async (outcome: TaskCommentDeliveryOutcome, extra: Record<string, unknown> = {}) =>
    emitBoundedRunAudit(input.auditHost, {
      taskId,
      agentId: "task-comment-delivery",
      runId: `task-comment-delivery:${taskId}:${commentId}`,
      domain: "database",
      mutationType: outcome === "unrouted" ? "task:comment-delivery-unowned" : "task:comment-delivery",
      target: taskId,
      metadata: {
        source,
        kind,
        commentId,
        via: recipient.via,
        outcome,
        unroutedReason: recipient.unroutedReason ?? "none",
        skippedRungs: recipient.skippedRungs,
        poolSize: recipient.poolSize,
        messageStoreAvailable: Boolean(messageSink),
        ...extra,
      },
    });

  /** Announce a comment that is not going to be acted on, on the mailbox AND on the card itself. */
  const announceUndelivered = async (reason: string, noticeKind: string, dedupeKey: string): Promise<string | undefined> => {
    let noticeMessageId: string | undefined;
    if (messageSink) {
      try {
        const notice = await messageSink.sendMessageOnce({
          fromId: "system",
          fromType: "system",
          toId: DASHBOARD_USER_ID,
          toType: "user",
          type: "system",
          content: [
            `Your ${kind} on ${taskId} ${reason}.`,
            "",
            "It is stored on the card, but no agent has been given it, so nothing will act on it until that is fixed.",
            recipient.agentId
              ? `Intended recipient: ${recipient.agentId}.`
              : `Lane candidates for this card: ${recipient.poolSize}. Assign the card or bind an agent to its column.`,
          ].join("\n"),
          metadata: { taskId, kind: noticeKind, commentId, subject: `Undelivered comment on ${taskId}` },
        }, dedupeKey);
        noticeMessageId = notice.message.id;
      } catch {
        // A mailbox outage must not lose the comment nor fail the writer; the audit row is the record.
      }
    }
    if (input.logSink) {
      try {
        await input.logSink.logEntryOnce(taskId, {
          action: `Comment written but not delivered: ${reason}`,
          outcome: `recipient: ${recipient.agentId ?? "none"}; via: ${recipient.via}; mailbox notice: ${noticeMessageId ? "sent" : "unavailable"}`,
          dedupeKey: `task-comment-undelivered:${taskId}:${commentId}`,
          windowMs: COMMENT_LOG_DEDUPE_WINDOW_MS,
        });
      } catch {
        // A card-log write is a secondary channel; the audit row already carries the outcome.
      }
    }
    return noticeMessageId;
  };

  if (!recipient.agentId) {
    const noticeMessageId = await announceUndelivered(
      `could not be routed to any agent (${recipient.unroutedReason ?? "no-recipient"})`,
      "task-comment-unowned",
      `task-comment-unowned:${taskId}:${commentId}`,
    );
    await audit("unrouted", { noticeDelivered: Boolean(noticeMessageId) });
    return { ...base, outcome: "unrouted", noticeMessageId };
  }

  if (!messageSink) {
    const noticeMessageId = await announceUndelivered(
      "could not be stored in the recipient's inbox: this project has no messaging transport",
      "task-comment-undelivered",
      `task-comment-undelivered:${taskId}:${comment.id}`,
    );
    await audit("no-message-store", { noticeDelivered: Boolean(noticeMessageId) });
    return { ...base, outcome: "no-message-store", noticeMessageId };
  }

  try {
    const sent = await messageSink.sendMessageOnce({
      fromId: comment.author && authorType !== "system" ? comment.author : "system",
      fromType: authorType,
      toId: recipient.agentId,
      toType: "agent",
      type: authorType === "agent" ? "agent-to-agent" : "user-to-agent",
      content: renderTaskCommentMessage({
        taskId,
        text: comment.text,
        author: comment.author,
        createdAt: comment.createdAt,
        kind,
      }),
      metadata: {
        taskId,
        kind: "task-comment",
        commentId: comment.id,
        subject: `${kind} on ${taskId}`,
        // Only a user-authored comment may force an immediate wake past `on-heartbeat`.
        wakeRecipient: authorType === "user" ? true : undefined,
      },
    }, `task-comment:${taskId}:${commentId}`);
    const outcome: TaskCommentDeliveryOutcome = sent.inserted ? "delivered" : "already-delivered";
    await audit(outcome, { messageId: sent.message.id });
    return { ...base, outcome, messageId: sent.message.id };
  } catch {
    const noticeMessageId = await announceUndelivered(
      `could not be stored in ${recipient.agentId}'s inbox (the messaging write failed)`,
      "task-comment-undelivered",
      `task-comment-undelivered:${taskId}:${commentId}`,
    );
    await audit("send-failed", { noticeDelivered: Boolean(noticeMessageId) });
    return { ...base, outcome: "send-failed", noticeMessageId };
  }
}
