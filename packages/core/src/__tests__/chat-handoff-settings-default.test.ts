import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_SETTINGS, PROJECT_SETTINGS_KEYS } from "../types.js";

/*
FNXC:ChatHandoff 2026-09-09-17:21:
RUFU-199 gives a long live Direct chat an exit ramp that in-session compaction cannot provide: the
model's context is the per-session pi session file, so continuing "with memory" requires a NEW
session whose first prompt turn is primed. The affordance is threshold-gated and operator-switchable,
so both knobs must be declared project settings with defaults that do not need configuration:
`chatHandoffEnabled` stays on (the feature is discoverable without setup, and every LCM behavior
change remains disableable), and `chatHandoffThresholdPercent` is 75 — the same advisory context-usage
signal the read-only thread-header meter shows. The 50–95 clamp is applied by the dashboard reader
(`getChatHandoffSettings`), which is why the schema default is a plain number rather than a bounded type.
*/
describe("chat handoff project settings (RUFU-199)", () => {
  it("defaults the handoff affordance on so a long chat offers it without configuration", () => {
    expect(DEFAULT_PROJECT_SETTINGS.chatHandoffEnabled).toBe(true);
  });

  it("defaults the threshold to 75% of the model context window", () => {
    expect(DEFAULT_PROJECT_SETTINGS.chatHandoffThresholdPercent).toBe(75);
  });

  it("declares both keys in the project settings scope so clients receive them via settings fetch", () => {
    const keys = PROJECT_SETTINGS_KEYS as readonly string[];
    expect(keys).toContain("chatHandoffEnabled");
    expect(keys).toContain("chatHandoffThresholdPercent");
  });

  it("is declared beside the chat context opt-outs it must be distinguishable from", () => {
    // In-session compaction (chatPreOverflowCompactionEnabled) and the handoff are independent
    // mechanisms; the test names them together because the docs and Settings UI pair them visually
    // and a reviewer must be able to see they are separate keys, not aliases.
    expect(DEFAULT_PROJECT_SETTINGS).toHaveProperty("chatPreOverflowCompactionEnabled");
    expect(DEFAULT_PROJECT_SETTINGS).toHaveProperty("chatContextBudgetEnabled");
    expect(DEFAULT_PROJECT_SETTINGS).toHaveProperty("chatHandoffEnabled");
    expect(DEFAULT_PROJECT_SETTINGS).toHaveProperty("chatHandoffThresholdPercent");
  });
});
