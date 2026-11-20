import { definePlugin } from "@fusion/plugin-sdk";
import type { FusionPlugin, PluginContext, PluginRouteDefinition } from "@fusion/plugin-sdk";

import { createTelegramClient, type FetchLike, type TelegramClient, type TelegramLogger } from "./bot-api.js";
import { createAnswerHandler } from "./answer-handler.js";
import { createInboundLoop, type AnswerHandler } from "./inbound.js";
import { createTelegramOutbox } from "./outbox.js";
import { createTopicRouter, type TopicBindingStore, type TopicRouter } from "./topics.js";
import { createProjectRegistry, type ProjectRegistry } from "./project-registry.js";
import {
  FUSION_EVENT_ROUTE_PATH,
  STATUS_ROUTE_PATH,
  TELEGRAM_PLUGIN_ID,
  createBackgroundTracker,
  createEventDeliverer,
  handleFusionEvent,
  handleStatus,
  type CardSnapshot,
  type DeliveryPort,
  type DeliveryRequest,
  type IngestRequest,
  type OpenQuestion,
  type PluginRouteResponse,
  type QuestionRecord,
} from "./ingest.js";
import { getBotToken, getChatId, getGroupingMode, getHubProjectId, isIngestSecretConfigured, settingsSchema } from "./settings.js";
import { createTelegramPersistence, type TelegramPersistence } from "./persistence.js";

/**
 * FNXC:TelegramBridge 2026-11-20-02:49 (RUFU-782):
 * Async Telegram channel for a Fusion instance, hosted as a plugin rather than a sidecar. Three operator
 * decisions are fixed and shape this file: ONE bot per instance (Telegram `getUpdates` is one stream per
 * token, so the bridge cannot run per project), grouping by Telegram Topics per project, and no new runtime
 * dependency (the Bot API is called over `fetch`).
 *
 * The structural template is `plugins/fusion-plugin-whatsapp-chat`; the one thing that template does not do
 * and this plugin must is a task-correlated answer: an inbound reply becomes a steering comment plus a
 * resume of the parked card.
 *
 * FNXC:TelegramBridge 2026-11-20-02:49 (RUFU-782) — one deliberate difference from that template: the
 * WhatsApp plugin THROWS from `onLoad` when PostgreSQL is unavailable. This plugin loads and reports
 * itself unusable instead, because its outbound half needs no database at all and a misconfigured optional
 * plugin must not take the dashboard down. The half that CAN change a card's lifecycle is the one that
 * fails closed: with no correlation table, an answer is refused.
 */

interface InboundState {
  lastPollAt: number | null;
  processedUpdates: number;
  resumeRequests: number;
  failures: number;
  holder: boolean;
  /** Why this instance is not polling, or null while it is. Silence with no reason reads as an outage. */
  stoppedReason: string | null;
}

/** The correlation table's read side, implemented in `persistence.ts` alongside the write side. */
export interface QuestionStore {
  openQuestionFor(projectId: string, taskId: string): Promise<OpenQuestion | null>;
  insertQuestion(record: QuestionRecord): Promise<void>;
  loadTopicBinding(projectId: string, chatId: string): Promise<number | null>;
  saveTopicBinding(projectId: string, chatId: string, threadId: number): Promise<void>;
}

interface Bridge {
  registry: ProjectRegistry;
  topics: TopicRouter;
  delivery: DeliveryPort;
  questionStore: QuestionStore | null;
  /** Null on a SQLite instance; the inbound loop needs it to claim updates, hold the lease, and resume. */
  persistence: TelegramPersistence | null;
  inbound: () => InboundState;
  /** Sends waiting their turn in a chat queue right now; reported by `/status` as delivery backlog. */
  queuedSends(): number;
  startInbound(): void;
  stopInbound(): void;
}

const bridges = new Map<string, Bridge>();

function bridgeKey(ctx: PluginContext): string {
  return `${ctx.taskStore.getRootDir()}::${ctx.pluginId}`;
}

