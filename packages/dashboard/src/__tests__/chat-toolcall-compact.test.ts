// @vitest-environment node

import { describe, expect, it } from "vitest";
import { COMPACT_QUESTION_TOOL_NAMES, compactChatMessagesForFeed } from "../shared/chat-toolcall-compact.js";
import { QUESTION_TOOL_NAMES } from "../../app/utils/parseQuestionToolCall.js";

function toolMessage(metadata: Record<string, unknown> | null) {
  return {
    id: "msg-1",
    sessionId: "chat-1",
    role: "assistant",
    content: "done",
    createdAt: "2026-09-17T00:00:00.000Z",
    metadata,
  } as never;
}

function toolCallsOf(message: Awaited<ReturnType<typeof compactChatMessagesForFeed>>[number]) {
  return ((message as unknown as { metadata: Record<string, unknown> }).metadata.toolCalls ?? []) as Record<string, unknown>[];
}

describe("compactChatMessagesForFeed", () => {
  it("drops non-question bodies and ships a result preview with full-details marker", () => {
    const [message] = compactChatMessagesForFeed([toolMessage({
      interrupted: false,
      toolCalls: [{ toolName: "bash", args: { command: "ls -la" }, result: "x".repeat(400), isError: true, status: "completed" }],
    })]);
    const [entry] = toolCallsOf(message);
    expect(entry.compacted).toBe(true);
    expect("args" in entry).toBe(false);
    expect("result" in entry).toBe(false);
    expect(entry.toolName).toBe("bash");
    expect(entry.status).toBe("completed");
    expect(entry.isError).toBe(true);
    expect(entry.hasFullDetails).toBe(true);
    expect(entry.previewKind).toBe("result");
    expect(entry.previewText).toBe(`${"x".repeat(120)}…`);
    // Non-toolCall metadata keys are untouched.
    expect((message as unknown as { metadata: Record<string, unknown> }).metadata.interrupted).toBe(false);
  });

  it("falls back to an args preview when there is no result", () => {
    const [message] = compactChatMessagesForFeed([toolMessage({
      toolCalls: [{ toolName: "read", args: { file_path: "/tmp/a.txt" }, isError: false, status: "completed" }],
    })]);
    const [entry] = toolCallsOf(message);
    expect(entry.previewKind).toBe("args");
    expect(entry.previewText).toBe("file_path=/tmp/a.txt");
    expect(entry.hasFullDetails).toBe(true);
  });

  it("keeps question tool calls fully intact so answer cards stay answerable", () => {
    const question = {
      toolName: "ask_user",
      args: { questions: [{ id: "q1", type: "text", question: "Which branch?" }] },
      isError: false,
      status: "completed",
    };
    const [message] = compactChatMessagesForFeed([toolMessage({ toolCalls: [question] })]);
    expect(toolCallsOf(message)[0]).toEqual(question);
  });

  it("is idempotent and leaves bodies-less rows preview-less", () => {
    const once = compactChatMessagesForFeed([toolMessage({
      toolCalls: [
        { toolName: "bash", args: { command: "ls" }, result: "ok", isError: false, status: "completed" },
        { toolName: "noop", isError: false, status: "completed" },
      ],
    })]);
    const twice = compactChatMessagesForFeed(once);
    expect(twice).toEqual(once);
    const [, bodyless] = toolCallsOf(once[0]);
    expect(bodyless.compacted).toBe(true);
    expect("previewText" in bodyless).toBe(false);
    expect(bodyless.hasFullDetails).toBeUndefined();
  });

  it("leaves messages without tool calls and non-object metadata untouched", () => {
    const plain = toolMessage({ senderAgentId: "agent-1" });
    const [returned] = compactChatMessagesForFeed([plain]);
    expect(returned).toBe(plain);
    const [nullMeta] = compactChatMessagesForFeed([toolMessage(null)]);
    expect(nullMeta.metadata).toBeNull();
  });

  it("mirrors the app-side question tool name list exactly", async () => {
    // Server mirror parity: FNXC:ChatFeedCompaction 2026-09-17-15:38 documents why both copies must agree.
    expect(new Set(COMPACT_QUESTION_TOOL_NAMES.map((name) => name.toLowerCase())))
      .toEqual(new Set(QUESTION_TOOL_NAMES.map((name) => name.toLowerCase())));
  });
});
