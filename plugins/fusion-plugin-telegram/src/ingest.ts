/**
 * FNXC:TelegramBridge 2026-11-20-02:49 (RUFU-782):
 * The plugin side of the bridge's only inbound event path: `POST /api/plugins/fusion-plugin-telegram/fusion`.
 *
 * Two facts shape this file. The generic webhook provider is the ONLY sender Fusion ever puts on the wire
 * for an event — it sends `event`, a generic `task` block, and `project: { id }`, and nothing else — and
 * this route is exempt from the daemon-token gate, because the provider posts no bearer. So the route is
 * unauthenticated from the platform's point of view and must authenticate the caller itself, fail closed
 * when no secret is configured, and treat every field it reads as hostile input.
 *
 * The payload carries no card text, so the question, the title, and the duplicate-suppression pair are
 * read from the scoped TaskStore rather than trusted from the request body. This module is also the
 * project-correlation site: one event is attributed to exactly one project id, and the settings that
 * decide the rest of the delivery (grouping mode, chat, throttle) are that project's own.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import {
  INGEST_BODY_BYTE_LIMIT,
  getChatId,
  getDashboardBaseUrl,
  getEventFilter,
  getGroupingMode,
  getHubProjectId,
  isIngestSecretConfigured,
  getSettingString,
  getThrottleMsPerChat,
  mergeSettings,
} from "./settings.js";
import type { TelegramClient, TelegramLogger } from "./bot-api.js";
import { isTelegramRateLimit } from "./bot-api.js";
import type { TelegramOutbox } from "./outbox.js";
import { isOutboxBackoffError, isOutboxFullError } from "./outbox.js";
import type { ProjectRegistry } from "./project-registry.js";
import { buildQuestionKeyboard, callbackDataFits, callbackDataFor, extractAwaitInputPauseEpochMs, extractAwaitInputQuestion, hasAwaitInputMarker, parseInlineOptions, renderEventMessage } from "./format.js";
import type { TopicRouter } from "./topics.js";

export const TELEGRAM_PLUGIN_ID = "fusion-plugin-telegram";

/** The route path as registered with the plugin router (the platform serves it under `/api/plugins`). */
export const FUSION_EVENT_ROUTE_PATH = "/fusion";
export const STATUS_ROUTE_PATH = "/status";

export interface PluginRouteResponse {
  status: number;
  body?: unknown;
  contentType?: string;
}

/** The subset of the Express request this route reads, declared so the route is testable without Express. */
export interface IngestRequest {
  method?: string;
  path?: string;
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
  body: unknown;
}

export interface CardSnapshot {
  title?: string;
  /** Carries the `workflow-input:` question text for an await-input park; the webhook payload never does. */
  pausedReason?: string;
  status?: string;
  column?: string;
}

/** The card's still-unanswered question, read from the plugin's own correlation table. */
export interface OpenQuestion {
  questionId: string;
  botMessageId: number;
  /**
   * When this row was created, epoch milliseconds. It is what distinguishes "this card is being asked
   * right now" from "this card was once asked something nobody answered here" — see
   * {@link extractAwaitInputPauseEpochMs}.
   */
  createdAtMs?: number;
}

export interface DeliveryRequest {
  projectId: string;
  projectName?: string;
  event: string;
  taskId?: string;
  taskTitle?: string;
  question?: string;
  options: string[];
  questionId?: string;
  /** Card's previous unanswered question message, so its buttons can be dropped after this send lands. */
  previousBotMessageId?: number;
  /**
   * The stale correlation row this new question replaces. Closing it is the deliverer's job and must
   * happen in the same transaction that inserts the new row, because the table permits one open row per
   * card and a superseded row left standing would make the new question unanswerable.
   */
  supersedesQuestionId?: string;
}

export interface DeliveryPort {
  deliver(request: DeliveryRequest): Promise<{ delivered: boolean; reason?: string; threadId?: number | null }>;
  /**
   * Runs a delivery in the background. The route answers 202 before Telegram has been called, so the
   * promise is reported back to whoever can await it — the production host logs a failure, a test drains it.
   */
  track(task: Promise<unknown>): void;
}

