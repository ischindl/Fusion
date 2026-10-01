/*
FNXC:RUFU153 2026-08-23-00:21:
Per FNXC:ChatNavigation (ChatView.tsx) the main pane is gated behind the closed-by-default detailOpen
state and opens only on a user row click. The test clicks the active session row (chat-session-<id>)
through the canonical user path before asserting the hash-mention composer DOM.
*/
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "../ChatView";
import { FileBrowserProvider } from "../../context/FileBrowserContext";
import * as useChatModule from "../../hooks/useChat";
import * as apiModule from "../../api";
import type { UseChatReturn, ChatSessionInfo } from "../../hooks/useChat";

Element.prototype.scrollIntoView = vi.fn();

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms", () => ({
  useChatRooms: () => ({
    rooms: [],
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
    refreshRooms: vi.fn(),
  }),
}));
vi.mock("../../hooks/useChatUnread", () => ({
  useChatUnread: () => ({ isUnread: () => false, markRead: vi.fn() }),
}));
vi.mock("../../hooks/useNavigationHistory", () => ({
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchTasks: vi.fn().mockResolvedValue([
    { id: "FN-5218", title: "Hash entries in chat", column: "todo" },
  ]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
}));

const mockUseChat = vi.mocked(useChatModule.useChat);
const mockFetchTasks = vi.mocked(apiModule.fetchTasks);

const activeSession: ChatSessionInfo = {
  id: "session-1",
  agentId: "agent-1",
  status: "active",
  title: "Chat",
  createdAt: "2026-05-19T00:00:00.000Z",
  updatedAt: "2026-05-19T00:00:00.000Z",
};

const defaultChatState: UseChatReturn = {
  sessions: [activeSession],
  activeSession,
  sessionsLoading: false,
  messages: [],
  messagesLoading: false,
  isStreaming: false,
  streamingText: "",
  streamingThinking: "",
  streamingToolCalls: [],
  /* Merged UseChatReturn (origin/main merge): engine phase, RUFU-199 handoff, FN-459 edit-draft rescue, and session-pagination defaults. */
  streamingPhase: null,
  handoffSession: vi.fn().mockResolvedValue({ session: { id: "session-handoff", agentId: "agent-001", status: "active", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }, degraded: false }),
  loadMoreSessions: vi.fn().mockResolvedValue(undefined),
  hasMoreSessions: false,
  hasMoreArchivedSessions: false,
  sessionsLoadingMore: false,
  selectSession: vi.fn(),
  createSession: vi.fn(),
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  sendMessage: vi.fn(),
  editMessageAndResend: vi.fn(),
  // FNXC:ChatMessageEdit 2026-09-16-05:58: FN-459 edit-draft rescue surface; nothing to restore here.
  editDraftRestore: null,
  clearEditDraftRestore: vi.fn(),
  stopStreaming: vi.fn(),
  pendingMessages: [],
  clearPendingMessage: vi.fn(),
  loadMoreMessages: vi.fn(),
  hasMoreMessages: false,
  searchQuery: "",
  setSearchQuery: vi.fn(),
  filteredSessions: [activeSession],
  refreshSessions: vi.fn(),
  agentsMap: new Map(),

  tags: [],
  selectedTagId: null,
  setSelectedTagId: vi.fn(),
  archivedSessions: [],
  refreshArchivedSessions: vi.fn(),
  unarchiveSession: vi.fn(),
  renameSession: vi.fn(),
  pinSession: vi.fn(),
  pinnedCount: 0,
  setSessionModel: vi.fn(),
  setSessionThinkingLevel: vi.fn(),
  createTag: vi.fn(),
  renameTag: vi.fn(),
  deleteTag: vi.fn(),
  setSessionTags: vi.fn(),
  backfillStashSession: vi.fn(),
};

describe("ChatView hash mentions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseChat.mockReturnValue(defaultChatState);
  });

  it("inserts a task id from the shared hash mention popup", async () => {
    render(
      <FileBrowserProvider openFile={vi.fn()}>
        <ChatView addToast={vi.fn()} />
      </FileBrowserProvider>,
    );
    // RUFU-153: the detail pane (composer included) opens only on row click (FNXC:ChatNavigation 2026-08-19-19:36).
    await userEvent.click(screen.getByTestId("chat-session-session-1"));

    /* FNXC:ChatNavigation 2026-08-23-18:40: FN-054 made Chat list-first, so the composer exists only inside an opened conversation. */
    fireEvent.click(screen.getByTestId(`chat-session-${activeSession.id}`));

    const textarea = screen.getByPlaceholderText("Type a message...") as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: "#FN", selectionStart: 3, selectionEnd: 3 },
    });

    await waitFor(() => {
      expect(screen.getByText("Tasks")).toBeInTheDocument();
    });
    expect(screen.getByTestId("task-mention-item-0")).toHaveTextContent("FN-5218");

    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(textarea.value).toBe("#FN-5218");
    });
    expect(mockFetchTasks).toHaveBeenCalledWith(20, 0, undefined, "FN");
  });
});
