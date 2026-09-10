/*
FNXC:ReviewLaneBypass 2026-09-03-13:39 (RUFU-179):
Anti-flicker contract for the review-lane bypass affordance. The client deliberately blanks the
DIAGNOSTIC copy (`stallReason` and the stall badges) while an in-review agent has a fresh `agent:log`
entry — a reviewer that dispatched a gate and then died keeps its log fresh-looking, so the
diagnostic must not assert "stalled" while work is visibly happening. The CAPABILITY field
(`reviewBypass`) must survive that same clear: it mirrors what `TaskStore.bypassFailedPreMergeReviewStep`
would accept, and hiding the operator's only escape hatch exactly when the card is wedged is the
SANE-387 failure this task exists to eliminate. A test that only asserted the capability renders in
the menu would miss this — the flicker lives in the client copy, not the server row.

EventSource mock reuse requirements (same as useTasks.test.ts): instances are tracked statically and
must be closed + cleared in afterEach so reconnect timers cannot leak across tests.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useTasks } from "../useTasks";
import * as api from "../../api";
import type { ReviewBypassTarget, Task } from "@fusion/core";

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchTaskPage: vi.fn().mockResolvedValue({ tasks: [], total: 0, hasMore: false, nextCursor: null }),
    fetchArchivedTasks: vi.fn().mockResolvedValue({ tasks: [], total: 0, hasMore: false }),
    bypassReview: vi.fn(),
  });
});

const mockFetchBoard = vi.mocked(api.fetchTaskPage);

type BoardPage = Awaited<ReturnType<typeof api.fetchTaskPage>>;

function page(tasks: Task[]): BoardPage {
  return { tasks, total: tasks.length, hasMore: false, nextCursor: null };
}


class MockEventSource {
  static instances: MockEventSource[] = [];
  static CLOSED = 2;
  url: string;
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  readyState = 0;
  close = vi.fn(() => {
    this.readyState = MockEventSource.CLOSED;
  });

  constructor(url: string) {
    this.url = url;
    this.readyState = 1;
    MockEventSource.instances.push(this);
  }

  addEventListener(event: string, fn: (e: unknown) => void) {
    (this.listeners[event] ??= []).push(fn);
  }

  removeEventListener(event: string, fn: (e: unknown) => void) {
    this.listeners[event] = (this.listeners[event] ?? []).filter((listener) => listener !== fn);
  }

  _emit(event: string, data?: unknown) {
    for (const fn of this.listeners[event] ?? []) {
      fn(data === undefined ? {} : { data: JSON.stringify(data) });
    }
  }
}

const originalEventSource = globalThis.EventSource;

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  mockFetchBoard.mockReset().mockResolvedValue(page([]));
  vi.useRealTimers();
});

afterEach(() => {
  for (const instance of MockEventSource.instances) instance.close();
  MockEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = originalEventSource;
  vi.useRealTimers();
});

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-179",
    description: "Review-lane card with an unrun pre-merge gate",
    column: "in-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    columnMovedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as Task;
}

const gatePendingStall = {
  code: "pre-merge-gate-pending",
  reason: "task has enabled pre-merge workflow steps that never ran",
  observedAt: "2026-09-01T00:00:00Z",
} as const;

const unrunTarget: ReviewBypassTarget = {
  kind: "absent",
  workflowStepId: "code-review",
  workflowStepName: "code-review",
};

describe("useTasks reviewBypass affordance survives the stall anti-flicker clear", () => {
  it("carries the server-derived capability through list normalization onto the board copy", async () => {
    const initialTask = createMockTask({ reviewBypass: unrunTarget, stallReason: gatePendingStall as never });
    mockFetchBoard.mockResolvedValueOnce(page([initialTask]));

    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    // normalizeTask must be spread-preserving: the capability arrives on the slim board row.
    expect(result.current.tasks[0]?.reviewBypass).toMatchObject({ kind: "absent", workflowStepId: "code-review" });
  });

  it("blanks the diagnostic copy on fresh agent-log activity but leaves the bypass capability present", async () => {
    const initialTask = createMockTask({ reviewBypass: unrunTarget, stallReason: gatePendingStall as never });
    mockFetchBoard.mockResolvedValueOnce(page([initialTask]));

    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    act(() => {
      MockEventSource.instances[0]._emit("agent:log", {
        taskId: "FN-179",
        timestamp: "2026-09-01T00:00:01.000Z", // > updatedAt → fresh
        type: "text",
        agent: "reviewer",
      });
    });

    // The diagnostic flickers off while the reviewer streams — that is the intended clear.
    expect(result.current.tasks[0]?.stallReason).toBeUndefined();
    // The capability must NOT flicker: hiding it here is the SANE-387 dead-end this task removes.
    expect(result.current.tasks[0]?.reviewBypass).toMatchObject({ kind: "absent", workflowStepId: "code-review" });
  });

  it("leaves the diagnostic and the capability untouched when the agent log is not fresh", async () => {
    const initialTask = createMockTask({ reviewBypass: unrunTarget, stallReason: gatePendingStall as never });
    mockFetchBoard.mockResolvedValueOnce(page([initialTask]));

    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    act(() => {
      MockEventSource.instances[0]._emit("agent:log", {
        taskId: "FN-179",
        timestamp: "2026-06-01T00:00:00.000Z", // < updatedAt → stale, no clear at all
        type: "text",
        agent: "reviewer",
      });
    });

    expect(result.current.tasks[0]?.stallReason?.code).toBe("pre-merge-gate-pending");
    expect(result.current.tasks[0]?.reviewBypass).toMatchObject({ kind: "absent", workflowStepId: "code-review" });
  });

  it("keeps the capability when only it is present (the clear's early-return must not touch it)", async () => {
    // Non-vacuous control for the stall clear's early-return branch: a card whose ONLY stall-family
    // field is the capability. If `reviewBypass` were ever added to the cleared-field list, both this
    // case and the fresh-log case above would go red; today the helper early-returns for cards with
    // no diagnostic copy, so the capability is provably never in its clear path.
    const initialTask = createMockTask({ reviewBypass: unrunTarget });
    mockFetchBoard.mockResolvedValueOnce(page([initialTask]));

    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    act(() => {
      MockEventSource.instances[0]._emit("agent:log", {
        taskId: "FN-179",
        timestamp: "2026-09-01T00:00:02.000Z", // fresh
        type: "text",
        agent: "reviewer",
      });
    });

    expect(result.current.tasks[0]?.reviewBypass).toMatchObject({ kind: "absent", workflowStepId: "code-review" });
  });
});