export interface IngestPorts {
  logger: TelegramLogger;
  /** Settings of the store that received the request (the hub's own, or this project's when there is no hub). */
  requestSettings: Record<string, unknown>;
  /** The project's own settings, so a non-hub project's grouping mode and chat win over the hub's. */
  settingsFor(projectId: string): Promise<Record<string, unknown>>;
  readCard(projectId: string, taskId: string): Promise<CardSnapshot | null>;
  /**
   * The card's unanswered question, or null. This one read serves two decisions that must not disagree:
   * suppressing a second question to a card that is already asking, and knowing which message's buttons to
   * drop once the new question is delivered.
   */
  openQuestionFor(projectId: string, taskId: string): Promise<OpenQuestion | null>;
  registry: ProjectRegistry;
  delivery: DeliveryPort;
}

interface ParsedEvent {
  event: string;
  projectId: string;
  projectName?: string;
  taskId?: string;
  taskTitle?: string;
}

function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nested(record: unknown, key: string): Record<string, unknown> | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function shortString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 512);
}

/**
 * FNXC:TelegramBridge 2026-11-20-02:49 (RUFU-782):
 * A wrong secret must cost the same whether it differs in the first byte or the last, and an unset secret
 * must refuse rather than accept everything — this route is exempt from the daemon-token gate, so this
 * check is the only thing between an unauthenticated local caller and a Telegram message carrying a real
 * card's title. Lengths are compared before `timingSafeEqual`, which throws on unequal lengths.
 */
export function verifyIngestSecret(provided: string | undefined, configured: string | undefined): boolean {
  if (!configured?.trim()) return false;
  const expected = Buffer.from(configured, "utf8");
  const supplied = Buffer.from(provided ?? "", "utf8");
  if (supplied.length !== expected.length) return false;
  if (supplied.length === 0) return false;
  return timingSafeEqual(supplied, expected);
}

/** Body-size guard: the header is checked first so an oversized body is refused before it is parsed. */
function contentLengthWithinLimit(headers: Record<string, unknown>): boolean {
  const raw = headers["content-length"] ?? headers["Content-Length"];
  if (typeof raw !== "string" && typeof raw !== "number") return true;
  const length = Number(raw);
  if (!Number.isFinite(length)) return false;
  return length <= INGEST_BODY_BYTE_LIMIT;
}

function isJsonContentType(headers: Record<string, unknown>): boolean {
  const raw = headers["content-type"] ?? headers["Content-Type"];
  if (typeof raw !== "string") return false;
  return /application\/json/i.test(raw);
}

/**
 * Correlates one event to one project. The body's `project.id` is authoritative because the engine derives
 * it from the store that owns the card; a `?projectId=` that disagrees is refused rather than guessed, since
 * picking either would deliver a card into the wrong project's topic. A project id configured on the
 * receiving store is the last resort, which is what lets a single-project instance leave the webhook URL
 * free of query parameters.
 */
export function correlateProject(
  body: unknown,
  query: Record<string, unknown>,
  fallbackProjectId?: string,
): { projectId: string } | { error: string } {
  const bodyProject = shortString(nested(body, "project")?.id);
  const queryProject = queryString(query.projectId);

  if (bodyProject && queryProject && bodyProject !== queryProject) {
    return { error: "project-mismatch" };
  }
  const projectId = bodyProject ?? queryProject ?? fallbackProjectId;
  if (!projectId) return { error: "unknown-project" };
  return { projectId };
}

function parseEvent(
  body: unknown,
  query: Record<string, unknown>,
  fallbackProjectId?: string,
): { parsed?: ParsedEvent; error?: string } {
  const event = shortString((body as { event?: unknown })?.event);
  if (!event) return { error: "missing-event" };

  const correlation = correlateProject(body, query, fallbackProjectId);
  if ("error" in correlation) return { error: correlation.error };

  const project = nested(body, "project");
  const task = nested(body, "task");
  return {
    parsed: {
      event,
      projectId: correlation.projectId,
      projectName: shortString(project?.name),
      taskId: shortString(task?.id),
      taskTitle: shortString(task?.title),
    },
  };
}

/**
 * FNXC:TelegramBridge 2026-11-20-02:49 (RUFU-782):
 * Does this card have a question on Telegram that an operator could still answer? The pair that proves it
 * lives in the plugin's own correlation table, not on the card: `chatId`/`botMessageId` are not writable
 * core Task fields, and `sourceMetadataPatch` is the only plugin-owned seam on a card, so the bridge keeps
 * its own state keyed by `(projectId, taskId)`.
 *
 * FNXC:TelegramBridge 2026-11-20-05:33 (RUFU-782 code review, P0):
 * This answers "is anything open", which is NOT "should this park be suppressed" — that judgement needs
 * the pause as well, so it is now {@link questionAnswersThisPause}. Kept separate because the two facts
 * drive different actions: an open row that answers a DIFFERENT pause is not a reason to stay silent, it
 * is the row this new question must replace.
 */
