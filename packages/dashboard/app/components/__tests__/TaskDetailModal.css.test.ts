import { describe, expect, it } from "vitest";
import { loadAllAppCssBaseOnly } from "../../test/cssFixture";

function getCssRuleBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ruleMatch = css.match(new RegExp(`(?:^|[}\n])\\s*(?:[^{}]*,\\s*)?${escapedSelector}(?:\\s*,[^{}]*)?\\s*\\{([^}]*)\\}`));
  return ruleMatch?.[1] ?? "";
}

function expectNoOuterPaddingOverride(css: string, selector: string): void {
  const ruleBlock = getCssRuleBlock(css, selector);
  expect(ruleBlock, `${selector} rule`).not.toBe("");
  expect(ruleBlock, `${selector} padding`).not.toMatch(/\bpadding(?:-[\w-]+)?\s*:/);
}

describe("TaskDetailModal CSS contract", () => {
  it("FN-4183 keeps detail source headers top-aligned so the disclosure toggle stays on the first row", async () => {
    const css = await loadAllAppCssBaseOnly();

    expect(css).toMatch(/\.detail-source-header\s*\{[^}]*align-items\s*:\s*flex-start\s*;/);
  });

  it("FN-5879/FN-6864 keeps the base detail tab strip horizontally scrollable and touch-pannable without shrinking tabs", async () => {
    const css = await loadAllAppCssBaseOnly();

    expect(css).toMatch(/\.detail-tabs\s*\{[^}]*overflow-x\s*:\s*auto\s*;/);
    expect(css).toMatch(/\.detail-tabs\s*\{[^}]*touch-action\s*:\s*pan-x\s+pan-y\s*;/);
    expect(css).toMatch(/\.detail-tab\s*\{[^}]*flex-shrink\s*:\s*0\s*;/);
  });

  it("FN-7408 keeps task-detail tab body padding canonical across Activity, planner Chat, and Plan surfaces", async () => {
    const css = await loadAllAppCssBaseOnly();
    const detailBodyBlock = getCssRuleBlock(css, ".detail-body");
    const rawBodyBlock = getCssRuleBlock(css, ".detail-body--agent-log");
    const planBlock = getCssRuleBlock(css, ".detail-section--plan-prompt");

    expect(detailBodyBlock).toContain("padding: calc(var(--space-lg) + var(--space-xs));");
    expectNoOuterPaddingOverride(css, ".detail-body--chat");
    expectNoOuterPaddingOverride(css, ".detail-body--planner-chat");
    expectNoOuterPaddingOverride(css, ".task-detail-content--chat-expanded .detail-body--chat");
    expectNoOuterPaddingOverride(css, ".task-detail-content--planner-chat-expanded .detail-body--planner-chat");
    expect(rawBodyBlock).not.toMatch(/\bpadding(?:-[\w-]+)?\s*:/);
    expect(planBlock).toContain("width: 100%;");
    expect(planBlock).toContain("max-width: 100%;");
  });

  it("FN-7351/FN-7375 keeps the Activity tab dropdown portal-safe on narrow task-detail surfaces", async () => {
    const css = await loadAllAppCssBaseOnly();

    expect(css).toMatch(/\.detail-tab-dropdown\s*\{[^}]*flex-shrink\s*:\s*0\s*;/);
    expect(css).toMatch(/\.detail-tab--activity\s*\{[^}]*display\s*:\s*inline-flex\s*;/);
    expect(css).toMatch(/\.activity-view-menu\s*\{[^}]*position\s*:\s*fixed\s*;/);
    expect(css).toMatch(/\.activity-view-menu\s*\{[^}]*overflow-y\s*:\s*auto\s*;/);
    expect(css).not.toMatch(/\.activity-view-menu\s*\{[^}]*position\s*:\s*absolute\s*;/);
    expect(css).not.toMatch(/\.activity-view-menu\s*\{[^}]*min-inline-size\s*:\s*100%\s*;/);
    expect(css).not.toContain(".activity-view-select");
    expect(css).not.toContain(".activity-segmented-control");
    expect(css).not.toContain(".activity-segment");
    expect(css).not.toContain(".log-subview-toggle");
    expect(css).not.toContain(".log-subview-btn");
  });
});
