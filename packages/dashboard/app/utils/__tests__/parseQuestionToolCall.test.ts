import { describe, expect, it } from "vitest";
import type { ToolCallInfo } from "../../hooks/chatTypes";
import {
  findDurableQuestionAnswer,
  findSubmittedQuestionAnswer,
  formatQuestionAnswer,
  indexDurableQuestionAnswers,
  isPlannerQuestionAwaitingAnswer,
  isLiveQuestionAwaitingAnswer,
  isQuestionToolName,
  parseQuestionToolCall,
  QUESTION_ANSWER_METADATA_KEY,
  readQuestionAnswerLink,
  holdsAwaitingQuestionToolCall,
} from "../parseQuestionToolCall";

function toolCall(toolName: string, args?: Record<string, unknown>): ToolCallInfo {
  return { toolName, args, isError: false, status: "completed" };
}

describe("parseQuestionToolCall", () => {
  it("recognizes question tool names case-insensitively", () => {
    expect(isQuestionToolName("AskUserQuestion")).toBe(true);
    expect(isQuestionToolName("ASK_USER")).toBe(true);
    expect(isQuestionToolName("fn_ask_question")).toBe(true);
    expect(isQuestionToolName("grep")).toBe(false);
  });

  it("normalizes Claude AskUserQuestion multi-question args", () => {
    const parsed = parseQuestionToolCall(toolCall("AskUserQuestion", {
      questions: [
        { question: "Pick one", header: "Decision", options: [{ label: "A" }, { label: "B", description: "Bee" }] },
        { id: "features", question: "Pick many", options: [{ id: "x", label: "X" }, { label: "Y" }], multiSelect: true },
      ],
    }));

    expect(parsed).toEqual({
      questions: [
        {
          id: "q-0",
          type: "single_select",
          question: "Pick one",
          header: "Decision",
          description: undefined,
          options: [{ id: "opt-0", label: "A", description: undefined }, { id: "opt-1", label: "B", description: "Bee" }],
          multiSelect: undefined,
        },
        {
          id: "features",
          type: "multi_select",
          question: "Pick many",
          header: undefined,
          description: undefined,
          options: [{ id: "x", label: "X", description: undefined }, { id: "opt-1", label: "Y", description: undefined }],
          multiSelect: true,
        },
      ],
    });
  });

  it.each([
    ["ask_user", { question: "Continue?", options: ["Yes", "No"] }, "confirm"],
    ["request_user_input", { prompt: "Name?" }, "text"],
    ["elicit", { message: "Choose", choices: [{ value: "a", label: "Alpha" }] }, "single_select"],
    ["ask_followup_question", { question: "Boolean?", type: "boolean" }, "confirm"],
  ] as const)("normalizes %s common schema", (name, args, expectedType) => {
    const parsed = parseQuestionToolCall(toolCall(name, args));
    expect(parsed?.questions).toHaveLength(1);
    expect(parsed?.questions[0]?.type).toBe(expectedType);
    expect(parsed?.questions[0]?.id).toBe("q-0");
  });

  it("normalizes fn_ask_question across all supported question types", () => {
    const parsed = parseQuestionToolCall(toolCall("fn_ask_question", {
      questions: [
        { question: "Pick one", type: "single_select", options: [{ label: "Alpha" }] },
        { question: "Pick many", type: "multi_select", options: [{ label: "Beta", description: "Second" }] },
        { question: "Explain", type: "text", description: "Short answer is fine." },
        { question: "Proceed?", type: "confirm" },
      ],
    }));

    expect(parsed?.questions).toEqual([
      expect.objectContaining({ id: "q-0", type: "single_select", question: "Pick one", options: [{ id: "opt-0", label: "Alpha", description: undefined }] }),
      expect.objectContaining({ id: "q-1", type: "multi_select", question: "Pick many", multiSelect: true, options: [{ id: "opt-0", label: "Beta", description: "Second" }] }),
      expect.objectContaining({ id: "q-2", type: "text", question: "Explain", description: "Short answer is fine." }),
      expect.objectContaining({ id: "q-3", type: "confirm", question: "Proceed?" }),
    ]);
  });

  it("preserves optionality from native and third-party question payloads", () => {
    const native = parseQuestionToolCall(toolCall("fn_ask_question", {
      questions: [
        { question: "Required", type: "text" },
        { question: "Optional", type: "text", optional: true },
      ],
    }));
    const thirdParty = parseQuestionToolCall(toolCall("ask_user", {
      questions: [
        { question: "Optional", required: false },
        { question: "Required", required: true },
      ],
    }));
    const single = parseQuestionToolCall(toolCall("ask_question", { question: "Notes", optional: true }));

    expect(native?.questions.map((question) => question.optional)).toEqual([undefined, true]);
    expect(thirdParty?.questions.map((question) => question.optional)).toEqual([true, undefined]);
    expect(single?.questions[0]?.optional).toBe(true);
  });

  it("falls back for malformed, empty option select, and non-question tools", () => {
    expect(parseQuestionToolCall(toolCall("ask_user"))).toBeNull();
    expect(parseQuestionToolCall(toolCall("ask_user", { question: "" }))).toBeNull();
    expect(parseQuestionToolCall(toolCall("read", { question: "No" }))).toBeNull();
  });

  it("degrades explicit select questions with missing options to answerable text prompts", () => {
    expect(parseQuestionToolCall(toolCall("fn_ask_question", { question: "Pick", type: "single_select" }))?.questions[0]).toEqual(
      expect.objectContaining({ id: "q-0", type: "text", question: "Pick", options: undefined }),
    );
    expect(parseQuestionToolCall(toolCall("fn_ask_question", { question: "Pick many", type: "multi_select", options: [] }))?.questions[0]).toEqual(
      expect.objectContaining({ id: "q-0", type: "text", question: "Pick many", options: undefined }),
    );
  });

  it("marks unanswered optional answers while preserving required and false confirmation answers", () => {
    const questions = [
      { id: "text", type: "text" as const, question: "Notes", optional: true },
      { id: "many", type: "multi_select" as const, question: "Choices", optional: true },
      { id: "answered", type: "text" as const, question: "Detail", optional: true },
      { id: "required", type: "text" as const, question: "Required" },
      { id: "confirm", type: "confirm" as const, question: "Proceed?", optional: true },
    ];

    expect(formatQuestionAnswer(questions, { text: "  ", many: [], answered: "Present", confirm: false })).toBe(
      "> Q: Notes\n(no answer — optional)\n\n> Q: Choices\n(no answer — optional)\n\n> Q: Detail\nPresent\n\n> Q: Required\n(no answer)\n\n> Q: Proceed?\nNo",
    );
  });

  it("formats selected labels, text, and confirm answers", () => {
    const parsed = parseQuestionToolCall(toolCall("AskUserQuestion", {
      questions: [
        { id: "one", question: "Pick one", options: [{ id: "a", label: "Alpha" }] },
        { id: "many", question: "Pick many", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }], multiSelect: true },
        { id: "text", question: "Explain" },
        { id: "ok", question: "Proceed?", type: "confirm" },
      ],
    }));

    expect(parsed).not.toBeNull();
    expect(formatQuestionAnswer(parsed!.questions, { one: "a", many: ["x", "y"], text: "Because", ok: false })).toBe(
      "> Q: Pick one\nAlpha\n\n> Q: Pick many\nX, Y\n\n> Q: Explain\nBecause\n\n> Q: Proceed?\nNo",
    );
  });
});

