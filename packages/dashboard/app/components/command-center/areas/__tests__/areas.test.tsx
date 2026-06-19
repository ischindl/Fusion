/*
FNXC:CommandCenter 2026-06-16-09:42:
Command Center area component tests (PR #1683). Pin loading/error/unavailable-vs-zero rendering for each analytics area against mocked fixtures so the "—" sentinel and cost-unavailable contracts can't regress.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act, renderHook } from "@testing-library/react";

// Mock the api() helper so the areas fetch deterministic fixtures.
const apiMock = vi.fn();
vi.mock("../../../../api/legacy", () => ({
  api: (path: string, opts?: RequestInit) => apiMock(path, opts),
}));

import { TokensArea } from "../TokensArea";
import { ToolsArea } from "../ToolsArea";
import { ProductivityArea } from "../ProductivityArea";
import { GithubArea } from "../GithubArea";
import { SignalsArea } from "../SignalsArea";
import { ActivityArea } from "../ActivityArea";
import { EcosystemArea } from "../EcosystemArea";
import { useAnalyticsArea } from "../useAnalyticsArea";
import type { DateRange } from "../DateRangePicker";

const range7d: DateRange = { from: "2026-06-08", to: null, preset: "7d" };
const customRange = (from: string, to: string): DateRange => ({ from, to, preset: "custom" });

function tokenFixture() {
  return {
    from: "2026-06-08",
    to: null,
    groupBy: "model",
    totals: {
      inputTokens: 1000,
      outputTokens: 500,
      cachedTokens: 200,
      cacheWriteTokens: 0,
      totalTokens: 1500,
      nTasks: 5,
    },
    cost: { usd: 12.5, unavailable: false, stale: false },
    series: [
      {
        bucket: "2026-06-08",
        inputTokens: 400,
        outputTokens: 200,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 600,
        nTasks: 2,
        cost: { usd: 4.5, unavailable: false, stale: false },
      },
      {
        bucket: "2026-06-09",
        inputTokens: 600,
        outputTokens: 300,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 900,
        nTasks: 3,
        cost: { usd: 8, unavailable: false, stale: false },
      },
    ],
    groups: [
      {
        key: "gpt-4o",
        inputTokens: 600,
        outputTokens: 300,
        cachedTokens: 100,
        cacheWriteTokens: 0,
        totalTokens: 900,
        nTasks: 3,
        cost: { usd: 9.0, unavailable: false, stale: false },
      },
      {
        key: "claude-sonnet",
        inputTokens: 400,
        outputTokens: 200,
        cachedTokens: 100,
        cacheWriteTokens: 0,
        totalTokens: 600,
        nTasks: 2,
        cost: { usd: 3.5, unavailable: false, stale: false },
      },
    ],
  };
}

function githubFixture() {
  return {
    from: "2026-06-08",
    to: null,
    filed: 5,
    fixed: 3,
    net: 2,
    daily: [
      { date: "2026-06-08", filed: 2, fixed: 1 },
      { date: "2026-06-09", filed: 3, fixed: 2 },
    ],
    byRepo: [
      { repo: "acme/alpha", filed: 4, fixed: 1 },
      { repo: "acme/beta", filed: 1, fixed: 2 },
    ],
  };
}

function activityFixture() {
  return {
    from: "2026-06-08",
    to: null,
    sessions: 4,
    messages: 12,
    activeNodes: 3,
    activeAgents: 2,
    agentRuns: { total: 8, active: 1, completed: 6, failed: 1 },
    daily: [
      { day: "2026-06-08", messages: 2, activeNodes: 1, activeAgents: 1, agentRuns: 2 },
      { day: "2026-06-09", messages: 4, activeNodes: 2, activeAgents: 1, agentRuns: 3 },
      { day: "2026-06-10", messages: 6, activeNodes: 3, activeAgents: 2, agentRuns: 3 },
    ],
    stickiness: 0.5,
    mttr: { value: null, unavailable: true, sampleCount: 0 },
    monitor: {
      mttr: { value: null, unavailable: true, sampleCount: 0 },
      incidentsOpened: 0,
      incidentsResolved: 0,
      openIncidents: 0,
      deployments: 0,
    },
    funnel: {
      stages: [],
      enteredInRange: 0,
      doneInRange: 0,
      completionRate: null,
      throughputPerDay: 0,
      rangeDays: 7,
    },
  };
}

beforeEach(() => {
  apiMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAnalyticsArea", () => {
  it("polls only when pollMs is provided and clears the interval on unmount", async () => {
    vi.useFakeTimers();
    apiMock.mockResolvedValue({ ok: true });

    const { unmount } = renderHook(() =>
      useAnalyticsArea<{ ok: boolean }>("/command-center/tokens", range7d, { pollMs: 1_000 }),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(apiMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(apiMock).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it("does not poll by default", async () => {
    vi.useFakeTimers();
    apiMock.mockResolvedValue({ ok: true });

    renderHook(() => useAnalyticsArea<{ ok: boolean }>("/command-center/tools", range7d));

    await act(async () => {
      await Promise.resolve();
    });
    expect(apiMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("does not fetch or schedule polling for inverted custom ranges", async () => {
    vi.useFakeTimers();

    renderHook(() =>
      useAnalyticsArea<{ ok: boolean }>(
        "/command-center/tokens",
        customRange("2026-06-10", "2026-06-01"),
        { pollMs: 1_000 },
      ),
    );

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(apiMock).not.toHaveBeenCalled();
  });
});

describe("ActivityArea", () => {
  it("renders summary stats and the live line chart sections for populated daily activity", async () => {
    apiMock.mockResolvedValue(activityFixture());
    render(<ActivityArea range={range7d} />);

    await screen.findByTestId("cc-area-activity");
    expect(screen.getByTestId("cc-activity-sessions").textContent).toContain("4");
    expect(screen.getByTestId("cc-activity-messages").textContent).toContain("12");
    expect(screen.getByTestId("cc-activity-nodes").textContent).toContain("3");
    expect(screen.getByTestId("cc-activity-agents").textContent).toContain("2");
    expect(screen.getByTestId("cc-activity-agent-runs").textContent).toContain("8");
    expect(screen.getByTestId("cc-activity-agent-runs-active").textContent).toContain("1");
    expect(screen.getByTestId("cc-activity-agent-runs-completed").textContent).toContain("6");
    expect(screen.getByTestId("cc-activity-agent-runs-failed").textContent).toContain("1");
    expect(screen.getByTestId("cc-activity-stickiness").textContent).toContain("50%");
    expect(screen.getByTestId("cc-activity-line-messages")).toBeTruthy();
    expect(screen.getByTestId("cc-activity-line-agents")).toBeTruthy();
    expect(screen.getByTestId("cc-activity-line-nodes")).toBeTruthy();
    expect(screen.getByTestId("cc-activity-agent-runs-sparkline")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Agent runs / day" })).toBeTruthy();
    expect(screen.getByTestId("cc-activity-line-throughput")).toBeTruthy();
  });

  it("renders zero agent-run cards when counts are zero and other activity exists", async () => {
    apiMock.mockResolvedValue({
      ...activityFixture(),
      agentRuns: { total: 0, active: 0, completed: 0, failed: 0 },
      daily: [{ day: "2026-06-08", messages: 1, activeNodes: 1, activeAgents: 1, agentRuns: 0 }],
    });
    render(<ActivityArea range={range7d} />);

    await screen.findByTestId("cc-area-activity");
    expect(screen.queryByTestId("cc-area-activity-empty")).toBeNull();
    expect(screen.getByTestId("cc-activity-agent-runs").textContent).toContain("0");
    expect(screen.getByTestId("cc-activity-agent-runs-active").textContent).toContain("0");
    expect(screen.getByTestId("cc-activity-agent-runs-completed").textContent).toContain("0");
    expect(screen.getByTestId("cc-activity-agent-runs-failed").textContent).toContain("0");
  });

  it("renders agent-run cards instead of the empty state when only run data exists", async () => {
    apiMock.mockResolvedValue({
      ...activityFixture(),
      sessions: 0,
      messages: 0,
      activeNodes: 0,
      activeAgents: 0,
      agentRuns: { total: 2, active: 1, completed: 1, failed: 0 },
      daily: [{ day: "2026-06-08", messages: 0, activeNodes: 0, activeAgents: 0, agentRuns: 2 }],
      stickiness: 0,
    });
    render(<ActivityArea range={range7d} />);

    await screen.findByTestId("cc-area-activity");
    expect(screen.queryByTestId("cc-area-activity-empty")).toBeNull();
    expect(screen.getByTestId("cc-activity-agent-runs").textContent).toContain("2");
    expect(screen.getByTestId("cc-activity-agent-runs-sparkline")).toBeTruthy();
  });

  it("renders the empty state for zero activity without empty chart shells", async () => {
    apiMock.mockResolvedValue({
      ...activityFixture(),
      sessions: 0,
      messages: 0,
      activeNodes: 0,
      activeAgents: 0,
      agentRuns: { total: 0, active: 0, completed: 0, failed: 0 },
      daily: [],
      stickiness: 0,
    });
    render(<ActivityArea range={range7d} />);

    await screen.findByTestId("cc-area-activity-empty");
    expect(screen.queryByTestId("cc-activity-line-messages")).toBeNull();
    expect(screen.queryByTestId("cc-activity-line-agents")).toBeNull();
    expect(screen.queryByTestId("cc-activity-line-nodes")).toBeNull();
    expect(screen.queryByTestId("cc-activity-agent-runs-sparkline")).toBeNull();
    expect(screen.queryByTestId("cc-activity-line-throughput")).toBeNull();
  });

  it("polls activity while mounted, keeps content during refresh, and clears the interval on unmount", async () => {
    vi.useFakeTimers();
    apiMock.mockResolvedValue(activityFixture());
    const { unmount } = render(<ActivityArea range={range7d} />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("cc-area-activity")).toBeTruthy();
    expect(apiMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("cc-area-activity")).toBeTruthy();
    expect(screen.queryByTestId("cc-area-activity-loading")).toBeNull();

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it("does not poll or fetch for an inverted custom activity range", async () => {
    vi.useFakeTimers();
    render(<ActivityArea range={customRange("2026-06-10", "2026-06-01")} />);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(apiMock).not.toHaveBeenCalled();
  });
});

describe("TokensArea", () => {
  it("shows per-model totals + cost and renders rows", async () => {
    apiMock.mockResolvedValue(tokenFixture());
    render(<TokensArea range={range7d} />);

    await screen.findByTestId("cc-area-tokens");
    expect(screen.getByTestId("cc-tokens-total").textContent).toContain("1,500");
    expect(screen.getByTestId("cc-tokens-cost").textContent).toContain("$12.50");
    expect(screen.getByTestId("cc-token-series-chart")).toBeTruthy();
    expect(screen.getByLabelText("2026-06-09: 900")).toBeTruthy();
    expect(screen.getByTestId("cc-tokens-row-gpt-4o")).toBeTruthy();
    expect(screen.getByTestId("cc-tokens-row-claude-sonnet")).toBeTruthy();
  });

  it("changes the requested endpoint when granularity changes", async () => {
    apiMock.mockResolvedValue(tokenFixture());
    render(<TokensArea range={range7d} />);
    await screen.findByTestId("cc-area-tokens");
    expect(apiMock.mock.calls.at(-1)?.[0]).toContain("granularity=day");

    fireEvent.click(screen.getByTestId("cc-token-granularity-hour"));
    await waitFor(() => expect(apiMock.mock.calls.at(-1)?.[0]).toContain("granularity=hour"));
  });

  it("polls the live token value while preserving rendered content", async () => {
    vi.useFakeTimers();
    apiMock
      .mockResolvedValueOnce(tokenFixture())
      .mockResolvedValueOnce({
        ...tokenFixture(),
        totals: { ...tokenFixture().totals, totalTokens: 1700 },
      });

    render(<TokensArea range={range7d} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("cc-tokens-total").textContent).toContain("1,500");

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("cc-tokens-total").textContent).toContain("1,700");
    expect(screen.getByTestId("cc-token-series-chart")).toBeTruthy();
  });

  it("refetches when the date range changes", async () => {
    apiMock.mockResolvedValue(tokenFixture());
    const { rerender } = render(<TokensArea range={range7d} />);
    await screen.findByTestId("cc-area-tokens");
    expect(apiMock).toHaveBeenCalledTimes(1);

    rerender(<TokensArea range={{ from: "2026-05-01", to: null, preset: "30d" }} />);
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    const lastCall = apiMock.mock.calls.at(-1)?.[0] as string;
    expect(lastCall).toContain("from=2026-05-01");
  });

  it("renders the empty state with no token data (no crash)", async () => {
    apiMock.mockResolvedValue({
      from: null,
      to: null,
      groupBy: "model",
      totals: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 0, nTasks: 0 },
      cost: { usd: null, unavailable: true, stale: false },
      groups: [],
      series: [],
    });
    render(<TokensArea range={range7d} />);
    await screen.findByTestId("cc-area-tokens-empty");
  });

  // The critical SWR-identity regression: a revalidation that returns
  // content-identical rows with a NEW object identity must NOT reset the user's
  // chosen column sort.
  it("preserves the user's sort across an SWR revalidation with new array identity", async () => {
    const original = tokenFixture();
    // Defer the second resolution so we can interact before it lands.
    let resolveSecond: ((v: unknown) => void) | null = null;
    apiMock
      .mockResolvedValueOnce(original)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );

    const { rerender } = render(<TokensArea range={range7d} />);
    await screen.findByTestId("cc-area-tokens");

    // Default sort is total desc. Switch to sorting by model name ascending.
    fireEvent.click(screen.getByTestId("cc-tokens-sort-key"));
    const rowsAfterSort = screen.getAllByTestId(/cc-tokens-row-/).map((r) => r.getAttribute("data-testid"));
    // claude-sonnet sorts before gpt-4o alphabetically.
    expect(rowsAfterSort[0]).toBe("cc-tokens-row-claude-sonnet");

    // Trigger a refetch (range value change → refetch) and resolve it with a
    // DEEP COPY of the SAME content (new object identity, identical model set).
    rerender(<TokensArea range={{ from: "2026-06-07", to: null, preset: "custom" }} />);
    await waitFor(() => expect(resolveSecond).not.toBeNull());
    await act(async () => {
      resolveSecond?.(JSON.parse(JSON.stringify(original)));
    });

    // Sort must survive: claude-sonnet still first.
    await waitFor(() => {
      const rows = screen.getAllByTestId(/cc-tokens-row-/).map((r) => r.getAttribute("data-testid"));
      expect(rows[0]).toBe("cc-tokens-row-claude-sonnet");
    });
  });

  it("rejects an inverted custom range client-side without fetching", async () => {
    render(<TokensArea range={customRange("2026-06-10", "2026-06-01")} />);
    // No request should be issued for from > to.
    await waitFor(() => expect(apiMock).not.toHaveBeenCalled());
  });
});

describe("ToolsArea", () => {
  it("shows autonomy ratio and sorted tool categories", async () => {
    apiMock.mockResolvedValue({
      from: "2026-06-08",
      to: null,
      toolCalls: 30,
      byCategory: [
        { category: "edit", count: 5 },
        { category: "read", count: 20 },
        { category: "shell", count: 5 },
      ],
      sessions: 3,
      interventions: { approvals: 2, userSteers: 1, total: 3 },
      autonomyRatio: 10,
      fullyAutonomous: false,
    });
    render(<ToolsArea range={range7d} />);
    await screen.findByTestId("cc-area-tools");
    expect(screen.getByTestId("cc-tools-autonomy").textContent).toContain("10.0:1");

    // Sorted descending by count: read (20) first.
    const chart = screen.getByRole("list", { name: "Tool categories" });
    const labels = within(chart).getAllByRole("img").map((el) => el.getAttribute("aria-label"));
    expect(labels[0]).toBe("read: 20");
  });

  it("renders the empty state when there are no tool calls", async () => {
    apiMock.mockResolvedValue({
      from: null,
      to: null,
      toolCalls: 0,
      byCategory: [],
      sessions: 0,
      interventions: { approvals: 0, userSteers: 0, total: 0 },
      autonomyRatio: 0,
      fullyAutonomous: true,
    });
    render(<ToolsArea range={range7d} />);
    await screen.findByTestId("cc-area-tools-empty");
  });
});

describe("ProductivityArea", () => {
  it("renders unavailable LOC as the dash sentinel, never 0 and keeps chart geometry finite", async () => {
    apiMock.mockResolvedValue({
      from: "2026-06-08",
      to: null,
      modifiedFiles: 12,
      byLanguage: [{ language: "ts", count: 12 }],
      commits: 4,
      pullRequests: 2,
      loc: { value: null, unavailable: true },
    });
    render(<ProductivityArea range={range7d} />);
    await screen.findByTestId("cc-area-productivity");
    const loc = screen.getByTestId("cc-productivity-loc-unavailable");
    expect(loc.textContent).toBe("—");
    expect(loc.getAttribute("title")).toBeTruthy();
    // The commits outcome counter still shows a real number.
    expect(screen.getByTestId("cc-productivity-commits").textContent).toContain("4");
    expect(screen.getByRole("list", { name: "Files by language" })).toBeTruthy();
    expect(screen.getByTestId("cc-area-productivity").textContent).not.toContain("NaN");
  });

  it("renders empty, loading, and error states without empty chart shells", async () => {
    apiMock.mockResolvedValueOnce({
      from: null,
      to: null,
      modifiedFiles: 0,
      byLanguage: [],
      commits: 0,
      pullRequests: 0,
      loc: { value: null, unavailable: true },
    });
    const { unmount } = render(<ProductivityArea range={range7d} />);
    await screen.findByTestId("cc-area-productivity-empty");
    expect(screen.queryByRole("list", { name: "Files by language" })).toBeNull();
    unmount();

    apiMock.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = render(<ProductivityArea range={range7d} />);
    expect(screen.getByTestId("cc-area-productivity-loading")).toBeTruthy();
    pending.unmount();

    apiMock.mockRejectedValueOnce(new Error("productivity failed"));
    render(<ProductivityArea range={range7d} />);
    await screen.findByTestId("cc-area-productivity-error");
    expect(screen.getByTestId("cc-area-productivity-error").textContent).toContain("productivity failed");
  });
});

describe("EcosystemArea", () => {
  it("renders populated and empty model chart states without NaN or empty chart shells", async () => {
    apiMock.mockResolvedValueOnce(tokenFixture());
    const { unmount } = render(<EcosystemArea range={range7d} />);
    await screen.findByTestId("cc-area-ecosystem");
    expect(screen.getByRole("list", { name: "Tasks per model" })).toBeTruthy();
    expect(screen.getByTestId("cc-area-ecosystem").textContent).not.toContain("NaN");
    unmount();

    apiMock.mockResolvedValueOnce({ ...tokenFixture(), groups: [], totals: { ...tokenFixture().totals, totalTokens: 0, nTasks: 0 } });
    render(<EcosystemArea range={range7d} />);
    await screen.findByTestId("cc-area-ecosystem-empty");
    expect(screen.queryByRole("list", { name: "Tasks per model" })).toBeNull();
  });
});

describe("GithubArea", () => {
  it("renders filed/fixed/net stats, daily trend, and by-repo bars", async () => {
    apiMock.mockResolvedValue(githubFixture());
    render(<GithubArea range={range7d} />);

    await screen.findByTestId("cc-area-github");
    expect(screen.getByTestId("cc-github-filed").textContent).toContain("5");
    expect(screen.getByTestId("cc-github-fixed").textContent).toContain("3");
    expect(screen.getByTestId("cc-github-net").textContent).toContain("2");
    expect(screen.getByTestId("cc-github-daily-trend")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Filed" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Fixed" })).toBeTruthy();
    const repoChart = screen.getByRole("list", { name: "By repository" });
    expect(within(repoChart).getByText("acme/alpha")).toBeTruthy();
    expect(within(repoChart).getByLabelText("acme/alpha: 4 filed / 1 fixed")).toBeTruthy();
  });

  it("renders the empty state without empty chart shells", async () => {
    apiMock.mockResolvedValue({ ...githubFixture(), filed: 0, fixed: 0, net: 0, daily: [], byRepo: [] });
    render(<GithubArea range={range7d} />);

    await screen.findByTestId("cc-area-github-empty");
    expect(screen.queryByTestId("cc-github-daily-trend")).toBeNull();
    expect(screen.queryByTestId("cc-github-by-repo")).toBeNull();
  });

  it("renders loading and error states", async () => {
    apiMock.mockImplementationOnce(() => new Promise(() => undefined));
    const { unmount } = render(<GithubArea range={range7d} />);
    expect(screen.getByTestId("cc-area-github-loading")).toBeTruthy();
    unmount();

    apiMock.mockRejectedValueOnce(new Error("github failed"));
    render(<GithubArea range={range7d} />);
    await screen.findByTestId("cc-area-github-error");
    expect(screen.getByTestId("cc-area-github-error").textContent).toContain("github failed");
  });

  it("handles undefined chart arrays and zero values without NaN output", async () => {
    apiMock.mockResolvedValue({ ...githubFixture(), filed: 1, fixed: 0, net: 1, daily: undefined, byRepo: undefined });
    render(<GithubArea range={range7d} />);

    await screen.findByTestId("cc-area-github");
    expect(screen.queryByTestId("cc-github-daily-trend")).toBeNull();
    expect(screen.queryByTestId("cc-github-by-repo")).toBeNull();
    expect(screen.getByTestId("cc-area-github").textContent).not.toContain("NaN");
  });

  it("rejects an inverted custom range client-side without fetching", async () => {
    render(<GithubArea range={customRange("2026-06-10", "2026-06-01")} />);
    await waitFor(() => expect(apiMock).not.toHaveBeenCalled());
  });
});

describe("SignalsArea", () => {
  it("renders the empty state (not an error) when the signals endpoint is missing", async () => {
    apiMock.mockRejectedValue(new Error("API returned HTML instead of JSON (404)"));
    render(<SignalsArea range={range7d} />);
    await screen.findByTestId("cc-area-signals-empty");
    // Must not surface the error UI.
    expect(screen.queryByTestId("cc-area-signals-error")).toBeNull();
  });

  it("renders signal metrics when data is present", async () => {
    apiMock.mockResolvedValue({
      totalSignals: 8,
      open: 3,
      resolved: 5,
      mttr: { value: 42, unavailable: false },
      bySource: [{ source: "sentry", count: 8 }],
      bySeverity: [{ severity: "error", count: 8 }],
    });
    render(<SignalsArea range={range7d} />);
    await screen.findByTestId("cc-area-signals");
    expect(screen.getByTestId("cc-signals-total").textContent).toContain("8");
    expect(screen.getByTestId("cc-signals-mttr").textContent).toContain("42");
  });
});
