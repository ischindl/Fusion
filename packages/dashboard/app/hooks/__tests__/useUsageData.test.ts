import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useUsageData } from "../useUsageData";
import * as api from "../../api";

describe("useUsageData", () => {
  const mockFetchUsageData = vi.spyOn(api, "fetchUsageData");

  beforeEach(() => {
    mockFetchUsageData.mockReset();
  });

  it("fetches data on initial mount", async () => {
    const mockData = {
      providers: [
        {
          name: "Claude",
          icon: "🟠",
          status: "ok" as const,
          windows: [],
        },
      ],
    };
    mockFetchUsageData.mockResolvedValue(mockData);

    const { result } = renderHook(() => useUsageData({ autoRefresh: false }));

    expect(result.current.loading).toBe(true);
    expect(result.current.providers).toEqual([]);
    expect(result.current.hasFetched).toBe(false);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.providers).toEqual(mockData.providers);
    expect(result.current.error).toBeNull();
    expect(result.current.lastUpdated).toBeInstanceOf(Date);
    expect(result.current.hasFetched).toBe(true);
  });

  it("handles fetch errors", async () => {
    mockFetchUsageData.mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() => useUsageData({ autoRefresh: false }));

    expect(result.current.hasFetched).toBe(false);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("Network error");
    expect(result.current.providers).toEqual([]);
    expect(result.current.hasFetched).toBe(true);
  });

  it("manual refresh fetches new data", async () => {
    const mockData1 = {
      providers: [{ name: "Claude", icon: "🟠", status: "ok" as const, windows: [] }],
    };
    const mockData2 = {
      providers: [{ name: "Codex", icon: "🟢", status: "ok" as const, windows: [] }],
    };

    mockFetchUsageData
      .mockResolvedValueOnce(mockData1)
      .mockResolvedValueOnce(mockData2);

    const { result } = renderHook(() => useUsageData({ autoRefresh: false }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.providers).toEqual(mockData1.providers);
    expect(result.current.hasFetched).toBe(true);

    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => expect(result.current.providers).toEqual(mockData2.providers));
    expect(result.current.hasFetched).toBe(true);
  });

  it("clears error on successful manual refresh after error", async () => {
    mockFetchUsageData
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({
        providers: [{ name: "Claude", icon: "🟠", status: "ok" as const, windows: [] }],
      });

    const { result } = renderHook(() => useUsageData({ autoRefresh: false }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("Network error");
    expect(result.current.hasFetched).toBe(true);

    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.providers).toHaveLength(1);
    expect(result.current.hasFetched).toBe(true);
  });

  it("sets hasFetched to true after a successful empty fetch", async () => {
    mockFetchUsageData.mockResolvedValue({ providers: [] });

    const { result } = renderHook(() => useUsageData({ autoRefresh: false }));

    expect(result.current.hasFetched).toBe(false);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.providers).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.hasFetched).toBe(true);
  });

  it("exports the correct interface", () => {
    expect(typeof useUsageData).toBe("function");
  });

  it("returns expected default values before first fetch", () => {
    mockFetchUsageData.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useUsageData({ autoRefresh: false }));

    expect(result.current.providers).toEqual([]);
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.lastUpdated).toBeNull();
    expect(result.current.hasFetched).toBe(false);
    expect(typeof result.current.refresh).toBe("function");
  });
});

/*
FNXC:UsageFetchGating 2026-10-02-11:06 (RUFU-493):
`UsageIndicator` is mounted with `isOpen={false}` on every dashboard boot, and `autoRefresh` gated only the
poll — so `GET /api/usage` still fired at mount and ran 61-82s on the production board, taking two of the
four client read slots away from the cards the operator came to read. These cases pin that a closed view
reads nothing, that opening it does read, and that closing it stops the read already running.
*/
describe("useUsageData fetch gating", () => {
  const mockFetch = vi.spyOn(api, "fetchUsageData");

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("reads nothing while the view is closed, and reads as soon as it opens", async () => {
    mockFetch.mockResolvedValue({ providers: [] });
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useUsageData({ enabled: open }),
      { initialProps: { open: false } },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockFetch).not.toHaveBeenCalled();
    // A closed view reports "not loading", not a spinner for a request that will never happen.
    expect(result.current.loading).toBe(false);

    rerender({ open: true });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.hasFetched).toBe(true));
  });

  it("aborts the request still in flight when the view closes", async () => {
    let signal: AbortSignal | undefined;
    // Never settles — the shape of a 60-80s usage read the operator walked away from.
    mockFetch.mockImplementation(((sig?: AbortSignal) => {
      signal = sig;
      return new Promise(() => {});
    }) as unknown as typeof api.fetchUsageData);

    const { rerender } = renderHook(({ open }: { open: boolean }) => useUsageData({ enabled: open }), {
      initialProps: { open: true },
    });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);

    rerender({ open: false });
    await waitFor(() => expect(signal!.aborted).toBe(true));
  });
});
