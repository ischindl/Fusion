/**
 * settings-ops-2 operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {TaskStore} from "../store.js";
import type {Settings, GlobalSettings, ProjectSettings} from "../types.js";
import {DEFAULT_SETTINGS, isGlobalOnlySettingsKey} from "../types.js";
import "../builtin-traits.js";
import {resolveWorktrunkSettings} from "../config/worktrunk-settings.js";
import {hasSyncPassphraseConfigured} from "../secrets/secrets-sync-passphrase.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {canonicalizeSettings} from "../task-store/settings-helpers.js";
import {readProjectConfig as readProjectConfigAsync, readProjectSettings as readProjectSettingsAsync} from "../task-store/async/async-settings.js";
import {resolveTaskIdMintingContext, type TaskIdMintingContext} from "../task-store/task-prefix.js";

export async function getSettingsImpl(store: TaskStore): Promise<Settings> {
    /*
    FNXC:SqliteDualPathCleanup 2026-07-26-14:20:
    Settings reads are PostgreSQL-only via AsyncDataLayer + GlobalSettingsStore. SQLite store.readConfig arm deleted.
    FNXC:RuntimePersistenceAsync 2026-06-24-10:20: jsonb config already-parsed (VAL-SCHEMA-004).
    */
    const layer = store.asyncLayer!;
    const [globalSettings, projectConfig] = await Promise.all([
      store.globalSettingsStore.getSettings(),
      readProjectConfigAsync(layer),
    ]);
    const projectSettings = Object.fromEntries(
      Object.entries(projectConfig.settings ?? {}).filter(
        ([key]) => !isGlobalOnlySettingsKey(key),
      ),
    );
    const merged = {
      ...DEFAULT_SETTINGS,
      ...globalSettings,
      ...projectSettings,
      worktrunk: resolveWorktrunkSettings(
        globalSettings.worktrunk,
        (projectSettings as Partial<Settings>).worktrunk,
      ),
    };
    try {
      merged.secretsSyncPassphraseConfigured = await hasSyncPassphraseConfigured(await store.getSecretsStore());
    } catch {
      merged.secretsSyncPassphraseConfigured = false;
    }
    const canonical = canonicalizeSettings(merged);
    // FNXC:IncompletePgPorts 2026-07-26-20:40: feed getSettingsSync cache for sync ntfy/prompt readers.
    store.settingsSyncCache = canonical;
    return canonical;
  }

/**
 * Resolve the namespace and partition a new task id will be minted from.
 *
 * FNXC:TaskIdMintingPartition 2026-11-08-09:19 (RUFU-320):
 * The single minting read shared by both backend create paths. It deliberately does NOT hand the
 * merged settings document to the minting site: `getSettingsFast()` layers the daemon-wide
 * `settings.json` under the project's own `project.config`, and that shared tier named the
 * `RUFU-…` ids that landed on the `vllm-rocm` board (RUFU-320). For a store bound to a project the
 * namespace comes only from that project's own config row; the merged tier remains authoritative
 * solely for a legacy unbound store, which has no partition to read.
 */
export async function resolveTaskIdMintingImpl(
  store: TaskStore,
  input: { taskPrefix?: string; targetProjectId?: string },
  fallback: string,
): Promise<TaskIdMintingContext> {
  const layer = store.asyncLayer;
  const mintingProjectId = layer?.projectId?.trim() || null;
  const partitionSettings = layer ? await readProjectSettingsAsync(layer) : null;
  const projectConfigPrefix = typeof partitionSettings?.taskPrefix === "string"
    ? partitionSettings.taskPrefix
    : null;
  const unboundSettingsTaskPrefix = mintingProjectId
    ? null
    : (await store.getSettingsFast()).taskPrefix ?? null;
  return resolveTaskIdMintingContext({
    targetProjectId: input.targetProjectId,
    mintingProjectId,
    taskPrefixHint: input.taskPrefix,
    projectConfigPrefix,
    unboundSettingsTaskPrefix,
    fallback,
  });
}

