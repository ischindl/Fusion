import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/*
FNXC:BoardOrdering 2026-11-13-15:25 (RUFU-526):
RUFU-526 — « the board's first screen must show work that needs attention first; idle/backlog cards must
never bury actionable items ». The headline acceptance is a VIEWPORT property: one failed card among 200+
idle `todo` cards must render inside the first screen at desktop width AND on a phone, with no scrolling.

Why this lane had to exist: a jsdom render cannot answer it. jsdom runs no layout engine, so every
`getBoundingClientRect()` it returns is zero and every `offsetHeight` is 0 — a geometry assertion written
there would pass on a board that renders the card below every fold. The rank itself is pinned in
`ListView.attention-order.test.tsx` and `task-attention.test.ts`; what ONLY a real engine can settle is
that the rank survives the whole rendered chain on top of it: the truncated lane read that must CARRY the
card at all, `Column`'s virtualisation (a row ranked ~201st is not in the DOM at all — it is not merely
below the fold, it does not exist to be scrolled to until it is ranked into the rendered window), the
spacer heights, and the phone scroll-snap layout.

Measured facts, never asserted constants: the failing card's rect, the lane's first rendered row, every
scroll offset, and which lane covers the pane centre after a real touch pan all come from the page. The
pan is dispatched through `Input.dispatchTouchEvent` — the same real input pipeline FN-500's suite uses —
because assigning `scrollLeft` would prove only that the property is assignable, not that an operator can
reach the lane.

The lane self-gates with no local Chromium (`describe.runIf`); a skip is an honest lane result, never a pass.
*/

// playwright-core is a declared dependency of @fusion/engine; resolve it from that package instead of
// adding a second copy of the protocol client to the dashboard package.
const requireFromEngine = createRequire(new URL("../../../engine/package.json", import.meta.url));
const { chromium } = requireFromEngine("playwright-core") as {
  chromium: { launch(options: { executablePath: string; headless: boolean; args?: string[] }): Promise<Browser> };
};

type Browser = { newPage(options: { viewport: { width: number; height: number } }): Promise<Page>; close(): Promise<void> };
type Cdp = { send(method: string, params: Record<string, unknown>): Promise<unknown> };
type Page = {
  goto(url: string): Promise<unknown>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  waitForFunction(fn: () => boolean, options?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T, Arg = undefined>(fn: (arg: Arg) => T, arg?: Arg): Promise<T>;
  screenshot(options: { path: string }): Promise<void>;
  close(): Promise<void>;
  context(): { newCDPSession(page: Page): Promise<Cdp> };
};

const browserCandidates = process.platform === "darwin"
  ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
  : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = [process.env.FUSION_BROWSER_SMOKE_BROWSER, process.env.CHROME_BIN, ...browserCandidates]
  .find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate));

const artifacts = path.resolve(process.cwd(), "../../artifacts/RUFU-526");

/** The card the fixture makes fail, and the lane it is buried in. */
const FAILED_TASK_ID = "FN-0900";
const LANE = "todo";

/** A capture the spec did not write is an evidence gap, not a pass (RUFU-492's rule). */
function expectWrittenScreenshot(file: string): void {
  expect(existsSync(file), `browser evidence missing: ${file}`).toBe(true);
  expect(statSync(file).size, `browser evidence is empty: ${file}`).toBeGreaterThan(0);
}

interface FirstScreenProbe {
  scrollX: number;
  scrollY: number;
  innerWidth: number;
  innerHeight: number;
  boardScrollLeft: number;
  boardScrollTop: number;
  /** Reachable scrollLeft that centres each rendered `.column`, derived from measured rects. */
  anchors: number[];
  /** The `.column` whose rect covers the board's horizontal centre. */
  laneInView: string | null;
  laneCount: number;
  /** Rendered rows of the measured lane, in DOM order, read from `data-virtual-task-row`. */
  renderedRowIds: string[];
  /** Spacer the virtualiser placed above the first rendered row (0 = nothing scrolled past). */
  topSpacerHeight: number;
  laneBodyScrollTop: number;
  laneBodyScrollHeight: number;
  /** Measured box of the failing card, or null when the card is not in the DOM at all. */
  failedCard: { top: number; left: number; bottom: number; right: number; height: number } | null;
  /** Measured boxes of the two scroll containers the claim is about, for a failure to be diagnosable. */
  boardRect: { top: number; bottom: number; left: number; right: number };
  laneRect: { top: number; bottom: number; left: number; right: number };
  laneBodyRect: { top: number; bottom: number; left: number; right: number };
  /** What the engine holds focus after the gesture — a synthesised tap is a harness artifact, not a product scroll. */
  activeElement: { tag: string; className: string; taskId: string | null } | null;
  /** Every HTTP request the fixture recorded, with the order each one asked for. */
  requests: { method: string; url: string; order: string | null; columns: string | null; reviewScope: string | null }[];
}

