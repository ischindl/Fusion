/*
 * FNXC:TelegramBridge 2026-11-20-03:29 (RUFU-782):
 * PostgreSQL coverage for the bridge's correlation tables, on the repository's reachability-aware harness
 * so an unavailable local PostgreSQL skips canonically. These assertions are the reason the tables exist:
 * an answer must reach the card that asked, and never a card in another project. The harness runs with RLS
 * bypass, so project isolation here is proven by the explicit `project_id` each statement carries — which
 * is the same property production relies on.
 */
import { expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { PluginContext, PluginLogger } from "@fusion/plugin-sdk";
import {
  createTaskStoreForTest,
  pgDescribe,
} from "../../../../packages/core/src/__test-utils__/pg-test-harness.js";
import {
  createQuestionRepository,
  createTelegramPersistence,
  type AsyncLayerLike,
} from "../persistence.js";
import { createAnswerHandler } from "../answer-handler.js";
import type { QuestionRecord } from "../ingest.js";

type Layer = Awaited<ReturnType<typeof createTaskStoreForTest>>["layer"];

type HandlerStore = NonNullable<Awaited<ReturnType<Parameters<typeof createAnswerHandler>[0]["storeFor"]>>>;

function bind(layer: Layer, projectId: string): AsyncLayerLike {
  return { ...layer, projectId } as unknown as AsyncLayerLike;
}

function silentLogger(): PluginLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function context(layer: AsyncLayerLike, resolver?: (projectId: string) => Promise<unknown>): PluginContext {
  return {
    pluginId: "fusion-plugin-telegram",
    settings: {},
    logger: silentLogger(),
    emitEvent: vi.fn(),
    taskStore: { getAsyncLayer: () => layer } as unknown as PluginContext["taskStore"],
    ...(resolver ? { resolveProjectTaskStore: resolver } : {}),
  } as PluginContext;
}

function question(overrides: Partial<QuestionRecord> = {}): QuestionRecord {
  return {
    projectId: "project-a",
    questionId: "q-1",
    taskId: "FN-1",
    chatId: "-1001234567890",
    threadId: 77,
    botMessageId: 4242,
    kind: "single_select",
    options: ["Yes", "No"],
    questionText: "Deploy now?",
    ...overrides,
  };
}

/**
 * The shape `openQuestionFor` answers with. The creation time is part of the contract, not noise: it is
 * how the ingest route tells "this park is being asked about" from "a park long gone was never answered".
 */
function openRow(questionId: string, botMessageId: number) {
  return { questionId, botMessageId, createdAtMs: expect.any(Number) };
}

/** Every card-facing read/write for two projects, from one hub-side persistence object. */
async function hubPersistence(h: Awaited<ReturnType<typeof createTaskStoreForTest>>) {
  const a = bind(h.layer, "project-a");
  const b = bind(h.layer, "project-b");
  const storeFor = async (projectId: string) => ({
    getAsyncLayer: () => (projectId === "project-a" ? a : projectId === "project-b" ? b : null),
  });
  return createTelegramPersistence(context(a, storeFor), silentLogger());
}

pgDescribe("Telegram bridge PostgreSQL persistence", () => {
  it("materializes every declared table with the columns the persistence layer writes", async () => {
    const h = await createTaskStoreForTest({ prefix: "telegram_schema" });
    try {
      const columns = await h.adminDb.execute(sql`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'project' AND table_name LIKE 'telegram_%'`);
      const rows = Array.isArray(columns) ? columns : (columns as { rows?: Array<{ table_name: string; column_name: string }> }).rows ?? [];
      const byTable = new Map<string, string[]>();
      for (const row of rows) byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row.column_name].sort());

      expect([...byTable.keys()].sort()).toEqual([
        "telegram_inbound_state",
        "telegram_processed_updates",
        "telegram_project_topics",
        "telegram_questions",
        "telegram_token_lease",
      ]);
      // Every table leads its key with project_id: a statement that omits it must not be able to match.
      for (const [table, names] of byTable) expect(names, table).toContain("project_id");
      expect(byTable.get("telegram_questions")).toEqual([
        "answered_at", "bot_message_id", "chat_id", "created_at", "kind", "options", "project_id",
        "question_id", "question_text", "status", "task_id", "thread_id",
      ]);
      expect(byTable.get("telegram_token_lease")).toEqual([
        "acquired_at", "bot_token_id", "expires_at", "holder_id", "project_id", "renewed_at",
      ]);
    } finally {
      await h.teardown();
    }
  });

  it("correlates a question to its card and closes it exactly once", async () => {
    const h = await createTaskStoreForTest({ prefix: "telegram_question" });
    try {
      const persistence = await hubPersistence(h);
      expect(persistence).not.toBeNull();
      const questions = persistence!.questions;

      expect(await questions.openQuestionFor("project-a", "FN-1")).toBeNull();
      await questions.insertQuestion(question());

      const open = await questions.openQuestionFor("project-a", "FN-1");
      expect(open).toEqual(openRow("q-1", 4242));

      const byMessage = await questions.findOpenByMessage("project-a", "-1001234567890", 4242);
      expect(byMessage?.kind).toBe("single_select");
      expect(byMessage?.options).toEqual(["Yes", "No"]);
      expect(byMessage?.threadId).toBe(77);

      const closed = await questions.markAnswered("project-a", "q-1");
      expect(closed?.open).toBe(false);
      expect(closed?.answeredAt).toBeTruthy();
      // A second close claims nothing: one answer must never resume the same card twice.
      expect(await questions.markAnswered("project-a", "q-1")).toBeNull();
      expect(await questions.openQuestionFor("project-a", "FN-1")).toBeNull();
    } finally {
      await h.teardown();
    }
  });

  it("keeps one open question per card and leaves the first one authoritative", async () => {
    const h = await createTaskStoreForTest({ prefix: "telegram_one_open" });
    try {
      const logger = silentLogger();
      const persistence = await hubPersistence(h);
      const questions = createQuestionRepository(async (projectId) => {
        return projectId === "project-a" ? bind(h.layer, "project-a") : null;
      }, logger);

      await questions.insertQuestion(question());
      await questions.insertQuestion(question({ questionId: "q-2", botMessageId: 5150 }));

      expect(await questions.openQuestionFor("project-a", "FN-1")).toEqual(openRow("q-1", 4242));
      expect(await questions.findQuestion("project-a", "q-2")).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("q-2"));
    } finally {
      await h.teardown();
    }
  });

  /*
  * FNXC:TelegramBridge 2026-11-20-05:33 (RUFU-782 code review, P0):
  * The dashboard answers a question without telling Telegram, so the plugin's row stays open until a LATER
  * park supersedes it. This test is the whole reason supersession is one write: `uqTelegramQuestionsOpenTask`
  * permits one open row per card, so a close that ran AFTER the insert would leave the new question refused
  * and unanswerable, and a close that never runs at all is the defect being fixed.
  */
  it("supersedes the unanswered question when a later park re-asks the same card", async () => {
    const h = await createTaskStoreForTest({ prefix: "telegram_supersede" });
    try {
      const questions = (await hubPersistence(h))!.questions;

      // Park #1 was asked about, then answered in the dashboard; Telegram never learned, so q-1 stays open.
      await questions.insertQuestion(question());
      expect(await questions.openQuestionFor("project-a", "FN-1")).toEqual(openRow("q-1", 4242));

      // Park #2 arrives. The new question must BECOME the open one, not collide with the stale row.
      await questions.insertQuestion(question({
        questionId: "q-2",
        botMessageId: 5150,
        questionText: "Publish now?",
        supersedesQuestionId: "q-1",
      }));

      expect(await questions.openQuestionFor("project-a", "FN-1")).toEqual(openRow("q-2", 5150));

      const stale = await questions.findQuestion("project-a", "q-1");
      expect(stale?.open).toBe(false);
      expect(stale?.superseded).toBe(true);
      /*
      * The secondary defect the review named: a reply to the OLD message must resolve to nothing. Left
      * open, that reply resumed the CURRENT park carrying the PREVIOUS question's stored options.
      */
      expect(await questions.findOpenByMessage("project-a", "-1001234567890", 4242)).toBeNull();
      expect(await questions.markAnswered("project-a", "q-1")).toBeNull();
      // And a superseded row never returns: supersession is not a close a failed resume can undo.
      expect(await questions.reopenQuestion("project-a", "q-1")).toBe(false);
      expect(await questions.openQuestionFor("project-a", "FN-1")).toEqual(openRow("q-2", 5150));
    } finally {
      await h.teardown();
    }
  });

  it("leaves a row that was really answered alone when a supersession arrives too late", async () => {
    const h = await createTaskStoreForTest({ prefix: "telegram_supersede_late" });
    try {
      const questions = (await hubPersistence(h))!.questions;

      await questions.insertQuestion(question());
      // The operator answered in Telegram a moment ago, so q-1 is `answered`, not `open`.
      expect(await questions.markAnswered("project-a", "q-1")).not.toBeNull();

      await questions.insertQuestion(question({ questionId: "q-2", botMessageId: 5151, supersedesQuestionId: "q-1" }));

      // Supersession closes an OPEN row only: a real answer's history must not be rewritten by a race.
      const answered = await questions.findQuestion("project-a", "q-1");
      expect(answered?.superseded).toBe(false);
      expect(answered?.open).toBe(false);
      expect(await questions.openQuestionFor("project-a", "FN-1")).toEqual(openRow("q-2", 5151));
    } finally {
      await h.teardown();
    }
  });

  it("hands a closed question back when the answer could not be delivered", async () => {
    const h = await createTaskStoreForTest({ prefix: "telegram_reopen" });
    try {
      const persistence = await hubPersistence(h);
      const questions = persistence!.questions;

      await questions.insertQuestion(question());
      expect(await questions.markAnswered("project-a", "q-1")).not.toBeNull();
      expect(await questions.openQuestionFor("project-a", "FN-1")).toBeNull();

      expect(await questions.reopenQuestion("project-a", "q-1")).toBe(true);
      expect(await questions.openQuestionFor("project-a", "FN-1")).toEqual(openRow("q-1", 4242));
      // Re-opening an open row claims nothing, so a retry cannot invent a second question.
      expect(await questions.reopenQuestion("project-a", "q-1")).toBe(false);
    } finally {
      await h.teardown();
    }
  });

  it("refuses to re-open a question on a card that has already been asked again", async () => {
    const h = await createTaskStoreForTest({ prefix: "telegram_reopen_clash" });
    try {
      const persistence = await hubPersistence(h);
      const questions = persistence!.questions;

      await questions.insertQuestion(question());
      await questions.markAnswered("project-a", "q-1");
      // The dashboard answered and the card re-asked: the newer open row owns the card now.
      await questions.insertQuestion(question({ questionId: "q-2", botMessageId: 5150 }));

      // uqTelegramQuestionsOpenTask is what refuses, so the answer handler's reopen cannot mint a second
      // open question for one card; the caller catches this and points the operator at the dashboard.
      await expect(questions.reopenQuestion("project-a", "q-1")).rejects.toThrow();
      expect(await questions.openQuestionFor("project-a", "FN-1")).toEqual(openRow("q-2", 5150));
    } finally {
      await h.teardown();
    }
  });

  it("delivers an answer into a real parked card: steering comment first, then the resume", async () => {
    const h = await createTaskStoreForTest({ prefix: "telegram_answer" });
    try {
      const persistence = await hubPersistence(h);
      const questions = persistence!.questions;

      const created = await h.store.createTask({ title: "Ship the bridge", description: "Telegram answer path" });
      const pauseEpoch = Date.now() - 5_000;
      await h.store.updateTask(created.id, {
        status: "awaiting-user-input",
        paused: true,
        pausedReason: `workflow-input:ask-branch@${pauseEpoch}: Which branch should I use?`,
      });
      await questions.insertQuestion(question({ taskId: created.id }));

      const answers = createAnswerHandler({
        logger: silentLogger(),
        questions,
        storeFor: async () => h.store as unknown as HandlerStore,
        registry: { noteAnswer: () => undefined },
      });

      const first = await answers.onReply({ projectId: "project-a", chatId: "-1001234567890", botMessageId: 4242, text: "develop" });
      expect(first.dropButtons).toBe(true);

      const resumed = await h.store.getTask(created.id);
      /*
      * The store prunes falsey transient fields rather than storing them, so a resumed card answers
      * `undefined` for `status` and `paused`. The assertion is the observable contract — the card is no
      * longer parked — which is what `toBeFalsy` states without pretending a key exists that never did.
      */
      expect(resumed.paused).toBeFalsy();
      expect(resumed.status).toBeFalsy();
      // The marker survives: runAwaitInputNode needs it to prove the pause it is consuming.
      expect(resumed.pausedReason).toContain(`workflow-input:ask-branch@${pauseEpoch}`);
      const steering = (resumed.steeringComments ?? []).filter((entry) => entry.text === "develop");
      expect(steering).toHaveLength(1);
      expect(steering[0].author).toBe("user");
      // The node consumes only a comment created at or after the pause watermark, so the ordering that
      // wrote the comment before unpausing is what makes this answer readable at all.
      expect(Date.parse(steering[0].createdAt)).toBeGreaterThanOrEqual(pauseEpoch);

      const second = await answers.onReply({ projectId: "project-a", chatId: "-1001234567890", botMessageId: 4242, text: "develop" });
      expect(second.notice).toBe("Already answered.");
      const afterSecond = await h.store.getTask(created.id);
      expect((afterSecond.steeringComments ?? []).filter((entry) => entry.text === "develop")).toHaveLength(1);
    } finally {
      await h.teardown();
    }
  });

  it("never reads or writes another project's rows, even from the hub that received the event", async () => {    const h = await createTaskStoreForTest({ prefix: "telegram_isolation" });
    try {
      const persistence = await hubPersistence(h);
      const questions = persistence!.questions;
      await questions.insertQuestion(question());
      await questions.saveTopicBinding("project-a", "-1001234567890", 11);

      expect(await questions.openQuestionFor("project-b", "FN-1")).toBeNull();
      expect(await questions.findOpenByMessage("project-b", "-1001234567890", 4242)).toBeNull();
      expect(await questions.loadTopicBinding("project-b", "-1001234567890")).toBeNull();

      // The same card id in another project is a different card, and answering it closes nothing here.
      expect(await questions.markAnswered("project-b", "q-1")).toBeNull();
      expect((await questions.markAnswered("project-a", "q-1"))?.questionId).toBe("q-1");
    } finally {
      await h.teardown();
    }
  });

  it("refuses a cross-project write when the resolved layer disagrees about its project", async () => {
    const h = await createTaskStoreForTest({ prefix: "telegram_layer_refusal" });
    try {
      const logger = silentLogger();
      const wrong = {
        getAsyncLayer: () => bind(h.layer, "project-intruder"),
      };
      const ctx = context(bind(h.layer, "project-a"), async () => wrong);
      const persistence = createTelegramPersistence(ctx, logger);
      await persistence!.questions.insertQuestion(question({ projectId: "project-b" }));

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("refusing to write project project-b"));
      const reader = createQuestionRepository(async () => bind(h.layer, "project-b"), silentLogger());
      expect(await reader.openQuestionFor("project-b", "FN-1")).toBeNull();
    } finally {
      await h.teardown();
    }
  });

  it("yields no store at all without a PostgreSQL layer, and a card-facing read survives a missing resolver", async () => {
    const sqliteLike = {
      pluginId: "fusion-plugin-telegram",
      settings: {},
      logger: silentLogger(),
      emitEvent: vi.fn(),
      taskStore: { getAsyncLayer: () => null },
    } as unknown as PluginContext;
    expect(createTelegramPersistence(sqliteLike, silentLogger())).toBeNull();

    const unboundLayer = {
      projectId: null,
      db: { execute: async () => [] },
      transactionImmediate: async (fn: (tx: { execute: () => Promise<unknown[]> }) => Promise<unknown>) =>
        fn({ execute: async () => [] }),
    } as unknown as AsyncLayerLike;
    const unboundLogger = silentLogger();
    const unbound = {
      pluginId: "fusion-plugin-telegram",
      settings: {},
      logger: unboundLogger,
      emitEvent: vi.fn(),
      taskStore: { getAsyncLayer: () => unboundLayer },
    } as unknown as PluginContext;
    expect(createTelegramPersistence(unbound, unboundLogger)).toBeNull();
    expect(unboundLogger.warn).toHaveBeenCalledWith(expect.stringContaining("not project-bound"));

    const logger = silentLogger();
    const orphan = createQuestionRepository(async () => null, logger);
    expect(await orphan.openQuestionFor("project-a", "FN-1")).toBeNull();
    expect(await orphan.loadTopicBinding("project-a", "-100")).toBeNull();
    await orphan.insertQuestion(question());
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("no data layer"));
  });

  it("claims each inbound update exactly once and prunes only rows past retention", async () => {
    const h = await createTaskStoreForTest({ prefix: "telegram_updates" });
    try {
      const persistence = await hubPersistence(h);
      const inbound = persistence!.inbound;
      const chatId = "-1001234567890";

      const claims = await Promise.all(
        Array.from({ length: 6 }, () => inbound.claimUpdate(9001, chatId, 7)),
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(await inbound.claimUpdate(9001, chatId, 7)).toBe(false);
      expect(await inbound.claimUpdate(9002, chatId, 7)).toBe(true);

      const ancient = new Date(Date.now() - 40 * 86_400_000).toISOString();
      await h.adminDb.execute(sql`
        INSERT INTO project.telegram_processed_updates(project_id, update_id, chat_id, received_at)
        VALUES ('project-a', 42, ${chatId}, ${ancient}), ('project-b', 43, ${chatId}, ${ancient})`);

      expect(await inbound.pruneProcessedUpdates(30)).toBe(1);
      const remaining = await h.adminDb.execute(sql`
        SELECT project_id, update_id FROM project.telegram_processed_updates WHERE update_id IN (42, 43)`);
      const kept = Array.isArray(remaining) ? remaining : (remaining as { rows?: Array<{ project_id: string }> }).rows ?? [];
      expect(kept.map((row) => row.project_id)).toEqual(["project-b"]);
    } finally {
      await h.teardown();
    }
  });

  it("keeps the getUpdates offset across a restart without rewinding", async () => {
    const h = await createTaskStoreForTest({ prefix: "telegram_offset" });
    try {
      const persistence = await hubPersistence(h);
      const inbound = persistence!.inbound;
      const chatId = "-1001234567890";

      expect(await inbound.loadOffset(chatId)).toBeNull();
      await inbound.saveOffset(chatId, 500);
      expect(await inbound.loadOffset(chatId)).toBe(500);
      await inbound.saveOffset(chatId, 511);
      expect(await inbound.loadOffset(chatId)).toBe(511);

      // A second holder for the same chat reads the same durable offset rather than starting at zero.
      const restart = await hubPersistence(h);
      expect(await restart!.inbound.loadOffset(chatId)).toBe(511);
    } finally {
      await h.teardown();
    }
  });

  it("grants one long-poll lease per token, keeps it with the holder, and hands it over once expired", async () => {
    const h = await createTaskStoreForTest({ prefix: "telegram_lease" });
    try {
      const inbound = (await hubPersistence(h))!.inbound;
      const token = "123456:AAA-bbbCCC";
      const tokenId = inbound.tokenFingerprint(token);

      expect(tokenId).not.toContain(token);
      expect(tokenId).toHaveLength(64);

      expect(await inbound.acquireLease(tokenId, "holder-a", 60_000)).toBe(true);
      expect(await inbound.acquireLease(tokenId, "holder-b", 60_000)).toBe(false);
      expect(await inbound.renewLease(tokenId, "holder-a", 60_000)).toBe(true);
      expect(await inbound.renewLease(tokenId, "holder-b", 60_000)).toBe(false);

      // A dead holder's lease expires rather than parking the bot forever; -1s models the clock passing it.
      expect(await inbound.acquireLease(tokenId, "holder-a", -1_000)).toBe(true);
      expect(await inbound.acquireLease(tokenId, "holder-b", 60_000)).toBe(true);
      expect(await inbound.acquireLease(tokenId, "holder-a", 60_000)).toBe(false);

      await inbound.releaseLease(tokenId, "holder-b");
      expect(await inbound.acquireLease(tokenId, "holder-a", 60_000)).toBe(true);
    } finally {
      await h.teardown();
    }
  });
});
