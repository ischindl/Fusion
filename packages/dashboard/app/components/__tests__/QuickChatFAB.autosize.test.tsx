import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QuickChatFAB, clampQuickChatInputHeight } from "../QuickChatFAB";

vi.mock("../../api", () => ({
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchModels: vi.fn().mockResolvedValue({
    models: [],
    favoriteProviders: [],
    favoriteModels: [],
    defaultProvider: "",
    defaultModelId: "",
  }),
}));

vi.mock("../../hooks/useQuickChat", () => ({
  FN_AGENT_ID: "__fn_agent__",
  useQuickChat: vi.fn(() => ({
    activeSession: { id: "session-1", agentId: "agent-1", modelProvider: null, modelId: null },
    messages: [],
    isStreaming: false,
    streamingText: "",
    streamingThinking: null,
    streamingToolCalls: [],
    sessions: [],
    sessionsLoading: false,
    messagesLoading: false,
    sendMessage: vi.fn(),
    stopStreaming: vi.fn(),
    pendingMessage: "",
    clearPendingMessage: vi.fn(),
    switchSession: vi.fn(),
    selectSession: vi.fn(),
    startModelChat: vi.fn(),
    startFreshSession: vi.fn(),
    refreshSessions: vi.fn(),
    skipNextSessionInitRef: { current: false },
  })),
}));

vi.mock("../../hooks/useAgents", () => ({
  useAgents: vi.fn(() => ({
    agents: [{ id: "agent-1", name: "Agent One", role: "executor", state: "active" }],
    activeAgents: [{ id: "agent-1", name: "Agent One", role: "executor", state: "active" }],
    stats: null,
    isLoading: false,
    loadAgents: vi.fn(),
    loadStats: vi.fn(),
  })),
}));

vi.mock("../../hooks/useFileMention", () => ({
  useFileMention: vi.fn(() => ({
    mentionActive: false,
    files: [],
    selectedIndex: 0,
    detectMention: vi.fn(),
    dismissMention: vi.fn(),
    handleKeyDown: vi.fn(),
    selectFile: vi.fn((file: { path?: string }, text: string) => `${text}${file.path ?? ""}`),
    selectHighlighted: vi.fn(),
    closeMention: vi.fn(),
    openMention: vi.fn(),
    hasResults: false,
    isLoading: false,
    query: "",
  })),
}));

vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: vi.fn(() => ({
    keyboardOverlap: 0,
    viewportHeight: null,
    viewportOffsetTop: 0,
    keyboardOpen: false,
  })),
}));

vi.mock("../../hooks/useViewportMode", () => ({
  useViewportMode: vi.fn(() => "desktop"),
}));

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => children,
}));

const quickChatCss = readFileSync(resolve(__dirname, "../QuickChatFAB.css"), "utf8");

describe("QuickChatFAB autosize", () => {
  it("keeps textarea CSS min/max height aligned with autosize contract", () => {
    const textareaRule = quickChatCss.match(/\.quick-chat-textarea\s*\{[^}]*\}/);

    expect(textareaRule).not.toBeNull();
    expect(textareaRule?.[0]).toContain("max-height: 320px");
    expect(textareaRule?.[0]).toContain("min-height: 40px");
  });

  it("clamps composer heights to the expected floor and cap", () => {
    expect(clampQuickChatInputHeight(600)).toBe(320);
    expect(clampQuickChatInputHeight(80)).toBe(80);
    expect(clampQuickChatInputHeight(20)).toBe(40);
  });

  it("renders quick chat input as textarea and assigns a px height while typing", () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" open />);

    const input = screen.getByTestId("quick-chat-input");
    Object.defineProperty(input, "scrollHeight", {
      configurable: true,
      get: () => 96,
    });

    fireEvent.change(input, { target: { value: "line 1\nline 2" } });

    expect(input.tagName).toBe("TEXTAREA");
    expect((input as HTMLTextAreaElement).style.height).toMatch(/^\d+px$/);
  });
});
