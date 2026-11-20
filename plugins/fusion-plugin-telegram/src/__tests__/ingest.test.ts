import { describe, expect, it, vi } from "vitest";

import {
  alreadyAwaitingOnTelegram,
  correlateProject,
  createBackgroundTracker,
  createEventDeliverer,
  handleFusionEvent,
  handleStatus,
  newQuestionId,
  questionAnswersThisPause,
  verifyIngestSecret,
  type DeliveryRequest,
  type IngestPorts,
  type IngestRequest,
} from "../ingest.js";
import { createProjectRegistry } from "../project-registry.js";
import { createTelegramOutbox } from "../outbox.js";
import { TelegramApiError } from "../bot-api.js";
import type { TelegramClient } from "../bot-api.js";
import type { TopicRouter } from "../topics.js";

const SECRET = "s3cret-ingest-key";
const CHAT = "-1001234567890";

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function request(overrides: Partial<IngestRequest> = {}): IngestRequest {
  return {
    method: "POST",
    query: { key: SECRET },
    headers: { "content-type": "application/json", "content-length": "220" },
    body: {
      event: "planning-awaiting-input",
      timestamp: "2026-11-20T02:49:00.000Z",
      project: { id: "p1", name: "Fusion" },
      task: { id: "RUFU-782", title: "Telegram bridge", status: "awaiting-user-input", column: "in-progress" },
    },
    ...overrides,
  };
}

function harness(overrides: Partial<IngestPorts> = {}) {
  const deliveries: DeliveryRequest[] = [];
  const tracked: Array<Promise<unknown>> = [];
  const log = logger();
  const ports: IngestPorts = {
    logger: log,
    requestSettings: { ingestSecret: SECRET, chatId: CHAT, eventFilter: "planning-awaiting-input,task-wedged", botToken: "123:abc" },
    settingsFor: async () => ({}),
    readCard: async () => null,
    openQuestionFor: async () => null,
    registry: createProjectRegistry(),
    delivery: {
      deliver: async (delivery) => {
        deliveries.push(delivery);
        return { delivered: true, threadId: 42 };
      },
      track: (task) => {
        tracked.push(task);
      },
    },
    ...overrides,
  };
  return { ports, deliveries, tracked, log };
}

describe("verifyIngestSecret", () => {
  it("refuses everything when no secret is configured, because the route is auth-exempt", () => {
    expect(verifyIngestSecret(SECRET, undefined)).toBe(false);
    expect(verifyIngestSecret(SECRET, "   ")).toBe(false);
    expect(verifyIngestSecret(undefined, undefined)).toBe(false);
  });

  it("accepts only the exact secret", () => {
    expect(verifyIngestSecret(SECRET, SECRET)).toBe(true);
    expect(verifyIngestSecret("wrong", SECRET)).toBe(false);
    expect(verifyIngestSecret(undefined, SECRET)).toBe(false);
    expect(verifyIngestSecret("", SECRET)).toBe(false);
  });
});

describe("correlateProject", () => {
  it("trusts the payload's project id, which the engine derives from the owning store", () => {
    expect(correlateProject({ project: { id: "p1" } }, { projectId: "p1" })).toEqual({ projectId: "p1" });
    expect(correlateProject({ project: { id: "p1" } }, {})).toEqual({ projectId: "p1" });
  });

  it("refuses to guess when the query and the payload name different projects", () => {
    expect(correlateProject({ project: { id: "p1" } }, { projectId: "p2" })).toEqual({ error: "project-mismatch" });
  });

  it("falls back to the query, then to the configured hub project, and refuses when nothing names one", () => {
    expect(correlateProject({}, { projectId: "p9" })).toEqual({ projectId: "p9" });
    expect(correlateProject({}, {}, "hub")).toEqual({ projectId: "hub" });
    expect(correlateProject({}, {})).toEqual({ error: "unknown-project" });
  });
});