/*
FNXC:ChatQuestionLiveness 2026-11-21-12:30:
RUFU-1065. The awaiting proof is a transcript tail holding an unanswered question tool call, never a
generation or sending clock. These blocks replace the 2026-09-17 ones, whose `isSessionGenerating:
false` and `isSending: false` cases asserted the removed rule — the rule that rendered an unanswered
question as an answered record because no writer ever holds a turn that ended by asking.
Fixtures are composed once through `awaitingOnDirectChat` / `awaitingOnPlanner` so a row shape is
stated in one place rather than re-typed per case.
*/
const QUESTION_TOOL_CALLS = [toolCall("fn_ask_question", { question: "Which branch?", options: ["main", "feature"] })];

function questionToolCall(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
  return { ...QUESTION_TOOL_CALLS[0], ...overrides };
}

/** Composes the row-level content proof with the Direct chat predicate, as `ChatView` does. */
function awaitingOnDirectChat(toolCalls: ToolCallInfo[] | undefined, overrides: Record<string, unknown> = {}): boolean {
  return isLiveQuestionAwaitingAnswer({
    role: "assistant",
    isLastMessage: true,
    isStreaming: false,
    holdsAwaitingQuestion: holdsAwaitingQuestionToolCall(toolCalls),
    ...overrides,
  });
}

