/*
FNXC:ChatHandoff 2026-09-09-17:36:
RUFU-199 proves the handoff at the manager seam, where every promise of the feature is actually kept:
the continuation is IDENTITY-IDENTICAL (same agent, same model lane, same thinking level) so a handoff
can never silently change which model the operator is talking to; the source is ARCHIVED and never
deleted, so a summarizer failure cannot destroy the conversation the operator can still read; the
primer row carries the complete lineage object in its ONE creating write (the store merges metadata one
level deep, so a later partial patch would erase the fields the notice and the injection gate read) and
carries NO delivery stamp; and every ineligible source is refused with a typed code instead of being
half-executed.

Every eligible fixture carries a measured `metadata.contextUsage` record on an assistant row, because
that record is the precondition for the affordance existing at all — a transcript with no usage signal
is an unknown-model source and must be refused.

The summarizer is mocked at the `@fusion/core` re-export because the alternative — a real AI lane —
would make the degradation branch untestable offline. Its own bounded-cap behaviour is proven in
packages/core/src/__tests__/ai-summarize-chat-handoff.test.ts.
*/
import { describe, it, expect, beforeEach, vi } from "vitest";

const summarizeChatHandoffMock = vi.hoisted(() => vi.fn());

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return { ...actual, summarizeChatHandoff: summarizeChatHandoffMock };
});

import { ChatManager, ChatHandoffError, buildHandoffTranscript } from "../../chat.js";
import type { ChatMessage, ChatSession } from "@fusion/core";

const TRANSCRIPT_SECRET = "TRANSCRIPT-SECRET-do-not-audit";
const BRIEFING_SECRET = "BRIEFING-SECRET-do-not-audit";

/** A measured usage record: the signal that makes a session eligible for a handoff at all. */
const USAGE = { contextUsage: { tokens: 90_000, contextWindow: 100_000, percent: 90 } };

type FakeSessionInput = {
  id?: string;
  agentId: string;
  title?: string | null;
  projectId?: string | null;
  modelProvider?: string | null;
  modelId?: string | null;
  thinkingLevel?: string | null;
  memoryFocus?: string | null;
  kind?: "direct" | "room";
  roomId?: string | null;
  cliExecutorAdapterId?: string | null;
  status?: "active" | "archived";
};

class FakeChatStore {
  sessions = new Map<string, ChatSession>();
  messages: ChatMessage[] = [];

  createSession = vi.fn(async (input: FakeSessionInput): Promise<ChatSession> => {
    const now = new Date().toISOString();
    const session = {
      id: `chat-${this.sessions.size + 1}`,
      agentId: input.agentId,
      title: input.title ?? null,
      status: "active",
      kind: "direct",
      roomId: input.roomId ?? null,
      projectId: input.projectId ?? null,
      modelProvider: input.modelProvider ?? null,
      modelId: input.modelId ?? null,
      thinkingLevel: input.thinkingLevel ?? null,
      memoryFocus: input.memoryFocus ?? null,
      cliSessionFile: null,
      cliExecutorAdapterId: null,
      inFlightGeneration: null,
      createdAt: now,
      updatedAt: now,
    } as ChatSession;
    this.sessions.set(session.id, session);
    return session;
  });

  archiveSession = vi.fn(async (id: string): Promise<ChatSession | undefined> => {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    session.status = "archived";
    return session;
  });

  deleteSession = vi.fn(async (id: string): Promise<boolean> => {
    this.messages = this.messages.filter((message) => message.sessionId !== id);
    return this.sessions.delete(id);
  });

  addMessage = vi.fn(async (
    sessionId: string,
    input: { role: string; content: string; metadata?: Record<string, unknown> | null },
  ): Promise<ChatMessage> => {
    const message = {
      id: `msg-${this.messages.length + 1}`,
      sessionId,
      role: input.role,
      content: input.content,
      thinkingOutput: null,
      metadata: input.metadata ?? null,
      attachments: [],
      createdAt: new Date().toISOString(),
    } as ChatMessage;
    this.messages.push(message);
    return message;
  });