/**
 * Duck-typed on purpose: `getProjectId()` is a `TaskStore` class accessor and a route context can hand a
 * narrower interface. An unreadable id is treated as "this store serves whatever project the request
 * named", never guessed at, because a wrong own-project read would read another project's cards.
 */
function ownProjectId(ctx: PluginContext): string | undefined {
  const candidate = ctx.taskStore as unknown as { getProjectId?: () => string | null };
  const value = typeof candidate.getProjectId === "function" ? candidate.getProjectId() : null;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function storeFor(ctx: PluginContext, projectId: string) {
  const own = ownProjectId(ctx);
  if (!own || own === projectId) return ctx.taskStore;
  const resolved = await ctx.resolveProjectTaskStore?.(projectId).catch(() => null);
  return resolved ?? null;
}

/** A project's OWN settings, empty when the request already landed on that project's store. */
async function projectSettingsFor(ctx: PluginContext, projectId: string): Promise<Record<string, unknown>> {
  const own = ownProjectId(ctx);
  if (!own || own === projectId) return {};
  const store = await storeFor(ctx, projectId);
  const pluginStore = (
    store as unknown as
      | { getPluginStore?: () => { getPlugin: (id: string) => Promise<{ settings: Record<string, unknown> }> } }
      | undefined
  )?.getPluginStore?.();
  if (!pluginStore) return {};
  const record = await pluginStore.getPlugin(TELEGRAM_PLUGIN_ID).catch(() => null);
  return record?.settings ?? {};
}

/**
 * FNXC:TelegramBridge 2026-11-20-02:49 (RUFU-782):
 * The webhook payload carries no card text, so the question lives only here. The card is read through the
 * store that owns its project; a store that cannot be resolved yields `null`, which degrades the event to
 * a plain notification rather than guessing at a question.
 */
async function readCard(ctx: PluginContext, projectId: string, taskId: string): Promise<CardSnapshot | null> {
  const store = await storeFor(ctx, projectId);
  if (!store) return null;
  const task = await store.getTask(taskId).catch(() => null);
  if (!task) return null;
  return {
    title: typeof task.title === "string" ? task.title : undefined,
    pausedReason: typeof task.pausedReason === "string" ? task.pausedReason : undefined,
    status: typeof task.status === "string" ? task.status : undefined,
    column: typeof task.column === "string" ? task.column : undefined,
  };
}

function lowercaseHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  return out;
}

/** Narrows the Express request to the four fields the ingest route reads, so the route stays testable. */
function toIngestRequest(req: unknown): IngestRequest {
  const request = (req ?? {}) as {
    method?: string;
    query?: Record<string, unknown>;
    headers?: Record<string, unknown>;
    body?: unknown;
  };
  return {
    method: request.method,
    query: request.query ?? {},
    headers: lowercaseHeaders(request.headers ?? {}),
    body: request.body,
  };
}

/** A client that refuses every send, so one missing token cannot become a null dereference deep in a port. */
function unconfiguredClient(logger: TelegramLogger): TelegramClient {
  const refuse = async (): Promise<never> => {
    logger.warn("[telegram] send refused: no bot token configured");
    throw new Error("telegram client is not configured");
  };
  return {
    getUpdates: refuse,
    sendMessage: refuse,
    createForumTopic: refuse,
    editMessageReplyMarkup: refuse,
    answerCallbackQuery: refuse,
  } as unknown as TelegramClient;
}

function topicBindingStore(questionStore: QuestionStore | null, chatId: string | undefined): TopicBindingStore | null {
  if (!questionStore || !chatId) return null;
  return {
    async getTopic(projectId) {
      return questionStore.loadTopicBinding(projectId, chatId);
    },
    async upsertTopic(projectId, boundChatId, threadId) {
      await questionStore.saveTopicBinding(projectId, boundChatId, threadId);
    },
  };
}

/**
 * FNXC:TelegramBridge 2026-11-20-03:29 (RUFU-782):
 * The correlation store is Postgres-only, exactly as in the WhatsApp template. It is resolved through a
 * function rather than inlined so the routing wiring above never has to know whether this instance has a
 * database: `null` means delivery still works and an answer is refused.
 */
