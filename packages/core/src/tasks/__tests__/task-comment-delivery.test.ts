import { describe, expect, it } from "vitest";
import type { Agent, MessageCreateInput } from "../../types.js";
import {
  deliverTaskComment,
  renderTaskCommentMessage,
  resolveTaskCommentRecipient,
} from "../task-comment-delivery.js";

/*
FNXC:CommentDelivery 2026-09-27-17:48 (RUFU-259):
These tests are the acceptance contract for the delivery seam: one comment resolves to exactly one
recipient, the body becomes durable in that recipient's inbox, and a comment that cannot be routed is
reported instead of vanishing. RUFU-251 is the motivating failure — the operator's steering text was
written to a row and nobody was ever given it.
*/

function agent(id: string, roles: Agent["roles"], name = id): Agent {
  return {
    id,
    name,
    roles,
    role: roles[0],
    state: "idle",
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
    metadata: {},
  } as Agent;
}

const planner = agent("agent-planner", ["triage"], "Workflow Planner");
const executor = agent("agent-exec", ["executor"], "Workflow Executor");
const secondExecutor = agent("agent-exec-2", ["executor"], "Audit Executor");
const reviewer = agent("agent-review", ["reviewer"], "Code Reviewer");

function fakeSink(inserted = true) {
  const sends: Array<{ input: MessageCreateInput; key: string }> = [];
  const sink = {
    async sendMessageOnce(input: MessageCreateInput, key: string) {
      sends.push({ input, key });
      return { message: { id: `msg-${sends.length}` }, inserted };
    },
  };
  return { sink, sends };
}

function fakeAudit() {
  const events: Array<Record<string, unknown>> = [];
  return {
    host: { recordRunAuditEvent: (input: Record<string, unknown>) => { events.push(input); } },
    events,
  };
}

function fakeLog() {
  const entries: Array<{ id: string; action: string; dedupeKey: string }> = [];
  return {
    sink: {
      async logEntryOnce(id: string, input: { action: string; outcome?: string; dedupeKey: string; windowMs: number }) {
        entries.push({ id, action: input.action, dedupeKey: input.dedupeKey });
        return true;
      },
    },
    entries,
  };
}

describe("resolveTaskCommentRecipient", () => {
  it("prefers the card's own assignee over any binding or lane pool", () => {
    const r = resolveTaskCommentRecipient({
      assignedAgentId: executor.id,
      columnBinding: { agentId: planner.id, mode: "override" },
      pool: [planner, executor],
    });
    expect(r).toMatchObject({ agentId: executor.id, via: "assignee" });
  });

  it("uses the binding on the card's own column before any pool", () => {
    const r = resolveTaskCommentRecipient({
      columnBinding: { agentId: executor.id, mode: "override" },
      pool: [planner, executor, secondExecutor],
    });
    // An ambiguous executor pool must not veto a binding that names the exact agent.
    expect(r).toMatchObject({ agentId: executor.id, via: "column-binding", skippedRungs: [] });
  });

  it("falls to the workflow's bound planner when the card's own column carries no binding", () => {
    const r = resolveTaskCommentRecipient({
      workflowBinding: { agentId: planner.id, mode: "override" },
      pool: [planner, executor, secondExecutor],
      lane: "work",
    });
    expect(r).toMatchObject({ agentId: planner.id, via: "workflow-binding", skippedRungs: [] });
  });

  it("lets a defer binding fall through when the card carries its own model selection", () => {
    const r = resolveTaskCommentRecipient({
      columnBinding: { agentId: planner.id, mode: "defer" },
      taskOwnAgentSetting: true,
      pool: [planner],
      lane: "planning",
    });
    // The deferral must not erase the lane rung: the unique planner still receives the comment.
    expect(r).toMatchObject({ agentId: planner.id, via: "triage-pool", skippedRungs: ["binding-deferred"] });
  });

  it("routes a planning card to the unique triage agent, not to an executor", () => {
    const r = resolveTaskCommentRecipient({ pool: [planner, executor], lane: "planning" });
    expect(r).toMatchObject({ agentId: planner.id, via: "triage-pool" });
  });

  it("rescues the observed RUFU-251 shape: an un-assigned work card with two executors", () => {
    // RUFU-251 measured exactly this board: un-assigned card, several executors, one planner. The old
    // seam woke nobody at all; the ladder must still hand the body to the unique planner.
    const r = resolveTaskCommentRecipient({ pool: [planner, executor, secondExecutor], lane: "work" });
    expect(r).toMatchObject({
      agentId: planner.id,
      via: "triage-pool",
      skippedRungs: ["pool-ambiguous"],
    });
    expect(r.unroutedReason).toBeUndefined();
  });

  it("refuses to fan out when the deciding pool holds more than one agent and nothing rescues it", () => {
    const r = resolveTaskCommentRecipient({ pool: [executor, secondExecutor], lane: "work" });
    expect(r.agentId).toBeUndefined();
    expect(r).toMatchObject({ via: "none", unroutedReason: "pool-ambiguous", poolSize: 2 });
  });

  it("reports an empty ladder distinctly from an ambiguous one", () => {
    const r = resolveTaskCommentRecipient({ pool: [reviewer], lane: "work" });
    expect(r).toMatchObject({ via: "none", unroutedReason: "pool-empty", poolSize: 0 });
  });

  it("records a dangling assignee and keeps walking the ladder", () => {
    const r = resolveTaskCommentRecipient({
      assignedAgentId: "agent-deleted",
      columnBinding: { agentId: "agent-unbound" },
      pool: [executor],
    });
    expect(r).toMatchObject({
      agentId: executor.id,
      via: "executor-pool",
      skippedRungs: ["dangling-assignee", "binding-not-found"],
    });
  });

  it("never routes to an ephemeral task-worker even when it is the only executor", () => {
    const worker = { ...agent("agent-worker", ["executor"], "executor-transient"), reportsTo: null } as Agent;
    const r = resolveTaskCommentRecipient({ pool: [worker] });
    expect(r).toMatchObject({ via: "none", unroutedReason: "pool-empty", poolSize: 0 });
  });
});

