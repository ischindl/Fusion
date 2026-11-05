// @vitest-environment node
/*
FNXC:PostMergeEvidenceContract 2026-11-05-04:13 (RUFU-456):
The two operator-facing surfaces (workflow editor inspector, Settings → Merge) read ONE route, so the route
is tested against the REAL engine resolver over a real throwaway repository — an injected fake resolver could
never catch a misderived reason, which is the exact failure class RUFU-430's real-repo tests exist for.

Surface enumeration covered here:
  • GET on a no-remote repo answers derived `none` / `no-remote` (the honest "this board has no reporter" row).
  • PUT + GET is the cache-invalidation PROOF: the GET before the PUT warms the process-lifetime cache, so
    without the settings-write hook the follow-up GET would keep serving the derived contract.
  • Round-trip: the PUT response and the raw settings carry the declared shape unchanged, including the
    OneDev `{provider, baseUrl, tokenSecret}` shape; `null` restores the derived status (parser treats null
    as no declaration).
  • The GET response is never enriched: no scheme-bearing URL ("://"), no absolute path, no secret-reference
    material — a git remote can carry credentials, so the route serializes the contract and nothing else.
*/
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { TaskStore } from "@fusion/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createApiRoutes } = await import("../routes.js");
const { request: performRequest } = await import("../test-request.js");

/** A throwaway `git init` checkout with NO remote — the shape a no-reporter local board really has. */
function freshGitRepoRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pmec-routes-"));
}

interface FakeStoreHarness {
  store: TaskStore;
  rawSettings: Record<string, unknown>;
  recordedAudit: Array<Record<string, unknown>>;
}

function createFakeStore(rootDir: string): FakeStoreHarness {
  const rawSettings: Record<string, unknown> = {};
  const recordedAudit: Array<Record<string, unknown>> = [];
  const store = {
    getRootDir: () => rootDir,
    readRawProjectSettings: async () => ({ ...rawSettings }),
    getSettings: async () => ({ ...rawSettings }),
    getSettingsFast: async () => ({ ...rawSettings }),
    updateSettings: async (patch: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete rawSettings[key];
        else rawSettings[key] = value;
      }
      return { ...rawSettings };
    },
    recordRunAuditEvent: (event: Record<string, unknown>) => {
      recordedAudit.push(event);
      return Promise.resolve();
    },
    on: vi.fn(),
    off: vi.fn(),
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
  } as unknown as TaskStore;
  return { store, rawSettings, recordedAudit };
}

function createApp(store: TaskStore) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return app;
}

const roots: string[] = [];
let repoRoot = "";

async function setup(): Promise<{ app: express.Express; harness: FakeStoreHarness }> {
  repoRoot = await freshGitRepoRoot();
  roots.push(repoRoot);
  execFileSync("git", ["init", "-q", "-b", "main", repoRoot], { stdio: "ignore" });
  const harness = createFakeStore(repoRoot);
  return { app: createApp(harness.store), harness };
}

function get(app: express.Express, path: string) {
  return performRequest(app, "GET", path);
}

function put(app: express.Express, path: string, body: unknown) {
  return performRequest(app, "PUT", path, JSON.stringify(body), { "Content-Type": "application/json" });
}

beforeEach(() => {
  repoRoot = "";
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GET /api/post-merge-evidence", () => {
  it("answers derived none / no-remote for a real no-remote checkout", async () => {
    const { app } = await setup();

    const res = await get(app, "/api/post-merge-evidence");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      contract: {
        provider: "none",
        source: "derived",
        reason: "no-remote",
      },
    });
    const contract = (res.body as { contract: Record<string, unknown> }).contract;
    expect(typeof contract.observedAt).toBe("string");
  });

  it("a saved declaration takes effect WITHOUT a restart (settings-write cache invalidation)", async () => {
    const { app } = await setup();

    // Warm the process-lifetime cache with the derived contract.
    const before = await get(app, "/api/post-merge-evidence");
    expect(before.body).toMatchObject({ contract: { source: "derived", reason: "no-remote" } });

    const saved = await put(app, "/api/settings", { postMergeEvidence: { provider: "none" } });
    expect(saved.status).toBe(200);

    // Without Step 1's invalidation hook this GET would STILL serve the cached derived row.
    const after = await get(app, "/api/post-merge-evidence");
    expect(after.body).toMatchObject({
      contract: { provider: "none", source: "declared", reason: "operator-declared" },
    });
  });

  it("round-trips the declaration through PUT + raw settings, restores derivation on null, and leaks nothing", async () => {
    const { app, harness } = await setup();

    const declared = { provider: "onedev", baseUrl: "http://onedev.example.test:6610", tokenSecret: "onedev-token-ref" };
    const saved = await put(app, "/api/settings", { postMergeEvidence: declared });
    expect(saved.status).toBe(200);
    // The PUT response and the raw stored shape carry the declaration back unchanged.
    expect(saved.body).toMatchObject({ postMergeEvidence: declared });
    expect(harness.rawSettings.postMergeEvidence).toEqual(declared);

    const res = await get(app, "/api/post-merge-evidence");
    expect(res.status).toBe(200);
    /*
    A `baseUrl` declaration without an origin match keeps `operator-declared` (core: the row must not claim
    a host match that never happened) while surfacing the endpoint LABEL as the contract's designed
    host[:port] fact — that label is what the status line renders, so the test pins its shape rather than
    pretending the port never appears.
    */
    expect(res.body).toMatchObject({
      contract: {
        provider: "onedev",
        source: "declared",
        reason: "operator-declared",
        endpointHost: "onedev.example.test:6610",
        credentialConfigured: true,
      },
    });
    const serialised = JSON.stringify(res.body);
    // Nothing transport-shaped or secret-shaped may ride the contract read, even though the repo's real
    // remote URL, the settings JSON, and the secret REFERENCE all exist server-side in this scenario:
    // no scheme-bearing URL ("://"), no absolute path, and the secret-reference NAME never reaches the row.
    expect(serialised).not.toContain("://");
    expect(serialised).not.toContain(repoRoot);
    expect(serialised).not.toContain("onedev-token-ref");

    // Explicit null = no declaration: the status line returns to derivation, not to a frozen declaration.
    const cleared = await put(app, "/api/settings", { postMergeEvidence: null });
    expect(cleared.status).toBe(200);
    const derived = await get(app, "/api/post-merge-evidence");
    expect(derived.body).toMatchObject({ contract: { provider: "none", source: "derived", reason: "no-remote" } });
  });
});
