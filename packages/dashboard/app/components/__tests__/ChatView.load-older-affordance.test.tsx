/*
FNXC:ChatThreadPagination 2026-11-08-10:19:
RUFU-871 Slice A.2/A.3 — the "Load older messages" affordance and the scroll contract it must not
break. Opening a thread now fetches a 20-row window (measured: one real thread answered
326 556 B for 13 messages), so older history becomes a visible control rather than only the
IntersectionObserver trigger.

The scroll assertion is deliberately geometric, per the repo rule that shallow event assertions
cannot catch this class of bug: `offsetTop`/`offsetHeight` are made live over the CURRENT row
order, so a prepended page really does push every existing row down, and the test then requires the
reader's anchor row to (a) still be the same DOM node and (b) sit at the same pixel offset from the
viewport top it occupied before the page arrived.

FNXC:ChatThreadPagination 2026-11-08-12:04 (RUFU-871, slice A review):
The first test originally asserted `document.querySelectorAll(".chat-message").length >
initialPage.length - 1`, i.e. that every loaded row is mounted. `.chat-messages` is virtualized
(`useVirtualizedChatTranscript` -> `useVirtualizedList`: 640px viewport / 112px row estimate /
1 viewport overscan), so it mounts only the viewport window — measured 12 rows for 50 loaded, and
still 12 for 53. That assertion was therefore unsatisfiable by any correct product code AND blind:
it returned 12 whether an older page prepends, replaces, or never merges, so it could not have
caught the bug it was written for. It is replaced by the tail-window / duplicate-key / exact-growth
assertions below, which are the observables that actually move when the merge or the prepend anchor
breaks. The data-level merge contract (union by id, chronological order, no loss of loaded older
rows) is asserted where that code runs — `hooks/__tests__/useChat.thread-window.test.ts` — and is
deliberately not duplicated here, because this file automocks `useChat` and would only be asserting
its own mock.
*/
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ChatMessage } from "@fusion/core";
import { ChatView } from "../ChatView";
import {
  activeSessionFixture,
  defaultChatState,
  installChatViewEnv,
  mockUseChat,
  mockViewportMode,
  renderWithAct,
  setupMockRooms,
} from "./ChatView.test-harness";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
/*
FNXC:ChatThreadPagination 2026-11-08-11:53 (RUFU-871):
`useChatUnread` and `CustomModelDropdown` must stay mocked here, exactly as every other ChatView test mocks
them (see `ChatView.active-gating.test.tsx:16-22`). Without the unread mock the component subscribes to a
live unread feed that never settles under jsdom, and the file hung for 420 s producing zero test results
while the sibling hook-level window test finished in 8,94 s on the same host — so the hang was the missing
mock, not host load. `CustomModelDropdown` is mocked only to keep the module graph off the test path.
*/
vi.mock("../../hooks/useChatUnread", () => ({
  useChatUnread: () => ({ isUnread: () => false, markRead: vi.fn() }),
}));
vi.mock("../CustomModelDropdown", () => ({ CustomModelDropdown: () => null }));
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return { ...actual, useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn(), removeNav: vi.fn() }) };
});
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));

/*
FNXC:ChatThreadPagination 2026-11-08-11:55 (RUFU-871):
jsdom ships no `IntersectionObserver`, and the load-older sentinel in `ChatView.tsx:1356` constructs one
whenever `hasMoreMessages && !messagesLoading`, so every test in this file died with
`ReferenceError: IntersectionObserver is not defined` until the global was stubbed. The stub is deliberately
inert: these tests drive the affordance by clicking it, which is the keyboard-accessible path a user takes,
and asserting on a synthetic observer callback would test the stub instead of the component.
*/
const inertIntersectionObserver = {
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
  takeRecords: () => [],
  root: null,
  rootMargin: "",
  thresholds: [],
};
vi.stubGlobal("IntersectionObserver", vi.fn(function () { return inertIntersectionObserver; }));

installChatViewEnv();

const ROW_HEIGHT = 112;

function makeMessages(count: number): ChatMessage[] {
  const base = Date.UTC(2026, 3, 8, 0, 0, 0);
  return Array.from({ length: count }, (_, index) => ({
    id: `msg-${String(index).padStart(3, "0")}`,
    sessionId: activeSessionFixture.id,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `row ${index}`,
    thinkingOutput: null,
    metadata: null,
    attachments: [],
    createdAt: new Date(base + index * 1000).toISOString(),
  })) as unknown as ChatMessage[];
}

const history = makeMessages(100);
const initialPage = history.slice(50);
const olderPage = history.slice(47, 50);

let renderedIds: string[] = [];

/** Live layout: a row's offset is its position in the CURRENT order, so prepending really shifts it. */
function installLiveLayout() {
  Object.defineProperty(HTMLElement.prototype, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) {
      const index = renderedIds.indexOf(this.dataset.messageId ?? "");
      return index < 0 ? 0 : index * ROW_HEIGHT;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.messageId ? ROW_HEIGHT : 0;
    },
  });
}

