import { describe, expect, it, vi } from "vitest";
import { STORE_RETRY_GUIDANCE } from "../tool-store-errors.js";
import { createAckMessagesTool } from "../agent-tools.js";

/**
 * Stateful fake of the two MessageStore methods `fn_ack_messages` touches.
 *
 * FNXC:HeartbeatMessageAck 2026-11-10-02:58 (RUFU-348):
 * The tool's whole contract is decided by the store's recipient-scoped primitive, so the fake models the
 * primitive's actual decisions — ownership, the archived flag, and the flag flip — instead of counting
 * calls. A call-counting fake cannot tell an ack of my own mail from an ack of a message addressed to a
 * different agent, which is exactly the hazard the surface must refuse.
 */
function createAckHarness(rows: Array<Record<string, unknown>>) {
  const byId = new Map(rows.map((row) => [String(row["id"]), row]));
  const markInboxAsRead = vi.fn(async (ownerId: unknown, ownerType: unknown, messageIds: unknown) => {
    const consumed: string[] = [];
    for (const id of (messageIds as string[]) ?? []) {
      const row = byId.get(id);
      if (!row || row["read"] === true || row["archived"] === true) continue;
      if (row["toId"] !== ownerId || row["toType"] !== ownerType) continue;
      row["read"] = true;
      consumed.push(id);
    }
    return consumed;
  });
  const getMessage = vi.fn(async (id: string) => byId.get(id) ?? null);
  return { messageStore: { markInboxAsRead, getMessage }, markInboxAsRead, byId };
}

function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "msg-1",
    fromId: "agent-ceo",
    fromType: "agent",
    toId: "agent-eng",
    toType: "agent",
    content: "a decision already handled",
    read: false,
    ...overrides,
  };
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

async function ack(tool: ReturnType<typeof createAckMessagesTool>, messageIds: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return tool.execute("call-1", { message_ids: messageIds } as any);
}

