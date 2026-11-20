import { describe, expect, it } from "vitest";

import { createAnswerHandler } from "../answer-handler.js";
import type { TelegramLogger } from "../bot-api.js";
import type { StoredQuestion } from "../persistence.js";
import { STEERING_TEXT_CHAR_LIMIT } from "../settings.js";

const PROJECT = "p1";
const CHAT = "100";
const TASK = "RUFU-782";
/** The exact shape `pauseForUserInput` writes: `workflow-input:<node>@<epoch>: <question>`. */
const AWAIT_REASON = "workflow-input:ask@1700000000000: Which branch should I use?";

function logger(): TelegramLogger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
}

function question(overrides: Partial<StoredQuestion> = {}): StoredQuestion {
  return {
    questionId: "abcDEF12345",
    projectId: PROJECT,
    taskId: TASK,
    chatId: CHAT,
    threadId: 42,
    botMessageId: 500,
    kind: "single_select",
    options: ["main", "develop"],
    questionText: "Which branch should I use?",
    createdAt: new Date(0).toISOString(),
    answeredAt: null,
    open: true,
    superseded: false,
    ...overrides,
  };
}

interface Writes {
  steering: Array<{ taskId: string; text: string; author?: string }>;
  updates: Array<Record<string, unknown>>;
}

/**
 * The store stand-in records call ORDER, not just calls: the steering comment must land before the
 * unpause, or the await-input node can re-park the card with no answer to consume.
 */
function storeSpy(task: Record<string, unknown> | null, opts: { failWrite?: "steering" | "update" } = {}) {
  const writes: Writes = { steering: [], updates: [] };
  const store = {
    writes,
    getTask: async () => task,
    addSteeringComment: async (taskId: string, text: string, author?: string) => {
      if (opts.failWrite === "steering") throw new Error("store rejected the comment");
      writes.steering.push({ taskId, text, author });
      return task;
    },
    updateTask: async (_taskId: string, patch: Record<string, unknown>) => {
      if (opts.failWrite === "update") throw new Error("store rejected the update");
      writes.updates.push(patch);
      return task;
    },
  };
  return store as unknown as StoreLike & typeof store;
}

type StoreLike = NonNullable<Awaited<ReturnType<Parameters<typeof createAnswerHandler>[0]["storeFor"]>>>;

interface QuestionsSpy {
  findQuestion(projectId: string, questionId: string): Promise<StoredQuestion | null>;
  findOpenByMessage(projectId: string, chatId: string, botMessageId: number): Promise<StoredQuestion | null>;
  markAnswered(projectId: string, questionId: string): Promise<StoredQuestion | null>;
  reopenQuestion(projectId: string, questionId: string): Promise<boolean>;
}

function questionsSpy(row: StoredQuestion | null, opts: { claim?: boolean; alreadyOpenReopen?: boolean } = {}) {
  const calls: string[] = [];
  const questions: QuestionsSpy = {
    findQuestion: async (projectId, questionId) => {
      calls.push(`find ${projectId}/${questionId}`);
      return row && row.projectId === projectId && row.questionId === questionId ? row : null;
    },
    findOpenByMessage: async (projectId, chatId, botMessageId) => {
      calls.push(`message ${projectId}/${chatId}/${botMessageId}`);
      return row && row.projectId === projectId && row.chatId === chatId && row.botMessageId === botMessageId ? row : null;
    },
    markAnswered: async (projectId, questionId) => {
      calls.push(`claim ${projectId}/${questionId}`);
      // The real row closes only from `open`; the spy mirrors that so a double answer cannot resume twice.
      return row && opts.claim !== false && row.open ? { ...row, open: false, answeredAt: new Date().toISOString() } : null;
    },
    reopenQuestion: async (projectId, questionId) => {
      calls.push(`reopen ${projectId}/${questionId}`);
      return opts.alreadyOpenReopen !== false;
    },
  };
  return { questions: questions as unknown as Parameters<typeof createAnswerHandler>[0]["questions"], calls };
}

function handler(args: {
  row: StoredQuestion | null;
  task: Record<string, unknown> | null;
  questions?: Parameters<typeof createAnswerHandler>[0]["questions"];
  store?: StoreLike | null;
  failWrite?: "steering" | "update";
  answers?: number;
}) {
  const noted: unknown[] = [];
  const built = createAnswerHandler({
    logger: logger(),
    questions: args.questions ?? questionsSpy(args.row).questions,
    storeFor: async () => (args.store === undefined ? storeSpy(args.task, args.failWrite ? { failWrite: args.failWrite } : {}) : args.store),
    registry: { noteAnswer: (answer) => noted.push(answer) },
    now: () => 1234,
  });
  return { built, noted };
}

const parked = () => ({ id: TASK, status: "awaiting-user-input", paused: true, pausedReason: AWAIT_REASON });

