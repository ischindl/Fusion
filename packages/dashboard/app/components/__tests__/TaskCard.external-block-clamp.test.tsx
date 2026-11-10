/*
FNXC:ExternalBlockUx 2026-10-02-10:51 (RUFU-492):
An external-block card whose obstacle reason was agent-authored prose (~70 rendered lines) painted a red
overlay taller than its card: `inset: 0` on `--card` fixes the box edges but never clipped children, so the
text spilled over the next column and the dock, and because the card sits in `column-virtual-row` — measured
before the overlay grew — the virtual list drew the NEXT card inside it, so lines rendered on top of lines.

Two invariants are pinned here. The clamp is visual only: the DOM keeps the whole sentence and the actions
still receive the raw reason, so an operator can act on it. And the clamp is a CSS construct the next edit
must not drop, which is what the style assertions guard.
*/
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { ExternalBlockNotice } from "../TaskCard";
import { readAppFile } from "../../test/cssFixture";

vi.mock("../ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../PrCreateModal", () => ({ PrCreateModal: () => null }));
vi.mock("../../hooks/useTaskDiffStats", () => ({ useTaskDiffStats: () => ({ stats: null, loading: false }) }));
vi.mock("../../hooks/useBadgeWebSocket", () => ({ useBadgeWebSocket: () => ({ badgeUpdates: new Map(), isConnected: true }) }));
vi.mock("../../hooks/useBatchBadgeFetch", () => ({ getFreshBatchData: vi.fn(() => null) }));

// Long enough to be the real shape: an agent writing its whole reasoning into the obstacle message.
const LONG_REASON = Array.from(
  { length: 70 },
  (_, i) => `line ${i}: REPAIR ladder evidence, publish.yml protection_rules [] and trunk divergence.`,
).join("\n");

const blocked = {
  id: "STAS-285",
  title: "Blocked",
  description: "",
  column: "in-progress",
  dependencies: [],
  steps: [],
  currentStep: 0,
  status: "blocked",
  paused: true,
  pausedReason: "external-block",
  externalBlock: {
    origin: "network",
    code: "ETIMEDOUT",
    message: LONG_REASON,
    source: "session-failure",
  },
} as Task;

function css() {
  return readAppFile("components/TaskCard.css");
}

function ruleBody(source: string, selector: string): string {
  const at = source.indexOf(`\n${selector} {`);
  expect(at, `missing selector ${selector}`).toBeGreaterThan(-1);
  const open = source.indexOf("{", at);
  return source.slice(open + 1, source.indexOf("}", open));
}

