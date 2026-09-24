import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { ChatView } from "../ChatView";
import type { ChatSessionInfo } from "../../hooks/useChat";
import { CHAT_IN_FLIGHT_GENERATION_STALE_MS } from "@fusion/core/chat-liveness";
import {
  activeSessionFixture,
  installChatViewEnv,
  mockViewportMode,
  renderWithAct,
  setupMockChat,
  setupMockRooms,
} from "./ChatView.test-harness";

/*
FNXC:ChatSidebarLiveness 2026-09-24-06:21 (RUFU-220):
Symptom verification for "a chat generation that died leaves the sidebar silent". Before this change
an in-flight claim owned by a dead process was invisible: the row looked exactly like an idle
conversation, and the only truth about it lived in the engine's reclaim sweep. These cases render the
REAL sidebar rows and pin the contract the operator can see:

- which of the two states shows, including the case where the client's optimistic `isGenerating`
  flag must lose to a provably old durable claim;
- the sweep's floor boundary, driven by moving the faked clock against a FIXED `startedAt` — the
  only way to prove the tag and the sweeper share one threshold rather than two similar numbers;
- that a row without a claim renders no tag at all (the non-vacuous control for every positive case);
- that the tag is presentational, and that the row's existing affordances survive it.

`Date` is the only faked primitive: the classifier reads wall-clock, which is exactly what makes this
boundary drivable. `performance` is never faked, and the liveness path never reads it.
*/

const { pushNav } = vi.hoisted(() => ({ pushNav: vi.fn() }));

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useChatUnread", () => ({
  useChatUnread: () => ({ isUnread: () => false, markRead: vi.fn() }),
}));
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useNavigationHistory")>()),
  useNavigationHistoryContext: () => ({ pushNav, replaceCurrent: vi.fn() }),
}));
vi.mock("../CustomModelDropdown", () => ({ CustomModelDropdown: () => null }));
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));

installChatViewEnv();

const GENERATING_LABEL = "Generating";
const STALE_LABEL = "Stale — waiting for reclaim";
/** Fixed claim start; every boundary is expressed by moving the CLOCK, never the fixture. */
const CLAIM_START = "2026-09-23T11:00:00.000Z";
const CLAIM_START_MS = Date.parse(CLAIM_START);
const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(CLAIM_START_MS + MINUTE);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

type ClaimShape = ChatSessionInfo["inFlightGeneration"];

function row(
  id: string,
  overrides: Partial<ChatSessionInfo> = {},
  claim: ClaimShape | undefined = undefined,
): ChatSessionInfo {
  return {
    ...activeSessionFixture,
    id,
    title: `Conversation ${id}`,
    updatedAt: new Date(CLAIM_START_MS + MINUTE).toISOString(),
    inFlightGeneration: claim,
    ...overrides,
  } as ChatSessionInfo;
}

function claimOf(overrides: Record<string, unknown> = {}): ClaimShape {
  return { status: "generating", startedAt: CLAIM_START, ...overrides } as ClaimShape;
}

async function renderRows(sessions: ChatSessionInfo[]) {
  setupMockRooms();
  setupMockChat({ activeSession: null, sessions, filteredSessions: sessions });
  return renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
}

function tag(id: string): HTMLElement {
  return screen.getByTestId(`chat-session-liveness-${id}`);
}

