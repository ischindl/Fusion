import { describe, expect, it } from "vitest";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../../test/cssFixture";

const selectorBlocks = (css: string, selectorFragment: string): string[] =>
  Array.from(css.matchAll(/[^{}]*\{[^{}]*\}/g), ([block]) => block).filter((block) => block.includes(selectorFragment));

describe("TodoView mobile stack height CSS contract", () => {
  it("uncaps both visible panels in the narrow single-panel stack", () => {
    const css = loadAllAppCss();
    const containerStart = css.indexOf("@container todo-view (max-width: 520px)");
    const mediaStart = css.indexOf("@media (max-width: 768px)", containerStart);

    expect(containerStart).toBeGreaterThanOrEqual(0);
    expect(mediaStart).toBeGreaterThan(containerStart);

    const narrowStackCss = css.slice(containerStart, mediaStart);

    expect(narrowStackCss).toMatch(
      /\.todo-view-layout \.todo-view-sidebar,\s*\.todo-view-layout \.todo-view-main\s*\{[^}]*height:\s*100%;[^}]*max-height:\s*none;[^}]*flex:\s*1 1 auto;[^}]*overflow-y:\s*auto;/,
    );
    expect(narrowStackCss).toMatch(/\.todo-view-layout\[data-mobile-stack-view="list"\] \.todo-view-main\s*\{[^}]*display:\s*none;/);
    expect(narrowStackCss).toMatch(/\.todo-view-layout\[data-mobile-stack-view="detail"\] \.todo-view-sidebar\s*\{[^}]*display:\s*none;/);
    expect(narrowStackCss).not.toMatch(/max-height:\s*calc\(var\(--space-2xl\) \* 6 \+ var\(--space-sm\)\)/);
  });

  it("retains the tablet two-panel sidebar height cap", () => {
    const css = loadAllAppCss();

    expect(css).toMatch(
      /@media \(max-width:\s*768px\)[\s\S]*\.todo-view-sidebar\s*\{[^}]*max-height:\s*calc\(var\(--space-2xl\) \* 6 \+ var\(--space-sm\)\);/,
    );
  });
});

describe("TodoView action row CSS contract", () => {
  it("keeps todo item actions visible by default on desktop", () => {
    const baseCss = loadAllAppCssBaseOnly();

    expect(baseCss).toMatch(/\.todo-item-actions\s*\{[^}]*opacity:\s*1;/);
  });

  it("uses a dedicated action row with mobile visibility override", () => {
    const css = loadAllAppCss();

    expect(css).toMatch(/\.todo-item\s*\{[^}]*flex-direction:\s*column;/);
    expect(css).toMatch(/\.todo-item-main-row\s*\{[^}]*display:\s*flex;/);
    expect(css).toMatch(/\.todo-item-actions\s*\{[^}]*margin-left:\s*calc\(var\(--space-lg\) \+ var\(--space-sm\)\);/);
    expect(css).toMatch(/@media \(max-width:\s*768px\)[^{]*\{[\s\S]*\.todo-item-actions\s*\{[^}]*opacity:\s*1;[^}]*\}/);
  });
});

describe("TodoView list row CSS contract", () => {
  it("keeps sidebar list rows flat without a left accent stripe", () => {
    const css = loadAllAppCss();
    const listItemBlocks = selectorBlocks(css, ".todo-list-item");
    const activeBlocks = selectorBlocks(css, ".todo-list-item--active");

    expect(listItemBlocks.length).toBeGreaterThan(0);
    expect(activeBlocks.length).toBeGreaterThan(0);
    expect(activeBlocks.join("\n")).not.toMatch(/inset\s+3px\s+0\s+0/);
    expect(listItemBlocks.join("\n")).not.toMatch(/border-left\s*:/);
    expect(css).not.toMatch(/\.todo-list-item\s*\{[^}]*border\s*:/);
    expect(css).not.toMatch(/\.todo-list-item:hover\s*\{[^}]*border-color\s*:/);
    expect(activeBlocks.join("\n")).toMatch(/background\s*:/);
  });
});
