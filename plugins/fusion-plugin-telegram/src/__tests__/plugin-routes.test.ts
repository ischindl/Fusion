import { describe, expect, it, vi } from "vitest";

import plugin from "../index.js";
import type { PluginContext } from "@fusion/plugin-sdk";

/**
 * FNXC:TelegramBridge 2026-11-20-02:49 (RUFU-782):
 * `ingest.test.ts` covers the route logic against injected ports; this file covers the WIRING that the
 * ports hide: the routes the plugin actually registers, whether a loaded bridge answers, what `/status`
 * says when the operator has not finished configuring, and that nothing on either route can echo a secret.
 * Those are exactly the properties a unit test of `handleFusionEvent` cannot see.
 */

const SECRET = "ingest-secret-value";
const TOKEN = "123456:telegram-bot-token-value";

function context(overrides: { settings?: Record<string, unknown>; task?: Record<string, unknown> | null } = {}) {
  const ctx = {
    pluginId: "fusion-plugin-telegram",
    settings: {
      botToken: TOKEN,
      chatId: "-100123",
      ingestSecret: SECRET,
      eventFilter: "planning-awaiting-input",
      ...overrides.settings,
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emitEvent: vi.fn(),
    taskStore: {
      getRootDir: () => `/tmp/fusion-${overrides.task ? "wired" : "bare"}`,
      getProjectId: () => "p1",
      getTask: async (id: string) => (overrides.task ? { id, ...overrides.task } : null),
    },
  };
  return ctx as unknown as PluginContext;
}

function route(method: string, path: string) {
  const found = (plugin.routes ?? []).find((entry) => entry.method === method && entry.path === path);
  if (!found) throw new Error(`route ${method} ${path} is not registered`);
  return found;
}

function json(body: unknown, secret = SECRET) {
  return {
    method: "POST",
    query: { key: secret },
    headers: { "content-type": "application/json", "content-length": String(JSON.stringify(body).length) },
    body,
  };
}

const awaitingEvent = {
  event: "planning-awaiting-input",
  project: { id: "p1", name: "Fusion" },
  task: { id: "RUFU-782", title: "Telegram bridge", status: "awaiting-user-input" },
};

describe("telegram plugin routes", () => {
  it("registers the ingest route the webhook url points at and a status route", () => {
    const paths = (plugin.routes ?? []).map((entry) => `${entry.method} ${entry.path}`);
    expect(paths).toContain("POST /fusion");
    expect(paths).toContain("GET /status");
  });

  it("refuses an event before the plugin is loaded instead of pretending it was accepted", async () => {
    const handler = route("POST", "/fusion").handler;
    const response = await handler(json(awaitingEvent), context({ task: null }));
    expect(response).toMatchObject({ status: 503, body: { error: "telegram-bridge-not-loaded" } });
  });

  it("answers the webhook with 202 and never sends anything when the instance has no bot token", async () => {
    const ctx = context({ settings: { botToken: "" }, task: { pausedReason: "workflow-input:step-execute@1: Which branch?" } });
    await plugin.hooks?.onLoad?.(ctx);
    try {
      const response = await route("POST", "/fusion").handler(json(awaitingEvent), ctx);
      expect(response).toMatchObject({ status: 202, body: { status: "queued", projectId: "p1", taskId: "RUFU-782" } });
    } finally {
      await plugin.hooks?.onUnload?.(ctx);
    }
  });

  it("reads the question off the card that the payload only names", async () => {
    const ctx = context({ task: { pausedReason: "workflow-input:step-execute@1730000000000: Which branch should I merge into?" } });
    await plugin.hooks?.onLoad?.(ctx);
    try {
      const response = (await route("POST", "/fusion").handler(json(awaitingEvent), ctx)) as { body: Record<string, unknown> };
      expect(response.body.status).toBe("queued");
      expect(response.body.questionId).toBeTruthy();
    } finally {
      await plugin.hooks?.onUnload?.(ctx);
    }
  });

  it("reports an unconfigured bridge honestly on /status and never leaks the token or the secret", async () => {
    const ctx = context({ settings: { ingestSecret: "" } });
    await plugin.hooks?.onLoad?.(ctx);
    try {
      const response = (await route("GET", "/status").handler({}, ctx)) as { status: number; body: Record<string, unknown> };
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        botTokenConfigured: true,
        chatIdConfigured: true,
        ingestSecretConfigured: false,
        ready: false,
      });
      const serialised = JSON.stringify(response);
      expect(serialised).not.toContain(TOKEN);
      expect(serialised).not.toContain(SECRET);
      expect(serialised).not.toContain("telegram-bot-token-value");
    } finally {
      await plugin.hooks?.onUnload?.(ctx);
    }
  });

  it("says ready only when the token, the chat, and the shared secret are all present", async () => {
    const ctx = context();
    await plugin.hooks?.onLoad?.(ctx);
    try {
      const response = (await route("GET", "/status").handler({}, ctx)) as { body: Record<string, unknown> };
      expect(response.body.ready).toBe(true);
    } finally {
      await plugin.hooks?.onUnload?.(ctx);
    }
  });

  it("warns at load about what the operator still has to set, instead of failing silently later", async () => {
    const ctx = context({ settings: { botToken: "", ingestSecret: "" } });
    await plugin.hooks?.onLoad?.(ctx);
    expect(ctx.logger.warn).toHaveBeenCalled();
    await plugin.hooks?.onUnload?.(ctx);
  });

  it("reports on /status why the inbound poller is silent, instead of showing only zeroes", async () => {
    const ctx = context();
    await plugin.hooks?.onLoad?.(ctx);
    try {
      const response = (await route("GET", "/status").handler({}, ctx)) as { body: Record<string, unknown> };
      const inbound = response.body.inbound as Record<string, unknown>;

      // A token and a chat are set here, so the only reason nothing arrives is the missing correlation store.
      expect(inbound.holder).toBe(false);
      expect(inbound.stoppedReason).toBe("no-persistence");
      expect(inbound.processedUpdates).toBe(0);
      expect(response.body.recentAnswers).toEqual([]);
    } finally {
      await plugin.hooks?.onUnload?.(ctx);
    }
  });

  it("names a missing chat as the reason the poller never started", async () => {
    const ctx = context({ settings: { chatId: "" } });
    await plugin.hooks?.onLoad?.(ctx);
    try {
      const response = (await route("GET", "/status").handler({}, ctx)) as { body: Record<string, unknown> };
      expect((response.body.inbound as Record<string, unknown>).stoppedReason).toBe("not-configured");
    } finally {
      await plugin.hooks?.onUnload?.(ctx);
    }
  });

  it("says the bridge is not loaded again after unload, so a stopped plugin cannot keep accepting events", async () => {
    const ctx = context();
    await plugin.hooks?.onLoad?.(ctx);
    await plugin.hooks?.onUnload?.(ctx);

    const refused = (await route("POST", "/fusion").handler(json(awaitingEvent), ctx)) as { status: number };
    expect(refused.status).toBe(503);

    const response = (await route("GET", "/status").handler({}, ctx)) as { body: Record<string, unknown> };
    expect((response.body.inbound as Record<string, unknown>).stoppedReason).toBe("not-loaded");
  });
});
