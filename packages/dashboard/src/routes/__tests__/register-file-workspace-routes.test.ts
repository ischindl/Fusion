// @vitest-environment node

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import express from "express";
import multer from "multer";
import type { TaskStore } from "@fusion/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api-error.js";
import { registerFileWorkspaceRoutes } from "../register-file-workspace-routes.js";
import type { ApiRoutesContext } from "../types.js";
import { request as REQUEST } from "../../test-request.js";

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fusion-file-workspace-routes-"));
  tempRoots.push(root);
  return root;
}

function makeApp(store: Partial<TaskStore>) {
  const router = express.Router();
  const app = express();
  registerFileWorkspaceRoutes({
    router,
    store: store as TaskStore,
    /*
    FNXC:FileBrowserUpload 2026-09-05-15:01:
    The upload route receives multer through the same injected seam production mounts with
    ({ ...routeContext, workspaceUpload: upload }), and the harness mirrors production limits
    (100 MB transport) so the 25 MB per-file PRODUCT cap under test is the one being exercised.
    */
    workspaceUpload: multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 100 * 1024 * 1024 },
    }),
    runtimeLogger: {} as never,
    planningLogger: {} as never,
    chatLogger: {} as never,
    getProjectIdFromRequest: vi.fn(),
    getScopedStore: vi.fn(async () => store as TaskStore),
    getProjectContext: vi.fn(async () => ({ store: store as TaskStore, engine: undefined, projectId: undefined })),
    prioritizeProjectsForCurrentDirectory: vi.fn((projects) => projects),
    emitRemoteRouteDiagnostic: vi.fn(),
    emitAuthSyncAuditLog: vi.fn(),
    parseScopeParam: vi.fn(),
    resolveAutomationStore: vi.fn(),
    resolveRoutineStore: vi.fn(),
    resolveRoutineRunner: vi.fn(),
    registerDispose: vi.fn(),
    dispose: vi.fn(),
    rethrowAsApiError(error: unknown, fallbackMessage?: string): never {
      throw error instanceof Error ? error : new Error(fallbackMessage ?? String(error));
    },
  } as ApiRoutesContext);
  // Production parses JSON before the router; the wildcard text-save (and its pass-through from
  // POST /files/upload for non-multipart requests) needs that same parser here.
  app.use(express.json());
  app.use("/api", router);
  const errorHandler: express.ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(error instanceof ApiError ? error.statusCode : 500).json({ error: error instanceof Error ? error.message : String(error) });
  };
  app.use(errorHandler);
  return app;
}