  seedSession(input: FakeSessionInput): ChatSession {
    const now = new Date().toISOString();
    const session = {
      id: input.id ?? `chat-seeded-${this.sessions.size + 1}`,
      agentId: input.agentId,
      title: input.title ?? null,
      status: input.status ?? "active",
      kind: input.kind ?? "direct",
      roomId: input.roomId ?? null,
      projectId: input.projectId ?? null,
      modelProvider: input.modelProvider ?? null,
      modelId: input.modelId ?? null,
      thinkingLevel: input.thinkingLevel ?? null,
      memoryFocus: input.memoryFocus ?? null,
      cliSessionFile: null,
      cliExecutorAdapterId: input.cliExecutorAdapterId ?? null,
      inFlightGeneration: null,
      createdAt: now,
      updatedAt: now,
    } as ChatSession;
    this.sessions.set(session.id, session);
    return session;
  }

  seedMessage(sessionId: string, role: string, content: string, metadata?: Record<string, unknown>): ChatMessage {
    const message = {
      id: `msg-${this.messages.length + 1}`,
      sessionId,
      role,
      content,
      thinkingOutput: null,
      metadata: metadata ?? null,
      attachments: [],
      createdAt: new Date().toISOString(),
    } as ChatMessage;
    this.messages.push(message);
    return message;
  }

  /** The minimal transcript that clears the usage-signal gate. */
  seedEligibleSource(input: FakeSessionInput): ChatSession {
    const session = this.seedSession(input);
    this.seedMessage(session.id, "user", "what blocks the merge gate?");
    this.seedMessage(session.id, "assistant", "the missing pre-merge approval", USAGE);
    return session;
  }

  async getSession(id: string): Promise<ChatSession | undefined> {
    return this.sessions.get(id);
  }

  async getMessages(sessionId: string, filter?: { order?: "asc" | "desc"; limit?: number }): Promise<ChatMessage[]> {
    const inSession = this.messages.filter((message) => message.sessionId === sessionId);
    const ordered = filter?.order === "desc" ? [...inSession].reverse() : inSession;
    return typeof filter?.limit === "number" ? ordered.slice(0, filter.limit) : ordered;
  }
}

function makeManager(
  store: FakeChatStore,
  options: { settings?: Record<string, unknown>; audit?: (event: unknown) => void } = {},
) {
  const taskStore = options.audit ? ({ recordRunAuditEvent: options.audit } as never) : undefined;
  return new ChatManager(
    store as never,
    "/tmp/rufu-199-handoff",
    undefined,
    undefined,
    () => ({ chatHandoffEnabled: true, chatHandoffThresholdPercent: 75, ...options.settings }),
    undefined,
    taskStore,
  );
}

function auditMetadata(auditCalls: unknown[]): Record<string, unknown>[] {
  return auditCalls.map((call) => (call as { metadata: Record<string, unknown> }).metadata);
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => null, (caught: unknown) => caught);
}

