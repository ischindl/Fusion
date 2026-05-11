import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Database } from "@fusion/core";
import { createCliPrintingPressRoutes } from "../routes/wizard-routes";
import type { ServiceDraft } from "../wizard/types";

function makeDraft(): ServiceDraft {
  const now = new Date().toISOString();
  return { id: "", name: "Demo", slug: "demo", description: "", baseUrl: "https://example.com", transport: "http", endpoints: [{ id: "e1", name: "Ping", method: "GET", path: "/ping" }], credential: { kind: "none" }, createdAt: now, updatedAt: now };
}

function route(method: string, path: string) {
  const found = createCliPrintingPressRoutes().find((entry) => entry.method === method && entry.path === path);
  if (!found) throw new Error(`missing route ${method} ${path}`);
  return found;
}

describe("wizard routes", () => {
  it("handles create/get/delete lifecycle", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "cli-printing-press-routes-"));
    const db = new Database(join(rootDir, ".fusion"), { inMemory: true });
    db.init();
    const ctx = { taskStore: { getRootDir: () => rootDir, getDatabase: () => db } } as any;

    const createRes = await route("POST", "/drafts").handler({ params: {}, body: makeDraft() }, ctx);
    expect(createRes.status).toBe(201);
    const id = (createRes.body as { id: string }).id;

    const getRes = await route("GET", "/drafts/:id").handler({ params: { id } }, ctx);
    expect(getRes.status).toBe(200);

    const missRes = await route("GET", "/drafts/:id").handler({ params: { id: "missing" } }, ctx);
    expect(missRes.status).toBe(404);

    const invalidRes = await route("POST", "/drafts").handler({ params: {}, body: { ...makeDraft(), slug: "Bad Slug" } }, ctx);
    expect(invalidRes.status).toBe(400);
    expect((invalidRes.body as { errors: Record<string, string> }).errors.slug).toBeTruthy();

    const putRes = await route("PUT", "/drafts/:id").handler({ params: { id }, body: { ...makeDraft(), id, name: "Renamed" } }, ctx);
    expect(putRes.status).toBe(200);
    expect((putRes.body as { name: string }).name).toBe("Renamed");

    const invalidPutRes = await route("PUT", "/drafts/:id").handler({ params: { id }, body: { ...makeDraft(), id, baseUrl: "invalid-url" } }, ctx);
    expect(invalidPutRes.status).toBe(400);

    const missingPutRes = await route("PUT", "/drafts/:id").handler({ params: { id: "missing" }, body: { ...makeDraft(), id: "missing" } }, ctx);
    expect(missingPutRes.status).toBe(404);

    const regenRes = await route("POST", "/drafts/:id/regenerate").handler({ params: { id } }, ctx);
    expect(regenRes.status).toBe(200);
    expect((regenRes.body as { artifact?: { binPath: string } }).artifact?.binPath).toBeTruthy();

    const missingRegenRes = await route("POST", "/drafts/:id/regenerate").handler({ params: { id: "missing" } }, ctx);
    expect(missingRegenRes.status).toBe(404);

    const deleteRes = await route("DELETE", "/drafts/:id").handler({ params: { id } }, ctx);
    expect(deleteRes.status).toBe(204);
  });
});