function persistenceFor(ctx: PluginContext, logger: TelegramLogger): TelegramPersistence | null {
  return createTelegramPersistence(ctx, logger);
}

/**
 * FNXC:TelegramBridge 2026-11-20-04:21 (RUFU-782):
 * Building the bridge never throws: a missing bot token yields a refusing client, so the state an operator
 * sees is `/status` reporting `botTokenConfigured: false`, not a stack trace out of `onLoad`. The poller is
 * built but not started here — `onLoad` starts it, and `start()` itself refuses to arm a timer without a
 * token, a chat, or a correlation store, because a poller with no durable offset would replay answers.
 */
function buildBridge(ctx: PluginContext, logger: TelegramLogger): Bridge {
  const settings = ctx.settings;
  const botToken = getBotToken(settings);
  const chatId = getChatId(settings);
  const registry = createProjectRegistry();
  const persistence = persistenceFor(ctx, logger);
  const questionStore: QuestionStore | null = persistence?.questions ?? null;
  const fetchImpl: FetchLike = (url, init) => fetch(url, init);
  const client: TelegramClient = botToken
    ? createTelegramClient({ fetchImpl, botToken, logger })
    : unconfiguredClient(logger);
  const topics = createTopicRouter({
    client,
    chatId: chatId ?? "",
    groupingMode: getGroupingMode(settings),
    store: topicBindingStore(questionStore, chatId),
    logger,
  });
  const outbox = createTelegramOutbox({ logger });
  const send = createEventDeliverer({
    client,
    /*
    * FNXC:TelegramBridge 2026-11-20-05:33 (RUFU-782 code review, P1):
    * One outbox per bridge, so every send this instance makes — from any project, from any concurrent
    * webhook POST — passes through the same per-chat queue. Building it here rather than inside the
    * deliverer is what makes the queue shared: the deliverer runs once per event, and a per-event queue
    * would throttle nothing.
    */
    outbox,
    topics,
    logger,
    baseSettings: settings,
    settingsFor: (projectId) => projectSettingsFor(ctx, projectId),
    ...(questionStore ? { insertQuestion: (record: QuestionRecord) => questionStore.insertQuestion(record) } : {}),
    registry,
  });

  const deliver: DeliveryPort["deliver"] = async (request: DeliveryRequest) => {
    if (!botToken) {
      logger.warn("[telegram] event dropped: no bot token configured");
      return { delivered: false, reason: "client-not-configured" };
    }
    return send(request);
  };

  /*
  * FNXC:TelegramBridge 2026-11-20-04:10 (RUFU-782):
  * An answer cannot be honored without the correlation table, so the refusing handler is not a placeholder: it
  * is the notice the operator gets if a poll somehow runs (a database that appears mid-session). It states
  * where to answer instead of pretending the card moved.
  */
  const answers: AnswerHandler = persistence
    ? createAnswerHandler({
      logger,
      questions: persistence.questions,
      storeFor: (projectId) => storeFor(ctx, projectId),
      registry,
    })
    : {
      onCallback: async () => ({ notice: "This Fusion instance has no database for the bridge, so answers must be given in the dashboard.", dropButtons: false }),
      onReply: async () => ({ notice: "This Fusion instance has no database for the bridge, so answers must be given in the dashboard.", dropButtons: false }),
    };

  const loop = createInboundLoop({
    client,
    logger,
    botToken: botToken ?? "",
    chatId: chatId ?? "",
    settings,
    inbound: persistence?.inbound ?? null,
    questions: persistence
      ? {
        findOpenByMessage: async (projectId, boundChatId, botMessageId) => {
          const row = await persistence.questions.findOpenByMessage(projectId, boundChatId, botMessageId);
          return row ? { questionId: row.questionId } : null;
        },
      }
      : null,
    projectsForMessage: async (boundChatId, threadId) => {
      /*
      * A topic names its project outright, which is the common topics-mode case and keeps a reply to one
      * indexed read. Flat delivery shares one chat between projects, so the search runs over every project
      * this instance has talked to, hub first.
      */
      const owner = threadId === null ? null : registry.projectForThread(boundChatId, threadId);
      if (owner) return [owner];
      return registry.knownProjectIds(getHubProjectId(settings) ?? ownProjectId(ctx));
    },
    answers,
  });

  return {
    registry,
    topics,
    questionStore,
    persistence,
    inbound: () => loop.state(),
    /** Sends waiting their turn in a chat queue right now, reported by `/status` as delivery backlog. */
    queuedSends: () => outbox.queued(),
    startInbound: () => loop.start(),
    stopInbound: () => loop.stop(),
    delivery: { deliver, track: createBackgroundTracker(logger) },
  };
}

