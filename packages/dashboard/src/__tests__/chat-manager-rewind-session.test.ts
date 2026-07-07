/*
FNXC:ChatMessageEdit 2026-07-07-09:00:
"Forget everything after" seam test for FN-7628. Deleting `chat_messages` rows alone does NOT
make the model forget a discarded turn — the pi SessionManager file is a separate append-only
transcript that the model-loop path resumes from (see chat.ts `resolveCliSessionManager`). This
test proves the rewind at the seam that actually matters: after
`ChatManager.rewindSessionForEdit`, re-opening the SAME on-disk pi session file and calling
`buildSessionContext()` no longer includes the discarded turn's content, while the retained
turn's content survives. It deliberately does NOT mock `@earendil-works/pi-coding-agent` — a
real, temp-directory-backed `SessionManager` is used so the assertion exercises the actual
`branch()`/`resetLeaf()` behavior described in `session-manager.d.ts`, not a stub.
*/
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { ChatManager } from "../chat.js";
import { ChatStore, Database } from "@fusion/core";
import { SessionManager } from "@earendil-works/pi-coding-agent";

function makeAssistantMessage(text: string) {
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

function extractText(context: ReturnType<SessionManager["buildSessionContext"]>): string[] {
  return context.messages.flatMap((message: any) => {
    if (typeof message.content === "string") return [message.content];
    if (Array.isArray(message.content)) {
      return message.content
        .filter((part: any) => part?.type === "text")
        .map((part: any) => part.text as string);
    }
    return [];
  });
}

describe("ChatManager.rewindSessionForEdit — pi session context seam (real SessionManager)", () => {
  let tmpDir: string;
  let db: Database;
  let chatStore: ChatStore;
  let chatManager: ChatManager;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fn-chat-rewind-test-"));
    const fusionDir = join(tmpDir, ".fusion");
    db = new Database(fusionDir, { inMemory: true });
    db.init();
    chatStore = new ChatStore(fusionDir, db);
    chatManager = new ChatManager(chatStore, tmpDir);
  });

  afterAll(async () => {
    try {
      db.close();
    } catch {
      // already closed
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("primary path (recorded parent-leaf id): branch() forgets the edited turn and everything after it", async () => {
    const session = chatStore.createSession({ agentId: "agent-001" });

    // Seed a real, file-backed pi session with two user/assistant turn pairs, mirroring what
    // ChatManager.sendMessage would have produced across two prior chat turns.
    const seedManager = SessionManager.create(tmpDir);
    const sessionFile = seedManager.getSessionFile();
    expect(sessionFile).toBeTruthy();
    chatStore.setCliSessionFile(session.id, sessionFile!);

    seedManager.appendMessage({ role: "user", content: "first turn", timestamp: Date.now() });
    seedManager.appendMessage(makeAssistantMessage("first reply"));
    const leafAfterTurn1 = seedManager.getLeafId();

    seedManager.appendMessage({ role: "user", content: "second turn", timestamp: Date.now() });
    seedManager.appendMessage(makeAssistantMessage("second reply"));

    // Persist the corresponding chat_messages rows, recording the second user turn's pi
    // parent-leaf id the way ChatManager.sendMessage does before calling prompt().
    const m1 = chatStore.addMessage(session.id, { role: "user", content: "first turn" });
    chatStore.addMessage(session.id, { role: "assistant", content: "first reply" });
    const m3 = chatStore.addMessage(session.id, { role: "user", content: "second turn" });
    chatStore.updateMessageMetadata(m3.id, { piParentLeafId: leafAfterTurn1 });
    chatStore.addMessage(session.id, { role: "assistant", content: "second reply" });

    // Sanity: before the edit, the full pi context includes both turns.
    const beforeTexts = extractText(seedManager.buildSessionContext());
    expect(beforeTexts).toContain("first turn");
    expect(beforeTexts).toContain("second turn");
    expect(beforeTexts).toContain("second reply");

    const { retained } = await chatManager.rewindSessionForEdit(session.id, m3.id);
    expect(retained.map((m) => m.id)).toEqual([m1.id, expect.any(String)]);
    expect(retained.map((m) => m.content)).toEqual(["first turn", "first reply"]);

    // The DB truncation alone is not the seam that matters — assert the persisted rows too,
    // but the load-bearing assertion is the pi session context below.
    expect(chatStore.getMessages(session.id).map((m) => m.content)).toEqual(["first turn", "first reply"]);

    // The rewind materializes a NEW session file (createBranchedSession) and repoints the
    // chat row at it — branch()/resetLeaf() alone only mutate an in-memory leaf pointer and do
    // not survive a fresh SessionManager.open() on the next turn, so re-fetch the file the next
    // real send would actually resume from and prove the discarded turn is unreachable there.
    const rewoundSession = chatStore.getSession(session.id)!;
    expect(rewoundSession.cliSessionFile).not.toBe(sessionFile);
    const reopened = SessionManager.open(rewoundSession.cliSessionFile!);
    const afterTexts = extractText(reopened.buildSessionContext());
    expect(afterTexts).toContain("first turn");
    expect(afterTexts).toContain("first reply");
    expect(afterTexts).not.toContain("second turn");
    expect(afterTexts).not.toContain("second reply");

    // The OLD file is never mutated (append-only tree semantics) — the discarded turn is still
    // physically present there, which is why repointing cliSessionFile (not just moving an
    // in-memory leaf) is the part of this fix that actually matters.
    const oldFileStillHasDiscardedTurn = extractText(SessionManager.open(sessionFile!).buildSessionContext());
    expect(oldFileStillHasDiscardedTurn).toContain("second turn");
  });

  it("primary path, first-turn edit (no recorded parent leaf): resetLeaf() forgets everything", async () => {
    const session = chatStore.createSession({ agentId: "agent-001" });

    const seedManager = SessionManager.create(tmpDir);
    const sessionFile = seedManager.getSessionFile();
    chatStore.setCliSessionFile(session.id, sessionFile!);

    // First turn: parent leaf is null (nothing before it).
    seedManager.appendMessage({ role: "user", content: "only turn", timestamp: Date.now() });
    seedManager.appendMessage(makeAssistantMessage("only reply"));

    const m1 = chatStore.addMessage(session.id, { role: "user", content: "only turn" });
    chatStore.updateMessageMetadata(m1.id, { piParentLeafId: null });
    chatStore.addMessage(session.id, { role: "assistant", content: "only reply" });

    const { retained } = await chatManager.rewindSessionForEdit(session.id, m1.id);
    expect(retained).toEqual([]);

    const rewoundSession = chatStore.getSession(session.id)!;
    expect(rewoundSession.cliSessionFile).not.toBe(sessionFile);
    const reopened = SessionManager.open(rewoundSession.cliSessionFile!);
    const afterTexts = extractText(reopened.buildSessionContext());
    expect(afterTexts).not.toContain("only turn");
    expect(afterTexts).not.toContain("only reply");
  });

  it("rejects editing a non-user message", async () => {
    const session = chatStore.createSession({ agentId: "agent-001" });
    const seedManager = SessionManager.create(tmpDir);
    chatStore.setCliSessionFile(session.id, seedManager.getSessionFile()!);
    const assistantMsg = chatStore.addMessage(session.id, { role: "assistant", content: "hi" });

    await expect(chatManager.rewindSessionForEdit(session.id, assistantMsg.id)).rejects.toThrow(/user message/);
  });

  it("rejects an edit while a generation is in flight for the session", async () => {
    const session = chatStore.createSession({ agentId: "agent-001" });
    const seedManager = SessionManager.create(tmpDir);
    chatStore.setCliSessionFile(session.id, seedManager.getSessionFile()!);
    const userMsg = chatStore.addMessage(session.id, { role: "user", content: "hi" });

    chatManager.beginGeneration(session.id);
    try {
      await expect(chatManager.rewindSessionForEdit(session.id, userMsg.id)).rejects.toThrow(/generation is currently in progress/);
    } finally {
      chatManager.cancelGeneration(session.id);
    }
  });
});
