import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/*
FNXC:ExternalBlockUx 2026-11-09-10:07 (RUFU-492):
RUFU-492 — "the red notice climbs over the card and the texts overlap, you cannot tell which task it is".
Every shipped assertion about this box read TaskCard.css as TEXT; jsdom computes no layout, so the geometry
the operator reported broken had never been measured. This spec measures it in a real engine:

- the clamped reason must not exceed its own line-box budget (derived from `--line-height-normal` x
  `--font-size-xs` — the token is UNITLESS, so the derivation mirrors app/utils/chatInputAutosize.ts and
  self-checks `lineHeightPx >= fontSizePx`; a scalar misread as px fails there, not as an unreachable
  fraction-of-a-pixel bound);
- the notice must not exceed the card's client box; the virtual row may exceed the card ONLY by its own
  computed in-block insets (`padding-block-end: var(--space-xs)` in Column.css is the shipped measurement
  box — asserted as a delta read from getComputedStyle, never as the constant 4 and never as an equality);
- the NEXT card must never be painted inside the blocked one — the exact operator symptom;
- the ceilings added in RUFU-492 must not bind too tight: header, title, and the actions row are asserted
  painted and inside the card, so an over-tight max-height fails here instead of shipping invisible buttons;
- `--list` and `--detail` are asserted UNCLAMPED against the clamped `--card` paint of the same reason in
  the same page — the leak that truncated the reading surfaces;
- no `height`/`min-height` declaration may exist on `.card`, `.card.external-blocked`, or
  `.external-block-notice--card` at any breakpoint, and their `max-height` values must be token
  expressions — scanned from the live CSSOM, which is where the breakpoints actually live.

The lane self-gates with no local Chromium (describe.runIf); a skip is an honest lane result, never a pass.
*/

// playwright-core is a declared dependency of @fusion/engine; resolve it from that package instead of
// adding a second copy of the protocol client to the dashboard package.
const requireFromEngine = createRequire(new URL("../../../engine/package.json", import.meta.url));
const { chromium } = requireFromEngine("playwright-core") as {
  chromium: { launch(options: { executablePath: string; headless: boolean; args?: string[] }): Promise<Browser> };
};

type Browser = { newPage(options: { viewport: { width: number; height: number } }): Promise<Page>; close(): Promise<void> };
type Page = {
  goto(url: string): Promise<unknown>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: () => T): Promise<T>;
  screenshot(options: { path: string }): Promise<void>;
  close(): Promise<void>;
  on(event: "console" | "pageerror", listener: (message: { text?(): string; message?: string }) => void): void;
};

const browserCandidates = process.platform === "darwin"
  ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
  : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = [process.env.FUSION_BROWSER_SMOKE_BROWSER, process.env.CHROME_BIN, ...browserCandidates]
  .find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate));

const artifacts = path.resolve(process.cwd(), "../../artifacts/RUFU-492");

/*
FNXC:ExternalBlockUx 2026-11-09-18:16 (RUFU-492 code review P1):
The review found this spec's predecessor reporting a green lane while writing NO evidence at all — the
`artifacts/RUFU-492/` directory simply did not exist, so nothing proved a real engine had rendered the card.
A screenshot the spec did not write is an evidence gap, not a pass, so every capture is asserted on disk
(non-existent or zero-byte both fail the test that produced it) instead of being trusted as a side effect.
*/
function expectWrittenScreenshot(file: string): void {
  expect(existsSync(file), `browser evidence missing: ${file}`).toBe(true);
  expect(statSync(file).size, `browser evidence is empty: ${file}`).toBeGreaterThan(0);
}

interface BlockedCardGeometry {
  cardHeight: number;
  cardClientHeight: number;
  cardBottom: number;
  cardMaxHeightPx: number;
  noticeHeight: number;
  noticeMaxHeightPx: number;
  reasonHeight: number;
  reasonScrollHeight: number;
  reasonClientHeight: number;
  reasonClampLines: number;
  reasonFontSizePx: number;
  lineHeightPx: number;
  lineHeightSource: "px" | "unitless-times-font-size" | "first-line-box-fallback";
  reasonTextMatchesTitle: boolean;
  reasonTextLength: number;
  actionsHeight: number;
  actionsBottom: number;
  headerHeight: number;
  headerBottom: number;
  headerBadgesHeight: number;
  headerBadgesChipRowPx: number;
  headerBadgesMaxHeightPx: number;
  titleHeight: number;
  titleLineHeightPx: number;
  titleBottom: number;
  rowHeight: number;
  rowInsetPx: number;
  nextCardTop: number | null;
}