describe("handleFusionEvent", () => {
  it("refuses an unauthenticated event before reading any of it", async () => {
    const { ports, deliveries } = harness();
    await expect(handleFusionEvent(request({ query: {} }), ports)).resolves.toMatchObject({ status: 401 });
    await expect(handleFusionEvent(request({ query: { key: "nope" } }), ports)).resolves.toMatchObject({ status: 401 });
    expect(deliveries).toHaveLength(0);
  });

  it("refuses everything when the operator has not set a secret", async () => {
    const { ports } = harness({ requestSettings: { chatId: CHAT } });
    await expect(handleFusionEvent(request(), ports)).resolves.toMatchObject({
      status: 401,
      body: { error: "ingest-secret-not-configured" },
    });
  });

  it("refuses an oversized body and a non-json body", async () => {
    const { ports, deliveries } = harness();
    await expect(
      handleFusionEvent(request({ headers: { "content-type": "application/json", "content-length": "99999999" } }), ports),
    ).resolves.toMatchObject({ status: 413 });
    await expect(
      handleFusionEvent(request({ headers: { "content-type": "text/plain", "content-length": "20" } }), ports),
    ).resolves.toMatchObject({ status: 415 });
    expect(deliveries).toHaveLength(0);
  });

  it("rejects a payload that names no event and a payload that names no project", async () => {
    const { ports } = harness();
    await expect(handleFusionEvent(request({ body: { timestamp: "now" } }), ports)).resolves.toMatchObject({ status: 400 });
    await expect(handleFusionEvent(request({ body: { event: "failed" }, query: { key: SECRET } }), ports)).resolves.toMatchObject({
      status: 400,
      body: { error: "unknown-project" },
    });
    await expect(
      handleFusionEvent(request({ body: { event: "failed", project: { id: "p1" } }, query: { key: SECRET, projectId: "p2" } }), ports),
    ).resolves.toMatchObject({ status: 409, body: { error: "project-mismatch" } });
  });

  it("drops an event the project did not opt into without sending anything", async () => {
    const { ports, deliveries } = harness();
    const result = await handleFusionEvent(
      request({ body: { event: "awaiting-user-review", project: { id: "p1" }, task: { id: "RUFU-782" } } }),
      ports,
    );
    expect(result).toMatchObject({ status: 202, body: { status: "ignored", reason: "event-filtered" } });
    expect(deliveries).toHaveLength(0);
  });

  it("extracts the question from the live card row, which is the only place the text exists", async () => {
    const { ports, deliveries } = harness({
      readCard: async () => ({
        title: "Telegram bridge",
        status: "awaiting-user-input",
        pausedReason: "workflow-input:step-execute@1730000000000: Which branch should I merge into? (main | develop)",
      }),
    });

    const result = await handleFusionEvent(request(), ports);

    expect(result).toMatchObject({ status: 202, body: { status: "queued", projectId: "p1", taskId: "RUFU-782" } });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      projectId: "p1",
      taskId: "RUFU-782",
      question: "Which branch should I merge into? (main | develop)",
      options: ["main", "develop"],
    });
    expect(deliveries[0]?.questionId).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it("delivers a plain event with no question and no keyboard identity", async () => {
    const { ports, deliveries } = harness();
    await handleFusionEvent(request({ body: { event: "task-wedged", project: { id: "p1" }, task: { id: "RUFU-782" } } }), ports);
    expect(deliveries[0]?.question).toBeUndefined();
    expect(deliveries[0]?.questionId).toBeUndefined();
    expect(deliveries[0]?.options).toEqual([]);
  });

  it("asks a card once: a second event for the same pause is acknowledged and dropped", async () => {
    const { ports, deliveries } = harness({
      readCard: async () => ({ pausedReason: "workflow-input:step-execute@1: Which branch?" }),
      // The row was created at the pause it answers, which is what makes it THIS pause's question.
      openQuestionFor: async () => ({ questionId: "oldid", botMessageId: 501, createdAtMs: 1 }),
    });

    const result = await handleFusionEvent(request(), ports);

    expect(result).toMatchObject({ status: 202, body: { status: "ignored", reason: "already-awaiting-input" } });
    expect(deliveries).toHaveLength(0);
  });

  /*
  * FNXC:TelegramBridge 2026-11-20-05:33 (RUFU-782 code review, P0):
  * The dashboard-first flow is supported: `POST /api/tasks/:id/workflow/input` answers an
  * `awaiting-user-input` card and resumes it without telling Telegram, so the plugin's row for the
  * answered question stays `open` forever. A card whose park the dashboard answered MUST still be asked
  * about on Telegram the next time it parks — the old rule ("any open row means stay quiet") silently
  * deafened it for good.
  */
  it("re-asks a card whose previous question was answered in the dashboard, and supersedes that row", async () => {
    // Park #1 at t=1000; Telegram asked at t=1002; the operator answered in the dashboard; park #2 at t=5000.
    const first = harness({
      readCard: async () => ({ pausedReason: "workflow-input:step-execute@1000: Which branch should I merge into?" }),
      openQuestionFor: async () => null,
    });
    await handleFusionEvent(request(), first.ports);
    expect(first.deliveries).toHaveLength(1);

    const second = harness({
      readCard: async () => ({ pausedReason: "workflow-input:step-execute@5000: Should I publish now?" }),
      // The row the dashboard never closed. It predates THIS park, so it cannot be this park's question.
      openQuestionFor: async () => ({ questionId: "stale1", botMessageId: 501, createdAtMs: 1002 }),
    });
    const result = await handleFusionEvent(request(), second.ports);

    expect(result).toMatchObject({ status: 202, body: { status: "queued" } });
    expect(second.deliveries).toHaveLength(1);
    expect(second.deliveries[0]).toMatchObject({
      question: "Should I publish now?",
      previousBotMessageId: 501,
      supersedesQuestionId: "stale1",
    });
  });

  it("drops the supersession pair for an event whose card carries no question", async () => {
    const { ports, deliveries } = harness({
      // Parked, but not by an await-input node: there is no question here to replace anything with.
      readCard: async () => ({ pausedReason: "terminal-failed: the step died twice" }),
      openQuestionFor: async () => ({ questionId: "live1", botMessageId: 501, createdAtMs: 4_000 }),
    });

    // A `task-wedged` notice must not consume or replace the card's still-live question.
    await handleFusionEvent(request({ body: { event: "task-wedged", project: { id: "p1" }, task: { id: "RUFU-782" } } }), ports);

    expect(deliveries[0]).toMatchObject({ event: "task-wedged", question: undefined });
    expect(deliveries[0]?.previousBotMessageId).toBeUndefined();
    expect(deliveries[0]?.supersedesQuestionId).toBeUndefined();
  });

  it("re-asks when the pause carries no watermark, and says why it could not prove the row was stale", async () => {
    const { ports, deliveries, log } = harness({
      readCard: async () => ({ pausedReason: "workflow-input:step-execute: Should I publish now?" }),
      openQuestionFor: async () => ({ questionId: "stale1", botMessageId: 501, createdAtMs: 1002 }),
    });

    await handleFusionEvent(request(), ports);

    // An undated pause cannot be proven answered, and a duplicate message is the lesser harm against silence.
    expect(deliveries).toHaveLength(1);
    expect(log.warn.mock.calls.some((call) => String(call[0]).includes("no watermark"))).toBe(true);
  });

  it("records the project from an accepted event even when the filter drops it", async () => {
    const registry = createProjectRegistry();
    const { ports } = harness({ registry });
    await handleFusionEvent(request({ body: { event: "failed", project: { id: "p7", name: "Seven" } } }), ports);
    expect(registry.snapshot().map((entry) => entry.projectId)).toContain("p7");
  });

  it("answers 202 without waiting for Telegram to accept the message", async () => {
    let release: ((value: { delivered: boolean }) => void) | undefined;
    const pending = new Promise<{ delivered: boolean }>((resolve) => {
      release = resolve;
    });
    const { ports, tracked } = harness({
      delivery: { deliver: () => pending, track: (task) => tracked.push(task) },
    });

    const result = await handleFusionEvent(request(), ports);

    expect(result.status).toBe(202);
    expect(tracked).toHaveLength(1);
    release?.({ delivered: true });
    await Promise.all(tracked);
  });

  it("never echoes the bot token or the ingest secret in its response", async () => {
    const { ports } = harness();
    const result = await handleFusionEvent(request(), ports);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("123:abc");
    expect(serialised).not.toContain(SECRET);
  });
});

