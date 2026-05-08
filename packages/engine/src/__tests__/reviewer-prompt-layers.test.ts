import { describe, it, expect } from "vitest";
import { buildPromptLayers, collapsePromptLayers } from "../prompt-layers.js";

describe("reviewer prompt layering", () => {
  const REVIEWER_BASE = "You are an independent code and plan reviewer.";
  const MEMORY_INSTRUCTIONS = "\n## Memory\n\nUse fn_memory_search to look up context.";

  it("puts base prompt + memory instructions in stable layer", () => {
    const layers = buildPromptLayers({
      basePrompt: REVIEWER_BASE + MEMORY_INSTRUCTIONS,
      agentInstructions: "Custom reviewer guidance.",
      pluginContributions: "## Plugin: lint\n\nCheck lint.",
    });

    expect(layers.stable).toBe(REVIEWER_BASE + MEMORY_INSTRUCTIONS);
    expect(layers.stable).not.toContain("Custom reviewer guidance");
    expect(layers.stable).not.toContain("lint");
  });

  it("produces identical stable layer across simulated sessions", () => {
    const layers1 = buildPromptLayers({
      basePrompt: REVIEWER_BASE + MEMORY_INSTRUCTIONS,
      agentInstructions: "Session 1 instructions.",
    });
    const layers2 = buildPromptLayers({
      basePrompt: REVIEWER_BASE + MEMORY_INSTRUCTIONS,
      agentInstructions: "Session 2 instructions.",
    });

    expect(layers1.stable).toBe(layers2.stable);
  });

  it("collapsed layers match legacy concatenation", () => {
    const layers = buildPromptLayers({
      basePrompt: REVIEWER_BASE,
      agentInstructions: "Check for bugs.",
      pluginContributions: "## Plugin: sec\n\nScan.",
    });
    const collapsed = collapsePromptLayers(layers);

    expect(collapsed).toBe(
      `${REVIEWER_BASE}\n\n## Custom Instructions\n\nCheck for bugs.\n\n## Plugin: sec\n\nScan.`
    );
  });
});