describe("external-block notice stays inside its card", () => {
  it("clamps the reason to a bounded number of lines on the card face", () => {
    // The mechanism moved off the shared rule onto the card-scoped one, because `--list` and `--detail`
    // must paint the whole obstacle report. `-webkit-line-clamp` binds only on a `-webkit-box`, so the
    // case asserts the whole mechanism travels together, `min-height: 0` included.
    const body = ruleBody(css(), ".external-block-notice--card .external-block-notice__reason");
    expect(body).toMatch(/display:\s*-webkit-box/);
    expect(body).toMatch(/-webkit-box-orient:\s*vertical/);
    expect(body).toMatch(/-webkit-line-clamp:\s*\d+/);
    expect(body).toMatch(/line-clamp:\s*\d+/);
    expect(body).toMatch(/overflow:\s*hidden/);
    // A flex child that may not shrink below its content is the classic way a clamp silently stops binding.
    expect(body).toMatch(/min-height:\s*0/);
  });

  /*
  FNXC:ExternalBlockUx 2026-11-09-10:07 (RUFU-492):
  The negative half of the scoping. The shared `__reason` rule is what made the board card's truncation
  leak into Task Detail and both ListView branches — the surfaces whose purpose is to read the whole
  reason. If the mechanism ever moves back onto the shared rule, this case fails at the moment of the
  edit instead of re-truncating the operator's obstacle report on the reading surfaces.
  */
  it("keeps the shared reason rule unclamped so --list and --detail paint the whole reason", () => {
    const base = ruleBody(css(), ".external-block-notice__reason");
    expect(base).not.toMatch(/line-clamp/);
    expect(base).not.toMatch(/display:\s*-webkit-box/);
    expect(base).not.toMatch(/-webkit-box-orient/);
    expect(base).not.toMatch(/overflow:\s*hidden/);
    // The base rule keeps its paint/wrap properties, and the flex-shrink floor with them.
    expect(base).toMatch(/overflow-wrap:\s*anywhere/);
    expect(base).toMatch(/min-height:\s*0/);
  });

  it("clips the notice, keeps its actions, and does not float over hidden content", () => {
    const overlay = ruleBody(css(), ".external-block-notice--card");
    expect(overlay).toMatch(/overflow:\s*hidden/);
    // The notice is the card's content, not a film above it: absolute + inset would make the card keep the
    // height of content nobody can see (measured 432 px on the live board).
    expect(overlay).toMatch(/position:\s*static/);
    expect(overlay).not.toMatch(/position:\s*absolute/);
    // The ceiling is a ceiling: a height or min-height on the panel would make every geometric
    // containment assertion trivially true (RUFU-492 measurement-honesty requirement).
    expect(overlay).not.toMatch(/(^|[^-])\bheight:/m);
    expect(overlay).not.toMatch(/min-height:/);
    expect(ruleBody(css(), ".external-block-notice__actions")).toMatch(/flex:\s*0 0 auto/);
    // Hidden siblings must leave the layout, or the card stays tall around the notice — but the header
    // (task id) and the title must survive it: hiding them made the blocked card unidentifiable.
    const hidden = ruleBody(css(), ".card.external-blocked > :not(.external-block-notice):not(.card-header):not(.card-title)");
    expect(hidden).toMatch(/display:\s*none/);
  });

  /*
  FNXC:ExternalBlockUx 2026-11-09-10:07 (RUFU-492):
  Cause 2 of the report: the blocked card's height was bounded only as a side effect of the reason clamp.
  Both ceilings are now declared as calc() sums over named tokens — the card's padding token differs
  across the UI style axis, so any px figure would be a lie. A bare px literal (except 0) in these two
  declarations fails this case; the real bound is proven by the browser spec on the
  `dashboard-browser-touch` lane.
  */
  it("declares token-only ceilings on the blocked card and the card-face notice", () => {
    const blockedCard = ruleBody(css(), ".card.external-blocked");
    expect(blockedCard).toMatch(/max-height:\s*calc\(/);
    // Ceiling, never a frame: a declared height or min-height would crush the card into a fixed box.
    expect(blockedCard).not.toMatch(/(^|\s)height:/m);
    expect(blockedCard).not.toMatch(/min-height:/);
    // No px literal may stand inside the two ceiling derivations (0 is the only allowed bare length).
    for (const selector of [".card.external-blocked", ".external-block-notice--card"]) {
      const body = ruleBody(css(), selector);
      const maxHeights = body.match(/max-height:[^;]+;/g) ?? [];
      expect(maxHeights.length).toBeGreaterThan(0);
      for (const declaration of maxHeights) {
        expect(declaration, `px literal in ${selector}: ${declaration}`).not.toMatch(/\b\d+px/);
      }
    }
    // The ceiling reaches the panel through the custom property declared on the card, so one derivation
    // rules both boxes and the two cannot drift.
    expect(blockedCard).toMatch(/--external-block-notice-ceiling:/);
    expect(ruleBody(css(), ".external-block-notice--card")).toMatch(/max-height:\s*var\(--external-block-notice-ceiling\)/);
  });

  /*
  FNXC:ExternalBlockUx 2026-11-09-18:16 (RUFU-492 code review P0):
  A ceiling is only a ceiling while every term it budgets is bounded. `.card-title` carries no clamp of its
  own and `.card-header-badges` wraps (`flex-wrap: wrap` + `row-gap`), so both identity rows could grow
  past the terms the card ceiling sums — and because `.card` is `display: block` with `overflow: visible`
  by contract, the excess pushed the red notice BELOW the card's border box, which is the operator's
  original symptom. Both rows are therefore bounded here, from ONE custom property so the badge clip and
  the ceiling term cannot drift apart, and the title clamps to exactly the two lines the ceiling budgets.
  The measured proof of the same invariant (against a card whose badges really do wrap) is the
  `dashboard-browser-touch` spec `external-block-card-geometry-browser.test.ts`.
  */
  it("bounds the two identity rows the blocked-card ceiling budgets", () => {
    const source = css();
    const blockedCard = ruleBody(source, ".card.external-blocked");
    // One derivation rules both the badge group's clip and the ceiling term that budgets it.
    expect(blockedCard).toMatch(/--blocked-card-header-rows:\s*calc\(\s*2 \* var\(--card-chip-height\)\s*\+\s*var\(--space-xs\)\s*\)/);
    expect(blockedCard).toMatch(/var\(--blocked-card-header-rows\)/);
    // The title term is TWO line boxes, matching the clamp below — one line would re-open the P0.
    expect(blockedCard).toMatch(/var\(--line-height-normal\) \* var\(--font-size-sm\) \* 2/);

    const badges = ruleBody(source, ".card.external-blocked .card-header-badges");
    expect(badges).toMatch(/max-height:\s*var\(--blocked-card-header-rows\)/);
    expect(badges).toMatch(/overflow:\s*hidden/);

    // The mechanism travels together: -webkit-line-clamp binds only on a -webkit-box.
    const title = ruleBody(source, ".card.external-blocked .card-title");
    expect(title).toMatch(/display:\s*-webkit-box/);
    expect(title).toMatch(/-webkit-box-orient:\s*vertical/);
    expect(title).toMatch(/-webkit-line-clamp:\s*2/);
    expect(title).toMatch(/line-clamp:\s*2/);
    expect(title).toMatch(/overflow:\s*hidden/);
  });

  it("keeps the whole obstacle text available even though it renders clamped", () => {
    const explain = vi.fn();
    render(
      <ExternalBlockNotice task={blocked} variant="card" onOpenChatWithPrefill={explain} onRetryTask={vi.fn()} />,
    );
    const notice = screen.getByTestId("external-block-card-STAS-285");
    const reason = notice.querySelector(".external-block-notice__reason");
    expect(reason).not.toBeNull();
    // CSS clamps the paint; the node still carries the full sentence, in text and in its tooltip.
    expect(reason!.textContent).toContain("REPAIR ladder evidence");
    expect(reason!.textContent!.length).toBeGreaterThan(3000);
    fireEvent.click(screen.getByRole("button", { name: "Explain this error" }));
    expect(explain).toHaveBeenCalledWith(expect.stringContaining("REPAIR ladder evidence"));
  });

  it("keeps the blocked card identifiable while its body is hidden", () => {
    render(
      <ExternalBlockNotice task={blocked} variant="card" onOpenChatWithPrefill={vi.fn()} onRetryTask={vi.fn()} />,
    );
    // The notice names the card it belongs to, so the identity survives even where the header is not rendered.
    expect(screen.getByTestId("external-block-card-STAS-285").textContent).toContain("STAS-285");
  });
});