/** Composes the same content proof with the planner predicate, as `TaskPlannerChatTab` does. */
function awaitingOnPlanner(toolCalls: ToolCallInfo[] | undefined, overrides: Record<string, unknown> = {}): boolean {
  return isPlannerQuestionAwaitingAnswer({
    role: "assistant",
    isLastMessage: true,
    holdsAwaitingQuestion: holdsAwaitingQuestionToolCall(toolCalls),
    ...overrides,
  });
}

describe("holdsAwaitingQuestionToolCall", () => {
  it("accepts a question tool call that did not error", () => {
    expect(holdsAwaitingQuestionToolCall(QUESTION_TOOL_CALLS)).toBe(true);
  });

  it("answers no for a row that holds no question tool call", () => {
    expect(holdsAwaitingQuestionToolCall(undefined)).toBe(false);
    expect(holdsAwaitingQuestionToolCall([])).toBe(false);
    expect(holdsAwaitingQuestionToolCall([toolCall("bash", { command: "ls" })])).toBe(false);
  });

  it("answers no when every question tool call errored", () => {
    expect(holdsAwaitingQuestionToolCall([questionToolCall({ isError: true })])).toBe(false);
  });

  it("is row-level: one live question among other tool calls still awaits", () => {
    expect(holdsAwaitingQuestionToolCall([
      toolCall("bash", { command: "ls" }),
      questionToolCall({ isError: true }),
      questionToolCall(),
    ])).toBe(true);
  });
});

describe("isLiveQuestionAwaitingAnswer", () => {
  it("opens only for the last, non-streaming, non-interrupted assistant row holding a question", () => {
    expect(awaitingOnDirectChat(QUESTION_TOOL_CALLS)).toBe(true);
    expect(awaitingOnDirectChat(QUESTION_TOOL_CALLS, { interrupted: true })).toBe(false);
    expect(awaitingOnDirectChat(QUESTION_TOOL_CALLS, { isStreaming: true })).toBe(false);
    expect(awaitingOnDirectChat(QUESTION_TOOL_CALLS, { isLastMessage: false })).toBe(false);
    expect(awaitingOnDirectChat(QUESTION_TOOL_CALLS, { role: "user" })).toBe(false);
  });

  it("stays closed for a tail row that could not be answered by a reply", () => {
    // A row with no tool calls, a question-free assistant row, and an errored question row are each
    // rows the server would never stamp an answer onto, so their card must not offer one.
    expect(awaitingOnDirectChat(undefined)).toBe(false);
    expect(awaitingOnDirectChat([toolCall("bash", { command: "ls" })])).toBe(false);
    expect(awaitingOnDirectChat([questionToolCall({ isError: true })])).toBe(false);
  });

  it("claims nothing from a row that merely arrived while a turn is running", () => {
    // The removed rule's shape: a generating session used to be the whole proof, so an assistant row
    // with no question on it claimed awaiting. Content, not the clock, now decides.
    expect(awaitingOnDirectChat([toolCall("bash", { command: "ls" })], { isLastMessage: true })).toBe(false);
  });
});

