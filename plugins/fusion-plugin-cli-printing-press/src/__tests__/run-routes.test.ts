import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Database } from "@fusion/core";
import { createCliPrintingPressRoutes } from "../routes/wizard-routes.js";
import type { ServiceDraft } from "../wizard/types.js";

function makeDraft(baseUrl: string): ServiceDraft {
  const now = new Date().toISOString();
  return {
    id: "",
    name: "Demo",
    slug: "demo",
    description: "",
    baseUrl,
    transport: "http",
    endpoints: [{ id: "e1", name: "Ping", method: "GET", path: "/ping" }],
    credential: { kind: "none" },
    createdAt: now,
    updatedAt: now,
  };
}

function route(method: string, path: string) {
  const found = createCliPrintingPressRoutes().find((entry) => entry.method === method && entry.path === path);
  if (!found) throw new Error(`missing route ${method} ${path}`);
  return found;
}

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  while (servers.length) servers.pop()?.close();
});

async function startServer(handler: (req: any, res: any) => void): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Invalid address");
  return `http://127.0.0.1:${addr.port}`;
}

describe("run routes", () => {
  it("regenerates and runs successfully", async () => {
    const baseUrl = await startServer((_req, res) => {
      res.statusCode = 200;
      res.end("pong");
    });
    const rootDir = await mkdtemp(join(tmpdir(), "cli-printing-press-run-routes-"));
    const db = new Database(join(rootDir, ".fusion"), { inMemory: true });
    db.init();
    const ctx = { taskStore: { getRootDir: () => rootDir, getDatabase: () => db } } as any;

    const createRes = await route("POST", "/drafts").handler({ params: {}, body: makeDraft(baseUrl) }, ctx);
    const id = (createRes.body as { id: string }).id;

    const regenRes = await route("POST", "/drafts/:id/regenerate").handler({ params: { id } }, ctx);
    expect(regenRes.status).toBe(200);
    expect((regenRes.body as any).stub).toBeUndefined();

    const runRes = await route("POST", "/drafts/:id/run").handler({ params: { id }, body: { endpointId: "e1", params: {} } }, ctx);
    expect(runRes.status).toBe(200);
    expect((runRes.body as any).stdout).toContain("pong");
  });

  it("returns validation, 404, 409, and timeout responses", async () => {
    const baseUrl = await startServer((_req, res) => {
      setTimeout(() => {
        res.statusCode = 200;
        res.end("slow");
      }, 50);
    });
    const rootDir = await mkdtemp(join(tmpdir(), "cli-printing-press-run-routes-"));
    const db = new Database(join(rootDir, ".fusion"), { inMemory: true });
    db.init();
    const ctx = { taskStore: { getRootDir: () => rootDir, getDatabase: () => db } } as any;

    const createRes = await route("POST", "/drafts").handler({ params: {}, body: makeDraft(baseUrl) }, ctx);
    const id = (createRes.body as { id: string }).id;

    const noArtifact = await route("POST", "/drafts/:id/run").handler({ params: { id }, body: { endpointId: "e1", params: {} } }, ctx);
    expect(noArtifact.status).toBe(409);

    const badBody = await route("POST", "/drafts/:id/run").handler({ params: { id }, body: { endpointId: "", params: {} } }, ctx);
    expect(badBody.status).toBe(400);

    const unknown = await route("POST", "/drafts/:id/run").handler({ params: { id: "missing" }, body: { endpointId: "e1", params: {} } }, ctx);
    expect(unknown.status).toBe(404);

    await route("POST", "/drafts/:id/regenerate").handler({ params: { id } }, ctx);
    const timeout = await route("POST", "/drafts/:id/run").handler({ params: { id }, body: { endpointId: "e1", params: {}, timeoutMs: 1 } }, ctx);
    expect(timeout.status).toBe(200);
    expect((timeout.body as any).timedOut).toBe(true);
  });
});
