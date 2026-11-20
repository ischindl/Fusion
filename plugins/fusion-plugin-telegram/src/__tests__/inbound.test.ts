import { describe, expect, it } from "vitest";

import type { TelegramClient, TelegramLogger, TelegramUpdate } from "../bot-api.js";
import { TelegramApiError } from "../bot-api.js";
import { buildQuestionKeyboard, parseCallbackData } from "../format.js";
import type { AnswerHandler, InboundLoop } from "../inbound.js";
import { createInboundLoop, processUpdate } from "../inbound.js";
import type { InboundRepository } from "../persistence.js";
import { createProjectRegistry } from "../project-registry.js";

const BOT_TOKEN = "123456:AA-throwaway-token-for-tests";
const CHAT = "100";

function logger(): TelegramLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (message: string) => lines.push(`info ${message}`),
    warn: (message: string) => lines.push(`warn ${message}`),
    error: (message: string) => lines.push(`error ${message}`),
    debug: (message: string) => lines.push(`debug ${message}`),
  };
}

/** A scheduler the test drives by hand: no timer, no sleep, no flake window. */
function manualScheduler() {
  const queued: Array<{ fn: () => void; ms: number }> = [];
  return {
    queued,
    schedule: (fn: () => void, ms: number) => {
      queued.push({ fn, ms });
      return () => {
        const at = queued.findIndex((entry) => entry.fn === fn);
        if (at >= 0) queued.splice(at, 1);
      };
    },
    /** Runs the next queued callback, returning the delay it was armed with. */
    async flush(): Promise<number> {
      const next = queued.shift();
      if (!next) throw new Error("nothing scheduled");
      next.fn();
      // One macrotask boundary drains the whole await chain the callback started, with nothing to poll.
      await new Promise((resolve) => setImmediate(resolve));
      return next.ms;
    },
  };
}

interface ClientSpy extends TelegramClient {
  calls: string[];
  pollRequests: Array<Record<string, unknown>>;
  answered: Array<{ callbackQueryId: string; text?: string }>;
  markupCleared: Array<{ chatId: string; messageId: number }>;
}

function clientSpy(opts: { pages?: TelegramUpdate[][]; pollError?: unknown } = {}): ClientSpy {
  let page = 0;
  const spy = {
    calls: [] as string[],
    pollRequests: [] as Array<Record<string, unknown>>,
    answered: [] as Array<{ callbackQueryId: string; text?: string }>,
    markupCleared: [] as Array<{ chatId: string; messageId: number }>,
    getUpdates: async (args: { offset?: number; timeout?: number }) => {
      spy.calls.push("getUpdates");
      spy.pollRequests.push({ ...args });
      if (opts.pollError) throw opts.pollError;
      return opts.pages?.[page++] ?? [];
    },
    sendMessage: async () => ({ messageId: 1 }),
    createForumTopic: async () => ({ messageThreadId: 1 }),
    editMessageReplyMarkup: async (args: { chatId: string; messageId: number }) => {
      spy.calls.push("editMessageReplyMarkup");
      spy.markupCleared.push(args);
    },
    answerCallbackQuery: async (args: { callbackQueryId: string; text?: string }) => {
      spy.calls.push("answerCallbackQuery");
      spy.answered.push({ callbackQueryId: args.callbackQueryId, ...(args.text !== undefined ? { text: args.text } : {}) });
    },
  } as unknown as ClientSpy;
  return spy;
}

function callbackUpdate(args: { updateId?: number; chatId?: number; data?: string; messageId?: number; callbackQueryId?: string } = {}): TelegramUpdate {
  return {
    update_id: args.updateId ?? 7,
    callback_query: {
      id: args.callbackQueryId ?? "cb-1",
      from: { id: 9 },
      message: { message_id: args.messageId ?? 500, chat: { id: args.chatId ?? Number(CHAT) } },
      data: args.data ?? "q:abcDEF12345:1",
    },
  };
}

function replyUpdate(text = "develop", overrides: Partial<TelegramUpdate> = {}): TelegramUpdate {
  return {
    update_id: 8,
    message: {
      message_id: 900,
      chat: { id: Number(CHAT) },
      text,
      reply_to_message_id: 500,
      message_thread_id: 42,
      ...overrides.message,
    },
    ...overrides,
  } as TelegramUpdate;
}

