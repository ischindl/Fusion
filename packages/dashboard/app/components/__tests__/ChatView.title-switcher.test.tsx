import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import { CHAT_TITLE_SWITCHER_MAX_ITEMS } from "../ChatThreadTitleSwitcher";
import type { ChatSessionInfo } from "../../hooks/useChat";
import { loadAllAppCss } from "../../test/cssFixture";
import {
  activeSessionFixture,
  defaultChatState,
  installChatViewEnv,
  mockViewportMode,
  renderWithAct,
  setupMockChat,
  setupMockRooms,
} from "./ChatView.test-harness";

const { markRead } = vi.hoisted(() => ({ markRead: vi.fn() }));

// Factories stay inline: importing the shared harness from a factory creates a TDZ cycle.
vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useChatUnread", () => ({
  useChatUnread: () => ({ isUnread: () => false, markRead }),
}));
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useNavigationHistory")>()),
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));
vi.mock("../CustomModelDropdown", () => ({ CustomModelDropdown: () => null }));
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));

installChatViewEnv();

function session(id: string, title: string | null = id): ChatSessionInfo {
  return {
    ...activeSessionFixture,
    id,
    title,
    updatedAt: "2026-08-23T00:00:00.000Z",
  };
}

async function renderDirect(options: { sessions?: ChatSessionInfo[]; activeSession?: ChatSessionInfo; floating?: boolean } = {}) {
  const activeSession = options.activeSession ?? session("session-001", "Alpha");
  const sessions = options.sessions ?? [activeSession, session("session-002", "Beta"), session("session-003", "Gamma")];
  const selectSession = vi.fn();
  setupMockChat({
    ...defaultChatState,
    activeSession,
    sessions,
    filteredSessions: sessions,
    messages: [{ id: "message-001", sessionId: activeSession.id, role: "assistant", content: "Hello", createdAt: "2026-08-23T00:00:00.000Z" }],
    selectSession,
  });
  await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} floating={options.floating} />);
  await userEvent.click(screen.getByTestId(`chat-session-${activeSession.id}`));
  return { activeSession, sessions, selectSession };
}

describe("ChatView title switcher", () => {
  it("opens ordered direct conversations and marks the active session", async () => {
    await renderDirect();
    await userEvent.click(screen.getByTestId("chat-thread-title-trigger"));
    const menu = await screen.findByTestId("chat-thread-title-menu");
    expect(menu).toBeInTheDocument();
    expect(screen.getByTestId("chat-thread-title-trigger")).toHaveAttribute("aria-expanded", "true");
    expect(within(menu).getByTestId("chat-thread-title-menu-item-session-001")).toHaveAttribute("aria-current", "true");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(4);
  });

  it("switches by session id without leaving detail view", async () => {
    const { selectSession } = await renderDirect();
    await userEvent.click(screen.getByTestId("chat-thread-title-trigger"));
    await userEvent.click(screen.getByTestId("chat-thread-title-menu-item-session-002"));

    expect(selectSession).toHaveBeenCalledWith("session-002");
    expect(markRead).toHaveBeenCalledWith("direct", "session-002", expect.any(String));
    expect(screen.getByTestId("chat-thread-header-identity")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-thread-title-menu")).not.toBeInTheDocument();
  });

  it("keeps duplicate titles bound to their distinct session ids", async () => {
    const active = session("session-001", "Duplicate");
    const duplicate = session("session-002", "Duplicate");
    const { selectSession } = await renderDirect({ activeSession: active, sessions: [active, duplicate] });
    await userEvent.click(screen.getByTestId("chat-thread-title-trigger"));
    await userEvent.click(screen.getByTestId("chat-thread-title-menu-item-session-002"));

    expect(selectSession).toHaveBeenCalledWith("session-002");
  });

  it("uses the untitled fallback and shows an empty row for a single session", async () => {
    const active = session("session-001", "");
    await renderDirect({ activeSession: active, sessions: [active] });
    expect(screen.getByTestId("chat-thread-title-trigger")).toHaveTextContent("Untitled conversation");
    await userEvent.click(screen.getByTestId("chat-thread-title-trigger"));

    expect(screen.getByTestId("chat-thread-title-menu-empty")).toHaveTextContent("No other conversations");
    expect(screen.getByTestId("chat-thread-title-menu-all")).toBeInTheDocument();
  });

  it("caps menu rows and returns to the conversation list from All conversations", async () => {
    const sessions = Array.from({ length: CHAT_TITLE_SWITCHER_MAX_ITEMS + 2 }, (_, index) => session(`session-${index}`, `Chat ${index}`));
    await renderDirect({ activeSession: sessions[0], sessions });
    await userEvent.click(screen.getByTestId("chat-thread-title-trigger"));

    expect(screen.getAllByTestId(/chat-thread-title-menu-item-/)).toHaveLength(CHAT_TITLE_SWITCHER_MAX_ITEMS);
    await userEvent.click(screen.getByTestId("chat-thread-title-menu-all"));
    expect(screen.queryByTestId("chat-thread-header-identity")).not.toBeInTheDocument();
  });

  it.each([{ name: "mobile", floating: false, viewport: "mobile" as const }, { name: "narrow", floating: true, viewport: "desktop" as const }])(
    "switches from the $name host",
    async ({ floating, viewport }) => {
      const viewportSpy = mockViewportMode(viewport);
      const { selectSession } = await renderDirect({ floating });
      await userEvent.click(screen.getByTestId("chat-thread-title-trigger"));
      await userEvent.click(screen.getByTestId("chat-thread-title-menu-item-session-002"));
      expect(selectSession).toHaveBeenCalledWith("session-002");
      viewportSpy.mockRestore();
    },
  );

  it("closes on outside press and Escape, and keyboard selects the first row", async () => {
    const { selectSession } = await renderDirect();
    const trigger = screen.getByTestId("chat-thread-title-trigger");
    await userEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("chat-thread-title-menu")).not.toBeInTheDocument();

    trigger.focus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(selectSession).toHaveBeenCalledWith("session-001");
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("chat-thread-title-menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("keeps Rooms titles as plain text without a switcher trigger", async () => {
    const activeRoom = { id: "room-001", projectId: "proj-123", slug: "team", name: "Team", createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z" };
    setupMockRooms({ rooms: [activeRoom], activeRoom });
    setupMockChat({ ...defaultChatState, sessions: [], filteredSessions: [] });
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);
    await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));
    await userEvent.click(screen.getByTestId("chat-room-item-team"));

    expect(screen.queryByTestId("chat-thread-title-trigger")).not.toBeInTheDocument();
    expect(document.querySelector(".chat-room-thread-header .chat-thread-header-title")).toHaveTextContent("#Team");
  });

  it("preserves title tooltip and both truncation contracts", async () => {
    const longTitle = "A deliberately long conversation title that must stay truncated";
    await renderDirect({ activeSession: session("session-001", longTitle) });
    const trigger = screen.getByTestId("chat-thread-title-trigger");
    expect(trigger).toHaveClass("chat-thread-header-title");
    expect(trigger).toHaveAttribute("title", longTitle);
    expect(document.querySelectorAll("span.chat-thread-header-title")).toHaveLength(0);
    const css = await loadAllAppCss();
    expect(css).toMatch(/\.chat-thread-header-title\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/);
    expect(css).toMatch(/\.chat-thread-title-text\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/);
  });
});
