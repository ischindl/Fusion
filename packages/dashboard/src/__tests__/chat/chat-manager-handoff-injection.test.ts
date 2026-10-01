/**
 * RUFU-199 Step 5: one-time first-turn seeding of the handoff primer, gated on the primer
 * ROW's delivery stamp — never on `session.cliSessionFile`.
 *
 * The handoff child's model context is its file-backed pi session, NOT `chat_messages` rows, so the
 * role:"system" LLM briefing primer is display-only unless the FIRST prompt turn injects it. The gate
 * is load-bearing in both directions:
 *   - inject when the primer row exists and has no `handoffDeliveredAt` scalar;
 *   - stamp ONLY after the dispatch call returns, so a turn-1 exit between the `cliSessionFile`
 *     persist (SessionManager construction) and the dispatch (generation-fence return, pre-dispatch
 *     abort, or a ChatContextOverflowError refusal) leaves the primer PENDING — the naive
 *     `cliSessionFile`-based gate would suppress it forever and silently lose the entire handoff.
 *
 * Seam fidelity mirrors chat-manager-context-guard.test.ts: `@fusion/engine` is spread-mocked so the
 * real runtime stays intact and only `createResolvedAgentSession` / `promptWithFallback` /
 * `ensureContextWithinCompactionThreshold` are swapped. The fake ChatStore replicates production's
 * ONE-LEVEL metadata merge, which is what makes the "stamp must not clobber lineage" assertion real:
 * a stamp written as a nested `handoff` patch would erase fromSessionId/fromTitle/degraded here.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const { mockCreateResolvedAgentSession, mockPromptWithFallback, mockEnsureCompaction } = vi.hoisted(() => ({
  mockCreateResolvedAgentSession: vi.fn(),
  mockPromptWithFallback: vi.fn(),
  mockEnsureCompaction: vi.fn(),
}));

vi.mock("@fusion/engine", async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    createResolvedAgentSession: mockCreateResolvedAgentSession,
    promptWithFallback: mockPromptWithFallback,
    ensureContextWithinCompactionThreshold: mockEnsureCompaction,
  };
});

const { ChatManager } = await import("../../chat.js");
const { ChatContextOverflowError } = await import("@fusion/engine");

/*
FNXC:TestHygiene (ThreatCrush CWE-377): an exclusive temp dir, not a predictable OS temp path — the
scanner flags a fixed string. The manager never writes through it in these tests, only SessionManager
construction does, so behaviour parity with the guard suite holds.
*/
const TEST_ROOT = mkdtempSync(join(tmpdir(), "fusion-chat-inject-"));
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

interface FakeMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

type MetadataPatch = { messageId: string; patch: Record<string, unknown>; merge: boolean | undefined };

/**
 * Stateful ChatStore fake. The two seams the assertions depend on:
 *  - `getMessages({ order: "asc", limit })` returns insertion order (chronological) sliced to limit,
 *    which is exactly the bounded forward page resolveHandoffPrimerForInjection reads.
 *  - `updateMessageMetadata` mirrors the store's ONE-LEVEL merge (`{ ...existing, ...patch }`); a
 *    caller that patched `{ handoff: {...} }` would therefore DROP the other lineage keys here too.
 */
class FakeChatStore {
  sessions = new Map<string, Record<string, unknown>>();
  messages: FakeMessage[] = [];
  metadataPatches: MetadataPatch[] = [];
  cliSessionFileWrites: Array<{ sessionId: string; file: string | null }> = [];
  private seq = 0;

  seedSession(session: Record<string, unknown>): void {
    this.sessions.set(session.id as string, session);
  }

  seedPrimer(
    sessionId: string,
    handoff: Record<string, unknown>,
    opts: { deliveredAt?: string; content?: string } = {},
  ): string {
    const metadata: Record<string, unknown> = { handoff };
    if (opts.deliveredAt) metadata.handoffDeliveredAt = opts.deliveredAt;
    const id = "msg-primer";
    this.messages.push({
      id,
      sessionId,
      role: "system",
      content: opts.content ?? "BRIEFING BODY",
      metadata,
      createdAt: new Date(0).toISOString(),
    });
    return id;
  }

  primerRow(): FakeMessage | undefined {
    return this.messages.find((m) => m.id === "msg-primer");
  }

  getSession = vi.fn(async (id: string) => this.sessions.get(id) ?? null);

