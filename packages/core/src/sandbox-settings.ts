import { isExperimentalFeatureEnabled } from "./experimental-features.js";
import type { Settings } from "./types.js";

export function isSandboxExperimentalEnabled(settings: Partial<Settings> | undefined): boolean {
  return isExperimentalFeatureEnabled(settings, "sandbox");
}