describe("answer handler: resume", () => {
  it("writes the steering comment before releasing the park, exactly as the dashboard route does", async () => {
    const spy = storeSpy(parked());
    const { built, noted } = handler({ row: question(), task: parked(), store: spy });

    const result = await built.onReply({ projectId: PROJECT, chatId: CHAT, botMessageId: 500, text: "develop" });

    expect(result).toEqual({ notice: `Answered ${TASK}. The card is running again.`, dropButtons: true });
    expect(spy.writes.steering).toEqual([{ taskId: TASK, text: "develop", author: "user" }]);
    expect(spy.writes.updates).toEqual([{ status: null, paused: false }]);
    expect(noted).toEqual([{ projectId: PROJECT, chatId: CHAT, botMessageId: 500, questionId: "abcDEF12345", at: 1234 }]);
  });

  it("leaves pausedReason alone, because the await-input node clears its own marker", async () => {
    const spy = storeSpy(parked());
    const { built } = handler({ row: question(), task: parked(), store: spy });

    await built.onReply({ projectId: PROJECT, chatId: CHAT, botMessageId: 500, text: "develop" });

    // The patch is exactly the dashboard route's: writing pausedReason here would make every later run
    // re-pause without ever consuming the answer, and moving a column is not this bridge's authority.
    expect(spy.writes.updates).toEqual([{ status: null, paused: false }]);
  });

  it("steers with the option label a button carried, resolved from the stored options", async () => {
    const spy = storeSpy(parked());
    const { questions } = questionsSpy(question());
    const { built } = handler({ row: question(), task: parked(), store: spy, questions });

    await built.onCallback({
      questionId: "abcDEF12345",
      chatId: CHAT,
      botMessageId: 500,
      callbackQueryId: "cb-1",
      optionIndex: 1,
      candidateProjectIds: [PROJECT],
    });

    expect(spy.writes.steering).toEqual([{ taskId: TASK, text: "develop", author: "user" }]);
  });

  it("clips an answer to the steering limit rather than sending an over-long comment", async () => {
    const spy = storeSpy(parked());
    const { built } = handler({ row: question({ kind: "text", options: [] }), task: parked(), store: spy });

    await built.onReply({ projectId: PROJECT, chatId: CHAT, botMessageId: 500, text: "x".repeat(STEERING_TEXT_CHAR_LIMIT + 500) });

    expect(spy.writes.steering[0].text).toHaveLength(STEERING_TEXT_CHAR_LIMIT);
  });
});

describe("answer handler: who is allowed to be resumed", () => {
  it("treats the dashboard as the authority once the card is no longer parked", async () => {
    const spy = storeSpy({ id: TASK, status: null, paused: false, pausedReason: null });
    const { questions, calls } = questionsSpy(question());
    const { built } = handler({ row: question(), task: { id: TASK, status: null, paused: false }, store: spy, questions });

    const result = await built.onReply({ projectId: PROJECT, chatId: CHAT, botMessageId: 500, text: "develop" });

    expect(result).toEqual({ notice: "Already answered in the dashboard.", dropButtons: true });
    expect(spy.writes.steering).toEqual([]);
    expect(spy.writes.updates).toEqual([]);
    expect(calls).toContain(`claim ${PROJECT}/abcDEF12345`);
  });

  it("refuses a card parked for a different reason and leaves its question open", async () => {
    const spy = storeSpy({ id: TASK, status: null, paused: true, pausedReason: "workflow-cli-approval:run:npm publish" });
    const { questions, calls } = questionsSpy(question());
    const { built } = handler({ row: question(), task: { id: TASK, paused: true, pausedReason: "workflow-cli-approval:run:npm publish" }, store: spy, questions });

    const result = await built.onReply({ projectId: PROJECT, chatId: CHAT, botMessageId: 500, text: "yes" });

    expect(result.notice).toContain("parked for a different reason");
    expect(result.dropButtons).toBe(false);
    expect(spy.writes.steering).toEqual([]);
    expect(calls.some((call) => call.startsWith("claim"))).toBe(false);
  });

  it("never resumes twice when a second answer arrives", async () => {
    const spy = storeSpy(parked());
    const row = question({ open: false, answeredAt: new Date().toISOString() });
    const { built } = handler({ row, task: parked(), store: spy });

    const result = await built.onReply({ projectId: PROJECT, chatId: CHAT, botMessageId: 500, text: "develop" });

    expect(result).toEqual({ notice: "Already answered.", dropButtons: true });
    expect(spy.writes.steering).toEqual([]);
  });

  /*
  * FNXC:TelegramBridge 2026-11-20-05:33 (RUFU-782 code review, P0):
  * A `superseded` row was never answered by anybody — the card was re-asked, typically because the operator
  * answered the earlier question in the dashboard. The buttons on that old message must send the operator to
  * the newest question and must not touch the card: the option text stored on a superseded row belongs to a
  * park that is gone, and handing it to the CURRENT park is exactly the wrong-card answer the review named.
  */
  it("points a tap on a superseded question at the newer one instead of answering the current park", async () => {
    const spy = storeSpy(parked());
    const row = question({ open: false, superseded: true });
    const { built } = handler({ row, task: parked(), store: spy });

    const result = await built.onCallback({
      projectId: PROJECT,
      questionId: "abcDEF12345",
      chatId: CHAT,
      botMessageId: 500,
      candidateProjectIds: [PROJECT],
      optionIndex: 0,
    });

    expect(result.dropButtons).toBe(true);
    expect(result.notice).toContain("replaced by a newer one");
    expect(spy.writes.steering).toEqual([]);
    expect(spy.writes.updates).toEqual([]);
  });

  it("does not resume a card whose project store cannot be reached, and keeps the question answerable", async () => {
    const { questions, calls } = questionsSpy(question());
    const { built } = handler({ row: question(), task: parked(), store: null, questions });

    const result = await built.onReply({ projectId: PROJECT, chatId: CHAT, botMessageId: 500, text: "develop" });

    expect(result.notice).toContain("could not be reached");
    expect(result.dropButtons).toBe(false);
    expect(calls.some((call) => call.startsWith("claim"))).toBe(false);
  });

  it("gives the claim back when the store refuses the answer, so it can be tried again", async () => {
    const spy = storeSpy(parked(), { failWrite: "steering" });
    const { questions, calls } = questionsSpy(question());
    const { built, noted } = handler({ row: question(), task: parked(), store: spy, questions });

    const result = await built.onReply({ projectId: PROJECT, chatId: CHAT, botMessageId: 500, text: "develop" });

    expect(result.notice).toContain("the question is still open");
    expect(calls).toContain(`reopen ${PROJECT}/abcDEF12345`);
    expect(spy.writes.updates).toEqual([]);
    expect(noted).toEqual([]);
  });

  it("reports a card that no longer exists instead of resuming nothing", async () => {
    const spy = storeSpy(null);
    const { built } = handler({ row: question(), task: null, store: spy });

    const result = await built.onReply({ projectId: PROJECT, chatId: CHAT, botMessageId: 500, text: "develop" });

    expect(result.notice).toContain("no longer exists");
    expect(spy.writes.steering).toEqual([]);
  });
});

