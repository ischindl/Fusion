import { describe, expect, it } from "vitest";

import { loadAllAppCss } from "../../test/cssFixture";

describe("SkillsView/runtime-card token guardrails", () => {
  it("does not use forbidden runtime fallback literals/tokens", async () => {
    const css = await loadAllAppCss();

    expect(css).not.toContain("var(--accent-green");
    expect(css).not.toContain("var(--accent-red");
    expect(css).not.toContain("var(--space-xxs");
    expect(css).not.toContain("var(--accent-green, #22c55e)");
    expect(css).not.toContain("var(--accent-red, #ef4444)");
    expect(css).not.toContain("var(--accent, #4f46e5)");
  });
});
