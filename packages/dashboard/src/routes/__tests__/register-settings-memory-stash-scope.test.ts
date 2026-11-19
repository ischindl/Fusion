/*
FNXC:StashReadScope 2026-11-19-13:41 (RUFU-1008):
The operator surface for cross-project leakage. A Stash account is shared by every Fusion project of
one operator and its search route scopes by OWNER only, so a query can be answered with another
project's rows; the client drops them (see `stash-read-scope.test.ts` in @fusion/core) and these two
routes are what makes the drop visible. Both must carry `stashReadScope`, keyed by (configured server,
THIS project's identity) — one dashboard process serves several projects, and a server-keyed counter
would show one project's drops on another project's page.

The payload is counts and a fixed class only. These cases assert the row CONTENT never rides along,
because the whole point of the surface is to tell an operator their answer was filtered without
puting another project's memory on screen.
*/
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Router } from "express";
import {
  StashMemoryBackend,
  stashProjectIdentityFor,
} from "@fusion/core";
import { registerSettingsMemoryRoutes } from "../register-settings-memory-routes.js";

const STASH_URL = "http://scope-route.stash.test";
const roots: string[] = [];

/** One server answer: two rows of ours, one row of a foreign project, one with no identity at all. */
function fakeStashClient(ownDiscriminator: string) {
  return async () => ({
    results: [
      { id: "own-1", content: "our own line", session_id: "s-1", metadata: { discriminator: ownDiscriminator } },
      { id: "own-2", content: "another own line", session_id: "s-2", metadata: { discriminator: ownDiscriminator } },
      { id: "foreign-1", content: "TOP-SECRET other project line", session_id: "s-9", metadata: { discriminator: "VLLM-deadbeef00" } },
      { id: "mystery-1", content: "row with no project identity", session_id: "s-10", metadata: {} },
    ],
  });
}

function setup(settings: Record<string, unknown>, rootDir: string) {
  const handlers = new Map<string, (req: { body?: Record<string, unknown> }, res: { json: (v: unknown) => void }) => Promise<void>>();
  const router = {
    get: vi.fn((path: string, handler: never) => handlers.set(path, handler as never)),
    post: vi.fn((path: string, handler: never) => handlers.set(path, handler as never)),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as Router;
  const scopedStore = {
    getSettings: async () => settings,
    getProjectSettings: async () => settings,
    getRootDir: () => rootDir,
  };
  registerSettingsMemoryRoutes(
    {
      router,
      store: scopedStore as never,
      options: { engineManager: { getAllEngines: () => new Map() } } as never,
      runtimeLogger: { warn: vi.fn() } as never,
      getProjectContext: vi.fn(async () => ({ store: scopedStore })),
      rethrowAsApiError: (error: unknown): never => {
        throw error;
      },
    } as never,
    {
      validateModelPresets: () => undefined,
      sanitizeBooleanSetting: () => undefined,
      sanitizeOverlapIgnorePaths: () => undefined,
      discoverDashboardPiExtensions: async () => ({ entries: [] }) as never,
    } as never,
  );
  return {
    backend: handlers.get("/memory/backend")!,
    test: handlers.get("/memory/test")!,
  };
}

async function call(
  handler: (req: { body?: Record<string, unknown> }, res: { json: (v: unknown) => void }) => Promise<void>,
): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown> = {};
  await handler({ body: { query: "line" } }, {
    json: (value: unknown) => {
      payload = value as Record<string, unknown>;
    },
  });
  return payload;
}

