import type { PluginSettingSchema } from "@fusion/plugin-sdk";
import { listStages } from "./session/stage-registry.js";

/**
 * Operator-facing settings for the Compound Engineering plugin (U9).
 *
 * Grouped like `fusion-plugin-reports`. Every setting here has a real, honest
 * consumption point in the existing plugin code:
 *   - Sessions group  → the orchestrator's interactive-session factory call
 *                        (`defaultProvider`/`defaultModelId`) and the launch
 *                        guard (`enabledStages`).
 *   - Sync group      → the reconciler trigger surface (auto-drain on hooks +
 *                        the cadence hint a refresh surface reads).
 *
 * `DEFAULT_*` consts are the single source of truth shared by the schema
 * defaults, the typed getters, and the settings test.
 */

/** Sessions: default provider/model for CE interactive sessions. */
export const DEFAULT_PROVIDER = "";
export const DEFAULT_MODEL_ID = "";

/** Sessions: which pipeline stages are launchable. Defaults to the full registry. */
export const DEFAULT_ENABLED_STAGES: string[] = listStages().map((s) => s.stageId);

/** Sync: whether the board→pipeline reconcile sweep auto-fires after lifecycle hooks. */
export const DEFAULT_RECONCILE_ON_HOOKS = true;
/**
 * Sync: cadence hint (minutes) a refresh/poll-fallback surface uses when it
 * sweeps the reconciler on demand. This is a HINT, not a host scheduler — there
 * is no continuous poll loop (per docs/performance/dashboard-load.md); a refresh
 * surface reads this to decide how often to offer/auto-trigger a manual sweep.
 */
export const DEFAULT_RECONCILE_INTERVAL_MINUTES = 15;

export const settingsSchema: Record<string, PluginSettingSchema> = {
  defaultProvider: {
    type: "string",
    label: "Default Session Provider",
    description: "Model provider used for CE interactive sessions (for example anthropic). Leave blank to use the host default.",
    group: "Sessions",
    defaultValue: DEFAULT_PROVIDER,
  },
  defaultModelId: {
    type: "string",
    label: "Default Session Model",
    description: "Model ID within the provider used for CE interactive sessions. Leave blank to use the host default.",
    group: "Sessions",
    defaultValue: DEFAULT_MODEL_ID,
  },
  enabledStages: {
    type: "array",
    itemType: "string",
    label: "Enabled Stages",
    description: "Stage IDs that may be launched from the Compound Engineering view (for example strategy, ideate, brainstorm, plan, work).",
    group: "Sessions",
    defaultValue: DEFAULT_ENABLED_STAGES,
  },

  reconcileOnHooks: {
    type: "boolean",
    label: "Reconcile on Board Changes",
    description: "Run the board→pipeline reconcile sweep automatically after task move/complete hooks. Disable to only reconcile on demand.",
    group: "Sync",
    defaultValue: DEFAULT_RECONCILE_ON_HOOKS,
  },
  reconcileIntervalMinutes: {
    type: "number",
    label: "Reconcile Cadence (minutes)",
    description: "Cadence hint for how often an on-demand refresh surface sweeps the reconciler. Not a continuous poll loop.",
    group: "Sync",
    defaultValue: DEFAULT_RECONCILE_INTERVAL_MINUTES,
  },
};

function asString(settings: Record<string, unknown>, key: string): string | undefined {
  const value = settings[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asBoolean(settings: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = settings[key];
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(settings: Record<string, unknown>, key: string, fallback: number): number {
  const value = settings[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStringArray(settings: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const value = settings[key];
  if (!Array.isArray(value)) return [...fallback];
  const normalized = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : [...fallback];
}

/**
 * Default provider for CE sessions. Returns `undefined` when unset so the
 * orchestrator can omit it and let the host pick its default provider.
 */
export function getDefaultProvider(settings: Record<string, unknown>): string | undefined {
  return asString(settings, "defaultProvider");
}

/**
 * Default model ID for CE sessions. Returns `undefined` when unset so the
 * orchestrator can omit it and let the host pick its default model.
 */
export function getDefaultModelId(settings: Record<string, unknown>): string | undefined {
  return asString(settings, "defaultModelId");
}

/**
 * Stage IDs that may be launched. When unset, defaults to the LIVE registry
 * (re-read here, not the import-time snapshot) so a stage registered at runtime
 * is launchable by default — disabling is an explicit opt-out, not opt-in.
 */
export function getEnabledStages(settings: Record<string, unknown>): string[] {
  return asStringArray(settings, "enabledStages", listStages().map((s) => s.stageId));
}

/** Whether the reconcile sweep auto-fires after lifecycle hooks. */
export function getReconcileOnHooks(settings: Record<string, unknown>): boolean {
  return asBoolean(settings, "reconcileOnHooks", DEFAULT_RECONCILE_ON_HOOKS);
}

/** On-demand reconcile cadence hint in minutes (>= 1). */
export function getReconcileIntervalMinutes(settings: Record<string, unknown>): number {
  return Math.max(1, Math.floor(asNumber(settings, "reconcileIntervalMinutes", DEFAULT_RECONCILE_INTERVAL_MINUTES)));
}