async function writeFixture(root: string, filePath: string, content = "fixture-bytes"): Promise<void> {
  const pathParts = filePath.split("/");
  const fileName = pathParts.pop();
  if (!fileName) {
    throw new Error(`Fixture path must include a file name: ${filePath}`);
  }
  const directoryPath = join(root, ...pathParts);
  await mkdir(directoryPath, { recursive: true });
  await writeFile(join(directoryPath, fileName), Buffer.from(content));
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file workspace download route", () => {
  it.each([
    ["assets/logo.png", "image/png"],
    ["icons/mark.svg", "image/svg+xml"],
    ["media/demo.mp4", "video/mp4"],
    ["audio/theme.mp3", "audio/mpeg"],
    ["docs/spec.pdf", "application/pdf"],
    ["nested/CAPTURE.PNG", "image/png"],
  ])("serves previewable file %s inline with renderable headers", async (filePath, expectedContentType) => {
    const root = await makeRoot();
    await writeFixture(root, filePath);
    const app = makeApp({ getRootDir: vi.fn(() => root) });

    const res = await REQUEST(app, "GET", `/api/files/${encodeURIComponent(filePath)}/download?workspace=project&inline=1`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe(expectedContentType);
    expect(res.headers["content-disposition"]).toBe(`inline; filename="${filePath.split("/").at(-1)}"`);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("sandbox");
    expect(res.body).toBe("fixture-bytes");
  });

  it.each([
    "assets/logo.png",
    "icons/mark.svg",
    "media/demo.mp4",
    "audio/theme.mp3",
    "docs/spec.pdf",
  ])("keeps the default download contract for %s as attachment octet-stream", async (filePath) => {
    const root = await makeRoot();
    await writeFixture(root, filePath);
    const app = makeApp({ getRootDir: vi.fn(() => root) });

    const res = await REQUEST(app, "GET", `/api/files/${encodeURIComponent(filePath)}/download?workspace=project`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="${filePath.split("/").at(-1)}"`);
    expect(res.headers["x-content-type-options"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).toBeUndefined();
    expect(res.body).toBe("fixture-bytes");
  });

  it("falls back to attachment for inline requests with unknown binary extensions", async () => {
    const root = await makeRoot();
    await writeFixture(root, "archives/build.zip");
    const app = makeApp({ getRootDir: vi.fn(() => root) });

    const res = await REQUEST(app, "GET", `/api/files/${encodeURIComponent("archives/build.zip")}/download?workspace=project&inline=1`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toBe("attachment; filename=\"build.zip\"");
    expect(res.headers["x-content-type-options"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });

  it("serves task workspace preview files inline while preserving projectId query propagation", async () => {
    const root = await makeRoot();
    const taskDir = join(root, ".fusion", "tasks", "FN-123");
    await writeFixture(taskDir, "screens/shot.JPG");
    const store = {
      getRootDir: vi.fn(() => root),
      getTask: vi.fn(async () => ({ id: "FN-123", title: "Task" })),
      getTaskDir: vi.fn(() => taskDir),
    };
    const app = makeApp(store);

    const res = await REQUEST(app, "GET", `/api/files/${encodeURIComponent("screens/shot.JPG")}/download?workspace=FN-123&projectId=project-a&inline=true`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["content-disposition"]).toBe("inline; filename=\"shot.JPG\"");
    expect(store.getTask).toHaveBeenCalledWith("FN-123");
  });
});

function expectZipResponse(res: Awaited<ReturnType<typeof REQUEST>>, name: string): void {
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toBe("application/zip");
  expect(res.headers["content-disposition"]).toBe(`attachment; filename="${name}.zip"`);
  expect(res.bodyBuffer.length).toBeGreaterThan(0);
}

function expectZipEntry(res: Awaited<ReturnType<typeof REQUEST>>, entryPath: string): void {
  expect(res.bodyBuffer.includes(Buffer.from(entryPath))).toBe(true);
}

describe("file workspace download-zip route", () => {
  it("returns a ZIP containing a populated directory", async () => {
    const root = await makeRoot();
    await writeFixture(root, "docs/readme.txt", "known-readme-bytes");
    const app = makeApp({ getRootDir: vi.fn(() => root) });

    const res = await REQUEST(app, "GET", "/api/files/docs/download-zip?workspace=project");

    expectZipResponse(res, "docs");
    expect(res.bodyBuffer.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expectZipEntry(res, "docs/readme.txt");
  });

  it("recursively includes nested directory entries", async () => {
    const root = await makeRoot();
    await writeFixture(root, "bundle/root.txt");
    await writeFixture(root, "bundle/inner/deep.txt");
    const app = makeApp({ getRootDir: vi.fn(() => root) });

    const res = await REQUEST(app, "GET", "/api/files/bundle/download-zip?workspace=project");

    expectZipResponse(res, "bundle");
    expectZipEntry(res, "bundle/root.txt");
    expectZipEntry(res, "bundle/inner/deep.txt");
  });

  it("returns a completed empty ZIP archive", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "empty"));
    const app = makeApp({ getRootDir: vi.fn(() => root) });

    const res = await REQUEST(app, "GET", "/api/files/empty/download-zip?workspace=project");

    expectZipResponse(res, "empty");
    expect(res.bodyBuffer.subarray(0, 2)).toEqual(Buffer.from([0x50, 0x4b]));
  });

  it.each([
    [404, "missing"],
    [400, "docs/readme.txt"],
  ])("preserves the %i error mapping", async (expectedStatus, filePath) => {
    const root = await makeRoot();
    await writeFixture(root, "docs/readme.txt");
    const app = makeApp({ getRootDir: vi.fn(() => root) });

    const res = await REQUEST(app, "GET", `/api/files/${encodeURIComponent(filePath)}/download-zip?workspace=project`);

    expect(res.status).toBe(expectedStatus);
  });
});

/*
FNXC:FileBrowserUpload 2026-09-05-15:01:
RUFU-189 upload contract: binary bytes land untouched, destination = form `path` field, collision
defaults to a per-file EEXIST refusal (replacement only with an explicit overwrite=true, which the
UI sends only after operator confirmation), one bad file never sinks the batch, and non-multipart
POST /api/files/upload still reaches the generic wildcard write route (a root file named "upload"
remains savable). Byte identity is asserted against the real filesystem here — mocked-fs unit
tests can only prove argument pass-through.
*/
describe("POST /api/files/upload (browser uploads)", () => {
  type Part = { field: string; filename?: string; contentType?: string; value: Buffer };

  function buildMultipartBody(parts: Part[]): { body: Buffer; contentType: string } {
    const boundary = "----fusion-upload-test";
    const chunks: Buffer[] = [];
    for (const part of parts) {
      let disposition = `Content-Disposition: form-data; name="${part.field}"`;
      if (part.filename !== undefined) {
        disposition += `; filename="${part.filename}"`;
      }
      chunks.push(Buffer.from(`--${boundary}\r\n${disposition}\r\n${part.contentType ? `Content-Type: ${part.contentType}\r\n` : ""}\r\n`));
      chunks.push(part.value);
      chunks.push(Buffer.from("\r\n"));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
  }

  async function uploadRequest(root: string, parts: Part[], query = "?workspace=project", onBodyDelivered?: (req: IncomingMessage) => Promise<void>) {
    const app = makeApp({ getRootDir: vi.fn(() => root) });
    const { body, contentType } = buildMultipartBody(parts);
    return await REQUEST(app, "POST", `/api/files/upload${query}`, body, { "content-type": contentType }, undefined, onBodyDelivered);
  }

  it("writes binary bytes byte-for-byte into the requested destination directory", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "assets"));
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80]);

    const res = await uploadRequest(root, [
      { field: "path", value: Buffer.from("assets") },
      { field: "files", filename: "logo.png", contentType: "image/png", value: pngBytes },
    ]);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uploaded: [{ name: "logo.png", path: "assets/logo.png", size: pngBytes.length }] });
    const written = await readFile(join(root, "assets/logo.png"));
    expect(written.equals(pngBytes)).toBe(true);
  });

  it("refuses an existing file with a per-file EEXIST verdict by default", async () => {
    const root = await makeRoot();

    const first = await uploadRequest(root, [{ field: "files", filename: "a.txt", value: Buffer.from("one") }]);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ uploaded: [{ name: "a.txt", path: "a.txt" }] });

    const second = await uploadRequest(root, [{ field: "files", filename: "a.txt", value: Buffer.from("two") }]);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ uploaded: [], failed: [{ name: "a.txt", code: "EEXIST" }] });
    expect(await readFile(join(root, "a.txt"), "utf-8")).toBe("one");
  });

  it("replaces an existing file only when the request explicitly sends overwrite=true", async () => {
    const root = await makeRoot();
    await uploadRequest(root, [{ field: "files", filename: "a.txt", value: Buffer.from("one") }]);

    const res = await uploadRequest(root, [
      { field: "files", filename: "a.txt", value: Buffer.from("two") },
      { field: "overwrite", value: Buffer.from("true") },
    ]);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uploaded: [{ name: "a.txt" }], failed: [] });
    expect(await readFile(join(root, "a.txt"), "utf-8")).toBe("two");
  });

  it("fails one oversized file alone while the rest of the batch lands", async () => {
    const root = await makeRoot();
    const overCap = Buffer.alloc(25 * 1024 * 1024 + 1, 0x61);

    const res = await uploadRequest(root, [
      { field: "files", filename: "ok.txt", value: Buffer.from("small") },
      { field: "files", filename: "big.bin", value: overCap },
    ]);

    expect(res.status).toBe(200);
    const body = res.body as { uploaded: Array<{ name: string }>; failed: Array<{ name: string; code: string }> };
    expect(body.uploaded.map((f) => f.name)).toEqual(["ok.txt"]);
    expect(body.failed).toMatchObject([{ name: "big.bin", code: "ETOOLARGE" }]);
    expect(await readFile(join(root, "ok.txt"), "utf-8")).toBe("small");
    expect(existsSync(join(root, "big.bin"))).toBe(false);
  });

  it("refuses more than 20 files per request outright", async () => {
    const root = await makeRoot();
    const parts: Part[] = Array.from({ length: 21 }, (_, i) => ({
      field: "files",
      filename: `f${i}.txt`,
      value: Buffer.from(`file ${i}`),
    }));

    /*
    FNXC:FileBrowserUpload 2026-09-05-15:01:
    multer aborts the over-limit upload but (drain-before-respond) defers its response until the
    request 'end' arrives AFTER its abort registers the end listener — with 20 files still
    buffering, that registration lands ticks after the harness's synchronous data+end, so the
    response would never come (a real client is still mid-upload when the cap fires). Quiesce the
    in-memory pipeline (bounded tick window, ~50x the settling cost of 21 tiny parts) before
    finishing the stream so the deferred response can complete.
    */
    const res = await uploadRequest(root, parts, undefined, async () => {
      for (let i = 0; i < 5000; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    });

    expect(res.status).toBe(400);
    expect(existsSync(join(root, "f0.txt"))).toBe(false);
  });

  it("rejects uploads whose files arrive under a foreign field name", async () => {
    const root = await makeRoot();

    const res = await uploadRequest(root, [{ field: "file", filename: "x.txt", value: Buffer.from("x") }]);

    expect(res.status).toBe(400);
  });

  it("strips client-supplied path separators out of upload names so files land in the browsed directory", async () => {
    const root = await makeRoot();

    const res = await uploadRequest(root, [
      { field: "files", filename: "evil/../../escape.png", value: Buffer.from([0xff, 0x00]) },
    ]);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uploaded: [{ name: "escape.png", path: "escape.png" }] });
    expect(existsSync(join(root, "escape.png"))).toBe(true);
    // Nothing may appear one level above the workspace root (the traversal target of "../../").
    expect(existsSync(join(dirname(root), "escape.png"))).toBe(false);
  });

  it("reports a per-file failure when the destination directory does not exist", async () => {
    const root = await makeRoot();

    const res = await uploadRequest(root, [
      { field: "path", value: Buffer.from("missing-dir") },
      { field: "files", filename: "x.txt", value: Buffer.from("x") },
    ]);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uploaded: [], failed: [{ name: "x.txt", code: "ENOENT" }] });
  });

  it("still routes non-multipart POST /api/files/upload to the generic wildcard text-save", async () => {
    const root = await makeRoot();
    const app = makeApp({ getRootDir: vi.fn(() => root) });

    const res = await REQUEST(app, "POST", "/api/files/upload?workspace=project", JSON.stringify({ content: "root-file" }), { "content-type": "application/json" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(await readFile(join(root, "upload"), "utf-8")).toBe("root-file");
  });
});
