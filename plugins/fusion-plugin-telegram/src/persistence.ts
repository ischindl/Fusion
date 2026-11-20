/**
 * PostgreSQL persistence for the Telegram bridge.
 *
 * FNXC:TelegramBridge 2026-11-20-03:29 (RUFU-782):
 * `chatId` / `botMessageId` are not writable core Task fields, so the correlation between an operator's
 * Telegram answer and the card it un-parks lives HERE, in plugin-owned tables. The drizzle shape is
 * declared once in `packages/core/src/postgres/schema/plugin.ts` and materialized by the
 * `fusion-plugin-telegram` schema-init hook; this module is the only reader and writer.
 *
 * Two partition rules, and they are not interchangeable:
 * - Card-facing rows (topic bindings, questions) are keyed by the PROJECT THAT OWNS THE CARD. An event
 *   routed through the hub still writes into the owning project's partition, which is why every
 *   card-facing method takes a `projectId` and resolves the layer for it rather than reusing one
 *   connection for everything. An answer correlated across partitions would resume another project's
 *   parked card.
 * - Poller-facing rows (the `update_id` replay guard, the `getUpdates` offset, the token lease) are
 *   instance-level: one bot is long-polled by exactly one holder, so splitting those per project would
 *   let two projects each believe they consumed the same `update_id`.
 *
 * Postgres-only by contract: no SQLite path exists for these tables. A missing or unbound data layer
 * yields `null` rather than an approximation, and the bridge then refuses to ask questions at all — a
 * question with nowhere to record its correlation is a question whose answer would resume nothing.
 */

import { createHash } from "node:crypto";
import type { PluginContext, PluginLogger } from "@fusion/plugin-sdk";
import { sql } from "drizzle-orm";
import type { OpenQuestion, QuestionRecord } from "./ingest.js";

const DAY_MS = 86_400_000;

/** A stored question, decoded. `open` is derived from `status`, never stored twice. */
export interface StoredQuestion {
  questionId: string;
  projectId: string;
  taskId: string | null;
  chatId: string;
  threadId: number | null;
  botMessageId: number;
  kind: QuestionRecord["kind"];
  options: string[];
  questionText: string;
  createdAt: string;
  answeredAt: string | null;
  open: boolean;
  /**
   * The card was re-asked while this question was still open, so this one is closed without anyone
   * answering it. Distinct from `answered` so the operator is told the truth about their buttons.
   */
  superseded: boolean;
}

/** Card-facing rows, partitioned by the project that owns the card. */
export interface QuestionRepository {
  openQuestionFor(projectId: string, taskId: string): Promise<OpenQuestion | null>;
  insertQuestion(record: QuestionRecord): Promise<void>;
  loadTopicBinding(projectId: string, chatId: string): Promise<number | null>;
  saveTopicBinding(projectId: string, chatId: string, threadId: number): Promise<void>;
  findQuestion(projectId: string, questionId: string): Promise<StoredQuestion | null>;
  findOpenByMessage(projectId: string, chatId: string, botMessageId: number): Promise<StoredQuestion | null>;
  /** Returns the row it just closed, or null when it was already answered — the caller must not resume twice. */
  markAnswered(projectId: string, questionId: string): Promise<StoredQuestion | null>;
  /**
   * Puts a just-closed question back to `open` when the answer could not be delivered, so an operator who
   * answered in Telegram is not left believing the card moved. Returns false when the row is gone or when
   * the card already carries a newer open question, which the one-open-per-card index refuses.
   */
  reopenQuestion(projectId: string, questionId: string): Promise<boolean>;
}

/** Poller-facing rows, written through the instance's own partition. */
export interface InboundRepository {
  claimUpdate(updateId: number, chatId: string, retentionDays: number): Promise<boolean>;
  pruneProcessedUpdates(retentionDays: number): Promise<number>;
  loadOffset(chatId: string): Promise<number | null>;
  saveOffset(chatId: string, offset: number): Promise<void>;
  /** sha256 of the bot token: the identity the lease is keyed by. The token itself is never stored. */
  tokenFingerprint(botToken: string): string;
  acquireLease(botTokenId: string, holderId: string, ttlMs: number): Promise<boolean>;
  renewLease(botTokenId: string, holderId: string, ttlMs: number): Promise<boolean>;
  releaseLease(botTokenId: string, holderId: string): Promise<void>;
}

