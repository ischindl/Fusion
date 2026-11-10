/*
FNXC:HeartbeatMessageAck 2026-11-10-03:47 (RUFU-348):

THE SYMPTOM THIS FILE EXISTS FOR: one message woke the same Engineer heartbeat lane on four
consecutive ticks. Measured on RUFU-344: `msg-43f50e9`-shaped rows (the CEO decision on RUFU-281)
came back from `fn_read_messages(unread_only=true)` unchanged across four ticks after the first of
those ticks had answered it in-thread, and each re-wake cost a full session.

WHY IT HAPPENED: the pending-message snapshot is rebuilt from unread rows on every tick
(`collectInboxSignal` -> `getInbox({ read: false })`), and "the agent handled this message" was
written nowhere. The engine's only writer of that flag on an agent lane is the post-run scoped
sweep, which stays gated on a SUCCESSFUL run on purpose (a failed tick must get to deliver the
message again — see `heartbeat-executor.test.ts` "does not mark messages as read on failed heartbeat
execution"). So a tick that answered and then failed re-advertised forever.

WHAT IS PINNED HERE, and the two halves that must not be traded against each other:
- Consumption is a WRITE on the same single `read` flag the snapshot reads, reached either by a
  threaded reply or by `fn_ack_messages`. A second lifecycle column would be a second truth for
  every existing reader to reconcile, so there is one flag and two writers.
- At-least-once delivery survives: an UNANSWERED unread row still re-advertises after a failed tick,
  and the engine's own post-run sweep is still never invoked by a failed run. Deduplicating a wake
  must never become message loss, which is why the control case below is mandatory, not optional.

The store fake is stateful on purpose: a fake that only counted calls could not distinguish "the
reply consumed the parent" from "the run consumed it", and that distinction IS this card.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HeartbeatMonitor } from "../agent-heartbeat.js";
import { createBudgetStatus, createMessage } from "./heartbeat-test-helpers.js";
import type { Agent, AgentHeartbeatRun, AgentStore, Message, MessageStore, TaskStore } from "@fusion/core";

vi.mock("../logger.js", async () => {
  const { formatMockError } = await import("./heartbeat-test-helpers.js");
  const quietLogger = () => ({
    log: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });
  return {
    createLogger: vi.fn(() => quietLogger()),
    heartbeatLog: quietLogger(),
    formatError: formatMockError,
  };
});
vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  promptWithFallback: vi.fn(async (session: any, prompt: string) => {
    await session.prompt(prompt);
  }),
}));
vi.mock("../worktree/worktree-acquisition.js", () => ({ acquireTaskWorktree: vi.fn() }));

import { createFnAgent } from "../pi.js";
import { acquireTaskWorktree } from "../worktree/worktree-acquisition.js";

const mockedCreateFnAgent = vi.mocked(createFnAgent);
const mockedAcquireTaskWorktree = vi.mocked(acquireTaskWorktree);

const AGENT_ID = "agent-ack-loop";
const PEER_ID = "agent-ceo";
const TASK_ID = "FN-3480";
const ANSWERED_ID = "msg-43f502e9";
const REPLY_ID = "msg-fc1de5f0";

function decisionMessage(): Message {
  return createMessage({
    id: ANSWERED_ID,
    fromId: PEER_ID,
    fromType: "agent",
    toId: AGENT_ID,
    toType: "agent",
    type: "agent-to-agent",
    content: "CEO decision on RUFU-281: ship the flag behind a setting.",
    createdAt: "2026-11-09T22:12:57.000Z",
  });
}

function baseAgent(): Agent {
  return {
    id: AGENT_ID,
    name: "Ack Loop Engineer",
    role: "executor",
    state: "active",
    taskId: TASK_ID,
    soul: "Close the loop on coordination mail without re-reporting decided questions.",
    createdAt: "2026-11-09T00:00:00.000Z",
    updatedAt: "2026-11-09T00:00:00.000Z",
    metadata: {},
  } as Agent;
}

/**
 * A message store whose `read` flag actually moves, scoped the way the real one is scoped: a row is
 * visible to, and consumable by, the participant it is addressed to and nobody else.
 */