  getMessages = vi.fn(async (sessionId: string, filter?: { order?: "asc" | "desc"; limit?: number }) => {
    const rows = this.messages.filter((m) => m.sessionId === sessionId).map((m) => ({
      ...m,
      metadata: m.metadata ? { ...m.metadata } : m.metadata,
    }));
    const ordered = filter?.order === "desc" ? rows.reverse() : rows;
    return typeof filter?.limit === "number" ? ordered.slice(0, filter.limit) : ordered;
  });

  addMessage = vi.fn(async (sessionId: string, input: { role: string; content?: string; metadata?: Record<string, unknown> }) => {
    const msg: FakeMessage = {
      id: `msg-${(this.seq += 1)}`,
      sessionId,
      role: input.role,
      content: input.content ?? "",
      metadata: input.metadata,
      createdAt: new Date().toISOString(),
    };
    this.messages.push(msg);
    return { id: msg.id, createdAt: msg.createdAt };
  });

  getMessage = vi.fn(async (id: string) => this.messages.find((m) => m.id === id) ?? null);

  /*
  FNXC:ChatHandoff 2026-09-10-01:13: (RUFU-199 review) rewindSessionForEdit truncates through this
  seam, so the handoff re-arm tests need it. Mirrors the real store: everything from the target row
  onward disappears and everything before it (including the `role:"system"` primer) is retained.
  */
  deleteMessagesFrom = vi.fn(async (sessionId: string, fromMessageId: string) => {
    const rows = this.messages.filter((m) => m.sessionId === sessionId);
    const fromIndex = rows.findIndex((m) => m.id === fromMessageId);
    const deletedIds = fromIndex === -1 ? [] : rows.slice(fromIndex).map((m) => m.id);
    this.messages = this.messages.filter((m) => !(m.sessionId === sessionId && deletedIds.includes(m.id)));
    const retained = this.messages
      .filter((m) => m.sessionId === sessionId)
      .map((m) => ({ ...m, metadata: m.metadata ? { ...m.metadata } : m.metadata }));
    return { deletedIds, retained };
  });

  // Production-fidelity metadata write: merge is one level deep, replace overwrites.
  updateMessageMetadata = vi.fn(
    async (messageId: string, patch: Record<string, unknown>, options?: { merge?: boolean }) => {
      this.metadataPatches.push({ messageId, patch: { ...patch }, merge: options?.merge });
      const msg = this.messages.find((m) => m.id === messageId);
      if (!msg) return msg ?? null;
      msg.metadata = options?.merge ? { ...(msg.metadata ?? {}), ...patch } : { ...patch };
      return msg;
    },
  );

  updateSession = vi.fn(async (id: string, patch: Record<string, unknown>) => {
    const s = this.sessions.get(id);
    if (s) Object.assign(s, patch);
    return s ?? null;
  });

  setCliSessionFile = vi.fn(async (id: string, file: string | null) => {
    this.cliSessionFileWrites.push({ sessionId: id, file });
    const s = this.sessions.get(id);
    if (s) s.cliSessionFile = file;
    return s ?? null;
  });

  setInFlightGeneration = vi.fn(async () => {});
  setMessageMetadata = vi.fn(async () => {});
  recordTokenUsage = vi.fn(async () => {});
  createSession = vi.fn(async (input: Record<string, unknown>) => ({ id: "chat-created", ...input }));
  deleteSession = vi.fn(async (id: string) => {
    this.messages = this.messages.filter((m) => m.sessionId !== id);
    return this.sessions.delete(id);
  });
  getRoom = vi.fn(async () => null);
  listRoomMembers = vi.fn(async () => []);
  getRoomMessages = vi.fn(async () => []);
  addRoomMessage = vi.fn(async () => {});

  /** Patches that touched the primer row specifically (excludes the unrelated piParentLeafId write). */
  primerPatches(): MetadataPatch[] {
    return this.metadataPatches.filter((p) => p.messageId === "msg-primer");
  }
}

function makeAgentSession() {
  return {
    model: { provider: "anthropic", id: "claude-sonnet-5", contextWindow: 200_000, maxTokens: 8_192 },
    state: { messages: [] as Array<{ role: string; content?: string }> },
    getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000, percent: null }),
    compact: vi.fn(async () => null),
    dispose: vi.fn(),
  };
}

