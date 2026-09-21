import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TaskPlannerChatTab } from "../TaskPlannerChatTab";

/*
FNXC:ChatRemoteGenerationMirror 2026-09-21-11:08:
RUFU-252 (Gap A). A planner generation started outside this tab — a second window, a direct API
call, an engine retry — must become visible in an already-open planner Chat tab without a reload.
These cases drive the tab's own `chat:session:updated` handler through a captured `subscribeSse`
subscription, exactly like `DesktopRightDock.integration.test.tsx` does for the dock.

Fixtures are the real `ChatInFlightGenerationState` fields and nothing else: the wire carries no
generation identifier, so the suppression under test is carried by the tab's live stream state plus
the `(sessionId, replayFromEventId)` cursor marker. A fixture that invented `generationId` would
assert a field the server never sends. That cursor marker is scoped to the attach it recorded and is
retired wherever the stream dies, because `beginGeneration` opens EVERY generation at cursor 0 and a
marker that outlived its transport would silence the tab from then on.
*/

const mocks = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  fetchTaskPlannerChatSession: vi.fn(),
  fetchChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  fetchGlobalSettings: vi.fn(),
  ensureTaskPlannerChatSession: vi.fn(),
  fetchTaskDetail: vi.fn(),
  updateChatSession: vi.fn(),
  streamChatResponse: vi.fn(),
  attachChatStream: vi.fn(),
  cancelChatResponse: vi.fn(),
  addSteeringComment: vi.fn(),
}));

type SseHandler = (event: MessageEvent) => void;
type SseOptions = { onReconnect?: () => void; events?: Record<string, SseHandler> };
type SseSubscription = { url: string; onReconnect?: () => void; events: Record<string, SseHandler> };

const sseHarness = vi.hoisted(() => ({
  subscriptions: [] as SseSubscription[],
  subscribeSse(
    url: string,
    options: SseOptions,
  ) {
    const entry = { url, onReconnect: options.onReconnect, events: options.events ?? {} };
    sseHarness.subscriptions.push(entry);
    return () => {
      const index = sseHarness.subscriptions.indexOf(entry);
      if (index >= 0) sseHarness.subscriptions.splice(index, 1);
    };
  },
}));