describe("answer handler: a button that cannot be trusted", () => {
  const callbackArgs = (overrides: Record<string, unknown> = {}) => ({
    questionId: "abcDEF12345",
    chatId: CHAT,
    botMessageId: 500,
    callbackQueryId: "cb-1",
    optionIndex: 0,
    candidateProjectIds: [PROJECT],
    ...overrides,
  });

  it("searches the candidate projects and refuses when none owns the question", async () => {
    const spy = storeSpy(parked());
    const { built } = handler({ row: question({ projectId: "other" }), task: parked(), store: spy });

    const result = await built.onCallback(callbackArgs({ candidateProjectIds: [PROJECT, "p2"] }));

    expect(result).toEqual({ notice: "This question is no longer here.", dropButtons: true });
    expect(spy.writes.steering).toEqual([]);
  });

  it("refuses a row that names a different chat than the one that pressed", async () => {
    const spy = storeSpy(parked());
    const { built } = handler({ row: question({ chatId: "999" }), task: parked(), store: spy });

    const result = await built.onCallback(callbackArgs());

    expect(result).toEqual({ notice: "This question is no longer here.", dropButtons: true });
    expect(spy.writes.steering).toEqual([]);
  });

  it("refuses an option index the stored question does not have", async () => {
    const spy = storeSpy(parked());
    const { built } = handler({ row: question(), task: parked(), store: spy });

    const result = await built.onCallback(callbackArgs({ optionIndex: 7 }));

    expect(result.notice).toContain("no longer the current ones");
    expect(spy.writes.steering).toEqual([]);
  });

  it("asks for a reply when the button encoded no option at all", async () => {
    const spy = storeSpy(parked());
    const { built } = handler({ row: question(), task: parked(), store: spy });

    const result = await built.onCallback(callbackArgs({ optionIndex: null }));

    expect(result.notice).toContain("predates option tracking");
    expect(spy.writes.steering).toEqual([]);
  });

  it("refuses an empty answer without claiming the question", async () => {
    const spy = storeSpy(parked());
    const { questions, calls } = questionsSpy(question());
    const { built } = handler({ row: question({ kind: "text", options: [] }), task: parked(), store: spy, questions });

    const result = await built.onReply({ projectId: PROJECT, chatId: CHAT, botMessageId: 500, text: "   " });

    expect(result).toEqual({ notice: "The answer arrived empty, so nothing was recorded.", dropButtons: false });
    expect(calls.some((call) => call.startsWith("claim"))).toBe(false);
  });
});
