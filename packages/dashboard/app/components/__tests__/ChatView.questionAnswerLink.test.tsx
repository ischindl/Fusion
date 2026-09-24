/*
FNXC:ChatQuestionAnswerLink 2026-09-23-14:21:
RUFU-258 symptom verification on the main Chat surface. Before the durable link, an answered
`fn_ask_question` card reconstructed its answer by position — "the first later user row" — so a
transcript where the operator typed something else first rendered the WRONG text as the submitted
answer, and a card could not be trusted as answered while a later generation was in flight. The
server now stamps `metadata.questionAnswer.questionMessageId` on the row that actually answered, and
the card must render from that link first, keeping the positional scan only as the pre-feature
fallback. These two tests are the red/green pair that pins that precedence.
*/
import { describe, it, expect, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { ChatView } from "../ChatView";
import type { ChatMessageInfo } from "../../hooks/chatTypes";
import {
  activeSessionFixture,
  installChatViewEnv,
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

function questionRow(id: string, createdAt: string): ChatMessageInfo {
  return {
    id,
    sessionId: activeSessionFixture.id,
    role: "assistant",
    content: "Which branch should I use?",
    toolCalls: [{ toolName: "fn_ask_question", args: QUESTION_ARGS, isError: false, status: "completed" }],
    createdAt,
  };
}

function userRow(id: string, content: string, createdAt: string, metadata?: Record<string, unknown>): ChatMessageInfo {
  return {
    id,
    sessionId: activeSessionFixture.id,
    role: "user",
    content,
    ...(metadata ? { metadata } : {}),
    createdAt,
  };
}

function assistantRow(id: string, content: string, createdAt: string): ChatMessageInfo {
  return { id, sessionId: activeSessionFixture.id, role: "assistant", content, createdAt };
}

/*
Transcript under test: the operator first typed an unrelated follow-up while the card was still live,
and only afterwards answered the question properly. Position says the follow-up is the answer; the
durable link says the later row is.
*/
function transcript(answerLinked: boolean): ChatMessageInfo[] {
  return [
    questionRow("a-question", "2026-09-23T00:01:00.000Z"),
    userRow("u-unrelated", "wait, also check CI", "2026-09-23T00:02:00.000Z"),
    assistantRow("a-ack", "Noted, I will check CI too.", "2026-09-23T00:03:00.000Z"),
    userRow(
      "u-answer",
      "the feature branch",
      "2026-09-23T00:04:00.000Z",
      answerLinked ? { questionAnswer: { questionMessageId: "a-question" } } : undefined,
    ),
    assistantRow("a-working", "Working on the feature branch now.", "2026-09-23T00:05:00.000Z"),
  ];
}

async function renderThread(messages: ChatMessageInfo[]) {
  const generatingSession = { ...activeSessionFixture, isGenerating: true };
  setupMockChat({
    activeSession: generatingSession,
    sessions: [generatingSession],
    filteredSessions: [generatingSession],
    messages,
  });
  setupMockRooms();
  await renderChatDetailWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
}

describe("ChatView durable question-answer link", () => {
  it("renders the linked answer verbatim and stays read-only while a later turn is generating", async () => {
    await renderThread(transcript(true));

    const card = await screen.findByTestId("chat-question-response");
    const submitted = within(card).getByTestId("chat-question-response-submitted-answer");
    expect(submitted).toHaveTextContent("the feature branch");
    expect(submitted).not.toHaveTextContent("wait, also check CI");
    expect(within(card).getByText("Answered")).toBeInTheDocument();
    // Answered is authoritative: no competing submit affordance even with isGenerating true.
    expect(within(card).queryByTestId("chat-question-response-submit")).not.toBeInTheDocument();
  });

  it("keeps the positional fallback for a pre-feature row that carries no link", async () => {
    await renderThread(transcript(false));

    const card = await screen.findByTestId("chat-question-response");
    // Legacy behavior is preserved untouched for rows written before the durable link existed.
    expect(within(card).getByTestId("chat-question-response-submitted-answer")).toHaveTextContent("wait, also check CI");
    expect(within(card).queryByTestId("chat-question-response-submit")).not.toBeInTheDocument();
  });
});