/*
`page.evaluate` serialises the ONE function it is handed, so every helper the in-page probe calls is
declared INSIDE it (the first cut hoisted `boxOf` to module scope and the page answered
`ReferenceError: boxOf is not defined`). The node-side `describeProbe` never crosses the boundary.
*/
function probeFirstScreen(args: { taskId: string; column: string }): FirstScreenProbe {
  function roundBox(rect: DOMRect | undefined): { top: number; bottom: number; left: number; right: number } {
    return {
      top: Math.round(rect?.top ?? -1),
      bottom: Math.round(rect?.bottom ?? -1),
      left: Math.round(rect?.left ?? -1),
      right: Math.round(rect?.right ?? -1),
    };
  }

  const board = document.getElementById("board");
  if (!board) throw new Error("No #board rendered");
  const boardRect = board.getBoundingClientRect();
  const lane = board.querySelector<HTMLElement>(`.column[data-column="${args.column}"]`);
  if (!lane) throw new Error(`No ${args.column} column rendered`);
  const laneBody = lane.querySelector<HTMLElement>(".column-body");
  const rendered = Array.from(lane.querySelectorAll<HTMLElement>("[data-virtual-task-row]"))
    .map((row) => row.getAttribute("data-virtual-task-row") ?? "");
  const card = lane.querySelector<HTMLElement>(`.card[data-id="${args.taskId}"]`);
  const rect = card?.getBoundingClientRect();
  const viewportWidth = board.clientWidth || boardRect.width;
  const max = Math.max(0, board.scrollWidth - viewportWidth);
  const centreX = boardRect.left + viewportWidth / 2;
  const columns = Array.from(board.querySelectorAll<HTMLElement>(".column"));
  const inView = columns.find((column) => {
    const r = column.getBoundingClientRect();
    return r.left <= centreX && r.right >= centreX;
  });
  const anchors = columns.map((column) => {
    const r = column.getBoundingClientRect();
    const ideal = Math.round(board.scrollLeft + r.left + r.width / 2 - (boardRect.left + viewportWidth / 2));
    return Math.min(Math.max(ideal, 0), max);
  });
  /*
  The virtualiser renders AT MOST one spacer on each side, and the bottom one is present-and-huge in this
  fixture (200 cards below the rendered window). Reading "the first `.column-virtual-spacer` in the lane"
  therefore reads the BOTTOM spacer whenever nothing sits above the head row — which is the passing case,
  and it measured 50 397px on the first run. The top spacer is identified positionally instead.
  */
  const virtualContent = lane.querySelector<HTMLElement>(".column-virtual-content");
  const firstChild = virtualContent?.firstElementChild as HTMLElement | null;
  const topSpacerHeight = firstChild?.classList.contains("column-virtual-spacer")
    ? Math.round(firstChild.getBoundingClientRect().height)
    : 0;
  return {
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
    innerWidth: Math.round(window.innerWidth),
    innerHeight: Math.round(window.innerHeight),
    boardScrollLeft: Math.round(board.scrollLeft),
    boardScrollTop: Math.round(board.scrollTop),
    anchors,
    laneInView: inView?.getAttribute("data-column") ?? null,
    laneCount: columns.length,
    renderedRowIds: rendered,
    topSpacerHeight,
    laneBodyScrollTop: Math.round(laneBody?.scrollTop ?? -1),
    laneBodyScrollHeight: Math.round(laneBody?.scrollHeight ?? -1),
    failedCard: rect
      ? { top: Math.round(rect.top), left: Math.round(rect.left), bottom: Math.round(rect.bottom), right: Math.round(rect.right), height: Math.round(rect.height) }
      : null,
    boardRect: roundBox(boardRect),
    laneRect: roundBox(lane.getBoundingClientRect()),
    laneBodyRect: roundBox(laneBody?.getBoundingClientRect()),
    activeElement: document.activeElement instanceof HTMLElement
      ? {
        tag: document.activeElement.tagName,
        className: document.activeElement.className,
        taskId: document.activeElement.getAttribute("data-id"),
      }
      : null,
    requests: [...(window as unknown as { __boardAttentionRequests?: FirstScreenProbe["requests"] }).__boardAttentionRequests ?? []],
  };
}

