import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ArtifactWithTask } from "@fusion/core";
import { fetchArtifacts } from "../../api";
import { subscribeSse } from "../../sse-bus";
import { useArtifacts } from "../useArtifacts";
import { message } from "./sseTestHelpers";
import { clearTraces, getTraces } from "../../utils/dashboardTraceBuffer";

const { handlers, unsubscribeMock } = vi.hoisted(() => ({
  handlers: {} as Record<string, (event: MessageEvent) => void>,
  unsubscribeMock: vi.fn(),
}));

vi.mock("../../api", () => ({
  fetchArtifacts: vi.fn(),
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn((_url: string, opts: { events: Record<string, (event: MessageEvent) => void> }) => {
    Object.assign(handlers, opts.events);
    return unsubscribeMock;
  }),
}));

const mockFetchArtifacts = vi.mocked(fetchArtifacts);
const mockSubscribeSse = vi.mocked(subscribeSse);

const mockArtifacts: ArtifactWithTask[] = [
  {
    id: "artifact-1",
    type: "image",
    title: "Screenshot",
    authorId: "agent-1",
    authorType: "agent",
    taskId: "FN-1",
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
  },
];

const newTaskArtifact: ArtifactWithTask = {
  id: "artifact-2",
  type: "document",
  title: "Live note",
  authorId: "agent-2",
  authorType: "agent",
  taskId: "FN-1",
  createdAt: "2026-06-27T00:00:00.000Z",
  updatedAt: "2026-06-27T00:00:00.000Z",
};

const loadInitialArtifacts = async () => {
  await act(async () => {
    await vi.runAllTimersAsync();
  });
};

