// @vitest-environment node

/*
FNXC:ChatHandoff 2026-09-08-00:00:
RUFU-199 route surface for the cross-session handoff. The route is a thin translator over
ChatManager.handoffSession, so these tests pin the TRANSLATION contract the manager cannot own:
- the happy-path response shape (session/degraded/summaryChars/sourceSessionId),
- that a ChatHandoffError's status is forwarded verbatim (404/409/500) with its fixed code in the body,
- a 503 when no chat manager is resolvable, and
- that a request body can never smuggle a different agent/model target: the route forwards ONLY the
  source session id to the manager, so the continuation always inherits the source's target.
*/

import express from "express";
import type { NextFunction } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../../test-request.js";
import { registerChatRoutes } from "../../routes/register-chat-routes.js";
import { ChatHandoffError } from "../../chat.js";

const { mockResolveProjectChatContext, mockGetOrCreateScopedChatManager } = vi.hoisted(() => ({
  mockResolveProjectChatContext: vi.fn(),
  mockGetOrCreateScopedChatManager: vi.fn(),
}));

vi.mock("../../chat-project-services.js", () => ({
  resolveProjectChatContext: mockResolveProjectChatContext,
  getOrCreateScopedChatManager: mockGetOrCreateScopedChatManager,
}));

interface ManagerLike {
  handoffSession: ReturnType<typeof vi.fn>;
}

function buildApp(manager: ManagerLike) {
  const app = express();
  app.use(express.json());
  const router = express.Router();

  registerChatRoutes({
    router,
    store: {} as never,
    options: {} as never,
    chatLogger: { error: vi.fn(), warn: vi.fn(), log: vi.fn() } as never,
    getProjectContext: async () => ({ store: {}, projectId: "project-a", engine: undefined }),
    rethrowAsApiError: (error: unknown): never => {
      throw error;
    },
  } as never, {
    parseLastEventId: () => undefined,
    replayBufferedSSE: () => false,
    validateOptionalModelField: () => undefined,
    upload: {
      single: () => (_req: unknown, _res: unknown, next: () => void) => next(),
      array: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    } as never,
  });

  app.use("/api", router);
  // The route throws ApiError; without a boundary the error paths would hang rather than assert status.
  app.use((err: { statusCode?: number; details?: Record<string, unknown>; message?: string }, _req: express.Request, res: express.Response, _next: NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? "unknown", details: err?.details });
  });

  return app;
}

function buildAppWithoutManager() {
  const app = express();
  app.use(express.json());
  const router = express.Router();

  registerChatRoutes({
    router,
    store: {} as never,
    // No projectId + no options.chatManager -> the scoped-manager resolver 503s.
    options: {} as never,
    chatLogger: { error: vi.fn(), warn: vi.fn(), log: vi.fn() } as never,
    getProjectContext: async () => ({ store: {}, projectId: undefined, engine: undefined }),
    rethrowAsApiError: (error: unknown): never => {
      throw error;
    },
  } as never, {
    parseLastEventId: () => undefined,
    replayBufferedSSE: () => false,
    validateOptionalModelField: () => undefined,
    upload: {
      single: () => (_req: unknown, _res: unknown, next: () => void) => next(),
      array: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    } as never,
  });

  app.use("/api", router);
  app.use((err: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? "unknown" });
  });

  return app;
}

const CHILD = { id: "child-session", agentId: "__fn_agent__", modelProvider: "p", modelId: "m", thinkingLevel: "high" };

