/**
 * Inbound loop: the bridge's only long-lived poller.
 *
 * FNXC:TelegramBridge 2026-11-20-03:29 (RUFU-782):
 * Telegram gives a bot exactly one `getUpdates` stream per token, which is why the whole bridge is one bot
 * per instance (accepted decision 1). Three consequences are load-bearing:
 *
 * 1. Only one process may poll at a time. Two pollers on one token split updates arbitrarily between them,
 *    and each sees a gapless-looking stream while silently dropping half the operator's answers. That is
 *    why every tick renews a database-backed lease keyed by the token's hash and a lost lease stops the
 *    poll rather than continuing without it.
 * 2. The offset is durable. Telegram buffers unread updates for about 24 hours, so an instance that
 *    restarts without an offset would either replay a day of stale answers (each of which can resume a
 *    card) or, if it skips everything, lose the answer the operator already typed. The offset advances
 *    only after an update was handled, never before.
 * 3. The first run on a fresh install adopts the newest `update_id` WITHOUT processing it. There is no
 *    correlation row for a message this instance never sent, so replaying a backlog could only act on
 *    something it cannot identify.
 *
 * Answering is delegated: this file decides WHETHER an update may be acted on (lease, allowlist, replay,
 * correlation) and never what the answer means for a card. That is `answer-handler.ts`.
 */

import type { TelegramClient, TelegramLogger, TelegramUpdate } from "./bot-api.js";
import { TelegramApiError } from "./bot-api.js";
import { parseCallbackData } from "./format.js";
import type { InboundRepository } from "./persistence.js";
import {
  getAllowedChatIds,
  getDedupeRetentionDays,
} from "./settings.js";

/** Long-poll hold time. Telegram caps it at 50 s; 30 s keeps a restart responsive. */
export const DEFAULT_POLL_TIMEOUT_SEC = 30;
/** Backoff ceiling for a failing poll: an unreachable Telegram must not become a hot loop. */
export const MAX_POLL_BACKOFF_MS = 60_000;
/** Default lease lifetime. A holder renews every tick, so only a dead process reaches expiry. */
export const DEFAULT_LEASE_TTL_MS = 90_000;
/** Pause before re-checking a condition another process owns (no lease) or that cannot change by itself. */
export const IDLE_RETRY_MS = 5_000;
/** Telegram returns at most 100 updates per call, which is also the drain step for a first-run backlog. */
const BACKLOG_DRAIN_LIMIT = 100;
/** Bound on backlog draining so a pathological stream cannot hold the first tick open indefinitely. */
const BACKLOG_DRAIN_ROUNDS = 50;

export interface InboundOutcome {
  kind: "callback" | "reply" | "ignored" | "unauthorized";
  questionId?: string;
  reason?: string;
}

/**
 * The card-lifecycle half of an answer, implemented in `answer-handler.ts`. Both methods return the text
 * the operator should see in Telegram, because the refusal reason is the product surface here: an operator
 * who presses a stale button must learn the card moved on, not watch the button spin.
 */
export interface AnswerHandler {
  onCallback(input: {
    questionId: string;
    chatId: string;
    botMessageId: number | null;
    callbackQueryId: string;
    /** Position into the stored option list, or null when the button encoded no choice. */
    optionIndex: number | null;
    /** Projects the correlation row may live in: a button carries no project either. */
    candidateProjectIds: string[];
  }): Promise<{ notice: string | null; dropButtons: boolean }>;
  onReply(input: {
    /** Already resolved by correlation: the reply answered a question this project sent. */
    projectId: string;
    chatId: string;
    botMessageId: number;
    text: string;
  }): Promise<{ notice: string | null; dropButtons: boolean }>;
}

export interface InboundLoopState {
  lastPollAt: number | null;
  processedUpdates: number;
  resumeRequests: number;
  failures: number;
  holder: boolean;
  stoppedReason: string | null;
}

export interface InboundLoop {
  start(): void;
  stop(): void;
  state(): InboundLoopState;
  /** One poll-and-handle pass. Exposed so a test drives the loop without any timer or sleep. */
  tick(): Promise<"polled" | "skipped" | "not-holder">;
}

type Scheduler = (fn: () => void, ms: number) => () => void;

const immediateScheduler: Scheduler = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

