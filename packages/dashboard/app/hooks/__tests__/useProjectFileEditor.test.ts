import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useProjectFileEditor } from "../useProjectFileEditor";
import * as api from "../../api";
import type { FileContentResponse, SaveFileResponse } from "../../api";

// Mock the api module
vi.mock("../../api", () => ({
  fetchProjectFileContent: vi.fn(),
  saveProjectFileContent: vi.fn(),
}));

const mockFetchProjectFileContent = vi.mocked(api.fetchProjectFileContent);
const mockSaveProjectFileContent = vi.mocked(api.saveProjectFileContent);

describe("useProjectFileEditor", () => {
  beforeEach(() => {
    mockFetchProjectFileContent.mockReset();
    mockSaveProjectFileContent.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("initializes with empty content when no file selected", () => {
    const { result } = renderHook(() => useProjectFileEditor("/project", null, true));

    expect(result.current.content).toBe("");
    expect(result.current.originalContent).toBe("");
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.hasChanges).toBe(false);
    expect(result.current.mtime).toBeNull();
  });

  it("initializes with empty content when disabled", () => {
    const { result } = renderHook(() => useProjectFileEditor("/project", "src/index.ts", false));

    expect(result.current.content).toBe("");
    expect(result.current.loading).toBe(false);
    expect(mockFetchProjectFileContent).not.toHaveBeenCalled();
  });

  it("fetches file content when filePath is provided and enabled", async () => {
    const mockResponse: FileContentResponse = {
      content: "console.log('hello');",
      mtime: "2024-01-01T00:00:00Z",
      size: 21,
    };
    mockFetchProjectFileContent.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useProjectFileEditor("/project", "src/index.ts", true));

    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.content).toBe("console.log('hello');");
    expect(result.current.originalContent).toBe("console.log('hello');");
    expect(result.current.mtime).toBe("2024-01-01T00:00:00Z");
    expect(result.current.hasChanges).toBe(false);
    expect(mockFetchProjectFileContent).toHaveBeenCalledWith("src/index.ts");
  });

  it("tracks content changes", async () => {
    const mockResponse: FileContentResponse = {
      content: "console.log('hello');",
      mtime: "2024-01-01T00:00:00Z",
      size: 21,
    };
    mockFetchProjectFileContent.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useProjectFileEditor("/project", "src/index.ts", true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasChanges).toBe(false);

    // Edit content
    act(() => {
      result.current.setContent("console.log('world');");
    });

    expect(result.current.content).toBe("console.log('world');");
    expect(result.current.hasChanges).toBe(true);
  });

  it("saves file content", async () => {
    const loadResponse: FileContentResponse = {
      content: "console.log('hello');",
      mtime: "2024-01-01T00:00:00Z",
      size: 21,
    };
    const saveResponse: SaveFileResponse = {
      success: true,
      mtime: "2024-01-02T00:00:00Z",
      size: 22,
    };

    mockFetchProjectFileContent.mockResolvedValueOnce(loadResponse);
    mockSaveProjectFileContent.mockResolvedValueOnce(saveResponse);

    const { result } = renderHook(() => useProjectFileEditor("/project", "src/index.ts", true));

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Edit and save
    act(() => {
      result.current.setContent("console.log('world');");
    });

    await act(async () => {
      await result.current.save();
    });

    expect(mockSaveProjectFileContent).toHaveBeenCalledWith("src/index.ts", "console.log('world');");
    expect(result.current.originalContent).toBe("console.log('world');");
    expect(result.current.hasChanges).toBe(false);
    expect(result.current.mtime).toBe("2024-01-02T00:00:00Z");
  });

  it("does not save when there are no changes", async () => {
    const mockResponse: FileContentResponse = {
      content: "console.log('hello');",
      mtime: "2024-01-01T00:00:00Z",
      size: 21,
    };
    mockFetchProjectFileContent.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useProjectFileEditor("/project", "src/index.ts", true));

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Try to save without changes
    await act(async () => {
      await result.current.save();
    });

    expect(mockSaveProjectFileContent).not.toHaveBeenCalled();
  });

  it("handles fetch errors", async () => {
    mockFetchProjectFileContent.mockRejectedValueOnce(new Error("File not found"));

    const { result } = renderHook(() => useProjectFileEditor("/project", "src/missing.ts", true));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("File not found");
    expect(result.current.content).toBe("");
  });

  it("handles save errors", async () => {
    const loadResponse: FileContentResponse = {
      content: "console.log('hello');",
      mtime: "2024-01-01T00:00:00Z",
      size: 21,
    };
    mockFetchProjectFileContent.mockResolvedValueOnce(loadResponse);
    mockSaveProjectFileContent.mockRejectedValueOnce(new Error("Permission denied"));

    const { result } = renderHook(() => useProjectFileEditor("/project", "src/index.ts", true));

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Edit and try to save
    act(() => {
      result.current.setContent("console.log('world');");
    });

    let saveError: Error | undefined;
    await act(async () => {
      try {
        await result.current.save();
      } catch (err) {
        saveError = err as Error;
      }
    });

    expect(saveError?.message).toBe("Permission denied");
    expect(result.current.error).toBe("Permission denied");
    // Original content should not be updated on error
    expect(result.current.originalContent).toBe("console.log('hello');");
    expect(result.current.hasChanges).toBe(true);
  });

  it("clears content when filePath changes", async () => {
    const firstResponse: FileContentResponse = {
      content: "// file 1",
      mtime: "2024-01-01T00:00:00Z",
      size: 10,
    };
    const secondResponse: FileContentResponse = {
      content: "// file 2",
      mtime: "2024-01-02T00:00:00Z",
      size: 10,
    };

    mockFetchProjectFileContent
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(secondResponse);

    const { result, rerender } = renderHook(
      ({ filePath }) => useProjectFileEditor("/project", filePath, true),
      { initialProps: { filePath: "file1.ts" } }
    );

    await waitFor(() => expect(result.current.content).toBe("// file 1"));

    // Change file
    rerender({ filePath: "file2.ts" });

    await waitFor(() => expect(result.current.content).toBe("// file 2"));
  });

  it("clears content when disabled", async () => {
    const mockResponse: FileContentResponse = {
      content: "console.log('hello');",
      mtime: "2024-01-01T00:00:00Z",
      size: 21,
    };
    mockFetchProjectFileContent.mockResolvedValueOnce(mockResponse);

    const { result, rerender } = renderHook(
      ({ enabled }) => useProjectFileEditor("/project", "src/index.ts", enabled),
      { initialProps: { enabled: true } }
    );

    await waitFor(() => expect(result.current.content).toBe("console.log('hello');"));

    // Disable
    rerender({ enabled: false });

    expect(result.current.content).toBe("");
    expect(result.current.originalContent).toBe("");
    expect(result.current.mtime).toBeNull();
  });

  it("clears error when content is edited", async () => {
    mockFetchProjectFileContent.mockRejectedValueOnce(new Error("File not found"));

    const { result } = renderHook(() => useProjectFileEditor("/project", "src/missing.ts", true));

    await waitFor(() => expect(result.current.error).toBe("File not found"));

    // Edit content should clear error
    act(() => {
      result.current.setContent("new content");
    });

    expect(result.current.error).toBeNull();
  });

  it("shows saving state during save operation", async () => {
    const loadResponse: FileContentResponse = {
      content: "console.log('hello');",
      mtime: "2024-01-01T00:00:00Z",
      size: 21,
    };
    const saveResponse: SaveFileResponse = {
      success: true,
      mtime: "2024-01-02T00:00:00Z",
      size: 22,
    };

    let resolveSave: (value: SaveFileResponse) => void;
    const savePromise = new Promise<SaveFileResponse>((resolve) => {
      resolveSave = resolve;
    });

    mockFetchProjectFileContent.mockResolvedValueOnce(loadResponse);
    mockSaveProjectFileContent.mockReturnValueOnce(savePromise);

    const { result } = renderHook(() => useProjectFileEditor("/project", "src/index.ts", true));

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Edit and save
    act(() => {
      result.current.setContent("console.log('world');");
    });

    // Start save
    let savePromiseResolved = false;
    act(() => {
      result.current.save().then(() => {
        savePromiseResolved = true;
      });
    });

    expect(result.current.saving).toBe(true);

    // Complete save
    resolveSave!(saveResponse);
    await waitFor(() => expect(savePromiseResolved).toBe(true));

    expect(result.current.saving).toBe(false);
  });

  it("cancels in-flight fetch on unmount", async () => {
    let resolveFetch: (value: FileContentResponse) => void;
    const fetchPromise = new Promise<FileContentResponse>((resolve) => {
      resolveFetch = resolve;
    });
    mockFetchProjectFileContent.mockReturnValueOnce(fetchPromise);

    const { unmount } = renderHook(() => useProjectFileEditor("/project", "src/index.ts", true));

    // Unmount before fetch completes
    unmount();

    // Complete the fetch after unmount
    resolveFetch!({
      content: "console.log('hello');",
      mtime: "2024-01-01T00:00:00Z",
      size: 21,
    });

    // Wait a bit to ensure state update doesn't happen
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockFetchProjectFileContent).toHaveBeenCalledTimes(1);
  });
});