vi.mock("../../sse-bus", () => ({ subscribeSse: (url: string, options: SseOptions) => sseHarness.subscribeSse(url, options) }));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  ...mocks,
}));
vi.mock("../../hooks/useModelsCache", () => ({
  useModelsCache: () => ({ models: [], favoriteProviders: [], favoriteModels: [], refresh: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("../../hooks/useFavorites", () => ({
  useFavorites: () => ({ availableModels: [], favoriteProviders: [], favoriteModels: [], providerInstances: {}, toggleFavoriteProvider: vi.fn(), toggleFavoriteModel: vi.fn() }),
}));
vi.mock("../../hooks/useVoiceDictation", () => ({
  useVoiceDictation: () => ({ enabled: false, supported: false, state: "idle", partialText: "", finalText: "", error: undefined, start: vi.fn(), stop: vi.fn() }),
}));
vi.mock("../CustomModelDropdown", () => ({ CustomModelDropdown: () => null }));
vi.mock("../ChatFocusSelector", () => ({ ChatFocusSelector: () => null }));

const PROJECT_ID = "proj-rufu252";
const task = {
  id: "FN-2520",
  description: "Mirror a foreign planner generation",
  column: "todo",
  dependencies: [],
  steps: [],
  currentStep: 0,
  createdAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
};

/** Planner session resolved idle — the state the tab is in when the foreign generation starts elsewhere. */
const idlePlannerSession = {
  id: "planner-chat-remote",
  agentId: "task-planner:FN-2520",
  title: "Planner chat",
  status: "active",
  projectId: null,
  createdAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
  cliSessionFile: null,
  cliExecutorAdapterId: null,
  inFlightGeneration: null,
};

/** A real `ChatInFlightGenerationState` row — no invented fields. */
function inFlightGeneration(overrides: Record<string, unknown> = {}) {
  return {
    status: "generating",
    streamingText: "",
    streamingThinking: "",
    toolCalls: [],
    replayFromEventId: 7,
    updatedAt: "2026-09-21T11:08:00.000Z",
    startedAt: "2026-09-21T11:07:50.000Z",
    ...overrides,
  };
}

function generatingFrame(payloadOverrides: Record<string, unknown> = {}, generationOverrides: Record<string, unknown> = {}) {
  return {
    id: idlePlannerSession.id,
    isGenerating: true,
    inFlightGeneration: inFlightGeneration(generationOverrides),
    ...payloadOverrides,
  };
}

function renderPlanner(overrides: Record<string, unknown> = {}) {
  return render(
    <TaskPlannerChatTab
      task={task as never}
      active
      projectId={PROJECT_ID}
      taskChatModel={{ provider: "anthropic", modelId: "claude" }}
      addToast={vi.fn()}
      {...overrides}
    />,
  );
}

/*
Only the planner tab subscribes to the project-scoped `/api/events` channel; other surfaces in the
same tree (e.g. the chat-snippets cache) use the bare `/api/events` URL, so the exact URL is what
isolates this component's channel from theirs.
*/
const PLANNER_SSE_URL = `/api/events?projectId=${PROJECT_ID}`;

function plannerSubscriptions(): SseSubscription[] {
  return sseHarness.subscriptions.filter((entry) => entry.url === PLANNER_SSE_URL);
}

function plannerSubscription(): SseSubscription {
  const [subscription] = plannerSubscriptions();
  if (!subscription) throw new Error(`planner chat did not subscribe to ${PLANNER_SSE_URL}`);
  return subscription;
}

function emitFrame(payload: unknown) {
  const handler = plannerSubscription().events["chat:session:updated"];
  expect(typeof handler).toBe("function");
  act(() => {
    handler(new MessageEvent("chat:session:updated", { data: JSON.stringify(payload) }));
  });
}

function streamingRow() {
  return screen.queryByTestId("chat-message-__streaming__");
}

/** Handlers the tab handed to `attachChatStream` for its Nth attach (0-based). */
function attachedHandlers(index = 0) {
  const call = mocks.attachChatStream.mock.calls[index];
  if (!call) throw new Error(`attachChatStream was not called ${index + 1} time(s)`);
  return call[1] as { onDone: (data: { messageId: string }) => void };
}

async function renderAndWaitForSession() {
  renderPlanner();
  await waitFor(() => expect(mocks.fetchTaskPlannerChatSession).toHaveBeenCalledWith(task.id, expect.anything(), PROJECT_ID));
  await waitFor(() => expect(mocks.fetchChatSession).toHaveBeenCalledWith(idlePlannerSession.id, PROJECT_ID));
}

describe("TaskPlannerChatTab remote generation mirror", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sseHarness.subscriptions.length = 0;
    mocks.fetchSettings.mockResolvedValue({});
    mocks.fetchGlobalSettings.mockResolvedValue({ chatSnippets: [] });
    mocks.fetchTaskPlannerChatSession.mockResolvedValue({ session: idlePlannerSession });
    mocks.fetchChatSession.mockResolvedValue({ session: idlePlannerSession });
    mocks.ensureTaskPlannerChatSession.mockResolvedValue({ session: idlePlannerSession });
    mocks.fetchChatMessages.mockResolvedValue({ messages: [] });
    mocks.fetchTaskDetail.mockResolvedValue(task);
    mocks.updateChatSession.mockResolvedValue({ session: idlePlannerSession });
    mocks.streamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });
    mocks.attachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });
    mocks.cancelChatResponse.mockResolvedValue({ success: true, interrupted: false });
  });

  it("subscribes while active and declares onReconnect (SSE-resync ratchet)", async () => {
    await renderAndWaitForSession();
    const subscription = plannerSubscription();
    expect(typeof subscription.onReconnect).toBe("function");
    expect(typeof subscription.events["chat:session:updated"]).toBe("function");
    expect(mocks.attachChatStream).not.toHaveBeenCalled();
    expect(streamingRow()).toBeNull();
  });

  it("attaches a foreign generation once at its replay cursor and renders the working state", async () => {
    await renderAndWaitForSession();
    emitFrame(generatingFrame());
    expect(mocks.attachChatStream).toHaveBeenCalledTimes(1);
    expect(mocks.attachChatStream).toHaveBeenCalledWith(
      idlePlannerSession.id,
      expect.anything(),
      PROJECT_ID,
      { lastEventId: 7 },
    );
    await waitFor(() => expect(streamingRow()).not.toBeNull());
  });

  it("mirrors an unenriched frame that carries only inFlightGeneration.status", async () => {
    await renderAndWaitForSession();
    const enriched = generatingFrame();
    // What a store emit without the SSE enrichment delivers: the raw row, no `isGenerating` field.
    emitFrame({ id: enriched.id, inFlightGeneration: enriched.inFlightGeneration });
    expect(mocks.attachChatStream).toHaveBeenCalledTimes(1);
    expect(mocks.attachChatStream).toHaveBeenCalledWith(idlePlannerSession.id, expect.anything(), PROJECT_ID, { lastEventId: 7 });
  });

  // The anti-loop guard for the generation that is CURRENT: while its stream is live, neither a frame
  // replayed by the per-event fan-out nor an advanced cursor may start a second transport.
  it("attaches exactly once for the identical frame and for an advanced cursor of the same generation", async () => {
    await renderAndWaitForSession();
    emitFrame(generatingFrame());
    emitFrame(generatingFrame());
    emitFrame(generatingFrame({}, { replayFromEventId: 8 }));
    expect(mocks.attachChatStream).toHaveBeenCalledTimes(1);
  });

  /*
  FNXC:ChatRemoteGenerationMirror 2026-09-21-19:19:
  RUFU-252 (Code Review remediation, P0). The earlier expectation of this file — "a cursor whose
  stream already ended must never re-attach" — pinned the retention bug instead of the invariant:
  the server stamps `replayFromEventId: 0` on the in-flight row that OPENS every generation
  (`packages/dashboard/src/chat.ts` `beginGeneration`), and a generation with no >=200 ms delta gap
  emits only that cursor-0 frame plus its terminal frame (the intermediate checkpoints go through
  the debounced queue the completion flush cancels). So a marker that survived the end of its stream
  suppressed EVERY later foreign generation in the same open tab — the exact idle-looking-tab symptom
  this task exists to kill. The loop guard for the generation that is still current is the live
  `streamRef` state (pinned by the case above); the marker must therefore die with its stream,
  exactly as `useChat` clears it in its attached stream's `onDone`/`onError`.
  */
  it("attaches every successive foreign generation after its own attached stream completed", async () => {
    await renderAndWaitForSession();
    // Generation 1 is observed mid-stream, so the tab adopts an advanced cursor.
    emitFrame(generatingFrame());
    expect(mocks.attachChatStream).toHaveBeenCalledTimes(1);
    act(() => {
      attachedHandlers(0).onDone({ messageId: "assistant-1" });
    });
    // Generation 2 opens at the cursor `beginGeneration` always seeds, 0 — the mismatch direction.
    emitFrame(generatingFrame({}, { replayFromEventId: 0, startedAt: "2026-09-21T11:12:00.000Z" }));
    expect(mocks.attachChatStream).toHaveBeenCalledTimes(2);
    expect(mocks.attachChatStream).toHaveBeenLastCalledWith(
      idlePlannerSession.id,
      expect.anything(),
      PROJECT_ID,
      { lastEventId: 0 },
    );
    await waitFor(() => expect(streamingRow()).not.toBeNull());
    act(() => {
      attachedHandlers(1).onDone({ messageId: "assistant-2" });
    });
    /*
    Generation 3 opens at the SAME cursor this tab last attached for — a generation with no
    >=200 ms delta gap emits nothing but this cursor-0 frame and its terminal frame, because the
    debounced checkpoint queue is cancelled by the completion flush. A marker that outlived its
    stream would suppress every generation from here on.
    */
    emitFrame(generatingFrame({}, { replayFromEventId: 0, startedAt: "2026-09-21T11:13:00.000Z" }));
    expect(mocks.attachChatStream).toHaveBeenCalledTimes(3);
    expect(mocks.attachChatStream).toHaveBeenLastCalledWith(
      idlePlannerSession.id,
      expect.anything(),
      PROJECT_ID,
      { lastEventId: 0 },
    );
  });

  it("attaches a new foreign generation that opens at cursor 0 after a terminal frame detached a cursor-0 attach", async () => {
    mocks.attachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });
    await renderAndWaitForSession();
    // The realistic first contact with a foreign generation: the frame that opened it, at cursor 0.
    emitFrame(generatingFrame({}, { replayFromEventId: 0 }));
    expect(mocks.attachChatStream).toHaveBeenCalledTimes(1);
    // The realistic server order: the session row is flushed to null before `done` is broadcast.
    emitFrame({ id: idlePlannerSession.id, isGenerating: false, inFlightGeneration: null });
    await waitFor(() => expect(streamingRow()).toBeNull());
    emitFrame(generatingFrame({}, { replayFromEventId: 0, startedAt: "2026-09-21T11:15:00.000Z" }));
    expect(mocks.attachChatStream).toHaveBeenCalledTimes(2);
    expect(mocks.attachChatStream).toHaveBeenLastCalledWith(
      idlePlannerSession.id,
      expect.anything(),
      PROJECT_ID,
      { lastEventId: 0 },
    );
  });

  it("closes the stream and drops the working state on a terminal frame", async () => {
    const handle = { close: vi.fn(), isConnected: () => true };
    mocks.attachChatStream.mockReturnValue(handle);
    await renderAndWaitForSession();
    emitFrame(generatingFrame());
    await waitFor(() => expect(streamingRow()).not.toBeNull());
    emitFrame({ id: idlePlannerSession.id, isGenerating: false, inFlightGeneration: null });
    expect(handle.close).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(streamingRow()).toBeNull());
    expect(mocks.attachChatStream).toHaveBeenCalledTimes(1);
  });

  /*
  FNXC:ChatRemoteGenerationMirror 2026-09-21-19:19:
  RUFU-252 (Code Review remediation, P1). The terminal frame must retire only the transport the
  mirror itself opened. The server persists the cleared in-flight row (`chat:session:updated`) before
  it broadcasts `done`, so a frame-path close that also caught a locally-started send would bump
  `streamRequestRef` out from under that send's own `onDone`, skipping its queued-message dispatch and
  replacing the persisted-row append with a transcript reload. `useChat` never closes a stream from
  its frame path either — only its authoritative reconcile does.
  */
  it("leaves a locally-started send to its own completion when a terminal frame arrives", async () => {
    const localHandle = { close: vi.fn(), isConnected: () => true };
    mocks.streamChatResponse.mockReturnValue(localHandle);
    await renderAndWaitForSession();
    fireEvent.change(screen.getByRole("textbox", { name: "Message task chat" }), { target: { value: "hello from this tab" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.streamChatResponse).toHaveBeenCalledTimes(1));

    emitFrame({ id: idlePlannerSession.id, isGenerating: false, inFlightGeneration: null });
    // The frame path must not touch a stream it does not own, and must not invent an attach.
    expect(localHandle.close).not.toHaveBeenCalled();
    expect(mocks.attachChatStream).not.toHaveBeenCalled();

    // The send's own completion still retires the working state.
    const localHandlers = mocks.streamChatResponse.mock.calls[0][2] as { onDone: (data: { messageId: string }) => void };
    act(() => {
      localHandlers.onDone({ messageId: "assistant-local" });
    });
    await waitFor(() => expect(streamingRow()).toBeNull());
  });

  it("still closes a locally-started stream when the authoritative probe says the server is idle", async () => {
    const localHandle = { close: vi.fn(), isConnected: () => true };
    mocks.streamChatResponse.mockReturnValue(localHandle);
    await renderAndWaitForSession();
    fireEvent.change(screen.getByRole("textbox", { name: "Message task chat" }), { target: { value: "hello from this tab" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.streamChatResponse).toHaveBeenCalledTimes(1));

    act(() => {
      plannerSubscription().onReconnect?.();
    });
    // The reconcile path re-probes the row, finds the server idle, and closes the dead transport.
    await waitFor(() => expect(localHandle.close).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(streamingRow()).toBeNull());
  });

  it("ignores a frame for another session", async () => {
    await renderAndWaitForSession();
    emitFrame(generatingFrame({ id: "some-other-session" }));
    emitFrame({ id: idlePlannerSession.id, isGenerating: false, inFlightGeneration: null });
    expect(mocks.attachChatStream).not.toHaveBeenCalled();
    expect(streamingRow()).toBeNull();
  });

  it("ignores frames while no planner session has resolved", async () => {
    mocks.fetchTaskPlannerChatSession.mockResolvedValue({ session: null });
    mocks.fetchChatMessages.mockResolvedValue({ messages: [] });
    renderPlanner();
    await waitFor(() => expect(plannerSubscriptions().length).toBe(1));
    emitFrame(generatingFrame());
    emitFrame(generatingFrame({ id: undefined }));
    expect(mocks.attachChatStream).not.toHaveBeenCalled();
  });

  it("keeps the mirror in the expanded (drawer) variant", async () => {
    renderPlanner({ expanded: true, onExpandedChange: vi.fn() });
    await waitFor(() => expect(mocks.fetchChatSession).toHaveBeenCalledWith(idlePlannerSession.id, PROJECT_ID));
    expect(typeof plannerSubscription().onReconnect).toBe("function");
    emitFrame(generatingFrame());
    expect(mocks.attachChatStream).toHaveBeenCalledTimes(1);
  });

  it("re-attaches on reconnect when the authoritative row is generating with no live stream", async () => {
    await renderAndWaitForSession();
    mocks.fetchChatSession.mockResolvedValue({
      session: { ...idlePlannerSession, isGenerating: true, inFlightGeneration: inFlightGeneration({ replayFromEventId: 42 }) },
    });
    act(() => {
      plannerSubscription().onReconnect?.();
    });
    await waitFor(() => expect(mocks.attachChatStream).toHaveBeenCalledTimes(1));
    expect(mocks.attachChatStream).toHaveBeenCalledWith(idlePlannerSession.id, expect.anything(), PROJECT_ID, { lastEventId: 42 });
  });

  it("closes a provably dead stream when the authoritative row says the server is idle", async () => {
    const handle = { close: vi.fn(), isConnected: () => true };
    mocks.attachChatStream.mockReturnValue(handle);
    await renderAndWaitForSession();
    emitFrame(generatingFrame());
    expect(handle.close).not.toHaveBeenCalled();
    act(() => {
      plannerSubscription().onReconnect?.();
    });
    await waitFor(() => expect(handle.close).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(streamingRow()).toBeNull());
  });

  it("unsubscribes when the tab is deactivated", async () => {
    const view = render(<TaskPlannerChatTab
      task={task as never}
      active
      projectId={PROJECT_ID}
      taskChatModel={{ provider: "anthropic", modelId: "claude" }}
      addToast={vi.fn()}
    />);
    await waitFor(() => expect(plannerSubscriptions().length).toBe(1));
    view.rerender(<TaskPlannerChatTab
      task={task as never}
      active={false}
      projectId={PROJECT_ID}
      taskChatModel={{ provider: "anthropic", modelId: "claude" }}
      addToast={vi.fn()}
    />);
    await waitFor(() => expect(plannerSubscriptions().length).toBe(0));
  });

  it("re-binds one channel and the cursor marker when the task changes", async () => {
    const otherTask = { ...task, id: "FN-2521" };
    const otherSession = { ...idlePlannerSession, id: "planner-chat-other", agentId: "task-planner:FN-2521" };
    mocks.fetchTaskPlannerChatSession.mockImplementation(async (taskId: string) => ({
      session: taskId === task.id ? idlePlannerSession : otherSession,
    }));
    const view = renderPlanner();
    await waitFor(() => expect(mocks.fetchChatSession).toHaveBeenCalledWith(idlePlannerSession.id, PROJECT_ID));

    view.rerender(
      <TaskPlannerChatTab
        task={otherTask as never}
        active
        projectId={PROJECT_ID}
        taskChatModel={{ provider: "anthropic", modelId: "claude" }}
        addToast={vi.fn()}
      />,
    );
    await waitFor(() => expect(mocks.fetchChatSession).toHaveBeenCalledWith(otherSession.id, PROJECT_ID));
    // Exactly one channel survives the switch, and it is scoped to the same project.
    expect(plannerSubscriptions().length).toBe(1);

    // Frames for the previous task's session are inert; the new session mirrors normally.
    emitFrame(generatingFrame());
    expect(mocks.attachChatStream).not.toHaveBeenCalled();
    emitFrame({ id: otherSession.id, isGenerating: true, inFlightGeneration: inFlightGeneration({ replayFromEventId: 11 }) });
    expect(mocks.attachChatStream).toHaveBeenCalledTimes(1);
    expect(mocks.attachChatStream).toHaveBeenCalledWith(otherSession.id, expect.anything(), PROJECT_ID, { lastEventId: 11 });
  });
});
