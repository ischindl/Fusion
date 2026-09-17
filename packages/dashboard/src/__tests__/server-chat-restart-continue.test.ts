/*
FNXC:ChatRestartAutoContinue 2026-09-17-21:05:
Auto-continue after a restart fires at most once and only while the recovered interrupted
row is still the transcript's tail. An operator who already continued manually, or a session
that resumed generating, is skipped - these cases pin that guard matrix.
*/

import { describe, expect, it, vi } from "vitest";
import { CHAT_RESTART_CONTINUATION_TEXT, maybeContinueRecoveredChatGeneration } from "../server.js";

function storeWithLast(last: { role: string; metadata?: Record<string, unknown> | null } | undefined) {
  return {
    getMessages: vi.fn(async () => (last ? [last] : [])),
  };
}

const RECOVERED = { role: "assistant", metadata: { interrupted: true, recoveredFromStaleGeneration: true } };

describe("maybeContinueRecoveredChatGeneration", () => {
  it("continues exactly a recovered interrupted tail", async () => {
    const send = vi.fn(async () => {});
    const outcome = await maybeContinueRecoveredChatGeneration({
      sessionId: "chat-1",
      chatStore: storeWithLast(RECOVERED),
      isGenerating: () => false,
      sendContinuation: send,
    });
    expect(outcome).toBe("continued");
    expect(send).toHaveBeenCalledWith("chat-1");
  });

  it("skips while the session is generating", async () => {
    const send = vi.fn();
    const outcome = await maybeContinueRecoveredChatGeneration({
      sessionId: "chat-2",
      chatStore: storeWithLast(RECOVERED),
      isGenerating: () => true,
      sendContinuation: send,
    });
    expect(outcome).toBe("skipped-generating");
    expect(send).not.toHaveBeenCalled();
  });

  it("skips when the operator already continued or the tail is unrelated", async () => {
    for (const last of [
      { role: "user", metadata: null },
      { role: "assistant", metadata: { interrupted: true } },
      undefined,
    ]) {
      const send = vi.fn();
      const outcome = await maybeContinueRecoveredChatGeneration({
        sessionId: "chat-3",
        chatStore: storeWithLast(last),
        isGenerating: () => false,
        sendContinuation: send,
      });
      expect(outcome).toBe("skipped-state");
      expect(send).not.toHaveBeenCalled();
    }
  });

  it("keeps the continuation text honest about its origin", () => {
    expect(CHAT_RESTART_CONTINUATION_TEXT).toContain("server restart");
    expect(CHAT_RESTART_CONTINUATION_TEXT).toContain("Resume the work requested by the last user message");
  });
});