export function alreadyAwaitingOnTelegram(open: OpenQuestion | null): boolean {
  return Boolean(open?.questionId && open?.botMessageId);
}

/**
 * True only when the open row was created FOR the pause being announced right now.
 *
 * FNXC:TelegramBridge 2026-11-20-05:33 (RUFU-782 code review, P0):
 * The failure this prevents: the dashboard-first flow is supported — an operator may answer an
 * `awaiting-user-input` card in the dashboard (`POST /api/tasks/:id/workflow/input` + resume), and that
 * path never tells Telegram. The plugin's row therefore stays `open` forever, and a suppression rule
 * reading only "is a row open" silenced every LATER question for that card — a card that answered once in
 * the dashboard could never be asked about on Telegram again. The card state decides it instead:
 * `runAwaitInputNode` re-stamps `@<pauseEpochMs>` on every park, so a row created BEFORE the current
 * watermark cannot be this pause's question, however alive it still looks in the plugin's table. Both
 * times come from the same daemon clock and a row is always inserted after its park, so `>=` is the
 * honest test for "this row is the answer to what is being announced now".
 * A pause with no watermark, or a row with no creation time, proves nothing about which pause it belongs
 * to; the answer is then `false` so the question is delivered rather than silently dropped — the shipped
 * marker format always carries a watermark, and a re-ask costs one message whose predecessor loses its
 * buttons, while the opposite bias is what produced the permanent silence being fixed here.
 */
export function questionAnswersThisPause(open: OpenQuestion | null, pauseEpochMs: number | undefined): boolean {
  if (!alreadyAwaitingOnTelegram(open)) return false;
  if (pauseEpochMs === undefined || open?.createdAtMs === undefined) return false;
  return open.createdAtMs >= pauseEpochMs;
}


/**
 * FNXC:TelegramBridge 2026-11-20-02:49 (RUFU-782):
 * An opaque 11-character id with NO `q:` prefix, because `callbackDataFor` is the one place that adds it —
 * a prefix carried in both places would either double it into `q:q:…` or silently steal bytes from the 64
 * byte ceiling. It is never derived from the card id or the question text: card ids like `RUFU-1234` plus
 * the prefix leave no room for the ceiling to hold as a property, and question text is not opaque at all.
 */
export function newQuestionId(): string {
  return createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("base64url").slice(0, 11);
}

function accepted(questionId: string): boolean {
  return callbackDataFits(callbackDataFor(questionId));
}

/**
 * Turns one validated Fusion event into one Telegram delivery, or explains why nothing was sent.
 *
 * FNXC:TelegramBridge 2026-11-20-02:49 (RUFU-782):
 * The order is the contract. Secret, content type, and size are checked before the body is interpreted;
 * the project is correlated before any of its settings are read; the project's own `eventFilter` is
 * consulted before a message could be sent; and a card already awaiting an answer is suppressed rather
 * than asked twice. Only then is the question taken from the live card row — never from the request body,
 * which carries no card text at all — and the delivery handed to the background track so the response
 * answers 202 without waiting for Telegram.
 */
