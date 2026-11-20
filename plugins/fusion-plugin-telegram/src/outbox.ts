/**
 * FNXC:TelegramBridge 2026-11-20-05:33 (RUFU-782 code review, P1):
 * The one place a Telegram send is allowed to leave this plugin, and the reason `throttleMsPerChat` is a
 * real setting instead of a number in the editor. Two facts make it necessary rather than cosmetic:
 * Telegram permits roughly ONE message per second per chat, and the bridge's sends do not arrive from one
 * serial loop — every accepted webhook POST fires its own background delivery, so N events about N cards
 * produce N concurrent `sendMessage` calls. Telegram's answer to that is HTTP 429, and before this file
 * existed the 429 was caught, logged, and reported as `send-failed` AFTER the route had already answered
 * the webhook with 202 — so the event was gone, unretried, with no operator-visible trace.
 *
 * The shape is therefore a queue PER CHAT (Telegram's limit is per-chat, and a slow project must not stall
 * a healthy one), strictly serialized inside each chat so two sends can never overlap, spaced by the
 * project's own `throttleMsPerChat`, with one bounded retry of a 429 that honors the `retry_after` the API
 * actually sent. Ordering within a chat is preserved by construction, which matters because a supersede
 * edit and the message it follows travel on the same queue.
 *
 * Why the ceiling is short (`maxAttempts = 2`, i.e. one retry): the webhook has already been acknowledged,
 * so a queued send is the only retry there will ever be. Holding a question for minutes behind a hostile
 * or offline Telegram delivers an `awaiting-user-input` prompt after the card may have been answered,
 * which is worse than losing it — the card stays parked and the operator still has the dashboard.
 */

import type { TelegramLogger } from "./bot-api.js";
import { isTelegramRateLimit } from "./bot-api.js";

/** One initial attempt plus one retry, which is what a `retry_after` backoff is worth on an acknowledged event. */
export const DEFAULT_MAX_SEND_ATTEMPTS = 2;

/**
 * A `retry_after` longer than this is a stop signal, not a wait. Telegram has been observed asking for
 * tens of seconds; a question that cannot be delivered inside a minute is stale, and the ceiling is what
 * keeps a misbehaving API from parking the whole queue for an hour.
 */
export const MAX_RETRY_WAIT_MS = 60_000;

/**
 * Sends waiting their turn per chat before new ones are refused. Spacing is ~1.1 s, so this is roughly a
 * minute of backlog: beyond it the operator has a Telegram or network outage, and an unbounded queue would
 * hold every question in memory and then deliver them all to a chat hours after the cards asked them.
 */
export const MAX_QUEUED_PER_CHAT = 60;

/** Thrown when a chat's queue is already at its ceiling. Loud on purpose: it is dropped work. */
export class TelegramOutboxFullError extends Error {
  constructor(readonly chatId: string, readonly queued: number) {
    super(`telegram-outbox-full chat=${chatId} queued=${queued}`);
    this.name = "TelegramOutboxFullError";
  }
}

/** Thrown for a send refused because its retry would have waited longer than {@link MAX_RETRY_WAIT_MS}. */
export class TelegramOutboxBackoffError extends Error {
  constructor(readonly chatId: string, readonly retryAfterMs: number) {
    super(`telegram-outbox-backoff-too-long chat=${chatId} retryAfterMs=${retryAfterMs}`);
    this.name = "TelegramOutboxBackoffError";
  }
}

export interface OutboxSend<T> {
  /** The chat this send targets; the queue and the rate limit are both keyed on it. */
  chatId: string;
  /** The owning project's `throttleMsPerChat`, read by the caller so the outbox never re-derives policy. */
  throttleMs: number;
  /** The actual API call. Run when the chat's turn comes; never run concurrently with another send. */
  run: () => Promise<T>;
}

export interface TelegramOutbox {
  /** Resolves with the send's own result, or rejects once the attempts are exhausted or the queue is full. */
  send<T>(args: OutboxSend<T>): Promise<T>;
  /** Sends currently waiting or in flight, across every chat. Reported by `/status`. */
  queued(): number;
}

interface ChatQueue {
  /** The last queued job in this chat, so the next one waits for it whatever its outcome was. */
  tail: Promise<unknown>;
  /** When this chat last started a send, epoch ms. `undefined` until the first send. */
  lastSendAt: number | undefined;
  waiting: number;
}

