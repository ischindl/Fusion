import type { TelegramClient, TelegramLogger } from "./bot-api.js";
import { FORUM_TOPIC_ICON_COLORS, type GroupingMode } from "./settings.js";

/**
 * FNXC:TelegramBridge 2026-11-20-02:49 (RUFU-782):
 * Accepted decision 2: group by project with Telegram Topics. The first event seen for a project
 * creates its topic (`createForumTopic`, which Bot API 9.3/9.4 also allows in a private chat with the
 * user) and the `projectId -> message_thread_id` binding is cached, both in-process and in the
 * plugin's persistent table, so a restart does not mint a second topic per project.
 *
 * A topics failure must not lose the event: the router falls back to `flat` (no `message_thread_id`)
 * and says so loudly exactly once per project per process, because the failure repeats on every send
 * and a per-message warning would drown the channel that is being degraded.
 */

export interface TopicBindingStore {
  getTopic(projectId: string, chatId: string): Promise<number | null>;
  upsertTopic(projectId: string, chatId: string, threadId: number): Promise<void>;
}

export interface TopicRouter {
  /** The `message_thread_id` to send into, or null for flat delivery. */
  resolveThreadId(projectId: string, projectName: string): Promise<number | null>;
  /** Bindings created or read in this process, for the status route. */
  snapshot(): Array<{ projectId: string; threadId: number }>;
}

const TOPIC_NAME_MAX = 128;

/** Deterministic so the same project keeps its colour across topics and processes. */
export function pickTopicIconColor(projectId: string): number {
  let hash = 0;
  for (let i = 0; i < projectId.length; i += 1) {
    hash = (hash * 31 + projectId.charCodeAt(i)) | 0;
  }
  return FORUM_TOPIC_ICON_COLORS[Math.abs(hash) % FORUM_TOPIC_ICON_COLORS.length] as number;
}

export function topicNameFor(projectName: string, projectId: string): string {
  const trimmed = projectName.trim() || projectId;
  return trimmed.length > TOPIC_NAME_MAX ? trimmed.slice(0, TOPIC_NAME_MAX) : trimmed;
}

export function createTopicRouter(args: {
  client: TelegramClient;
  chatId: number | string;
  groupingMode: GroupingMode;
  store: TopicBindingStore | null;
  logger: TelegramLogger;
}): TopicRouter {
  const { client, chatId, groupingMode, store, logger } = args;
  const inProcess = new Map<string, number>();
  const fallbackAnnounced = new Set<string>();

  async function createAndCache(projectId: string, projectName: string): Promise<number> {
    const created = await client.createForumTopic({
      chatId,
      name: topicNameFor(projectName, projectId),
      iconColor: pickTopicIconColor(projectId),
    });
    const threadId = created.messageThreadId;
    if (typeof threadId !== "number" || !Number.isFinite(threadId)) {
      throw new Error("createForumTopic returned no message_thread_id");
    }
    inProcess.set(projectId, threadId);
    if (store) {
      try {
        await store.upsertTopic(projectId, String(chatId), threadId);
      } catch (error) {
        logger.warn(`telegram topic binding could not be persisted for ${projectId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    logger.info(`telegram topic created for project ${projectId}: thread ${threadId}`);
    return threadId;
  }

  return {
    async resolveThreadId(projectId, projectName) {
      if (groupingMode === "flat") return null;

      const cached = inProcess.get(projectId);
      if (cached !== undefined) return cached;

      if (store) {
        try {
          const stored = await store.getTopic(projectId, String(chatId));
          if (stored !== null) {
            inProcess.set(projectId, stored);
            return stored;
          }
        } catch (error) {
          logger.warn(`telegram topic lookup failed for ${projectId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      try {
        return await createAndCache(projectId, projectName);
      } catch (error) {
        if (!fallbackAnnounced.has(projectId)) {
          fallbackAnnounced.add(projectId);
          logger.error(
            `telegram topics unavailable for project ${projectId} (${error instanceof Error ? error.message : String(error)}); ` +
              `falling back to flat [project/CARD] messages in the main chat`,
          );
        }
        return null;
      }
    },

    snapshot() {
      return Array.from(inProcess.entries()).map(([projectId, threadId]) => ({ projectId, threadId }));
    },
  };
}
