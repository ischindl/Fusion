import { describe, expect, it, vi } from "vitest";
import { createChatStreamHandlers } from "../createChatStreamHandlers";

describe("createChatStreamHandlers", () => {
  it.each([
    {
      name: "empty delta sandwiched between spaced chunks",
      chunks: ["Hello.", "", " World."],
      expected: "Hello. World.",
    },
    {
      name: "multiple sentence boundaries across four chunks",
      chunks: ["One.", " Two.", " Three.", " Four."],
      expected: "One. Two. Three. Four.",
    },
    {
      name: "whitespace-only final delta immediately before done",
      chunks: ["Trailing", " "],
      expected: "Trailing ",
    },
  ])("preserves whitespace across streamed text deltas (%s)", ({ chunks, expected }) => {
    vi.useFakeTimers();

    let text = "";
    const onDone = vi.fn();
    const onError = vi.fn();
    const cancelStreamingFlushesRef = { current: null } as { current: (() => void) | null };

    const { handlers } = createChatStreamHandlers({
      sessionId: "s-1",
      tempUserMessageId: "temp-1",
      setStreamingText: (value) => {
        text = typeof value === "function" ? value(text) : value;
      },
      setStreamingThinking: vi.fn(),
      setStreamingToolCalls: vi.fn(),
      cancelStreamingFlushesRef,
      onDone,
      onError,
    });

    for (const chunk of chunks) {
      handlers.onText(chunk);
    }

    vi.advanceTimersToNextTimer();

    expect(text).toBe(expected);

    handlers.onDone({ messageId: "m-1" });
    expect(onDone).toHaveBeenCalledWith({
      messageId: "m-1",
      message: undefined,
      accumulated: {
        text: expected,
        thinking: "",
        toolCalls: [],
        fallbackInfo: undefined,
      },
    });
    expect(onError).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
