import { createHmac } from "node:crypto";
import { describe, expect, it, vi, beforeEach } from "vitest";
import plugin, { splitMessageForWhatsapp, verifyMetaSignature, webhookGetHandler, webhookPostHandler } from "../index.js";

function createInMemoryDb() {
  const sessions = new Map<string, string>();
  const dedupe = new Set<string>();
  return {
    exec: vi.fn(),
    prepare: vi.fn((sql: string) => ({
      get: (value: string) => {
        if (sql.includes("FROM whatsapp_chat_sessions")) {
          const history = sessions.get(value);
          return history ? { history } : undefined;
        }
        if (sql.includes("FROM whatsapp_chat_dedupe")) {
          return dedupe.has(value) ? { found: 1 } : undefined;
        }
        return undefined;
      },
      run: (...args: unknown[]) => {
        if (sql.includes("whatsapp_chat_sessions")) {
          sessions.set(args[0] as string, args[1] as string);
        }
        if (sql.includes("whatsapp_chat_dedupe")) {
          dedupe.add(args[0] as string);
        }
      },
    })),
    get history() {
      return sessions;
    },
  };
}

function makeCtx(overrides: Partial<any> = {}) {
  const db = createInMemoryDb();
  const ctx: any = {
    settings: {
      appSecret: "secret",
      verifyToken: "verify-me",
      accessToken: "token",
      phoneNumberId: "123",
      allowedSenders: ["15551234567"],
    },
    taskStore: {
      getRootDir: () => "/tmp/project",
      getPluginStore: () => ({ db }),
    },
    createAiSession: vi.fn().mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        state: { messages: [{ role: "assistant", content: "hello from fusion" }] },
      },
    }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emitEvent: vi.fn(),
    ...overrides,
  };
  return { ctx, db };
}

function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(Buffer.from(body)).digest("hex")}`;
}

describe("whatsapp plugin", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("registers schema init hook", () => {
    expect(plugin.hooks?.onSchemaInit).toBeDefined();
  });

  it("verifies GET webhook challenge", async () => {
    const { ctx } = makeCtx();
    const result = await webhookGetHandler({ query: { "hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "abc" } }, ctx);
    expect(result).toEqual({ status: 200, body: "abc" });
  });

  it("rejects invalid signatures", async () => {
    const { ctx } = makeCtx();
    const body = JSON.stringify({ entry: [] });
    const res = await webhookPostHandler({ rawBody: Buffer.from(body), headers: { "x-hub-signature-256": "sha256=badsig" }, body: { entry: [] } }, ctx);
    expect(res.status).toBe(401);
  });

  it("dedupes repeated inbound messages", async () => {
    const { ctx } = makeCtx();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue("") }));

    const payload = {
      entry: [{ changes: [{ value: { messages: [{ id: "wamid.1", from: "15551234567", type: "text", text: { body: "Hi" } }] } }] }],
    };
    const raw = JSON.stringify(payload);
    const req = {
      rawBody: Buffer.from(raw),
      headers: { "x-hub-signature-256": signBody("secret", raw) },
      body: payload,
    };

    const first = await webhookPostHandler(req, ctx);
    const second = await webhookPostHandler(req, ctx);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(ctx.createAiSession).toHaveBeenCalledTimes(1);
    expect((global.fetch as any)).toHaveBeenCalledTimes(1);
  });

  it("preserves transcript continuity across turns", async () => {
    const { ctx } = makeCtx();
    const promptSpy = vi.fn().mockResolvedValue(undefined);
    ctx.createAiSession = vi.fn().mockResolvedValue({
      session: {
        prompt: promptSpy,
        state: { messages: [{ role: "assistant", content: "reply" }] },
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue("") }));

    const makeReq = (id: string, text: string) => {
      const payload = { entry: [{ changes: [{ value: { messages: [{ id, from: "15551234567", type: "text", text: { body: text } }] } }] }] };
      const raw = JSON.stringify(payload);
      return { rawBody: Buffer.from(raw), headers: { "x-hub-signature-256": signBody("secret", raw) }, body: payload };
    };

    await webhookPostHandler(makeReq("wamid.1", "First"), ctx);
    await webhookPostHandler(makeReq("wamid.2", "Second"), ctx);

    const secondPrompt = promptSpy.mock.calls[1][0] as string;
    expect(secondPrompt).toContain("User: First");
    expect(secondPrompt).toContain("Assistant: reply");
    expect(secondPrompt).toContain("User: Second");
  });

  it("formats outbound payloads and chunks long replies", async () => {
    const longReply = "a".repeat(5000);
    const { ctx } = makeCtx({
      createAiSession: vi.fn().mockResolvedValue({
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          state: { messages: [{ role: "assistant", content: longReply }] },
        },
      }),
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue("") });
    vi.stubGlobal("fetch", fetchMock);

    const payload = { entry: [{ changes: [{ value: { messages: [{ id: "wamid.1", from: "15551234567", type: "text", text: { body: "hi" } }] } }] }] };
    const raw = JSON.stringify(payload);

    await webhookPostHandler({ rawBody: Buffer.from(raw), headers: { "x-hub-signature-256": signBody("secret", raw) }, body: payload }, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body1 = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body1.messaging_product).toBe("whatsapp");
    expect(body1.to).toBe("15551234567");
  });

  it("sends fallback error response when AI/outbound flow fails", async () => {
    const { ctx } = makeCtx({
      createAiSession: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue("") });
    vi.stubGlobal("fetch", fetchMock);

    const payload = { entry: [{ changes: [{ value: { messages: [{ id: "wamid.1", from: "15551234567", type: "text", text: { body: "help" } }] } }] }] };
    const raw = JSON.stringify(payload);

    await webhookPostHandler({ rawBody: Buffer.from(raw), headers: { "x-hub-signature-256": signBody("secret", raw) }, body: payload }, ctx);

    const fallbackBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(fallbackBody.text.body).toContain("Sorry");
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it("has signature helper coverage", () => {
    const body = Buffer.from("{}");
    const signature = signBody("secret", "{}");
    expect(verifyMetaSignature(body, signature, "secret")).toBe(true);
    expect(verifyMetaSignature(body, signature, "wrong")).toBe(false);
  });

  it("splits oversized messages", () => {
    const chunks = splitMessageForWhatsapp("x".repeat(9000));
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].length).toBeLessThanOrEqual(4096);
  });
});
