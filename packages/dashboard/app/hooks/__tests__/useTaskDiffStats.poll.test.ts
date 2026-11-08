import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTaskDiffStats, __test_clearDiffStatsCache } from "../useTaskDiffStats";
import {
  VISIBLE_EDGE_STAGGER_WINDOW_MS,
  __resetVisibleEdgeStaggerRegistryForTests,
} from "../visibilitySuspension";
import * as api from "../../api";

/*
FNXC:BoardBootRequestSet 2026-11-08-04:48 (RUFU-493):
The per-card diff poll was the last raw `setInterval` loop on the board, so these tests pin the two
properties the boot request set depends on, in request COUNTS rather than durations:

  - a card asks for its diff ONCE at mount (a badge count is not a stream);
  - a card that is not shown — scrolled off-screen, or a search-result row — asks for NOTHING at any
    cadence, which is the same `enabled` signal TaskCard derives from its IntersectionObserver;
  - a HIDDEN document asks for nothing however long it stays hidden, and the edge back to visible buys
    exactly one refresh per card, no burst.

Fake timers stand in for the wall clock so "however long it stays hidden" is a loop bound rather than a
sleep: nothing here asserts a product timeout value, only how many requests a given condition produces.
*/

vi.mock("../../api", () => ({
  fetchTaskDiff: vi.fn(),
}));

const mockFetchTaskDiff = vi.mocked(api.fetchTaskDiff);

/** The cadence is passed IN by the caller, so the tests own this number, not the product. */
const CALLER_POLL_INTERVAL_MS = 60_000;

function setDocumentVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderActiveCard(options: { enabled?: boolean } = {}) {
  return renderHook(() =>
    useTaskDiffStats("RUFU-493", "in-progress", undefined, "project-x", {
      worktree: "/wt/rufu-493",
      pollIntervalMs: CALLER_POLL_INTERVAL_MS,
      enabled: options.enabled,
    }),
  );
}

describe("useTaskDiffStats poll lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetchTaskDiff.mockReset();
    mockFetchTaskDiff.mockResolvedValue({ stats: { filesChanged: 1, additions: 2, deletions: 0 } });
    __test_clearDiffStatsCache();
    __resetVisibleEdgeStaggerRegistryForTests();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for its diff exactly once at mount", async () => {
    renderActiveCard();
    await flushMicrotasks();

    expect(mockFetchTaskDiff).toHaveBeenCalledTimes(1);
  });

  it("issues no request however long the document stays hidden", async () => {
    renderActiveCard();
    await flushMicrotasks();
    mockFetchTaskDiff.mockClear();

    setDocumentVisibility("hidden");
    await flushMicrotasks();
    // Three full caller intervals plus the visible-edge stagger window: a hidden page holds no armed timer.
    await act(async () => {
      vi.advanceTimersByTime(CALLER_POLL_INTERVAL_MS * 3 + VISIBLE_EDGE_STAGGER_WINDOW_MS);
    });

    expect(mockFetchTaskDiff).not.toHaveBeenCalled();
  });

  it("buys exactly one refresh on the edge back to visible", async () => {
    renderActiveCard();
    await flushMicrotasks();
    mockFetchTaskDiff.mockClear();

    setDocumentVisibility("hidden");
    await flushMicrotasks();
    setDocumentVisibility("visible");
    await act(async () => {
      vi.advanceTimersByTime(VISIBLE_EDGE_STAGGER_WINDOW_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockFetchTaskDiff).toHaveBeenCalledTimes(1);
  });

  it("keeps polling while the tab stays visible, so the gate did not just delete the poll", async () => {
    renderActiveCard();
    await flushMicrotasks();
    mockFetchTaskDiff.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(CALLER_POLL_INTERVAL_MS * 2);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockFetchTaskDiff.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Every poll is a cache-bypassing refresh, not a first paint.
    for (const call of mockFetchTaskDiff.mock.calls) {
      expect(call[3]).toBe(true);
    }
  });

  it("asks for nothing at any cadence when the card is not shown", async () => {
    renderActiveCard({ enabled: false });
    await flushMicrotasks();

    await act(async () => {
      vi.advanceTimersByTime(CALLER_POLL_INTERVAL_MS * 3 + VISIBLE_EDGE_STAGGER_WINDOW_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockFetchTaskDiff).not.toHaveBeenCalled();
  });
});
