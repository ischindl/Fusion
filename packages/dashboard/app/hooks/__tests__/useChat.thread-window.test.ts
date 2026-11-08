/*
FNXC:ChatThreadPagination 2026-11-08-10:19:
RUFU-871 Slice A. The production measurement that motivated this slice: one real thread answered
326 556 B for 13 messages (~25 kB per rendered assistant row, individual rows of 107 kB / 68 kB /
57 kB), while the client asked for a 50-row window — so opening a dense thread could move well
over a megabyte. These tests pin the contract, never latency:
- the exact request URL for the opening window and for the older page;
- transferred bytes for one opened chat on one fixture, as a number;
- the cache/window merge: a cached transcript plus a freshly fetched window must not duplicate,
  must not lose already-loaded older rows, and must not let the window overwrite rows it never
  fetched;
- an exhausted history stops announcing more pages.
The real `fetchChatMessages` runs here (only the transport is stubbed), so the asserted URLs are the
URLs the server would actually receive.
*/
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatSession } from "@fusion/core";
import { useChat } from "../useChat";
import * as apiModule from "../../api";
import * as projectStorageModule from "../../utils/projectStorage";
import * as swrCacheModule from "../../utils/swrCache";
import { SWR_CACHE_KEYS } from "../../utils/swrCache";

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchChatSessions: vi.fn(),
    fetchChatTags: vi.fn().mockResolvedValue({ tags: [] }),
    fetchChatSession: vi.fn(),
    createChatSession: vi.fn(),
    handoffChatSession: vi.fn(),
    updateChatSession: vi.fn(),
    deleteChatSession: vi.fn(),
    streamChatResponse: vi.fn(),
    attachChatStream: vi.fn(),
    cancelChatResponse: vi.fn(),
    fetchAgents: vi.fn().mockResolvedValue([]),
  };
});
vi.mock("../../utils/projectStorage", () => ({
  getScopedItem: vi.fn(),
  setScopedItem: vi.fn(),
  removeScopedItem: vi.fn(),
  getPersistedChatOpenSession: vi.fn(),
  setPersistedChatOpenSession: vi.fn(),
  clearPersistedChatOpenSession: vi.fn(),
}));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => {}) }));

const mockFetchChatSessions = vi.mocked(apiModule.fetchChatSessions);
const mockFetchChatSession = vi.mocked(apiModule.fetchChatSession);

const PROJECT_ID = "proj-871";
const SESSION_ID = "sess-871";
/** The window the client must now ask for. Pinned here so a silent change fails loudly. */
const WINDOW_SIZE = 20;

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: SESSION_ID,
    agentId: "agent-001",
    status: "active",
    title: "Thread",
    projectId: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    createdAt: "2026-04-08T00:00:00.000Z",
    updatedAt: "2026-04-08T00:00:00.000Z",
    pinnedAt: null,
    tags: [],
    memoryFocus: null,
    cliSessionFile: null,
    cliExecutorAdapterId: null,
    inFlightGeneration: null,
    ...overrides,
  };
}

/*
One fixture, fixed-width content, so every byte assertion below is a literal number rather than a
"smaller than" hand-wave. 108 characters of body per row mirrors the measured shape (many rows,
each far too large) without importing 25 kB x 45 into the repo.
*/
const ROW_CONTENT = "r".repeat(108);

function makeThread(count: number): ChatMessage[] {
  const base = Date.UTC(2026, 3, 8, 0, 0, 0);
  return Array.from({ length: count }, (_, index) => ({
    id: `msg-${String(index).padStart(3, "0")}`,
    sessionId: SESSION_ID,
    role: (index % 2 === 0 ? "user" : "assistant") as ChatMessage["role"],
    content: `#${String(index).padStart(3, "0")} ${ROW_CONTENT}`,
    thinkingOutput: null,
    metadata: null,
    attachments: [],
    createdAt: new Date(base + index * 1000).toISOString(),
  })) as ChatMessage[];
}