export async function handleFusionEvent(request: IngestRequest, ports: IngestPorts): Promise<PluginRouteResponse> {
  const hubSettings = ports.requestSettings;

  const configuredSecret = getSettingString(hubSettings, "ingestSecret");
  if (!configuredSecret) {
    return { status: 401, body: { error: "ingest-secret-not-configured" } };
  }
  if (!verifyIngestSecret(queryString(request.query.key), configuredSecret)) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  if (!contentLengthWithinLimit(request.headers)) {
    return { status: 413, body: { error: "payload-too-large" } };
  }
  if (!isJsonContentType(request.headers)) {
    return { status: 415, body: { error: "unsupported-content-type" } };
  }
  if (request.body === undefined || request.body === null) {
    return { status: 400, body: { error: "missing-body" } };
  }

  const { parsed, error } = parseEvent(request.body, request.query, getHubProjectId(hubSettings));
  if (!parsed) {
    return { status: error === "project-mismatch" ? 409 : 400, body: { error } };
  }

  const projectSettings = await ports.settingsFor(parsed.projectId);
  const settings = mergeSettings(hubSettings, projectSettings);

  ports.registry.record(parsed.projectId, parsed.projectName);

  if (!getChatId(settings)) {
    return { status: 202, body: { status: "ignored", reason: "chat-not-configured", projectId: parsed.projectId } };
  }

  const filter = getEventFilter(settings);
  if (!filter.has(parsed.event)) {
    return { status: 202, body: { status: "ignored", reason: "event-filtered", event: parsed.event, projectId: parsed.projectId } };
  }

  const card = parsed.taskId ? await ports.readCard(parsed.projectId, parsed.taskId) : null;
  const question = hasAwaitInputMarker(card?.pausedReason) ? extractAwaitInputQuestion(card?.pausedReason) : undefined;

  const open = parsed.taskId ? await ports.openQuestionFor(parsed.projectId, parsed.taskId) : null;
  /*
  * FNXC:TelegramBridge 2026-11-20-05:33 (RUFU-782 code review, P0):
  * Suppress only a question that answers THIS pause. An open row older than the card's current pause
  * watermark is a question the operator answered somewhere else — the dashboard, or a park that has since
  * been resumed — and treating it as "already asked" is what made a dashboard answer permanently silence
  * the card on Telegram. Such a row is superseded by the new delivery: its buttons go away with the new
  * send, and closing its row is what stops an answer to the stale message from resuming the CURRENT park
  * with the PREVIOUS question's stored option text.
  */
  if (question !== undefined && questionAnswersThisPause(open, extractAwaitInputPauseEpochMs(card?.pausedReason))) {
    return {
      status: 202,
      body: { status: "ignored", reason: "already-awaiting-input", projectId: parsed.projectId, taskId: parsed.taskId },
    };
  }
  const superseded = question !== undefined && alreadyAwaitingOnTelegram(open) ? open : undefined;
  if (superseded && extractAwaitInputPauseEpochMs(card?.pausedReason) === undefined) {
    // The only shape where a re-ask could be a duplicate of a still-live question: an undated pause.
    ports.logger.warn("re-asking a card whose pause carries no watermark, so the open question could not be dated", {
      projectId: parsed.projectId,
      taskId: parsed.taskId,
      questionId: superseded.questionId,
    });
  }

  const options = question ? parseInlineOptions(question) : [];
  const questionId = question !== undefined ? newQuestionId() : undefined;
  if (questionId && !accepted(questionId)) {
    return { status: 500, body: { error: "question-id-unrepresentable" } };
  }

  const delivery = ports.delivery.deliver({
    projectId: parsed.projectId,
    projectName: parsed.projectName,
    event: parsed.event,
    taskId: parsed.taskId,
    taskTitle: parsed.taskTitle ?? card?.title,
    question,
    options,
    questionId,
    previousBotMessageId: superseded?.botMessageId,
    supersedesQuestionId: superseded?.questionId,
  });
  ports.delivery.track(delivery);

  return {
    status: 202,
    body: {
      status: "queued",
      projectId: parsed.projectId,
      event: parsed.event,
      ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
      ...(questionId ? { questionId } : {}),
    },
  };
}

/**
 * FNXC:TelegramBridge 2026-11-20-02:49 (RUFU-782):
 * The status route reports a token by its LENGTH only. It is the operator's first debugging stop, and the
 * cheapest way to leak a bot token — which grants full control of the bot and its chat history to anyone
 * holding it — is a diagnostics endpoint that echoes it back.
 */
