import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createSendMessageTool } from "../agent-tools.js";

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

function createMessageStoreHarness(parent?: Record<string, unknown> | null) {
  const wakeSpy = vi.fn();
  const getMessage = vi.fn(async () => parent ?? null);
  const sendMessage = vi.fn(async (input: Record<string, unknown>) => {
    if (input.toType === "agent") {
      await wakeSpy(input);
    }
    return { id: "msg-1" };
  });
  /*
  FNXC:HeartbeatMessageAck 2026-11-10-02:46 (RUFU-348):
  The reply path now consumes the parent through the store's own recipient-scoped primitive, so the
  harness models the two things that primitive decides: whether the named row is this recipient's
  unread row, and the flipped flag itself. A harness that only counted calls could not tell an ack of
  my own mail from an ack of somebody else's.
  */
  const markInboxAsRead = vi.fn(async (ownerId: unknown, ownerType: unknown, messageIds: unknown) => {
    const ids = (messageIds as string[]) ?? [];
    if (!parent) return [];
    return ids.filter((id) => {
      const owned = parent["id"] === id && parent["toId"] === ownerId && parent["toType"] === ownerType;
      if (!owned || parent["read"] === true) return false;
      parent["read"] = true;
      return true;
    });
  });
  return { messageStore: { getMessage, sendMessage, markInboxAsRead }, getMessage, sendMessage, wakeSpy, markInboxAsRead };
}

/** Same harness with a store whose acknowledgement write rejects, for the best-effort contract. */
function createRejectingAckHarness(parent: Record<string, unknown>) {
  const harness = createMessageStoreHarness(parent);
  harness.markInboxAsRead.mockRejectedValue(new Error("message store unavailable"));
  return harness;
}

async function executeSend(
  tool: ReturnType<typeof createSendMessageTool>,
  params: Record<string, unknown>,
) {
  return tool.execute("1", params as never, undefined, undefined, {});
}

/*
FNXC:HeartbeatMessageAck 2026-11-10-02:46 (RUFU-348):
A reply in the thread of a message addressed to this agent is the acknowledgement the heartbeat wake
loop was missing, so these cases pin the four outcomes that decision has: my own parent is consumed,
someone else's parent never is, a store that refuses the write cannot undo the delivered reply, and
repeating the ack is a no-op that still reports success.
*/
describe("createSendMessageTool reply-time acknowledgement", () => {
  it("consumes a parent that was addressed to this agent", async () => {
    const parent = {
      id: "msg-parent-mine",
      fromId: "agent-c",
      fromType: "agent",
      toId: "agent-a",
      toType: "agent",
      content: "a decision I must not re-report",
      read: false,
    };
    const { messageStore, markInboxAsRead, sendMessage } = createMessageStoreHarness(parent);
    const tool = createSendMessageTool(messageStore as never, "agent-a");

    const result = await executeSend(tool, { content: "acknowledged", reply_to_message_id: "msg-parent-mine" });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(markInboxAsRead).toHaveBeenCalledWith("agent-a", "agent", ["msg-parent-mine"]);
    expect(firstText(result as never)).toContain("Message sent to agent-c");
    expect(firstText(result as never)).toContain("msg-parent-mine acknowledged as handled");
    // The row's own flag moved, which is what the next tick's unread snapshot reads.
    expect(parent.read).toBe(true);
    expect((result.details as Record<string, unknown>).parentAcknowledgement).toBe("acknowledged");
  });

  it("never consumes a parent addressed to a third party", async () => {
    const foreignParent = {
      id: "msg-parent-foreign",
      fromId: "agent-c",
      fromType: "agent",
      toId: "agent-b",
      toType: "agent",
      content: "not my mail",
      read: false,
    };
    const { messageStore, markInboxAsRead, sendMessage } = createMessageStoreHarness(foreignParent);
    const tool = createSendMessageTool(messageStore as never, "agent-a");

    // An explicit recipient makes this an intentional forward over a foreign thread, which is legal.
    const result = await executeSend(tool, { content: "forwarding", reply_to_message_id: "msg-parent-foreign", to_id: "agent-c" });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(markInboxAsRead).not.toHaveBeenCalled();
    expect(foreignParent.read).toBe(false);
    expect(firstText(result as never)).not.toContain("acknowledged as handled");
  });

  it("keeps the delivered reply and reports the failure when the acknowledgement store rejects", async () => {
    const parent = {
      id: "msg-parent-hostile",
      fromId: "agent-c",
      fromType: "agent",
      toId: "agent-a",
      toType: "agent",
      content: "decision",
      read: false,
    };
    const harness = createRejectingAckHarness(parent);
    const tool = createSendMessageTool(harness.messageStore as never, "agent-a");

    const result = await executeSend(tool, { content: "acknowledged", reply_to_message_id: "msg-parent-hostile" });

    // The reply is durable: a failed ack must never fail or duplicate the send.
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
    expect(firstText(result as never)).toContain("Message sent to agent-c");
    expect(firstText(result as never)).toContain("could NOT be acknowledged as handled");
    expect((result.details as Record<string, unknown>).parentAcknowledgement).toBe("failed");
  });

  it("treats acking an already-consumed parent as a successful no-op", async () => {
    const parent = {
      id: "msg-parent-read",
      fromId: "agent-c",
      fromType: "agent",
      toId: "agent-a",
      toType: "agent",
      content: "decision",
      read: true,
    };
    const { messageStore, markInboxAsRead, sendMessage } = createMessageStoreHarness(parent);
    const tool = createSendMessageTool(messageStore as never, "agent-a");

    const result = await executeSend(tool, { content: "acknowledged again", reply_to_message_id: "msg-parent-read" });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(markInboxAsRead).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
    expect(firstText(result as never)).toContain("Message sent to agent-c");
    expect(firstText(result as never)).toContain("already acknowledged");
    expect((result.details as Record<string, unknown>).parentAcknowledgement).toBe("alreadyRead");
  });
});