interface ThreadServer {
  requests: string[];
  responseBytes: number[];
}

/** Minimal stand-in for GET /api/chat/sessions/:id/messages honouring the real query params. */
function installThreadServer(messages: ChatMessage[]): ThreadServer {
  const server: ThreadServer = { requests: [], responseBytes: [] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    server.requests.push(url);
    const parsed = new URL(url, "http://localhost");
    const limit = Number(parsed.searchParams.get("limit") ?? "50");
    const before = parsed.searchParams.get("before");
    const beforeId = parsed.searchParams.get("beforeId");
    const desc = [...messages].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
    let start = 0;
    if (before) {
      start = desc.findIndex(
        (row) => row.createdAt < before || (row.createdAt === before && row.id < String(beforeId)),
      );
      if (start < 0) start = desc.length;
    }
    const body = JSON.stringify({ messages: desc.slice(start, start + limit) });
    server.responseBytes.push(new TextEncoder().encode(body).length);
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  });
  return server;
}

function threadQuery(url: string): string {
  const parsed = new URL(url, "http://localhost");
  parsed.searchParams.delete("projectId");
  return `${parsed.pathname}?${parsed.searchParams.toString()}`;
}

function messagesCacheKey(sessionId = SESSION_ID): string {
  return `${SWR_CACHE_KEYS.CHAT_MESSAGES_PREFIX}${PROJECT_ID}:${sessionId}`;
}

function readCachedThread(): ChatMessage[] {
  const raw = localStorage.getItem(messagesCacheKey());
  if (!raw) return [];
  return (JSON.parse(raw) as { data: ChatMessage[] }).data ?? [];
}

