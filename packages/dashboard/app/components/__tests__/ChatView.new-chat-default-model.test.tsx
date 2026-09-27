import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { ChatView } from "../ChatView";
import type { UseChatReturn, ChatMessageInfo, ChatSessionInfo } from "../../hooks/useChat";
import { FileBrowserProvider } from "../../context/FileBrowserContext";
import * as useChatModule from "../../hooks/useChat";
import * as apiModule from "../../api";

/*
FNXC:ChatNewChatCatalogRace 2026-09-27-09:36:
The default chat model arrives with the model catalog (`GET /api/models`), and that client cache is
legitimately empty on a cold load — 6 h TTL, a version-update wipe, or a first fetch that has not landed
yet. New Chat used to read that emptiness as a configuration verdict and toast "Configure a default chat
model" on every project, while the same click a moment later worked. These cases pin the invariant: one
forced catalog fetch answers before the refusal, and the refusal survives only for a genuinely
default-less catalog. The operator requirement was "I cannot start a new chat anywhere".
*/

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
  fetchModels: vi.fn(),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  updateGlobalSettings: vi.fn(),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
}));
vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return {
    ...actual,
    Bot: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-bot"} {...props} />,
  };
});

const mockUseChat = vi.mocked(useChatModule.useChat);
const mockFetchModels = vi.mocked(apiModule.fetchModels);

const session: ChatSessionInfo = {
  id: "session-1",
  agentId: "agent-1",
  status: "active",
  title: "Session",
  createdAt: "2026-05-19T00:00:00.000Z",
  updatedAt: "2026-05-19T00:00:00.000Z",
};

const message: ChatMessageInfo = {
  id: "msg-1",
  sessionId: "session-1",
  role: "assistant",
  content: "hello",
  createdAt: "2026-05-19T00:00:00.000Z",
};

/** Catalog with the resolved default pair (what `/api/models` returns when a default is configured). */
const catalogWithDefault = {
  models: [{ provider: "dsai1", modelId: "deepseek-v4", label: "DeepSeek V4" }],
  favoriteProviders: [],
  favoriteModels: [],
  defaultProvider: "dsai1",
  defaultModelId: "deepseek-v4",
  providerInstances: {},
};

/** Catalog from a board with no default model configured at any tier. */
const catalogWithoutDefault = { ...catalogWithDefault, defaultProvider: undefined, defaultModelId: undefined };

function mockChatState(createSession: ReturnType<typeof vi.fn>) {
  const state: UseChatReturn = {
    sessions: [session],
    activeSession: session,
    sessionsLoading: false,
    messages: [message],
    messagesLoading: false,
    isStreaming: false,
    streamingText: "",
    streamingThinking: "",
    streamingToolCalls: [],
    streamingPhase: null,
    handoffSession: vi.fn(),
    loadMoreSessions: vi.fn().mockResolvedValue(undefined),
    hasMoreSessions: false,
    hasMoreArchivedSessions: false,
    sessionsLoadingMore: false,
    selectSession: vi.fn(),
    createSession,
    archiveSession: vi.fn(),
    deleteSession: vi.fn(),
    sendMessage: vi.fn(),
    editMessageAndResend: vi.fn(),
    editDraftRestore: null,
    clearEditDraftRestore: vi.fn(),
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
  mockUseChat.mockReturnValue(state);
}

function renderView(addToast: ReturnType<typeof vi.fn>) {
  return render(
    <FileBrowserProvider openFile={vi.fn()}>
      <ChatView addToast={addToast} />
    </FileBrowserProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe("ChatView New Chat default-model resolution", () => {
  it("creates the session from a forced catalog fetch instead of refusing while the catalog is unavailable", async () => {
    const createSession = vi.fn().mockResolvedValue(session);
    mockChatState(createSession);
    const addToast = vi.fn();
    // The mount-time catalog fetch fails (network blip / cold window); the click must force a retry.
    mockFetchModels
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(catalogWithDefault);

    renderView(addToast);
    await waitFor(() => expect(screen.getByTestId("chat-new-btn")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("chat-new-btn"));

    await waitFor(() =>
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({ modelProvider: "dsai1", modelId: "deepseek-v4" }),
      ),
    );
    expect(addToast.mock.calls.filter(([msg]) => String(msg).includes("default chat model"))).toEqual([]);
  });

  it("still refuses when the answered catalog really has no default model", async () => {
    const createSession = vi.fn().mockResolvedValue(session);
    mockChatState(createSession);
    const addToast = vi.fn();
    mockFetchModels.mockResolvedValue(catalogWithoutDefault);

    renderView(addToast);
    await waitFor(() => expect(screen.getByTestId("chat-new-btn")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("chat-new-btn"));

    await waitFor(() =>
      expect(addToast.mock.calls.some(([msg]) => String(msg).includes("default chat model"))).toBe(true),
    );
    expect(createSession).not.toHaveBeenCalled();
  });
});