describe("createSendMessageTool recipient validation", () => {
  it("rejects a missing agent before persistence or wake", async () => {
    const { messageStore, sendMessage, wakeSpy } = createMessageStoreHarness();
    const agentStore = { getAgent: vi.fn().mockResolvedValue(null) };
    const tool = createSendMessageTool(messageStore as never, "agent-a", { agentStore: agentStore as never });

    const result = await executeSend(tool, { to_id: "agent-does-not-exist", content: "hello", type: "agent-to-agent" });

    expect(firstText(result as never)).toMatch(/^ERROR: Recipient agent 'agent-does-not-exist' does not exist/);
    expect(agentStore.getAgent).toHaveBeenCalledWith("agent-does-not-exist");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(wakeSpy).not.toHaveBeenCalled();
  });

  it("uses async getAgent and still sends and wakes an existing recipient", async () => {
    const { messageStore, sendMessage, wakeSpy } = createMessageStoreHarness();
    // Mimics PostgreSQL mode: only async getAgent is available; there is no sync cache.
    const agentStore = { getAgent: vi.fn().mockResolvedValue({ id: "agent-b" }) };
    const tool = createSendMessageTool(messageStore as never, "agent-a", { agentStore: agentStore as never });

    const result = await executeSend(tool, { to_id: "agent-b", content: "hello" });

    expect(firstText(result as never)).toContain("Message sent to agent-b");
    expect(agentStore.getAgent).toHaveBeenCalledWith("agent-b");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(wakeSpy).toHaveBeenCalledTimes(1);
  });

  it("does not resolve user recipients and preserves no-resolver behavior", async () => {
    const userHarness = createMessageStoreHarness();
    const agentStore = { getAgent: vi.fn() };
    const userTool = createSendMessageTool(userHarness.messageStore as never, "agent-a", { agentStore: agentStore as never });

    const userResult = await executeSend(userTool, { to_id: "dashboard-user", content: "hello", type: "agent-to-user" });

    expect(firstText(userResult as never)).toContain("Message sent to dashboard-user");
    expect(agentStore.getAgent).not.toHaveBeenCalled();
    expect(userHarness.sendMessage).toHaveBeenCalledTimes(1);

    const legacyHarness = createMessageStoreHarness();
    const legacyTool = createSendMessageTool(legacyHarness.messageStore as never, "agent-a");
    const legacyResult = await executeSend(legacyTool, { to_id: "unknown-agent", content: "hello" });
    expect(firstText(legacyResult as never)).toContain("Message sent to unknown-agent");
    expect(legacyHarness.sendMessage).toHaveBeenCalledTimes(1);

    expect(firstText(await executeSend(legacyTool, { to_id: "agent-b", content: " " }) as never)).toBe("ERROR: Message content cannot be empty");
    expect(firstText(await executeSend(legacyTool, { to_id: "agent-b", content: "hello", reply_to_message_id: " " }) as never)).toBe("ERROR: reply_to_message_id must be a non-empty string");
  });

  it("routes an owned CLI parent reply to the CLI user mailbox", async () => {
    const parent = {
      id: "parent-cli",
      fromId: "cli",
      fromType: "user",
      toId: "agent-a",
      toType: "agent",
    };
    const { messageStore, sendMessage } = createMessageStoreHarness(parent);
    const tool = createSendMessageTool(messageStore as never, "agent-a");

    // Heartbeat guidance intentionally names the sender explicitly; it must still
    // preserve the parent user's type rather than treating `cli` as an agent.
    const result = await executeSend(tool, { content: "received", reply_to_message_id: "parent-cli", to_id: "cli" });

    expect(firstText(result as never)).toContain("Message sent to cli");
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      toId: "cli",
      toType: "user",
      type: "agent-to-user",
      metadata: { replyTo: { messageId: "parent-cli" } },
    }));
  });

  it("routes an owned dashboard parent reply to the dashboard mailbox", async () => {
    const parent = {
      id: "parent-dashboard",
      fromId: "dashboard",
      fromType: "user",
      toId: "agent-a",
      toType: "agent",
    };
    const { messageStore, sendMessage } = createMessageStoreHarness(parent);
    const tool = createSendMessageTool(messageStore as never, "agent-a");

    await executeSend(tool, { content: "received", reply_to_message_id: "parent-dashboard" });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      toId: "dashboard",
      toType: "user",
      type: "agent-to-user",
    }));
  });

  it("allows an explicit alternate recipient without inheriting a foreign parent", async () => {
    const foreignParent = {
      id: "parent-foreign",
      fromId: "cli",
      fromType: "user",
      toId: "agent-b",
      toType: "agent",
    };
    const { messageStore, sendMessage } = createMessageStoreHarness(foreignParent);
    const tool = createSendMessageTool(messageStore as never, "agent-a");

    await executeSend(tool, { content: "forward", reply_to_message_id: "parent-foreign", to_id: "agent-c" });

    // A different explicit ID is a forward: without type it keeps the legacy
    // agent-to-agent default instead of inheriting the foreign parent's user type.
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ toId: "agent-c", toType: "agent", type: "agent-to-agent" }));
  });

  it("rejects foreign or missing parents when no explicit recipient is supplied", async () => {
    const foreignParent = {
      id: "parent-foreign",
      fromId: "cli",
      fromType: "user",
      toId: "agent-b",
      toType: "agent",
    };
    const foreignHarness = createMessageStoreHarness(foreignParent);
    const foreignTool = createSendMessageTool(foreignHarness.messageStore as never, "agent-a");
    const missingHarness = createMessageStoreHarness();
    const missingTool = createSendMessageTool(missingHarness.messageStore as never, "agent-a");

    expect(firstText(await executeSend(foreignTool, { content: "nope", reply_to_message_id: "parent-foreign" }) as never)).toMatch(/^ERROR: reply_to_message_id/);
    expect(foreignHarness.sendMessage).not.toHaveBeenCalled();
    expect(firstText(await executeSend(missingTool, { content: "nope", reply_to_message_id: "missing" }) as never)).toMatch(/^ERROR: reply_to_message_id/);
    expect(missingHarness.sendMessage).not.toHaveBeenCalled();
  });

  it("does not report delivery when recipient validation is unavailable", async () => {
    const failedLookupHarness = createMessageStoreHarness();
    const failedLookupTool = createSendMessageTool(failedLookupHarness.messageStore as never, "agent-a", {
      agentStore: { getAgent: vi.fn().mockRejectedValue(new Error("database unavailable")) } as never,
    });

    const result = await executeSend(failedLookupTool, { to_id: "agent-b", content: "hello" });
    expect(firstText(result as never)).toMatch(/^ERROR: Recipient agent 'agent-b' could not be validated/);
    expect(failedLookupHarness.sendMessage).not.toHaveBeenCalled();
    expect(failedLookupHarness.wakeSpy).not.toHaveBeenCalled();
  });

  it("rejects an undefined recipient lookup result", async () => {
    const { messageStore, sendMessage, wakeSpy } = createMessageStoreHarness();
    const tool = createSendMessageTool(messageStore as never, "agent-a", {
      agentStore: { getAgent: vi.fn().mockResolvedValue(undefined) } as never,
    });

    const result = await executeSend(tool, { to_id: "agent-does-not-exist", content: "hello" });
    expect(firstText(result as never)).toMatch(/^ERROR: Recipient agent 'agent-does-not-exist' does not exist/);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(wakeSpy).not.toHaveBeenCalled();
  });
});