async function openThread(history: ChatMessage[]) {
  const server = installThreadServer(history);
  const session = makeSession();
  mockFetchChatSessions.mockResolvedValue({ sessions: [session], taskChatsVisibleInCommonFeed: false });
  mockFetchChatSession.mockResolvedValue({ session });
  const rendered = renderHook(() => useChat(PROJECT_ID, vi.fn()));
  await waitFor(() => expect(rendered.result.current.sessions).toHaveLength(1));
  await act(async () => {
    rendered.result.current.selectSession(SESSION_ID, session);
  });
  await waitFor(() => expect(rendered.result.current.messages.length).toBeGreaterThan(0));
  return { ...rendered, server };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(projectStorageModule.getPersistedChatOpenSession).mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useChat bounded thread window (RUFU-871 Slice A)", () => {
  it("opens a thread with exactly the bounded window URL and transfers fewer bytes than the 50-row window", async () => {
    const history = makeThread(45);
    const { result, server } = await openThread(history);

    const openRequest = server.requests.find((url) => url.includes("/messages"));
    expect(openRequest).toBeDefined();
    expect(threadQuery(String(openRequest))).toBe(
      `/api/chat/sessions/${SESSION_ID}/messages?limit=${WINDOW_SIZE}&order=desc`,
    );

    // Newest 20 of the same fixture is the whole transfer for one opened chat.
    const openedBytes = server.responseBytes[server.requests.indexOf(String(openRequest))];
    const expectedWindowBytes = new TextEncoder().encode(
      JSON.stringify({ messages: [...history].reverse().slice(0, WINDOW_SIZE) }),
    ).length;
    expect(openedBytes).toBe(expectedWindowBytes);

    // The previous client asked for 50 of these 45 rows, i.e. the entire thread.
    const previousWindowBytes = new TextEncoder().encode(
      JSON.stringify({ messages: [...history].reverse() }),
    ).length;
    expect(previousWindowBytes).toBeGreaterThan(openedBytes);
    expect(openedBytes).toBeLessThanOrEqual(previousWindowBytes / 2);

    expect(result.current.messages).toHaveLength(WINDOW_SIZE);
    expect(result.current.messages.at(-1)?.id).toBe("msg-044");
    expect(result.current.hasMoreMessages).toBe(true);
  });

  it("loads older messages with the exact before-cursor URL and keeps hasMore honest at the end", async () => {
    const history = makeThread(45);
    const { result, server } = await openThread(history);

    await act(async () => {
      await result.current.loadMoreMessages();
    });

    const olderRequest = server.requests.at(-1);
    expect(threadQuery(String(olderRequest))).toBe(
      "/api/chat/sessions/"
      + `${SESSION_ID}/messages?limit=${WINDOW_SIZE}`
      + "&before=2026-04-08T00%3A00%3A25.000Z&beforeId=msg-025&order=desc",
    );
    await waitFor(() => expect(result.current.messages).toHaveLength(40));
    expect(new Set(result.current.messages.map((message) => message.id)).size).toBe(40);

    // Two more pages: history is exhausted, so the affordance must switch off rather than keep loading.
    await act(async () => { await result.current.loadMoreMessages(); });
    await act(async () => { await result.current.loadMoreMessages(); });
    await waitFor(() => expect(result.current.hasMoreMessages).toBe(false));
    expect(result.current.messages).toHaveLength(45);
    expect(result.current.messages[0]?.id).toBe("msg-000");
    expect(server.requests.filter((url) => url.includes("/messages"))).toHaveLength(3);
  });

  it("merges a re-fetched window over the cached transcript without duplicating or dropping loaded older rows", async () => {
    const history = makeThread(45);
    const { result, server } = await openThread(history);
    await act(async () => { await result.current.loadMoreMessages(); });
    await waitFor(() => expect(result.current.messages).toHaveLength(40));

    const cachedBeforeMerge = readCachedThread();
    expect(cachedBeforeMerge).toHaveLength(40);
    expect(cachedBeforeMerge[0]?.id).toBe("msg-005");

    // Re-selecting the same session forces a non-paginated window reload: the window covers only
    // rows 25..44, so rows older than that must survive from cache/memory.
    await act(async () => {
      result.current.selectSession(SESSION_ID, makeSession({ title: "Thread" }));
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(40));

    const ids = result.current.messages.map((message) => message.id);
    expect(new Set(ids).size).toBe(40);
    expect(ids[0]).toBe("msg-005");
    expect(ids.at(-1)).toBe("msg-044");
    // Only the two pages plus the two window reloads — no page was re-fetched to rebuild state.
    expect(server.requests.filter((url) => url.includes("/messages"))).toHaveLength(3);
  });

  it("widens the opening window until a content-search hit is inside the loaded transcript", async () => {
    const history = makeThread(45);
    const matched = history[3];
    const server = installThreadServer(history);
    const session = makeSession({
      matchedMessagePreview: `${matched.content.slice(0, 101)}…`,
    } as Partial<ChatSession>);
    mockFetchChatSessions.mockResolvedValue({ sessions: [session], taskChatsVisibleInCommonFeed: false });
    mockFetchChatSession.mockResolvedValue({ session });

    const rendered = renderHook(() => useChat(PROJECT_ID, vi.fn()));
    await waitFor(() => expect(rendered.result.current.sessions).toHaveLength(1));
    await act(async () => {
      rendered.result.current.selectSession(SESSION_ID, session);
    });

    await waitFor(() => expect(rendered.result.current.matchedSearchMessageId).toBe(matched.id));
    const messageRequests = server.requests.filter((url) => url.includes("/messages"));
    expect(threadQuery(messageRequests[0])).toBe(
      `/api/chat/sessions/${SESSION_ID}/messages?limit=${WINDOW_SIZE}&order=desc`,
    );
    expect(threadQuery(messageRequests[1])).toContain(`limit=${WINDOW_SIZE}&before=`);
    expect(messageRequests).toHaveLength(3);
    expect(rendered.result.current.messages.some((message) => message.id === matched.id)).toBe(true);
  });
});
