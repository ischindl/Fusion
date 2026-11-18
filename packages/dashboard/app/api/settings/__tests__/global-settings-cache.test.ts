/*
FNXC:IdleBoardReadCost 2026-11-18-09:14 (RUFU-479) — the settings cache, and the invalidations it owes.

`/api/settings/global` was fetched four times by one board load: each consumer mounted and asked, and
`api/client/dedupe.ts` only collapses calls that overlap IN FLIGHT, so two asks 300 ms apart are two
requests. The layer that answers the second ask is the short-TTL cache dedupe's own header says belongs
above it. That layer is only honest while three invariants hold, and each is a case below:

  1. READ SHARING: concurrent and near-concurrent consumers share one request.
  2. WRITE INVALIDATION: `updateGlobalSettings` clears the snapshot it just made stale, so the next reader
     cannot be served a pre-save object.
  3. A LATE RESPONSE MAY NOT RESURRECT STALE DATA. A read that started before an invalidation is not
     allowed to repopulate the cache when it settles after it - this is the case a TTL cache gets wrong,
     because the response is perfectly valid and simply old.

Plus the constraint that decides the whole design: this payload carries `daemonToken`, `githubAuthToken`
and `gitlabAuthToken`, so the cache is memory-only and nothing is ever written to a browser store.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchGlobalSettings,
  hasCachedGlobalSettings,
  invalidateGlobalSettingsCache,
  updateGlobalSettings,
} from "../global-and-pi-settings.js";

let fetchCount = 0;
let serverSnapshot: Record<string, unknown> = { themeMode: "dark", experimentalFeatures: { claudeCliAcp: true } };
let responseDelayMs = 0;

function stubTransport(): void {
  vi.stubGlobal("fetch", vi.fn(async () => {
    fetchCount += 1;
    const served = serverSnapshot;
    if (responseDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
    return new Response(JSON.stringify(served), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }));
}

beforeEach(() => {
  fetchCount = 0;
  responseDelayMs = 0;
  serverSnapshot = { themeMode: "dark", experimentalFeatures: { claudeCliAcp: true } };
  invalidateGlobalSettingsCache();
  localStorage.clear();
  sessionStorage.clear();
  stubTransport();
});

afterEach(() => {
  vi.unstubAllGlobals();
  invalidateGlobalSettingsCache();
});

describe("global settings cache (RUFU-479)", () => {
  it("shares one request between consumers that mount together", async () => {
    const [first, second, third] = await Promise.all([
      fetchGlobalSettings(),
      fetchGlobalSettings(),
      fetchGlobalSettings(),
    ]);

    expect(fetchCount).toBe(1);
    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });

  it("serves a consumer that asks after the first one finished, inside the window", async () => {
    await fetchGlobalSettings();
    expect(fetchCount).toBe(1);
    expect(hasCachedGlobalSettings()).toBe(true);

    await fetchGlobalSettings();
    expect(fetchCount).toBe(1);
  });

  it("invalidates on save, so the next reader cannot see a pre-save snapshot", async () => {
    await fetchGlobalSettings();
    expect(fetchCount).toBe(1);

    serverSnapshot = { ...serverSnapshot, themeMode: "light" };
    await updateGlobalSettings({ themeMode: "light" } as never);
    // The save itself is one transport call, so 2 reads + 1 write is the honest count after the next read.
    expect(fetchCount).toBe(2);
    expect(hasCachedGlobalSettings()).toBe(false);

    const after = await fetchGlobalSettings();
    expect(fetchCount).toBe(3);
    expect(after).toMatchObject({ themeMode: "light" });
  });

  it("serves a read-modify-write the server snapshot, so a sibling key written elsewhere survives the merge", async () => {
    const cached = await fetchGlobalSettings();
    expect(Object.keys(cached)).not.toContain("dashboardCurrentProjectIdByNode");

    // Another surface (or tab) writes a sibling key after this snapshot was taken.
    serverSnapshot = { ...serverSnapshot, dashboardCurrentProjectIdByNode: { nodeA: "project-9" } };

    const freshForMerge = await fetchGlobalSettings({ forceFresh: true });
    expect(fetchCount).toBe(2);
    const merged = { ...freshForMerge, themeMode: "light" } as Record<string, unknown>;
    expect(merged.dashboardCurrentProjectIdByNode).toEqual({ nodeA: "project-9" });

    // The stale snapshot the merge must NOT be built on is still the object the cached call returned.
    expect(cached).not.toHaveProperty("dashboardCurrentProjectIdByNode");
  });

  it("refuses to let a response that started before an invalidation repopulate the cache", async () => {
    responseDelayMs = 20;
    const slowRead = fetchGlobalSettings();
    // A save lands while that read is still in flight, and the server's next answer differs from the one
    // the in-flight read is already carrying.
    serverSnapshot = { ...serverSnapshot, themeMode: "light" };
    const settledSave = updateGlobalSettings({ themeMode: "light" } as never);
    await settledSave;
    await slowRead;

    expect(hasCachedGlobalSettings()).toBe(false);

    const after = await fetchGlobalSettings();
    expect(after).toMatchObject({ themeMode: "light" });
  });

  it("keeps the payload out of every browser storage", async () => {
    serverSnapshot = { daemonToken: "daemon-secret", githubAuthToken: "gh-secret" };
    const settings = await fetchGlobalSettings();
    expect(settings).toMatchObject({ daemonToken: "daemon-secret" });

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("does not leave a stale snapshot armed when the read fails", async () => {
    await fetchGlobalSettings();
    expect(hasCachedGlobalSettings()).toBe(true);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    invalidateGlobalSettingsCache();
    await expect(fetchGlobalSettings()).rejects.toThrow();
    expect(hasCachedGlobalSettings()).toBe(false);
  });
});