describe("send-message registration wiring", () => {
  it("forwards the in-scope AgentStore at every engine registration", async () => {
    const [executor, stepSessionExecutor, heartbeat] = await Promise.all([
      /*
      FNXC:AgentTools 2026-08-23-18:30: U4 peeled the implementation session out of `executor.ts`
      into `executor/run-implementation.ts` (deps bag: `deps.options` / `deps.store`), so the
      executor-side registration to pin now lives there. The invariant is unchanged — every engine
      registration forwards the in-scope AgentStore so recipient validation is never skipped.
      */
      readFile(fileURLToPath(new URL("../executor/run-implementation.ts", import.meta.url)), "utf8"),
      readFile(fileURLToPath(new URL("../execution/step-session-executor.ts", import.meta.url)), "utf8"),
      readFile(fileURLToPath(new URL("../agent-heartbeat.ts", import.meta.url)), "utf8"),
    ]);

    expect(executor).toContain("createSendMessageTool(deps.options.messageStore, assignedAgentId, { autoRecovery: settings.autoRecovery, runAudit: audit, taskStore: deps.store, settings, agentStore: deps.options.agentStore })");
    expect(stepSessionExecutor).toContain("createSendMessageTool(this.options.messageStore, taskDetail.assignedAgentId, { autoRecovery: settings.autoRecovery, taskStore: this.options.store!, settings, agentStore: this.options.agentStore })");
    expect(heartbeat.match(/createSendMessageTool\(this\.messageStore, agentId, \{ agentStore: this\.store \}\)/g)).toHaveLength(1);
    expect(heartbeat.match(/createSendMessageTool\(messageStore, agentId, \{ agentStore: this\.store \}\)/g)).toHaveLength(1);
  });
});