describe("ChatView sidebar liveness indicator — the two states", () => {
  it("labels a live in-flight generation Generating", async () => {
    // REST-shaped row: the list endpoint sends `inFlightGeneration` and never `isGenerating`, so the
    // tag must not depend on a field only the SSE mirror carries.
    await renderRows([row("live", {}, claimOf())]);

    expect(tag("live")).toHaveTextContent(GENERATING_LABEL);
    expect(tag("live")).toHaveClass("chat-session-liveness--generating");
  });

  it("labels a claim older than the shared floor as stale, and hides the generating label", async () => {
    await renderRows([row("dead", {}, claimOf({ startedAt: new Date(CLAIM_START_MS - 90 * MINUTE).toISOString() }))]);

    expect(tag("dead")).toHaveTextContent(STALE_LABEL);
    expect(tag("dead")).toHaveClass("chat-session-liveness--stale");
    expect(screen.queryByText(GENERATING_LABEL)).toBeNull();
  });

  it("lets the proven age outrank the client's optimistic generating flag", async () => {
    // The symptom reproduction: the client still believes it is streaming while the server's claim
    // has been ownerless for an hour. The durable claim decides, or the tag hides the wedge.
    await renderRows([
      row("wedged", { isGenerating: true }, claimOf({ startedAt: new Date(CLAIM_START_MS - 60 * MINUTE).toISOString() })),
    ]);

    expect(tag("wedged")).toHaveTextContent(STALE_LABEL);
    expect(screen.queryByText(GENERATING_LABEL)).toBeNull();
  });

  it("renders no tag for a row with no in-flight claim, while still rendering the row", async () => {
    // Non-vacuous control for every positive case above: the row exists, so an absent tag cannot be
    // explained by a list that never rendered. An idle conversation looks exactly as it did before.
    await renderRows([row("idle")]);

    expect(screen.getByTestId("chat-session-idle")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-session-liveness-idle")).toBeNull();
    expect(screen.queryAllByTestId(/^chat-session-liveness-/)).toHaveLength(0);
  });

  it("resolves each row independently in a mixed list", async () => {
    await renderRows([
      row("a", {}, claimOf()),
      row("b", {}, claimOf({ startedAt: new Date(CLAIM_START_MS - 31 * MINUTE).toISOString() })),
      row("c"),
    ]);

    expect(tag("a")).toHaveTextContent(GENERATING_LABEL);
    expect(tag("b")).toHaveTextContent(STALE_LABEL);
    expect(screen.queryByTestId("chat-session-liveness-c")).toBeNull();
  });
});

describe("ChatView sidebar liveness indicator — the shared floor boundary", () => {
  // The age is measured when the row renders, so each clock move is followed by the re-render a list
  // refresh would cause. The tag tracks the conversation list rather than counting down live, which
  // is deliberate: a per-second tick would be a timer per row for a state that changes rarely.
  async function moveClockAndRerender(view: { rerender: (ui: ReactElement) => void }, atMs: number) {
    vi.setSystemTime(atMs);
    await act(async () => {
      view.rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    });
  }

  it("holds the sweep's inclusivity: the floor itself is live, one millisecond past it is stale", async () => {
    // `startedAt` stays fixed and the clock moves, so this is the same comparison the reclaim sweep
    // performs against the same constant — not a dashboard-side approximation of it.
    const view = await renderRows([row("boundary", {}, claimOf())]);

    await moveClockAndRerender(view, CLAIM_START_MS + CHAT_IN_FLIGHT_GENERATION_STALE_MS);
    expect(tag("boundary")).toHaveTextContent(GENERATING_LABEL);

    await moveClockAndRerender(view, CLAIM_START_MS + CHAT_IN_FLIGHT_GENERATION_STALE_MS + 1);
    expect(tag("boundary")).toHaveTextContent(STALE_LABEL);
  });

  it("matches the reclaim sweep's 29-minute / 31-minute pair", async () => {
    const view = await renderRows([row("pair", {}, claimOf())]);

    await moveClockAndRerender(view, CLAIM_START_MS + 29 * MINUTE);
    expect(tag("pair")).toHaveTextContent(GENERATING_LABEL);

    await moveClockAndRerender(view, CLAIM_START_MS + 31 * MINUTE);
    expect(tag("pair")).toHaveTextContent(STALE_LABEL);
  });

  it("treats a future-dated claim as live, never stale", async () => {
    // Clock skew makes the age negative, which the sweep also skips. An accusation needs a real age.
    await renderRows([row("skewed", {}, claimOf({ startedAt: new Date(CLAIM_START_MS + 60 * MINUTE).toISOString() }))]);

    expect(tag("skewed")).toHaveTextContent(GENERATING_LABEL);
  });
});

describe("ChatView sidebar liveness indicator — legacy and unprovable rows", () => {
  it("ages a pre-timestamp claim by the row's updatedAt", async () => {
    const legacy = (overrides: Record<string, unknown> = {}) => claimOf({ startedAt: undefined, ...overrides });

    await renderRows([
      row("fresh-legacy", { updatedAt: CLAIM_START }, legacy()),
      row("old-legacy", { updatedAt: new Date(CLAIM_START_MS - 45 * MINUTE).toISOString() }, legacy()),
    ]);

    expect(tag("fresh-legacy")).toHaveTextContent(GENERATING_LABEL);
    expect(tag("old-legacy")).toHaveTextContent(STALE_LABEL);
  });

  it("renders nothing when no timestamp is readable and the client is not generating", async () => {
    await renderRows([
      row("unreadable", { updatedAt: "" }, claimOf({ startedAt: "not-a-date" })),
    ]);

    expect(screen.getByTestId("chat-session-unreadable")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-session-liveness-unreadable")).toBeNull();
  });

  it("says Generating — not Stale — when the age is unreadable but the client is streaming", async () => {
    await renderRows([
      row("unreadable-live", { updatedAt: "", isGenerating: true }, claimOf({ startedAt: "not-a-date" })),
    ]);

    expect(tag("unreadable-live")).toHaveTextContent(GENERATING_LABEL);
  });
});

describe("ChatView sidebar liveness indicator — reclaim and boundaries", () => {
  it("loses the tag once the sweeper clears the claim and the list re-syncs", async () => {
    // The disappearance is the sweeper's event: it clears the durable claim, the row re-syncs without
    // it, and the classifier declines the row. No client-side clear is involved.
    const staleSession = row("reclaimed", {}, claimOf({ startedAt: new Date(CLAIM_START_MS - 45 * MINUTE).toISOString() }));
    setupMockRooms();
    setupMockChat({ activeSession: null, sessions: [staleSession], filteredSessions: [staleSession] });
    const { rerender } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    expect(tag("reclaimed")).toHaveTextContent(STALE_LABEL);

    // The list re-syncs with the claim cleared — exactly what the sweep's write produces downstream.
    const cleared = { ...staleSession, inFlightGeneration: null } as ChatSessionInfo;
    setupMockChat({ activeSession: null, sessions: [cleared], filteredSessions: [cleared] });
    await act(async () => {
      rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    });

    expect(screen.queryByTestId("chat-session-liveness-reclaimed")).toBeNull();
    expect(screen.getByTestId("chat-session-reclaimed")).toBeInTheDocument();
  });

  it("rides the filtered (search-result) list exactly like the browse list", async () => {
    // The sidebar renders `filteredSessions` only, so a search narrows the rows without changing the
    // render site. Pins that a search hit is never a plain title row and a filtered-away row leaves
    // no orphaned tag behind.
    setupMockRooms();
    setupMockChat({
      activeSession: null,
      sessions: [row("hidden", {}, claimOf({ startedAt: new Date(CLAIM_START_MS - 45 * MINUTE).toISOString() })), row("hit", {}, claimOf())],
      filteredSessions: [row("hit", {}, claimOf())],
    });
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(tag("hit")).toHaveTextContent(GENERATING_LABEL);
    expect(screen.queryByTestId("chat-session-hidden")).toBeNull();
    expect(screen.queryAllByTestId(/^chat-session-liveness-/)).toHaveLength(1);
  });

  it.each(["desktop", "tablet", "mobile"] as const)(
    "shows the tag at the %s breakpoint without displacing the row's other affordances",
    async (viewport) => {
      mockViewportMode(viewport);
      await renderRows([row("kept", {}, claimOf({ startedAt: new Date(CLAIM_START_MS - 45 * MINUTE).toISOString() }))]);

      expect(tag("kept")).toHaveTextContent(STALE_LABEL);
      // The row's existing affordances survive the new chip — the tag is additive, not a replacement.
      expect(screen.getByTestId("chat-session-menu-btn")).toBeInTheDocument();
      expect(screen.getByText("Conversation kept")).toBeInTheDocument();
      expect(tag("kept")).toHaveAttribute("title", expect.stringContaining(String(Math.round(CHAT_IN_FLIGHT_GENERATION_STALE_MS / MINUTE))));
    },
  );

  it("adds no click target of its own and inherits the row's selection behaviour", async () => {
    await renderRows([row("clickme", {}, claimOf())]);

    const element = tag("clickme");
    // Presentational, not a control: a nested button would steal row width and become a second target
    // whose behaviour differs from the row it sits in.
    expect(element.tagName).toBe("SPAN");
    expect(element.closest("button")).toBeNull();

    const rowElement = screen.getByTestId("chat-session-clickme");
    const onRowClick = vi.fn();
    rowElement.addEventListener("click", onRowClick);
    fireEvent.click(element);
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it("renders no sidebar rows at all in a popped-out conversation window", async () => {
    // Dedicated windows mount ChatView without the conversation list, so the new tag cannot appear
    // there. Pinning the boundary is cheaper than assuming it.
    setupMockRooms();
    const popped = row("popped", {}, claimOf({ startedAt: new Date(CLAIM_START_MS - 45 * MINUTE).toISOString() }));
    setupMockChat({ activeSession: popped, sessions: [popped], filteredSessions: [] });
    await renderWithAct(
      <ChatView projectId="proj-123" addToast={vi.fn()} dedicatedConversation persistChatPreferences={false} />,
    );

    expect(document.querySelector(".view-sidebar")).toBeNull();
    expect(screen.queryAllByTestId(/^chat-session-liveness-/)).toHaveLength(0);
  });
});
