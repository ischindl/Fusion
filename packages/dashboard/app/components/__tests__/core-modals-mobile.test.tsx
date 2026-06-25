import fs from "node:fs";
import { loadAllAppCss } from "../../test/cssFixture";
import path from "node:path";
import { describe, expect, it } from "vitest";


function getMediaBlocks(css: string, pattern: RegExp): string {
  const matches = [...css.matchAll(pattern)];
  expect(matches.length).toBeGreaterThan(0);

  const parts: string[] = [];
  for (const match of matches) {
    const start = match.index!;
    const open = css.indexOf("{", start);
    let depth = 1;
    let i = open + 1;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    parts.push(css.slice(start, i));
  }
  return parts.join("\n");
}

function getMainMobileBlock(css: string): string {
  // Mobile rules now live both in styles.css (cross-cutting) and in
  // co-located @media (max-width: 768px) blocks at the bottom of each
  // component CSS file. Aggregate all such media-query blocks.
  const block = getMediaBlocks(css, /@media[^{]*\(max-width:\s*768px\)[^{]*\{/g);
  expect(block).toContain(".modal-overlay");
  expect(block).toContain(".detail-tabs");
  return block;
}

function getEmbeddedGitManagerBlock(css: string): string {
  const block = getMediaBlocks(css, /@container\s+gm-embedded\s+\(max-width:\s*560px\)\s*\{/g);
  expect(block).toContain(".gm-modal--embedded .gm-sidebar");
  return block;
}

function getTabletBlock(css: string): string {
  const block = getMediaBlocks(
    css,
    /@media[^{]*\(min-width:\s*769px\)[^{]*\(max-width:\s*1024px\)[^{]*\{/g,
  );
  expect(block).toContain(".modal.task-detail-modal");
  return block;
}

function getRuleBlocks(css: string, selector: string): string[] {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "g"))]
    .map((match) => match[1]);
}

function getFirstRuleBlock(css: string, selector: string): string {
  const block = getRuleBlocks(css, selector).at(0);
  expect(block).toBeTruthy();
  return block!;
}

function getLastRuleBlock(css: string, selector: string): string {
  const block = getRuleBlocks(css, selector).at(-1);
  expect(block).toBeTruthy();
  return block!;
}

function extractVhHeight(rule: string): number {
  const heightMatch = rule.match(/height:\s*(\d+)vh;/);
  expect(heightMatch).toBeTruthy();
  return Number(heightMatch![1]);
}

describe("core modals mobile css coverage", () => {
  it("TaskDetailModal: keeps desktop, tablet, mobile, and embedded height invariants", () => {
    const css = loadAllAppCss();
    const tabletBlock = getTabletBlock(css);
    const mobileBlock = getMainMobileBlock(css);

    const baseRule = getFirstRuleBlock(css, ".modal.task-detail-modal");
    expect(baseRule).toContain("height: 85vh;");
    expect(baseRule).toContain("max-height: calc(100dvh - var(--overlay-padding-top, 10vh) - 16px);");
    expect(baseRule).toContain("resize: both;");

    const tabletRule = getLastRuleBlock(tabletBlock, ".modal.task-detail-modal");
    expect(tabletRule).toContain("height: 92vh;");
    expect(extractVhHeight(tabletRule)).toBeGreaterThan(extractVhHeight(baseRule));
    expect(tabletRule).toContain("width: 98vw;");
    expect(tabletRule).toContain("max-width: 98vw;");
    expect(tabletBlock).toContain("--overlay-padding-top: 6vh;");
    expect(tabletRule).toContain("max-height: calc(100dvh - var(--overlay-padding-top, 6vh) - var(--space-md));");

    const mobileRule = getLastRuleBlock(mobileBlock, ".modal.task-detail-modal");
    expect(mobileRule).toContain("height: 100dvh;");
    expect(mobileRule).toContain("max-height: 100dvh;");
    expect(mobileRule).toContain("resize: none;");

    const embeddedRule = getRuleBlocks(css, ".task-detail-content--embedded")
      .find((rule) => rule.includes("height: 100%;"));
    expect(embeddedRule).toBeTruthy();
    expect(tabletBlock).not.toContain(".task-detail-content--embedded");
  });

  it("TaskDetailModal: modal-actions uses safe-area inset bottom padding", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".modal-actions {");
    expect(mobileBlock).toContain("env(safe-area-inset-bottom, 0px)");
  });

  it("TaskDetailModal: detail tabs are horizontally scrollable and tabs do not shrink", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".detail-tabs {");
    expect(mobileBlock).toContain("overflow-x: auto;");
    expect(mobileBlock).toContain(".detail-tab {");
    expect(mobileBlock).toContain("flex-shrink: 0;");
  });

  it("TaskDetailModal: refine modal goes full-screen on mobile", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".detail-refine-modal {");
    expect(mobileBlock).toContain("width: 100%;");
    expect(mobileBlock).toContain("max-width: 100%;");
  });

  it("ChangesDiffModal: mobile fullscreen rule clears desktop min size and fills the viewport", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    const modalRuleMatch = mobileBlock.match(/\.changes-diff-modal\s*\{[^}]*\}/s);
    expect(modalRuleMatch).toBeTruthy();
    const modalRule = modalRuleMatch![0];

    expect(modalRule).toContain("min-width: 0");
    expect(modalRule).toContain("min-height: 0");
    expect(modalRule).toContain("width: 100vw");
    expect(modalRule).toContain("max-width: 100vw");
    expect(modalRule).toContain("height: 100dvh");

    const headerRuleMatch = mobileBlock.match(/\.changes-diff-modal-header\s*\{[^}]*\}/s);
    expect(headerRuleMatch).toBeTruthy();
    expect(headerRuleMatch![0]).toContain("flex-wrap: wrap");

    const actionsRuleMatch = mobileBlock.match(/\.changes-diff-header-actions\s*\{[^}]*\}/s);
    expect(actionsRuleMatch).toBeTruthy();
    expect(actionsRuleMatch![0]).toContain("flex: 1 1 100%");
  });

  it("AgentDetailView: mobile fullscreen rule clears desktop min size and fills the viewport", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    const modalRuleMatch = mobileBlock.match(/\.agent-detail-modal\s*\{[^}]*\}/s);
    expect(modalRuleMatch).toBeTruthy();
    const modalRule = modalRuleMatch![0];

    expect(modalRule).toContain("min-width: 0");
    expect(modalRule).toContain("min-height: 0");
    expect(modalRule).toContain("width: 100vw");
    expect(modalRule).toContain("max-width: 100vw");
    expect(modalRule).toContain("height: 100dvh");
  });

  it("NewTaskModal: modal body unsets desktop max-height for mobile", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".new-task-modal .modal-body {");
    expect(mobileBlock).toContain("max-height: unset;");
    expect(mobileBlock).toContain("overflow-y: auto;");
  });

  it("TaskForm: model selection rows stack vertically on mobile", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".model-select-row {");
    expect(mobileBlock).toContain("flex-direction: column;");
    expect(mobileBlock).toContain(".model-select-label {");
    expect(mobileBlock).toContain("width: auto;");
    expect(mobileBlock).toContain("text-align: left;");
  });

  it("SettingsModal: layout stacks and sidebar becomes horizontal scroll row", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".settings-layout {");
    expect(mobileBlock).toContain("flex-direction: column;");
    expect(mobileBlock).toContain(".settings-sidebar {");
    expect(mobileBlock).toContain("flex-direction: row;");
    expect(mobileBlock).toContain("align-items: center;");
    expect(mobileBlock).toContain("overflow-x: auto;");
    expect(mobileBlock).toContain(".settings-nav-item {");
    expect(mobileBlock).toContain("display: flex;");
    expect(mobileBlock).toContain("align-items: center;");
    expect(mobileBlock).toContain("justify-content: center;");
    expect(mobileBlock).toContain("gap: 4px;");
  });

  it("FN-4281: SettingsModal header keeps mobile heading shrink-to-fit scaffolding", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".settings-modal .modal-header {");
    expect(mobileBlock).toContain(".settings-header-actions {");
    expect(mobileBlock).toContain(".settings-modal-heading {");

    const headingRule = mobileBlock.match(/\.settings-modal-heading\s*\{[^}]*\}/s);
    expect(headingRule).toBeTruthy();
    expect(headingRule![0]).toContain("flex: 1 1 0;");
    expect(headingRule![0]).toContain("min-width: 0;");
  });

  it("FN-4375: SettingsModal header keeps GitHub/Help/title/close on one row at ≤768px", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    const headerRule = mobileBlock.match(/\.settings-modal \.modal-header\s*\{[^}]*\}/s);
    expect(headerRule).toBeTruthy();
    expect(headerRule![0]).not.toContain("flex-wrap: wrap;");

    const actionsRule = mobileBlock.match(/\.settings-header-actions\s*\{[^}]*\}/s);
    expect(actionsRule).toBeTruthy();
    expect(actionsRule![0]).not.toContain("flex: 1 1 100%;");
    expect(actionsRule![0]).toContain("margin-left: auto;");
  });

  it("GitManagerModal: 768px mobile block includes stacked layout rules", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".gm-layout {");
    expect(mobileBlock).toContain("flex-direction: column;");
    expect(mobileBlock).toContain(".gm-sidebar {");
    expect(mobileBlock).toContain("flex-direction: row;");
  });

  it("GitManagerModal: mobile section toolbar opts back into horizontal touch scrolling", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    const sidebarRules = getRuleBlocks(mobileBlock, ".gm-sidebar");
    expect(sidebarRules.length).toBeGreaterThan(0);
    for (const sidebarRule of sidebarRules) {
      expect(sidebarRule).toContain("flex: 0 0 auto;");
      expect(sidebarRule).toContain("flex-wrap: nowrap;");
      expect(sidebarRule).toContain("min-height: calc(var(--space-2xl) + var(--space-md));");
      expect(sidebarRule).toContain("overflow-x: auto;");
      expect(sidebarRule).toContain("overflow-y: hidden;");
      expect(sidebarRule).toContain("touch-action: pan-x pan-y;");
      expect(sidebarRule).toContain("-webkit-overflow-scrolling: touch;");
      expect(sidebarRule).toContain("overscroll-behavior-x: contain;");
    }

    const navItemRules = getRuleBlocks(mobileBlock, ".gm-nav-item");
    expect(navItemRules.length).toBeGreaterThan(0);
    for (const navItemRule of navItemRules) {
      expect(navItemRule).toMatch(/flex:\s*0 0 auto;|flex-shrink:\s*0;/);
    }

    const refreshRules = getRuleBlocks(mobileBlock, ".gm-nav-refresh");
    expect(refreshRules.length).toBeGreaterThan(0);
    for (const refreshRule of refreshRules) {
      expect(refreshRule).toContain("flex: 0 0 auto;");
      expect(refreshRule).toContain("width: auto;");
    }
  });

  it("GitManagerModal: embedded narrow tab strip is independently horizontally scrollable", () => {
    const css = loadAllAppCss();
    const embeddedBlock = getEmbeddedGitManagerBlock(css);

    const sidebarRules = getRuleBlocks(embeddedBlock, ".gm-modal--embedded .gm-sidebar");
    expect(sidebarRules).toHaveLength(1);
    expect(sidebarRules[0]).toContain("flex: 0 0 auto;");
    expect(sidebarRules[0]).toContain("flex-wrap: nowrap;");
    expect(sidebarRules[0]).toContain("overflow-x: auto;");
    expect(sidebarRules[0]).toContain("overflow-y: hidden;");
    expect(sidebarRules[0]).toContain("touch-action: pan-x pan-y;");
    expect(sidebarRules[0]).toContain("-webkit-overflow-scrolling: touch;");
    expect(sidebarRules[0]).toContain("overscroll-behavior-x: contain;");

    const navItemRules = getRuleBlocks(embeddedBlock, ".gm-modal--embedded .gm-nav-item");
    expect(navItemRules).toHaveLength(1);
    expect(navItemRules[0]).toContain("flex: 0 0 auto;");
    expect(navItemRules[0]).toContain("width: auto;");

    const refreshRules = getRuleBlocks(embeddedBlock, ".gm-modal--embedded .gm-nav-refresh");
    expect(refreshRules).toHaveLength(1);
    expect(refreshRules[0]).toContain("flex: 0 0 auto;");
    expect(refreshRules[0]).toContain("width: auto;");
  });

  it("GitManagerModal: workspace repo selector does not consume the mobile tab strip", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);
    const embeddedBlock = getEmbeddedGitManagerBlock(css);

    const standaloneWrapRules = getRuleBlocks(mobileBlock, ".gm-repo-selector-wrap");
    expect(standaloneWrapRules.length).toBeGreaterThan(0);
    for (const wrapRule of standaloneWrapRules) {
      expect(wrapRule).toContain("flex: 0 0 auto;");
    }
    const standaloneSelectRules = getRuleBlocks(mobileBlock, ".gm-repo-selector");
    expect(standaloneSelectRules.length).toBeGreaterThan(0);
    for (const selectRule of standaloneSelectRules) {
      expect(selectRule).toContain("width: auto;");
    }

    const embeddedWrapRules = getRuleBlocks(embeddedBlock, ".gm-modal--embedded .gm-repo-selector-wrap");
    expect(embeddedWrapRules).toHaveLength(1);
    expect(embeddedWrapRules[0]).toContain("flex: 0 0 auto;");

    const embeddedSelectRules = getRuleBlocks(embeddedBlock, ".gm-modal--embedded .gm-repo-selector");
    expect(embeddedSelectRules).toHaveLength(1);
    expect(embeddedSelectRules[0]).toContain("width: auto;");
  });

  it("GitManagerModal: nav items keep a token-sized touch target on mobile", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".gm-nav-item {");
    expect(mobileBlock).toContain("min-height: calc(var(--space-xl) + var(--space-sm));");
  });

  it("GitManagerModal: panel allows content scrolling on mobile", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".gm-panel {");
    expect(mobileBlock).toContain("overflow-y: auto;");
  });

  it("GitManagerModal: mobile fullscreen block includes explicit overlay class and keyboard viewport rule", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    expect(mobileBlock).toContain(".modal-overlay.git-manager-modal-overlay,");
    // FNXC:GitManager 2026-06-22-09:30: The mobile viewport-takeover (and its keyboard rule)
    // is now scoped to the NON-embedded dialog via :not(.gm-modal--embedded) so the right-dock
    // embedded Git Manager keeps its 100%-of-pane sizing instead of hiding the Header/MobileNavBar.
    expect(mobileBlock).toContain(".modal.gm-modal:not(.gm-modal--embedded)[style*=\"--keyboard-overlap\"]");

    const keyboardRule = mobileBlock.match(/\.modal\.gm-modal:not\(\.gm-modal--embedded\)\[style\*=\"--keyboard-overlap\"\]\s*\{[^}]+\}/s);
    expect(keyboardRule).not.toBeNull();
    expect(keyboardRule![0]).toContain("height: var(--vv-height, 100dvh)");
    expect(keyboardRule![0]).toContain("min-height: var(--vv-height, 100dvh)");
    expect(keyboardRule![0]).toContain("max-height: var(--vv-height, 100dvh)");
    expect(keyboardRule![0]).toContain("translateY(var(--vv-offset-top, 0px))");
  });

  it("GitManagerModal: changes rows/actions wrap without widening viewport on mobile", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    const actionsRule = mobileBlock.match(/\.gm-file-section-actions\s*\{[^}]+\}/s);
    expect(actionsRule).not.toBeNull();
    expect(actionsRule![0]).toContain("flex-wrap: wrap");
    expect(actionsRule![0]).toContain("flex: 1 1 100%");

    const fileItemRule = mobileBlock.match(/\.gm-file-item\s*\{[^}]+\}/s);
    expect(fileItemRule).not.toBeNull();
    expect(fileItemRule![0]).toContain("flex-wrap: wrap");
    expect(fileItemRule![0]).toContain("min-width: 0");

    const fileSectionRule = mobileBlock.match(/\.gm-file-section\s*\{[^}]+\}/s);
    expect(fileSectionRule).not.toBeNull();
    expect(fileSectionRule![0]).toContain("max-width: 100%");
  });

  it("GitManagerModal: file sections and file lists keep independent scrolling constraints", () => {
    const css = loadAllAppCss();

    // FNXC:GitManager 2026-06-22-09:30: Multiple .gm-file-section rules exist (base + mobile
    // overrides), and concatenation order is not guaranteed, so select the BASE rule by its
    // defining flex-column property instead of relying on first-match.
    const fileSectionRule = [...css.matchAll(/\.gm-file-section\s*\{[^}]+\}/gs)]
      .map((m) => m[0])
      .find((rule) => rule.includes("display: flex"));
    expect(fileSectionRule).toBeTruthy();
    expect(fileSectionRule!).toContain("display: flex");
    expect(fileSectionRule!).toContain("flex-direction: column");
    expect(fileSectionRule!).toContain("min-height: 0");

    const fileListRule = css.match(/\.gm-file-list\s*\{[^}]+\}/s);
    expect(fileListRule).not.toBeNull();
    expect(fileListRule![0]).toContain("overflow-y: auto");
    expect(fileListRule![0]).toContain("overscroll-behavior: contain");
    expect(fileListRule![0]).toContain("-webkit-overflow-scrolling: touch");
  });

  it("GitManagerModal: modal uses full-screen viewport sizing on mobile (641-768px range)", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    // Verify .gm-modal is included in the modal sizing rule block
    const modalRuleMatch = mobileBlock.match(
      /\.modal:not\(\.confirm-dialog\),\s*\.modal-lg,\s*\.modal-md,\s*\.gm-modal\s*\{[^}]+\}/,
    );
    expect(modalRuleMatch).not.toBeNull();
    const modalRule = modalRuleMatch![0];

    // Verify full-screen constraints
    expect(modalRule).toContain("width: 100%;");
    expect(modalRule).toContain("max-width: 100%;");
    expect(modalRule).toContain("height: 100vh;");
    expect(modalRule).toContain("max-height: 100vh;");
    expect(modalRule).toContain("border-radius: 0;");
  });

  it("TaskDetailModal: action dropdown menus have max-height constraint on mobile", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    // Verify dropdown menu selectors are in mobile block (selectors share the same line)
    expect(mobileBlock).toContain(".detail-actions-menu,");
    expect(mobileBlock).toContain(".detail-move-menu {");

    // Extract the dropdown menu rule block and verify constraints
    const menuBlockMatch = mobileBlock.match(
      /\.detail-actions-menu,\s*\.detail-move-menu\s*\{[^}]+\}/s,
    );
    expect(menuBlockMatch).not.toBeNull();
    const menuBlock = menuBlockMatch![0];

    expect(menuBlock).toContain("max-height");
    expect(menuBlock).toContain("overflow-y: auto");
    expect(menuBlock).toContain("max-width: calc(100vw - calc(var(--space-lg) + var(--space-md)))");
  });

  it("TaskDetailModal: mobile back control keeps token-based touch-target sizing", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    const backControlMatch = mobileBlock.match(
      /\.task-detail-mobile-back\s*\{[^}]+\}/,
    );
    expect(backControlMatch).not.toBeNull();
    expect(backControlMatch![0]).toContain("min-height: calc(var(--space-2xl) + var(--space-xs))");
    expect(backControlMatch![0]).toContain("min-width: calc(var(--space-2xl) + var(--space-xs))");
  });

  it("TaskDetailModal: footer dropdown menus anchor toward available horizontal space", () => {
    const css = loadAllAppCss();

    const actionsMenuAnchorMatch = css.match(/^\.detail-actions-menu\s*\{\s*left: 0;\s*\}/m);
    const moveMenuAnchorMatch = css.match(/^\.detail-move-menu\s*\{\s*right: 0;\s*\}/m);
    expect(actionsMenuAnchorMatch).not.toBeNull();
    expect(moveMenuAnchorMatch).not.toBeNull();
  });

  it("TaskForm / TaskEditModal: description textarea capped at 200px height with scroll on mobile", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    // Modal edit form textarea (TaskEditModal)
    const modalEditBlockMatch = mobileBlock.match(
      /\.modal-edit-form \.form-group textarea\s*\{[^}]+\}/,
    );
    expect(modalEditBlockMatch).not.toBeNull();
    expect(modalEditBlockMatch![0]).toContain("max-height: 200px");
    expect(modalEditBlockMatch![0]).toContain("overflow-y: auto");
    expect(modalEditBlockMatch![0]).toContain("-webkit-overflow-scrolling: touch");

    // TaskForm description textarea
    const taskFormBlockMatch = mobileBlock.match(
      /\.task-form-primary-section \.description-with-refine textarea\s*\{[^}]+\}/,
    );
    expect(taskFormBlockMatch).not.toBeNull();
    expect(taskFormBlockMatch![0]).toContain("max-height: 200px");
    expect(taskFormBlockMatch![0]).toContain("overflow-y: auto");

    // Fullscreen variant restores unbounded height on mobile
    const fullscreenBlockMatch = mobileBlock.match(
      /\.task-form-primary-section \.description-with-refine\.description--fullscreen textarea\s*\{[^}]+\}/,
    );
    expect(fullscreenBlockMatch).not.toBeNull();
    expect(fullscreenBlockMatch![0]).toContain("max-height: unset");
  });

  it("AgentErrorDetailsModal: mobile fills fullscreen container and keeps inner scrolling log region", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    const modalRuleMatch = mobileBlock.match(/\.agent-error-modal\s*\{[^}]+\}/s);
    expect(modalRuleMatch).not.toBeNull();
    // The mobile rule now subtracts mobile-nav-height and safe-area-inset-bottom
    // from the parent container; assert both height and max-height are
    // calc(100% - ...) rather than the simpler `100%`.
    expect(modalRuleMatch![0]).toMatch(/height:\s*calc\(100%/);
    expect(modalRuleMatch![0]).toMatch(/max-height:\s*calc\(100%/);
    expect(modalRuleMatch![0]).toContain("min-height: 0");

    const contentRuleMatch = css.match(/\.agent-error-modal__content\s*\{[^}]+\}/s);
    expect(contentRuleMatch).not.toBeNull();
    expect(contentRuleMatch![0]).toContain("overflow: hidden");
    expect(contentRuleMatch![0]).toContain("display: flex");

    const errorRuleMatch = mobileBlock.match(/\.agent-error-modal__error\s*\{[^}]+\}/s);
    expect(errorRuleMatch).not.toBeNull();
    expect(errorRuleMatch![0]).toContain("max-height: none");
    expect(errorRuleMatch![0]).toContain("-webkit-overflow-scrolling: touch");
    expect(errorRuleMatch![0]).toContain("overscroll-behavior: contain");
  });

  it("NewTaskModal: quick fields buttons meet 36px touch target on mobile", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    // Verify the promoted screenshot action row and quick-fields dep/agent buttons keep the mobile touch target.
    const actionButtonMatch = mobileBlock.match(
      /\.task-form-description-actions \.btn\s*\{[^}]+\}/,
    );
    expect(actionButtonMatch).not.toBeNull();
    expect(actionButtonMatch![0]).toContain("min-height: 36px");

    const quickFieldsTriggerMatch = mobileBlock.match(
      /\.new-task-quick-fields \.dep-trigger\s*\{[^}]+\}/,
    );
    expect(quickFieldsTriggerMatch).not.toBeNull();
    expect(quickFieldsTriggerMatch![0]).toContain("min-height: 36px");

    const githubSelectRule = mobileBlock.match(
      /\.new-task-github-reference-picker__remote-select,\s*\.new-task-github-reference-picker__select\s*\{[^}]+\}/,
    );
    expect(githubSelectRule).not.toBeNull();
    expect(githubSelectRule![0]).toContain("min-height: calc(var(--space-xl) + var(--space-sm))");
  });

  it("NewTaskModal: mobile popup containers stay hit-testable and scrollable inside the sheet", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);
    const baseModalRule = getFirstRuleBlock(css, ".new-task-modal");

    expect(baseModalRule).toContain("pointer-events: auto");

    const taskFormDropdownRule = mobileBlock.match(
      /\.task-form \.dep-dropdown\s*\{[^}]+\}/,
    );
    expect(taskFormDropdownRule).not.toBeNull();
    expect(taskFormDropdownRule![0]).toContain("left: 0");
    expect(taskFormDropdownRule![0]).toContain("right: 0");
    expect(taskFormDropdownRule![0]).toContain("overflow-y: auto");
    expect(taskFormDropdownRule![0]).toContain("overscroll-behavior: contain");

    const quickFieldsDropdownRule = mobileBlock.match(
      /\.new-task-quick-fields \.dep-dropdown\s*\{[^}]+\}/,
    );
    expect(quickFieldsDropdownRule).not.toBeNull();
    expect(quickFieldsDropdownRule![0]).toContain("left: 0");
    expect(quickFieldsDropdownRule![0]).toContain("right: 0");
    expect(quickFieldsDropdownRule![0]).toContain("overflow-y: auto");
    expect(quickFieldsDropdownRule![0]).toContain("overscroll-behavior: contain");
  });

  it("NewTaskModal: modal body uses token-based padding on mobile", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    // Extract the new-task-modal .modal-body rule
    const modalBodyMatch = mobileBlock.match(
      /\.new-task-modal \.modal-body\s*\{[^}]+\}/,
    );
    expect(modalBodyMatch).not.toBeNull();
    // Should use var(--space-sm) for horizontal padding (not hardcoded 0)
    expect(modalBodyMatch![0]).toContain("var(--space-sm)");
    expect(modalBodyMatch![0]).toContain("var(--space-md)");
  });

  it("NewTaskModal: more options toggle uses token-based margin on mobile", () => {
    const css = loadAllAppCss();
    const mobileBlock = getMainMobileBlock(css);

    // Extract the more-options-toggle rule
    const toggleMatch = mobileBlock.match(
      /\.task-form-more-options-toggle\s*\{[^}]+\}/,
    );
    expect(toggleMatch).not.toBeNull();
    // Should use var(--space-md) for horizontal margin (not hardcoded 14px)
    expect(toggleMatch![0]).toContain("var(--space-md)");
  });
});