/**
 * A per-chat serialized, rate-spaced send queue. `now` and `sleep` are injectable so the spacing contract
 * is testable without real time passing — the same reason the engine's verification seams take a clock.
 */
export function createTelegramOutbox(opts: {
  logger: TelegramLogger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  maxQueuedPerChat?: number;
  maxRetryWaitMs?: number;
}): TelegramOutbox {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_SEND_ATTEMPTS;
  const maxQueued = opts.maxQueuedPerChat ?? MAX_QUEUED_PER_CHAT;
  const maxRetryWaitMs = opts.maxRetryWaitMs ?? MAX_RETRY_WAIT_MS;
  const chats = new Map<string, ChatQueue>();

  function queueFor(chatId: string): ChatQueue {
    const existing = chats.get(chatId);
    if (existing) return existing;
    const fresh: ChatQueue = { tail: Promise.resolve(), lastSendAt: undefined, waiting: 0 };
    chats.set(chatId, fresh);
    return fresh;
  }

  /**
   * One attempt, plus the single retry a 429 earned. Anything that is not a rate limit (a revoked token, a
   * forbidden chat, a 400 from bad Markdown) is rethrown untouched — retrying it twice only delays the
   * error the operator needs to read.
   */
  async function withRateLimitRetry(chatId: string, throttleMs: number, run: () => Promise<unknown>) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        const retryable = isTelegramRateLimit(error) && attempt < maxAttempts;
        if (!retryable) throw error;
        const retryAfterMs = errorRetryAfterMs(error) ?? throttleMs;
        if (retryAfterMs > maxRetryWaitMs) {
          opts.logger.warn("telegram asked for a backoff longer than the bridge will wait, dropping the send", {
            chatId,
            retryAfterMs,
            maxRetryWaitMs,
          });
          throw new TelegramOutboxBackoffError(chatId, retryAfterMs);
        }
        opts.logger.info("telegram rate limited this chat, retrying once", { chatId, attempt, retryAfterMs });
        await sleep(retryAfterMs);
      }
    }
  }

  return {
    send<T>({ chatId, throttleMs, run }: OutboxSend<T>): Promise<T> {
      const queue = queueFor(chatId);
      if (queue.waiting >= maxQueued) {
        opts.logger.error("telegram outbox is full for this chat, refusing the send", { chatId, queued: queue.waiting, maxQueued });
        return Promise.reject(new TelegramOutboxFullError(chatId, queue.waiting));
      }
      queue.waiting += 1;

      const job = async (): Promise<T> => {
        try {
          /*
          * Spacing is measured from the START of the previous send, and the wait is recomputed at the
          * moment this job actually runs (the previous send may have been slow). The result is that starts
          * are at least `throttleMs` apart and never overlap — which is exactly Telegram's constraint, and
          * the reason the queue is per-chat rather than global.
          */
          const sinceLast = queue.lastSendAt === undefined ? Infinity : now() - queue.lastSendAt;
          const waitMs = throttleMs - sinceLast;
          if (waitMs > 0) await sleep(waitMs);
          queue.lastSendAt = now();
          return (await withRateLimitRetry(chatId, throttleMs, run)) as T;
        } finally {
          queue.waiting -= 1;
        }
      };

      const settled = queue.tail.then(job, job);
      // The chain must survive a failed job, or one rejected send would wedge the chat forever.
      queue.tail = settled.then(undefined, () => undefined);
      return settled;
    },
    queued() {
      let total = 0;
      for (const queue of chats.values()) total += queue.waiting;
      return total;
    },
  };
}

/** The `retry_after` Telegram reported, if it reported one. Read structurally, never from the message text. */
function errorRetryAfterMs(error: unknown): number | undefined {
  const candidate = error as { retryAfterMs?: unknown };
  return typeof candidate?.retryAfterMs === "number" && Number.isFinite(candidate.retryAfterMs)
    ? candidate.retryAfterMs
    : undefined;
}

/** True for a send refused because the chat's queue had reached its ceiling. */
export function isOutboxFullError(error: unknown): error is TelegramOutboxFullError {
  return error instanceof TelegramOutboxFullError;
}

/** True for a send dropped because the required backoff exceeded {@link MAX_RETRY_WAIT_MS}. */
export function isOutboxBackoffError(error: unknown): error is TelegramOutboxBackoffError {
  return error instanceof TelegramOutboxBackoffError;
}