/** Reads the chat an update belongs to. An update with no chat cannot be authorized, so it is dropped. */
function chatIdOf(update: TelegramUpdate): string | null {
  const fromMessage = update.callback_query?.message?.chat?.id ?? update.message?.chat?.id;
  return fromMessage === undefined ? null : String(fromMessage);
}

function botMessageIdOf(update: TelegramUpdate): number | null {
  const id = update.callback_query?.message?.message_id ?? update.message?.message_id;
  return typeof id === "number" ? id : null;
}

/** The topic an update was typed in. Flat delivery and clients without topics report null. */
function threadIdOf(update: TelegramUpdate): number | null {
  const id = update.callback_query?.message?.message_thread_id ?? update.message?.message_thread_id;
  return typeof id === "number" ? id : null;
}

/**
 * Handles one already-claimed update: it decodes what the operator touched and hands it over. It never
 * touches a card and never sends a message beyond the two Telegram calls that acknowledge the tap.
 */
export async function processUpdate(args: {
  update: TelegramUpdate;
  allowedChatIds: Set<string>;
  questions: {
    findOpenByMessage(projectId: string, chatId: string, botMessageId: number): Promise<{ questionId: string } | null>;
  } | null;
  /** The project whose correlation row may match. A hub polls once for every project it serves. */
  projectsForMessage(chatId: string, threadId: number | null): Promise<string[]>;
  answers: AnswerHandler;
  logger: TelegramLogger;
  client: Pick<TelegramClient, "answerCallbackQuery" | "editMessageReplyMarkup">;
}): Promise<InboundOutcome> {
  const { update, allowedChatIds, questions, projectsForMessage, answers, logger, client } = args;
  const chatId = chatIdOf(update);

  if (!chatId) return { kind: "ignored", reason: "no-chat" };
  /*
  * The allowlist is checked before any database read and before any acknowledgment. An empty allowlist
  * means nobody (the WhatsApp plugin's rule), so a stranger who discovers the bot cannot even learn
  * whether a question id exists.
  */
  if (!allowedChatIds.has(chatId)) {
    if (update.callback_query) {
      await client.answerCallbackQuery({ callbackQueryId: update.callback_query.id, text: "Not authorized from this chat" }).catch(() => undefined);
    } else {
      logger.debug(`[telegram] inbound message from chat ${chatId} ignored: chat is not in Allowed Chat Ids`);
    }
    return { kind: "unauthorized", reason: "chat-not-allowed" };
  }

  const threadId = threadIdOf(update);

  if (update.callback_query) {
    const query = update.callback_query;
    const parsed = parseCallbackData(query.data ?? "");
    if (!parsed) {
      await client.answerCallbackQuery({ callbackQueryId: query.id, text: "This button is not a Fusion question" }).catch(() => undefined);
      return { kind: "ignored", reason: "unrecognized-callback" };
    }
    const result = await answers.onCallback({
      questionId: parsed.questionId,
      chatId,
      botMessageId: botMessageIdOf(update),
      callbackQueryId: query.id,
      optionIndex: parsed.optionIndex,
      candidateProjectIds: await projectsForMessage(chatId, threadId),
    });
    /*
    * The notice is what the operator sees in Telegram — the client shows it as a toast on the pressed
    * button — so it travels through `answerCallbackQuery` rather than only into a log. A stale button must
    * tell the operator the card moved on instead of spinning.
    */
    await client.answerCallbackQuery({ callbackQueryId: query.id, ...(result.notice ? { text: result.notice } : {}) }).catch(() => undefined);
    if (result.dropButtons && query.message) {
      await client.editMessageReplyMarkup({ chatId: query.message.chat.id, messageId: query.message.message_id }).catch(() => undefined);
    }
    return { kind: "callback", questionId: parsed.questionId };
  }

  const message = update.message;
  const repliedTo = message?.reply_to_message_id;
  if (!message || typeof repliedTo !== "number" || !message.text) {
    return { kind: "ignored", reason: "not-an-answer" };
  }
  if (!questions) return { kind: "ignored", reason: "no-correlation-store" };

  /*
  * A reply carries no project. Its `message_thread_id` usually names one, because a topic belongs to a
  * single project, and the caller narrows to that; in flat mode every project shares one chat, so the
  * row is searched across the projects this instance serves. A message id is unique per chat, so at most
  * one project can own it and the search stops at the first hit rather than asking everyone.
  */
  const threadIdOfUpdate = threadId;
  for (const projectId of await projectsForMessage(chatId, threadIdOfUpdate)) {
    const match = await questions.findOpenByMessage(projectId, chatId, repliedTo);
    if (!match) continue;
    const result = await answers.onReply({ projectId, chatId, botMessageId: repliedTo, text: message.text });
    if (result.notice) logger.info(`[telegram] answer from chat ${chatId} on card question ${match.questionId}: ${result.notice}`);
    if (result.dropButtons) {
      await client.editMessageReplyMarkup({ chatId, messageId: repliedTo }).catch(() => undefined);
    }
    return { kind: "reply", questionId: match.questionId };
  }
  // Replies to anything else (the operator's own note, another bot, an old question) change nothing.
  return { kind: "ignored", reason: "no-correlation" };
}