function handlerSpy(result: { notice: string | null; dropButtons: boolean } = { notice: "done", dropButtons: false }): AnswerHandler & { callbackCalls: unknown[]; replyCalls: unknown[] } {
  const callbackCalls: unknown[] = [];
  const replyCalls: unknown[] = [];
  return {
    callbackCalls,
    replyCalls,
    onCallback: async (input) => {
      callbackCalls.push(input);
      return result;
    },
    onReply: async (input) => {
      replyCalls.push(input);
      return result;
    },
  };
}

function questionsSpy(hitProject: string | null) {
  const looked: string[] = [];
  return {
    looked,
    findOpenByMessage: async (projectId: string, chatId: string, botMessageId: number) => {
      looked.push(`${projectId}/${chatId}/${botMessageId}`);
      return projectId === hitProject ? { questionId: "abcDEF12345" } : null;
    },
  };
}

function inboundSpy(opts: {
  offset?: number | null;
  holder?: boolean;
  claimable?: (updateId: number) => boolean;
} = {}): InboundRepository & { offsets: number[]; released: string[]; claims: number[] } {
  const state = {
    offsets: [] as number[],
    released: [] as string[],
    claims: [] as number[],
    tokenFingerprint: () => "tokenhash",
    acquireLease: async () => opts.holder !== false,
    renewLease: async () => opts.holder !== false,
    releaseLease: async (_token: string, holder: string) => {
      state.released.push(holder);
      return true;
    },
    claimUpdate: async (updateId: number) => {
      state.claims.push(updateId);
      return opts.claimable ? opts.claimable(updateId) : true;
    },
    loadOffset: async () => (opts.offset === undefined ? null : opts.offset),
    saveOffset: async (_chat: string, offset: number) => {
      state.offsets.push(offset);
      return true;
    },
    pruneProcessedUpdates: async () => 0,
  };
  return state as InboundRepository & { offsets: number[]; released: string[]; claims: number[] };
}

describe("callback_data grammar", () => {
  it("round-trips the opaque id and the option position", () => {
    expect(parseCallbackData("q:abcDEF12345")).toEqual({ questionId: "abcDEF12345", optionIndex: null });
    expect(parseCallbackData("q:abcDEF12345:2")).toEqual({ questionId: "abcDEF12345", optionIndex: 2 });
  });

  it("refuses every shape this plugin did not author", () => {
    for (const data of ["", "q:", "q:short", "q:abcDEF12345X", "q:abcDEF12345:10", "q:abcDEF12345:x", "RUFU-782", "q:RUFU-782", "accept:yes"]) {
      expect(parseCallbackData(data), data).toBeNull();
    }
  });

  it("numbers each option row so a tap names its option", () => {
    const keyboard = buildQuestionKeyboard("abcDEF12345", ["main", "develop"]);
    expect(keyboard?.inline_keyboard.map((row) => row[0].callback_data)).toEqual(["q:abcDEF12345:0", "q:abcDEF12345:1"]);
  });
});