const fireArtifactRegistration = async (
  eventName: "artifact:registered" | "artifact:retracted" | "message:received" | "message:sent",
  payload: object,
) => {
  act(() => {
    handlers[eventName]?.(message(payload));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
};

describe("useArtifacts", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.localStorage.clear();
    clearTraces();
    for (const key of Object.keys(handlers)) delete handlers[key];
    unsubscribeMock.mockClear();
    mockFetchArtifacts.mockResolvedValue(mockArtifacts);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("loads artifacts on initial mount", async () => {
    const { result } = renderHook(() => useArtifacts({ projectId: "project-1" }));

    expect(result.current.loading).toBe(true);
    expect(result.current.artifacts).toEqual([]);

    await loadInitialArtifacts();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.artifacts).toEqual(mockArtifacts);
    expect(mockFetchArtifacts).toHaveBeenCalledWith({ q: undefined, includeRetracted: false }, "project-1");
  });

  /*
  FNXC:ArtifactRetraction 2026-11-11-12:27 (RUFU-433): the two assertions above now state `includeRetracted: false`
  rather than omitting it, because the default IS the behaviour worth pinning: a hook that silently defaulted to
  true would undo the hiding on whichever surface forgot to pass it. This test pins the opted-in direction and the
  cache separation, which is the part that fails silently - sharing one cache key across the two views makes the
  toggle look broken whenever a cached list is still fresh.
  */
  it("carries includeRetracted to the fetch and keeps the opted-in view off the hidden view's cache key", async () => {
    const { result, rerender } = renderHook(
      ({ includeRetracted }) => useArtifacts({ projectId: "project-9", includeRetracted }),
      { initialProps: { includeRetracted: false } },
    );

    await loadInitialArtifacts();
    expect(mockFetchArtifacts).toHaveBeenLastCalledWith({ q: undefined, includeRetracted: false }, "project-9");

    rerender({ includeRetracted: true });
    await loadInitialArtifacts();

    await waitFor(() => {
      expect(mockFetchArtifacts).toHaveBeenLastCalledWith({ q: undefined, includeRetracted: true }, "project-9");
    });
    expect(result.current.loading).toBe(false);
  });

  it("propagates filter parameters to fetchArtifacts", async () => {
    renderHook(() => useArtifacts({
      projectId: "project-2",
      type: "video",
      authorId: "agent-video",
      taskId: "FN-2",
      searchQuery: "demo",
    }));

    await loadInitialArtifacts();

    expect(mockFetchArtifacts).toHaveBeenCalledWith({
      type: "video",
      authorId: "agent-video",
      taskId: "FN-2",
      q: "demo",
      includeRetracted: false,
    }, "project-2");
  });

  it("debounces search query changes", async () => {
    const { rerender } = renderHook(
      ({ searchQuery }) => useArtifacts({ projectId: "project-3", searchQuery }),
      { initialProps: { searchQuery: undefined as string | undefined } },
    );

    await loadInitialArtifacts();

    mockFetchArtifacts.mockClear();
    rerender({ searchQuery: "alpha" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(mockFetchArtifacts).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    await waitFor(() => {
      expect(mockFetchArtifacts).toHaveBeenCalledWith({ q: "alpha", includeRetracted: false }, "project-3");
    });
  });

  it("surfaces errors without clearing existing artifacts", async () => {
    mockFetchArtifacts.mockResolvedValueOnce(mockArtifacts);
    const { result } = renderHook(() => useArtifacts({ projectId: "project-4" }));

    await loadInitialArtifacts();
    await waitFor(() => expect(result.current.artifacts).toEqual(mockArtifacts));

    mockFetchArtifacts.mockRejectedValueOnce(new Error("Artifacts failed"));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBe("Artifacts failed");
    expect(result.current.artifacts).toEqual(mockArtifacts);
  });

  it("refreshes artifacts on demand", async () => {
    const { result } = renderHook(() => useArtifacts({ projectId: "project-5" }));

    await loadInitialArtifacts();
    mockFetchArtifacts.mockClear();

    await act(async () => {
      await result.current.refresh();
    });

    expect(mockFetchArtifacts).toHaveBeenCalledTimes(1);
    expect(mockFetchArtifacts).toHaveBeenCalledWith({ q: undefined, includeRetracted: false }, "project-5");
  });

  it("refreshes task-scoped artifacts when a matching artifact registration arrives", async () => {
    mockFetchArtifacts.mockResolvedValue([]);
    const { result } = renderHook(() => useArtifacts({ projectId: "project-6", taskId: "FN-1" }));

    await loadInitialArtifacts();
    await waitFor(() => expect(result.current.artifacts).toEqual([]));

    mockFetchArtifacts.mockClear();
    mockFetchArtifacts.mockResolvedValue([newTaskArtifact]);

    await fireArtifactRegistration("message:received", {
      metadata: { artifactId: newTaskArtifact.id, taskId: "FN-1" },
    });

    await waitFor(() => expect(mockFetchArtifacts).toHaveBeenCalledTimes(1));
    expect(mockFetchArtifacts).toHaveBeenCalledWith({ taskId: "FN-1", q: undefined, includeRetracted: false }, "project-6");
    await waitFor(() => expect(result.current.artifacts).toEqual([newTaskArtifact]));
  });

  it("does not refresh task-scoped artifacts for a different task", async () => {
    renderHook(() => useArtifacts({ projectId: "project-7", taskId: "FN-1" }));

    await loadInitialArtifacts();
    mockFetchArtifacts.mockClear();

    await fireArtifactRegistration("message:received", {
      metadata: { artifactId: "artifact-other", taskId: "FN-2" },
    });

    expect(mockFetchArtifacts).toHaveBeenCalledTimes(0);
  });

  it("refreshes task-scoped artifacts from the authoritative artifact registration event", async () => {
    mockFetchArtifacts.mockResolvedValue([]);
    const { result } = renderHook(() => useArtifacts({ projectId: "project-8a", taskId: "FN-1" }));

    await loadInitialArtifacts();
    await waitFor(() => expect(result.current.artifacts).toEqual([]));

    mockFetchArtifacts.mockClear();
    mockFetchArtifacts.mockResolvedValue([newTaskArtifact]);

    await fireArtifactRegistration("artifact:registered", {
      id: newTaskArtifact.id,
      taskId: "FN-1",
    });

    await waitFor(() => expect(mockFetchArtifacts).toHaveBeenCalledTimes(1));
    expect(mockFetchArtifacts).toHaveBeenCalledWith({ taskId: "FN-1", q: undefined, includeRetracted: false }, "project-8a");
    await waitFor(() => expect(result.current.artifacts).toEqual([newTaskArtifact]));
  });

  it("refreshes project-scoped artifacts when any artifact registration arrives", async () => {
    const updatedArtifacts = [...mockArtifacts, newTaskArtifact];
    const { result } = renderHook(() => useArtifacts({ projectId: "project-8" }));

    await loadInitialArtifacts();
    await waitFor(() => expect(result.current.artifacts).toEqual(mockArtifacts));

    mockFetchArtifacts.mockClear();
    mockFetchArtifacts.mockResolvedValue(updatedArtifacts);

    await fireArtifactRegistration("message:sent", {
      projectId: "project-8",
      metadata: { artifactId: newTaskArtifact.id, taskId: "FN-1" },
    });

    await waitFor(() => expect(mockFetchArtifacts).toHaveBeenCalledTimes(1));
    expect(mockFetchArtifacts).toHaveBeenCalledWith({ q: undefined, includeRetracted: false }, "project-8");
    await waitFor(() => expect(result.current.artifacts).toEqual(updatedArtifacts));
  });

  it("does not refresh project-scoped artifacts when the payload projectId mismatches", async () => {
    renderHook(() => useArtifacts({ projectId: "project-9" }));

    await loadInitialArtifacts();
    mockFetchArtifacts.mockClear();

    await fireArtifactRegistration("message:received", {
      projectId: "project-other",
      metadata: { artifactId: "artifact-other", taskId: "FN-1" },
    });

    expect(mockFetchArtifacts).toHaveBeenCalledTimes(0);
  });

  it("ignores non-artifact messages", async () => {
    renderHook(() => useArtifacts({ projectId: "project-10" }));

    await loadInitialArtifacts();
    mockFetchArtifacts.mockClear();

    await fireArtifactRegistration("message:received", {
      id: "message-not-artifact",
      metadata: { taskId: "FN-1" },
    });

    expect(mockFetchArtifacts).toHaveBeenCalledTimes(0);
  });

  it("ignores malformed message payloads", async () => {
    renderHook(() => useArtifacts({ projectId: "project-11" }));

    await loadInitialArtifacts();
    mockFetchArtifacts.mockClear();

    act(() => {
      handlers["message:received"]?.({ data: "not-json" } as MessageEvent);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(mockFetchArtifacts).toHaveBeenCalledTimes(0);
  });

  it("coalesces duplicate sent and received artifact events into one refresh", async () => {
    renderHook(() => useArtifacts({ projectId: "project-12", taskId: "FN-1" }));

    await loadInitialArtifacts();
    mockFetchArtifacts.mockClear();

    act(() => {
      const event = message({ metadata: { artifactId: "artifact-duplicate", taskId: "FN-1" } });
      handlers["message:received"]?.(event);
      handlers["message:sent"]?.(event);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    await waitFor(() => expect(mockFetchArtifacts).toHaveBeenCalledTimes(1));
  });

  it("drops a late artifact response after the active project switches", async () => {
    const { result, rerender } = renderHook(
      ({ projectId }) => useArtifacts({ projectId }),
      { initialProps: { projectId: "project-a" } },
    );
    await loadInitialArtifacts();
    await waitFor(() => expect(result.current.artifacts).toEqual(mockArtifacts));

    let resolveOldRequest!: (value: ArtifactWithTask[]) => void;
    mockFetchArtifacts.mockImplementationOnce(() => new Promise((resolve) => {
      resolveOldRequest = resolve;
    }));
    void result.current.refresh();
    rerender({ projectId: "project-b" });

    await act(async () => {
      resolveOldRequest([{ ...mockArtifacts[0], id: "project-a-artifact" }]);
    });

    expect(result.current.artifacts).not.toContainEqual(expect.objectContaining({ id: "project-a-artifact" }));
    expect(getTraces()).toContainEqual(expect.objectContaining({ source: "useArtifacts", event: "dropped-stale-event" }));
  });

  it("drops a late artifact rejection after the active project switches", async () => {
    const { result, rerender } = renderHook(
      ({ projectId }) => useArtifacts({ projectId }),
      { initialProps: { projectId: "project-a" } },
    );
    await loadInitialArtifacts();

    let rejectOldRequest!: (reason: Error) => void;
    mockFetchArtifacts.mockImplementationOnce(() => new Promise((_, reject) => {
      rejectOldRequest = reject;
    }));
    void result.current.refresh();
    rerender({ projectId: "project-b" });

    await act(async () => {
      rejectOldRequest(new Error("project-a failure"));
    });

    expect(result.current.error).toBeNull();
    expect(getTraces()).toContainEqual(expect.objectContaining({ source: "useArtifacts", event: "dropped-stale-event" }));
  });

  it("subscribes to project-scoped artifact registration events and unsubscribes on unmount", async () => {
    const { unmount } = renderHook(() => useArtifacts({ projectId: "project-13" }));

    expect(mockSubscribeSse).toHaveBeenCalledWith("/api/events?projectId=project-13", {
      events: expect.objectContaining({
        "artifact:registered": expect.any(Function),
        /*
         * FNXC:ArtifactRetraction 2026-11-11-15:12 (RUFU-433): the subscription has to be asserted, not just
         * written. The retraction shipped once with the store emitting the event and this hook listening for
         * it while `sse.ts` never forwarded it, which left the listener a dead control - so the shape
         * assertion here is what keeps the client half of that three-layer wire from silently disappearing.
         */
        "artifact:retracted": expect.any(Function),
        "message:received": expect.any(Function),
        "message:sent": expect.any(Function),
      }),
      // FNXC:ArtifactRegistry 2026-07-26-15:52: the subscription must also carry the sse-bus
      // missed-event resync (onReconnect); assert it rather than letting the shape drift.
      onReconnect: expect.any(Function),
    });

    unmount();

    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  /*
   * FNXC:ArtifactRegistry 2026-07-10-00:00:
   * The operator-visible "Artifacts tab always shows 0" repro was a single-project/default-scope dashboard mount where no currentProject id was threaded into useArtifacts. The server's real /api/artifacts route listed the agent-created image, but the hook short-circuited before fetch/SSE, so the artifact consumer rendered a permanent 0 count.
   */
  it("fetches and subscribes to the default artifact scope when no projectId is available", async () => {
    const { result } = renderHook(() => useArtifacts());

    expect(result.current.loading).toBe(true);

    await loadInitialArtifacts();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.artifacts).toEqual(mockArtifacts);
    expect(mockFetchArtifacts).toHaveBeenCalledWith({ q: undefined, includeRetracted: false }, undefined);
    expect(mockSubscribeSse).toHaveBeenCalledWith("/api/events", {
      events: expect.objectContaining({
        "artifact:registered": expect.any(Function),
        "message:received": expect.any(Function),
        "message:sent": expect.any(Function),
      }),
      // FNXC:ArtifactRegistry 2026-07-26-15:52: the subscription must also carry the sse-bus
      // missed-event resync (onReconnect); assert it rather than letting the shape drift.
      onReconnect: expect.any(Function),
    });
  });

  it("refreshes default-scope artifacts when an unscoped artifact registration arrives", async () => {
    const updatedArtifacts = [...mockArtifacts, newTaskArtifact];
    const { result } = renderHook(() => useArtifacts());

    await loadInitialArtifacts();
    await waitFor(() => expect(result.current.artifacts).toEqual(mockArtifacts));

    mockFetchArtifacts.mockClear();
    mockFetchArtifacts.mockResolvedValue(updatedArtifacts);

    await fireArtifactRegistration("artifact:registered", {
      id: newTaskArtifact.id,
      taskId: "FN-1",
    });

    await waitFor(() => expect(mockFetchArtifacts).toHaveBeenCalledTimes(1));
    expect(mockFetchArtifacts).toHaveBeenCalledWith({ q: undefined, includeRetracted: false }, undefined);
    await waitFor(() => expect(result.current.artifacts).toEqual(updatedArtifacts));
  });

  /*
   * FNXC:ArtifactRetraction 2026-11-11-15:12 (RUFU-433): the symptom this case owns is an operator reading a
   * gallery that no longer matches the registry. A retraction moves no card, writes no task row and changes no
   * verdict, so there is no `task:updated` for the view to piggyback on: the retraction event is the only
   * automated notice it ever gets. Without a listener the false review artifact stays on screen as a live tile
   * - i.e. as live merge-grade input for whoever is deciding the merge - until somebody reloads the page.
   */
  it("drops a retracted artifact from an already-open gallery without a reload", async () => {
    const { result } = renderHook(() => useArtifacts());

    await loadInitialArtifacts();
    await waitFor(() => expect(result.current.artifacts).toEqual(mockArtifacts));

    mockFetchArtifacts.mockClear();
    // The default read hides VOID rows, so the post-retraction list is empty rather than tombstoned.
    mockFetchArtifacts.mockResolvedValue([]);

    await fireArtifactRegistration("artifact:retracted", {
      id: "artifact-1",
      taskId: "FN-1",
      retractedAt: "2026-11-11T15:00:00.000Z",
    });

    await waitFor(() => expect(mockFetchArtifacts).toHaveBeenCalledTimes(1));
    expect(mockFetchArtifacts).toHaveBeenCalledWith({ q: undefined, includeRetracted: false }, undefined);
    await waitFor(() => expect(result.current.artifacts).toEqual([]));
  });
});
