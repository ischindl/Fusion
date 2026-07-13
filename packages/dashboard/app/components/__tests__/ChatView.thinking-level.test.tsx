// ChatView thinking-level control mount test (FN-7898).
//
// Asserts the Brain-icon ChatThinkingLevelControl renders ONLY in the direct-session
// (non-CLI) composer, next to the attach button, and never renders for CLI-backed
// sessions, never in the rooms composer, and never with no active session. Also verifies
// the control's displayed state tracks the active session across a session switch, and
// that it renders without layout regression at a mobile viewport.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { ChatView } from "../ChatView";
import * as useChatModule from "../../hooks/useChat";
import * as useChatRoomsModule from "../../hooks/useChatRooms";
import type { ChatSessionInfo, UseChatReturn } from "../../hooks/useChat";
import type { UseChatRoomsResult } from "../../hooks/useChatRooms";
import { _resetInitialViewportHeight } from "../../hooks/useMobileKeyboard";

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
    id: "sess-1",
    agentId: "agent-1",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function chatState(overrides: Partial<UseChatReturn> = {}): UseChatReturn {
  const session = "activeSession" in overrides ? overrides.activeSession ?? null : makeSession();
  return {
    sessions: session ? [session] : [],
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
    setSessionThinkingLevel: vi.fn(),
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
    filteredSessions: session ? [session] : [],
    refreshSessions: vi.fn(),
    agentsMap: new Map(),
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

function roomsState(overrides: Partial<UseChatRoomsResult> = {}): UseChatRoomsResult {
  return {
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
    ...overrides,
  };
}

function mockDesktopViewport() {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", { value: vi.fn(), configurable: true, writable: true });
  }
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as MediaQueryList);
}

function mockMobileViewport() {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", { value: vi.fn(), configurable: true, writable: true });
  }
  Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)",
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as MediaQueryList);
}

describe("ChatView thinking-level control (FN-7898)", () => {
  beforeEach(() => {
    _resetInitialViewportHeight();
    vi.clearAllMocks();
    mockDesktopViewport();
    mockUseChatRooms.mockReturnValue(roomsState());
  });

  it("(a) renders in the direct-session composer for a non-CLI active session and selecting a level calls setSessionThinkingLevel(session.id, level)", async () => {
    const setSessionThinkingLevel = vi.fn();
    const session = makeSession({ id: "sess-a", cliExecutorAdapterId: null, thinkingLevel: null });
    mockUseChat.mockReturnValue(chatState({ activeSession: session, sessions: [session], setSessionThinkingLevel }));

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const trigger = screen.getByTestId("chat-thinking-btn");
    expect(trigger).toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId("chat-thinking-option-high"));

    expect(setSessionThinkingLevel).toHaveBeenCalledWith("sess-a", "high");
  });

  it("(b) does NOT render when the active session is CLI-backed", async () => {
    const session = makeSession({ id: "sess-cli", cliExecutorAdapterId: "claude-code", cliSessionFile: "cli-native-1" });
    mockUseChat.mockReturnValue(chatState({ activeSession: session, sessions: [session] }));

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.queryByTestId("chat-thinking-btn")).toBeNull();
  });

  it("(c) does NOT render in the rooms composer when chatScope is rooms with an active room", async () => {
    const session = makeSession({ id: "sess-a", cliExecutorAdapterId: null });
    mockUseChat.mockReturnValue(chatState({ activeSession: session, sessions: [session] }));
    mockUseChatRooms.mockReturnValue(roomsState({ rooms: [roomA], activeRoom: roomA }));
    localStorage.setItem("fusion:chat-scope", "rooms");

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

    // The rooms composer's own attach button is present (proves the rooms
    // composer rendered), but no thinking-level trigger exists anywhere.
    expect(screen.getAllByTestId("chat-attach-btn").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("chat-thinking-btn")).toBeNull();

    localStorage.removeItem("fusion:chat-scope");
  });

  it("(d) does NOT render when there is no active session", async () => {
    mockUseChat.mockReturnValue(chatState({ activeSession: null, sessions: [] }));

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.queryByTestId("chat-thinking-btn")).toBeNull();
  });

  it("(e) updates the control's active-state class when switching from a session with a concrete thinkingLevel to one without", async () => {
    const sessionWithLevel = makeSession({ id: "sess-with-level", cliExecutorAdapterId: null, thinkingLevel: "high" });
    mockUseChat.mockReturnValue(chatState({ activeSession: sessionWithLevel, sessions: [sessionWithLevel] }));

    const { rerender } = await (async () => {
      let result: ReturnType<typeof rtlRender> | undefined;
      await act(async () => {
        result = rtlRender(<ChatView projectId="proj-123" addToast={vi.fn()} />);
      });
      return result!;
    })();

    expect(screen.getByTestId("chat-thinking-btn").className).toContain("chat-thinking-btn--active");

    const sessionWithoutLevel = makeSession({ id: "sess-without-level", cliExecutorAdapterId: null, thinkingLevel: null });
    mockUseChat.mockReturnValue(chatState({ activeSession: sessionWithoutLevel, sessions: [sessionWithoutLevel] }));

    await act(async () => {
      rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    });

    expect(screen.getByTestId("chat-thinking-btn").className).not.toContain("chat-thinking-btn--active");
  });

  it("(f) renders the trigger without a layout/overflow regression at a mobile viewport", async () => {
    mockMobileViewport();
    const session = makeSession({ id: "sess-mobile", cliExecutorAdapterId: null, thinkingLevel: null });
    mockUseChat.mockReturnValue(chatState({ activeSession: session, sessions: [session] }));

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const trigger = screen.getByTestId("chat-thinking-btn");
    expect(trigger).toBeInTheDocument();
    // Shell/structure assertion consistent with other ChatView mobile tests:
    // the trigger sits alongside the attach button inside the same input row.
    expect(trigger.closest(".chat-input-row")).not.toBeNull();
    expect(trigger.closest(".chat-thinking-level-root")).not.toBeNull();
  });
});
