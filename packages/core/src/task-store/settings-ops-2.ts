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

/**
 * Start the sync-passphrase probe without ever rejecting.
 *
 * FNXC:SettingsOpenLatency 2026-11-09-14:30 (RUFU-908):
 * `secretsSyncPassphraseConfigured` is one boolean on the settings document, derived from a single
 * `secrets` read (`hasSyncPassphraseConfigured` → `listSecrets("global")`). Both request-path settings
 * readers used to await it AFTER the two settings reads had already settled, so every `GET /api/settings`
 * and `GET /api/settings/scopes` paid three serial database round trips where the flag needs none of them:
 * it is not an input to the merge and the merge is not an input to it. On the operator's loaded host each
 * extra hop queues on a pool capped at `DEFAULT_POOL_MAX = 3` and is client-visible; this is the same
 * serial-chain class the `/api/settings/scopes` route fix removes.
 *
 * Swallowing lives HERE rather than in a `try` around the await, because hoisting the probe in front of
 * `Promise.all` would otherwise let a secrets failure surface as the settings read's error. The returned
 * promise can therefore only fulfil, so the two settings reads keep their exact rejection precedence.
 *
 * Only the two `*Fast` request-path readers use this. The boot-path `getSettingsImpl` /
 * `getSettingsByScopeImpl` keep their original order: they have no measured latency requirement, and
 * leaving them untouched keeps the change's blast radius on the read that gates the Settings modal.
 */
function readSyncPassphraseFlagConcurrently(store: TaskStore): Promise<boolean> {
  return (async () => {
    try {
      return await hasSyncPassphraseConfigured(await store.getSecretsStore());
    } catch {
      return false;
    }
  })();
}

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
    // FNXC:SettingsOpenLatency 2026-11-09-14:30 (RUFU-908): the passphrase probe is a third independent
    // read, not a step after the merge — it starts with the other two. See readSyncPassphraseFlagConcurrently().
    const passphraseFlag = readSyncPassphraseFlagConcurrently(store);
    const [globalSettings, projectSettingsRaw, secretsSyncPassphraseConfigured] = await Promise.all([
      store.globalSettingsStore.getSettings(),
      readProjectSettingsAsync(layer),
      passphraseFlag,
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
    merged.secretsSyncPassphraseConfigured = secretsSyncPassphraseConfigured;
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
    // FNXC:SettingsOpenLatency 2026-11-09-14:30 (RUFU-908): started alongside the two settings reads
    // rather than awaited after them — see readSyncPassphraseFlagConcurrently().
    const passphraseFlag = readSyncPassphraseFlagConcurrently(store);
    const [globalSettings, projectSettingsRaw, secretsSyncPassphraseConfigured] = await Promise.all([
      store.globalSettingsStore.getSettings(),
      readProjectSettingsAsync(layer),
      passphraseFlag,
    ]);
    /*
    FNXC:SqliteDualPathCleanup 2026-07-26-15:00:
    Do not mutate GlobalSettingsStore cache; return a shallow copy with the request-time passphrase flag.
    */
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

