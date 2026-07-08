/*
FNXC:ChatMessageEdit 2026-07-07-09:00:
Covers the FN-7628 chat message edit affordance across the surfaces enumerated in
PROMPT.md: renders only for user messages in direct/model-loop chat, is absent for
assistant messages, CLI-agent-backed sessions, and Rooms, and is disabled while
streaming. Also covers the inline editor save/cancel interaction and the
editMessageAndResend wiring.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { ChatView } from "../ChatView";
import * as useChatModule from "../../hooks/useChat";
import * as useChatRoomsModule from "../../hooks/useChatRooms";
import type { ChatSessionInfo, UseChatReturn } from "../../hooks/useChat";
import type { UseChatRoomsResult } from "../../hooks/useChatRooms";

Element.prototype.scrollIntoView = vi.fn();

vi.mock("../SessionTerminal", () => ({
  SessionTerminal: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="session-terminal" data-session-id={sessionId}>
      terminal
    </div>
  ),
}));

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
});
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchAgents: vi.fn().mockResolvedValue([]),
    fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
    fetchTasks: vi.fn().mockResolvedValue([]),
    searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  };
});
vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return {
    ...actual,
    Pencil: (props: any) => <svg data-testid="icon-pencil" {...props} />,
  };
});

async function renderWithAct(ui: Parameters<typeof rtlRender>[0]) {
  let result: ReturnType<typeof rtlRender> | undefined;
  await act(async () => {
    result = rtlRender(ui);
  });
  return result!;
}

const mockUseChat = vi.mocked(useChatModule.useChat);
const mockUseChatRooms = vi.mocked(useChatRoomsModule.useChatRooms);

function makeSession(overrides: Partial<ChatSessionInfo> = {}): ChatSessionInfo {
  return {
    id: "session-001",
    agentId: "agent-001",
    status: "active",
    title: "Test Chat",
    createdAt: "2026-04-08T00:00:00.000Z",
    updatedAt: "2026-04-08T00:00:00.000Z",
    ...overrides,
  };
}

const roomA = {
  id: "room-a",
  name: "Room A",
  slug: "room-a",
  description: null,
  projectId: "proj-123",
  createdBy: "agent-1",
  status: "active" as const,
  createdAt: "2026-04-08T00:00:00.000Z",
  updatedAt: "2026-04-08T00:00:00.000Z",
};

function baseRoomsState(overrides: Partial<UseChatRoomsResult> = {}): UseChatRoomsResult {
  return {
    rooms: [roomA],
    roomsLoading: false,
    roomsError: null,
    activeRoom: null,
    activeRoomMembers: [],
    messages: [],
    messagesLoading: false,
    selectRoom: vi.fn(),
    createRoom: vi.fn(),
    deleteRoom: vi.fn(),
    sendRoomMessage: vi.fn(),
    clearRoom: vi.fn(),
    refreshRooms: vi.fn(),
    ...overrides,
  };
}

function baseChatState(overrides: Partial<UseChatReturn> = {}): UseChatReturn {
  const session = overrides.activeSession ?? makeSession();
  return {
    sessions: [session],
    activeSession: session,
    sessionsLoading: false,
    messages: [],
    messagesLoading: false,
    isStreaming: false,
    streamingText: "",
    streamingThinking: "",
    streamingToolCalls: [],
    selectSession: vi.fn(),
    createSession: vi.fn(),
    archiveSession: vi.fn(),
    renameSession: vi.fn(),
    deleteSession: vi.fn(),
    sendMessage: vi.fn(),
    editMessageAndResend: vi.fn(),
    stopStreaming: vi.fn(),
    pendingMessages: [],
    clearPendingMessage: vi.fn(),
    loadMoreMessages: vi.fn(),
    hasMoreMessages: false,
    searchQuery: "",
    setSearchQuery: vi.fn(),
    filteredSessions: [session],
    refreshSessions: vi.fn(),
    agentsMap: new Map(),
    ...overrides,
  };
}

describe("ChatView message edit affordance", () => {
  beforeEach(() => {
    localStorage.clear();
    mockUseChatRooms.mockReturnValue(baseRoomsState());
  });

  it("renders the edit affordance only on user messages in a direct chat session", async () => {
    mockUseChat.mockReturnValue(baseChatState({
      messages: [
        { id: "user-1", sessionId: "session-001", role: "user", content: "hello", createdAt: "2026-04-08T00:00:00.000Z" },
        { id: "assistant-1", sessionId: "session-001", role: "assistant", content: "hi there", createdAt: "2026-04-08T00:00:01.000Z" },
      ],
    }));

    await renderWithAct(<ChatView addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-message-edit-user-1")).toHaveAttribute("aria-label", "Edit message");
    expect(screen.queryByTestId("chat-message-edit-assistant-1")).toBeNull();
  });

  it("is absent for CLI-agent-backed sessions", async () => {
    mockUseChat.mockReturnValue(baseChatState({
      activeSession: makeSession({ cliExecutorAdapterId: "claude-code", cliSessionFile: "cli-native-1" }),
      messages: [
        { id: "user-1", sessionId: "session-001", role: "user", content: "hello", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    }));

    await renderWithAct(<ChatView addToast={vi.fn()} />);

    expect(screen.queryByTestId("chat-message-edit-user-1")).toBeNull();
  });

  it("is absent for Rooms messages", async () => {
    mockUseChat.mockReturnValue(baseChatState({ messages: [] }));
    mockUseChatRooms.mockReturnValue(baseRoomsState({
      activeRoom: roomA,
      messages: [
        { id: "room-user-1", roomId: roomA.id, role: "user", content: "hey room", createdAt: "2026-04-08T00:00:00.000Z", senderAgentId: "agent-1", mentions: [] },
      ],
    }));

    await renderWithAct(<ChatView addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    fireEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));

    expect(screen.queryByTestId("chat-message-edit-room-user-1")).toBeNull();
  });

  it("is absent while a generation is streaming", async () => {
    mockUseChat.mockReturnValue(baseChatState({
      isStreaming: true,
      messages: [
        { id: "user-1", sessionId: "session-001", role: "user", content: "hello", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    }));

    await renderWithAct(<ChatView addToast={vi.fn()} />);

    expect(screen.queryByTestId("chat-message-edit-user-1")).toBeNull();
  });

  it("swaps to an inline editor and saves via editMessageAndResend", async () => {
    const editMessageAndResend = vi.fn();
    mockUseChat.mockReturnValue(baseChatState({
      editMessageAndResend,
      messages: [
        { id: "user-1", sessionId: "session-001", role: "user", content: "hello", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    }));

    await renderWithAct(<ChatView addToast={vi.fn()} />);

    fireEvent.click(screen.getByTestId("chat-message-edit-user-1"));

    const editor = screen.getByTestId("chat-message-edit-editor-user-1");
    const textarea = editor.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("hello");

    fireEvent.change(textarea, { target: { value: "hello, edited" } });
    fireEvent.click(screen.getByText("Save"));

    expect(editMessageAndResend).toHaveBeenCalledWith("user-1", "hello, edited");
    expect(screen.queryByTestId("chat-message-edit-editor-user-1")).toBeNull();
  });

  it("cancel restores the original content without calling editMessageAndResend", async () => {
    const editMessageAndResend = vi.fn();
    mockUseChat.mockReturnValue(baseChatState({
      editMessageAndResend,
      messages: [
        { id: "user-1", sessionId: "session-001", role: "user", content: "hello", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    }));

    await renderWithAct(<ChatView addToast={vi.fn()} />);

    fireEvent.click(screen.getByTestId("chat-message-edit-user-1"));
    const editor = screen.getByTestId("chat-message-edit-editor-user-1");
    const textarea = editor.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "changed but cancelled" } });

    fireEvent.click(screen.getByText("Cancel"));

    expect(editMessageAndResend).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chat-message-edit-editor-user-1")).toBeNull();
    expect(screen.getByTestId("chat-message-user-1")).toHaveTextContent("hello");
  });

  it("does not leave an empty edit-action shell for assistant messages", async () => {
    mockUseChat.mockReturnValue(baseChatState({
      messages: [
        { id: "assistant-1", sessionId: "session-001", role: "assistant", content: "hi there", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    }));

    await renderWithAct(<ChatView addToast={vi.fn()} />);

    const assistantMessage = screen.getByTestId("chat-message-assistant-1");
    expect(assistantMessage.querySelector("[aria-label='Edit message']")).toBeNull();
  });
});
