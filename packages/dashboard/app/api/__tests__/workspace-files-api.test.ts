import { afterEach, describe, expect, it, vi } from "vitest";
import { saveFileContent, saveWorkspaceFileContent, uploadWorkspaceFiles, MAX_WORKSPACE_UPLOAD_FILE_BYTES } from "../projects/workspace-files";
import { MAX_UPLOAD_FILE_SIZE } from "../../../src/file-service";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * FNXC:LargeTextPayloads 2026-08-21-04:35:
 * File-editor clients must keep canonical JSON serialization so the server's finite escaped-file
 * envelope covers every shared editor without introducing client-specific truncation.
 */
describe("workspace file save API", () => {
  afterEach(() => vi.restoreAllMocks());

  it("serializes large workspace and compatibility task-file content exactly", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ success: true, mtime: "now", size: 1 }));
    const content = "2026-08-21T04:35:00Z INFO repeated file log\n".repeat(3_000);

    await saveWorkspaceFileContent("project", "logs/large.log", content, "project-1");
    await saveFileContent("task-1", "logs/large.log", content, "project-1");

    const [workspaceUrl, workspaceInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(workspaceUrl).toContain("/api/files/logs%2Flarge.log?workspace=project&projectId=project-1");
    expect(workspaceInit.body).toBe(JSON.stringify({ content }));
    const [taskUrl, taskInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(taskUrl).toContain("/api/tasks/task-1/files/logs%2Flarge.log?projectId=project-1");
    expect(taskInit.body).toBe(JSON.stringify({ content }));
  });
});

/*
FNXC:FileBrowserUpload 2026-09-05-15:01:
RUFU-189: the upload helper must NOT set a Content-Type header — fetch owns the multipart
boundary, and the shared api() wrapper's forced `application/json` stamp is exactly why uploads
bypass it. Destination directory, the explicit overwrite waiver, and per-file outcomes are the
contract the Files browser UI branches on.
*/
describe("workspace file upload API", () => {
  afterEach(() => vi.restoreAllMocks());

  function uploadResponse(overrides: Partial<{ uploaded: unknown[]; failed: unknown[] }> = {}) {
    return jsonResponse({ uploaded: [], failed: [], ...overrides });
  }

  it("sends multipart form data without a manual Content-Type and returns per-file outcomes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      uploadResponse({
        uploaded: [{ name: "a.png", path: "assets/a.png", size: 3, mtime: "now" }],
        failed: [{ name: "b.png", code: "EEXIST", error: "already exists" }],
      }),
    );

    const result = await uploadWorkspaceFiles(
      "project",
      [new File([new Uint8Array([1, 2, 3])], "a.png"), new File([new Uint8Array([4])], "b.png")],
      { path: "assets", projectId: "p-1" },
    );

    expect(result.uploaded).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ name: "b.png", code: "EEXIST" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/files/upload?workspace=project&projectId=p-1");
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect((form.getAll("files") as File[]).map((f) => f.name)).toEqual(["a.png", "b.png"]);
    expect(form.get("path")).toBe("assets");
    expect(form.get("overwrite")).toBeNull();
    const headers = new Headers(init.headers);
    // Absent so fetch can declare `multipart/form-data; boundary=...` itself.
    expect(headers.get("content-type")).toBeNull();
    expect(headers.get("x-fusion-client")).toBe("dashboard-ui");
  });

  it("defaults to the workspace root and appends overwrite=true only when asked", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => uploadResponse());

    await uploadWorkspaceFiles("project", [new File([new Uint8Array([1])], "x.txt")], { overwrite: true });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const form = init.body as FormData;
    expect(form.get("path")).toBe(".");
    expect(form.get("overwrite")).toBe("true");
  });

  it("surfaces whole-request refusals as ApiRequestError with the server message", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ error: "File too large. Server transport maximum: 104857600 bytes (100MB)" }), {
        status: 413,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(uploadWorkspaceFiles("project", [new File([new Uint8Array([1])], "big.bin")])).rejects.toMatchObject({
      name: "ApiRequestError",
      status: 413,
      message: expect.stringContaining("File too large"),
    });
  });

  it("reports the 25 MiB per-file product cap through failed[] verdicts, not a thrown error", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      uploadResponse({ failed: [{ name: "big.bin", code: "ETOOLARGE", error: "File exceeds the 25 MiB upload limit" }] }),
    );

    const result = await uploadWorkspaceFiles("project", [new File([new Uint8Array([1])], "big.bin")]);

    expect(result.uploaded).toEqual([]);
    expect(result.failed[0]!.code).toBe("ETOOLARGE");
  });

  it("keeps the client pre-rejection mirror equal to the server per-file cap", () => {
    /*
    FNXC:FileBrowserUpload 2026-09-05-16:11:
    RUFU-189 drift ratchet: the browser pre-rejects picks above the mirrored cap so bytes never
    stream for a guaranteed ETOOLARGE bounce. If the server cap moves, this mirror must move
    with it or the client will wave through files the server then refuses mid-batch.
    (The 20-file count bound is NOT mirrored — the server answers an oversized batch with one
    whole-request 400, which the status strip surfaces directly.)
    */
    expect(MAX_WORKSPACE_UPLOAD_FILE_BYTES).toBe(MAX_UPLOAD_FILE_SIZE);
  });
});