describe("deliverTaskComment", () => {
  const comment = {
    id: "1758-abc",
    text: "Please cover the empty-catalog case before merging.",
    author: "user:operator",
    createdAt: "2026-09-27T16:00:00.000Z",
    kind: "steering" as const,
  };

  const toExecutor = () => resolveTaskCommentRecipient({ assignedAgentId: executor.id, pool: [executor] });

  it("writes the body durably into the recipient's inbox and records the outcome", async () => {
    const { sink, sends } = fakeSink();
    const audit = fakeAudit();
    const result = await deliverTaskComment({
      taskId: "RUFU-259",
      comment,
      recipient: toExecutor(),
      source: "dashboard-steer",
      messageSink: sink,
      auditHost: audit.host,
    });

    expect(result).toMatchObject({ outcome: "delivered", via: "assignee", recipientAgentId: executor.id, messageId: "msg-1" });
    expect(sends).toHaveLength(1);
    expect(sends[0].key).toBe("task-comment:RUFU-259:1758-abc");
    expect(sends[0].input).toMatchObject({ toId: executor.id, toType: "agent", fromType: "user", type: "user-to-agent" });
    expect(sends[0].input.content).toContain("Please cover the empty-catalog case");
    expect(sends[0].input.content).toContain('fn_task_show(id: "RUFU-259"');
    expect(sends[0].input.metadata).toMatchObject({
      taskId: "RUFU-259",
      kind: "task-comment",
      commentId: "1758-abc",
      wakeRecipient: true,
    });
    expect(sends[0].input.metadata?.subject).toBe("steering on RUFU-259");

    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ mutationType: "task:comment-delivery", taskId: "RUFU-259", target: "RUFU-259" });
    expect(audit.events[0].metadata).toMatchObject({ source: "dashboard-steer", kind: "steering", via: "assignee", outcome: "delivered" });
    // The comment body is operator prose and must never reach run-audit.
    expect(JSON.stringify(audit.events[0])).not.toContain("empty-catalog");
  });

  it("reports an idempotent replay as already-delivered without pretending a second write", async () => {
    const { sink, sends } = fakeSink(false);
    const audit = fakeAudit();
    const result = await deliverTaskComment({
      taskId: "RUFU-259",
      comment,
      recipient: toExecutor(),
      source: "cli-steer",
      messageSink: sink,
      auditHost: audit.host,
    });
    expect(result.outcome).toBe("already-delivered");
    expect(audit.events[0].metadata).toMatchObject({ outcome: "already-delivered" });
    expect(sends).toHaveLength(1);
  });

  it("does not force an immediate wake for agent-authored steering", async () => {
    const { sink, sends } = fakeSink();
    await deliverTaskComment({
      taskId: "RUFU-259",
      comment: { ...comment, author: executor.id, authorType: "agent" },
      recipient: resolveTaskCommentRecipient({ assignedAgentId: planner.id, pool: [planner] }),
      source: "review-address",
      messageSink: sink,
    });
    expect(sends[0].input.metadata?.wakeRecipient).toBeUndefined();
    expect(sends[0].input.type).toBe("agent-to-agent");
  });

  it("surfaces an unrouted comment to the operator instead of dropping it", async () => {
    const { sink, sends } = fakeSink();
    const audit = fakeAudit();
    const log = fakeLog();
    const result = await deliverTaskComment({
      taskId: "RUFU-259",
      comment,
      recipient: resolveTaskCommentRecipient({ pool: [executor, secondExecutor] }),
      source: "dashboard-comment",
      messageSink: sink,
      auditHost: audit.host,
      logSink: log.sink,
    });

    expect(result).toMatchObject({ outcome: "unrouted", via: "none", unroutedReason: "pool-ambiguous" });
    expect(result.noticeMessageId).toBeTruthy();
    // The only message written is the operator notice — nothing was silently sent to a bystander.
    expect(sends).toHaveLength(1);
    expect(sends[0].input).toMatchObject({ toId: "dashboard", toType: "user", fromType: "system" });
    expect(sends[0].input.content).toContain("could not be routed");
    expect(sends[0].key).toBe("task-comment-unowned:RUFU-259:1758-abc");
    expect(audit.events[0]).toMatchObject({ mutationType: "task:comment-delivery-unowned", taskId: "RUFU-259" });
    expect(audit.events[0].metadata).toMatchObject({ outcome: "unrouted", unroutedReason: "pool-ambiguous", poolSize: 2 });
    // The drop must also be visible on the card the operator typed into, not only in their mailbox.
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].id).toBe("RUFU-259");
    expect(log.entries[0].action).toContain("Comment written but not delivered");
    expect(log.entries[0].dedupeKey).toBe("task-comment-undelivered:RUFU-259:1758-abc");
  });

  it("still records an unrouted comment when the mailbox itself is down", async () => {
    const audit = fakeAudit();
    const result = await deliverTaskComment({
      taskId: "RUFU-259",
      comment,
      recipient: resolveTaskCommentRecipient({ pool: [reviewer] }),
      source: "planner-chat",
      messageSink: { async sendMessageOnce() { throw new Error("mailbox unavailable"); } },
      auditHost: audit.host,
    });
    expect(result.outcome).toBe("unrouted");
    expect(result.noticeMessageId).toBeUndefined();
    expect(audit.events[0].metadata).toMatchObject({ outcome: "unrouted", unroutedReason: "pool-empty", noticeDelivered: false });
  });

  it("reports a missing messaging transport instead of claiming delivery", async () => {
    const audit = fakeAudit();
    const log = fakeLog();
    const result = await deliverTaskComment({
      taskId: "RUFU-259",
      comment,
      recipient: toExecutor(),
      source: "dashboard-comment",
      messageSink: null,
      auditHost: audit.host,
      logSink: log.sink,
    });
    expect(result.outcome).toBe("no-message-store");
    expect(result.messageId).toBeUndefined();
    expect(audit.events[0]).toMatchObject({ mutationType: "task:comment-delivery" });
    expect(audit.events[0].metadata).toMatchObject({ outcome: "no-message-store", messageStoreAvailable: false });
    expect(log.entries).toHaveLength(1);
  });

  it("turns a throwing message write into a send-failed outcome rather than a lost comment", async () => {
    const audit = fakeAudit();
    const log = fakeLog();
    const result = await deliverTaskComment({
      taskId: "RUFU-259",
      comment,
      recipient: toExecutor(),
      source: "pr-address",
      messageSink: { async sendMessageOnce() { throw new Error("db down"); } },
      auditHost: audit.host,
      logSink: log.sink,
    });
    expect(result.outcome).toBe("send-failed");
    expect(audit.events[0].metadata).toMatchObject({ outcome: "send-failed" });
    expect(log.entries).toHaveLength(1);
  });

  it("tolerates a store with no audit sink or card log at all", async () => {
    const { sink } = fakeSink();
    const result = await deliverTaskComment({
      taskId: "RUFU-259",
      comment,
      recipient: toExecutor(),
      source: "dashboard-comment",
      messageSink: sink,
    });
    expect(result.outcome).toBe("delivered");
  });
});

describe("renderTaskCommentMessage", () => {
  it("clips an oversized paste and says so inside the delivered body", () => {
    const body = "x".repeat(8_001);
    const rendered = renderTaskCommentMessage({ taskId: "RUFU-259", text: body, author: "user", createdAt: "now" });
    expect(rendered).toContain("body clipped at 8000 of 8001 characters");
    expect(rendered).toContain("Reply on the card itself");
  });
});