describe("ChatManager.handoffSession — Direct conversation handoff", () => {
  let store: FakeChatStore;

  beforeEach(() => {
    summarizeChatHandoffMock.mockReset();
    store = new FakeChatStore();
  });

  describe("success", () => {
    it("creates an identity-identical continuation, seeds a primer, and archives the source", async () => {
      const source = store.seedEligibleSource({
        id: "chat-source",
        agentId: "agent-abc",
        title: "Ship the gate",
        projectId: "proj-7",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-5",
        thinkingLevel: "high",
        memoryFocus: "merge gates",
      });

      summarizeChatHandoffMock.mockResolvedValue(BRIEFING_SECRET);
      const auditCalls: unknown[] = [];
      const manager = makeManager(store, { audit: (event) => auditCalls.push(event) });

      const result = await manager.handoffSession(source.id);

      expect(result.sourceSessionId).toBe(source.id);
      expect(result.degraded).toBe(false);
      expect(result.summaryChars).toBe(BRIEFING_SECRET.length);

      // The continuation must be the SAME agent on the SAME model lane: a handoff is an escape from
      // context pressure, never a model or agent change.
      expect(result.session.agentId).toBe("agent-abc");
      expect(result.session.modelProvider).toBe("anthropic");
      expect(result.session.modelId).toBe("claude-sonnet-5");
      expect(result.session.thinkingLevel).toBe("high");
      expect(result.session.projectId).toBe("proj-7");
      expect(result.session.title).toBe("Continue: Ship the gate");
      // A fresh session means a fresh recall scope; only the identity lane carries over.
      expect(result.session.memoryFocus).toBeNull();
      expect(result.session.cliExecutorAdapterId).toBeNull();

      // Archive, never delete: the source keeps its row and stays readable.
      expect(store.sessions.get(source.id)?.status).toBe("archived");

      const primer = store.messages.find((message) => message.sessionId === result.session.id);
      expect(primer?.role).toBe("system");
      expect(primer?.content).toBe(BRIEFING_SECRET);
      expect(primer?.metadata?.handoff).toEqual({
        fromSessionId: source.id,
        fromTitle: "Ship the gate",
        degraded: false,
      });
      // The delivery stamp is written later, by the injection gate — never at creation.
      expect(primer?.metadata?.handoffDeliveredAt).toBeUndefined();

      await vi.waitFor(() => expect(auditCalls).toHaveLength(1));
      expect(auditCalls[0]).toMatchObject({
        mutationType: "chat:handoff-session-created",
        target: `chat:${result.session.id}`,
      });
      expect(auditMetadata(auditCalls)[0]).toEqual({
        fromSessionId: source.id,
        toSessionId: result.session.id,
        outcome: "created",
        messageCount: 2,
        summaryChars: BRIEFING_SECRET.length,
      });
    });

    it("hands off the model-target sentinel chat, which is the common model-mode chat", async () => {
      const source = store.seedEligibleSource({
        agentId: "__fn_agent__",
        title: "Model mode",
        modelProvider: "anthropic",
        modelId: "claude-opus-4-1",
      });
      summarizeChatHandoffMock.mockResolvedValue("briefing");

      const result = await makeManager(store).handoffSession(source.id);

      expect(result.session.agentId).toBe("__fn_agent__");
      expect(result.session.modelId).toBe("claude-opus-4-1");
    });

    it("summarizes on the source session's own provider and model", async () => {
      const source = store.seedSession({
        id: "chat-source",
        agentId: "agent-abc",
        title: "Lane check",
        modelProvider: "openrouter",
        modelId: "deepseek-v3",
      });
      store.seedMessage(source.id, "user", "hello");
      store.seedMessage(source.id, "assistant", "hi", USAGE);
      summarizeChatHandoffMock.mockResolvedValue("briefing");

      await makeManager(store).handoffSession(source.id);

      expect(summarizeChatHandoffMock).toHaveBeenCalledTimes(1);
      const [digest, rootDir, provider, modelId] = summarizeChatHandoffMock.mock.calls[0] as [string, string, string, string];
      expect(rootDir).toBe("/tmp/rufu-199-handoff");
      expect(provider).toBe("openrouter");
      expect(modelId).toBe("deepseek-v3");
      expect(digest).toContain("(user) hello");
    });

    it("needs a usage signal, not a stored model pair", async () => {
      // An agent-target chat whose lane was never written onto the row still measures real usage, and
      // that measurement — not the row's provider column — is what the threshold was compared against.
      const source = store.seedEligibleSource({ id: "chat-source", agentId: "agent-abc", title: "No pair" });
      summarizeChatHandoffMock.mockResolvedValue("briefing");

      const result = await makeManager(store).handoffSession(source.id);
      expect(result.degraded).toBe(false);
    });

    it("keeps a source whose title is unset out of a null-titled continuation", async () => {
      const source = store.seedEligibleSource({ id: "chat-source", agentId: "agent-abc" });
      summarizeChatHandoffMock.mockResolvedValue("briefing");

      const result = await makeManager(store).handoffSession(source.id);

      expect(result.session.title).toBe("Continue: Untitled conversation");
      const primer = store.messages.find((message) => message.sessionId === result.session.id);
      expect((primer?.metadata?.handoff as { fromTitle: string }).fromTitle).toBe("Untitled conversation");
    });

    it("emits ids, counts and enums only — never the transcript, the briefing, or a title", async () => {
      const source = store.seedEligibleSource({ id: "chat-source", agentId: "agent-abc", title: "TITLE-SECRET-not-audited" });
      store.seedMessage(source.id, "user", TRANSCRIPT_SECRET);
      summarizeChatHandoffMock.mockResolvedValue(BRIEFING_SECRET);

      const auditCalls: unknown[] = [];
      const manager = makeManager(store, { audit: (event) => auditCalls.push(event) });
      const result = await manager.handoffSession(source.id);

      await vi.waitFor(() => expect(auditCalls).toHaveLength(1));
      const serialized = JSON.stringify(auditCalls);
      expect(serialized).not.toContain(TRANSCRIPT_SECRET);
      expect(serialized).not.toContain(BRIEFING_SECRET);
      expect(serialized).not.toContain("TITLE-SECRET");
      expect(auditMetadata(auditCalls)[0]).not.toHaveProperty("content");
      expect(result.degraded).toBe(false);
    });
  });

  describe("honest degradation", () => {
    it("falls back to the deterministic digest and flags the primer degraded when the summarizer throws", async () => {
      const source = store.seedSession({ id: "chat-source", agentId: "agent-abc", title: "Long thread" });
      store.seedMessage(source.id, "user", "we decided to keep the gate");
      store.seedMessage(source.id, "assistant", "agreed, gate stays", USAGE);
      summarizeChatHandoffMock.mockRejectedValue(new Error("model unavailable"));

      const auditCalls: unknown[] = [];
      const manager = makeManager(store, { audit: (event) => auditCalls.push(event) });
      const result = await manager.handoffSession(source.id);

      expect(result.degraded).toBe(true);
      const primer = store.messages.find((message) => message.sessionId === result.session.id);
      expect(primer?.content.trim().length).toBeGreaterThan(0);
      expect(primer?.content).toContain("we decided to keep the gate");
      expect(primer?.content).toContain("agreed, gate stays");
      expect((primer?.metadata?.handoff as { degraded: boolean }).degraded).toBe(true);
      // The handoff still succeeds: the source is archived and the continuation exists.
      expect(store.sessions.get(source.id)?.status).toBe("archived");

      await vi.waitFor(() => expect(auditCalls).toHaveLength(1));
      expect(auditCalls[0]).toMatchObject({ mutationType: "chat:handoff-session-created" });
      expect(auditMetadata(auditCalls)[0].outcome).toBe("degraded-created");
    });

    it("treats a blank briefing as a failed briefing rather than shipping an empty primer", async () => {
      const source = store.seedEligibleSource({ id: "chat-source", agentId: "agent-abc", title: "Blank" });
      store.seedMessage(source.id, "user", "the real content lives here");
      summarizeChatHandoffMock.mockResolvedValue("   ");

      const result = await makeManager(store).handoffSession(source.id);
      const primer = store.messages.find((message) => message.sessionId === result.session.id);

      expect(result.degraded).toBe(true);
      expect(primer?.content).toContain("the real content lives here");
    });
  });

  describe("eligibility refusals", () => {
    const cases: Array<{ name: string; seed: FakeSessionInput; code: string; status: number }> = [
      { name: "room", seed: { id: "chat-room", agentId: "agent-abc", kind: "room", roomId: "room-1" }, code: "room-unsupported", status: 409 },
      { name: "archived", seed: { id: "chat-archived", agentId: "agent-abc", status: "archived" }, code: "source-not-active", status: 409 },
      { name: "cli-backed", seed: { id: "chat-cli", agentId: "agent-abc", cliExecutorAdapterId: "adapter-grok" }, code: "cli-backed-unsupported", status: 409 },
      { name: "task-planner", seed: { id: "chat-planner", agentId: "task-planner:FN-001" }, code: "task-planner-unsupported", status: 409 },
    ];

    for (const testCase of cases) {
      it(`refuses a ${testCase.name} source with ${testCase.code} and creates nothing`, async () => {
        store.seedSession(testCase.seed);
        store.seedMessage(testCase.seed.id!, "user", "anything", USAGE);
        summarizeChatHandoffMock.mockResolvedValue("briefing");

        const auditCalls: unknown[] = [];
        const manager = makeManager(store, { audit: (event) => auditCalls.push(event) });
        const before = store.sessions.size;

        const error = await captureError(manager.handoffSession(testCase.seed.id!));

        expect(error).toBeInstanceOf(ChatHandoffError);
        expect((error as ChatHandoffError).code).toBe(testCase.code);
        expect((error as ChatHandoffError).status).toBe(testCase.status);
        expect(store.sessions.size).toBe(before);
        expect(summarizeChatHandoffMock).not.toHaveBeenCalled();
        expect(store.archiveSession).not.toHaveBeenCalled();

        await vi.waitFor(() => expect(auditCalls).toHaveLength(1));
        expect(auditCalls[0]).toMatchObject({
          mutationType: "chat:handoff-session-failed",
          target: `chat:${testCase.seed.id}`,
        });
        expect(auditMetadata(auditCalls)[0]).toMatchObject({
          fromSessionId: testCase.seed.id,
          outcome: "refused",
          refusalCode: testCase.code,
        });
      });
    }

    it("refuses a source with no context-usage signal — an unknown model has no threshold to clear", async () => {
      const source = store.seedSession({ id: "chat-source", agentId: "agent-abc", title: "No usage" });
      store.seedMessage(source.id, "user", "hello");
      store.seedMessage(source.id, "assistant", "hi");
      summarizeChatHandoffMock.mockResolvedValue("briefing");

      const manager = makeManager(store);
      const error = await captureError(manager.handoffSession(source.id));

      expect((error as ChatHandoffError).code).toBe("unknown-model");
      expect((error as ChatHandoffError).status).toBe(409);
      expect(store.sessions.size).toBe(1);
      expect(summarizeChatHandoffMock).not.toHaveBeenCalled();
    });

    it("refuses an empty conversation instead of seeding a blank primer", async () => {
      const source = store.seedSession({ id: "chat-empty", agentId: "agent-abc", title: "Empty" });
      summarizeChatHandoffMock.mockResolvedValue("briefing");

      const error = await captureError(makeManager(store).handoffSession(source.id));
      expect((error as ChatHandoffError).code).toBe("unknown-model");
      expect(store.sessions.size).toBe(1);
    });

    it("refuses a missing source with not-found/404", async () => {
      const error = await captureError(makeManager(store).handoffSession("chat-ghost"));
      expect(error).toBeInstanceOf(ChatHandoffError);
      expect((error as ChatHandoffError).code).toBe("not-found");
      expect((error as ChatHandoffError).status).toBe(404);
    });

    it("refuses while a reply is still in flight", async () => {
      const source = store.seedEligibleSource({ id: "chat-source", agentId: "agent-abc" });
      const manager = makeManager(store);
      (manager as unknown as { activeGenerations: Map<string, unknown> }).activeGenerations.set(source.id, {
        abortController: new AbortController(),
        agentResult: null,
        generationId: 1,
        cancellationRequested: false,
      });

      const error = await captureError(manager.handoffSession(source.id));
      expect((error as ChatHandoffError).code).toBe("generation-in-progress");
      expect(store.sessions.size).toBe(1);
    });

    it("refuses when the project disabled handoffs, even though the UI hides the button", async () => {
      store.seedEligibleSource({ id: "chat-source", agentId: "agent-abc" });
      summarizeChatHandoffMock.mockResolvedValue("briefing");

      const manager = makeManager(store, { settings: { chatHandoffEnabled: false } });
      const error = await captureError(manager.handoffSession("chat-source"));

      expect((error as ChatHandoffError).code).toBe("disabled");
      expect(store.sessions.size).toBe(1);
      expect(summarizeChatHandoffMock).not.toHaveBeenCalled();
    });

    it("keeps the feature on when no settings reader is wired (the defaults are the contract)", async () => {
      const source = store.seedEligibleSource({ id: "chat-source", agentId: "agent-abc" });
      summarizeChatHandoffMock.mockResolvedValue("briefing");

      const result = await new ChatManager(store as never, "/tmp/rufu-199-handoff").handoffSession(source.id);
      expect(result.degraded).toBe(false);
    });
  });

  describe("idempotency and compensation", () => {
    it("creates exactly one continuation for two simultaneous requests", async () => {
      const source = store.seedEligibleSource({ id: "chat-source", agentId: "agent-abc", title: "Race" });

      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      summarizeChatHandoffMock.mockImplementation(async () => {
        await gate;
        return "briefing";
      });

      const manager = makeManager(store);
      const first = manager.handoffSession(source.id);
      const second = manager.handoffSession(source.id);
      release();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(secondResult).toBe(firstResult);
      expect(store.sessions.size).toBe(2);
      expect(store.createSession).toHaveBeenCalledTimes(1);
      expect(store.messages.filter((message) => message.sessionId === firstResult.session.id)).toHaveLength(1);
    });

    it("refuses a second sequential handoff instead of forking a second continuation", async () => {
      const source = store.seedEligibleSource({ id: "chat-source", agentId: "agent-abc", title: "Once" });
      summarizeChatHandoffMock.mockResolvedValue("briefing");
      const manager = makeManager(store);

      await manager.handoffSession(source.id);
      const error = await captureError(manager.handoffSession(source.id));

      expect((error as ChatHandoffError).code).toBe("source-not-active");
      expect(store.createSession).toHaveBeenCalledTimes(1);
      expect(store.sessions.size).toBe(2);
    });

    it("discards the half-built continuation when the source cannot be archived", async () => {
      const source = store.seedEligibleSource({ id: "chat-source", agentId: "agent-abc", title: "Archive fails" });
      summarizeChatHandoffMock.mockResolvedValue("briefing");
      store.archiveSession.mockRejectedValue(new Error("database is down"));

      const auditCalls: unknown[] = [];
      const manager = makeManager(store, { audit: (event) => auditCalls.push(event) });
      const error = await captureError(manager.handoffSession(source.id));

      expect((error as ChatHandoffError).code).toBe("archival-failed");
      expect((error as ChatHandoffError).status).toBe(500);
      // No orphan: the operator keeps an active source and no sibling pointing at nothing.
      expect(store.sessions.has("chat-2")).toBe(false);
      expect(store.sessions.size).toBe(1);
      expect(store.sessions.get(source.id)?.status).toBe("active");
      expect(store.messages.filter((message) => message.sessionId === "chat-2")).toHaveLength(0);
      expect(store.deleteSession).toHaveBeenCalledWith("chat-2");

      await vi.waitFor(() => expect(auditCalls).toHaveLength(1));
      expect(auditCalls[0]).toMatchObject({ mutationType: "chat:handoff-session-failed", target: `chat:${source.id}` });
      expect(auditMetadata(auditCalls)[0]).toMatchObject({ outcome: "archival-failed", refusalCode: "archival-failed" });
    });

    it("discards the continuation when a concurrent process already archived the source", async () => {
      const source = store.seedEligibleSource({ id: "chat-source", agentId: "agent-abc", title: "Cross-process race" });
      // Another process archives the source between the eligibility check and the re-read.
      summarizeChatHandoffMock.mockImplementation(async () => {
        source.status = "archived";
        return "briefing";
      });

      const manager = makeManager(store);
      const error = await captureError(manager.handoffSession(source.id));

      expect((error as ChatHandoffError).code).toBe("source-not-active");
      expect(store.sessions.size).toBe(1);
      expect(store.archiveSession).not.toHaveBeenCalled();
    });
  });
});