describe("processUpdate", () => {
  const allowlist = new Set([CHAT]);

  it("hands a pressed option over with its position and shows the notice on the button", async () => {
    const client = clientSpy();
    const answers = handlerSpy({ notice: "Answered: develop", dropButtons: true });

    const outcome = await processUpdate({
      update: callbackUpdate(),
      allowedChatIds: allowlist,
      questions: null,
      projectsForMessage: async () => [],
      answers,
      logger: logger(),
      client,
    });

    expect(outcome).toEqual({ kind: "callback", questionId: "abcDEF12345" });
    expect(answers.callbackCalls).toEqual([
      { questionId: "abcDEF12345", chatId: CHAT, botMessageId: 500, callbackQueryId: "cb-1", optionIndex: 1, candidateProjectIds: [] },
    ]);
    expect(client.answered).toEqual([{ callbackQueryId: "cb-1", text: "Answered: develop" }]);
    expect(client.markupCleared).toEqual([{ chatId: Number(CHAT), messageId: 500 }]);
  });

  it("refuses a chat outside the allowlist before reading anything", async () => {
    const client = clientSpy();
    const answers = handlerSpy();
    const questions = questionsSpy("p1");

    const outcome = await processUpdate({
      update: callbackUpdate({ callbackQueryId: "cb-9" }),
      allowedChatIds: new Set(["999"]),
      questions,
      projectsForMessage: async () => ["p1"],
      answers,
      logger: logger(),
      client,
    });

    expect(outcome).toEqual({ kind: "unauthorized", reason: "chat-not-allowed" });
    expect(answers.callbackCalls).toEqual([]);
    expect(questions.looked).toEqual([]);
    expect(client.answered[0].text).toContain("Not authorized");
  });

  it("treats an empty allowlist as nobody, not as everybody", async () => {
    const outcome = await processUpdate({
      update: replyUpdate(),
      allowedChatIds: new Set<string>(),
      questions: questionsSpy("p1"),
      projectsForMessage: async () => ["p1"],
      answers: handlerSpy(),
      logger: logger(),
      client: clientSpy(),
    });
    expect(outcome).toEqual({ kind: "unauthorized", reason: "chat-not-allowed" });
  });

  it("answers a foreign button without touching a card", async () => {
    const client = clientSpy();
    const answers = handlerSpy();
    const outcome = await processUpdate({
      update: callbackUpdate({ callbackQueryId: "cb-2", data: "ship-it" }),
      allowedChatIds: allowlist,
      questions: null,
      projectsForMessage: async () => [],
      answers,
      logger: logger(),
      client,
    });
    expect(outcome).toEqual({ kind: "ignored", reason: "unrecognized-callback" });
    expect(answers.callbackCalls).toEqual([]);
    expect(client.answered[0].text).toContain("not a Fusion question");
  });

  it("correlates a reply to the bot's own message and passes the text through", async () => {
    const answers = handlerSpy({ notice: null, dropButtons: false });
    const questions = questionsSpy("p2");

    const outcome = await processUpdate({
      update: replyUpdate("develop"),
      allowedChatIds: allowlist,
      questions,
      projectsForMessage: async () => ["p1", "p2"],
      answers,
      logger: logger(),
      client: clientSpy(),
    });

    expect(outcome).toEqual({ kind: "reply", questionId: "abcDEF12345" });
    expect(questions.looked).toEqual(["p1/100/500", "p2/100/500"]);
    expect(answers.replyCalls).toEqual([{ projectId: "p2", chatId: CHAT, botMessageId: 500, text: "develop" }]);
  });

  it("ignores a reply this bridge cannot correlate", async () => {
    const answers = handlerSpy();
    const outcome = await processUpdate({
      update: replyUpdate(),
      allowedChatIds: allowlist,
      questions: questionsSpy(null),
      projectsForMessage: async () => ["p1"],
      answers,
      logger: logger(),
      client: clientSpy(),
    });
    expect(outcome).toEqual({ kind: "ignored", reason: "no-correlation" });
    expect(answers.replyCalls).toEqual([]);
  });

  it("ignores a message that does not answer a question", async () => {
    const outcome = await processUpdate({
      update: { update_id: 3, message: { message_id: 4, chat: { id: Number(CHAT) }, text: "standup at 10" } } as TelegramUpdate,
      allowedChatIds: allowlist,
      questions: questionsSpy("p1"),
      projectsForMessage: async () => ["p1"],
      answers: handlerSpy(),
      logger: logger(),
      client: clientSpy(),
    });
    expect(outcome).toEqual({ kind: "ignored", reason: "not-an-answer" });
  });
});

function loop(args: {
  client: TelegramClient;
  inbound: InboundRepository | null;
  answers?: AnswerHandler;
  questions?: ReturnType<typeof questionsSpy>;
  botToken?: string;
  chatId?: string;
  schedule?: ReturnType<typeof manualScheduler>["schedule"];
}): InboundLoop {
  return createInboundLoop({
    client: args.client,
    logger: logger(),
    botToken: args.botToken ?? BOT_TOKEN,
    chatId: args.chatId ?? CHAT,
    settings: { allowedChatIds: [CHAT] },
    inbound: args.inbound,
    questions: args.questions ?? null,
    projectsForMessage: async () => ["p1"],
    answers: args.answers ?? handlerSpy(),
    ...(args.schedule ? { schedule: args.schedule } : {}),
  });
}