describe("alreadyAwaitingOnTelegram", () => {
  it("needs both halves of the correlation pair", () => {
    expect(alreadyAwaitingOnTelegram(null)).toBe(false);
    expect(alreadyAwaitingOnTelegram({ questionId: "id1", botMessageId: 0 })).toBe(false);
    expect(alreadyAwaitingOnTelegram({ questionId: "id1", botMessageId: 7 })).toBe(true);
  });
});

describe("questionAnswersThisPause", () => {
  it("suppresses only a row created for the pause being announced", () => {
    // Created during this park: the same event delivered twice must not ask twice.
    expect(questionAnswersThisPause({ questionId: "a", botMessageId: 7, createdAtMs: 2_000 }, 1_000)).toBe(true);
    expect(questionAnswersThisPause({ questionId: "a", botMessageId: 7, createdAtMs: 1_000 }, 1_000)).toBe(true);
    // Created before this park: an unanswered leftover (typically a dashboard answer), so it is not this pause.
    expect(questionAnswersThisPause({ questionId: "a", botMessageId: 7, createdAtMs: 999 }, 1_000)).toBe(false);
  });

  it("refuses to claim a row it cannot date, or a pause it cannot date", () => {
    expect(questionAnswersThisPause({ questionId: "a", botMessageId: 7 }, 1_000)).toBe(false);
    expect(questionAnswersThisPause({ questionId: "a", botMessageId: 7, createdAtMs: 5_000 }, undefined)).toBe(false);
    expect(questionAnswersThisPause(null, 1_000)).toBe(false);
    // A row with no Telegram message behind it answers nothing, however fresh.
    expect(questionAnswersThisPause({ questionId: "a", botMessageId: 0, createdAtMs: 5_000 }, 1_000)).toBe(false);
  });
});

