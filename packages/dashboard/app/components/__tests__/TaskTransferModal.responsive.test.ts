import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/*
FNXC:CrossProjectHandoff 2026-09-11-02:45 (RUFU-211):
Structural guards for the transfer modal's responsive CSS — the one thing RTL unit tests cannot
prove (jsdom never applies @media). Probing the real stylesheets in headless chromium showed the
error row laid out correctly at 1440px but the whole project picker `display:none` at ≤768px:
ProjectSelector.css hides `.project-selector` document-globally on phones (the header replaces it
with `.mobile-project-switch`), which also suppressed the picker inside the transfer modal. These
assertions pin the in-modal re-show override and the 36px touch floors, so a future edit to either
stylesheet that re-breaks phone operability fails here rather than shipping.
*/

const css = readFileSync(resolve(__dirname, "../TaskTransferModal.css"), "utf8");

/** Strip comment bodies so guards assert declarations/selectors, never prose. */
function code(cssText: string): string {
  return cssText.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("TaskTransferModal.css — bounded-discovery error row", () => {
  it("lays the message + Retry pair out as a flex row on pointer-sized screens", () => {
    const body = code(css).match(/\.task-transfer-modal__error(?:\s*>\s*\.btn)?\s*\{([^}]*)\}/g) ?? [];
    const declarations = body.join("\n");
    expect(declarations).toMatch(/display:\s*flex/);
    expect(declarations).toMatch(/gap:\s*var\(--space-sm\)/);
    expect(declarations).toMatch(/\.task-transfer-modal__error\s*>\s*\.btn\s*\{[^}]*margin-left:\s*auto/);
  });

  it("stacks the error row and keeps Retry a full-width tap target at ≤768px", () => {
    const mobileBlock = code(css).match(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)\n\}/g) ?? [];
    const joined = mobileBlock.join("\n");
    expect(joined).toMatch(/\.task-transfer-modal__error\s*\{[^}]*flex-direction:\s*column/);
    expect(joined).toMatch(/\.task-transfer-modal__error\s*>\s*\.btn\s*\{[^}]*min-height:\s*36px/);
  });

  it("uses only design tokens and color-mix in the error surface (no raw hex/rgba)", () => {
    expect(code(css)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code(css)).not.toMatch(/rgba?\(/);
  });
});

describe("TaskTransferModal.css — phone operability of the in-modal picker", () => {
  it("re-shows the project picker inside the modal against the ≤768px global hide", () => {
    // Specificity (0,2,0): `.task-transfer-modal .project-selector` outranks ProjectSelector.css's
    // bare `@media (max-width: 768px) { .project-selector { display: none } }`. Anchored to line
    // start so the data-viewport-mode variant's selector tail cannot satisfy this guard.
    expect(code(css)).toMatch(
      /^\.task-transfer-modal\s+\.project-selector\s*\{[^}]*display:\s*inline-flex/m,
    );
  });

  it("re-shows the picker against the data-viewport-mode=mobile global hide", () => {
    // Specificity (0,3,1) vs ProjectSelector.css's `html[data-viewport-mode="mobile"]
    // .project-selector` (0,2,1) — phones report a mobile viewport mode at ANY CSS width.
    expect(code(css)).toMatch(
      /html\[data-viewport-mode="mobile"\]\s+\.task-transfer-modal\s+\.project-selector\s*\{[^}]*display:\s*inline-flex/,
    );
  });

  it("gives trigger, search row, and project rows the 36px touch floor at ≤768px", () => {
    const mobileBlock = code(css).match(/@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*?)\n\}/g) ?? [];
    const joined = mobileBlock.join("\n");
    expect(joined).toMatch(
      /\.task-transfer-modal\s+\.project-selector__trigger,[\s\S]*?\.project-selector__search,[\s\S]*?\.project-selector__item\s*\{[^}]*min-height:\s*36px/,
    );
  });
});
