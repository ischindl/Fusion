/**
 * FNXC:SettingsOpenLatency 2026-11-09-14:30 (RUFU-908):
 * The two request-path settings readers (`getSettingsFast`, `getSettingsByScopeFast`) back
 * `GET /api/settings` and `GET /api/settings/scopes`, which together gate the Settings modal — the modal body
 * stays a spinner until both answer. Each reader used to await
 * `hasSyncPassphraseConfigured(await store.getSecretsStore())` AFTER its two settings reads had settled, so a
 * single boolean (`secretsSyncPassphraseConfigured`) cost a third serial database round trip on a pool capped
 * at `DEFAULT_POOL_MAX = 3`. That flag is not an input to the settings merge and the merge is not an input to
 * it, so the hop was pure latency.
 *
 * These cases pin both halves: the probe now overlaps the settings reads (the trace below goes RED on the old
 * sequential spelling), and everything the readers return — the flag, the global/project split, the
 * swallow-failure-to-`false` behaviour, and which error a failing read surfaces — is unchanged.
 *
 * The overlap assertion is a call-interleave trace, never a wall-clock comparison: this repo forbids real time
 * waits in tests, and a timing assertion would only ever prove the machine was busy.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const callTrace: string[] = [];

/** Swappable per-case behaviour for the two fakes below; `undefined` keeps the default answer. */
let projectSettingsImpl: (() => unknown) | undefined;
let passphraseImpl: (() => unknown) | undefined;

vi.mock("../task-store/async/async-settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../task-store/async/async-settings.js")>()),
  readProjectSettings: vi.fn(async () => {
    callTrace.push("projectSettings:start");
    await Promise.resolve();
    callTrace.push("projectSettings:end");
    if (projectSettingsImpl) return projectSettingsImpl();
    return { maxConcurrent: 2, maxWorktrees: 6 };
  }),
  readProjectConfig: vi.fn(async () => ({ settings: {} })),
}));

vi.mock("../secrets/secrets-sync-passphrase.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../secrets/secrets-sync-passphrase.js")>()),
  hasSyncPassphraseConfigured: vi.fn(async () => {
    callTrace.push("passphrase:start");
    await Promise.resolve();
    if (passphraseImpl) return passphraseImpl();
    return true;
  }),
}));

const { getSettingsFastImpl, getSettingsByScopeFastImpl } = await import("../task-store/settings-ops-2.js");

function createFakeStore(globalSettings: Record<string, unknown> = { maxConcurrent: 9, maxWorktrees: 9 }) {
  return {
    asyncLayer: { projectId: "proj_test" },
    globalSettingsStore: {
      getSettings: vi.fn(async () => {
        callTrace.push("globalSettings:start");
        await Promise.resolve();
        callTrace.push("globalSettings:end");
        return { ...globalSettings };
      }),
    },
    getSecretsStore: vi.fn(async () => ({ scope: "global" })),
    settingsSyncCache: undefined,
  };
}

function resetCase() {
  callTrace.length = 0;
  projectSettingsImpl = undefined;
  passphraseImpl = undefined;
}

describe("fast settings reads overlap the sync-passphrase probe", () => {
  beforeEach(() => {
    resetCase();
    vi.clearAllMocks();
  });

  it("getSettingsFast issues the secrets probe alongside its settings reads", async () => {
    const store = createFakeStore();

    const settings = await getSettingsFastImpl(store as never);

    expect(settings.secretsSyncPassphraseConfigured).toBe(true);
    expect(store.getSecretsStore).toHaveBeenCalledTimes(1);
    // RUFU-908 ratchet. The probe must be issued while a settings read is still in flight; the old
    // sequential spelling traced globalSettings:start, globalSettings:end, projectSettings:start,
    // projectSettings:end, passphrase:start.
    expect([...callTrace.slice(0, 3)].sort()).toEqual([
      "globalSettings:start",
      "passphrase:start",
      "projectSettings:start",
    ]);
    expect(callTrace.indexOf("passphrase:start")).toBeLessThan(callTrace.indexOf("globalSettings:end"));
    expect(callTrace.indexOf("passphrase:start")).toBeLessThan(callTrace.indexOf("projectSettings:end"));
  });

  it("getSettingsByScopeFast issues the secrets probe alongside its settings reads", async () => {
    const store = createFakeStore();

    const scopes = await getSettingsByScopeFastImpl(store as never);

    expect(scopes.global.secretsSyncPassphraseConfigured).toBe(true);
    expect([...callTrace.slice(0, 3)].sort()).toEqual([
      "globalSettings:start",
      "passphrase:start",
      "projectSettings:start",
    ]);
  });

  it("keeps the populated merged shape: project tier wins, flag present, sync cache fed", async () => {
    const store = createFakeStore();

    const settings = await getSettingsFastImpl(store as never);

    expect(settings.maxConcurrent).toBe(2);
    expect(settings.maxWorktrees).toBe(6);
    expect(settings.secretsSyncPassphraseConfigured).toBe(true);
    expect(store.settingsSyncCache).toBe(settings);
  });

  it("keeps the scoped shape, with the flag on the global half only", async () => {
    const store = createFakeStore();

    const scopes = await getSettingsByScopeFastImpl(store as never);

    expect(scopes.global.maxConcurrent).toBe(9);
    expect(scopes.global.secretsSyncPassphraseConfigured).toBe(true);
    expect(scopes.project.maxConcurrent).toBe(2);
    expect(scopes.project.secretsSyncPassphraseConfigured).toBeUndefined();
  });

  it("reports the empty states honestly: no project tier rows, no passphrase", async () => {
    projectSettingsImpl = () => undefined;
    passphraseImpl = () => false;

    const merged = await getSettingsFastImpl(createFakeStore() as never);
    const scopes = await getSettingsByScopeFastImpl(createFakeStore() as never);

    // An absent project tier still leaves the global tier authoritative rather than an empty document.
    expect(merged.secretsSyncPassphraseConfigured).toBe(false);
    expect(merged.maxConcurrent).toBe(9);
    expect(scopes.global.secretsSyncPassphraseConfigured).toBe(false);
    expect(scopes.project.maxConcurrent).toBeUndefined();
    expect(scopes.project.secretsSyncPassphraseConfigured).toBeUndefined();
  });

  it("swallows an unavailable secrets store into false without failing the settings read", async () => {
    passphraseImpl = () => {
      throw new Error("keystore unavailable");
    };

    const merged = await getSettingsFastImpl(createFakeStore() as never);
    const scopes = await getSettingsByScopeFastImpl(createFakeStore() as never);

    expect(merged.secretsSyncPassphraseConfigured).toBe(false);
    expect(scopes.global.secretsSyncPassphraseConfigured).toBe(false);
    expect(merged.maxConcurrent).toBe(2);
  });

  it("surfaces the settings read's own error even when the passphrase probe fails too", async () => {
    // The probe moved AHEAD of the settings reads, so its failure must be structurally unable to become the
    // caller's error. That is why the swallowing lives inside the probe rather than around the await.
    const failBoth = () => {
      projectSettingsImpl = () => {
        throw new Error("project config unreadable");
      };
      passphraseImpl = () => {
        throw new Error("keystore unavailable");
      };
    };

    failBoth();
    await expect(getSettingsFastImpl(createFakeStore() as never)).rejects.toThrow("project config unreadable");
    failBoth();
    await expect(getSettingsByScopeFastImpl(createFakeStore() as never)).rejects.toThrow(
      "project config unreadable",
    );
  });
});
