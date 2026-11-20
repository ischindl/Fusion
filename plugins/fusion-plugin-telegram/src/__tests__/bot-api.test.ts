import { describe, expect, it, vi } from "vitest";

import { createTelegramClient, isTelegramRateLimit, redactToken, TelegramApiError, type FetchLike } from "../bot-api.js";

const TOKEN = "123456789:AA-secret-token-value-abcdefghijklmnopqrst";

interface RecordedCall {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

interface StubbedResponse {
  ok: boolean;
  status?: number;
  body?: unknown;
}

function makeFakeApi(responses: StubbedResponse[] = []) {
  const calls: RecordedCall[] = [];
  let cursor = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ method: url.split("/").pop() ?? url, url, body: JSON.parse(String(init?.body ?? "{}")) });
    const next = responses[cursor] ?? { ok: true, body: { ok: true, result: { message_id: 4242 } } };
    if (cursor < responses.length) cursor += 1;
    return { ok: next.ok, status: next.status ?? (next.ok ? 200 : 400), json: async () => next.body };
  };
  return { calls, fetchImpl };
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe("createTelegramClient.sendMessage", () => {
  it("posts chat_id, message_thread_id and text to the Bot API", async () => {
    const { calls, fetchImpl } = makeFakeApi();
    const client = createTelegramClient({ fetchImpl, botToken: TOKEN, logger: makeLogger() });

    const result = await client.sendMessage({ chatId: "-100123", text: "hello", messageThreadId: 77, parseMode: "HTML" });

    expect(result).toEqual({ messageId: 4242 });
    expect(calls[0]?.method).toBe("sendMessage");
    expect(calls[0]?.body).toEqual({ chat_id: "-100123", text: "hello", message_thread_id: 77, parse_mode: "HTML" });
  });

  it("omits message_thread_id for flat delivery instead of sending null", async () => {
    const { calls, fetchImpl } = makeFakeApi();
    const client = createTelegramClient({ fetchImpl, botToken: TOKEN, logger: makeLogger() });

    await client.sendMessage({ chatId: "-100123", text: "flat" });

    expect("message_thread_id" in (calls[0]?.body ?? {})).toBe(false);
  });

  it("attaches an inline keyboard when the caller supplies one", async () => {
    const { calls, fetchImpl } = makeFakeApi();
    const client = createTelegramClient({ fetchImpl, botToken: TOKEN, logger: makeLogger() });

    await client.sendMessage({
      chatId: "-100123",
      text: "pick",
      replyMarkup: { inline_keyboard: [[{ text: "main", callback_data: "q:abc" }]] },
    });

    expect(calls[0]?.body.reply_markup).toEqual({ inline_keyboard: [[{ text: "main", callback_data: "q:abc" }]] });
  });
});

describe("createTelegramClient.createForumTopic", () => {
  it("maps message_thread_id onto the camelCase result", async () => {
    const { calls, fetchImpl } = makeFakeApi([{ ok: true, body: { ok: true, result: { message_thread_id: 321 } } }]);
    const client = createTelegramClient({ fetchImpl, botToken: TOKEN, logger: makeLogger() });

    const created = await client.createForumTopic({ chatId: "-100123", name: "Fusion", iconColor: 7322096 });

    expect(created).toEqual({ messageThreadId: 321 });
    expect(calls[0]?.body).toEqual({ chat_id: "-100123", name: "Fusion", icon_color: 7322096 });
  });
});

describe("createTelegramClient.getUpdates", () => {
  it("sends offset+1, the long-poll timeout, and only the update types in use", async () => {
    const { calls, fetchImpl } = makeFakeApi([{ ok: true, body: { ok: true, result: [] } }]);
    const client = createTelegramClient({ fetchImpl, botToken: TOKEN, logger: makeLogger() });

    const updates = await client.getUpdates({ offset: 11, timeout: 30, allowed_updates: ["message", "callback_query"] });

    expect(updates).toEqual([]);
    expect(calls[0]?.body).toEqual({ offset: 11, timeout: 30, allowed_updates: ["message", "callback_query"] });
  });

  it("treats a missing result array as no updates", async () => {
    const { fetchImpl } = makeFakeApi([{ ok: true, body: { ok: true } }]);
    const client = createTelegramClient({ fetchImpl, botToken: TOKEN, logger: makeLogger() });

    await expect(client.getUpdates({ timeout: 30 })).resolves.toEqual([]);
  });
});

