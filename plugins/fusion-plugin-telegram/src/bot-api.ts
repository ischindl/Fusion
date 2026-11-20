/**
 * FNXC:TelegramBridge 2026-11-20-02:49 (RUFU-782):
 * The whole Telegram surface this bridge uses, over `fetch`. Accepted decision 4 forbids a runtime
 * dependency (`grammy`/`telegraf` are not added), so the five Bot API methods the bridge needs are
 * hand-called: getUpdates, sendMessage, createForumTopic, editMessageReplyMarkup, answerCallbackQuery
 * (https://core.telegram.org/bots/api).
 *
 * Two rules are load-bearing here:
 * 1. The bot token travels inside the URL path, so it is redacted from every error message and never
 *    written to the logger at all (docs/secrets.md). A token leak through an error string is the only
 *    realistic way this plugin can leak.
 * 2. The client does NOT retry. A 429 carries `retry_after` and the caller (the per-chat outbox, or
 *    the inbound loop's backoff) is the only place that knows whether waiting is correct, so the client
 *    reports `errorCode` / `retryAfterMs` as data and stops.
 */

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface TelegramLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number | string };
  date?: number;
  text?: string;
  reply_to_message?: { message_id: number };
  /** Telegram sends the id alongside `reply_to_message`; the id alone is all correlation needs. */
  reply_to_message_id?: number;
  message_thread_id?: number;
}

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number; username?: string };
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardMarkupShape {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

const REDACTED = "[telegram-token-redacted]";

/** Replaces every occurrence of the token; empty tokens would match everywhere, so they are skipped. */
export function redactToken(text: string, botToken: string): string {
  if (!botToken) return text;
  return text.split(botToken).join(REDACTED);
}

export function isTelegramRateLimit(error: unknown): boolean {
  return error instanceof TelegramApiError && error.errorCode === 429;
}

export class TelegramApiError extends Error {
  readonly method: string;
  readonly httpStatus: number;
  readonly errorCode: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(args: {
    method: string;
    httpStatus: number;
    errorCode?: number;
    retryAfterMs?: number;
    detail?: string;
    cause?: unknown;
  }) {
    const parts = [`${args.method} failed`];
    if (args.errorCode !== undefined) parts.push(`errorCode=${args.errorCode}`);
    else parts.push(`httpStatus=${args.httpStatus}`);
    if (args.retryAfterMs !== undefined) parts.push(`retryAfterMs=${args.retryAfterMs}`);
    if (args.detail) parts.push(args.detail);
    super(parts.join(" "));
    this.name = "TelegramApiError";
    this.method = args.method;
    this.httpStatus = args.httpStatus;
    this.errorCode = args.errorCode;
    this.retryAfterMs = args.retryAfterMs;
    this.cause = args.cause;
  }
}

export interface TelegramClient {
  getUpdates(args: { offset?: number; timeout?: number; limit?: number; allowed_updates?: string[] }): Promise<TelegramUpdate[]>;
  sendMessage(args: {
    chatId: number | string;
    text: string;
    messageThreadId?: number;
    parseMode?: "HTML";
    replyMarkup?: InlineKeyboardMarkupShape;
    disableWebPagePreview?: boolean;
  }): Promise<{ messageId: number }>;
  createForumTopic(args: { chatId: number | string; name: string; iconColor?: number }): Promise<{ messageThreadId: number }>;
  editMessageReplyMarkup(args: { chatId: number | string; messageId: number }): Promise<void>;
  answerCallbackQuery(args: { callbackQueryId: string; text?: string; showAlert?: boolean }): Promise<void>;
}

export function createTelegramClient(opts: { fetchImpl: FetchLike; botToken: string; logger: TelegramLogger }): TelegramClient {
  const { fetchImpl, botToken, logger } = opts;

  async function call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      const detail = redactToken(error instanceof Error ? error.message : String(error), botToken);
      logger.warn(`telegram ${method} transport failed: ${detail}`);
      throw new TelegramApiError({ method, httpStatus: 0, detail, cause: error });
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    const envelope = (body ?? {}) as {
      ok?: boolean;
      result?: unknown;
      description?: string;
      parameters?: { retry_after?: number };
    };

    if (response.ok && envelope.ok === true) {
      return envelope.result as T;
    }

    const errorCode = typeof envelope.ok === "boolean" && typeof body === "object"
      ? (body as { error_code?: number }).error_code
      : undefined;
    const retryAfter = typeof envelope.parameters?.retry_after === "number" ? envelope.parameters.retry_after : undefined;
    const error: TelegramApiError = new TelegramApiError({
      method,
      httpStatus: response.status,
      errorCode,
      retryAfterMs: retryAfter !== undefined ? Math.max(0, Math.round(retryAfter * 1000)) : undefined,
      detail: envelope.description ? redactToken(envelope.description, botToken) : undefined,
    });
    logger.warn(`telegram ${method} rejected (errorCode=${errorCode ?? "n/a"}, httpStatus=${response.status})`);
    throw error;
  }

  return {
    getUpdates: (args) =>
      call<TelegramUpdate[]>("getUpdates", {
        ...(args.offset !== undefined ? { offset: args.offset } : {}),
        timeout: args.timeout ?? 30,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.allowed_updates ? { allowed_updates: args.allowed_updates } : {}),
      }).then((result) => (Array.isArray(result) ? result : [])),

    sendMessage: (args) =>
      call<{ message_id: number }>("sendMessage", {
        chat_id: args.chatId,
        text: args.text,
        ...(args.messageThreadId !== undefined ? { message_thread_id: args.messageThreadId } : {}),
        ...(args.parseMode ? { parse_mode: args.parseMode } : {}),
        ...(args.replyMarkup ? { reply_markup: args.replyMarkup } : {}),
        ...(args.disableWebPagePreview ? { disable_web_page_preview: true } : {}),
      }).then((result) => ({ messageId: result?.message_id as number })),

    createForumTopic: (args) =>
      call<{ message_thread_id: number }>("createForumTopic", {
        chat_id: args.chatId,
        name: args.name,
        ...(args.iconColor !== undefined ? { icon_color: args.iconColor } : {}),
      }).then((result) => ({ messageThreadId: result?.message_thread_id as number })),

    editMessageReplyMarkup: (args) =>
      call<unknown>("editMessageReplyMarkup", {
        chat_id: args.chatId,
        message_id: args.messageId,
        reply_markup: { inline_keyboard: [] },
      }).then(() => undefined),

    answerCallbackQuery: (args) =>
      call<unknown>("answerCallbackQuery", {
        callback_query_id: args.callbackQueryId,
        ...(args.text ? { text: args.text } : {}),
        ...(args.showAlert ? { show_alert: true } : {}),
      }).then(() => undefined),
  };
}
