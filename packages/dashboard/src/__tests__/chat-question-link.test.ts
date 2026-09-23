// @vitest-environment node

/*
FNXC:ChatQuestionAnswerLink 2026-09-23-13:59:
RUFU-258 server-side tail detection + metadata merge. These are the pure halves of the durable
question-answer link; the `ChatManager.sendMessage` stamping half lives in
`chat-manager.test.ts` (that file owns the ChatManager store-fake harness).
*/

import { describe, expect, it } from "vitest";
import {
  findAwaitingQuestionMessageId,
  QUESTION_ANSWER_METADATA_KEY,
  QUESTION_ANSWER_TAIL_LIMIT,
  readQuestionAnswerLink,
  withQuestionAnswerLink,
} from "../shared/chat-question-link.js";

function row(id: string, role: "user" | "assistant", metadata?: Record<string, unknown> | null) {
  return {
    id,
    sessionId: "chat-1",
    role,
    content: role === "user" ? "an answer" : "a reply",
    createdAt: `2026-09-23T00:00:0${id.slice(-1)}.000Z`,
    metadata: metadata ?? null,
  } as never;
}

function questionRow(id: string, toolCall: Record<string, unknown> = {
  toolName: "fn_ask_question",
  args: { questions: [{ id: "q1", type: "text", question: "Which branch?" }] },
  isError: false,
  status: "completed",
}) {
  return row(id, "assistant", { toolCalls: [toolCall] });
}

describe("findAwaitingQuestionMessageId", () => {
  it("returns the assistant row id when the tail ends on an awaiting question", () => {
    expect(findAwaitingQuestionMessageId([row("u-1", "user"), questionRow("a-9")])).toBe("a-9");
  });

  it("resolves every question tool name through the shared isQuestionToolName list", () => {
    for (const toolName of ["fn_ask_question", "AskUserQuestion", "ask_followup_question", "elicit"]) {
      expect(findAwaitingQuestionMessageId([questionRow("a-2", { toolName, isError: false, status: "completed" })])).toBe("a-2");
    }
  });

  it("returns null when the newest row's last tool call is not a question tool", () => {
    const tail = [questionRow("a-1"), row("u-2", "user"), row("a-3", "assistant", {
      toolCalls: [{ toolName: "bash", isError: false, status: "completed" }],
    })];
    expect(findAwaitingQuestionMessageId(tail)).toBeNull();
  });

  it("returns null when the newest row is a user message", () => {
    expect(findAwaitingQuestionMessageId([questionRow("a-1"), row("u-2", "user")])).toBeNull();
  });

  it("returns null when the question tool call errored or failed", () => {
    expect(findAwaitingQuestionMessageId([questionRow("a-1", {
      toolName: "fn_ask_question",
      isError: true,
      status: "completed",
    })])).toBeNull();
    expect(findAwaitingQuestionMessageId([questionRow("a-2", {
      toolName: "fn_ask_question",
      isError: false,
      status: "failed",
    })])).toBeNull();
  });

  it("returns null for an empty transcript, a null-metadata row, or non-array tool calls", () => {
    expect(findAwaitingQuestionMessageId([])).toBeNull();
    expect(findAwaitingQuestionMessageId([row("a-1", "assistant", null)])).toBeNull();
    expect(findAwaitingQuestionMessageId([row("a-2", "assistant", { toolCalls: "nope" })])).toBeNull();
    expect(findAwaitingQuestionMessageId([row("a-3", "assistant", { toolCalls: ["nope"] })])).toBeNull();
  });

  it("ignores an earlier question row — only the newest turn can be awaiting", () => {
    const tail = [questionRow("a-1"), row("u-2", "user"), row("a-3", "assistant", { text: "no tools" })];
    expect(findAwaitingQuestionMessageId(tail)).toBeNull();
  });

  it("reports the row id once for several question calls in the same row", () => {
    const multi = row("a-4", "assistant", {
      toolCalls: [
        { toolName: "bash", isError: false, status: "completed" },
        { toolName: "fn_ask_question", args: { questions: [{ id: "q1", type: "text", question: "A?" }] }, isError: false, status: "completed" },
        { toolName: "ask_user", args: { questions: [{ id: "q2", type: "text", question: "B?" }] }, isError: false, status: "completed" },
      ],
    });
    expect(findAwaitingQuestionMessageId([multi])).toBe("a-4");
  });
});

describe("readQuestionAnswerLink", () => {
  it("reads a well-formed link", () => {
    expect(readQuestionAnswerLink({ [QUESTION_ANSWER_METADATA_KEY]: { questionMessageId: "a-1" } })).toBe("a-1");
  });

  it("treats malformed payloads as no link", () => {
    expect(readQuestionAnswerLink(null)).toBeNull();
    expect(readQuestionAnswerLink(undefined)).toBeNull();
    expect(readQuestionAnswerLink({})).toBeNull();
    expect(readQuestionAnswerLink({ [QUESTION_ANSWER_METADATA_KEY]: "a-1" })).toBeNull();
    expect(readQuestionAnswerLink({ [QUESTION_ANSWER_METADATA_KEY]: ["a-1"] })).toBeNull();
    expect(readQuestionAnswerLink({ [QUESTION_ANSWER_METADATA_KEY]: {} })).toBeNull();
    expect(readQuestionAnswerLink({ [QUESTION_ANSWER_METADATA_KEY]: { questionMessageId: 42 } })).toBeNull();
    expect(readQuestionAnswerLink({ [QUESTION_ANSWER_METADATA_KEY]: { questionMessageId: "   " } })).toBeNull();
  });
});

