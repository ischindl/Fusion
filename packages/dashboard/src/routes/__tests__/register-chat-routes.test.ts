// @vitest-environment node

import express from "express";
import multer from "multer";
import { describe, expect, it, vi } from "vitest";
import { registerChatRoutes } from "../register-chat-routes.js";
import { request } from "../../test-request.js";

function makeApp(overrides?: { settings?: Record<string, unknown>; sessions?: unknown[]; messages?: unknown[] }) {
  const sessions = overrides?.sessions ?? [{
    id: "chat-1", agentId: "agent-1", tags: [], title: "First", status: "active", projectId: "project-a",
    modelProvider: null, modelId: null, thinkingLevel: null, memoryFocus: null, createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z", pinnedAt: null, cliSessionFile: null, cliExecutorAdapterId: null, inFlightGeneration: null,
  }];
  const listSessionsPage = vi.fn(async () => ({ sessions, total: 2, hasMore: true, nextCursor: "next" }));
  const findLatestActiveSessionForTarget = vi.fn(async () => null);
  const chatStore = {
    listSessionsPage,
    findLatestActiveSessionForTarget,
    getLastMessageForSessions: vi.fn(async () => new Map()),
    searchSessionsByMessageContent: vi.fn(async () => new Map()),
    getSession: vi.fn(async (id: string) => sessions.find((session) => (session as { id?: string }).id === id) ?? null),
    getMessages: vi.fn(async () => overrides?.messages ?? []),
    getMessage: vi.fn(async (id: string) => (overrides?.messages ?? []).find((message) => (message as { id?: string }).id === id) ?? undefined),
  };
  const store = {
    getSettings: vi.fn(async () => overrides?.settings ?? { showTaskChatsInCommonFeed: false }),
    getFusionDir: () => "/route-project/.fusion",
    getAsyncLayer: () => undefined,
  };
  const app = express();
  const router = express.Router();
  registerChatRoutes({
    router,
    store,
    options: { chatStore },
    getProjectContext: async () => ({ store, projectId: "project-a", engine: undefined }),
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as never, { parseLastEventId: () => undefined, replayBufferedSSE: () => false, validateOptionalModelField: (value: unknown) => value as string | undefined, upload: multer() });
  app.use("/api", router);
  app.use((error: { statusCode?: number; status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode ?? error.status ?? 500).json({ error: error.message }));
  return { app, listSessionsPage };
}

describe("GET /api/chat/sessions pagination", () => {
  it("returns bounded page metadata and forwards filters before enrichment", async () => {
    const { app, listSessionsPage } = makeApp();
    const response = await request(app, "GET", "/api/chat/sessions?projectId=project-a&status=active&limit=25&cursor=opaque&tagId=tag-a&q=needle");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 2, hasMore: true, nextCursor: "next" });
    expect(response.body.sessions).toHaveLength(1);
    expect(listSessionsPage).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-a", status: "active", limit: 25, cursor: "opaque", tagId: "tag-a", q: "needle" }));
  });

  /*
  FNXC:ChatSidebarPerf 2026-09-16-02:15:
  The list response must publish the effective task-chat common-feed visibility so the browser
  snapshot can replay that project gate offline instead of discarding every task conversation on a
  cold open. It is always a strict boolean, is present on an empty page, and never appears on
  `lookup=resume`.
  */
  it("publishes taskChatsVisibleInCommonFeed=false with default settings", async () => {
    const { app } = makeApp();
    const response = await request(app, "GET", "/api/chat/sessions?projectId=project-a");
    expect(response.status).toBe(200);
    expect(response.body.taskChatsVisibleInCommonFeed).toBe(false);
  });

  it("publishes taskChatsVisibleInCommonFeed=true when the project setting is enabled", async () => {
    const { app } = makeApp({ settings: { showTaskChatsInCommonFeed: true } });
    const response = await request(app, "GET", "/api/chat/sessions?projectId=project-a");
    expect(response.status).toBe(200);
    expect(response.body.taskChatsVisibleInCommonFeed).toBe(true);
  });

  it("publishes taskChatsVisibleInCommonFeed=false when settings omit the key", async () => {
    const { app } = makeApp({ settings: {} });
    const response = await request(app, "GET", "/api/chat/sessions?projectId=project-a");
    expect(response.status).toBe(200);
    expect(response.body.taskChatsVisibleInCommonFeed).toBe(false);
  });

  it("publishes taskChatsVisibleInCommonFeed on an empty page", async () => {
    const { app } = makeApp({ settings: { showTaskChatsInCommonFeed: true }, sessions: [] });
    const response = await request(app, "GET", "/api/chat/sessions?projectId=project-a");
    expect(response.status).toBe(200);
    expect(response.body.sessions).toHaveLength(0);
    expect(response.body.taskChatsVisibleInCommonFeed).toBe(true);
  });

  it("omits taskChatsVisibleInCommonFeed from lookup=resume responses", async () => {
    const { app } = makeApp({ settings: { showTaskChatsInCommonFeed: true } });
    const response = await request(app, "GET", "/api/chat/sessions?projectId=project-a&lookup=resume&agentId=agent-1");
    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty("taskChatsVisibleInCommonFeed");
    expect(response.body).not.toHaveProperty("total");
  });

  it.each(["limit=0", "limit=201", "limit=nope", "status=deleted"])("rejects invalid list input without querying: %s", async (query) => {
    const { app, listSessionsPage } = makeApp();
    const response = await request(app, "GET", `/api/chat/sessions?${query}`);
    expect(response.status).toBe(400);
    expect(listSessionsPage).not.toHaveBeenCalled();
  });
});

