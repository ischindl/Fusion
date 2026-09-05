import { describe, expect, it, vi } from "vitest";
import { createChatStreamHandlers } from "../createChatStreamHandlers";
import type { ToolCallInfo } from "../chatTypes";

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

  it("FN-6632 seeds reattached accumulators before appending new chunks", () => {
    vi.useFakeTimers();

    let text = "Hello ";
    let thinking = "thinking…";
    let toolCalls: ToolCallInfo[] = [
      { toolName: "read", status: "completed", isError: false, result: "seeded" },
    ];
    const onDone = vi.fn();
    const cancelStreamingFlushesRef = { current: null } as { current: (() => void) | null };

    const { handlers } = createChatStreamHandlers({
      sessionId: "s-1",
      tempUserMessageId: "",
      initialText: "Hello ",
      initialThinking: "thinking…",
      initialToolCalls: toolCalls,
      setStreamingText: (value) => {
        text = typeof value === "function" ? value(text) : value;
      },
      setStreamingThinking: (value) => {
        thinking = typeof value === "function" ? value(thinking) : value;
      },
      setStreamingToolCalls: (value) => {
        toolCalls = typeof value === "function" ? value(toolCalls) : value;
      },
      cancelStreamingFlushesRef,
      onDone,
      onError: vi.fn(),
    });

    handlers.onText("world");
    handlers.onText("!");
    handlers.onThinking(" more");
    handlers.onToolStart({ toolName: "write", args: { path: "a.ts" } });
    handlers.onToolEnd({ toolName: "write", isError: false, result: "done" });

    vi.advanceTimersToNextTimer();
    vi.advanceTimersToNextTimer();

    expect(text).toBe("Hello world!");
    expect(thinking).toBe("thinking… more");
    expect(toolCalls).toEqual([
      { toolName: "read", status: "completed", isError: false, result: "seeded" },
      { toolName: "write", args: { path: "a.ts" }, status: "completed", isError: false, result: "done" },
    ]);

    handlers.onDone({ messageId: "m-1" });
    expect(onDone).toHaveBeenCalledWith({
      messageId: "m-1",
      message: undefined,
      accumulated: {
        text: "Hello world!",
        thinking: "thinking… more",
        toolCalls,
        fallbackInfo: undefined,
      },
    });

    vi.useRealTimers();
  });

  /*
  FNXC:ChatPhaseStatus 2026-09-05-11:45:
  RUFU-188 (Code Review P0): the client half of the phase side-channel had no test below the component
  boundary — nothing proved the shared handlers map the paired `phase` frames onto the single label slot or
  that the terminal events clear it. These pin the factory contract the consumers rely on: an active frame
  arms the label, the inactive frame clears it, the first text delta clears it (a lost inactive frame must
  not strand "(compacting…)" once the answer streams), `done`/`error` clear defensively, and a consumer
  that does not carry phase state stays a safe no-op.
  */
  describe("phase side-channel", () => {
    function makePhaseHandlers(withPhaseSetter = true) {
      const setStreamingPhase = vi.fn();
      const onDone = vi.fn();
      const onError = vi.fn();
      const cancelStreamingFlushesRef = { current: null } as { current: (() => void) | null };
      const { handlers } = createChatStreamHandlers({
        sessionId: "s-phase",
        tempUserMessageId: "temp-1",
        setStreamingText: vi.fn(),
        setStreamingThinking: vi.fn(),
        setStreamingToolCalls: vi.fn(),
        ...(withPhaseSetter ? { setStreamingPhase } : {}),
        cancelStreamingFlushesRef,
        onDone,
        onError,
      });
      return { handlers, setStreamingPhase, onDone, onError };
    }

    it("arms the label on an active frame and clears it on the paired inactive frame", () => {
      const { handlers, setStreamingPhase } = makePhaseHandlers();

      handlers.onPhase?.({ phase: "compacting", active: true });
      expect(setStreamingPhase).toHaveBeenCalledWith("compacting");

      handlers.onPhase?.({ phase: "compacting", active: false });
      expect(setStreamingPhase).toHaveBeenLastCalledWith(null);
      expect(setStreamingPhase).toHaveBeenCalledTimes(2);
    });

    it("clears the phase on the first text delta and not on later ones", () => {
      const { handlers, setStreamingPhase } = makePhaseHandlers();

      handlers.onPhase?.({ phase: "compacting", active: true });
      handlers.onText("Hel");
      expect(setStreamingPhase).toHaveBeenNthCalledWith(2, null);

      handlers.onText("lo");
      // Exactly one arm + one clear: the clear is the FIRST-delta boundary, not every append.
      expect(setStreamingPhase).toHaveBeenCalledTimes(2);
    });

    it("clears the phase when the stream completes", () => {
      const { handlers, setStreamingPhase, onDone } = makePhaseHandlers();

      handlers.onPhase?.({ phase: "compacting", active: true });
      handlers.onDone?.({ messageId: "m-1" });

      // A replayed `active: true` (gate long finished server-side) must never leave a stuck label.
      expect(setStreamingPhase).toHaveBeenLastCalledWith(null);
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    it("clears the phase when the stream errors", () => {
      const { handlers, setStreamingPhase, onError } = makePhaseHandlers();

      handlers.onPhase?.({ phase: "compacting", active: true });
      handlers.onError?.("boom");

      expect(setStreamingPhase).toHaveBeenLastCalledWith(null);
      expect(onError).toHaveBeenCalledWith("boom", "temp-1", undefined);
    });

    it("treats phase frames as a safe no-op without a phase setter", () => {
      const { handlers, onDone, onError } = makePhaseHandlers(false);

      expect(() => {
        handlers.onPhase?.({ phase: "compacting", active: true });
        handlers.onText("answer text");
        handlers.onPhase?.({ phase: "compacting", active: false });
        handlers.onDone?.({ messageId: "m-2" });
        handlers.onError?.("late");
      }).not.toThrow();
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);
    });
  });
});
