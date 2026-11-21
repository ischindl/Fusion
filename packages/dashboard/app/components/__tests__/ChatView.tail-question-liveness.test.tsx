/*
FNXC:ChatQuestionLiveness 2026-11-21-12:30:
RUFU-1065 symptom verification on the Direct chat surface. The operator measured this on every
question asked in Direct chat: the moment the turn finished, the option buttons vanished and the card
replaced itself with "A later user reply answered this question." although no reply had been sent.
The cause was the liveness proof, not the card: `isLiveQuestionAwaitingAnswer` asked the session's
generation clock, and no writer ever holds that generation for a turn that ended by asking a question
(`packages/dashboard/src/chat.ts` flushes it unconditionally on normal completion), so the proof was
false as soon as the assistant row was persisted. The proof must instead come from the transcript: the
same decision the server makes with `findAwaitingQuestionMessageId` before it stamps
`metadata.questionAnswer`. A row that would still receive an answer stamp is a row whose card is still
answerable, and a row that already has a linked answer is a record. These tests pin both halves.
*/
import { describe, it, expect, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import type { ChatMessageInfo } from "../../hooks/chatTypes";
import {
  activeSessionFixture,
  installChatViewEnv,
  mockViewportMode,
  renderChatDetailWithAct,
  setupMockChat,
  setupMockRooms,
} from "./ChatView.test-harness";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn(), removeNav: vi.fn() }),
  };
});

vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
  fetchChatMessages: vi.fn().mockResolvedValue({ messages: [] }),
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
}));

installChatViewEnv();

const QUESTION_ARGS = { question: "Which branch?", options: ["main", "feature"] };
const ANSWER_TEXT = "> Q: Which branch?\nmain";

function questionRow(overrides: Partial<ChatMessageInfo> = {}): ChatMessageInfo {
  return {
    id: "a-question",
    sessionId: activeSessionFixture.id,
    role: "assistant",
    content: "Which branch should I use?",
    toolCalls: [{ toolName: "fn_ask_question", args: QUESTION_ARGS, isError: false, status: "completed" }],
    createdAt: "2026-11-21T00:01:00.000Z",
    ...overrides,
  };
}

function plainAssistantRow(id: string, content: string): ChatMessageInfo {
  return {
    id,
    sessionId: activeSessionFixture.id,
    role: "assistant",
    content,
    createdAt: "2026-11-21T00:03:00.000Z",
  };
}

function plainUserRow(content: string): ChatMessageInfo {
  return {
    id: "u-unlinked",
    sessionId: activeSessionFixture.id,
    role: "user",
    content,
    createdAt: "2026-11-21T00:02:00.000Z",
  };
}

function answerRow(content: string, questionMessageId = "a-question"): ChatMessageInfo {
  return {
    id: "u-answer",
    sessionId: activeSessionFixture.id,
    role: "user",
    content,
    metadata: { questionAnswer: { questionMessageId } },
    createdAt: "2026-11-21T00:02:00.000Z",
  };
}

async function renderThread(messages: ChatMessageInfo[], session: object = activeSessionFixture) {
  const sendMessage = vi.fn();
  // The turn is OVER: no `isGenerating`, no in-flight generation, nothing streaming.
  setupMockChat({
    activeSession: session as never,
    sessions: [session as never],
    filteredSessions: [session as never],
    messages,
    sendMessage,
  });
  setupMockRooms();
  await renderChatDetailWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
  const cards = await screen.findAllByTestId("chat-question-response");
  return { card: cards[0]!, cards, sendMessage };
}