function makeManager(store: FakeChatStore) {
  return new ChatManager(store as never, TEST_ROOT, undefined, undefined, async () => ({}), undefined, undefined);
}

// A handoff child session whose cliSessionFile is ALREADY persisted — the exact state a naive
// file-based gate would misread as "primer already delivered".
function seedHandoffChild(store: FakeChatStore, overrides: Record<string, unknown> = {}): void {
  store.seedSession({
    id: "chat-child",
    projectId: "proj-1",
    agentId: "__fn_agent__",
    title: "Continue: Ship the gate",
    modelProvider: "anthropic",
    modelId: "claude-sonnet-5",
    thinkingLevel: "high",
    roomId: null,
    cliSessionFile: join(TEST_ROOT, "already-present.jsonl"),
    ...overrides,
  });
  store.seedPrimer("chat-child", { fromSessionId: "chat-source", fromTitle: "Ship the gate", degraded: false });
}

function promptOf(callIndex = 0): string {
  return String(mockPromptWithFallback.mock.calls[callIndex]?.[1] ?? "");
}

/**
 * A pi-shaped assistant turn, used only to seed a real session file (pi persists on assistant append).
 * Mirrors the fixture in chat-manager-rewind-session.test.ts.
 */
function makePiAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "chat",
    provider: "anthropic",
    model: "claude-sonnet-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateResolvedAgentSession.mockImplementation(async () => ({
    session: makeAgentSession(),
    model: { provider: "anthropic", modelId: "claude-sonnet-5" },
  }));
  mockPromptWithFallback.mockImplementation(async () => undefined);
  // Default: the gate passes (no truncation), so dispatch is reached.
  mockEnsureCompaction.mockImplementation(async () => undefined);
});

