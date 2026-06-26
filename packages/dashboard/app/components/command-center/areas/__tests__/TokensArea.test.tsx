import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { TokensArea } from "../TokensArea";
import type { DateRange } from "../../DateRangePicker";

const apiMock = vi.fn();

vi.mock("../../../../api/legacy", () => ({
  api: (path: string, opts?: RequestInit) => apiMock(path, opts),
}));

vi.mock("../../../ProviderIcon", () => ({
  ProviderIcon: ({ provider, size }: { provider: string; size?: "sm" | "md" | "lg" }) => (
    <span className="provider-icon" data-provider={provider.toLowerCase()} data-size={size} data-testid={`provider-icon-${provider}`} />
  ),
}));

const range7d: DateRange = { from: "2026-06-08", to: null, preset: "7d" };

function tokenFixture() {
  return {
    from: "2026-06-08",
    to: null,
    groupBy: "model",
    totals: {
      inputTokens: 1_350,
      outputTokens: 675,
      cachedTokens: 225,
      cacheWriteTokens: 0,
      totalTokens: 2_250,
      nTasks: 5,
    },
    cost: { usd: 12.5, unavailable: false, stale: false },
    series: [],
    groups: [
      {
        key: "claude-sonnet-4-5",
        inputTokens: 600,
        outputTokens: 300,
        cachedTokens: 100,
        cacheWriteTokens: 0,
        totalTokens: 1_000,
        nTasks: 2,
        cost: { usd: 3.5, unavailable: false, stale: false },
      },
      {
        key: "gpt-4o-mini",
        inputTokens: 500,
        outputTokens: 250,
        cachedTokens: 100,
        cacheWriteTokens: 0,
        totalTokens: 850,
        nTasks: 2,
        cost: { usd: 7, unavailable: false, stale: false },
      },
      {
        key: null,
        inputTokens: 250,
        outputTokens: 125,
        cachedTokens: 25,
        cacheWriteTokens: 0,
        totalTokens: 400,
        nTasks: 1,
        cost: { usd: null, unavailable: true, stale: false },
      },
    ],
  };
}

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockResolvedValue(tokenFixture());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TokensArea provider model icons", () => {
  it("renders inferred provider icons in the per-model table and Tokens by model bars", async () => {
    render(<TokensArea range={range7d} />);

    const table = await screen.findByTestId("cc-tokens-table");
    const claudeRow = screen.getByTestId("cc-tokens-row-claude-sonnet-4-5");
    const gptRow = screen.getByTestId("cc-tokens-row-gpt-4o-mini");
    const unknownRow = screen.getByTestId("cc-tokens-row-unknown");

    expect(within(claudeRow).getByText("claude-sonnet-4-5")).toBeTruthy();
    expect(within(claudeRow).getByTestId("provider-icon-anthropic")).toBeTruthy();
    expect(within(gptRow).getByText("gpt-4o-mini")).toBeTruthy();
    expect(within(gptRow).getByTestId("provider-icon-openai")).toBeTruthy();
    expect(within(unknownRow).getByText("(unknown)")).toBeTruthy();
    expect(within(unknownRow).getByTestId("provider-icon-")).toBeTruthy();

    const byModelChart = screen.getByRole("list", { name: "Tokens by model" });
    const claudeBarLabel = within(byModelChart).getByText("claude-sonnet-4-5").closest(".cc-bar-label");
    const gptBarLabel = within(byModelChart).getByText("gpt-4o-mini").closest(".cc-bar-label");
    const unknownBarLabel = within(byModelChart).getByText("(unknown)").closest(".cc-bar-label");

    expect(claudeBarLabel?.firstElementChild).toHaveAttribute("data-testid", "provider-icon-anthropic");
    expect(gptBarLabel?.firstElementChild).toHaveAttribute("data-testid", "provider-icon-openai");
    expect(unknownBarLabel?.firstElementChild).toHaveAttribute("data-testid", "provider-icon-");
    expect(table.querySelectorAll(".provider-icon").length).toBeGreaterThanOrEqual(3);
  });
});