/**
 * Builds the poller. `tick()` is the unit of behavior; `start()` only owns a timer around it, so the
 * suite asserts the loop without a single real wait (Standing Rule: Do Not Add Slow Tests).
 */
export function createInboundLoop(args: {
  client: TelegramClient;
  logger: TelegramLogger;
  botToken: string;
  chatId: string;
  settings: Record<string, unknown>;
  inbound: InboundRepository | null;
  questions: Parameters<typeof processUpdate>[0]["questions"];
  projectsForMessage(chatId: string, threadId: number | null): Promise<string[]>;
  answers: AnswerHandler;
  pollTimeoutSec?: number;
  leaseTtlMs?: number;
  holderId?: string;
  schedule?: Scheduler;
  now?: () => number;
}): InboundLoop {
  const {
    client, logger, botToken, chatId, settings, inbound, questions, projectsForMessage, answers,
    pollTimeoutSec = DEFAULT_POLL_TIMEOUT_SEC,
    leaseTtlMs = DEFAULT_LEASE_TTL_MS,
    holderId = defaultHolderId(),
    schedule = immediateScheduler,
    now = () => Date.now(),
  } = args;

  let cancel: (() => void) | null = null;
  let running = false;
  let stopping = false;
  let backoffMs = 1_000;
  let lastPollAt: number | null = null;
  let processedUpdates = 0;
  let resumeRequests = 0;
  let failures = 0;
  let holder = false;
  let stoppedReason: string | null = null;
  let offset: number | null | undefined;

  function publicState(): InboundLoopState {
    return { lastPollAt, processedUpdates, resumeRequests, failures, holder, stoppedReason };
  }

  function allowedChatIds(): Set<string> {
    return getAllowedChatIds(settings);
  }

  async function acquireOrRenew(): Promise<boolean> {
    if (!inbound) return false;
    const tokenId = inbound.tokenFingerprint(botToken);
    if (holder) {
      const renewed = await inbound.renewLease(tokenId, holderId, leaseTtlMs);
      if (!renewed) {
        // A lost lease stops this poller rather than continuing blind: two pollers on one token split
        // updates arbitrarily, and each would look healthy while answering half the operator's replies.
        logger.warn("[telegram] inbound: poll lease was taken elsewhere; this process stops polling");
        holder = false;
      }
      return renewed;
    }
    const won = await inbound.acquireLease(tokenId, holderId, leaseTtlMs);
    holder = won;
    if (won) logger.info("[telegram] inbound: holding the poll lease for this bot token");
    return won;
  }

  async function resolveOffset(): Promise<number | null> {
    if (!inbound) return null;
    if (offset !== undefined) return offset;
    const stored = await inbound.loadOffset(chatId);
    if (stored !== null) {
      offset = stored;
      return stored;
    }
    /*
    * First run for this chat: adopt the newest update id WITHOUT acting on it. None of those messages was
    * sent by this instance, so none can be correlated, and an answer replayed from the buffer would still
    * be a write to a card nobody asked about. Drained until Telegram returns a short page, because one
    * page is not the whole buffer when it holds a day of traffic.
    */
    let newest = 0;
    let drained = 0;
    for (let round = 0; round < BACKLOG_DRAIN_ROUNDS; round += 1) {
      const page = await client.getUpdates({ timeout: 0, limit: BACKLOG_DRAIN_LIMIT }).catch(() => [] as TelegramUpdate[]);
      drained += page.length;
      for (const update of page) newest = Math.max(newest, update.update_id);
      if (page.length < BACKLOG_DRAIN_LIMIT) break;
    }
    offset = newest;
    if (newest > 0) {
      await inbound.saveOffset(chatId, newest).catch(() => undefined);
      logger.info(`[telegram] inbound: skipped ${drained} update(s) buffered before this start`);
    }
    return offset;
  }

  /** Why this process must not poll at all, or null when it may try. */
  function cannotPoll(): string | null {
    if (!botToken || !chatId) return "not-configured";
    // No PostgreSQL: polling is refused outright, because a poller without a durable offset replays.
    if (!inbound) return "no-persistence";
    return null;
  }

  async function tick(): Promise<"polled" | "skipped" | "not-holder"> {
    const store = inbound;
    const refusal = cannotPoll();
    if (refusal || !store) {
      stoppedReason = refusal ?? "no-persistence";
      return "skipped";
    }
    if (!(await acquireOrRenew())) {
      if (holder === false && stoppedReason !== "lease-held-elsewhere") {
        logger.info("[telegram] inbound: another process holds the poll lease for this token; standing by");
      }
      stoppedReason = "lease-held-elsewhere";
      holder = false;
      return "not-holder";
    }
    stoppedReason = null;

    const startOffset = await resolveOffset();
    const updates = await client.getUpdates({
      ...(startOffset !== null && startOffset > 0 ? { offset: startOffset + 1 } : {}),
      timeout: pollTimeoutSec,
      allowed_updates: ["message", "callback_query"],
    });
    lastPollAt = now();
    backoffMs = 1_000;

    const allowlist = allowedChatIds();
    for (const update of updates) {
      const claimed = await store.claimUpdate(update.update_id, chatId, getDedupeRetentionDays(settings));
      if (!claimed) {
        offset = Math.max(offset ?? 0, update.update_id);
        continue;
      }
      try {
        const outcome = await processUpdate({
          update, allowedChatIds: allowlist, questions, projectsForMessage, answers, logger, client,
        });
        processedUpdates += 1;
        if (outcome.kind === "callback" || outcome.kind === "reply") resumeRequests += 1;
      } catch (error) {
        failures += 1;
        logger.error(`[telegram] inbound update ${update.update_id} failed: ${describe(error, botToken)}`);
      }
      /*
      * The offset advances after the update was handled, including a handled-but-failed one: replaying a
      * failed update would repeat an action that already reached the card, which is worse than losing a
      * notification. The failure is counted and logged instead.
      */
      offset = Math.max(offset ?? 0, update.update_id);
      await store.saveOffset(chatId, offset).catch(() => undefined);
    }
    return "polled";
  }

  function arm(ms: number) {
    if (stopping || cancel) return;
    cancel = schedule(() => {
      cancel = null;
      void run();
    }, ms);
  }

  async function run(): Promise<void> {
    if (running || stopping) return;
    running = true;
    try {
      const result = await tick();
      // A condition another process owns is re-checked slowly; a real poll returns as soon as Telegram does.
      arm(result === "polled" ? 0 : IDLE_RETRY_MS);
    } catch (error) {
      failures += 1;
      const wait = Math.max(error instanceof TelegramApiError && error.retryAfterMs ? error.retryAfterMs : backoffMs, 1_000);
      backoffMs = Math.min(backoffMs * 2, MAX_POLL_BACKOFF_MS);
      arm(wait);
      logger.warn(`[telegram] inbound poll failed: ${describe(error, botToken)} (retrying in ${wait} ms)`);
    } finally {
      running = false;
    }
  }

  return {
    tick,
    state: publicState,
    start() {
      if (cancel || running) return;
      const refusal = cannotPoll();
      if (refusal) {
        // No timer at all: a bridge that cannot poll must not wake up forever to do nothing.
        stoppedReason = refusal;
        return;
      }
      stopping = false;
      arm(0);
    },
    stop() {
      stopping = true;
      cancel?.();
      cancel = null;
      if (holder && inbound) {
        void inbound.releaseLease(inbound.tokenFingerprint(botToken), holderId).catch(() => undefined);
        holder = false;
      }
    },
  };
}

function defaultHolderId(): string {
  return `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Token-redacted error text; a token travels in the URL of every Bot API call. */
function describe(error: unknown, botToken: string): string {
  const text = error instanceof Error ? error.message : String(error);
  return botToken ? text.split(botToken).join("[telegram-token-redacted]") : text;
}
