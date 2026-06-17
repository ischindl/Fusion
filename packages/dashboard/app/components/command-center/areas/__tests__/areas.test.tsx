/*
FNXC:CommandCenter 2026-06-16-09:42:
Command Center area component tests (PR #1683). Pin loading/error/unavailable-vs-zero rendering for each analytics area against mocked fixtures so the "—" sentinel and cost-unavailable contracts can't regress.
*/
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";

// Mock the api() helper so the areas fetch deterministic fixtures.
const apiMock = vi.fn();
vi.mock("../../../../api/legacy", () => ({
  api: (path: string, opts?: RequestInit) => apiMock(path, opts),
}));

import { TokensArea } from "../TokensArea";
import { ToolsArea } from "../ToolsArea";
import { ProductivityArea } from "../ProductivityArea";
import { SignalsArea } from "../SignalsArea";
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

beforeEach(() => {
  apiMock.mockReset();
});

describe("TokensArea", () => {
  it("shows per-model totals + cost and renders rows", async () => {
    apiMock.mockResolvedValue(tokenFixture());
    render(<TokensArea range={range7d} />);

    await screen.findByTestId("cc-area-tokens");
    expect(screen.getByTestId("cc-tokens-total").textContent).toContain("1,500");
    expect(screen.getByTestId("cc-tokens-cost").textContent).toContain("$12.50");
    expect(screen.getByTestId("cc-tokens-row-gpt-4o")).toBeTruthy();
    expect(screen.getByTestId("cc-tokens-row-claude-sonnet")).toBeTruthy();
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
  it("renders unavailable LOC as the dash sentinel, never 0", async () => {
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