/*
FNXC:ChatFeedCompaction 2026-09-17-15:38:
The list feed ships compacted tool calls (identity/status/preview, no bodies) so a 50-row thread
stays small; question tool calls stay whole and the sibling single-message route returns full
bodies for lazy disclosures, enforcing message→session ownership.
*/
describe("chat message feed compaction + single-message companion", () => {
  const assistantMessage = (overrides: Record<string, unknown> = {}) => ({
    id: "msg-1",
    sessionId: "chat-1",
    role: "assistant",
    content: "done",
    createdAt: "2026-09-17T00:00:00.000Z",
    metadata: {
      interrupted: false,
      toolCalls: [
        { toolName: "bash", args: { command: "ls" }, result: "y".repeat(400), isError: false, status: "completed" },
        { toolName: "ask_user", args: { questions: [{ id: "q1", type: "text", question: "Which branch?" }] }, isError: false, status: "completed" },
      ],
    },
    ...overrides,
  });

  it("compacts the list feed but keeps question tool calls and other metadata intact", async () => {
    const { app } = makeApp({ messages: [assistantMessage()] });
    const response = await request(app, "GET", "/api/chat/sessions/chat-1/messages?projectId=project-a");
    expect(response.status).toBe(200);
    const [message] = response.body.messages;
    expect(message.metadata.interrupted).toBe(false);
    const [bash, question] = message.metadata.toolCalls;
    expect(bash).toMatchObject({ toolName: "bash", compacted: true, status: "completed", previewKind: "result" });
    expect(bash).not.toHaveProperty("result");
    expect(bash).not.toHaveProperty("args");
    expect(question.toolName).toBe("ask_user");
    expect(question.args).toEqual({ questions: [{ id: "q1", type: "text", question: "Which branch?" }] });
    expect(question).not.toHaveProperty("compacted");
  });

  it("returns full bodies when the feed is requested with full=1", async () => {
    const { app } = makeApp({ messages: [assistantMessage()] });
    const response = await request(app, "GET", "/api/chat/sessions/chat-1/messages?projectId=project-a&full=1");
    const [message] = response.body.messages;
    expect(message.metadata.toolCalls[0].result).toBe("y".repeat(400));
  });

  it("returns one full message for a lazy disclosure and enforces session ownership", async () => {
    const { app } = makeApp({ messages: [assistantMessage()] });
    const found = await request(app, "GET", "/api/chat/sessions/chat-1/messages/msg-1?projectId=project-a");
    expect(found.status).toBe(200);
    expect(found.body.message.metadata.toolCalls[0].result).toBe("y".repeat(400));

    const foreign = await request(app, "GET", "/api/chat/sessions/chat-9/messages/msg-1?projectId=project-a");
    expect(foreign.status).toBe(404);
    const missing = await request(app, "GET", "/api/chat/sessions/chat-1/messages/msg-404?projectId=project-a");
    expect(missing.status).toBe(404);
  });
});