describe("newQuestionId", () => {
  it("stays short enough for callback_data with its prefix", () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      expect(Buffer.byteLength(newQuestionId(), "utf8")).toBeLessThanOrEqual(64);
    }
    expect(new Set(Array.from({ length: 200 }, () => newQuestionId())).size).toBe(200);
  });
});

function clientWith(options: {
  messageId?: number;
  onSend?: (args: unknown) => void;
  sendFails?: boolean;
}): TelegramClient & { sends: unknown[]; edits: number[] } {
  const sends: unknown[] = [];
  const edits: number[] = [];
  return {
    sends,
    edits,
    getUpdates: async () => [],
    createForumTopic: async () => ({ messageThreadId: 1 }),
    answerCallbackQuery: async () => undefined,
    editMessageReplyMarkup: async (args) => {
      edits.push(args.messageId);
    },
    sendMessage: async (args) => {
      sends.push(args);
      options.onSend?.(args);
      if (options.sendFails) throw new Error("telegram sendMessage failed httpStatus=429");
      return { messageId: options.messageId ?? 900 };
    },
  } as unknown as TelegramClient & { sends: unknown[]; edits: number[] };
}

function delivererWith(options: {
  client?: TelegramClient;
  threadId?: number | null;
  insertQuestion?: (record: unknown) => Promise<void>;
  settings?: Record<string, unknown>;
  baseSettings?: Record<string, unknown>;
}) {
  const log = logger();
  const registry = createProjectRegistry();
  const topics = {
    resolveThreadId: async () => options.threadId ?? null,
    snapshot: () => [],
  } as unknown as TopicRouter;
  const deliver = createEventDeliverer({
    client: options.client ?? clientWith({}),
    /*
    * The real outbox, with its timer replaced so a test that awaits one send does not pay the project's
    * 1.1 s spacing. The spacing itself is covered by `outbox-throttle.test.ts`; here the outbox is present
    * because the deliverer requires it, and its `run` must actually reach the fake client.
    */
    outbox: createTelegramOutbox({ logger: log, sleep: async () => undefined, now: () => 0 }),
    topics,
    logger: log,
    baseSettings: options.baseSettings ?? {},
    settingsFor: async () => options.settings ?? { chatId: CHAT, groupingMode: "privateTopics", dashboardBaseUrl: "http://dash.local" },
    ...(options.insertQuestion ? { insertQuestion: options.insertQuestion } : {}),
    registry,
  });
  return { deliver, log, registry };
}

const questionDelivery: DeliveryRequest = {
  projectId: "p1",
  projectName: "Fusion",
  event: "planning-awaiting-input",
  taskId: "RUFU-782",
  taskTitle: "Telegram bridge",
  question: "Which branch should I merge into? (main | develop)",
  options: ["main", "develop"],
  questionId: "abc123def45",
};

