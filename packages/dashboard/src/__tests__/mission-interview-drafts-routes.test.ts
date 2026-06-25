// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, type TaskStore } from "@fusion/core";
import { createMissionRouter } from "../mission-routes.js";

vi.mock("../project-store-resolver.js", () => ({
  getOrCreateProjectStore: vi.fn().mockResolvedValue({
    getMissionStore: vi.fn().mockReturnValue({}),
    getRootDir: vi.fn().mockReturnValue("/fake/root"),
    getSettings: vi.fn().mockResolvedValue({ promptOverrides: {} }),
    pauseTask: vi.fn(),
  }),
}));
import { AiSessionStore, type AiSessionRow } from "../ai-session-store.js";
import { request } from "../test-request.js";
import {
  __registerMissionInterviewSessionForTest,
  __resetMissionInterviewState,
  setAiSessionStore,
} from "../mission-interview.js";

function createMockStore(): TaskStore {
  return {
    getMissionStore: vi.fn().mockReturnValue({}),
    getRootDir: vi.fn().mockReturnValue("/fake/root"),
    getSettings: vi.fn().mockResolvedValue({ promptOverrides: {} }),
    pauseTask: vi.fn(),
  } as unknown as TaskStore;
}

function buildApp(aiSessionStore: AiSessionStore) {
  const app = express();
  app.use(express.json());
  app.use("/api/missions", createMissionRouter(createMockStore(), undefined, aiSessionStore));
  return app;
}

function makeRow(overrides: Partial<AiSessionRow> & Pick<AiSessionRow, "id">): AiSessionRow {
  const now = overrides.updatedAt ?? "2026-05-12T00:00:00.000Z";
  return {
    id: overrides.id,
    type: overrides.type ?? "mission_interview",
    status: overrides.status ?? "awaiting_input",
    title: overrides.title ?? overrides.id,
    inputPayload: overrides.inputPayload ?? JSON.stringify({ missionTitle: overrides.title ?? overrides.id }),
    conversationHistory: overrides.conversationHistory ?? "[]",
    currentQuestion: overrides.currentQuestion ?? null,
    result: overrides.result ?? null,
    thinkingOutput: overrides.thinkingOutput ?? "",
    error: overrides.error ?? null,
    projectId: overrides.projectId ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: now,
    lockedByTab: overrides.lockedByTab ?? null,
    lockedAt: overrides.lockedAt ?? null,
    archived: overrides.archived,
  };
}