describe("memory routes surface the Stash read scope (RUFU-1008)", () => {
  let rootDir = "";

  beforeEach(() => {
    // No diagnostics reset: every case gets a fresh temp root, and a project's identity is derived
    // from that root, so each case asks about a (server, project) pair nothing else recorded.
    rootDir = mkdtempSync(join(tmpdir(), "fusion-stash-scope-route-"));
    roots.push(rootDir);
    mkdirSync(join(rootDir, ".fusion/memory"), { recursive: true });
    writeFileSync(join(rootDir, ".fusion/memory/MEMORY.md"), "our own line\nanother own line\n", "utf8");
  });

  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  /** Seed the process record the way a real read does: the backend itself classifies and counts. */
  async function runScopedRead() {
    const backend = new StashMemoryBackend({
      baseUrl: STASH_URL,
      httpClient: fakeStashClient(stashProjectIdentityFor(rootDir).discriminator) as never,
    });
    const hits = await backend.search(rootDir, { query: "line", limit: 5 });
    // The read itself kept only this project's rows — the surfaces below must not contradict that.
    expect(hits).toHaveLength(2);
  }

  it("GET /memory/backend carries the counts of the last scoped read", async () => {
    await runScopedRead();
    const { backend } = setup({ memoryBackendType: "stash", stashUrl: STASH_URL }, rootDir);
    const payload = await call(backend);

    expect(payload.stashReadScope).toMatchObject({
      outcome: "dropped-foreign",
      matchedCount: 4,
      ownCount: 2,
      droppedForeignCount: 1,
      droppedUnidentifiedCount: 1,
    });
    // Counts only: no URL, no row id, no recalled text, no other project's discriminator.
    const json = JSON.stringify(payload);
    expect(json).not.toContain("TOP-SECRET");
    expect(json).not.toContain("deadbeef");
    expect(json).not.toContain(STASH_URL);
  });

  it("POST /memory/test carries the counts of the probe it just ran", async () => {
    await runScopedRead();
    // The probe itself runs on the local backend here (no network in a test); the scope it reports is
    // the record for the CONFIGURED Stash server, which is what the operator's Settings say.
    const { test } = setup({ memoryBackendType: "local", stashUrl: STASH_URL }, rootDir);
    const payload = await call(test);

    expect(payload).toHaveProperty("stashReadScope");
    expect(payload.stashReadScope).toMatchObject({
      outcome: "dropped-foreign",
      droppedForeignCount: 1,
      droppedUnidentifiedCount: 1,
    });
    expect(JSON.stringify(payload)).not.toContain("TOP-SECRET");
  });

  it("reports null when this project has read nothing — an absent record stays absent", async () => {
    const { backend, test } = setup({ memoryBackendType: "local", stashUrl: STASH_URL }, rootDir);
    expect((await call(backend)).stashReadScope).toBeNull();
    expect((await call(test)).stashReadScope).toBeNull();
  });

  it("keeps reporting the drop class after a later clean read (two-lane ordering)", async () => {
    /*
    FNXC:StashReadScope 2026-11-19-16:08 (RUFU-1008 code review, P1):
    The per-turn recall searches twice per turn and reports once, so a clean focus-lane answer follows
    a filtered project-lane answer within one invocation. If the surface showed only the newest read,
    the operator would see "nothing dropped" for a turn that had just dropped another project's rows —
    so the record, and this surface, keep the worse class. `at` is what lets a reader weigh it.
    */
    const ownDisc = stashProjectIdentityFor(rootDir).discriminator;
    let keywordReads = 0;
    const seeding = new StashMemoryBackend({
      baseUrl: STASH_URL,
      httpClient: (async () => {
        keywordReads += 1;
        if (keywordReads === 1) return fakeStashClient(ownDisc)();
        return { results: [{ id: "own-1", content: "our own line", session_id: "s-1", metadata: { discriminator: ownDisc } }] };
      }) as never,
    });
    await seeding.search(rootDir, { query: "line", limit: 5 });
    await seeding.search(rootDir, { query: "own", limit: 5 });

    const { backend } = setup({ memoryBackendType: "stash", stashUrl: STASH_URL }, rootDir);
    const payload = await call(backend);
    // The counts are the FILTERED read's, not the clean one's that followed it.
    expect(payload.stashReadScope).toMatchObject({
      outcome: "dropped-foreign",
      ownCount: 2,
      droppedForeignCount: 1,
      droppedUnidentifiedCount: 1,
    });
  });

  it("does not show another project's drop count on this project's page", async () => {
    // The seed read belongs to a DIFFERENT project root (a different discriminator on the same server).
    const otherRoot = mkdtempSync(join(tmpdir(), "fusion-stash-scope-route-other-"));
    roots.push(otherRoot);
    mkdirSync(join(otherRoot, ".fusion/memory"), { recursive: true });
    const otherBackend = new StashMemoryBackend({
      baseUrl: STASH_URL,
      httpClient: fakeStashClient(stashProjectIdentityFor(otherRoot).discriminator) as never,
    });
    await otherBackend.search(otherRoot, { query: "line", limit: 5 });

    const { backend } = setup({ memoryBackendType: "stash", stashUrl: STASH_URL }, rootDir);
    expect((await call(backend)).stashReadScope).toBeNull();
  });
});