describe("inbound loop", () => {
  it("never arms a timer when the bridge cannot poll at all", async () => {
    const scheduler = manualScheduler();
    const client = clientSpy({ pages: [[]] });

    const unconfigured = loop({ client, inbound: inboundSpy(), chatId: "", schedule: scheduler.schedule });
    unconfigured.start();
    expect(scheduler.queued).toHaveLength(0);
    expect(unconfigured.state().stoppedReason).toBe("not-configured");

    const noDatabase = loop({ client, inbound: null, schedule: scheduler.schedule });
    noDatabase.start();
    expect(scheduler.queued).toHaveLength(0);
    expect(noDatabase.state().stoppedReason).toBe("no-persistence");
    expect(client.calls).toEqual([]);
  });

  it("polls only while it holds the token lease, and reports a competing holder", async () => {
    const client = clientSpy({ pages: [[]] });
    const loopNotHolding = loop({ client, inbound: inboundSpy({ holder: false }) });

    expect(await loopNotHolding.tick()).toBe("not-holder");
    expect(client.calls).toEqual([]);
    expect(loopNotHolding.state().stoppedReason).toBe("lease-held-elsewhere");
  });

  it("resumes from the stored offset and persists it after each handled update", async () => {
    const inbound = inboundSpy({ offset: 41 });
    const client = clientSpy({ pages: [[{ update_id: 42, message: { message_id: 1, chat: { id: Number(CHAT) }, text: "hi" } } as TelegramUpdate, { update_id: 43 } as TelegramUpdate]] });

    await expect(loop({ client, inbound }).tick()).resolves.toBe("polled");

    expect(client.pollRequests[0]).toMatchObject({ offset: 42 });
    expect(inbound.offsets).toEqual([42, 43]);
  });

  it("skips a replayed update without handling it, and still moves past it", async () => {
    const inbound = inboundSpy({ offset: 40, claimable: (updateId) => updateId !== 41 });
    const answers = handlerSpy();
    const client = clientSpy({ pages: [[callbackUpdate({ updateId: 41 }), callbackUpdate({ updateId: 42, callbackQueryId: "cb-2", data: "q:abcDEF12345:0" })], []] });

    const bridge = loop({ client, inbound, answers, questions: null });
    await bridge.tick();

    // 41 was already handled by whoever else claimed it, so only 42 reaches the answer handler.
    expect(answers.callbackCalls).toHaveLength(1);
    // A replayed row writes no offset row — the durable one is the last genuinely handled update.
    expect(inbound.offsets).toEqual([42]);

    // The skipped update was still counted as seen: the next poll asks Telegram for 43, never for 41 again.
    await bridge.tick();
    expect(client.pollRequests[1]).toMatchObject({ offset: 43 });
  });

  it("adopts a pre-start backlog without acting on it", async () => {
    const inbound = inboundSpy({ offset: null });
    const answers = handlerSpy();
    const backlog = [
      { update_id: 10, message: { message_id: 1, chat: { id: Number(CHAT) }, text: "old", reply_to_message_id: 500 } } as TelegramUpdate,
      { update_id: 11, callback_query: { id: "cb-old", from: { id: 1 }, message: { message_id: 500, chat: { id: Number(CHAT) } }, data: "q:abcDEF12345:0" } } as TelegramUpdate,
    ];
    const client = clientSpy({ pages: [backlog, []] });

    await expect(loop({ client, inbound, answers, questions: questionsSpy("p1") }).tick()).resolves.toBe("polled");

    // The backlog was drained to find its newest id; nothing in it reached a card.
    expect(answers.callbackCalls).toEqual([]);
    expect(answers.replyCalls).toEqual([]);
    expect(inbound.offsets).toEqual([11]);
    expect(client.pollRequests.at(-1)).toMatchObject({ offset: 12 });
  });

  it("waits out a Telegram rate limit using the interval the API asked for", async () => {
    const scheduler = manualScheduler();
    const client = clientSpy({ pages: [[]] });
    client.getUpdates = async () => {
      throw new TelegramApiError({ method: "getUpdates", httpStatus: 429, errorCode: 429, retryAfterMs: 2_500 });
    };
    const loopRateLimited = loop({ client, inbound: inboundSpy({ offset: 1 }), schedule: scheduler.schedule });

    loopRateLimited.start();
    await scheduler.flush();

    expect(scheduler.queued[0]?.ms).toBe(2_500);
    expect(loopRateLimited.state().failures).toBe(1);
  });

  it("keeps the bot token out of failure logs", async () => {
    const scheduler = manualScheduler();
    const client = clientSpy({ pages: [[]] });
    const log = logger();
    client.getUpdates = async () => {
      throw new Error(`fetch failed for https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`);
    };
    const leaking = createInboundLoop({
      client,
      logger: log,
      botToken: BOT_TOKEN,
      chatId: CHAT,
      settings: {},
      inbound: inboundSpy({ offset: 1 }),
      questions: null,
      projectsForMessage: async () => [],
      answers: handlerSpy(),
      schedule: scheduler.schedule,
    });

    leaking.start();
    await scheduler.flush();

    expect(leaking.state().failures).toBe(1);
    expect(log.lines.join("\n")).not.toContain(BOT_TOKEN);
    expect(log.lines.join("\n")).toContain("[telegram-token-redacted]");
  });

  it("counts handled updates and the answers they carried", async () => {
    const client = clientSpy({
      pages: [[
        callbackUpdate({ updateId: 5 }),
        { update_id: 6, message: { message_id: 7, chat: { id: Number(CHAT) }, text: "notes" } } as TelegramUpdate,
      ]],
    });
    const bridge = loop({ client, inbound: inboundSpy({ offset: 4 }), questions: questionsSpy("p1") });

    await bridge.tick();

    expect(bridge.state().processedUpdates).toBe(2);
    expect(bridge.state().resumeRequests).toBe(1);
    expect(bridge.state().lastPollAt).toBeTypeOf("number");
  });

  it("gives the lease back on stop so the next process starts immediately", async () => {
    const inbound = inboundSpy();
    const bridge = loop({ client: clientSpy({ pages: [[]] }), inbound });

    await bridge.tick();
    bridge.stop();
    await Promise.resolve();

    expect(inbound.released).toHaveLength(1);
    expect(inbound.released[0]).toBeTruthy();
    expect(bridge.state().holder).toBe(false);
  });
});

