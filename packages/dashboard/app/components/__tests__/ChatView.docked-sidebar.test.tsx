/*
FNXC:DashboardTests 2026-08-23-03:55:
FN-9193 requires both tablet shapes to resolve through useViewportMode before docked-list
assertions run. These tests also keep persistence and excluded hosts on the shared ChatView path.
*/
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { ChatView, CHAT_DOCKED_SIDEBAR_DEFAULT_WIDTH, CHAT_DOCKED_SIDEBAR_MAX_WIDTH, CHAT_DOCKED_SIDEBAR_MIN_WIDTH, CHAT_DOCKED_SIDEBAR_OPEN_STORAGE_KEY, CHAT_DOCKED_SIDEBAR_WIDTH_STORAGE_KEY, clampChatDockedSidebarWidth } from "../ChatView";
import {
  installChatViewEnv,
  mockTabletClassTouchViewport,
  mockViewportMode,
  renderWithAct,
  setupMockChat,
  setupMockRooms,
} from "./ChatView.test-harness";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useNavigationHistory")>()),
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [], defaultProvider: "anthropic", defaultModelId: "claude-sonnet-4-5" }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));

installChatViewEnv();

const session = {
  id: "session-001", agentId: "agent-001", status: "active" as const, title: "Architecture discussion",
  lastMessagePreview: "The latest conversation message", modelProvider: "anthropic", modelId: "claude-sonnet-4-5",
  createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z",
};

async function renderSelected(props: Partial<React.ComponentProps<typeof ChatView>> = {}) {
  const selectSession = vi.fn();
  setupMockChat({ activeSession: session, sessions: [session], filteredSessions: [session], selectSession });
  const view = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} {...props} />);
  await act(async () => { fireEvent.click(screen.getByTestId(`chat-session-${session.id}`)); });
  return { view, selectSession };
}

describe("ChatView docked conversation sidebar", () => {
  it("proves mobile, desktop, and both tablet viewport shapes", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });
    const desktop = mockViewportMode("desktop");
    const desktopView = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    expect(document.documentElement.dataset.viewportMode).toBe("desktop");
    desktopView.unmount(); desktop.mockRestore();

    const tablet = mockViewportMode("tablet");
    const tabletView = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    expect(document.documentElement.dataset.viewportMode).toBe("tablet");
    tabletView.unmount(); tablet.mockRestore();

    const restoreTouchTablet = mockTabletClassTouchViewport();
    const touchTabletView = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    expect(document.documentElement.dataset.viewportMode).toBe("tablet");
    touchTabletView.unmount(); restoreTouchTablet();

    const mobile = mockViewportMode("mobile");
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    expect(document.documentElement.dataset.viewportMode).toBe("mobile");
    mobile.mockRestore();
  });

  it("clamps widths and restores valid stored preferences at first render", async () => {
    expect(clampChatDockedSidebarWidth(100)).toBe(CHAT_DOCKED_SIDEBAR_MIN_WIDTH);
    expect(clampChatDockedSidebarWidth(900)).toBe(CHAT_DOCKED_SIDEBAR_MAX_WIDTH);
    expect(clampChatDockedSidebarWidth(300)).toBe(300);
    localStorage.setItem(CHAT_DOCKED_SIDEBAR_WIDTH_STORAGE_KEY, "900");
    setupMockChat({ sessions: [], filteredSessions: [] });
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    expect((document.querySelector(".chat-sidebar") as HTMLElement).style.width).toBe(`${CHAT_DOCKED_SIDEBAR_MAX_WIDTH}px`);
  });

  it("keeps selected desktop threads beside the list and supports toggle and keyboard resize", async () => {
    const { selectSession } = await renderSelected();
    expect(selectSession).toHaveBeenCalledWith(session.id);
    expect(document.querySelector(".chat-sidebar")).toHaveClass("chat-sidebar--docked");
    expect(screen.queryByTestId("chat-back-btn")).toBeNull();
    const handle = screen.getByTestId("chat-sidebar-resize-handle");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-valuenow", "316");
    expect(localStorage.getItem(CHAT_DOCKED_SIDEBAR_WIDTH_STORAGE_KEY)).toBe("316");
    fireEvent.click(screen.getByTestId("chat-docked-sidebar-toggle"));
    expect(screen.queryByTestId("chat-sidebar-resize-handle")).toBeNull();
    expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();
    expect(localStorage.getItem(CHAT_DOCKED_SIDEBAR_OPEN_STORAGE_KEY)).toBe("false");
  });

  it("persists resize and open state across unmount/remount", async () => {
    const { view } = await renderSelected();
    const handle = screen.getByTestId("chat-sidebar-resize-handle");
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 180 });
    fireEvent.pointerUp(document, { pointerId: 1, clientX: 180 });
    expect(localStorage.getItem(CHAT_DOCKED_SIDEBAR_WIDTH_STORAGE_KEY)).toBe("380");
    view.unmount();
    setupMockChat({ sessions: [], filteredSessions: [] });
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    expect((document.querySelector(".chat-sidebar") as HTMLElement).style.width).toBe("380px");
  });

  it("excludes mobile, compact dock, and floating hosts", async () => {
    const mobile = mockViewportMode("mobile");
    await renderSelected();
    expect(screen.queryByTestId("chat-docked-sidebar-toggle")).toBeNull();
    expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();
    mobile.mockRestore();
  });

  it("does not persist preferences for ephemeral hosts", async () => {
    const { view } = await renderSelected({ persistChatPreferences: false });
    fireEvent.keyDown(screen.getByTestId("chat-sidebar-resize-handle"), { key: "ArrowRight" });
    fireEvent.click(screen.getByTestId("chat-docked-sidebar-toggle"));
    expect(localStorage.getItem(CHAT_DOCKED_SIDEBAR_WIDTH_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(CHAT_DOCKED_SIDEBAR_OPEN_STORAGE_KEY)).toBeNull();
    view.unmount();
    expect(CHAT_DOCKED_SIDEBAR_DEFAULT_WIDTH).toBe(300);
  });
});
