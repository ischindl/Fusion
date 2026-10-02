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
  it("clamps the reason to a bounded number of lines", () => {
    const body = ruleBody(css(), ".external-block-notice__reason");
    expect(body).toMatch(/-webkit-line-clamp:\s*\d+/);
    expect(body).toMatch(/line-clamp:\s*\d+/);
    expect(body).toMatch(/overflow:\s*hidden/);
    // A flex child that may not shrink below its content is the classic way a clamp silently stops binding.
    expect(body).toMatch(/min-height:\s*0/);
  });

  it("clips the notice, keeps its actions, and does not float over hidden content", () => {
    const overlay = ruleBody(css(), ".external-block-notice--card");
    expect(overlay).toMatch(/overflow:\s*hidden/);
    // The notice is the card's content, not a film above it: absolute + inset would make the card keep the
    // height of content nobody can see (measured 432 px on the live board).
    expect(overlay).toMatch(/position:\s*static/);
    expect(overlay).not.toMatch(/position:\s*absolute/);
    expect(ruleBody(css(), ".external-block-notice__actions")).toMatch(/flex:\s*0 0 auto/);
    // Hidden siblings must leave the layout, or the card stays tall around the notice.
    expect(ruleBody(css(), ".card.external-blocked > :not(.external-block-notice)")).toMatch(/display:\s*none/);
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
});
