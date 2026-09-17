/*
FNXC:ChatRemoteGenerationMirror 2026-09-17-18:57:
A generation started OUTSIDE this tab (another tab, an API call, an engine auto-retry) used to
stay invisible: the client received the foreign user row instantly via the bus, but the
`chat:session:updated` payload was the raw store row - `inFlightGeneration` present,
`isGenerating` absent - so the handler's `isGenerating` check never fired `attachIfGenerating`
and the transcript showed no working state until a manual reload. These cases pin both wire
versions: the enriched payload and the raw-store fallback.
*/

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api", () => ({
  fetchChatSessions: vi.fn(),
  fetchChatTags: vi.fn().mockResolvedValue({ tags: [] }),
  fetchChatSession: vi.fn(),
  createChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  updateChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  streamChatResponse: vi.fn(),
  attachChatStream: vi.fn(),
  cancelChatResponse: vi.fn(),
  fetchAgents: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../utils/projectStorage", () => ({
  getScopedItem: vi.fn(),
  setScopedItem: vi.fn(),
  removeScopedItem: vi.fn(),
  getPersistedChatOpenSession: vi.fn(),
  setPersistedChatOpenSession: vi.fn(),
  clearPersistedChatOpenSession: vi.fn(),
}));

const { sseHandlers } = vi.hoisted(() => ({
  sseHandlers: { current: {} as Record<string, (event: MessageEvent) => void> },
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn((_url: string, options: { events?: Record<string, (e: MessageEvent) => void> }) => {
    if (options?.events) sseHandlers.current = options.events;
    return () => {};
  }),
}));

import { useChat } from "../useChat";
import * as apiModule from "../../api";

const mockFetchChatSessions = vi.mocked(apiModule.fetchChatSessions);
const mockFetchChatSession = vi.mocked(apiModule.fetchChatSession);
const mockFetchChatMessages = vi.mocked(apiModule.fetchChatMessages);
const mockAttachChatStream = vi.mocked(apiModule.attachChatStream);

const GENERATING = {
  status: "generating" as const,
  streamingText: "Rozde",
  streamingThinking: "",
  toolCalls: [],
  replayFromEventId: 3,
  updatedAt: "2026-09-17T17:00:40.000Z",
  startedAt: "2026-09-17T17:00:36.000Z",
};

function sessionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "session-remote",
    agentId: "agent-001",
    status: "active",
    title: "remote",
    createdAt: "2026-09-17T17:00:00.000Z",
    updatedAt: "2026-09-17T17:00:36.000Z",
    inFlightGeneration: null,
    isGenerating: false,
    ...overrides,
  };
}

function emitSessionUpdated(row: unknown): void {
  act(() => {
    sseHandlers.current["chat:session:updated"]?.({ data: JSON.stringify(row) } as MessageEvent);
  });
}

async function renderWithOpenSession() {
  const row = sessionRow();
  mockFetchChatSessions.mockResolvedValue({ sessions: [row] } as never);
  mockFetchChatSession.mockResolvedValue({ session: row } as never);
  const rendered = renderHook(() => useChat("proj-1"));
  await waitFor(() => expect(rendered.result.current.sessions).toHaveLength(1));
  act(() => {
    rendered.result.current.selectSession("session-remote");
  });
  await waitFor(() => expect(rendered.result.current.activeSession?.id).toBe("session-remote"));
  mockAttachChatStream.mockReset();
  mockAttachChatStream.mockReturnValue({ close: vi.fn() } as never);
  return rendered;
}

describe("useChat — mirroring generations started elsewhere", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sseHandlers.current = {};
    mockFetchChatMessages.mockResolvedValue({ messages: [] } as never);
  });

  it("attaches the working stream when the event carries the enriched isGenerating flag", async () => {
    const rendered = await renderWithOpenSession();
    emitSessionUpdated(sessionRow({ inFlightGeneration: GENERATING, isGenerating: true }));
    await waitFor(() => expect(mockAttachChatStream).toHaveBeenCalledTimes(1));
    expect(mockAttachChatStream.mock.calls[0]?.[0]).toBe("session-remote");
    expect(rendered.result.current.isStreaming).toBe(true);
  });

  it("still attaches when an older server sends the raw store row without isGenerating", async () => {
    const raw = sessionRow({ inFlightGeneration: GENERATING });
    delete (raw as { isGenerating?: boolean }).isGenerating;
    await renderWithOpenSession();
    emitSessionUpdated(raw);
    await waitFor(() => expect(mockAttachChatStream).toHaveBeenCalledTimes(1));
  });

  it("does not attach for a terminal session update with no in-flight generation", async () => {
    await renderWithOpenSession();
    emitSessionUpdated(sessionRow({ inFlightGeneration: null, isGenerating: false }));
    expect(mockAttachChatStream).not.toHaveBeenCalled();
  });
});