describe("ChatManager.sendMessage — handoff primer one-time injection (RUFU-199 Step 5)", () => {
  it("injects the primer into the first prompt content exactly once, even though cliSessionFile is already set", async () => {
    const store = new FakeChatStore();
    seedHandoffChild(store);
    // Premise: the file pointer is non-null before any prompt reaches the model.
    expect(store.sessions.get("chat-child")?.cliSessionFile).toBeTruthy();

    await makeManager(store).sendMessage("chat-child", "hello world");

    expect(mockPromptWithFallback).toHaveBeenCalledTimes(1);
    const prompt = promptOf(0);
    expect(prompt).toContain("BRIEFING BODY");
    expect(prompt).toContain('[Handoff from conversation "Ship the gate"]');
    expect(prompt).toContain("hello world");
    expect((prompt.match(/BRIEFING BODY/g) ?? []).length).toBe(1);
    // The briefing rides the model prompt only — the persisted user row stays the raw text, so the
    // primer never appears as a second user-visible message.
    const userRow = store.messages.find((m) => m.role === "user");
    expect(userRow?.content).toBe("hello world");
    expect(userRow?.content).not.toContain("BRIEFING BODY");
  });

  it("does not inject on a later turn once the durable delivery stamp exists", async () => {
    const store = new FakeChatStore();
    seedHandoffChild(store);
    const manager = makeManager(store);

    await manager.sendMessage("chat-child", "first turn");
    expect(promptOf(0)).toContain("BRIEFING BODY");

    await manager.sendMessage("chat-child", "second turn");
    expect(mockPromptWithFallback).toHaveBeenCalledTimes(2);
    expect(promptOf(1)).not.toContain("BRIEFING BODY");
    expect(promptOf(1)).toContain("second turn");
  });

  it("stamps the primer with a top-level scalar after dispatch and preserves the lineage object", async () => {
    const store = new FakeChatStore();
    seedHandoffChild(store);

    await makeManager(store).sendMessage("chat-child", "hello");

    const primer = store.primerRow();
    expect(typeof primer?.metadata?.handoffDeliveredAt).toBe("string");
    // The lineage object survives the merge untouched.
    expect(primer?.metadata?.handoff).toEqual({ fromSessionId: "chat-source", fromTitle: "Ship the gate", degraded: false });
    // The stamp must be a top-level scalar; a patch that touched the nested `handoff` key would have
    // erased fromSessionId/fromTitle/degraded via the one-level merge.
    const primerPatches = store.primerPatches();
    expect(primerPatches.length).toBeGreaterThan(0);
    for (const patch of primerPatches) {
      expect(patch.patch).not.toHaveProperty("handoff");
      expect(patch.merge).toBe(true);
    }
  });

  describe("re-injects after every turn-1 exit that precedes the dispatch, with cliSessionFile already persisted", () => {
    it("generation-fence mismatch return (a newer generation replaced this one)", async () => {
      const store = new FakeChatStore();
      seedHandoffChild(store);
      const manager = makeManager(store);

      // Simulate a concurrent send taking the generation slot mid-flight, so the fence returns
      // without dispatching — the primer must stay pending.
      mockCreateResolvedAgentSession.mockImplementation(async () => {
        manager.beginGeneration("chat-child");
        return { session: makeAgentSession(), model: { provider: "anthropic", modelId: "claude-sonnet-5" } };
      });

      await manager.sendMessage("chat-child", "interrupted turn");

      expect(mockPromptWithFallback).not.toHaveBeenCalled();
      expect(store.primerPatches().some((p) => "handoffDeliveredAt" in p.patch)).toBe(false);
      // cliSessionFile was persisted by resolveCliSessionManager before the fence — the fact the file
      // exists must NOT be what suppresses the primer.
      expect(store.sessions.get("chat-child")?.cliSessionFile).toBeTruthy();

      // The next ordinary send still injects — the exit left the primer pending.
      mockCreateResolvedAgentSession.mockImplementation(async () => ({
        session: makeAgentSession(),
        model: { provider: "anthropic", modelId: "claude-sonnet-5" },
      }));
      await manager.sendMessage("chat-child", "retry turn");
      expect(promptOf(0)).toContain("BRIEFING BODY");
    });

    it("pre-dispatch abort throw (cancellation requested before the prompt)", async () => {
      const store = new FakeChatStore();
      seedHandoffChild(store);
      const manager = makeManager(store);
      const { generationId, abortController } = manager.beginGeneration("chat-child");
      abortController.abort();

      await manager.sendMessage("chat-child", "cancelled turn", undefined, undefined, undefined, { generationId });

      expect(mockPromptWithFallback).not.toHaveBeenCalled();
      expect(store.primerPatches().some((p) => "handoffDeliveredAt" in p.patch)).toBe(false);

      // A fresh send (new generation) re-injects the primer.
      await manager.sendMessage("chat-child", "retry turn");
      expect(promptOf(0)).toContain("BRIEFING BODY");
    });

    it("compaction-gate ChatContextOverflowError refusal (a compaction refusal does not consume the primer)", async () => {
      const store = new FakeChatStore();
      seedHandoffChild(store);
      const manager = makeManager(store);

      mockEnsureCompaction.mockImplementation(async () => {
        throw new ChatContextOverflowError("context exceeds the model window");
      });
      await manager.sendMessage("chat-child", "overflow turn");

      expect(mockPromptWithFallback).not.toHaveBeenCalled();
      expect(store.primerPatches().some((p) => "handoffDeliveredAt" in p.patch)).toBe(false);
      // The gate itself ran — independence from compaction is exercised, not assumed.
      expect(mockEnsureCompaction).toHaveBeenCalled();

      // With compaction now passing, the still-pending primer injects on the next send. The
      // overflow send never reached dispatch, so this retry is promptWithFallback call[0].
      mockEnsureCompaction.mockImplementation(async () => undefined);
      await manager.sendMessage("chat-child", "retry turn");
      expect(promptOf(0)).toContain("BRIEFING BODY");
    });
  });

  it("counts a post-dispatch cancellation as delivered (no re-injection after the prompt returned)", async () => {
    const store = new FakeChatStore();
    seedHandoffChild(store);
    const manager = makeManager(store);
    const { generationId, abortController } = manager.beginGeneration("chat-child");

    // The abort lands DURING dispatch — the model already received the primer, so the stamp block
    // runs before the post-dispatch cancellation check and the primer is consumed.
    mockPromptWithFallback.mockImplementation(async () => {
      abortController.abort();
    });

    await manager.sendMessage("chat-child", "turn", undefined, undefined, undefined, { generationId });

    expect(promptOf(0)).toContain("BRIEFING BODY");
    expect(store.primerPatches().some((p) => "handoffDeliveredAt" in p.patch)).toBe(true);

    await manager.sendMessage("chat-child", "next turn");
    expect(promptOf(1)).not.toContain("BRIEFING BODY");
  });

  it("never injects for an ordinary (non-handoff) first message", async () => {
    const store = new FakeChatStore();
    store.seedSession({
      id: "chat-plain",
      projectId: "proj-1",
      agentId: null,
      title: "Ordinary chat",
      modelProvider: "anthropic",
      modelId: "claude-sonnet-5",
      roomId: null,
    });

    await makeManager(store).sendMessage("chat-plain", "hello there");

    expect(mockPromptWithFallback).toHaveBeenCalledTimes(1);
    expect(promptOf(0)).not.toContain("[Handoff from conversation");
    expect(promptOf(0)).not.toContain("BRIEFING BODY");
    expect(promptOf(0)).toContain("hello there");
  });
});

