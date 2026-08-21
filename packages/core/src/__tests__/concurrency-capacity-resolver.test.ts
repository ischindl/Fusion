import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_SETTINGS } from "../types.js";
import {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_WORKTREES,
  resolveEffectiveConcurrency,
  resolveMaxConcurrentSetting,
} from "../workflows/workflow-capacity.js";

describe("resolveEffectiveConcurrency", () => {
  it("uses shipped defaults for absent values", () => {
    expect(resolveEffectiveConcurrency(undefined)).toEqual({
      maxConcurrent: DEFAULT_PROJECT_SETTINGS.maxConcurrent,
      worktreeLimit: DEFAULT_PROJECT_SETTINGS.maxWorktrees,
      effectiveLimit: DEFAULT_PROJECT_SETTINGS.maxConcurrent,
      bindingKnob: "maxConcurrent",
    });
  });

  it.each([0, -3, Number.NaN, Infinity, "2", null])("rejects invalid maxConcurrent %j", (maxConcurrent) => {
    expect(resolveMaxConcurrentSetting({ maxConcurrent } as never)).toBe(DEFAULT_PROJECT_SETTINGS.maxConcurrent);
  });

  it("honors configured values and names a binding worktree limit", () => {
    expect(resolveEffectiveConcurrency({ maxConcurrent: 8, maxWorktrees: 4, worktreeLimitEnabled: true })).toEqual({
      maxConcurrent: 8,
      worktreeLimit: 4,
      effectiveLimit: 4,
      bindingKnob: "maxWorktrees",
    });
  });

  it("makes the worktree dimension structurally absent when disabled", () => {
    expect(resolveEffectiveConcurrency({ maxConcurrent: 8, maxWorktrees: 4, worktreeLimitEnabled: false })).toEqual({
      maxConcurrent: 8,
      worktreeLimit: null,
      effectiveLimit: 8,
      bindingKnob: "maxConcurrent",
    });
  });

  it("keeps exported capacity defaults aligned with shipped settings", () => {
    expect(DEFAULT_MAX_CONCURRENT).toBe(DEFAULT_PROJECT_SETTINGS.maxConcurrent);
    expect(DEFAULT_MAX_WORKTREES).toBe(DEFAULT_PROJECT_SETTINGS.maxWorktrees);
  });
});
