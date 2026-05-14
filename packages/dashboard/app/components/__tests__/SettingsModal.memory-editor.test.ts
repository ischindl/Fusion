import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../../test/cssFixture";

function extractMediaBlock(css: string, mediaQuery: string): string {
  const start = css.indexOf(mediaQuery);
  expect(start).toBeGreaterThanOrEqual(0);

  const openBrace = css.indexOf("{", start);
  expect(openBrace).toBeGreaterThanOrEqual(0);

  let depth = 1;
  for (let i = openBrace + 1; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") depth -= 1;
    if (depth === 0) {
      return css.slice(openBrace + 1, i);
    }
  }

  throw new Error(`Unable to extract media block for ${mediaQuery}`);
}

describe("FN-4416 SettingsModal memory editor mobile height", () => {
  it("keeps base 50vh and mobile min-height at or above desktop", async () => {
    const css = await loadAllAppCss();

    const baseMatch = css.match(/\.memory-editor-frame\s*\{[^}]*min-height\s*:\s*(\d+(?:\.\d+)?)vh\s*;[^}]*\}/);
    expect(baseMatch).not.toBeNull();
    const baseHeight = Number(baseMatch?.[1]);
    expect(baseHeight).toBe(50);

    const mobileBlock = extractMediaBlock(css, "@media (max-width: 768px)");
    const mobileMatch = mobileBlock.match(/\.memory-editor-frame\s*\{[^}]*min-height\s*:\s*(\d+(?:\.\d+)?)vh\s*;[^}]*\}/);
    expect(mobileMatch).not.toBeNull();

    const mobileHeight = Number(mobileMatch?.[1]);
    expect(mobileHeight).toBeGreaterThanOrEqual(baseHeight);
    expect(mobileHeight).toBe(65);
  });
});