describe("POST /api/chat/sessions/:id/handoff", () => {
  let currentManager: ManagerLike;

  beforeEach(() => {
    mockResolveProjectChatContext.mockResolvedValue({ store: {}, chatStore: {} });
    mockGetOrCreateScopedChatManager.mockImplementation(() => currentManager);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the manager result shape on success", async () => {
    currentManager = { handoffSession: vi.fn().mockResolvedValue({ session: CHILD, degraded: false, summaryChars: 420, sourceSessionId: "src-1" }) };

    const response = await request(buildApp(currentManager), "POST", "/api/chat/sessions/src-1/handoff?projectId=project-a");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      session: CHILD,
      degraded: false,
      summaryChars: 420,
      sourceSessionId: "src-1",
    });
    expect(currentManager.handoffSession).toHaveBeenCalledWith("src-1");
  });

  it("reflects a degraded handoff without inventing a different shape", async () => {
    currentManager = { handoffSession: vi.fn().mockResolvedValue({ session: CHILD, degraded: true, summaryChars: 111, sourceSessionId: "src-2" }) };

    const response = await request(buildApp(currentManager), "POST", "/api/chat/sessions/src-2/handoff?projectId=project-a");

    expect(response.status).toBe(200);
    expect(response.body.degraded).toBe(true);
    expect(response.body.session).toEqual(CHILD);
  });

  it("forwards a not-found refusal as 404 with its fixed code", async () => {
    currentManager = { handoffSession: vi.fn().mockRejectedValue(new ChatHandoffError("not-found", 404, "Chat session not found")) };

    const response = await request(buildApp(currentManager), "POST", "/api/chat/sessions/missing/handoff?projectId=project-a");

    expect(response.status).toBe(404);
    expect(response.body.details).toEqual({ code: "not-found" });
  });

  it("forwards an ineligible-source refusal as 409 with its code (room)", async () => {
    currentManager = { handoffSession: vi.fn().mockRejectedValue(new ChatHandoffError("room-unsupported", 409, "Room chats cannot be handed off")) };

    const response = await request(buildApp(currentManager), "POST", "/api/chat/sessions/room-1/handoff?projectId=project-a");

    expect(response.status).toBe(409);
    expect(response.body.details).toEqual({ code: "room-unsupported" });
  });

  it("forwards an archived-source refusal as 409 (source-not-active)", async () => {
    currentManager = { handoffSession: vi.fn().mockRejectedValue(new ChatHandoffError("source-not-active", 409, "Only an active conversation can be handed off")) };

    const response = await request(buildApp(currentManager), "POST", "/api/chat/sessions/archived-1/handoff?projectId=project-a");

    expect(response.status).toBe(409);
    expect(response.body.details).toEqual({ code: "source-not-active" });
  });

  it("forwards a CLI-backed refusal as 409 (cli-backed-unsupported)", async () => {
    currentManager = { handoffSession: vi.fn().mockRejectedValue(new ChatHandoffError("cli-backed-unsupported", 409, "CLI-backed chats cannot be handed off")) };

    const response = await request(buildApp(currentManager), "POST", "/api/chat/sessions/cli-1/handoff?projectId=project-a");

    expect(response.status).toBe(409);
    expect(response.body.details).toEqual({ code: "cli-backed-unsupported" });
  });

  it("surfaces the archival-compensation failure as 500", async () => {
    currentManager = { handoffSession: vi.fn().mockRejectedValue(new ChatHandoffError("archival-failed", 500, "Failed to archive the source conversation")) };

    const response = await request(buildApp(currentManager), "POST", "/api/chat/sessions/src-3/handoff?projectId=project-a");

    expect(response.status).toBe(500);
    expect(response.body.details).toEqual({ code: "archival-failed" });
  });

  it("returns 503 when no chat manager is resolvable", async () => {
    const response = await request(buildAppWithoutManager(), "POST", "/api/chat/sessions/src-4/handoff");

    expect(response.status).toBe(503);
  });

  it("ignores a body that tries to retarget the handoff: forwards only the source session id", async () => {
    // The continuation's target must always be copied from the SOURCE inside the manager. A client
    // cannot smuggle a different agent/model through the route — the route reads no body fields.
    currentManager = { handoffSession: vi.fn().mockResolvedValue({ session: CHILD, degraded: false, summaryChars: 1, sourceSessionId: "src-5" }) };

    const response = await request(
      buildApp(currentManager),
      "POST",
      "/api/chat/sessions/src-5/handoff?projectId=project-a",
      JSON.stringify({ agentId: "attacker-agent", modelProvider: "evil", modelId: "evil", thinkingLevel: "off", status: "active" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    // handoffSession is called with the session id ONLY — never a body-derived target object.
    expect(currentManager.handoffSession).toHaveBeenCalledTimes(1);
    const [calledArg] = currentManager.handoffSession.mock.calls[0]!;
    expect(calledArg).toBe("src-5");
  });
});
