/**
 * FNXC:CodeOrganization 2026-07-17-12:00:
 * Global settings and pi-extension/package client API peeled from legacy.ts.
 */
import type { GlobalSettings, ProjectSettings, Settings } from "@fusion/core";
import { api } from "../client/client.js";
import type { FetchOptions } from "../client/client.js";
import { withProjectId } from "../client/health.js";
import { dedupe } from "../client/dedupe.js";

export interface GlobalSettingsFetchOptions extends FetchOptions {
  /**
   * Bypass the short-TTL memory cache. Mandatory for any read-modify-write: a caller that reads settings,
   * mutates one key, and PUTs the merged object back must read the SERVER snapshot, not a cached one.
   */
  forceFresh?: boolean;
}

/*
FNXC:IdleBoardReadCost 2026-11-18-08:38 (RUFU-479): one bounded settings read per view, not one per consumer.

`/api/settings/global` was fetched FOUR times by a single board load - every consumer mounted, asked, and
joined nothing because the reads were spaced past the in-flight window that `api/client/dedupe.ts` coalesces.
Dedupe collapses a BURST; it cannot serve a second consumer that asks 300 ms later. The missing layer is the
short-TTL cache its own header says belongs above it, so that is where this sits.

The bound is deliberately tiny (5 s) for the same reason the payload is the constraint: this response carries
`daemonToken`, `githubAuthToken` and `gitlabAuthToken`. Rules that follow from that:
  * MEMORY ONLY. Nothing here is ever written to sessionStorage/localStorage/indexedDB, and the cache holds
    the one object the caller already had - no copy, no derivative, no log of its contents;
  * a WRITE invalidates. `updateGlobalSettings` clears this cache in the same call that PUTs, and a caller
    that must observe post-mutation state passes `forceFresh`, which both skips the cache and clears it -
    so the cache can never outlive a change it has not seen;
  * a response that STARTED before an invalidation may not RE-ARM it. `invalidateEpoch` is compared when the
    fetch settles, which is the only way to keep a slow pre-save response from resurrecting pre-save data in
    the 5 s window after the save.

Rejected alternative: raising dedupe's window. That is the same staleness bought without the invalidation
half, and it would apply to every endpoint dedupe serves.
*/
const GLOBAL_SETTINGS_TTL_MS = 5_000;

let globalSettingsCache: { value: GlobalSettings; expiresAt: number } | null = null;
let invalidateEpoch = 0;

/** Drop the cached global-settings snapshot. Exported for callers that mutate settings outside this module. */
export function invalidateGlobalSettingsCache(): void {
  invalidateEpoch += 1;
  globalSettingsCache = null;
}

/** Test seam: whether a snapshot is currently held and still inside its window. */
export function hasCachedGlobalSettings(): boolean {
  return globalSettingsCache !== null && globalSettingsCache.expiresAt > Date.now();
}

export function fetchGlobalSettings(options?: GlobalSettingsFetchOptions): Promise<GlobalSettings> {
  const now = Date.now();
  if (!options?.forceFresh && globalSettingsCache && globalSettingsCache.expiresAt > now) {
    return Promise.resolve(globalSettingsCache.value);
  }
  if (options?.forceFresh) {
    // A fresh read is also an invalidation: any older in-flight response must not repopulate the cache.
    invalidateEpoch += 1;
    globalSettingsCache = null;
  }
  const epochAtRequest = invalidateEpoch;
  return dedupe("/settings/global", () => api<GlobalSettings>("/settings/global"), options).then((value) => {
    if (epochAtRequest === invalidateEpoch) {
      globalSettingsCache = { value, expiresAt: Date.now() + GLOBAL_SETTINGS_TTL_MS };
    }
    return value;
  }, (error: unknown) => {
    // A failed read must not leave a stale snapshot looking fresh to the next consumer.
    if (epochAtRequest === invalidateEpoch) globalSettingsCache = null;
    throw error;
  });
}

/** Update global (user-level) settings. These persist across all fn projects. */
export function updateGlobalSettings(settings: Partial<GlobalSettings>): Promise<Settings> {
  // Write-invalidate at the same seam the write is issued, so no consumer can read a pre-save snapshot
  // out of the TTL window after this call has been made.
  invalidateGlobalSettingsCache();
  return api<Settings>("/settings/global", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

/** Fetch settings separated by scope: { global, project } */
export function fetchSettingsByScope(projectId?: string): Promise<{ global: GlobalSettings; project: Partial<ProjectSettings> }> {
  return api<{ global: GlobalSettings; project: Partial<ProjectSettings> }>(withProjectId("/settings/scopes", projectId));
}

export interface PiExtensionEntry {
  id: string;
  name: string;
  path: string;
  source: "fusion-global" | "pi-global" | "fusion-project" | "pi-project" | "package";
  enabled: boolean;
}

export interface PiExtensionSettings {
  extensions: PiExtensionEntry[];
  disabledIds: string[];
  settingsPath: string;
}

export function fetchPiExtensions(projectId?: string): Promise<PiExtensionSettings> {
  return api<PiExtensionSettings>(withProjectId("/settings/pi-extensions", projectId));
}

export function updatePiExtensions(disabledIds: string[], projectId?: string): Promise<PiExtensionSettings> {
  return api<PiExtensionSettings>(withProjectId("/settings/pi-extensions", projectId), {
    method: "PUT",
    body: JSON.stringify({ disabledIds }),
  });
}

/**
 * Test a notification provider by sending a test notification.
 * Supports "ntfy" and "webhook" provider IDs.
 */
export function testNotification(providerId: string, config?: Record<string, unknown>, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId("/settings/test-notification", projectId), {
    method: "POST",
    // Pin providerId last so config.providerId cannot override the selected provider.
    body: JSON.stringify({ ...(config ?? {}), providerId }),
  });
}

/**
 * Backward-compatible ntfy test helper.
 * Wraps testNotification() while preserving the legacy function signature.
 */
export function testNtfyNotification(
  config?: {
    ntfyEnabled?: boolean;
    ntfyTopic?: string;
    ntfyBaseUrl?: string;
    ntfyAccessToken?: string;
  },
  projectId?: string,
): Promise<{ success: boolean }> {
  return testNotification("ntfy", config as Record<string, unknown> | undefined, projectId);
}

/** Pi extension settings from ~/.pi/agent/settings.json (global scope) */
export interface PiSettings {
  packages: Array<string | { source: string; extensions?: string[]; skills?: string[]; prompts?: string[]; themes?: string[] }>;
  extensions: string[];
  skills: string[];
  prompts: string[];
  themes: string[];
}

/** Fetch pi extension settings (global scope from ~/.pi/agent/settings.json) */
export function fetchPiSettings(): Promise<PiSettings> {
  return api<PiSettings>("/pi-settings");
}

/** Update pi extension settings (partial update, global scope) */
export async function updatePiSettings(settings: Partial<PiSettings>): Promise<{ success: boolean }> {
  return api<{ success: boolean }>("/pi-settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

/** Install a new pi package source (adds to ~/.pi/agent/settings.json) */
export async function installPiPackage(source: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>("/pi-settings/packages", {
    method: "POST",
    body: JSON.stringify({ source }),
  });
}

/** Reinstall Fusion's bundled pi package and ensure it remains in global Pi settings. */
export async function reinstallFusionPiPackage(projectId?: string): Promise<{ success: boolean; source: string }> {
  return api<{ success: boolean; source: string }>(withProjectId("/pi-settings/reinstall-fusion", projectId), {
    method: "POST",
  });
}