describe("buildHandoffTranscript — deterministic digest", () => {
  function message(overrides: Partial<ChatMessage>): ChatMessage {
    return {
      id: "msg",
      sessionId: "chat-1",
      role: "user",
      content: "",
      thinkingOutput: null,
      metadata: null,
      attachments: [],
      createdAt: "2026-09-09T00:00:00.000Z",
      ...overrides,
    } as ChatMessage;
  }

  it("renders chronological role-prefixed lines and collapses whitespace", () => {
    const digest = buildHandoffTranscript([
      message({ role: "user", content: "first\n\nline" }),
      message({ role: "assistant", content: "second" }),
    ]);
    expect(digest).toBe("(user) first line\n(assistant) second");
  });

  it("names attachments instead of embedding their content", () => {
    const digest = buildHandoffTranscript([
      message({ role: "user", content: "look", attachments: [{ id: "a", filename: "stored.png", originalName: "diagram.png", mimeType: "image/png", size: 12, createdAt: "" }] }),
    ]);
    expect(digest).toContain("[attached: diagram.png]");
    expect(digest).not.toContain("stored.png");
  });

  it("truncates an oversized single message to the per-message cap", () => {
    const digest = buildHandoffTranscript([message({ content: "x".repeat(5_000) })]);
    expect(digest.length).toBeLessThanOrEqual(1_300);
    expect(digest.endsWith("…")).toBe(true);
  });

  it("enforces the total cap by dropping the OLDEST lines and says so", () => {
    const messages = Array.from({ length: 40 }, (_unused, index) =>
      message({ id: `msg-${index}`, content: `m${index} ${"y".repeat(1_000)}` }),
    );
    const digest = buildHandoffTranscript(messages);
    expect(digest).toContain("earlier message(s) elided for length");
    expect(digest).not.toContain("m0 ");
    expect(digest).toContain("m39 ");
    const body = digest.split("\n").filter((line) => !line.startsWith("[")).join("\n");
    expect(body.length).toBeLessThanOrEqual(20_000);
  });

  it("announces a fetch-bound gap separately from a length-bound gap", () => {
    const digest = buildHandoffTranscript([message({ content: "kept" })], { earlierElided: true });
    expect(digest).toContain("were not read");
    expect(digest).not.toContain("elided for length");
  });

  it("is empty for an empty transcript and stable across repeated calls", () => {
    expect(buildHandoffTranscript([])).toBe("");
    const messages = [message({ content: "a" }), message({ role: "assistant", content: "b" })];
    expect(buildHandoffTranscript(messages)).toBe(buildHandoffTranscript(messages));
  });
});
