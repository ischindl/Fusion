import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("settings precedence", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);

  it("merges worktrunk field-level project overrides while preserving scope views", async () => {
    await harness.store().updateGlobalSettings({
      worktrunk: {
        enabled: true,
        binaryPath: "/opt/bin/worktrunk",
        onFailure: "fallback-native",
      },
    });

    await harness.store().updateSettings({
      worktrunk: {
        enabled: false,
      },
    });

    const merged = await harness.store().getSettings();
    expect(merged.worktrunk).toEqual({
      enabled: false,
      binaryPath: "/opt/bin/worktrunk",
      onFailure: "fallback-native",
    });

    const scoped = await harness.store().getSettingsByScope();
    expect(scoped.global.worktrunk).toEqual({
      enabled: true,
      binaryPath: "/opt/bin/worktrunk",
      onFailure: "fallback-native",
    });
    expect(scoped.project.worktrunk).toEqual({ enabled: false });
  });
});