describe("ChatView tail question liveness", () => {
  it("keeps an unanswered tail question actionable after the turn has finished", async () => {
    const { card } = await renderThread([questionRow()]);

    // The card must not present itself as an answered record.
    expect(card).not.toHaveClass("chat-question-response--answered");
    expect(within(card).queryByTestId("chat-question-response-submitted-answer")).not.toBeInTheDocument();
    expect(within(card).queryByText("Answered")).not.toBeInTheDocument();

    // The option controls are reachable, not greyed out.
    const option = within(card).getByTestId("chat-question-response-option-q-0-opt-0");
    const radio = option.querySelector("input");
    expect(radio).not.toBeNull();
    expect(radio).toBeEnabled();

    // The submit button obeys the component's own validity rule: invalid until something is picked.
    const submit = within(card).getByTestId("chat-question-response-submit");
    expect(submit).toBeDisabled();

    await userEvent.click(option);
    expect(submit).toBeEnabled();
  });

  it("delivers the card's answer through the composer send path", async () => {
    const { card, sendMessage } = await renderThread([questionRow()]);

    await userEvent.click(within(card).getByTestId("chat-question-response-option-q-0-opt-0"));
    await userEvent.click(within(card).getByTestId("chat-question-response-submit"));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith(ANSWER_TEXT);
  });

  it("turns the same card into a record once a reply is durably linked to it", async () => {
    const { card } = await renderThread([questionRow(), answerRow("main, please")]);

    expect(card).toHaveClass("chat-question-response--answered");
    expect(within(card).getByText("Answered")).toBeInTheDocument();
    expect(within(card).getByTestId("chat-question-response-submitted-answer")).toHaveTextContent("main, please");
    expect(within(card).queryByTestId("chat-question-response-submit")).not.toBeInTheDocument();
    expect(within(card).queryByTestId("chat-question-response-option-q-0-opt-0")).not.toBeInTheDocument();
  });

  /*
  FNXC:ChatQuestionLiveness 2026-11-21-12:41:
  The state matrix the intake enumerated. Each case is decided by whether a reply sent NOW would
  still be stamped as this card's answer, which is the only reason a card may offer controls.
  */
  it("stays actionable after a restart, which reports the session as not generating", async () => {
    // A reload re-reads chat_sessions with `isGenerating: false` and no in-flight snapshot. Under the
    // clock rule the restart alone was what killed the card; the tail row is what decides now.
    const { card } = await renderThread([questionRow()], { ...activeSessionFixture, isGenerating: false });

    expect(card).not.toHaveClass("chat-question-response--answered");
    expect(within(card).getByTestId("chat-question-response-option-q-0-opt-0").querySelector("input")).toBeEnabled();
    // The component's own validity rule still gates the button: present, inert until something is picked.
    const submit = within(card).getByTestId("chat-question-response-submit");
    expect(submit).toBeDisabled();
    await userEvent.click(within(card).getByTestId("chat-question-response-option-q-0-opt-0"));
    expect(submit).toBeEnabled();
  });

  it("keeps an interrupted tail question as a record", async () => {
    // RUFU-144 turns a Stop or a runtime restart into an interrupted row; posting into it is a no-op,
    // so this row must stay a record even though it holds an unanswered question on the tail.
    const { card } = await renderThread([questionRow({ metadata: { interrupted: true } })]);

    expect(card).toHaveClass("chat-question-response--answered");
    expect(within(card).queryByTestId("chat-question-response-submit")).not.toBeInTheDocument();
  });

  it("answers both cards of a row that asked two questions, at row granularity", async () => {
    const twoQuestions = questionRow({
      toolCalls: [
        { toolName: "fn_ask_question", args: QUESTION_ARGS, isError: false, status: "completed" },
        { toolName: "fn_ask_question", args: { question: "And which env?", options: ["dev", "prod"] }, isError: false, status: "completed" },
      ],
    });
    const { cards } = await renderThread([twoQuestions]);

    expect(cards).toHaveLength(2);
    for (const each of cards) {
      expect(each).not.toHaveClass("chat-question-response--answered");
      expect(within(each).getByTestId("chat-question-response-submit")).toBeInTheDocument();
    }
  });

  it("claims nothing for a tail that a reply could no longer bind to", async () => {
    // Question superseded by a later turn: the server would refuse to stamp an answer onto it, so the
    // card must not offer controls. Only the tail row can be awaiting, on either surface.
    const { card } = await renderThread([questionRow(), plainAssistantRow("a-next", "I went with main.")]);

    expect(card).toHaveClass("chat-question-response--answered");
    expect(within(card).queryByTestId("chat-question-response-submit")).not.toBeInTheDocument();
    expect(within(card).queryByTestId("chat-question-response-option-q-0-opt-0")).not.toBeInTheDocument();
  });

  it("claims nothing once a reply row already follows the question", async () => {
    const { card } = await renderThread([questionRow(), plainUserRow("main")]);

    expect(card).toHaveClass("chat-question-response--answered");
    expect(within(card).getByTestId("chat-question-response-submitted-answer")).toHaveTextContent("main");
    expect(within(card).queryByTestId("chat-question-response-submit")).not.toBeInTheDocument();
  });

  it("keeps the same decision on the mobile layout", async () => {
    mockViewportMode("mobile");
    const { card } = await renderThread([questionRow()]);

    expect(card).not.toHaveClass("chat-question-response--answered");
    const option = within(card).getByTestId("chat-question-response-option-q-0-opt-0");
    expect(option.querySelector("input")).toBeEnabled();

    const submit = within(card).getByTestId("chat-question-response-submit");
    expect(submit).toBeDisabled();
    await userEvent.click(option);
    expect(submit).toBeEnabled();
  });
});