function createStatefulInbox(seed: Message[]) {
  const rows: Message[] = seed.map((row) => ({ ...row }));
  let replySequence = 0;
  const addressedTo = (ownerId: string, ownerType: string) =>
    rows.filter((row) => row.toId === ownerId && row.toType === ownerType);
  const unreadTo = (ownerId: string, ownerType: string) => addressedTo(ownerId, ownerType).filter((row) => !row.read);

  const store = {
    setMessageToAgentHook: vi.fn(),
    getInbox: vi.fn(async (ownerId: string, ownerType: string, filter?: { read?: boolean; limit?: number }) => {
      const visible = filter?.read === false ? unreadTo(ownerId, ownerType) : addressedTo(ownerId, ownerType);
      return typeof filter?.limit === "number" ? visible.slice(0, filter.limit) : visible;
    }),
    getMailbox: vi.fn(async (ownerId: string, ownerType: string) => ({
      ownerId,
      ownerType,
      unreadCount: unreadTo(ownerId, ownerType).length,
      messages: addressedTo(ownerId, ownerType),
    })),
    getMessage: vi.fn(async (messageId: string) => rows.find((row) => row.id === messageId) ?? null),
    sendMessage: vi.fn(async (input: Omit<Message, "id" | "createdAt" | "updatedAt" | "read">) => {
      replySequence += 1;
      const now = new Date(`2026-11-09T22:20:0${replySequence}.000Z`).toISOString();
      const row: Message = {
        ...input,
        id: replySequence === 1 ? REPLY_ID : `msg-reply-${replySequence}`,
        read: false,
        createdAt: now,
        updatedAt: now,
      };
      rows.push(row);
      return row;
    }),
    markInboxAsRead: vi.fn(async (ownerId: string, ownerType: string, messageIds: string[]) => {
      const consumed: string[] = [];
      for (const row of unreadTo(ownerId, ownerType)) {
        if (messageIds.includes(row.id)) {
          row.read = true;
          consumed.push(row.id);
        }
      }
      return consumed;
    }),
    // The blanket sweep is the engine's own post-run behaviour; a stateful fake still has to answer
    // it so a test that proves it was NOT reached is proving the call list, not a missing method.
    markAllAsRead: vi.fn(async (ownerId: string, ownerType: string) => {
      const unread = unreadTo(ownerId, ownerType);
      unread.forEach((row) => {
        row.read = true;
      });
      return unread.length;
    }),
  };
  return store as unknown as MessageStore & {
    getInbox: ReturnType<typeof vi.fn>;
    getMailbox: ReturnType<typeof vi.fn>;
    getMessage: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    markInboxAsRead: ReturnType<typeof vi.fn>;
    markAllAsRead: ReturnType<typeof vi.fn>;
  };
}

interface Harness {
  monitor: HeartbeatMonitor;
  messageStore: ReturnType<typeof createStatefulInbox>;
  /** Drives one heartbeat tick, optionally touching mail mid-turn and optionally dying afterwards. */
  tick: (options?: { consume?: "reply" | "ack" | "read"; fail?: boolean }) => Promise<{ status: string; prompt: string }>;
}