describe("createEventDeliverer", () => {
  it("sends one message into the project's topic with the keyboard attached", async () => {
    const client = clientWith({ messageId: 777 });
    const { deliver } = delivererWith({ client, threadId: 512 });

    await expect(deliver(questionDelivery)).resolves.toEqual({ delivered: true, threadId: 512 });

    expect(client.sends).toHaveLength(1);
    const send = client.sends[0] as { chatId: string; messageThreadId?: number; parseMode?: string; replyMarkup?: unknown; text: string };
    expect(send.chatId).toBe(CHAT);
    expect(send.messageThreadId).toBe(512);
    expect(send.parseMode).toBe("HTML");
    expect(send.replyMarkup).toEqual({
      inline_keyboard: [
        [{ text: "main", callback_data: "q:abc123def45:0" }],
        [{ text: "develop", callback_data: "q:abc123def45:1" }],
      ],
    });
    expect(send.text).toContain("Which branch should I merge into?");
  });

  it("sends flat when the topic could not be resolved", async () => {
    const client = clientWith({ messageId: 778 });
    const { deliver } = delivererWith({ client, threadId: null, settings: { chatId: CHAT, groupingMode: "flat" } });

    await deliver(questionDelivery);

    const send = client.sends[0] as { messageThreadId?: number; text: string };
    expect(send.messageThreadId).toBeUndefined();
    expect(send.text.startsWith("[Fusion/RUFU-782]")).toBe(true);
  });

  it("refuses to deliver when the project has no chat configured", async () => {
    const client = clientWith({});
    const { deliver } = delivererWith({ client, settings: {} });
    await expect(deliver(questionDelivery)).resolves.toMatchObject({ delivered: false, reason: "chat-not-configured" });
    expect(client.sends).toHaveLength(0);
  });

  it("writes the correlation row only from a real message id", async () => {
    const records: unknown[] = [];
    const { deliver } = delivererWith({
      client: clientWith({ messageId: 888 }),
      threadId: 512,
      insertQuestion: async (record) => {
        records.push(record);
      },
    });

    await deliver(questionDelivery);

    expect(records).toEqual([
      {
        projectId: "p1",
        questionId: "abc123def45",
        taskId: "RUFU-782",
        chatId: CHAT,
        threadId: 512,
        botMessageId: 888,
        kind: "single_select",
        options: ["main", "develop"],
        questionText: "Which branch should I merge into? (main | develop)",
      },
    ]);
  });

  it("records a plain question as text and an option list as single_select", async () => {
    const records: Array<{ kind: string }> = [];
    const { deliver } = delivererWith({
      client: clientWith({ messageId: 889 }),
      insertQuestion: async (record) => {
        records.push(record as { kind: string });
      },
    });

    await deliver({ ...questionDelivery, options: [], questionId: "txtid" });

    expect(records[0]?.kind).toBe("text");
  });

  it("drops the previous question's buttons only after the new send returns a real id", async () => {
    const client = clientWith({ messageId: 999 });
    const { deliver } = delivererWith({ client });

    await deliver({ ...questionDelivery, previousBotMessageId: 501 });

    expect(client.edits).toEqual([501]);
  });

  /*
  * FNXC:TelegramBridge 2026-11-20-05:33 (RUFU-782 code review, P0):
  * The row this question replaces must be closed by the SAME write that opens the new one. Left open, it
  * would both hold the card's single open-question slot — making the new question unanswerable — and let a
  * reply to the old message resume the current park with the previous question's options.
  */
  it("hands the row it replaces to the correlation write", async () => {
    const records: Array<Record<string, unknown>> = [];
    const { deliver } = delivererWith({
      client: clientWith({ messageId: 990 }),
      insertQuestion: async (record) => {
        records.push(record as Record<string, unknown>);
      },
    });

    await deliver({ ...questionDelivery, previousBotMessageId: 501, supersedesQuestionId: "stale1" });

    expect(records[0]).toMatchObject({ questionId: "abc123def45", supersedesQuestionId: "stale1" });
  });

  it("carries no supersession key for an ordinary question, so no other row can be closed", async () => {
    const records: Array<Record<string, unknown>> = [];
    const { deliver } = delivererWith({
      client: clientWith({ messageId: 991 }),
      insertQuestion: async (record) => {
        records.push(record as Record<string, unknown>);
      },
    });

    await deliver(questionDelivery);

    expect(records[0]).not.toHaveProperty("supersedesQuestionId");
  });

  it("names throttling as the reason when Telegram rate limited the chat, token still undisclosed", async () => {
    const client = clientWith({ messageId: 992 });
    client.sendMessage = async () => {
      throw new TelegramApiError({ method: "sendMessage", httpStatus: 429, errorCode: 429, retryAfterMs: 1_000 });
    };
    const { deliver, log } = delivererWith({ client, settings: { chatId: CHAT } });

    const outcome = await deliver(questionDelivery);

    expect(outcome).toMatchObject({ delivered: false, reason: "send-throttled" });
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("123:abc");
  });

  it("keeps the previous question live when the new send fails", async () => {
    const client = clientWith({ sendFails: true });
    const { deliver, log } = delivererWith({ client });

    await expect(deliver({ ...questionDelivery, previousBotMessageId: 501 })).resolves.toMatchObject({ delivered: false });
    expect(client.edits).toEqual([]);
    expect(log.error).toHaveBeenCalled();
  });

  it("reports a failed send without letting the bot token escape", async () => {
    const client = clientWith({ sendFails: true });
    const { deliver, log } = delivererWith({ client, settings: { chatId: CHAT } });

    const outcome = await deliver({ ...questionDelivery, previousBotMessageId: undefined });

    expect(outcome).toMatchObject({ delivered: false, reason: "send-failed" });
    const logged = JSON.stringify(log.error.mock.calls);
    expect(logged).not.toContain("123:abc");
  });

  it("sends to the hub chat when the project leaves Chat Id blank", async () => {
    const client = clientWith({ messageId: 901 });
    const { deliver } = delivererWith({
      client,
      baseSettings: { chatId: CHAT },
      settings: { chatId: "   ", groupingMode: "flat" },
    });

    await expect(deliver(questionDelivery)).resolves.toMatchObject({ delivered: true });
    expect((client.sends[0] as { chatId: string }).chatId).toBe(CHAT);
  });

  it("lets a project override the hub grouping mode", async () => {
    const client = clientWith({ messageId: 902 });
    const { deliver } = delivererWith({
      client,
      threadId: 7,
      baseSettings: { chatId: CHAT, groupingMode: "privateTopics" },
      settings: { groupingMode: "flat" },
    });

    await deliver(questionDelivery);

    const send = client.sends[0] as { text: string; messageThreadId?: number };
    expect(send.text.startsWith("[Fusion/RUFU-782]")).toBe(true);
    expect(send.messageThreadId).toBeUndefined();
  });

  it("notes the delivery thread on the project registry", async () => {
    const { deliver, registry } = delivererWith({ client: clientWith({ messageId: 900 }), threadId: 4242 });
    await deliver(questionDelivery);
    expect(registry.snapshot()[0]).toMatchObject({ projectId: "p1", lastThreadId: 4242 });
  });
});