/** Compact measurement dump, so a failure names the numbers instead of forcing a re-run to see them. */
function describeProbe(probe: FirstScreenProbe): string {
  const { requests, ...measured } = probe;
  void requests;
  return JSON.stringify(measured);
}

describe.runIf(executablePath)("RUFU-526 first screen of the board in a real browser", () => {
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
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    await mkdir(artifacts, { recursive: true });
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await Promise.race([server?.watcher.close(), new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    server?.ws.close();
    server?.httpServer?.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server?.httpServer?.close((error) => error ? reject(error) : resolve()));
    await server?.pluginContainer.close();
  }, 30_000);

  async function openBoard(viewport: { width: number; height: number }, options: { touch?: boolean } = {}) {
    const touch = options.touch === true;
    const page = await browser.newPage({ viewport });
    const cdp = await page.context().newCDPSession(page);
    /*
    `Emulation.setDeviceMetricsOverride` also publishes `window.screen`, which the shared
    `useViewportMode` classifier reads to tell a phone from a tablet; without it a narrow viewport
    would not produce the same layout the real device does.
    */
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
      deviceScaleFactor: 1,
      mobile: touch,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", touch ? { enabled: true, maxTouchPoints: 1 } : { enabled: false });
    await page.goto(`${baseUrl}app/board-attention-e2e-fixture.html`);
    await page.waitForSelector("#board .column", { timeout: 20_000 });
    /*
    The failing card reaches the DOM through the lane-head read, so waiting for the CARD — not for a
    fixed delay — is what makes the rest of the probe a statement about ordering rather than a race.
    */
    await page.waitForSelector(`#board .column[data-column="${LANE}"] .card[data-id="${FAILED_TASK_ID}"]`, { timeout: 20_000 });
    await page.waitForTimeout(400);
    return { page, cdp };
  }

  function probe(page: Page): Promise<FirstScreenProbe> {
    return page.evaluate(probeFirstScreen, { taskId: FAILED_TASK_ID, column: LANE });
  }

  /** Real touch swipe through the browser input pipeline — never a `scrollLeft` assignment. */
  async function touchSwipe(cdp: Cdp, page: Page, from: { x: number; y: number }, deltaX: number) {
    const steps = 6;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
    for (let step = 1; step <= steps; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: from.x + (deltaX * step) / steps, y: from.y, id: 1 }],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }

  /*
  FNXC:BoardOrdering 2026-11-13-15:25 (RUFU-526):
  The desktop half of the headline acceptance, plus the two properties the viewport claim rides on: the
  card is carried into the payload by an `order=attention` read (a `queue` read would leave it absent, so
  the DOM assertion below would fail on a missing element rather than a misplaced one), and nothing was
  written by scrolling or by a POST.
  */
  it("puts the one failing card of 201 inside the first desktop viewport, unscrolled", async () => {
    const { page } = await openBoard({ width: 1440, height: 900 });
    const probeValue = await probe(page);

    // The card exists in the rendered DOM, so the truncated lane read actually carried it.
    expect(probeValue.failedCard, `card ${FAILED_TASK_ID} was never rendered into the ${LANE} lane`).not.toBeNull();

    // It is the FIRST rendered row of its lane, with nothing virtual scrolled away above it.
    expect(probeValue.renderedRowIds[0]).toBe(FAILED_TASK_ID);
    expect(probeValue.topSpacerHeight).toBe(0);

    // Inside the first viewport, on both axes, without any scroll having been applied.
    const card = probeValue.failedCard!;
    expect(card.top, `card top ${card.top} is above the viewport — ${describeProbe(probeValue)}`).toBeGreaterThanOrEqual(0);
    expect(card.bottom, `card bottom ${card.bottom} is past the ${probeValue.innerHeight}px viewport — ${describeProbe(probeValue)}`).toBeLessThanOrEqual(probeValue.innerHeight);
    expect(card.left, `card left ${card.left} is off-screen`).toBeGreaterThanOrEqual(0);
    expect(card.right, `card right ${card.right} is past the ${probeValue.innerWidth}px viewport`).toBeLessThanOrEqual(probeValue.innerWidth);
    expect(probeValue.scrollX).toBe(0);
    expect(probeValue.scrollY).toBe(0);
    expect(probeValue.boardScrollLeft).toBe(probeValue.anchors[0]);
    // The lane's own scroll container is at its head too: the operator reads it from row one.
    expect(probeValue.laneBodyScrollTop).toBe(0);

    // The lane head asked for the attention rank, and no read wrote anything.
    const laneReads = probeValue.requests.filter((request) => request.columns === LANE);
    expect(laneReads.length, "the board issued no lane-head read for the todo column").toBeGreaterThan(0);
    expect(laneReads.every((request) => request.order === "attention")).toBe(true);
    const writes = probeValue.requests
      .filter((request) => request.method !== "GET" && request.url.includes("/tasks/"))
      .map((request) => `${request.method} ${request.url}`);
    /*
    Scoped to `/tasks/` on purpose. The dashboard's own event client keeps a `POST /api/events/keepalive`
    and a `POST /api/diagnostics/resume-events` alive on every mounted page — those are the transport's,
    not this rule's. What the ladder owes is that the READ path it changed performs no write: no ordering
    rule, no per-card rank write, nothing posted while the board is being drawn.
    */
    expect(writes, `an ordering rule may issue no write: ${JSON.stringify(writes)}`).toEqual([]);

    const shot = path.join(artifacts, "first-screen-desktop-1440x900.png");
    await page.screenshot({ path: shot });
    expectWrittenScreenshot(shot);
    await page.close();
  }, 60_000);

  /*
  FNXC:BoardOrdering 2026-11-13-15:25 (RUFU-526):
  The phone half. At 390x844 the board is one lane per pane, so the operator's OWN horizontal pan is what
  reaches a lane — this task must not write that scroll, and the lane it lands on must already present the
  failing card at its head. The lane reached by the pan is read from measured rects, not assumed: the
  assertion holds for whichever lane the pan actually landed on, so the proof is about the lane head, not
  about a scroll position this suite does not own.
  */
  it("lands a real phone touch pan on a lane whose first card is the one that needs attention", async () => {
    const { page, cdp } = await openBoard({ width: 390, height: 844 }, { touch: true });
    const start = await probe(page);

    // First paint: the operator has panned nothing and has scrolled nothing.
    expect(start.laneCount).toBeGreaterThanOrEqual(3);
    expect(start.boardScrollLeft).toBe(start.anchors[0]);
    expect(start.scrollY).toBe(0);
    expect(start.laneBodyScrollTop, `the lane's own scroll container is not at its head at first paint — ${describeProbe(start)}`).toBe(0);

    // One real swipe reaches the neighbouring lane (the settled anchor is read from measured rects).
    await touchSwipe(cdp, page, { x: 195, y: 422 }, -140);
    await page.waitForTimeout(700);
    const landed = await probe(page);
    expect(landed.boardScrollLeft).toBe(landed.anchors[1]);
    expect(landed.laneInView).toBe(LANE);

    // The lane the operator landed on presents the card needing attention as its FIRST card, in view.
    const card = landed.failedCard;
    expect(card, `card ${FAILED_TASK_ID} missing from the lane the pan landed on`).not.toBeNull();
    expect(landed.renderedRowIds[0]).toBe(FAILED_TASK_ID);
    expect(landed.topSpacerHeight).toBe(0);
    expect(card!.top, `card top ${card!.top} is above the phone viewport — ${describeProbe(landed)}`).toBeGreaterThanOrEqual(0);
    expect(card!.bottom, `card bottom ${card!.bottom} is past the ${landed.innerHeight}px phone viewport — ${describeProbe(landed)}`).toBeLessThanOrEqual(landed.innerHeight);
    expect(card!.left, `card left ${card!.left} is off-screen on the phone — ${describeProbe(landed)}`).toBeGreaterThanOrEqual(0);
    expect(card!.right, `card right ${card!.right} is past the ${landed.innerWidth}px phone viewport — ${describeProbe(landed)}`).toBeLessThanOrEqual(landed.innerWidth);

    // Reaching a lane is the operator's pan; a vertical scroll was never this board's to write.
    expect(landed.scrollY).toBe(0);
    expect(landed.scrollX).toBe(0);
    expect(landed.laneBodyScrollTop).toBe(0);

    const shot = path.join(artifacts, "first-screen-phone-390x844-after-pan.png");
    await page.screenshot({ path: shot });
    expectWrittenScreenshot(shot);
    await page.close();
  }, 60_000);
});