export interface TelegramPersistence {
  questions: QuestionRepository;
  inbound: InboundRepository;
}

type Sql = ReturnType<typeof sql>;

export interface AsyncLayerLike {
  projectId?: string | null;
  db: { execute(query: Sql): Promise<unknown> };
  transactionImmediate<T>(fn: (tx: { execute(query: Sql): Promise<unknown> }) => Promise<T>): Promise<T>;
}

type TaskStoreLike = PluginContext["taskStore"] & {
  getAsyncLayer?: () => AsyncLayerLike | null;
};

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const shaped = result as { rows?: T[] } | null;
  return shaped?.rows ?? [];
}

function asNumber(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : null;
}

function parseOptions(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

type QuestionRow = {
  question_id: string;
  task_id: string | null;
  chat_id: string;
  thread_id: number | string | null;
  bot_message_id: number | string;
  kind: string;
  options: string | null;
  question_text: string;
  status: string;
  created_at: string;
  answered_at: string | null;
};

const QUESTION_COLUMNS = `question_id, task_id, chat_id, thread_id, bot_message_id, kind, options, question_text, status, created_at, answered_at`;

/*
* A module constant inlined as a raw fragment. Values are ALWAYS bound as parameters by the `sql`
* template: `sql.raw` interpolates its argument into the statement text, so it belongs to a fixed column
* list and never near a request-derived value.
*/
const QUESTION_COLUMNS_SQL = sql.raw(QUESTION_COLUMNS);

function decode(row: QuestionRow | undefined, projectId: string): StoredQuestion | null {
  if (!row) return null;
  return {
    questionId: row.question_id,
    projectId,
    taskId: row.task_id,
    chatId: row.chat_id,
    threadId: asNumber(row.thread_id),
    botMessageId: Number(row.bot_message_id),
    kind: row.kind === "single_select" ? "single_select" : "text",
    options: parseOptions(row.options),
    questionText: row.question_text,
    createdAt: row.created_at,
    answeredAt: row.answered_at ?? null,
    open: row.status === "open",
    superseded: row.status === "superseded",
  };
}

/**
 * The card-facing repository over a resolver for the owning project's data layer. Extracted from
 * `createTelegramPersistence` so the SQL can be exercised against the shared PostgreSQL harness without
 * a `PluginContext`, exactly as the WhatsApp plugin's persistence test binds a layer by hand.
 */
export function createQuestionRepository(
  layerFor: (projectId: string) => Promise<AsyncLayerLike | null>,
  logger: PluginLogger,
): QuestionRepository {
  async function query<T>(projectId: string, build: () => Sql): Promise<T[]> {
    const layer = await layerFor(projectId);
    if (!layer) return [];
    return rowsOf<T>(await layer.db.execute(build()));
  }

  return {
    async openQuestionFor(projectId, taskId) {
      const found = await query<{ question_id: string; bot_message_id: number | string; created_at: string }>(projectId, () => sql`
        SELECT question_id, bot_message_id, created_at FROM project.telegram_questions
        WHERE project_id = ${projectId} AND task_id = ${taskId} AND status = 'open'
        ORDER BY created_at DESC LIMIT 1`);
      const row = found[0];
      const botMessageId = row ? Number(row.bot_message_id) : Number.NaN;
      if (!row || !Number.isFinite(botMessageId)) return null;
      /*
      * `created_at` is the row's claim about WHICH park it asked about, and the ingest route needs it to
      * decide whether that park is still the current one. An unparseable stamp stays undefined rather
      * than becoming 0: a fabricated date would make a fresh row look ancient and re-ask a card that is
      * already being answered.
      */
      const createdAtMs = Date.parse(row.created_at);
      return {
        questionId: row.question_id,
        botMessageId,
        ...(Number.isFinite(createdAtMs) ? { createdAtMs } : {}),
      };
    },

    async insertQuestion(record) {
      const stamp = new Date().toISOString();
      const layer = await layerFor(record.projectId);
      if (!layer) {
        logger.warn(`[telegram] question ${record.questionId} could not be recorded: no data layer for its project. Its answer will be refused.`);
        return;
      }
      /*
      * `uqTelegramQuestionsOpenTask` refuses a second OPEN row for the same card: the durable form of
      * "do not ask twice". A conflict means two events raced past the route's suppression — the message
      * is already on Telegram, so the ROW is dropped and the earlier question stays authoritative rather
      * than the newer one silently stealing the answer.
      */
      /*
      * FNXC:TelegramBridge 2026-11-20-05:33 (RUFU-782 code review, P0):
      * A question the operator answered in the DASHBOARD never gets closed by anything else, so the row
      * that this delivery supersedes is closed HERE, in the same transaction as the new INSERT. Two
      * reasons it cannot be a separate statement: `uqTelegramQuestionsOpenTask` allows one OPEN row per
      * card, so the stale row must be gone before the new one can exist — closing it afterwards would
      * have the new question refused and left unanswerable; and a crash between the two statements must
      * not be able to leave a card with no open question at all.
      * The status is `superseded`, not `answered`: nobody answered it, and the distinction is what keeps
      * `reopenQuestion` (which restores `answered` rows only after a failed resume) from ever putting a
      * question the card has moved past back into play.
      */
      const inserted = await layer.transactionImmediate(async (tx) => {
        if (record.supersedesQuestionId) {
          await tx.execute(sql`
            UPDATE project.telegram_questions SET status = 'superseded', answered_at = ${stamp}
            WHERE project_id = ${record.projectId} AND question_id = ${record.supersedesQuestionId}
              AND status = 'open'`);
        }
        return rowsOf<{ question_id: string }>(await tx.execute(sql`
          INSERT INTO project.telegram_questions(
            project_id, question_id, task_id, chat_id, thread_id, bot_message_id,
            kind, options, question_text, status, created_at)
          VALUES(${record.projectId}, ${record.questionId}, ${record.taskId ?? null}, ${record.chatId},
            ${record.threadId}, ${record.botMessageId}, ${record.kind},
            ${record.options.length ? JSON.stringify(record.options) : null},
            ${record.questionText}, 'open', ${stamp})
          ON CONFLICT DO NOTHING RETURNING question_id`));
      });
      if (inserted.length === 0) {
        logger.warn(`[telegram] question ${record.questionId} not recorded: the card already has an open question, so this one cannot be answered.`);
      }
    },

    async loadTopicBinding(projectId, chatId) {
      const found = await query<{ thread_id: number | string }>(projectId, () => sql`
        SELECT thread_id FROM project.telegram_project_topics
        WHERE project_id = ${projectId} AND chat_id = ${chatId} LIMIT 1`);
      return asNumber(found[0]?.thread_id);
    },

    async saveTopicBinding(projectId, chatId, threadId) {
      const stamp = new Date().toISOString();
      await query(projectId, () => sql`
        INSERT INTO project.telegram_project_topics(project_id, chat_id, thread_id, created_at, updated_at)
        VALUES(${projectId}, ${chatId}, ${threadId}, ${stamp}, ${stamp})
        ON CONFLICT(project_id, chat_id)
        DO UPDATE SET thread_id = excluded.thread_id, updated_at = excluded.updated_at`);
    },

    async findQuestion(projectId, questionId) {
      const found = await query<QuestionRow>(projectId, () => sql`
        SELECT ${QUESTION_COLUMNS_SQL} FROM project.telegram_questions
        WHERE project_id = ${projectId} AND question_id = ${questionId} LIMIT 1`);
      return decode(found[0], projectId);
    },

    async findOpenByMessage(projectId, chatId, botMessageId) {
      const found = await query<QuestionRow>(projectId, () => sql`
        SELECT ${QUESTION_COLUMNS_SQL} FROM project.telegram_questions
        WHERE project_id = ${projectId} AND chat_id = ${chatId} AND bot_message_id = ${botMessageId}
          AND status = 'open'
        ORDER BY created_at DESC LIMIT 1`);
      return decode(found[0], projectId);
    },

    async markAnswered(projectId, questionId) {
      const stamp = new Date().toISOString();
      const updated = await query<QuestionRow>(projectId, () => sql`
        UPDATE project.telegram_questions SET status = 'answered', answered_at = ${stamp}
        WHERE project_id = ${projectId} AND question_id = ${questionId} AND status = 'open'
        RETURNING ${QUESTION_COLUMNS_SQL}`);
      return decode(updated[0], projectId);
    },

    async reopenQuestion(projectId, questionId) {
      // Only a row this process just closed may go back; re-opening an already-open row is a no-op, and a
      // card that has since been re-asked violates uqTelegramQuestionsOpenTask and raises to the caller.
      const updated = await query<QuestionRow>(projectId, () => sql`
        UPDATE project.telegram_questions SET status = 'open', answered_at = NULL
        WHERE project_id = ${projectId} AND question_id = ${questionId} AND status = 'answered'
        RETURNING question_id`);
      return updated.length > 0;
    },
  };
}

/**
 * Builds the bridge's persistence, or `null` when this Fusion instance cannot host it. The bridge treats
 * `null` as "deliver notifications, never ask questions".
 */
export function createTelegramPersistence(
  ctx: PluginContext,
  logger: PluginLogger,
): TelegramPersistence | null {
  const store = ctx.taskStore as unknown as TaskStoreLike;
  const ownLayer = typeof store.getAsyncLayer === "function" ? store.getAsyncLayer() : null;
  if (!ownLayer?.db || typeof ownLayer.transactionImmediate !== "function") {
    logger.warn("[telegram] persistence unavailable: no PostgreSQL async data layer. The bridge needs PostgreSQL and will not ask questions without it.");
    return null;
  }
  const ownProjectId = ownLayer.projectId?.trim();
  if (!ownProjectId) {
    logger.warn("[telegram] persistence unavailable: the data layer is not project-bound, so bridge rows could not be isolated per project.");
    return null;
  }

  /*
  * A card-facing write must land in the OWNING project's partition. The hub receives every event, so
  * `layerFor` resolves that project's own data layer through the platform's resolver — never reusing the
  * hub's connection — and refuses when the resolved layer disagrees about which project it serves.
  * Writing project B's question through project A's layer is the leak this module exists to prevent.
  */
  const cache = new Map<string, AsyncLayerLike>();
  cache.set(ownProjectId, ownLayer);

  async function layerFor(projectId: string): Promise<AsyncLayerLike | null> {
    const wanted = projectId.trim();
    if (!wanted) return null;
    const cached = cache.get(wanted);
    if (cached) return cached;
    if (!ctx.resolveProjectTaskStore) {
      logger.warn(`[telegram] no project resolver for ${wanted}; its card is not reachable from this store.`);
      return null;
    }
    // Called with the receiver bound: the resolver is a store method, not a free function.
    const resolved = (await ctx.resolveProjectTaskStore(wanted).catch(() => null)) as TaskStoreLike | null;
    const layer = resolved && typeof resolved.getAsyncLayer === "function" ? resolved.getAsyncLayer() : null;
    if (!layer?.db || typeof layer.transactionImmediate !== "function") return null;
    if (layer.projectId?.trim() !== wanted) {
      logger.warn(`[telegram] the resolved data layer disagrees about which project it serves; refusing to write project ${wanted} rows.`);
      return null;
    }
    cache.set(wanted, layer);
    return layer;
  }

  /*
  * Poller-facing rows always go through the instance's own layer: one bot, one holder, one offset
  * sequence. Stale rows are pruned in the same transaction that claims an update, so retention is
  * enforced by the write that needs the space rather than a timer that may never fire.
  */
  const own = ownLayer;
  const inbound: InboundRepository = {
    tokenFingerprint(botToken) {
      return createHash("sha256").update(botToken).digest("hex");
    },
    async claimUpdate(updateId, chatId, retentionDays) {
      const stamp = new Date().toISOString();
      const cutoff = new Date(Date.now() - retentionDays * DAY_MS).toISOString();
      return own.transactionImmediate(async (tx) => {
        await tx.execute(sql`
          DELETE FROM project.telegram_processed_updates WHERE project_id = ${ownProjectId} AND received_at < ${cutoff}`);
        const claimed = rowsOf<{ update_id: string | number }>(await tx.execute(sql`
          INSERT INTO project.telegram_processed_updates(project_id, update_id, chat_id, received_at)
          VALUES(${ownProjectId}, ${updateId}, ${chatId}, ${stamp})
          ON CONFLICT(project_id, update_id) DO NOTHING RETURNING update_id`));
        return claimed.length === 1;
      });
    },
    async pruneProcessedUpdates(retentionDays) {
      const cutoff = new Date(Date.now() - retentionDays * DAY_MS).toISOString();
      const pruned = await own.db.execute(sql`
        DELETE FROM project.telegram_processed_updates
        WHERE project_id = ${ownProjectId} AND received_at < ${cutoff} RETURNING update_id`);
      return rowsOf<{ update_id: unknown }>(pruned).length;
    },
    async loadOffset(chatId) {
      const found = rowsOf<{ last_update_offset: number | string }>(await own.db.execute(sql`
        SELECT last_update_offset FROM project.telegram_inbound_state
        WHERE project_id = ${ownProjectId} AND chat_id = ${chatId} LIMIT 1`));
      return asNumber(found[0]?.last_update_offset);
    },
    async saveOffset(chatId, offset) {
      const stamp = new Date().toISOString();
      await own.db.execute(sql`
        INSERT INTO project.telegram_inbound_state(project_id, chat_id, last_update_offset, updated_at)
        VALUES(${ownProjectId}, ${chatId}, ${offset}, ${stamp})
        ON CONFLICT(project_id, chat_id)
        DO UPDATE SET last_update_offset = excluded.last_update_offset, updated_at = excluded.updated_at`);
    },
    async acquireLease(botTokenId, holderId, ttlMs) {
      const stamp = new Date().toISOString();
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      /*
      * A lease is granted when it is absent, already ours, or expired, and the expiry test runs inside the
      * same statement as the write: two processes racing on one expired row must not both believe they
      * won, and a lost race must read as a lost race (zero rows) rather than an error.
      */
      const won = rowsOf<{ bot_token_id: string }>(await own.db.execute(sql`
        INSERT INTO project.telegram_token_lease(project_id, bot_token_id, holder_id, acquired_at, renewed_at, expires_at)
        VALUES(${ownProjectId}, ${botTokenId}, ${holderId}, ${stamp}, ${stamp}, ${expiresAt})
        ON CONFLICT(project_id, bot_token_id) DO UPDATE
          SET holder_id = excluded.holder_id, acquired_at = excluded.acquired_at,
              renewed_at = excluded.renewed_at, expires_at = excluded.expires_at
          WHERE telegram_token_lease.holder_id = excluded.holder_id
             OR telegram_token_lease.expires_at < ${stamp}
        RETURNING bot_token_id`));
      return won.length === 1;
    },
    async renewLease(botTokenId, holderId, ttlMs) {
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      const kept = rowsOf<{ bot_token_id: string }>(await own.db.execute(sql`
        UPDATE project.telegram_token_lease SET renewed_at = ${new Date().toISOString()}, expires_at = ${expiresAt}
        WHERE project_id = ${ownProjectId} AND bot_token_id = ${botTokenId} AND holder_id = ${holderId}
        RETURNING bot_token_id`));
      return kept.length === 1;
    },
    async releaseLease(botTokenId, holderId) {
      await own.db.execute(sql`
        DELETE FROM project.telegram_token_lease
        WHERE project_id = ${ownProjectId} AND bot_token_id = ${botTokenId} AND holder_id = ${holderId}`);
    },
  };

  return { questions: createQuestionRepository(layerFor, logger), inbound };
}