/** Geometry of the blocked card, its notice, and the virtual row that measures it. Self-contained: runs in the page. */
function measureBlockedCard(): BlockedCardGeometry {
  const px = (value: string | null | undefined): number => {
    if (!value) return 0;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const card = document.querySelector<HTMLElement>(".card.external-blocked");
  if (!card) throw new Error("no .card.external-blocked rendered");
  const notice = card.querySelector<HTMLElement>(".external-block-notice--card");
  const reason = notice?.querySelector<HTMLElement>(".external-block-notice__reason");
  const actions = notice?.querySelector<HTMLElement>(".external-block-notice__actions");
  const header = card.querySelector<HTMLElement>(".card-header");
  const headerBadges = card.querySelector<HTMLElement>(".card-header-badges");
  const title = card.querySelector<HTMLElement>(".card-title");
  const row = card.closest<HTMLElement>(".column-virtual-row");
  if (!notice || !reason || !actions || !header || !headerBadges || !title || !row) {
    throw new Error("blocked card is not fully rendered (notice, actions, and both identity rows are required)");
  }
  const nextCard = row.nextElementSibling?.querySelector<HTMLElement>(".card") ?? null;

  const reasonStyle = getComputedStyle(reason);
  const fontSizePx = px(reasonStyle.fontSize);
  /*
  `--line-height-normal` is unitless, so `getComputedStyle(...).lineHeight` may report a scalar. Honour a
  px suffix, else multiply by the font size — the same resolution as getChatInputBoxMetrics() in
  app/utils/chatInputAutosize.ts. When even that is unresolvable, measure the FIRST LINE BOX with a Range
  (the reported symptom itself proves first-line boxes exist).
  */
  const lineHeightValue = (reasonStyle.lineHeight ?? "").trim();
  let lineHeightPx = 0;
  let lineHeightSource: BlockedCardGeometry["lineHeightSource"] = "px";
  if (lineHeightValue.endsWith("px")) {
    lineHeightPx = px(lineHeightValue);
  } else {
    const scalar = Number.parseFloat(lineHeightValue);
    if (Number.isFinite(scalar) && fontSizePx > 0) {
      lineHeightPx = scalar * fontSizePx;
      lineHeightSource = "unitless-times-font-size";
    }
  }
  if (!(lineHeightPx > 0)) {
    lineHeightSource = "first-line-box-fallback";
    const textNode = Array.from(reason.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 0);
    if (textNode) {
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, Math.min(1, textNode.textContent?.length ?? 0));
      const first = range.getClientRects()[0];
      if (first) lineHeightPx = first.height;
    }
  }

  // The row may legitimately exceed the card ONLY by the row's own in-block insets. Read them from the
  // row itself — Column.css is the measuring stick of this spec, not its target.
  const rowStyle = getComputedStyle(row);
  const rowInsetPx = px(rowStyle.paddingBlockStart) + px(rowStyle.paddingBlockEnd) + px(rowStyle.borderTopWidth) + px(rowStyle.borderBottomWidth);

  const clampRaw = reasonStyle.getPropertyValue("-webkit-line-clamp").trim();

  return {
    cardHeight: card.getBoundingClientRect().height,
    cardClientHeight: card.clientHeight,
    cardBottom: card.getBoundingClientRect().bottom,
    cardMaxHeightPx: px(getComputedStyle(card).maxHeight),
    noticeHeight: notice.getBoundingClientRect().height,
    noticeMaxHeightPx: px(getComputedStyle(notice).maxHeight),
    reasonHeight: reason.getBoundingClientRect().height,
    reasonScrollHeight: reason.scrollHeight,
    reasonClientHeight: reason.clientHeight,
    reasonClampLines: Number.parseInt(clampRaw, 10),
    reasonFontSizePx: fontSizePx,
    lineHeightPx,
    lineHeightSource,
    reasonTextMatchesTitle: (reason.textContent ?? "") === (reason.getAttribute("title") ?? ""),
    reasonTextLength: (reason.textContent ?? "").length,
    actionsHeight: actions.getBoundingClientRect().height,
    actionsBottom: actions.getBoundingClientRect().bottom,
    headerHeight: header.getBoundingClientRect().height,
    headerBottom: header.getBoundingClientRect().bottom,
    // The tight-shape witnesses: the badge group's own height against the ONE chip row its `min-height`
    // declares, and the title's height against its own computed line box. Both are read from the nodes,
    // never hardcoded, so "the fixture really wrapped" is a measurement rather than an assumption.
    headerBadgesHeight: headerBadges.getBoundingClientRect().height,
    headerBadgesChipRowPx: px(getComputedStyle(headerBadges).minHeight),
    headerBadgesMaxHeightPx: px(getComputedStyle(headerBadges).maxHeight),
    titleHeight: title.getBoundingClientRect().height,
    titleLineHeightPx: (() => {
      const titleStyle = getComputedStyle(title);
      const raw = (titleStyle.lineHeight ?? "").trim();
      const titleFontSizePx = px(titleStyle.fontSize);
      if (raw.endsWith("px")) return px(raw);
      const scalar = Number.parseFloat(raw);
      return Number.isFinite(scalar) && titleFontSizePx > 0 ? scalar * titleFontSizePx : 0;
    })(),
    titleBottom: title.getBoundingClientRect().bottom,
    rowHeight: row.getBoundingClientRect().height,
    rowInsetPx,
    nextCardTop: nextCard ? nextCard.getBoundingClientRect().top : null,
  };
}