describe("handleStatus", () => {
  it("reports a bot token by length only", () => {
    const response = handleStatus({
      settings: { botToken: "123456:very-secret-token-value", chatId: CHAT, ingestSecret: SECRET, eventFilter: "failed" },
      registry: createProjectRegistry(),
    });

    const body = response.body as Record<string, unknown>;
    expect(body.botTokenConfigured).toBe(true);
    expect(body.botTokenLength).toBe("123456:very-secret-token-value".length);
    expect(JSON.stringify(response)).not.toContain("very-secret-token-value");
    expect(JSON.stringify(response)).not.toContain(SECRET);
  });

  it("says when the bridge cannot work instead of pretending it is healthy", () => {
    const body = handleStatus({ settings: {}, registry: createProjectRegistry() }).body as Record<string, unknown>;
    expect(body).toMatchObject({
      botTokenConfigured: false,
      botTokenLength: 0,
      chatIdConfigured: false,
      ingestSecretConfigured: false,
      groupingMode: "privateTopics",
      dashboardBaseUrl: null,
    });
  });
});

describe("createBackgroundTracker", () => {
  it("logs a rejected delivery instead of leaving an unhandled rejection", async () => {
    const log = logger();
    const track = createBackgroundTracker(log);
    track(Promise.reject(new Error("telegram sendMessage failed httpStatus=429")));
    await new Promise((resolve) => setImmediate(resolve));
    expect(log.error).toHaveBeenCalled();
  });
});
