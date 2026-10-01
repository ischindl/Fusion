import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import {
  activeSessionFixture,
  installChatViewEnv,
  mockViewportMode,
  renderWithAct,
  setupMockChat,
  setupMockRooms,
} from "./ChatView.test-harness";
import * as apiModule from "../../api";
import type { ChatMessageInfo } from "../../hooks/useChat";
import type { Settings } from "@fusion/core";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
});
/*
FNXC:DashboardTests 2026-09-09-20:04:
Literals are inlined inside this factory on purpose: vi.mock hoists above the imports, so any
reference to harness exports here would hit the module-init-order error (same reason the
context-window test carries its own models literal). Export shapes mirror the context-window
factory exactly — ChatView consumes fetchTasks as an array and fetchChatSession as { session }.
*/
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({
    models: [
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ],
    favoriteProviders: [],
    favoriteModels: [],
    defaultProvider: "anthropic",
    defaultModelId: "claude-sonnet-4-5",
  }),
  fetchAgents: vi.fn().mockResolvedValue([
    { id: "agent-001", name: "Alpha", role: "executor", state: "idle", icon: undefined, createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z", metadata: {} },
  ]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
}));

installChatViewEnv();

/*
fetchSettings resolves the full Settings type; these tests only ever steer the two chatHandoff
fields, so the patch is asserted through Partial<Settings> once instead of faking a full object.
*/
const mockFetchSettings = vi.mocked(apiModule.fetchSettings);
function withSettings(patch: Partial<Settings>): void {
  mockFetchSettings.mockResolvedValue(patch as Settings);
}

/*
vi.clearAllMocks (inside installChatViewEnv) clears call history but NOT implementations, so a
per-test fetchSettings override would otherwise bleed into every later test in this file. Pin the
empty-settings default after the harness beforeEach; tests that need settings override it below.
*/
beforeEach(() => {
  withSettings({});
});

/*
FNXC:ChatHandoff 2026-09-09-20:04:
RUFU-199 component coverage for the threshold-gated handoff affordance and the primer notice.
Every "hidden" expectation carries its non-vacuous control: the same thread at a gateable percent
is shown by the positive tests, so a hidden button here means the GATE suppressed it, not that the
affordance never renders. Percent fixtures hang a measured contextUsage record on the LAST message
so resolveChatContextUsage's trailing estimate is 0 and the percent is exact.
*/

const CONTEXT_WINDOW = 200_000;

function assistantWithUsage(percent: number): ChatMessageInfo {
  return {
    id: "message-usage",
    sessionId: activeSessionFixture.id,
    role: "assistant",
    content: "final answer",
    createdAt: "2026-01-02T00:00:00.000Z",
    metadata: { contextUsage: { tokens: Math.round((percent / 100) * CONTEXT_WINDOW), contextWindow: CONTEXT_WINDOW } },
  };
}

const childSession = { ...activeSessionFixture, id: "child-session", title: "Continuation" };

function handoffResult(degraded = false) {
  return { session: childSession, degraded };
}

async function openThread() {
  const addToast = vi.fn();
  await renderWithAct(<ChatView projectId="project-1" addToast={addToast} />);
  await userEvent.click(screen.getByTestId("chat-session-session-001"));
  await waitFor(() => expect(document.querySelector(".chat-thread")).toBeInTheDocument());
  return addToast;
}