describe("isPlannerQuestionAwaitingAnswer", () => {
  it("opens on the same content proof the Direct chat surface uses", () => {
    expect(awaitingOnPlanner(QUESTION_TOOL_CALLS)).toBe(true);
    expect(awaitingOnPlanner(QUESTION_TOOL_CALLS, { interrupted: true })).toBe(false);
    expect(awaitingOnPlanner(QUESTION_TOOL_CALLS, { isLastMessage: false })).toBe(false);
    expect(awaitingOnPlanner(QUESTION_TOOL_CALLS, { role: "user" })).toBe(false);
    expect(awaitingOnPlanner(undefined)).toBe(false);
    expect(awaitingOnPlanner([toolCall("bash", { command: "ls" })])).toBe(false);
    expect(awaitingOnPlanner([questionToolCall({ isError: true })])).toBe(false);
  });
});

describe("findSubmittedQuestionAnswer", () => {
  it("returns the first following user message content", () => {
    const messages = [
      { role: "assistant", content: "question" },
      { role: "assistant", content: "noise" },
      { role: "user", content: "answer" },
    ];
    expect(findSubmittedQuestionAnswer(messages, 0)).toBe("answer");
    expect(findSubmittedQuestionAnswer(messages, 2)).toBeUndefined();
  });
});

/*
FNXC:ChatQuestionAnswerLink 2026-09-23-13:59:
RUFU-258: the durable link is the authoritative answered-state source, so its readers are tested
against server-persisted row shapes (metadata as stored JSON, local rows that carry none).
*/
describe("durable question-answer link readers", () => {
  const link = (questionMessageId: unknown) => ({ [QUESTION_ANSWER_METADATA_KEY]: { questionMessageId } });

  it("reads a well-formed durable link", () => {
    expect(readQuestionAnswerLink(link("msg-q1"))).toBe("msg-q1");
  });

  it("treats every malformed payload as no link", () => {
    expect(readQuestionAnswerLink(undefined)).toBeNull();
    expect(readQuestionAnswerLink(null)).toBeNull();
    expect(readQuestionAnswerLink("nope")).toBeNull();
    expect(readQuestionAnswerLink({ [QUESTION_ANSWER_METADATA_KEY]: null })).toBeNull();
    expect(readQuestionAnswerLink({ [QUESTION_ANSWER_METADATA_KEY]: "msg-q1" })).toBeNull();
    expect(readQuestionAnswerLink({ [QUESTION_ANSWER_METADATA_KEY]: ["msg-q1"] })).toBeNull();
    expect(readQuestionAnswerLink({ [QUESTION_ANSWER_METADATA_KEY]: {} })).toBeNull();
    expect(readQuestionAnswerLink({ [QUESTION_ANSWER_METADATA_KEY]: { questionMessageId: 42 } })).toBeNull();
    expect(readQuestionAnswerLink({ [QUESTION_ANSWER_METADATA_KEY]: { questionMessageId: "   " } })).toBeNull();
  });

  it("indexes the transcript by question id, chronological first answer winning", () => {
    const rows = [
      { id: "a-q1", role: "assistant", content: "Q1?", metadata: null },
      { id: "u-first", role: "user", content: "the real answer", metadata: link("a-q1") },
      { id: "a-mid", role: "assistant", content: "noted", metadata: null },
      // A stamp anomaly: a second row claims the same question. The oldest claim wins.
      { id: "u-again", role: "user", content: "a later claim", metadata: link("a-q1") },
      { id: "u-plain", role: "user", content: "unrelated new request", metadata: { mentions: [] } },
    ];

    const index = indexDurableQuestionAnswers(rows);
    expect([...index.keys()]).toEqual(["a-q1"]);
    expect(index.get("a-q1")?.id).toBe("u-first");

    expect(findDurableQuestionAnswer(rows, "a-q1")?.id).toBe("u-first");
    expect(findDurableQuestionAnswer(rows, "a-unlinked")).toBeNull();
    expect(findDurableQuestionAnswer(rows, "")).toBeNull();
  });

  it("never resolves an answer from a non-user row even when it carries the link", () => {
    const rows = [
      { id: "a-echo", role: "assistant", content: "echo", metadata: link("a-q1") },
      { id: "u-real", role: "user", content: "answer", metadata: null },
    ];
    expect(findDurableQuestionAnswer(rows, "a-q1")).toBeNull();
    expect(indexDurableQuestionAnswers(rows).size).toBe(0);
  });
});
