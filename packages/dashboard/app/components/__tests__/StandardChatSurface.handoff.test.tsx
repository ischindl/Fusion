import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageInfo } from "../../hooks/chatTypes";
import { StandardChatMessageItem } from "../StandardChatSurface";
import { installChatViewEnv } from "./ChatView.test-harness";

/*
FNXC:ChatHandoff 2026-09-09-22:05:
RUFU-199 component coverage for the handoff primer notice. A handoff child's role:"system"
row carries the model-facing briefing in `content` and its lineage in `metadata.handoff`;
the transcript must render a compact "Continues from …" notice (role="note",
data-testid="chat-message-handoff") with a deep link back to the archived source, and must
NEVER leak the raw briefing text into the UI. The lineage branch keys on `metadata.handoff`
only, so the notice, its deep link, and the degraded label must render IDENTICALLY before
and after the first turn stamps the top-level `handoffDeliveredAt` scalar — the post-send
reload is the state an operator actually lives in. Ordinary rows (non-handoff system,
assistant, user) keep their current rendering untouched. The mock i18n `t` returns the
fallback string, so assertions match the English fallback copy.
*/

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return { ...actual, useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) };
});

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  /*
  FNXC:ChatHandoff 2026-09-09-22:20:
  Fallback-returning `t` (same convention as the budgetExhausted coverage) plus {{var}}
  interpolation, because the handoff notice embeds the source title in its copy
  ("Continues from “{{title}}”") and the assertion must see the interpolated title.
  */
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: unknown, options?: Record<string, unknown>) => {
        let text = typeof fallback === "string" ? fallback : key;
        if (options) {
          for (const [name, value] of Object.entries(options)) text = text.replaceAll(`{{${name}}}`, String(value));
        }
        return text;
      },
    }),
  };
});

// The shared harness resolves its `vi.mocked` handles against this file's own hoisted
// mock of ../../api (see ChatView.test-harness.tsx), so the factory must exist here.
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchSettings: vi.fn().mockResolvedValue({}),
    fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [], defaultProvider: null, defaultModelId: null }),
    fetchAgents: vi.fn().mockResolvedValue([]),
    fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
    fetchTasks: vi.fn().mockResolvedValue([]),
    searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  };
});

installChatViewEnv();

const PRIMER_BODY = "PRIMER BODY — decisions: chose X. Open questions: Y. Files touched: chat.ts. Conclusions: Z.";

function primerMessage(deliveredAt?: string): ChatMessageInfo {
  return {
    id: "primer-1",
    sessionId: "child-session",
    role: "system",
    content: PRIMER_BODY,
    createdAt: "2026-09-09T00:00:00.000Z",
    metadata: {
      handoff: { fromSessionId: "source-session", fromTitle: "Long investigation", degraded: false },
      ...(deliveredAt ? { handoffDeliveredAt: deliveredAt } : {}),
    },
  };
}

function renderMessage(overrides: Partial<ChatMessageInfo>, onHandoffSourceOpen?: (id: string) => void) {
  return render(
    <StandardChatMessageItem
      message={{
        id: "message-1",
        sessionId: "session-1",
        role: "assistant",
        content: "",
        createdAt: "2026-09-09T00:00:00.000Z",
        ...overrides,
      }}
      forcePlain={false}
      agentName="Assistant"
      hideAssistantIdentity={false}
      showAssistantModelTag={false}
      activeModelTag={null}
      activeModelProvider={null}
      activeSessionId="session-1"
      onHandoffSourceOpen={onHandoffSourceOpen}
    />,
  );
}

describe("StandardChatSurface handoff primer notice", () => {
  afterEach(() => cleanup());

  it("renders the notice with the source title and no raw briefing text", () => {
    renderMessage(primerMessage());

    const notice = screen.getByTestId("chat-message-handoff");
    expect(notice).toHaveAttribute("role", "note");
    expect(notice.textContent).toContain("Continues from");
    expect(notice.textContent).toContain("Long investigation");
    // The model-facing briefing must never render raw in the transcript.
    expect(screen.queryByText(PRIMER_BODY)).not.toBeInTheDocument();
    expect(notice.textContent).not.toContain("PRIMER BODY");
  });

  it("deep-links back to the archived source session", () => {
    const onOpen = vi.fn();
    renderMessage(primerMessage(), onOpen);

    fireEvent.click(screen.getByTestId("chat-handoff-notice-open"));
    expect(onOpen).toHaveBeenCalledWith("source-session");
  });

  it("renders the degraded label only for a degraded lineage", () => {
    const { unmount } = renderMessage(primerMessage());
    expect(screen.queryByTestId("chat-handoff-notice-degraded")).not.toBeInTheDocument();
    unmount();

    renderMessage({
      ...primerMessage(),
      metadata: { handoff: { fromSessionId: "source-session", fromTitle: "Long investigation", degraded: true } },
    });
    expect(screen.getByTestId("chat-handoff-notice-degraded").textContent).toContain("transcript digest");
  });

  it("keeps notice, deep link, and degraded label rendering after handoffDeliveredAt is stamped", () => {
    const onOpen = vi.fn();
    renderMessage(
      {
        ...primerMessage(),
        metadata: {
          handoff: { fromSessionId: "source-session", fromTitle: "Long investigation", degraded: true },
          handoffDeliveredAt: "2026-09-09T00:05:00.000Z",
        },
      },
      onOpen,
    );

    // The branch keys on the lineage object only: the stamped post-send row renders identically.
    const notice = screen.getByTestId("chat-message-handoff");
    expect(notice.textContent).toContain("Continues from");
    expect(notice.textContent).toContain("Long investigation");
    expect(notice.textContent).not.toContain("PRIMER BODY");
    expect(screen.getByTestId("chat-handoff-notice-degraded")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("chat-handoff-notice-open"));
    expect(onOpen).toHaveBeenCalledWith("source-session");
  });

  it("renders an ordinary system row (no lineage) as plain content, untouched", () => {
    renderMessage({ role: "system", content: "A plain system note." });

    expect(screen.queryByTestId("chat-message-handoff")).not.toBeInTheDocument();
    expect(screen.getByText("A plain system note.")).toBeInTheDocument();
  });

  it("renders malformed lineage defensively (no crash, falls back to plain content)", () => {
    renderMessage({ role: "system", content: "Weird row.", metadata: { handoff: { fromTitle: "no id" } } });

    expect(screen.queryByTestId("chat-message-handoff")).not.toBeInTheDocument();
    expect(screen.getByText("Weird row.")).toBeInTheDocument();
  });

  it("leaves user and assistant rows unchanged", () => {
    const { unmount } = renderMessage({ role: "user", content: "hello there" });
    expect(screen.queryByTestId("chat-message-handoff")).not.toBeInTheDocument();
    expect(screen.getByText("hello there")).toBeInTheDocument();
    unmount();

    renderMessage({ role: "assistant", content: "general kenobi" });
    expect(screen.queryByTestId("chat-message-handoff")).not.toBeInTheDocument();
    expect(screen.getByText("general kenobi")).toBeInTheDocument();
  });
});
