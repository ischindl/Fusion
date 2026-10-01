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

  /*
  FNXC:ChatSendDurability 2026-09-07-15:52:
  RUFU-192: this factory is the pass-through seam between the SSE parser and the composer's durability
  commit, so the contract the composer relies on is pinned here: every `user_persisted` frame reaches the
  caller's handler exactly once and SYNCHRONOUSLY — unlike text deltas it is never buffered or coalesced,
  because delaying the release of composer text by a frame widens the zero-durable-owner window this task
  exists to close. Redelivery through `Last-Event-ID` replay is forwarded too: the idempotent commit lives
  in the caller, not in this seam. A consumer without the handler (the planner tab, an explicit non-goal of
  this task) must stay a safe no-op rather than throwing.
  */
  describe("durable user-turn acknowledgement", () => {
    function makeAckHandlers(withAckHandler = true) {
      const onUserPersisted = vi.fn();
      const { handlers } = createChatStreamHandlers({
        sessionId: "s-ack",
        tempUserMessageId: "temp-1",
        setStreamingText: vi.fn(),
        setStreamingThinking: vi.fn(),
        setStreamingToolCalls: vi.fn(),
        cancelStreamingFlushesRef: { current: null } as { current: (() => void) | null },
        ...(withAckHandler ? { onUserPersisted } : {}),
        onDone: vi.fn(),
        onError: vi.fn(),
      });
      return { handlers, onUserPersisted };
    }

    it("forwards each acknowledgement synchronously, exactly once per delivery", () => {
      const { handlers, onUserPersisted } = makeAckHandlers();

      handlers.onUserPersisted("user-row-1");
      // Asserted without advancing any timer: a buffered ack would strand released text.
      expect(onUserPersisted).toHaveBeenCalledTimes(1);
      expect(onUserPersisted).toHaveBeenCalledWith("user-row-1");

      // A replayed duplicate is forwarded verbatim; dedupe is the caller's idempotent commit.
      handlers.onUserPersisted("user-row-1");
      expect(onUserPersisted).toHaveBeenCalledTimes(2);
    });

    it("stays a safe no-op for a consumer without an acknowledgement handler", () => {
      const { handlers } = makeAckHandlers(false);

      expect(() => handlers.onUserPersisted("user-row-2")).not.toThrow();
    });
  });

  /*
  FNXC:AssistantTextCapture 2026-09-15-22:45:
  FN-431: a reconnect resumes from the persisted checkpoint and then replays only the events after
  its cursor. The opening words live in the checkpoint, so replaying them again would recreate the
  reported "I'll researchI'll research" duplication on the client side.
  */
  it("FN-431 resumes from a checkpoint without repeating its opening words", () => {
    vi.useFakeTimers();

    const prefix = "I'll research";
    const suffix = " the codebase before writing the spec.";
    let text = prefix;
    const onDone = vi.fn();
    const cancelStreamingFlushesRef = { current: null } as { current: (() => void) | null };

    const { handlers } = createChatStreamHandlers({
      sessionId: "s-1",
      tempUserMessageId: "",
      initialText: prefix,
      setStreamingText: (value) => {
        text = typeof value === "function" ? value(text) : value;
      },
      setStreamingThinking: vi.fn(),
      setStreamingToolCalls: vi.fn(),
      cancelStreamingFlushesRef,
      onDone,
      onError: vi.fn(),
    });

    // Only the events strictly after the checkpoint cursor are replayed.
    handlers.onText(suffix);
    vi.advanceTimersToNextTimer();

    expect(text).toBe(prefix + suffix);
    expect(text).not.toBe(prefix + prefix + suffix);

    handlers.onDone({ messageId: "m-1" });
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({
      accumulated: expect.objectContaining({ text: prefix + suffix }),
    }));

    vi.useRealTimers();
  });

  it("FN-431 keeps two legitimately identical fragments", () => {
    vi.useFakeTimers();

    const prefix = "I'll research";
    let text = "";
    const cancelStreamingFlushesRef = { current: null } as { current: (() => void) | null };

    const { handlers } = createChatStreamHandlers({
      sessionId: "s-1",
      tempUserMessageId: "",
      setStreamingText: (value) => {
        text = typeof value === "function" ? value(text) : value;
      },
      setStreamingThinking: vi.fn(),
      setStreamingToolCalls: vi.fn(),
      cancelStreamingFlushesRef,
      onDone: vi.fn(),
      onError: vi.fn(),
    });

    handlers.onText(prefix);
    handlers.onText(prefix);
    vi.advanceTimersToNextTimer();

    expect(text).toBe(prefix + prefix);

    vi.useRealTimers();
  });

  /*
  FNXC:ChatMessageEdit 2026-09-16-05:58:
  FN-459. The factory must join the stream's own `tempUserMessageId` onto the in-band identity event
  so the caller reconciles its optimistic bubble by EXACT temp id rather than by content equality
  (two identical consecutive sends would otherwise collide and leave a `temp-<ts>` id behind).
  */
  it("joins the stream's tempUserMessageId onto the in-band user_message event", () => {
    const onUserMessage = vi.fn();
    const cancelStreamingFlushesRef = { current: null } as { current: (() => void) | null };

    const { handlers } = createChatStreamHandlers({
      sessionId: "s-1",
      tempUserMessageId: "temp-1789537275231",
      setStreamingText: vi.fn(),
      setStreamingThinking: vi.fn(),
      setStreamingToolCalls: vi.fn(),
      cancelStreamingFlushesRef,
      onUserMessage,
      onDone: vi.fn(),
      onError: vi.fn(),
    });

    const persisted = {
      id: "msg-ab12cd34",
      sessionId: "s-1",
      role: "user" as const,
      content: "bonjour",
      thinkingOutput: null,
      metadata: null,
      createdAt: "2026-09-16T00:00:00.000Z",
    };
    handlers.onUserMessage?.({ message: persisted });

    expect(onUserMessage).toHaveBeenCalledTimes(1);
    expect(onUserMessage).toHaveBeenCalledWith({
      message: persisted,
      tempUserMessageId: "temp-1789537275231",
    });
  });

  it("omits onUserMessage entirely when the caller does not opt in", () => {
    const cancelStreamingFlushesRef = { current: null } as { current: (() => void) | null };
    const { handlers } = createChatStreamHandlers({
      sessionId: "s-1",
      tempUserMessageId: "temp-1",
      setStreamingText: vi.fn(),
      setStreamingThinking: vi.fn(),
      setStreamingToolCalls: vi.fn(),
      cancelStreamingFlushesRef,
      onDone: vi.fn(),
      onError: vi.fn(),
    });

    expect(handlers.onUserMessage).toBeUndefined();
  });
});