describe("ChatView direct-chat handoff affordance", () => {
  it("hides the affordance while measured usage stays below the default threshold", async () => {
    setupMockChat({ activeSession: activeSessionFixture, messages: [assistantWithUsage(50)] });
    setupMockRooms();
    await openThread();
    expect(screen.queryByTestId("chat-handoff-button")).toBeNull();
  });

  it("offers the handoff at the threshold and hands off the active session exactly once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const handoffSession = vi.fn().mockReturnValue(
      gate.then(() => handoffResult(false)),
    );
    setupMockChat({ activeSession: activeSessionFixture, messages: [assistantWithUsage(75)], handoffSession });
    setupMockRooms();
    const addToast = await openThread();

    const button = screen.getByTestId("chat-handoff-button");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(handoffSession).toHaveBeenCalledTimes(1);
    expect(handoffSession).toHaveBeenCalledWith("session-001");

    release();
    await waitFor(() => expect(addToast).toHaveBeenCalledWith(
      expect.stringContaining("Continued in a fresh chat"),
      "success",
    ));
  });

  it("stays hidden when the operator kill switch is off even past the threshold", async () => {
    withSettings({ chatHandoffEnabled: false });
    setupMockChat({ activeSession: activeSessionFixture, messages: [assistantWithUsage(80)] });
    setupMockRooms();
    await openThread();
    expect(screen.queryByTestId("chat-handoff-button")).toBeNull();
  });

  it("clamps a misconfigured low threshold up to the 50% floor", async () => {
    // Stored 5 would gate at 5% — clamped to 50, a 30% thread must stay hidden.
    withSettings({ chatHandoffThresholdPercent: 5 });
    setupMockChat({ activeSession: activeSessionFixture, messages: [assistantWithUsage(30)] });
    setupMockRooms();
    await openThread();
    expect(screen.queryByTestId("chat-handoff-button")).toBeNull();
  });

  it("clamps a misconfigured high threshold down to the 95% ceiling", async () => {
    // Stored 99 would gate at 99% — clamped to 95, a 96% thread must show the affordance.
    withSettings({ chatHandoffThresholdPercent: 99 });
    setupMockChat({ activeSession: activeSessionFixture, messages: [assistantWithUsage(96)] });
    setupMockRooms();
    await openThread();
    expect(screen.getByTestId("chat-handoff-button")).toBeTruthy();
  });

  it("never offers the handoff for a CLI-backed conversation", async () => {
    setupMockChat({
      activeSession: { ...activeSessionFixture, cliExecutorAdapterId: "claude-code" },
      messages: [assistantWithUsage(90)],
    });
    setupMockRooms();
    await openThread();
    expect(screen.queryByTestId("chat-handoff-button")).toBeNull();
  });

  it("never offers the handoff for a task-planner conversation", async () => {
    setupMockChat({
      activeSession: { ...activeSessionFixture, agentId: "task-planner:planning" },
      messages: [assistantWithUsage(90)],
    });
    setupMockRooms();
    await openThread();
    expect(screen.queryByTestId("chat-handoff-button")).toBeNull();
  });

  it("warns the operator when the handoff briefing came back degraded", async () => {
    const handoffSession = vi.fn().mockResolvedValue(handoffResult(true));
    setupMockChat({ activeSession: activeSessionFixture, messages: [assistantWithUsage(80)], handoffSession });
    setupMockRooms();
    const addToast = await openThread();

    fireEvent.click(screen.getByTestId("chat-handoff-button"));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith(
      expect.stringContaining("degraded"),
      "warning",
    ));
  });

  it("surfaces a route refusal verbatim instead of failing silently", async () => {
    const handoffSession = vi.fn().mockRejectedValue(new Error("A reply is still in flight in this conversation."));
    setupMockChat({ activeSession: activeSessionFixture, messages: [assistantWithUsage(80)], handoffSession });
    setupMockRooms();
    const addToast = await openThread();

    fireEvent.click(screen.getByTestId("chat-handoff-button"));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith(
      "A reply is still in flight in this conversation.",
      "error",
    ));
  });

  it("replaces the primer briefing with a lineage notice that links back to the archived source", async () => {
    const primer: ChatMessageInfo = {
      id: "message-primer",
      sessionId: activeSessionFixture.id,
      role: "system",
      content: "HANDOFF PRIMER BODY — THIS MODEL-FACING BRIEFING MUST NEVER RENDER IN THE TRANSCRIPT",
      createdAt: "2026-01-02T00:00:00.000Z",
      metadata: { handoff: { fromSessionId: "session-000", fromTitle: "Old chat", degraded: true } },
    };
    const selectSession = vi.fn();
    setupMockChat({
      activeSession: activeSessionFixture,
      messages: [primer, { ...assistantWithUsage(50), id: "message-answer" }],
      selectSession,
    });
    setupMockRooms();
    await openThread();

    const notice = screen.getByTestId("chat-message-handoff");
    expect(notice.textContent).toContain("Continues from \u201cOld chat\u201d");
    expect(screen.getByTestId("chat-handoff-notice-degraded").textContent).toContain("transcript digest");
    expect(screen.queryByText(/HANDOFF PRIMER BODY/)).toBeNull();

    fireEvent.click(screen.getByTestId("chat-handoff-notice-open"));
    expect(selectSession).toHaveBeenCalledWith("session-000");
  });

  /*
  FNXC:ChatHandoff 2026-09-09-22:10:
  RUFU-199 Surface Enumeration: the mobile breakpoint must keep the affordance reachable. The
  non-vacuous control is the desktop-threshold test above (same fixture shows the button), while
  this test additionally proves the mobile layout really suppressed the desktop-only meter chip
  (.chat-thread-header-context absent) — so the button's presence here is the header-mounted
  control doing its job, not the desktop layout leaking through. Viewport is reset in finally so
  no later test in this file inherits the phone shape.
  */
  it("keeps the affordance reachable on mobile where the meter chip is suppressed", async () => {
    mockViewportMode("mobile");
    try {
      setupMockChat({ activeSession: activeSessionFixture, messages: [assistantWithUsage(80)] });
      setupMockRooms();
      await openThread();

      expect(screen.getByTestId("chat-handoff-button")).toBeInTheDocument();
      expect(document.querySelector(".chat-thread-header-context")).toBeNull();
    } finally {
      mockViewportMode("desktop");
    }
  });

  /*
  FNXC:ChatHandoff 2026-09-09-22:10:
  RUFU-199 acceptance: no usage signal → no affordance. A thread with no contextUsage record
  resolves to an estimated usage whose percent stays null (the estimator never claims a window
  percentage), and a pending record also resolves to null — neither can cross a threshold, so the
  gate must stay closed. Non-vacuous control: the identical openThread renders the button in the
  threshold tests above with the only difference being the usage fixture.
  */
  it("never offers the handoff without a gateable usage percent", async () => {
    const noUsage = { ...assistantWithUsage(80), id: "message-no-usage", metadata: undefined };
    setupMockChat({ activeSession: activeSessionFixture, messages: [noUsage] });
    setupMockRooms();
    await openThread();

    expect(screen.queryByTestId("chat-handoff-button")).toBeNull();

    // Same thread with a pending (tokens:null) usage record — still no gateable percent.
    cleanup();
    const pendingUsage = {
      ...assistantWithUsage(80),
      id: "message-pending-usage",
      metadata: { contextUsage: { tokens: null, contextWindow: CONTEXT_WINDOW } },
    };
    setupMockChat({ activeSession: activeSessionFixture, messages: [pendingUsage] });
    setupMockRooms();
    await openThread();
    expect(screen.queryByTestId("chat-handoff-button")).toBeNull();
  });
});