function createHarness(seed: Message[]): Harness {
  const prompts: string[] = [];
  let lastPromptCount = 0;
  const agent = baseAgent();
  const messageStore = createStatefulInbox(seed);
  const session = {
    prompt: vi.fn(),
    abort: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(),
    model: { provider: "mock", id: "mock-model" },
  };
  const offeredTools = new Map<string, { execute?: (id: string, params: never) => Promise<unknown> }>();
  mockedCreateFnAgent.mockImplementation(async (options: { customTools?: Array<{ name: string; execute?: (id: string, params: never) => Promise<unknown> }> }) => {
    offeredTools.clear();
    for (const tool of options.customTools ?? []) offeredTools.set(tool.name, tool);
    return { session: session as never } as never;
  });
  const invokeTool = async (name: string, params: Record<string, unknown>) => {
    const tool = offeredTools.get(name);
    if (!tool?.execute) throw new Error(`harness: the session was never offered ${name}`);
    return tool.execute("tool-call", params as never);
  };

  /*
  The run rows have to be stateful for the same reason the inbox rows do: `completeRun` reads the run
  back through `getRunDetail` and refuses to overwrite a row that already looks terminal. A fake that
  answers "completed" before any run has closed therefore silently erases every status write, and the
  failed tick this repro depends on would report itself as a clean run — the test would then be
  asserting nothing. Mirrors the savedRuns shape `heartbeat-executor.test.ts` uses for the same reason.
  */
  const savedRuns = new Map<string, AgentHeartbeatRun>();
  let runSequence = 0;

  const store = {
    getAgent: vi.fn(async (agentId: string) =>
      agentId === AGENT_ID ? agent : ({ id: agentId, name: agentId, role: "executor", state: "active" } as Agent),
    ),
    getCachedAgent: vi.fn().mockReturnValue(null),
    assignTask: vi.fn().mockResolvedValue(agent),
    claimTaskForAgent: vi.fn().mockResolvedValue({ ok: false, reason: "task_not_found" }),
    handoffTaskToWorkflowExecutor: vi.fn().mockResolvedValue({ ok: true, task: { id: TASK_ID } }),
    startHeartbeatRun: vi.fn(async (_agentId: string, initialMetadata: Record<string, unknown> = {}) => {
      runSequence += 1;
      const run = {
        id: `run-ack-loop-${runSequence}`,
        agentId: AGENT_ID,
        startedAt: "2026-11-09T22:15:00.000Z",
        endedAt: null,
        status: "active",
        ...initialMetadata,
      } as AgentHeartbeatRun;
      savedRuns.set(run.id, run);
      return run;
    }),
    saveRun: vi.fn(async (run: AgentHeartbeatRun) => {
      savedRuns.set(run.id, run);
    }),
    endHeartbeatRun: vi.fn(async (runId: string) => {
      const existing = savedRuns.get(runId);
      if (existing) savedRuns.set(runId, { ...existing, endedAt: "2026-11-09T22:16:00.000Z" });
    }),
    getRunDetail: vi.fn(async (_agentId: string, runId: string) => savedRuns.get(runId) ?? null),
    getActiveHeartbeatRun: vi.fn().mockResolvedValue(null),
    getRecentRuns: vi.fn().mockResolvedValue([]),
    getCompletedHeartbeatRuns: vi.fn().mockResolvedValue([]),
    getBudgetStatus: vi.fn().mockResolvedValue(createBudgetStatus({ agentId: AGENT_ID })),
    getLastBlockedState: vi.fn().mockResolvedValue(null),
    setLastBlockedState: vi.fn().mockResolvedValue(undefined),
    clearLastBlockedState: vi.fn().mockResolvedValue(undefined),
    appendRunLog: vi.fn().mockResolvedValue(undefined),
    getRatingSummary: vi.fn().mockResolvedValue(undefined),
    recordHeartbeat: vi.fn().mockResolvedValue(undefined),
    updateAgent: vi.fn().mockResolvedValue(agent),
    updateAgentState: vi.fn().mockResolvedValue(undefined),
    syncExecutionTaskLink: vi.fn().mockResolvedValue(undefined),
    getAgentsByReportsTo: vi.fn().mockResolvedValue([]),
  } as unknown as AgentStore;

  const taskStore = {
    getTask: vi.fn().mockResolvedValue({
      id: TASK_ID,
      title: "Answer the CEO decision",
      description: "body",
      prompt: "# PROMPT\ncontent",
      steps: [],
      column: "in-progress",
      worktree: "/tmp/wt-3480",
      branch: `fusion/${TASK_ID.toLowerCase()}`,
      dependencies: [],
      log: [],
      attachments: [],
      comments: [],
      steeringComments: [],
      createdAt: "2026-11-09T00:00:00.000Z",
      updatedAt: "2026-11-09T00:00:00.000Z",
    }),
    getSettings: vi.fn().mockResolvedValue({}),
    listTasks: vi.fn().mockResolvedValue([]),
    getTasksByAssignedAgent: vi.fn().mockResolvedValue([{ id: TASK_ID, column: "in-progress", assignedAgentId: AGENT_ID }]),
    selectNextTaskForAgent: vi.fn().mockResolvedValue(null),
    logEntry: vi.fn().mockResolvedValue(undefined),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
    addComment: vi.fn().mockResolvedValue({}),
    getMissionStore: vi.fn().mockReturnValue(null),
    findRecentTasksBySourceParentTaskId: vi.fn().mockResolvedValue([]),
    createTask: vi.fn().mockResolvedValue({ id: "FN-3481", description: "x", dependencies: [], column: "triage" }),
    upsertTaskDocument: vi.fn().mockResolvedValue({}),
    getTaskDocument: vi.fn().mockResolvedValue(null),
    listTaskDocuments: vi.fn().mockResolvedValue([]),
  } as unknown as TaskStore;

  const chatStore = {
    listRoomsForAgent: vi.fn().mockResolvedValue([]),
    listRoomMessagesSince: vi.fn().mockResolvedValue([]),
    listRoomMembers: vi.fn().mockResolvedValue([]),
  };

  const monitor = new HeartbeatMonitor({
    store,
    messageStore,
    taskStore,
    chatStore: chatStore as never,
    rootDir: "/tmp",
  });

  const tick: Harness["tick"] = async (options = {}) => {
    lastPromptCount = prompts.length;
    session.prompt.mockImplementation(async (prompt: string) => {
      prompts.push(prompt);
      if (options.consume === "reply") {
        // The real tool the lane was offered, not a hand-built stand-in: a reply is only a
        // consumption path if the tool the agent actually holds writes the flag.
        await invokeTool("fn_send_message", {
          content: "Understood, shipping it behind the setting.",
          reply_to_message_id: ANSWERED_ID,
        });
      } else if (options.consume === "ack") {
        await invokeTool("fn_ack_messages", { message_ids: [ANSWERED_ID] });
      } else if (options.consume === "read") {
        await invokeTool("fn_read_messages", { unread_only: true });
      }
      if (options.fail) {
        throw new Error("session died after the turn's work landed");
      }
    });

    const result = await monitor.executeHeartbeat({
      agentId: AGENT_ID,
      source: "on_demand",
      triggerDetail: "wake-on-message",
      wakeMessage: {
        messageId: ANSWERED_ID,
        fromType: "agent",
        fromId: PEER_ID,
        forced: false,
        createdAt: "2026-11-09T22:12:57.000Z",
      },
    });

    /*
    Only what THIS tick put on the wire. `prompts` accumulates across the harness's lifetime, so
    returning the whole log would make tick 2 assert against tick 1's advertisement and report a
    re-advertisement that never happened — the opposite of what this file is measuring.
    */
    return { status: result.status, prompt: prompts.slice(lastPromptCount).join("\n") };
  };

  return {
    monitor,
    messageStore,
    tick,
    diagnostics: () => ({
      promptCount: prompts.length,
      createCalls: mockedCreateFnAgent.mock.calls.length,
      inboxCalls: messageStore.getInbox.mock.calls.length,
      saveRun: store.saveRun.mock.calls.length,
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedAcquireTaskWorktree.mockResolvedValue({
    worktreePath: "/tmp/wt-3480",
    branch: `fusion/${TASK_ID.toLowerCase()}`,
    source: "existing",
    hydrated: false,
    isResume: true,
  } as never);
});

describe("RUFU-348 symptom: an answered message must not re-wake the next tick", () => {
  it("re-advertises the decision on the tick that received it (the precondition of the repro)", async () => {
    const h = createHarness([decisionMessage()]);

    const first = await h.tick({ fail: true });

    expect(first.status, `tick diagnostics: ${JSON.stringify(h.diagnostics())}`).toBe("failed");
  });

  it("a threaded reply consumed the decision, so the next tick's wake list is empty", async () => {
    const h = createHarness([decisionMessage()]);

    const first = await h.tick({ consume: "reply", fail: true });
    expect(first.status).toBe("failed");
    expect(first.prompt).toContain(ANSWERED_ID);
    // The reply path is the writer here, and it is exactly one scoped write — the engine's own
    // post-run sweep never ran, because this run failed.
    expect(h.messageStore.markInboxAsRead).toHaveBeenCalledTimes(1);
    expect(h.messageStore.markInboxAsRead).toHaveBeenCalledWith(AGENT_ID, "agent", [ANSWERED_ID]);
    expect(h.messageStore.markAllAsRead).not.toHaveBeenCalled();

    const second = await h.tick();

    expect(second.status).toBe("completed");
    expect(second.prompt).not.toContain("Pending Messages:");
    expect(second.prompt).not.toContain(ANSWERED_ID);
    expect(second.prompt).toContain("- pending messages: 0");
    expect(second.prompt).toContain("- inbox snapshot: empty (already consumed)");
    // The reply the agent sent is the peer's mail, not a new unread row for the sender.
    expect(h.messageStore.getInbox).toHaveBeenLastCalledWith(AGENT_ID, "agent", { read: false, limit: 10 });
  });

  it("fn_ack_messages ends the wake with no reply owed", async () => {
    const h = createHarness([decisionMessage()]);

    const first = await h.tick({ consume: "ack", fail: true });
    expect(first.status).toBe("failed");
    expect(first.prompt).toContain(ANSWERED_ID);
    expect(h.messageStore.markInboxAsRead).toHaveBeenCalledWith(AGENT_ID, "agent", [ANSWERED_ID]);

    const second = await h.tick();

    expect(second.status).toBe("completed");
    expect(second.prompt).not.toContain("Pending Messages:");
    expect(second.prompt).not.toContain(ANSWERED_ID);
    expect(second.prompt).toContain("- pending messages: 0");
  });

  /*
  FNXC:HeartbeatMessageAck 2026-11-10-03:47 (RUFU-348):
  The anti-message-loss control. Dedupe that eats mail is worse than the loop it removes, so this
  case is the reason the fix is a WRITE on consumption rather than a suppression of the read: a tick
  that failed having done nothing still gets the row delivered, and the engine's post-run sweep is
  still never reached by a failed run.
  */
  it("an unanswered decision still re-advertises after a failed tick (at-least-once delivery)", async () => {
    const h = createHarness([decisionMessage()]);

    const first = await h.tick({ fail: true });
    expect(first.status).toBe("failed");
    expect(h.messageStore.markInboxAsRead).not.toHaveBeenCalled();

    const second = await h.tick({ fail: true });

    expect(second.status).toBe("failed");
    expect(second.prompt).toContain("Pending Messages:");
    expect(second.prompt).toContain(ANSWERED_ID);
    expect(second.prompt).toContain("- pending messages: 1");
  });

  it("a read is not a consumption: the same id re-advertises after a tick that only looked at it", async () => {
    const h = createHarness([decisionMessage()]);

    const first = await h.tick({ consume: "read", fail: true });

    expect(first.status).toBe("failed");
    expect(first.prompt).toContain(ANSWERED_ID);
    // Reading must not consume, or a failed tick could never get the message delivered again.
    expect(h.messageStore.markInboxAsRead).not.toHaveBeenCalled();

    const second = await h.tick({ fail: true });
    expect(second.prompt).toContain("Pending Messages:");
    expect(second.prompt).toContain(ANSWERED_ID);
  });
});