describe("project registry as the inbound candidate source", () => {
  function clocked() {
    let at = 1_000;
    return createProjectRegistry(() => (at += 1));
  }

  it("lists the hub first, most recently seen next, and never repeats a project", () => {
    const registry = clocked();
    registry.record("p2");
    registry.record("p3");
    registry.record("p1");

    expect(registry.knownProjectIds("p1")).toEqual(["p1", "p3", "p2"]);
    expect(registry.knownProjectIds("hub")).toEqual(["hub", "p1", "p3", "p2"]);
    expect(registry.knownProjectIds()).toEqual(["p1", "p3", "p2"]);
  });

  it("names the project that owns a topic, and stops naming one when two claim it", () => {
    const registry = clocked();
    registry.record("p1");
    registry.noteThreadOwner("p1", CHAT, 42);
    expect(registry.projectForThread(CHAT, 42)).toBe("p1");

    // Flat mode puts two projects in one chat and thread; such a pair can never answer "whose topic?".
    registry.noteThreadOwner("p2", CHAT, 42);
    expect(registry.projectForThread(CHAT, 42)).toBeNull();
    expect(registry.projectForThread(CHAT, 7)).toBeNull();
  });

  it("keeps a short, newest-first answer trail for the status route", () => {
    const registry = clocked();
    for (const [index, id] of ["a", "b", "c", "d"].entries()) {
      registry.noteAnswer({ projectId: "p1", chatId: CHAT, botMessageId: 500 + index, questionId: id, at: index });
    }

    expect(registry.recentAnswers(2).map((answer) => answer.questionId)).toEqual(["d", "c"]);
    expect(registry.recentAnswers(0)).toEqual([]);
  });
});
