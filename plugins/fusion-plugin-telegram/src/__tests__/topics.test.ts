import { describe, expect, it, vi } from "vitest";

import type { FetchLike, TelegramLogger } from "../bot-api.js";
import { createTelegramClient } from "../bot-api.js";
import { createTopicRouter, pickTopicIconColor, topicNameFor, type TopicBindingStore } from "../topics.js";
import { FORUM_TOPIC_ICON_COLORS } from "../settings.js";

const TOKEN = "999:token";

interface RecordedCall {
  method: string;
  body: Record<string, unknown>;
}

function makeApi(responses: Array<{ ok: boolean; body?: unknown }>) {
  const calls: RecordedCall[] = [];
  let cursor = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ method: url.split("/").pop() ?? url, body: JSON.parse(String(init?.body ?? "{}")) });
    const next = responses[cursor] ?? { ok: true, body: { ok: true, result: { message_thread_id: 11 } } };
    if (cursor < responses.length) cursor += 1;
    return { ok: next.ok, status: next.ok ? 200 : 400, json: async () => next.body };
  };
  return { calls, fetchImpl };
}

function logger(): TelegramLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function storeWith(bindings: Record<string, number> = {}): TopicBindingStore & { writes: Array<{ projectId: string; threadId: number }> } {
  const writes: Array<{ projectId: string; threadId: number }> = [];
  return {
    writes,
    async getTopic(projectId) {
      return bindings[projectId] ?? null;
    },
    async upsertTopic(projectId, chatId, threadId) {
      expect(chatId).toBe("-100123");
      writes.push({ projectId, threadId });
    },
  };
}

async function createRouter(args: {
  groupingMode: "privateTopics" | "forumTopic" | "flat";
  responses?: Array<{ ok: boolean; body?: unknown }>;
  store?: TopicBindingStore | null;
  log?: TelegramLogger;
}) {
  const api = makeApi(args.responses ?? []);
  const client = createTelegramClient({ fetchImpl: api.fetchImpl, botToken: TOKEN, logger: args.log ?? logger() });
  const router = createTopicRouter({
    client,
    chatId: "-100123",
    groupingMode: args.groupingMode,
    store: args.store ?? null,
    logger: args.log ?? logger(),
  });
  return { router, calls: api.calls };
}

describe("resolveThreadId", () => {
  it("sends nowhere in flat mode and calls no Bot API method", async () => {
    const log = logger();
    const { router, calls } = await createRouter({ groupingMode: "flat", log });

    await expect(router.resolveThreadId("p1", "Fusion")).resolves.toBeNull();
    expect(calls).toHaveLength(0);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("creates the topic once and caches it, so the second event reuses the thread", async () => {
    const store = storeWith();
    const { router, calls } = await createRouter({
      groupingMode: "privateTopics",
      responses: [{ ok: true, body: { ok: true, result: { message_thread_id: 512 } } }],
      store,
    });

    await expect(router.resolveThreadId("p1", "Fusion")).resolves.toBe(512);
    await expect(router.resolveThreadId("p1", "Fusion")).resolves.toBe(512);

    const creates = calls.filter((call) => call.method === "createForumTopic");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.body).toMatchObject({ chat_id: "-100123", name: "Fusion" });
    expect(store.writes).toEqual([{ projectId: "p1", threadId: 512 }]);
    expect(router.snapshot()).toEqual([{ projectId: "p1", threadId: 512 }]);
  });

  it("prefers a persisted binding over creating a second topic after a restart", async () => {
    const store = storeWith({ p1: 777 });
    const { router, calls } = await createRouter({ groupingMode: "forumTopic", store });

    await expect(router.resolveThreadId("p1", "Fusion")).resolves.toBe(777);
    expect(calls.filter((call) => call.method === "createForumTopic")).toHaveLength(0);
  });

  it("picks an icon colour the Bot API accepts, deterministically per project", async () => {
    const { router, calls } = await createRouter({
      groupingMode: "privateTopics",
      responses: [{ ok: true, body: { ok: true, result: { message_thread_id: 5 } } }],
    });

    await router.resolveThreadId("p1", "Fusion");

    const creates = calls.filter((call) => call.method === "createForumTopic");
    expect(FORUM_TOPIC_ICON_COLORS).toContain(creates[0]?.body.icon_color);
    expect(pickTopicIconColor("p1")).toBe(creates[0]?.body.icon_color);
    expect(pickTopicIconColor("p1")).toBe(pickTopicIconColor("p1"));
  });

  it("falls back to flat and complains once when topics are unavailable", async () => {
    const log = logger();
    const rejected = { ok: false, body: { ok: false, error_code: 400, description: "Bad Request: forum topics requested in a chat without topics" } };
    const { router, calls } = await createRouter({ groupingMode: "privateTopics", responses: [rejected, rejected], log });

    await expect(router.resolveThreadId("p1", "Fusion")).resolves.toBeNull();
    await expect(router.resolveThreadId("p1", "Fusion")).resolves.toBeNull();

    const loud = log.error.mock.calls.filter((call) => String(call[0]).includes("falling back to flat"));
    expect(loud).toHaveLength(1);
    expect(calls.filter((call) => call.method === "createForumTopic")).toHaveLength(2);
    expect(router.snapshot()).toEqual([]);
  });

  it("still delivers when the topic binding cannot be persisted", async () => {
    const log = logger();
    const failingStore: TopicBindingStore = {
      async getTopic() {
        return null;
      },
      async upsertTopic() {
        throw new Error("database is unreadable");
      },
    };
    const { router } = await createRouter({
      groupingMode: "privateTopics",
      responses: [{ ok: true, body: { ok: true, result: { message_thread_id: 9 } } }],
      store: failingStore,
      log,
    });

    await expect(router.resolveThreadId("p1", "Fusion")).resolves.toBe(9);
    expect(log.warn).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("clips a project name to the topic-name ceiling", () => {
    expect(topicNameFor("x".repeat(200), "p1")).toHaveLength(128);
    expect(topicNameFor("   ", "p1")).toBe("p1");
  });
});