describe("mission interview draft routes", () => {
  let tmpRoot: string;
  let db: Database;
  let aiSessionStore: AiSessionStore;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-mission-drafts-"));
    db = new Database(join(tmpRoot, ".fusion"));
    db.init();
    aiSessionStore = new AiSessionStore(db);
    __resetMissionInterviewState();
    setAiSessionStore(aiSessionStore);
    app = buildApp(aiSessionStore);
  });

  afterEach(async () => {
    __resetMissionInterviewState();
    aiSessionStore.stopScheduledCleanup();
    try {
      db.close();
    } catch {
      // ignore
    }
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("GET /interview/drafts returns only non-terminal mission interview drafts for the requested project", async () => {
    aiSessionStore.upsert(makeRow({ id: "draft-a", title: "Draft A", projectId: "project-a", status: "awaiting_input", conversationHistory: "[{\"q\":1}]" }));
    aiSessionStore.upsert(makeRow({ id: "draft-b", title: "Draft B", projectId: "project-b", status: "generating" }));
    aiSessionStore.upsert(makeRow({ id: "draft-unscoped", title: "Draft Unscoped", projectId: null, status: "error" }));
    aiSessionStore.upsert(makeRow({ id: "planning-row", type: "planning", title: "Planning", projectId: "project-a", status: "awaiting_input" }));

    const res = await request(app, "GET", "/api/missions/interview/drafts?projectId=project-a");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      drafts: [
        expect.objectContaining({
          id: "draft-a",
          title: "Draft A",
          status: "awaiting_input",
          projectId: "project-a",
          hasConversation: true,
        }),
      ],
    });
  });

  it("GET /interview/drafts includes complete mission interview rows but excludes archived rows", async () => {
    aiSessionStore.upsert(makeRow({ id: "draft-live", title: "Live draft", status: "awaiting_input" }));
    aiSessionStore.upsert(
      makeRow({
        id: "draft-complete",
        title: "Complete draft",
        status: "complete",
        result: JSON.stringify({ missionTitle: "Complete draft", missionDescription: "desc", milestones: [] }),
        currentQuestion: null,
      }),
    );
    aiSessionStore.upsert(makeRow({ id: "draft-archived", title: "Archived draft", status: "error" }));
    aiSessionStore.upsert(makeRow({ id: "draft-other-type", title: "Planning row", type: "planning", status: "complete" }));
    db.prepare("UPDATE ai_sessions SET archived = 1 WHERE id = ?").run("draft-archived");

    const res = await request(app, "GET", "/api/missions/interview/drafts");

    expect(res.status).toBe(200);
    expect((res.body as { drafts: Array<{ id: string; status: string }> }).drafts).toEqual([
      expect.objectContaining({ id: "draft-complete", status: "complete" }),
      expect.objectContaining({ id: "draft-live", status: "awaiting_input" }),
    ]);
  });

  it("POST /interview/drafts/:sessionId/discard removes a hot in-memory session", async () => {
    __registerMissionInterviewSessionForTest("draft-hot", "Hot draft");
    aiSessionStore.upsert(makeRow({ id: "draft-hot", title: "Hot draft", status: "awaiting_input" }));

    const res = await request(
      app,
      "POST",
      "/api/missions/interview/drafts/draft-hot/discard",
      JSON.stringify({ tabId: "tab-1" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, removed: true });
    expect(aiSessionStore.get("draft-hot")).toBeNull();
  });

  it("POST /interview/drafts/:sessionId/discard removes a cold persisted session", async () => {
    aiSessionStore.upsert(makeRow({ id: "draft-cold", title: "Cold draft", status: "error" }));

    const res = await request(app, "POST", "/api/missions/interview/drafts/draft-cold/discard", JSON.stringify({}), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, removed: true });
    expect(aiSessionStore.get("draft-cold")).toBeNull();
  });

  it("POST /interview/drafts/:sessionId/discard is scoped by project and leaves other session types intact", async () => {
    aiSessionStore.upsert(makeRow({ id: "draft-project-b", title: "Project B", projectId: "project-b", status: "awaiting_input" }));
    aiSessionStore.upsert(makeRow({ id: "planning-row", type: "planning", title: "Planning", projectId: "project-a", status: "awaiting_input" }));

    const wrongProject = await request(
      app,
      "POST",
      "/api/missions/interview/drafts/draft-project-b/discard?projectId=project-a",
      JSON.stringify({}),
      { "content-type": "application/json" },
    );
    const planningRow = await request(
      app,
      "POST",
      "/api/missions/interview/drafts/planning-row/discard?projectId=project-a",
      JSON.stringify({}),
      { "content-type": "application/json" },
    );

    expect(wrongProject.status).toBe(404);
    expect(planningRow.status).toBe(404);
    expect(aiSessionStore.get("draft-project-b")).not.toBeNull();
    expect(aiSessionStore.get("planning-row")).not.toBeNull();
  });

  it("POST /interview/drafts/:sessionId/discard returns 404 when the session does not exist", async () => {
    const res = await request(app, "POST", "/api/missions/interview/drafts/missing/discard", JSON.stringify({}), {
      "content-type": "application/json",
    });

    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toContain("missing");
  });

  it("POST /interview/drafts/:sessionId/discard allows the owning tab to discard a locked draft", async () => {
    aiSessionStore.upsert(makeRow({ id: "draft-owned", title: "Owned draft", status: "awaiting_input" }));
    db.prepare("UPDATE ai_sessions SET lockedByTab = ?, lockedAt = ? WHERE id = ?").run(
      "tab-owner",
      "2026-05-12T00:00:00.000Z",
      "draft-owned",
    );

    const res = await request(
      app,
      "POST",
      "/api/missions/interview/drafts/draft-owned/discard",
      JSON.stringify({ tabId: "tab-owner" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, removed: true });
    expect(aiSessionStore.get("draft-owned")).toBeNull();
  });

  it("POST /interview/drafts/:sessionId/discard returns 409 when locked by another tab", async () => {
    aiSessionStore.upsert(makeRow({ id: "draft-locked", title: "Locked draft", status: "awaiting_input" }));
    db.prepare("UPDATE ai_sessions SET lockedByTab = ?, lockedAt = ? WHERE id = ?").run(
      "tab-owner",
      "2026-05-12T00:00:00.000Z",
      "draft-locked",
    );

    const res = await request(
      app,
      "POST",
      "/api/missions/interview/drafts/draft-locked/discard",
      JSON.stringify({ tabId: "tab-other" }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "Session locked by another tab",
      lockedByTab: "tab-owner",
    });
  });
});