describe("withQuestionAnswerLink", () => {
  it("stamps the documented metadata shape", () => {
    expect(withQuestionAnswerLink(undefined, "a-1")).toEqual({ [QUESTION_ANSWER_METADATA_KEY]: { questionMessageId: "a-1" } });
  });

  it("preserves every coexisting metadata key", () => {
    const merged = withQuestionAnswerLink({ mentions: [{ id: "agent-1" }], autoRetry: false, interrupted: false }, "a-7");
    expect(merged.mentions).toEqual([{ id: "agent-1" }]);
    expect(merged.autoRetry).toBe(false);
    expect(merged.interrupted).toBe(false);
    expect(merged[QUESTION_ANSWER_METADATA_KEY]).toEqual({ questionMessageId: "a-7" });
  });

  it("does not mutate the source metadata object", () => {
    const source: Record<string, unknown> = { mentions: [] };
    const merged = withQuestionAnswerLink(source, "a-1");
    expect(merged).not.toBe(source);
    expect(QUESTION_ANSWER_METADATA_KEY in source).toBe(false);
  });

  it("keeps the bounded tail limit small enough for the send path", () => {
    expect(QUESTION_ANSWER_TAIL_LIMIT).toBeLessThanOrEqual(10);
    expect(QUESTION_ANSWER_TAIL_LIMIT).toBeGreaterThan(0);
  });
});

/*
FNXC:ChatQuestionAnswerLink 2026-09-23-13:59:
RUFU-258 mirror parity. The browser bundle cannot import this module (it pulls in server-only code),
so the app keeps its own copy of the key literal and the reader — the same reason
`QUESTION_TOOL_NAMES` mirrors `COMPACT_QUESTION_TOOL_NAMES`. Parity is asserted behaviourally: the
same payload battery must resolve identically on both sides, and a stamped row must be readable by
the client. Behaviour, not source text, is the subject.
*/
describe("app-side durable reader parity", () => {
  const payloads: unknown[] = [
    { [QUESTION_ANSWER_METADATA_KEY]: { questionMessageId: "msg-q1" } },
    { [QUESTION_ANSWER_METADATA_KEY]: { questionMessageId: "  msg-q1  " } },
    { [QUESTION_ANSWER_METADATA_KEY]: null },
    { [QUESTION_ANSWER_METADATA_KEY]: "msg-q1" },
    { [QUESTION_ANSWER_METADATA_KEY]: ["msg-q1"] },
    { [QUESTION_ANSWER_METADATA_KEY]: {} },
    { [QUESTION_ANSWER_METADATA_KEY]: { questionMessageId: 42 } },
    { [QUESTION_ANSWER_METADATA_KEY]: { questionMessageId: "   " } },
    { mentions: [], [QUESTION_ANSWER_METADATA_KEY]: { questionMessageId: "msg-q2" } },
    { mentions: [] },
    null,
    undefined,
    "not-an-object",
  ];

  it("shares the metadata key literal with the client reader", async () => {
    const app = await import("../../app/utils/parseQuestionToolCall.js");
    expect(app.QUESTION_ANSWER_METADATA_KEY).toBe(QUESTION_ANSWER_METADATA_KEY);
  });

  it("resolves every payload identically on both sides", async () => {
    const app = await import("../../app/utils/parseQuestionToolCall.js");
    for (const payload of payloads) {
      expect(app.readQuestionAnswerLink(payload)).toEqual(readQuestionAnswerLink(payload));
    }
  });

  it("resolves a server-stamped row through the client reader", async () => {
    const app = await import("../../app/utils/parseQuestionToolCall.js");
    const stamped = withQuestionAnswerLink({ mentions: [{ agentId: "agent-1" }] }, "a-question");
    expect(app.readQuestionAnswerLink(stamped)).toBe("a-question");
    expect(readQuestionAnswerLink(stamped)).toBe("a-question");
  });

  it("survives the chat feed compaction that every thread page passes through", async () => {
    const app = await import("../../app/utils/parseQuestionToolCall.js");
    const { compactChatMessagesForFeed } = await import("../shared/chat-toolcall-compact.js");
    const userRow = {
      id: "msg-answer",
      sessionId: "chat-1",
      role: "user",
      content: "the feature branch",
      createdAt: "2026-09-23T00:00:00.000Z",
      metadata: withQuestionAnswerLink({}, "a-question"),
    } as never;

    const [compacted] = compactChatMessagesForFeed([userRow]);
    const metadata = (compacted as unknown as { metadata?: Record<string, unknown> }).metadata;
    expect(app.readQuestionAnswerLink(metadata)).toBe("a-question");
  });
});