/*
FNXC:ChatHandoff 2026-09-10-01:13:
RUFU-199 code-review regression: the pi session file IS the model's context, and every
`rewindSessionForEdit` branch that REPLACES that file (first-turn fresh session, retained-history
rebuild, clear-on-failure) also destroys the briefing turn 1 injected as prompt text, because the
rebuild replays only `user`/`assistant` rows. If the retained primer row kept its `handoffDeliveredAt`
stamp the injection gate stayed closed and the model continued with ZERO inherited context while the
"Continues from <title>" notice still claimed continuity — a silent-empty-handoff at edit time. So the
gate must be re-armed on those branches. The control rewinds mid-conversation from a RECORDED REAL pi
leaf: that path keeps turn 1 (and the briefing embedded in it), so re-arming there would only duplicate
the briefing and the stamp must survive. The control also proves the branch path actually ran, so
"no clear" is a decision rather than a skipped code path.
*/
describe("ChatManager.rewindSessionForEdit — re-arms the handoff primer after pi context loss (RUFU-199 review)", () => {
  const last = <T,>(items: T[]): T | undefined => items[items.length - 1];
  const handoffChildSession = (cliSessionFile: string | null) => ({
    id: "chat-child",
    projectId: "proj-1",
    agentId: "__fn_agent__",
    title: "Continue: Ship the gate",
    modelProvider: "anthropic",
    modelId: "claude-sonnet-5",
    thinkingLevel: "high",
    roomId: null,
    cliSessionFile,
  });
  const lineage = { fromSessionId: "chat-source", fromTitle: "Ship the gate", degraded: false };

  it("re-arms after a first-message edit so the edited resend reaches the model briefed again", async () => {
    const store = new FakeChatStore();
    seedHandoffChild(store);
    const manager = makeManager(store);

    await manager.sendMessage("chat-child", "first turn");
    const firstUser = store.messages.find((m) => m.role === "user");
    expect(firstUser).toBeDefined();
    /*
     * Precondition for the fresh-session branch: production records the pre-prompt pi leaf on the user
     * row and an untouched session has none. Dispatch is mocked here, so the file never advances —
     * state the precondition instead of inheriting it from pi internals.
     */
    await store.updateMessageMetadata(firstUser!.id, { piParentLeafId: null });
    // The briefing was delivered, so an ordinary next turn would NOT have re-injected it.
    expect(typeof store.primerRow()?.metadata?.handoffDeliveredAt).toBe("string");

    await manager.rewindSessionForEdit("chat-child", firstUser!.id);

    // The clear is a top-level null scalar merged in — never a nested `handoff` patch, which the
    // one-level merge would use to erase the lineage the visible notice reads.
    const clearPatch = last(store.primerPatches());
    expect(clearPatch?.patch).toEqual({ handoffDeliveredAt: null });
    expect(clearPatch?.merge).toBe(true);
    expect(store.primerRow()?.metadata?.handoff).toEqual(lineage);
    expect(typeof store.primerRow()?.metadata?.handoffDeliveredAt).not.toBe("string");

    // The load-bearing half: the edited resend carries the briefing again. Without the re-arm the new
    // empty pi file would hold none and the model would continue unbriefed under a continuity notice.
    await manager.sendMessage("chat-child", "edited turn");
    expect(mockPromptWithFallback).toHaveBeenCalledTimes(2);
    expect(promptOf(1)).toContain("BRIEFING BODY");
    expect(promptOf(1)).toContain("edited turn");
  });

  it("re-arms after the retained-history rebuild, including a stamp this process never wrote", async () => {
    const store = new FakeChatStore();
    store.seedSession(handoffChildSession(null));
    // A PREVIOUS process delivered and stamped the briefing: this manager has no in-process entry, so
    // only the durable scalar can be wrong — which is the cross-process case the re-arm must also fix.
    store.seedPrimer("chat-child", lineage, { deliveredAt: "2026-09-09T12:00:00.000Z" });
    const firstUser = await store.addMessage("chat-child", { role: "user", content: "first turn" });
    const manager = makeManager(store);

    // No `piParentLeafId` on the row (a pre-feature message) routes to the text-only rebuild, which
    // replays only user/assistant rows and therefore cannot carry a role:"system" primer.
    const { retained } = await manager.rewindSessionForEdit("chat-child", firstUser.id);
    expect(retained.map((m) => m.role)).toEqual(["system"]);

    const clearPatch = store.primerPatches().find((p) => "handoffDeliveredAt" in p.patch);
    expect(clearPatch?.patch).toEqual({ handoffDeliveredAt: null });
    expect(typeof store.primerRow()?.metadata?.handoffDeliveredAt).not.toBe("string");

    await manager.sendMessage("chat-child", "edited turn");
    expect(promptOf(0)).toContain("BRIEFING BODY");
    expect(promptOf(0)).toContain("edited turn");
  });

  it("control: a mid-conversation edit branches from a recorded real leaf, keeps the briefing, and must NOT re-arm", async () => {
    const store = new FakeChatStore();
    /*
     * A real file-backed pi session, as a genuine two-turn conversation leaves it. Turn 1's text stands
     * in for the prompt the model actually received, so the briefing is embedded in it exactly as in
     * production. The assistant reply is load-bearing for the SEEDING, not for the behaviour: pi only
     * writes the JSONL when an assistant message is appended, so a user-only seed leaves
     * `existsSync(cliSessionFile)` false and `resolveCliSessionManager` would silently swap in a fresh
     * empty session, making this control test the wrong thing.
     */
    const seed = SessionManager.create(TEST_ROOT);
    const originalFile = seed.getSessionFile();
    expect(originalFile).toBeTruthy();
    seed.appendMessage({
      role: "user",
      content: '[Handoff from conversation "Ship the gate"]\n\nBRIEFING BODY\n\nfirst turn',
      timestamp: Date.now(),
    });
    seed.appendMessage(makePiAssistantMessage("first reply"));
    // Production records the leaf BEFORE prompting, so turn 2's parent is the leaf after turn 1's reply.
    const leafAfterTurn1 = seed.getLeafId();
    expect(leafAfterTurn1).toBeTruthy();
    seed.appendMessage({ role: "user", content: "second turn", timestamp: Date.now() });

    store.seedSession(handoffChildSession(originalFile!));
    store.seedPrimer("chat-child", lineage, { deliveredAt: "2026-09-09T12:00:00.000Z" });
    await store.addMessage("chat-child", { role: "user", content: "first turn" });
    const secondUser = await store.addMessage("chat-child", {
      role: "user",
      content: "second turn",
      metadata: { piParentLeafId: leafAfterTurn1 },
    });
    const manager = makeManager(store);

    const { retained } = await manager.rewindSessionForEdit("chat-child", secondUser.id);
    expect(retained.map((m) => m.role)).toEqual(["system", "user"]);

    // Non-vacuity: the branch really materialized a NEW file, and that file still carries the briefing
    // — so the absence of a clear below is the re-arm declining to run, not the rewind failing to run.
    const adoptedFile = last(store.cliSessionFileWrites);
    expect(adoptedFile?.file).toBeTruthy();
    expect(adoptedFile?.file).not.toBe(originalFile);
    const branchedTexts = JSON.stringify(
      SessionManager.open(adoptedFile!.file!).buildSessionContext().messages.map((m: { content?: unknown }) => m.content),
    );
    expect(branchedTexts).toContain("BRIEFING BODY");
    expect(branchedTexts).not.toContain("second turn");

    // The branched context still holds turn 1 and its embedded briefing, so the delivery record stands.
    expect(store.primerPatches().some((p) => "handoffDeliveredAt" in p.patch)).toBe(false);
    expect(typeof store.primerRow()?.metadata?.handoffDeliveredAt).toBe("string");

    // And the next send does not duplicate a briefing the context already carries.
    await manager.sendMessage("chat-child", "corrected turn");
    expect(promptOf(0)).not.toContain("BRIEFING BODY");
    expect(promptOf(0)).toContain("corrected turn");
  });
});