/*
FNXC:HeartbeatMessageAck 2026-11-10-02:58 (RUFU-348):
`fn_ack_messages` is the agent-reachable writer of the single `read` flag that stops the heartbeat
pending-message snapshot from re-advertising a handled message. These cases pin the data states the
surface has to answer distinctly: populated unread, already read, an id that is not mine, an archived
row, a missing id, a duplicate inside one call, a rejecting store, and an empty argument list.
*/
describe("createAckMessagesTool", () => {
  it("consumes an unread inbox message addressed to this agent", async () => {
    const rows = [row({ id: "msg-mine" })];
    const { messageStore, byId } = createAckHarness(rows);
    const tool = createAckMessagesTool(messageStore as never, "agent-eng");

    const result = await ack(tool, ["msg-mine"]);

    expect(firstText(result)).toContain("Acknowledged 1");
    expect(result.details).toMatchObject({ acknowledged: 1, acknowledgedIds: ["msg-mine"] });
    // The flag the next tick's `getInbox({ read: false })` snapshot reads is what moved.
    expect(byId.get("msg-mine")?.read).toBe(true);
  });

  it("reports an id addressed to a different agent as refused and leaves it pending", async () => {
    const rows = [row({ id: "msg-theirs", toId: "agent-other" })];
    const { messageStore, byId } = createAckHarness(rows);
    const tool = createAckMessagesTool(messageStore as never, "agent-eng");

    const result = await ack(tool, ["msg-theirs"]);

    expect(firstText(result)).toContain("refused 1");
    expect(result.details).toMatchObject({ acknowledged: 0, refused: 1, refusedIds: ["msg-theirs"] });
    expect(byId.get("msg-theirs")?.read).toBe(false);
  });

  it("refuses a user-addressed row even when the id string matches", async () => {
    const rows = [row({ id: "msg-user", toId: "agent-eng", toType: "user" })];
    const { messageStore, byId } = createAckHarness(rows);
    const tool = createAckMessagesTool(messageStore as never, "agent-eng");

    const result = await ack(tool, ["msg-user"]);

    expect(result.details).toMatchObject({ acknowledged: 0, refused: 1 });
    expect(byId.get("msg-user")?.read).toBe(false);
  });

  it("is idempotent: a repeat reports already handled rather than an error", async () => {
    const rows = [row({ id: "msg-mine", read: true })];
    const { messageStore } = createAckHarness(rows);
    const tool = createAckMessagesTool(messageStore as never, "agent-eng");

    const result = await ack(tool, ["msg-mine"]);

    expect(firstText(result)).toContain("already handled 1");
    expect(result.details).toMatchObject({ acknowledged: 0, alreadyRead: 1, alreadyReadIds: ["msg-mine"] });
    expect(firstText(result)).not.toContain("ERROR");
  });

  it("counts a duplicate inside one call as already handled, not as two consumes", async () => {
    const rows = [row({ id: "msg-mine" })];
    const { messageStore } = createAckHarness(rows);
    const tool = createAckMessagesTool(messageStore as never, "agent-eng");

    const result = await ack(tool, ["msg-mine", "msg-mine"]);

    expect(result.details).toMatchObject({ acknowledged: 1, alreadyRead: 1 });
  });

  it("never consumes an archived row that the inbox no longer advertises", async () => {
    const rows = [row({ id: "msg-archived", archived: true })];
    const { messageStore, byId } = createAckHarness(rows);
    const tool = createAckMessagesTool(messageStore as never, "agent-eng");

    const result = await ack(tool, ["msg-archived"]);

    expect(result.details).toMatchObject({ acknowledged: 0, refused: 1 });
    expect(byId.get("msg-archived")?.read).toBe(false);
  });

  it("refuses an id that no row holds instead of reporting a silent success", async () => {
    const { messageStore } = createAckHarness([]);
    const tool = createAckMessagesTool(messageStore as never, "agent-eng");

    const result = await ack(tool, ["msg-phantom"]);

    expect(result.details).toMatchObject({ acknowledged: 0, refused: 1, refusedIds: ["msg-phantom"] });
  });

  it("answers a rejecting store in the shared store-failure shape without throwing", async () => {
    /*
    FNXC:SharedStoreErrorShape 2026-11-10-03:10 (RUFU-348):
    STAS-258 is not optional for a new tool: a handler that awaited a refused write must flag its result,
    because `AgentLogger` records `tool_error` only when `isError` is set. A plain-text "still pending" here
    would have been logged as a successful call over a board nobody could reach.
    */
    const rows = [row({ id: "msg-mine" })];
    const { messageStore } = createAckHarness(rows);
    messageStore.markInboxAsRead = vi.fn(async () => {
      throw new Error("message store unavailable");
    });
    const tool = createAckMessagesTool(messageStore as never, "agent-eng");

    const result = await ack(tool, ["msg-mine"]);

    expect(firstText(result)).toContain("did not reach the task store");
    expect(firstText(result)).toContain(STORE_RETRY_GUIDANCE);
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      code: "STORE_UNAVAILABLE",
      acknowledged: 0,
      failed: 1,
      failedIds: ["msg-mine"],
    });
  });

  it("keeps a sibling id's consume when one row's write rejects, and still flags the refusal", async () => {
    const rows = [row({ id: "msg-mine" }), row({ id: "msg-mine-2" })];
    const { messageStore } = createAckHarness(rows);
    const original = messageStore.markInboxAsRead;
    messageStore.markInboxAsRead = vi.fn(async (ownerId: unknown, ownerType: unknown, ids: unknown) => {
      if ((ids as string[])[0] === "msg-mine-2") throw new Error("transient store stall");
      return original(ownerId, ownerType, ids);
    });
    const tool = createAckMessagesTool(messageStore as never, "agent-eng");

    const result = await ack(tool, ["msg-mine", "msg-mine-2"]);

    expect(result.details).toMatchObject({ acknowledged: 1, failed: 1, failedIds: ["msg-mine-2"] });
    expect(firstText(result)).toContain("store-failed 1");
    expect(firstText(result)).toContain(STORE_RETRY_GUIDANCE);
    expect(result.isError).toBe(true);
  });

  it("answers an empty or blank id list with an error rather than consuming nothing quietly", async () => {
    const { messageStore } = createAckHarness([]);
    const tool = createAckMessagesTool(messageStore as never, "agent-eng");

    const result = await ack(tool, ["  ", ""]);

    expect(firstText(result)).toContain("ERROR:");
    expect(result.details).toMatchObject({ acknowledged: 0, refused: 0, failed: 0 });
  });

  it("offers no bulk flag, so a call can only consume ids the agent was shown", async () => {
    /*
    FNXC:HeartbeatMessageAck 2026-11-10-02:58 (RUFU-348):
    The engine's own post-run sweep already replaced a blanket `markAllAsRead` with a receipt-scoped
    write after measuring 162 messages swept read that no agent had ever been shown (STAS-300). A bulk
    ack reachable from the tool would reintroduce that over-clear from the agent side, so the schema
    deliberately has no all/boolean knob — only an id list.
    */
    const schema = createAckMessagesTool({} as never, "agent-eng").parameters as unknown as {
      required?: string[];
      properties: Record<string, unknown>;
    };

    expect(Object.keys(schema.properties)).toEqual(["message_ids"]);
    expect(schema.required).toContain("message_ids");
  });
});