function loadedBridge(ctx: PluginContext): Bridge | undefined {
  return bridges.get(bridgeKey(ctx));
}

const routes: PluginRouteDefinition[] = [
  {
    method: "POST",
    path: FUSION_EVENT_ROUTE_PATH,
    description: "Receives the instance's notification webhook events (shared secret via ?key=)",
    handler: async (req, ctx) => {
      const bridge = loadedBridge(ctx);
      if (!bridge) {
        return { status: 503, body: { error: "telegram-bridge-not-loaded" } } satisfies PluginRouteResponse;
      }
      return handleFusionEvent(toIngestRequest(req), {
        logger: ctx.logger,
        requestSettings: ctx.settings,
        settingsFor: (projectId) => projectSettingsFor(ctx, projectId),
        readCard: (projectId, taskId) => readCard(ctx, projectId, taskId),
        openQuestionFor: (projectId, taskId) => bridge.questionStore?.openQuestionFor(projectId, taskId) ?? Promise.resolve(null),
        registry: bridge.registry,
        delivery: bridge.delivery,
      });
    },
  },
  {
    method: "GET",
    path: STATUS_ROUTE_PATH,
    description: "Bridge health: bot token reported by length only, per-project topic bindings, inbound counters, queued sends",
    handler: async (_req, ctx) => {
      const bridge = loadedBridge(ctx);
      const response = handleStatus({
        settings: ctx.settings,
        registry: bridge?.registry ?? createProjectRegistry(),
        inbound: bridge?.inbound(),
        queuedSends: bridge?.queuedSends(),
        persistenceAvailable: Boolean(bridge?.persistence),
      });
      // Structurally loaded and able to work are different claims, and only the second one matters.
      const body = response.body as Record<string, unknown>;
      body.ready = Boolean(getBotToken(ctx.settings) && getChatId(ctx.settings) && isIngestSecretConfigured(ctx.settings));
      return response;
    },
  },
];

const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: TELEGRAM_PLUGIN_ID,
    name: "Telegram Bridge",
    version: "0.1.0",
    description: "Telegram async discussion channel: per-project topics and answers that resume parked cards",
    author: "Fusion Team",
    settingsSchema,
  },
  state: "installed",
  routes,
  hooks: {
    onLoad: async (ctx) => {
      const key = bridgeKey(ctx);
      if (bridges.has(key)) return;
      const bridge = buildBridge(ctx, ctx.logger);
      bridges.set(key, bridge);
      if (!getBotToken(ctx.settings) || !getChatId(ctx.settings)) {
        ctx.logger.warn("[telegram] loaded unconfigured: set Bot Token and Chat Id before any event can be delivered");
      }
      if (!isIngestSecretConfigured(ctx.settings)) {
        ctx.logger.warn("[telegram] loaded without an Ingest Secret: the event route refuses every request until one is set");
      }
      // The poller owns its own refusal: without a token, a chat, or a database it arms no timer at all.
      bridge.startInbound();
      ctx.logger.info("[telegram] plugin loaded");
    },
    onUnload: async (ctx) => {
      const bridge = bridges.get(bridgeKey(ctx));
      if (!bridge) return;
      bridges.delete(bridgeKey(ctx));
      // Giving the token lease back is what lets a restarting instance resume polling in seconds rather
      // than after the lease expiry, and it stops this process polling the moment it is unloaded.
      bridge.stopInbound();
      ctx.logger.info("[telegram] plugin unloaded");
    },
  },
});

export default plugin;