export function handleStatus(input: {
  settings: Record<string, unknown>;
  registry: ProjectRegistry;
  inbound?: { lastPollAt: number | null; processedUpdates: number; resumeRequests: number; failures: number; holder: boolean; stoppedReason?: string | null };
  /** Whether this instance can host the correlation table at all (Postgres-only). */
  persistenceAvailable?: boolean;
  /**
   * Sends currently waiting in a per-chat queue. Reported because a queue is invisible from the outside:
   * an operator watching four cards park at once sees nothing on Telegram for several seconds and cannot
   * tell "waiting its turn at 1.1 s spacing" from "the bot is broken".
   */
  queuedSends?: number;
}): PluginRouteResponse {
  const botToken = typeof input.settings.botToken === "string" ? input.settings.botToken.trim() : "";
  const allowedChatIds = typeof input.settings.allowedChatIds === "string" ? input.settings.allowedChatIds : undefined;

  return {
    status: 200,
    body: {
      pluginId: TELEGRAM_PLUGIN_ID,
      botTokenConfigured: botToken.length > 0,
      botTokenLength: botToken.length,
      chatIdConfigured: Boolean(getChatId(input.settings)),
      groupingMode: getGroupingMode(input.settings),
      eventFilter: getEventFilter(input.settings),
      ingestSecretConfigured: isIngestSecretConfigured(input.settings),
      /*
      * FNXC:TelegramBridge 2026-11-20-03:29 (RUFU-782):
      * `true` here means only that the plugin loaded. A bridge whose correlation table cannot be opened
      * delivers notifications and refuses every question, so an operator reading `loaded` alone would
      * conclude that unanswered cards were a Telegram delivery problem rather than a missing database.
      */
      persistenceAvailable: input.persistenceAvailable ?? false,
      allowedChatIdsConfigured: Boolean(allowedChatIds && allowedChatIds.trim()),
      dashboardBaseUrl: getDashboardBaseUrl(input.settings) ?? null,
      projects: input.registry.snapshot(),
      /*
      * FNXC:TelegramBridge 2026-11-20-04:12 (RUFU-782):
      * `stoppedReason` belongs in the same report as the counters because it explains their silence: a
      * bridge holding no lease, missing a chat id, or sitting on an instance without Postgres shows zero
      * processed updates forever, which looks exactly like a Telegram outage from the outside.
      */
      inbound: input.inbound ?? { lastPollAt: null, processedUpdates: 0, resumeRequests: 0, failures: 0, holder: false, stoppedReason: "not-loaded" },
      queuedSends: input.queuedSends ?? 0,
      recentAnswers: input.registry.recentAnswers(3),
    },
  };
}

/** A row in the plugin's question-correlation table, keyed by the Telegram message that carries it. */
export interface QuestionRecord {
  projectId: string;
  questionId: string;
  taskId?: string;
  chatId: string;
  threadId: number | null;
  botMessageId: number;
  kind: "text" | "single_select";
  options: string[];
  questionText: string;
  /** An open row this question replaces, closed in the same transaction as this insert. */
  supersedesQuestionId?: string;
}

export interface DelivererPorts {
  client: Pick<TelegramClient, "sendMessage" | "editMessageReplyMarkup">;
  /**
   * FNXC:TelegramBridge 2026-11-20-05:33 (RUFU-782 code review, P1):
   * Mandatory, not optional. Every send goes through the per-chat queue, because that queue IS the
   * throttle: an optional outbox would mean a caller could silently deliver at unlimited concurrency,
   * which is the exact defect this exists to remove. Only `editMessageReplyMarkup` stays outside it — it is
   * cosmetic, already serialized behind its own send inside one delivery, and Telegram rate-counts edits
   * under a different ceiling than messages.
   */
  outbox: TelegramOutbox;
  topics: TopicRouter;
  logger: TelegramLogger;
  /** The hub settings the bridge loaded with: one bot per instance means the token and chat live here. */
  baseSettings: Record<string, unknown>;
  /** The project's OWN settings, merged over `baseSettings` (a blank there must not erase a hub value). */
  settingsFor(projectId: string): Promise<Record<string, unknown>>;
  /** Absent when the instance has no Postgres async layer: delivery then works, correlation does not. */
  insertQuestion?(record: QuestionRecord): Promise<void>;
  registry: ProjectRegistry;
}

/**
 * FNXC:TelegramBridge 2026-11-20-02:49 (RUFU-782):
 * One accepted Fusion event becomes exactly one Telegram message. Three ordering facts are the contract:
 * the thread is resolved BEFORE sending, because `message_thread_id` is a send parameter and a failed topic
 * creation must degrade to flat delivery rather than lose the event; the correlation row is written only
 * after the send returned a real `message_id`, because a row pointing at a message that does not exist
 * would hand an operator's answer to nothing; and the previous question's buttons are dropped only after
 * THIS send succeeded, so a failed send cannot leave the card with no visible question at all.
 *
 * A delivery failure is logged without the bot token (`bot-api.ts` redacts it) and reported as
 * `{ delivered: false }` — the ingest response has already answered 202, so a Telegram outage must not
 * turn into a failed webhook call or a retried duplicate question.
 */
