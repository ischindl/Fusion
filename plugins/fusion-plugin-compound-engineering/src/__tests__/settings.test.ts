import { describe, expect, it } from "vitest";
import type { PluginSettingType } from "@fusion/plugin-sdk";
import { listStages } from "../session/stage-registry.js";
import {
  DEFAULT_ENABLED_STAGES,
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER,
  DEFAULT_RECONCILE_INTERVAL_MINUTES,
  DEFAULT_RECONCILE_ON_HOOKS,
  getDefaultModelId,
  getDefaultProvider,
  getEnabledStages,
  getReconcileIntervalMinutes,
  getReconcileOnHooks,
  settingsSchema,
} from "../settings.js";

const VALID_TYPES: PluginSettingType[] = ["string", "number", "boolean", "enum", "password", "array"];

describe("compound engineering plugin settings schema", () => {
  it("uses only valid plugin setting types and labels", () => {
    for (const [key, schema] of Object.entries(settingsSchema)) {
      expect(VALID_TYPES).toContain(schema.type);
      expect(typeof schema.label).toBe("string");
      expect(schema.label?.trim().length).toBeGreaterThan(0);

      if (schema.type === "enum") {
        expect(Array.isArray(schema.enumValues)).toBe(true);
        expect(schema.enumValues?.length ?? 0).toBeGreaterThan(0);
      }

      if (schema.type === "array") {
        expect(schema.itemType).toBe("string");
      }

      expect(key.length).toBeGreaterThan(0);
    }
  });

  it("exposes the expected keys grouped into Sessions and Sync", () => {
    expect(Object.keys(settingsSchema).sort()).toEqual(
      [
        "defaultModelId",
        "defaultProvider",
        "enabledStages",
        "reconcileIntervalMinutes",
        "reconcileOnHooks",
      ].sort(),
    );
    expect(settingsSchema.defaultProvider.group).toBe("Sessions");
    expect(settingsSchema.defaultModelId.group).toBe("Sessions");
    expect(settingsSchema.enabledStages.group).toBe("Sessions");
    expect(settingsSchema.reconcileOnHooks.group).toBe("Sync");
    expect(settingsSchema.reconcileIntervalMinutes.group).toBe("Sync");
  });

  it("defaults enabledStages to the full stage registry", () => {
    expect(DEFAULT_ENABLED_STAGES).toEqual(listStages().map((s) => s.stageId));
    expect(settingsSchema.enabledStages.defaultValue).toEqual(DEFAULT_ENABLED_STAGES);
  });

  it("uses documented literal defaults", () => {
    expect(settingsSchema.reconcileOnHooks.defaultValue).toBe(true);
    expect(settingsSchema.reconcileIntervalMinutes.defaultValue).toBe(15);
    expect(settingsSchema.defaultProvider.defaultValue).toBe("");
    expect(settingsSchema.defaultModelId.defaultValue).toBe("");
  });

  it("returns defaults for empty settings", () => {
    const empty = {};
    expect(getDefaultProvider(empty)).toBeUndefined();
    expect(DEFAULT_PROVIDER).toBe("");
    expect(getDefaultModelId(empty)).toBeUndefined();
    expect(DEFAULT_MODEL_ID).toBe("");
    // getEnabledStages re-reads the LIVE registry default (so runtime-registered
    // stages are launchable); DEFAULT_ENABLED_STAGES is the import-time snapshot
    // used for the schema/manifest literal.
    expect(getEnabledStages(empty)).toEqual(listStages().map((s) => s.stageId));
    expect(getReconcileOnHooks(empty)).toBe(DEFAULT_RECONCILE_ON_HOOKS);
    expect(getReconcileIntervalMinutes(empty)).toBe(DEFAULT_RECONCILE_INTERVAL_MINUTES);
  });

  it("returns configured values when provided", () => {
    const populated = {
      defaultProvider: "anthropic",
      defaultModelId: "claude-opus",
      enabledStages: ["strategy", "plan"],
      reconcileOnHooks: false,
      reconcileIntervalMinutes: 30,
    } satisfies Record<string, unknown>;

    expect(getDefaultProvider(populated)).toBe("anthropic");
    expect(getDefaultModelId(populated)).toBe("claude-opus");
    expect(getEnabledStages(populated)).toEqual(["strategy", "plan"]);
    expect(getReconcileOnHooks(populated)).toBe(false);
    expect(getReconcileIntervalMinutes(populated)).toBe(30);
  });

  it("clamps the reconcile cadence to at least one minute", () => {
    expect(getReconcileIntervalMinutes({ reconcileIntervalMinutes: 0 })).toBe(1);
    expect(getReconcileIntervalMinutes({ reconcileIntervalMinutes: -5 })).toBe(1);
    expect(getReconcileIntervalMinutes({ reconcileIntervalMinutes: 7.9 })).toBe(7);
  });

  it("falls back to defaults for malformed values", () => {
    const liveDefault = listStages().map((s) => s.stageId);
    expect(getEnabledStages({ enabledStages: "not-an-array" })).toEqual(liveDefault);
    expect(getEnabledStages({ enabledStages: [] })).toEqual(liveDefault);
    expect(getDefaultProvider({ defaultProvider: "   " })).toBeUndefined();
    expect(getReconcileOnHooks({ reconcileOnHooks: "yes" })).toBe(DEFAULT_RECONCILE_ON_HOOKS);
  });
});