describe("createTelegramClient keyboard teardown", () => {
  it("clears the keyboard by sending an empty inline_keyboard", async () => {
    const { calls, fetchImpl } = makeFakeApi([{ ok: true, body: { ok: true, result: true } }]);
    const client = createTelegramClient({ fetchImpl, botToken: TOKEN, logger: makeLogger() });

    await client.editMessageReplyMarkup({ chatId: "-100123", messageId: 55 });

    expect(calls[0]?.method).toBe("editMessageReplyMarkup");
    expect(calls[0]?.body).toEqual({ chat_id: "-100123", message_id: 55, reply_markup: { inline_keyboard: [] } });
  });

  it("answers a callback query with the operator-visible sentence", async () => {
    const { calls, fetchImpl } = makeFakeApi([{ ok: true, body: { ok: true, result: true } }]);
    const client = createTelegramClient({ fetchImpl, botToken: TOKEN, logger: makeLogger() });

    await client.answerCallbackQuery({ callbackQueryId: "cb-1", text: "already answered" });

    expect(calls[0]?.body).toEqual({ callback_query_id: "cb-1", text: "already answered" });
  });
});

describe("createTelegramClient failures", () => {
  it("carries errorCode and retry_after off a 429 without retrying", async () => {
    const { calls, fetchImpl } = makeFakeApi([
      {
        ok: false,
        status: 429,
        body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 30", parameters: { retry_after: 30 } },
      },
    ]);
    const client = createTelegramClient({ fetchImpl, botToken: TOKEN, logger: makeLogger() });

    const error = await client.sendMessage({ chatId: "-100123", text: "x" }).catch((e) => e) as TelegramApiError;

    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error.errorCode).toBe(429);
    expect(error.retryAfterMs).toBe(30_000);
    expect(isTelegramRateLimit(error)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("reports a rejected Bot API call as a typed error", async () => {
    const { calls, fetchImpl } = makeFakeApi([
      { ok: false, status: 400, body: { ok: false, error_code: 400, description: "Bad Request: chat not found" } },
    ]);
    const client = createTelegramClient({ fetchImpl, botToken: TOKEN, logger: makeLogger() });

    const error = await client.sendMessage({ chatId: "-1", text: "x" }).catch((e) => e) as TelegramApiError;

    expect(error.errorCode).toBe(400);
    expect(error.message).toContain("chat not found");
    expect(calls).toHaveLength(1);
  });

  it("wraps a transport failure without retrying", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ method: url.split("/").pop() ?? url, url, body: JSON.parse(String(init?.body ?? "{}")) });
      throw new Error("socket hang up");
    };
    const client = createTelegramClient({ fetchImpl, botToken: TOKEN, logger: makeLogger() });

    const error = await client.sendMessage({ chatId: "-1", text: "x" }).catch((e) => e) as TelegramApiError;

    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error.httpStatus).toBe(0);
    expect(calls).toHaveLength(1);
  });
});

describe("bot token secrecy", () => {
  it("redacts the token from anything Telegram echoes back", () => {
    expect(redactToken(`bad token ${TOKEN} rejected`, TOKEN)).toContain("[telegram-token-redacted]");
    expect(redactToken(`bad token ${TOKEN} rejected`, TOKEN)).not.toContain(TOKEN);
  });

  it("keeps the token out of the error message, the logger output, and the serialized error", async () => {
    const logger = makeLogger();
    const { fetchImpl } = makeFakeApi([
      { ok: false, status: 401, body: { ok: false, error_code: 401, description: `Unauthorized: invalid token specified (${TOKEN})` } },
    ]);
    const client = createTelegramClient({ fetchImpl, botToken: TOKEN, logger });

    const error = await client.sendMessage({ chatId: "-1", text: "x" }).catch((e) => e) as TelegramApiError;

    expect(error.message).not.toContain(TOKEN);
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(TOKEN);
    for (const spy of [logger.info, logger.warn, logger.error, logger.debug]) {
      for (const call of spy.mock.calls) {
        expect(String(call[0])).not.toContain(TOKEN);
      }
    }
  });

  it("keeps the token out of every logged transport failure", async () => {
    const logger = makeLogger();
    const fetchImpl: FetchLike = async () => {
      throw new Error(`connect failed for https://api.telegram.org/bot${TOKEN}/getUpdates`);
    };
    const client = createTelegramClient({ fetchImpl, botToken: TOKEN, logger });

    const error = await client.getUpdates({ timeout: 1 }).catch((e) => e) as TelegramApiError;

    expect(error.message).not.toContain(TOKEN);
    expect(logger.error.mock.calls.length + logger.warn.mock.calls.length).toBeGreaterThan(0);
    for (const call of logger.warn.mock.calls) expect(String(call[0])).not.toContain(TOKEN);
  });
});