export async function getSettingsFastImpl(store: TaskStore): Promise<Settings> {
    // FNXC:RuntimePersistenceAsync 2026-06-24-10:22:
    // Backend-mode fast settings read: delegate to the async settings helper
    // (readProjectSettingsAsync), which reads only the jsonb `settings` column.
        const layer = store.asyncLayer!;
    const [globalSettings, projectSettingsRaw] = await Promise.all([
      store.globalSettingsStore.getSettings(),
      readProjectSettingsAsync(layer),
    ]);
    const raw = projectSettingsRaw ?? undefined;
    const projectSettings: Partial<Settings> | undefined = raw
      ? (Object.fromEntries(
          Object.entries(raw).filter(([key]) => !isGlobalOnlySettingsKey(key)),
        ) as Partial<Settings>)
      : undefined;
    const merged = {
      ...DEFAULT_SETTINGS,
      ...globalSettings,
      ...projectSettings,
      worktrunk: resolveWorktrunkSettings(
        globalSettings.worktrunk,
        projectSettings?.worktrunk,
      ),
    };
    try {
      merged.secretsSyncPassphraseConfigured = await hasSyncPassphraseConfigured(await store.getSecretsStore());
    } catch {
      merged.secretsSyncPassphraseConfigured = false;
    }
    const canonical = canonicalizeSettings(merged);
    // FNXC:IncompletePgPorts 2026-07-26-20:40: feed getSettingsSync cache (fast path).
    store.settingsSyncCache = canonical;
    return canonical;
}

export async function getSettingsByScopeImpl(store: TaskStore): Promise<{ global: GlobalSettings; project: Partial<ProjectSettings> }> {
    /*
    FNXC:SqliteDualPathCleanup 2026-07-26-14:20:
    Scoped settings reads are PostgreSQL-only; SQLite store.readConfig arm deleted.
    */
    const layer = store.asyncLayer!;
    const [globalSettings, projectConfig] = await Promise.all([
      store.globalSettingsStore.getSettings(),
      readProjectConfigAsync(layer),
    ]);
    /*
    FNXC:SqliteDualPathCleanup 2026-07-26-15:00:
    Do not mutate GlobalSettingsStore's cached object; compute passphrase flag on a shallow copy.
    */
    let secretsSyncPassphraseConfigured = false;
    try {
      secretsSyncPassphraseConfigured = await hasSyncPassphraseConfigured(await store.getSecretsStore());
    } catch {
      secretsSyncPassphraseConfigured = false;
    }
    const global = { ...globalSettings, secretsSyncPassphraseConfigured };
    const projectSettings: Partial<ProjectSettings> = {};
    if (projectConfig.settings) {
      for (const key of Object.keys(projectConfig.settings)) {
        if (!isGlobalOnlySettingsKey(key)) {
          (projectSettings as Record<string, unknown>)[key] = (projectConfig.settings as Record<string, unknown>)[key];
        }
      }
    }
    return { global, project: canonicalizeSettings(projectSettings as Settings) };
  }

export async function getSettingsByScopeFastImpl(store: TaskStore): Promise<{ global: GlobalSettings; project: Partial<ProjectSettings> }> {
    // FNXC:RuntimePersistenceAsync 2026-06-24-10:24:
    // Backend-mode fast scoped read: delegate to async settings helper.
    const layer = store.asyncLayer!;
    const [globalSettings, projectSettingsRaw] = await Promise.all([
      store.globalSettingsStore.getSettings(),
      readProjectSettingsAsync(layer),
    ]);
    /*
    FNXC:SqliteDualPathCleanup 2026-07-26-15:00:
    Do not mutate GlobalSettingsStore cache; return a shallow copy with the request-time passphrase flag.
    */
    let secretsSyncPassphraseConfigured = false;
    try {
      secretsSyncPassphraseConfigured = await hasSyncPassphraseConfigured(await store.getSecretsStore());
    } catch {
      secretsSyncPassphraseConfigured = false;
    }
    const global = { ...globalSettings, secretsSyncPassphraseConfigured };
    const projectSettings = projectSettingsRaw ?? undefined;
    const projectScoped: Partial<ProjectSettings> = {};
    if (projectSettings) {
      for (const key of Object.keys(projectSettings)) {
        if (!isGlobalOnlySettingsKey(key)) {
          (projectScoped as Record<string, unknown>)[key] = (projectSettings as Record<string, unknown>)[key];
        }
      }
    }
    return { global, project: canonicalizeSettings(projectScoped as Settings) };
}