function installPagedThread(options?: { hasMoreAfterPage?: boolean }) {
  const calls: string[] = [];
  mockUseChat.mockImplementation(() => {
    const [loaded, setLoaded] = useState(initialPage);
    const [hasMore, setHasMore] = useState(true);
    renderedIds = loaded.map((message) => message.id);
    return {
      ...defaultChatState,
      activeSession: activeSessionFixture,
      sessions: [activeSessionFixture],
      filteredSessions: [activeSessionFixture],
      messages: loaded,
      hasMoreMessages: hasMore,
      loadMoreMessages: async () => {
        calls.push(loaded[0]?.id ?? "");
        setLoaded((current) => {
          const merged = [...olderPage, ...current];
          renderedIds = merged.map((message) => message.id);
          setHasMore(options?.hasMoreAfterPage ?? false);
          return merged;
        });
      },
    };
  });
  return calls;
}

async function renderThread() {
  setupMockRooms();
  await renderWithAct(
    <ChatView projectId="project" addToast={vi.fn()} initialDirectSession={activeSessionFixture} />,
  );
  return document.querySelector<HTMLElement>(".chat-messages")!;
}

/**
 * The row ids actually mounted in the transcript right now. The virtualizer owns this window, so it
 * is a tail slice of the loaded order, never the whole loaded thread.
 */
function mountedRowIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(".chat-message[data-message-id]"),
  ).map((row) => row.dataset.messageId ?? "");
}

function anchorRow(transcript: HTMLElement): HTMLElement {
  const rows = Array.from(transcript.querySelectorAll<HTMLElement>(".chat-message[data-message-id]"));
  const anchor = rows.find((row) => row.offsetTop + row.offsetHeight >= transcript.scrollTop) ?? rows[0];
  expect(anchor).toBeDefined();
  return anchor!;
}

beforeEach(() => {
  installLiveLayout();
});

afterEach(() => {
  mockViewportMode("desktop");
  renderedIds = [];
});

describe("ChatView load-older affordance (RUFU-871 Slice A)", () => {
  it("renders a pressable control that requests the older page exactly once", async () => {
    const calls = installPagedThread();
    await renderThread();

    const button = await screen.findByTestId("chat-load-older");
    expect(button.textContent).toContain("Load older messages");
    expect(button.className).toContain("btn");

    const loadedBefore = [...renderedIds];
    const mountedBefore = mountedRowIds();
    expect(mountedBefore.length).toBeGreaterThan(0);
    expect(mountedBefore).toEqual(loadedBefore.slice(-mountedBefore.length));

    await act(async () => { fireEvent.click(button); });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(initialPage[0].id);

    await waitFor(() => expect(renderedIds).toHaveLength(loadedBefore.length + olderPage.length));
    const mountedAfter = mountedRowIds();
    /*
    (a) The mounted window stays the tail of the loaded order. A page that REPLACED the loaded rows
    breaks the equality because the mounted ids are no longer in `renderedIds` at all; a page that
    landed behind the newest row, or a reversed transcript, moves the window off the tail.
    */
    expect(mountedAfter).toEqual(renderedIds.slice(-mountedAfter.length));
    // (b) No duplicated row key in the DOM, whichever rows the window picked.
    expect(new Set(mountedAfter).size).toBe(mountedAfter.length);
    /*
    (c) The loaded transcript grew by exactly the older page, in front, with nothing lost,
    duplicated, or reordered.
    */
    expect(renderedIds).toEqual([...olderPage.map((message) => message.id), ...loadedBefore]);
    // (d) The reader's window did not move: an older page arriving above must not change what is on screen.
    expect(mountedAfter).toEqual(mountedBefore);
  });

  it("does not exist when there is no older history, and never sits there loading", async () => {
    mockUseChat.mockImplementation(() => ({
      ...defaultChatState,
      activeSession: activeSessionFixture,
      sessions: [activeSessionFixture],
      filteredSessions: [activeSessionFixture],
      messages: history.slice(-1),
      hasMoreMessages: false,
    }));
    const transcript = await renderThread();

    expect(screen.queryByTestId("chat-load-older")).toBeNull();
    expect(transcript.textContent).not.toContain("Loading older messages");
  });

  it("keeps the reader's anchor row and its viewport offset when older messages are prepended", async () => {
    installPagedThread();
    const transcript = await renderThread();
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 5_600 },
      scrollTop: { configurable: true, writable: true, value: 1_120 },
    });
    act(() => { fireEvent.scroll(transcript) });

    const anchor = anchorRow(transcript);
    const offsetBefore = anchor.offsetTop - transcript.scrollTop;
    expect(offsetBefore).not.toBe(0);

    await act(async () => { fireEvent.click(screen.getByTestId("chat-load-older")); });

    await waitFor(() => expect(renderedIds).toHaveLength(initialPage.length + olderPage.length));
    // Same node — React reconciled it in place rather than remounting the transcript.
    expect(anchor.isConnected).toBe(true);
    expect(document.querySelector(`[data-message-id="${anchor.dataset.messageId}"]`)).toBe(anchor);
    // Same pixel distance from the viewport top: the page arrived above without moving the reader.
    await waitFor(() => expect(anchor.offsetTop - transcript.scrollTop).toBe(offsetBefore));
  });

  it("offers the same affordance on the mobile chat layout", async () => {
    mockViewportMode("mobile");
    installPagedThread();
    await renderThread();
    expect(await screen.findByTestId("chat-load-older")).toBeInTheDocument();
  });
});