export function createEventDeliverer(ports: DelivererPorts): DeliveryPort["deliver"] {
  return async (request: DeliveryRequest) => {
    const settings = mergeSettings(ports.baseSettings, await ports.settingsFor(request.projectId));
    const chatId = getChatId(settings);
    if (!chatId) {
      return { delivered: false, reason: "chat-not-configured" };
    }

    const groupingMode = getGroupingMode(settings);
    // A project that overrode the hub's mode to flat must not be sent into a topic, even though the hub
    // router resolved one: `flat` is the switch that says "this chat has no topics", and the prefix the
    // renderer adds is meaningless if the message still lands in a thread nobody reads.
    const threadId = groupingMode === "flat" ? null : await ports.topics.resolveThreadId(request.projectId, request.projectName ?? request.projectId);
    const text = renderEventMessage({
      event: request.event,
      projectId: request.projectId,
      projectName: request.projectName,
      taskId: request.taskId,
      taskTitle: request.taskTitle,
      groupingMode,
      question: request.question,
      options: request.options,
      dashboardBaseUrl: getDashboardBaseUrl(settings),
    });
    const replyMarkup = request.question !== undefined
      ? buildQuestionKeyboard(request.questionId ?? "", request.options)
      : undefined;

    try {
      /*
      * The project's own spacing travels with the job: `throttleMsPerChat` is a per-project setting while
      * the queue is per-chat, and one bot serving several projects must honor the setting of whoever asked
      * for this message rather than a value frozen at load time.
      */
      const sent = await ports.outbox.send({
        chatId,
        throttleMs: getThrottleMsPerChat(settings),
        run: () => ports.client.sendMessage({
          chatId,
          text,
          parseMode: "HTML",
          ...(threadId !== null ? { messageThreadId: threadId } : {}),
          ...(replyMarkup ? { replyMarkup } : {}),
        }),
      });
      ports.registry.noteDelivery(request.projectId, threadId);

      if (request.question !== undefined && request.questionId && sent?.messageId) {
        await ports.insertQuestion?.({
          projectId: request.projectId,
          questionId: request.questionId,
          taskId: request.taskId,
          chatId,
          threadId,
          botMessageId: sent.messageId,
          kind: request.options.length > 0 ? "single_select" : "text",
          options: request.options,
          questionText: request.question,
          ...(request.supersedesQuestionId ? { supersedesQuestionId: request.supersedesQuestionId } : {}),
        });
      }

      if (request.previousBotMessageId && sent?.messageId) {
        try {
          await ports.client.editMessageReplyMarkup({ chatId, messageId: request.previousBotMessageId });
        } catch (error) {
          // Superseding the older question is cosmetic; the new question is already delivered.
          ports.logger.warn("could not drop buttons from the superseded question", { error });
        }
      }

      return { delivered: true, threadId };
    } catch (error) {
      ports.logger.error("telegram delivery failed", { projectId: request.projectId, event: request.event, error });
      /*
      * FNXC:TelegramBridge 2026-11-20-05:33 (RUFU-782 code review, P1):
      * The reason names the gate that refused, because "send-failed" for a rate limit and for a revoked
      * token send the operator to different settings. A plain error is still `send-failed`: only a real
      * Telegram 429 (or the outbox's own refusal, which carries its own reason) is classified as throttling.
      */
      const reason = isOutboxFullError(error)
        ? "queue-full"
        : isOutboxBackoffError(error) || isTelegramRateLimit(error)
          ? "send-throttled"
          : "send-failed";
      return { delivered: false, reason, threadId };
    }
  };
}

/**
 * FNXC:TelegramBridge 2026-11-20-02:49 (RUFU-782):
 * The route answers 202 before Telegram has been reached, so the delivery promise must be owned by
 * somebody. The production host logs a failure — the event is already acknowledged, and a retry would
 * duplicate a question an operator may have answered in the dashboard since. A test injects its own
 * tracker and awaits the recorded promises.
 */
export function createBackgroundTracker(logger: TelegramLogger): DeliveryPort["track"] {
  return (task: Promise<unknown>) => {
    void task.catch((error) => {
      logger.error("background telegram delivery rejected", { error });
    });
  };
}
