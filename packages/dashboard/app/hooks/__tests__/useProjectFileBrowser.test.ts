import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useProjectFileBrowser } from "../useProjectFileBrowser";
import * as api from "../../api";
import type { FileListResponse } from "../../api";

// Mock the api module
vi.mock("../../api", () => ({
  fetchProjectFileList: vi.fn(),
}));

const mockFetchProjectFileList = vi.mocked(api.fetchProjectFileList);

describe("useProjectFileBrowser", () => {
  beforeEach(() => {
    mockFetchProjectFileList.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("initializes with empty entries and loading false when disabled", () => {
    const { result } = renderHook(() => useProjectFileBrowser("/project", false));

    expect(result.current.entries).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.currentPath).toBe(".");
  });

  it("fetches file list when enabled", async () => {
    const mockResponse: FileListResponse = {
      path: ".",
      entries: [
        { name: "src", type: "directory", mtime: "2024-01-01T00:00:00Z" },
        { name: "package.json", type: "file", size: 100, mtime: "2024-01-01T00:00:00Z" },
      ],
    };
    mockFetchProjectFileList.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useProjectFileBrowser("/project", true));

    // Should start loading
    expect(result.current.loading).toBe(true);

    // Wait for fetch to complete
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.entries).toHaveLength(2);
    expect(result.current.entries[0].name).toBe("src");
    expect(result.current.entries[1].name).toBe("package.json");
    expect(mockFetchProjectFileList).toHaveBeenCalledWith(undefined);
  });

  it("fetches subdirectory when path changes", async () => {
    const rootResponse: FileListResponse = {
      path: ".",
      entries: [{ name: "src", type: "directory", mtime: "2024-01-01T00:00:00Z" }],
    };
    const subdirResponse: FileListResponse = {
      path: "src",
      entries: [{ name: "index.ts", type: "file", size: 200, mtime: "2024-01-01T00:00:00Z" }],
    };

    mockFetchProjectFileList
      .mockResolvedValueOnce(rootResponse)
      .mockResolvedValueOnce(subdirResponse);

    const { result } = renderHook(() => useProjectFileBrowser("/project", true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toHaveLength(1);

    // Navigate to subdirectory
    act(() => {
      result.current.setPath("src");
    });

    await waitFor(() => expect(result.current.currentPath).toBe("src"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockFetchProjectFileList).toHaveBeenLastCalledWith("src");
  });

  it("handles fetch errors", async () => {
    mockFetchProjectFileList.mockRejectedValueOnce(new Error("Failed to load files"));

    const { result } = renderHook(() => useProjectFileBrowser("/project", true));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("Failed to load files");
    expect(result.current.entries).toEqual([]);
  });

  it("refreshes file list when refresh is called", async () => {
    const initialResponse: FileListResponse = {
      path: ".",
      entries: [{ name: "file1.txt", type: "file", size: 100, mtime: "2024-01-01T00:00:00Z" }],
    };
    const refreshedResponse: FileListResponse = {
      path: ".",
      entries: [
        { name: "file1.txt", type: "file", size: 100, mtime: "2024-01-01T00:00:00Z" },
        { name: "file2.txt", type: "file", size: 200, mtime: "2024-01-02T00:00:00Z" },
      ],
    };

    mockFetchProjectFileList
      .mockResolvedValueOnce(initialResponse)
      .mockResolvedValueOnce(refreshedResponse);

    const { result } = renderHook(() => useProjectFileBrowser("/project", true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toHaveLength(1);

    // Refresh
    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    expect(mockFetchProjectFileList).toHaveBeenCalledTimes(2);
  });

  it("clears error when path changes", async () => {
    mockFetchProjectFileList
      .mockRejectedValueOnce(new Error("Failed to load files"))
      .mockResolvedValueOnce({
        path: ".",
        entries: [{ name: "file.txt", type: "file", size: 100, mtime: "2024-01-01T00:00:00Z" }],
      });

    const { result } = renderHook(() => useProjectFileBrowser("/project", true));

    await waitFor(() => expect(result.current.error).toBe("Failed to load files"));

    // Change path should clear error
    act(() => {
      result.current.setPath("subdir");
    });

    expect(result.current.error).toBeNull();
  });

  it("does not fetch when disabled", async () => {
    renderHook(() => useProjectFileBrowser("/project", false));

    // Wait a bit to ensure no fetch happens
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockFetchProjectFileList).not.toHaveBeenCalled();
  });

  it("cancels in-flight requests on unmount", async () => {
    let resolveFetch: (value: FileListResponse) => void;
    const fetchPromise = new Promise<FileListResponse>((resolve) => {
      resolveFetch = resolve;
    });
    mockFetchProjectFileList.mockReturnValueOnce(fetchPromise);

    const { unmount } = renderHook(() => useProjectFileBrowser("/project", true));

    // Unmount before fetch completes
    unmount();

    // Complete the fetch after unmount
    resolveFetch!({
      path: ".",
      entries: [{ name: "file.txt", type: "file", size: 100, mtime: "2024-01-01T00:00:00Z" }],
    });

    // Wait a bit to ensure state update doesn't happen
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should not throw or have any issues
    expect(mockFetchProjectFileList).toHaveBeenCalledTimes(1);
  });
});