interface CeilingDeclaration {
  selector: string;
  prop: string;
  value: string;
  media: string;
}

/** Every height/min-height/max-height declared EXACTLY on the three measured selectors, at any breakpoint, from the live CSSOM. */
function scanCeilingDeclarations(): CeilingDeclaration[] {
  const targets = new Set([".card", ".card.external-blocked", ".external-block-notice--card"]);
  const props = ["height", "min-height", "max-height"];
  const out: CeilingDeclaration[] = [];
  const walk = (rules: CSSRuleList, media: string): void => {
    for (const rule of Array.from(rules)) {
      // Since CSS Nesting shipped, CSSStyleRule ITSELF carries `cssRules` (empty when there is none),
      // so a group-first check would recurse every plain style rule past its own declarations.
      if (rule instanceof CSSStyleRule) {
        for (const part of rule.selectorText.split(",").map((s) => s.trim())) {
          if (!targets.has(part)) continue;
          for (const prop of props) {
            const value = rule.style.getPropertyValue(prop).trim();
            if (value) out.push({ selector: part, prop, value, media });
          }
        }
        continue;
      }
      const conditional = rule as CSSConditionRule;
      if (conditional.cssRules) {
        walk(conditional.cssRules, media ? `${media} && ${conditional.conditionText ?? ""}` : (conditional.conditionText ?? media));
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      if (sheet.cssRules) walk(sheet.cssRules, "");
    } catch {
      // A cross-origin sheet is not this app's cascade; skip it.
    }
  }
  return out;
}

interface VariantPaint {
  variant: string;
  clamp: string;
  reasonHeight: number;
  reasonScrollHeight: number;
  reasonClientHeight: number;
}

/** The three notice variants of the SAME long reason at identical width, painted in one page. */
function measureVariantPaint(): VariantPaint[] {
  return ["card", "list", "detail"].map((variant) => {
    const host = document.querySelector<HTMLElement>(`[data-variant-host="${variant}"]`);
    if (!host) throw new Error(`missing variant host: ${variant}`);
    const reason = host.querySelector<HTMLElement>(".external-block-notice__reason");
    if (!reason) throw new Error(`missing reason in variant ${variant}`);
    return {
      variant,
      clamp: getComputedStyle(reason).getPropertyValue("-webkit-line-clamp").trim(),
      reasonHeight: reason.getBoundingClientRect().height,
      reasonScrollHeight: reason.scrollHeight,
      reasonClientHeight: reason.clientHeight,
    };
  });
}

describe.runIf(executablePath)("RUFU-492 blocked-card containment in a real browser", () => {
  let server: ViteDevServer;
  let browser: Browser;
  let baseUrl = "";

  beforeAll(async () => {
    server = await createServer({ root: process.cwd(), server: { host: "127.0.0.1", port: 0, watch: null }, logLevel: "error" });
    await server.listen();
    baseUrl = server.resolvedUrls?.local[0] ?? "";
    browser = await chromium.launch({
      executablePath: executablePath!,
      headless: true,
      ...(process.env.CI ? { args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] } : {}),
    });
    await mkdir(artifacts, { recursive: true });
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await Promise.race([server?.watcher.close(), new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    server?.ws.close();
    server?.httpServer?.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server?.httpServer?.close((error) => (error ? reject(error) : resolve())));
    await server?.pluginContainer.close();
  }, 30_000);

  async function openSurface(surface: string, viewport: { width: number; height: number }) {
    const page = await browser.newPage({ viewport });
    // A page-load ReferenceError would otherwise surface only as an opaque waitForSelector timeout; the
    // neighbouring browser specs (task-search, view-layout, task-modal-touch-resize) all attach this.
    page.on("pageerror", (event) => console.error(`[external-block-geometry-browser] ${event.message ?? ""}`));
    await page.goto(`${baseUrl}app/external-block-e2e-fixture.html?surface=${surface}`);
    await page.waitForSelector(surface === "variants" ? "[data-testid=\"external-block-variants\"]" : ".card.external-blocked", { timeout: 20_000 });
    await page.waitForTimeout(350);
    return page;
  }

  /*
  FNXC:ExternalBlockUx 2026-11-09-18:16 (RUFU-492 code review P0):
  The ceiling only protects the operator if it is measured against the shape that actually broke. The two
  identity rows the card ceiling budgets are `.card-title` (which has no clamp of its own) and
  `.card-header-badges` (flex-wrap: wrap), so a fixture with a short title and no header badges would let
  every non-crush assertion pass on a card that never grew. The tight shape is therefore ASSERTED, in
  derived terms only: the badge group's height against its OWN declared one-chip-row `min-height` (it must
  exceed it, so the badges really wrapped) and against its OWN declared `max-height` (it must not exceed
  it, so the clip the ceiling budgets is the clip that paints); the title against its own computed line
  box the same way. No pixel literal appears, because a literal is exactly what a future theme breaks.
  */
  function expectTightIdentityShape(g: BlockedCardGeometry): void {
    expect(g.headerBadgesChipRowPx, "the badge group declares a one-chip-row min-height").toBeGreaterThan(0);
    expect(g.headerBadgesHeight, "fixture must wrap its header badges onto a second row").toBeGreaterThan(g.headerBadgesChipRowPx * 1.5);
    expect(g.headerBadgesMaxHeightPx, "the badge group must carry the declared bound").toBeGreaterThan(0);
    expect(g.headerBadgesHeight).toBeLessThanOrEqual(g.headerBadgesMaxHeightPx + 1);

    expect(g.titleLineHeightPx, "the title line box must resolve").toBeGreaterThan(0);
    expect(g.titleHeight, "fixture must paint a multi-line title").toBeGreaterThan(g.titleLineHeightPx * 1.5);
    // The title is clamped to exactly the two lines the card ceiling budgets.
    expect(g.titleHeight).toBeLessThanOrEqual(g.titleLineHeightPx * 2 + 1);

    // And the whole tight card still fits inside its declared ceiling — the assertion that makes the
    // ceiling honest rather than optimistic.
    expect(g.cardMaxHeightPx).toBeGreaterThan(0);
    expect(g.cardHeight).toBeLessThanOrEqual(g.cardMaxHeightPx + 1);
  }

  /*
  FNXC:ExternalBlockUx 2026-11-09-10:07 (RUFU-492):
  The exact reproduction from the report: a ~70-line agent-authored reason on a blocked card. Every bound
  below is measured, not declared: the line budget is derived from the reason's own computed font metrics
  (with the `lineHeightPx >= fontSizePx` self-check that catches a unitless scalar misread as px), the row
  budget from the row's own computed insets, and the "not crushed" half from the identity rows and the
  actions row being painted INSIDE the card.
  */
  it("contains the clamped reason, the notice, and the row within the blocked card on desktop", async () => {
    const page = await openSurface("board", { width: 1440, height: 900 });
    const g = await page.evaluate(measureBlockedCard);

    // The reported shape is really rendered: > 3 000 chars sit in the DOM, title-inclusive.
    expect(g.reasonTextLength).toBeGreaterThan(3_000);
    expect(g.reasonTextMatchesTitle).toBe(true);

    // The line budget is derived from real metrics, and the derivation itself is checked.
    expect(g.lineHeightSource).not.toBe("first-line-box-fallback");
    expect(g.lineHeightPx).toBeGreaterThanOrEqual(g.reasonFontSizePx);
    expect(g.reasonClampLines).toBeGreaterThan(0);
    expect(g.reasonHeight).toBeLessThanOrEqual((g.reasonClampLines + 0.5) * g.lineHeightPx + 1);

    // The clip is real, not merely computed: the painted box is shorter than its own content.
    expect(g.reasonScrollHeight).toBeGreaterThan(g.reasonClientHeight);
    expect(g.reasonHeight).toBeLessThan(g.reasonScrollHeight - g.lineHeightPx);

    // The card is a card: positive height, and the ceilings resolve to real lengths (an unresolved
    // calc() would compute to `none` -> 0 here).
    expect(g.cardHeight).toBeGreaterThan(0);
    expect(g.cardClientHeight).toBeGreaterThan(0);
    expect(g.cardMaxHeightPx).toBeGreaterThan(0);
    expect(g.noticeMaxHeightPx).toBeGreaterThan(0);

    // Containment: the notice never exceeds the card's own client box (clientHeight excludes the
    // 1px .card border); the whole card stays inside its declared ceiling.
    expect(g.noticeHeight).toBeLessThanOrEqual(g.cardClientHeight + 1);
    expect(g.cardHeight).toBeLessThanOrEqual(g.cardMaxHeightPx + 1);

    // Not crushed: identity rows and the actions row are painted and inside the card. An over-tight
    // max-height fails HERE instead of shipping invisible buttons.
    expect(g.headerHeight).toBeGreaterThan(0);
    expect(g.titleHeight).toBeGreaterThan(0);
    expect(g.actionsHeight).toBeGreaterThan(0);
    expect(g.actionsBottom).toBeLessThanOrEqual(g.cardBottom + 1);
    expect(g.headerBottom).toBeLessThanOrEqual(g.cardBottom + 1);
    expect(g.titleBottom).toBeLessThanOrEqual(g.cardBottom + 1);

    // The shape under test is the tight one, not a mild card that never exercises the budgeted rows.
    expectTightIdentityShape(g);

    // The row agrees with the card within the row's OWN computed in-block insets — never an equality,
    // never the constant 4 (Column.css is this spec's measuring stick, not its target).
    expect(g.rowHeight).toBeGreaterThanOrEqual(g.cardHeight);
    expect(g.rowHeight - g.cardHeight).toBeLessThanOrEqual(g.rowInsetPx + 1);

    // The operator symptom: the NEXT card is never painted inside this one.
    expect(g.nextCardTop).not.toBeNull();
    expect(g.nextCardTop!).toBeGreaterThanOrEqual(g.cardBottom - 1);

    // The declared authority itself: no height/min-height on the three selectors at any breakpoint,
    // and every ceiling value is a token expression, not a px literal.
    const declarations = await page.evaluate(scanCeilingDeclarations);
    expect(declarations.filter((d) => d.prop === "height" || d.prop === "min-height")).toEqual([]);
    const ceilings = declarations.filter((d) => d.prop === "max-height");
    expect(ceilings.length).toBeGreaterThanOrEqual(2);
    for (const ceiling of ceilings) {
      expect(ceiling.value).toContain("var(");
      expect(ceiling.value, `px literal in ${ceiling.selector}: ${ceiling.value}`).not.toMatch(/\d+px/);
    }

    const desktopShot = path.join(artifacts, "blocked-card-desktop-1440.png");
    await page.screenshot({ path: desktopShot });
    expectWrittenScreenshot(desktopShot);
    await page.close();
  }, 90_000);

  /*
  FNXC:ExternalBlockUx 2026-11-09-10:07 (RUFU-492):
  Cause 1 of the report was the leak, not the clamp: the mechanism sat on the SHARED `__reason` rule, so
  `--list` and `--detail` — the surfaces whose job is to read the whole obstacle report — showed three
  lines of it. Here all three variants paint the same reason at the same width in one page: the two
  reading surfaces must be unclamped (`-webkit-line-clamp: none`, scrollHeight === clientHeight) and the
  comparison only a real unclamped paint can satisfy (>= 4x the clamped card-face height).
  */
  it("paints the whole reason on --list and --detail while --card stays clamped", async () => {
    const page = await openSurface("variants", { width: 1280, height: 900 });
    const paints = await page.evaluate(measureVariantPaint);
    const byVariant = new Map(paints.map((p) => [p.variant, p]));

    const card = byVariant.get("card")!;
    expect(Number.parseInt(card.clamp, 10)).toBeGreaterThan(0);

    for (const variant of ["list", "detail"]) {
      const paint = byVariant.get(variant)!;
      expect(paint.clamp).toBe("none");
      expect(paint.reasonScrollHeight).toBeGreaterThan(0);
      expect(paint.reasonScrollHeight).toBe(paint.reasonClientHeight);
      // The full ~70-line report against the 3-line card face: only unclamped painting clears 4x.
      expect(paint.reasonHeight).toBeGreaterThanOrEqual(card.reasonHeight * 4);
    }

    const variantsShot = path.join(artifacts, "blocked-notice-variants-desktop.png");
    await page.screenshot({ path: variantsShot });
    expectWrittenScreenshot(variantsShot);
    await page.close();
  }, 90_000);

  /*
  FNXC:ExternalBlockUx 2026-11-09-10:07 (RUFU-492):
  The 768px media block today reflows direction and enlarges the button floors — it never carried a
  clamp, and none is needed because the mechanism is selector-scoped, not viewport-scoped. This run
  EXERCISES that block for real: the ceiling's actions term is `max(--space-xl, --touch-target-min-size)`
  precisely so the 44px mobile floor cannot make the declared ceiling bind too tight. A repeat of a
  passing desktop assertion would be a defect; this exercises the different button geometry under the
  same ceilings.
  */
  const responsiveWidths = [
    ["phone", 390, 844],
    ["tablet-portrait", 768, 1024],
  ] as const;
  it.each(responsiveWidths)("keeps the blocked card a card and the next row unoverlapped at %s width (%ix%i)", async (label, width, height) => {
    const page = await openSurface("board", { width, height });
    const g = await page.evaluate(measureBlockedCard);

    expect(g.cardHeight).toBeGreaterThan(0);
    expect(g.noticeHeight).toBeLessThanOrEqual(g.cardClientHeight + 1);
    expect(g.reasonClampLines).toBeGreaterThan(0);
    expect(g.lineHeightPx).toBeGreaterThanOrEqual(g.reasonFontSizePx);
    expect(g.reasonHeight).toBeLessThanOrEqual((g.reasonClampLines + 0.5) * g.lineHeightPx + 1);
    expect(g.reasonScrollHeight).toBeGreaterThan(g.reasonClientHeight);

    // The media block's 44px touch floors stand INSIDE the token-derived ceiling.
    expect(g.actionsHeight).toBeGreaterThan(0);
    expect(g.actionsBottom).toBeLessThanOrEqual(g.cardBottom + 1);
    expect(g.headerHeight).toBeGreaterThan(0);
    expect(g.titleHeight).toBeGreaterThan(0);

    // The same tight shape at the mobile/tablet widths, where the touch button floors and the smaller
    // card padding change the arithmetic the declared ceiling has to survive.
    expectTightIdentityShape(g);

    expect(g.rowHeight).toBeGreaterThanOrEqual(g.cardHeight);
    expect(g.rowHeight - g.cardHeight).toBeLessThanOrEqual(g.rowInsetPx + 1);
    expect(g.nextCardTop).not.toBeNull();
    expect(g.nextCardTop!).toBeGreaterThanOrEqual(g.cardBottom - 1);

    const declarations = await page.evaluate(scanCeilingDeclarations);
    expect(declarations.filter((d) => d.prop === "height" || d.prop === "min-height")).toEqual([]);
    for (const ceiling of declarations.filter((d) => d.prop === "max-height")) {
      expect(ceiling.value).toContain("var(");
      expect(ceiling.value, `px literal in ${ceiling.selector}: ${ceiling.value}`).not.toMatch(/\d+px/);
    }

    const responsiveShot = path.join(artifacts, `blocked-card-${label}-${width}x${height}.png`);
    await page.screenshot({ path: responsiveShot });
    expectWrittenScreenshot(responsiveShot);
    await page.close();
  }, 90_000);
});
