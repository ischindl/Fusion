import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import realEnApp from "../../../../i18n/locales/en/app.json";
import { AgentsView } from "../AgentsView";
import * as apiModule from "../../api";

const mockViewportMode = vi.fn<() => "mobile" | "tablet" | "desktop">(() => "desktop");
vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  isFullScreenSheetViewport: () => false,
  isShortViewport: () => false,
  getViewportMode: () => mockViewportMode(),
  isMobileViewport: () => mockViewportMode() === "mobile",
  isTabletTouchViewport: (mode?: string) => mode === "tablet",
  useViewportMode: () => mockViewportMode(),
}));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));
vi.mock("../AgentDetailView", () => ({ AgentDetailView: () => null, relativeTime: () => "now" }));

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchAgents: vi.fn().mockResolvedValue([]),
    fetchAgentStats: vi.fn().mockResolvedValue({ total: 0, byState: {}, byRole: {} }),
    fetchOrgTree: vi.fn(),
    fetchSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 1 }),
    updateSettings: vi.fn().mockResolvedValue({}),
  });
});

const mockFetchOrgTree = vi.mocked((apiModule as any).fetchOrgTree);
const mockFetchAgents = vi.mocked((apiModule as any).fetchAgents);
const COMPONENTS_DIR = resolve(__dirname, "..");
const AGENTS_VIEW_CSS = join(COMPONENTS_DIR, "AgentsView.css");

function extractRuleBlock(css: string, selector: string): string {
  const ruleStart = css.indexOf(`${selector} {`);
  expect(ruleStart, `Expected ${selector} to exist in AgentsView.css`).toBeGreaterThanOrEqual(0);
  const bodyStart = css.indexOf("{", ruleStart);
  const bodyEnd = css.indexOf("\n}", bodyStart);
  expect(bodyEnd, `Expected ${selector} rule to have a closing brace`).toBeGreaterThan(bodyStart);
  return css.slice(bodyStart + 1, bodyEnd);
}

const orgTree = [{ agent: { id: "ceo", name: "CEO", role: "scheduler", state: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} }, children: [
  { agent: { id: "cto", name: "CTO", role: "engineer", state: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} }, children: [
    { agent: { id: "eng-a", name: "Eng A", role: "executor", state: "idle", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} }, children: [] },
    { agent: { id: "eng-b", name: "Eng B", role: "executor", state: "idle", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} }, children: [{ agent: { id: "eng-c", name: "Eng C", role: "reviewer", state: "idle", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} }, children: [] }] },
  ] },
] }, { agent: { id: "cfo", name: "CFO", role: "triage", state: "idle", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} }, children: [] }];

function mockRects() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    /*
    FNXC:RUFU-140 2026-08-21-04:35:
    The (this: HTMLElement) parameter satisfies noImplicitThis (the pre-RUFU-140
    form `const el = this as HTMLElement` on an untyped function tripped TS2683
    once test files entered the typecheck program), and the no-this-alias rule
    forbids re-aliasing `this` to a local — so read `this` directly.
    */
    if (this.classList.contains("agent-org-chart-viewport")) return { left: 0, top: 0, width: 400, height: 280, right: 400, bottom: 280, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    if (this.classList.contains("agent-org-chart")) return { left: 0, top: 0, width: 700, height: 500, right: 700, bottom: 500, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    const id = this.getAttribute("data-agent-id");
    const map: Record<string, DOMRect> = {
      ceo: { left: 200, top: 20, width: 140, height: 80, right: 340, bottom: 100, x: 200, y: 20, toJSON: () => ({}) } as DOMRect,
      cto: { left: 120, top: 180, width: 140, height: 80, right: 260, bottom: 260, x: 120, y: 180, toJSON: () => ({}) } as DOMRect,
      cfo: { left: 360, top: 180, width: 140, height: 80, right: 500, bottom: 260, x: 360, y: 180, toJSON: () => ({}) } as DOMRect,
      "eng-a": { left: 40, top: 340, width: 140, height: 80, right: 180, bottom: 420, x: 40, y: 340, toJSON: () => ({}) } as DOMRect,
      "eng-b": { left: 200, top: 340, width: 140, height: 80, right: 340, bottom: 420, x: 200, y: 340, toJSON: () => ({}) } as DOMRect,
      "eng-c": { left: 220, top: 500, width: 140, height: 80, right: 360, bottom: 580, x: 220, y: 500, toJSON: () => ({}) } as DOMRect,
    };
    return map[id ?? ""] ?? ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
  });
}

describe("AgentsView org chart interactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    mockFetchAgents.mockResolvedValue([]);
    mockFetchOrgTree.mockResolvedValue(orgTree);
    mockRects();
  });

  it("keeps SVG connectors explicitly sized and removes the broken CSS connector bus", () => {
    const css = readFileSync(AGENTS_VIEW_CSS, "utf8");
    const connectorBlock = extractRuleBlock(css, ".agent-org-chart-connectors");
    expect(connectorBlock).toMatch(/width\s*:\s*100%\s*;/);
    expect(connectorBlock).toMatch(/height\s*:\s*100%\s*;/);
    expect(connectorBlock).toMatch(/overflow\s*:\s*visible\s*;/);
    expect(css).not.toContain("--org-chart-first-child-center-offset");
    expect(css).not.toContain("--org-chart-last-child-center-offset");
    expect(css).not.toContain(".org-chart-children::before");
    expect(css).not.toContain(".org-chart-children > .org-chart-node::before");
  });

  it("renders no activity affordance when the stream has no evidence", async () => {
    render(<AgentsView addToast={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Org Chart view"));
    const root = await screen.findByTestId("agent-org-chart-viewport");
    expect(root.querySelector('[data-agent-id="ceo"]')?.getAttribute("data-activity-state")).toBeNull();
  });

  it("renders controls and supports transform interactions", async () => {
    render(<AgentsView addToast={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Org Chart view"));
    await screen.findByTestId("agent-org-chart-controls");
    expect(screen.getByLabelText("Horizontal layout")).toBeInTheDocument();
    expect(screen.getByLabelText("Fit org chart")).toBeInTheDocument();
    const canvas = screen.getByTestId("agent-org-chart-viewport").querySelector(".agent-org-chart-canvas") as HTMLDivElement;
    const zoomLabel = screen.getByText(/%/);
    fireEvent.click(screen.getByLabelText("Zoom in org chart"));
    expect(zoomLabel.textContent).not.toBe("100%");
    expect(canvas.style.transform).toMatch(/scale\(/);
    fireEvent.click(screen.getByLabelText("Fit org chart"));
    expect(canvas.style.transform).not.toContain("translate(0px, 0px) scale(1)");

    const viewport = screen.getByTestId("agent-org-chart-viewport");
    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 30, clientY: 30 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 80, clientY: 90 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 80, clientY: 90 });
    expect(canvas.style.transform).toContain("translate(");

    const card = document.querySelector('.org-chart-node-card[data-agent-id="ceo"]') as HTMLElement;
    const before = canvas.style.transform;
    fireEvent.pointerDown(card, { pointerId: 2, clientX: 220, clientY: 40 });
    fireEvent.pointerMove(viewport, { pointerId: 2, clientX: 280, clientY: 120 });
    fireEvent.pointerUp(viewport, { pointerId: 2, clientX: 280, clientY: 120 });
    expect(canvas.style.transform).toBe(before);

    const scaleBefore = canvas.style.transform;
    fireEvent.pointerDown(viewport, { pointerId: 3, clientX: 50, clientY: 50 });
    fireEvent.pointerDown(viewport, { pointerId: 4, clientX: 120, clientY: 120 });
    fireEvent.pointerMove(viewport, { pointerId: 4, clientX: 180, clientY: 180 });
    fireEvent.pointerUp(viewport, { pointerId: 3, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(viewport, { pointerId: 4, clientX: 180, clientY: 180 });
    expect(canvas.style.transform).not.toBe(scaleBefore);

    viewport.focus();
    fireEvent.keyDown(viewport, { key: "ArrowRight" });
    fireEvent.keyDown(viewport, { key: "+" });
    fireEvent.keyDown(viewport, { key: "-" });
    fireEvent.keyDown(viewport, { key: "0" });
    fireEvent.keyDown(viewport, { key: "Home" });
    expect(canvas.style.transform).toContain("scale(1)");

    await waitFor(() => {
      const paths = document.querySelectorAll(".agent-org-chart-connectors path");
      expect(paths.length).toBe(4);
      expect(paths[0].getAttribute("d")).toContain("L");
    });

    fireEvent.click(screen.getByLabelText("Vertical layout"));
    await waitFor(() => {
      const paths = document.querySelectorAll(".agent-org-chart-connectors path");
      expect(paths.length).toBe(4);
      const firstPath = paths[0]?.getAttribute("d") ?? "";
      expect(firstPath).toMatch(/^M\s\d+\s\d+\sL\s\d+\s\d+/);
    });
  });

  it("renders heartbeat controls nowhere in either org-chart layout", async () => {
    const { container } = render(<AgentsView addToast={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Org Chart view"));

    const assertHeartbeatControlsAreAbsent = () => {
      const chart = screen.getByTestId("agent-org-chart");
      expect(container.querySelectorAll(".org-chart-node__actions")).toHaveLength(0);
      expect(Array.from(chart.querySelectorAll("button")).filter((button) => /Disable heartbeat|Enable heartbeat/i.test(button.getAttribute("aria-label") ?? button.textContent ?? ""))).toHaveLength(0);
      expect(chart.querySelectorAll(".org-chart-node button")).toHaveLength(0);
    };

    await screen.findByText("Eng C");
    assertHeartbeatControlsAreAbsent();

    const layoutToggle = screen.getByTestId("agent-org-chart-layout-toggle");
    fireEvent.click(layoutToggle.querySelector<HTMLButtonElement>('[data-layout-value="vertical"]')!);
    await waitFor(() => expect(screen.getByTestId("agent-org-chart")).toHaveAttribute("data-layout-mode", "vertical"));
    assertHeartbeatControlsAreAbsent();
  });

  it("does not render connector paths for empty or single-root org chart data states", async () => {
    mockFetchOrgTree.mockResolvedValueOnce([]);
    const empty = render(<AgentsView addToast={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Org Chart view"));
    await screen.findByText("No agents found");
    expect(document.querySelectorAll(".agent-org-chart-connectors path")).toHaveLength(0);
    empty.unmount();

    mockFetchOrgTree.mockResolvedValueOnce([{ agent: { id: "solo", name: "Solo", role: "executor", state: "idle", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} }, children: [] }]);
    render(<AgentsView addToast={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Org Chart view"));
    await screen.findByText("Solo");
    await waitFor(() => expect(document.querySelectorAll(".agent-org-chart-connectors path")).toHaveLength(0));
  });

  it("renders mobile controls", async () => {
    mockViewportMode.mockReturnValue("mobile");
    render(<AgentsView addToast={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Org Chart view"));
    expect(await screen.findByTestId("agent-org-chart-controls")).toBeInTheDocument();
    expect(screen.getByLabelText("Center org chart")).toBeInTheDocument();
  });
});

/*
FNXC:FleetVerdict 2026-09-02-07:35 (RUFU-176):
The org node is the only surface that answers WHY one agent is parked, so these assert the rendered facts rather than the
classifier's arithmetic (covered in `fleetVerdict.test.ts`): the linked-task chip, the heartbeat countdown and its
overdue state, and the localized stall line. They also pin the two absence rules that keep a card honest — a stopped
runtime has no cadence to count down to, and a busy agent never grows a stall line — because a fabricated row is worse
than a missing one.

FNXC:FleetVerdict 2026-09-02-15:47 (RUFU-176 code review P0):
The first version of these fixtures handed `fetchOrgTree` a record carrying `taskColumn` and `pendingApprovalCount`.
That is not the wire: `/api/agents/org-tree` answers with raw `getOrgTree()` rows, on which neither
`sanitizeAgentTaskLinks` (supplies `taskColumn`, deletes `taskId` for a terminal link) nor
`withPendingApprovalCounts` (`pendingApprovalCount`) has run — only `/api/agents` runs both. The node rendered the
invented fields, so the fixture hid the defect it should have caught: on the real wire every chip read "Unresolved
task", a finished card kept its chip, and a node could never read "waiting for a human" while the strip above it
counted exactly that. One spec per agent is now projected through BOTH wire shapes, so a fixture cannot hand the tree
a field the tree endpoint never emits, and these assertions fail on a raw-record render.
*/
describe("AgentsView org chart node runtime facts", () => {
  const MINUTE = 60_000;
  const HOUR = 3_600_000;

  // The rendered stall line IS catalog copy, so these assertions load the real en catalog instead of asserting the
  // code-level fallback (`MailboxRelatedWorkLink.test.tsx` establishes this pattern).
  async function createRealCatalogInstance() {
    const instance = createInstance();
    await instance.use(initReactI18next).init({
      lng: "en",
      fallbackLng: "en",
      ns: ["app", "common"],
      defaultNS: "app",
      returnNull: false,
      returnEmptyString: false,
      react: { useSuspense: false },
      interpolation: { escapeValue: false },
      resources: { en: { app: realEnApp } },
    });
    return instance;
  }

  let catalog: Awaited<ReturnType<typeof createRealCatalogInstance>>;

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * MINUTE).toISOString();

  /** One agent, declared once, projected through both org-chart-relevant wire shapes (see the block comment above). */
  interface OrgFactSpec {
    id: string;
    name: string;
    state: string;
    /** Linked card, exactly as the raw agent row holds it. */
    taskId?: string;
    /** Linked card's board column — `/api/agents` only. */
    taskColumn?: string;
    /** Approval queue depth — `/api/agents` only. */
    pendingApprovalCount?: number;
    /** The linked card is done/archived: `/api/agents` deletes the link, the raw row keeps pointing at it. */
    terminalLink?: boolean;
    pauseReason?: string;
    /** Minutes since the last beat, aged at fixture-build time. */
    beatMinutesAgo: number;
    runtimeConfig: Record<string, unknown>;
  }

  const factSpecs: OrgFactSpec[] = [
    // Mid-card and busy: the raw row links the card, only the roster names its column.
    { id: "busy", name: "Busy", state: "active", taskId: "FN-042", taskColumn: "in-progress", beatMinutesAgo: 0, runtimeConfig: { heartbeatIntervalMs: HOUR } },
    // Idle with a queued approval the tree endpoint cannot know about. Beat 50m into a 1h cadence, so the countdown
    // row is only "under an hour" if it anchors on the interval (the 4x staleness anchor reads 3h 10m).
    { id: "approvable", name: "Approvable", state: "idle", pendingApprovalCount: 2, beatMinutesAgo: 50, runtimeConfig: { heartbeatIntervalMs: HOUR } },
    // Parked on a human-hold column: `taskColumn` is the ONLY signal, and the tree endpoint never sends it.
    { id: "waiting-card", name: "Waiting Card", state: "idle", taskId: "FN-044", taskColumn: "awaiting-user-review", beatMinutesAgo: 0, runtimeConfig: { heartbeatIntervalMs: HOUR } },
    // The linked card finished: `/api/agents` deleted the link, the raw row still carries it.
    { id: "terminal", name: "Terminal Link", state: "idle", taskId: "FN-099", taskColumn: "done", terminalLink: true, beatMinutesAgo: 0, runtimeConfig: { heartbeatIntervalMs: HOUR } },
    { id: "parked", name: "Parked", state: "paused", pauseReason: "budget-exhausted", beatMinutesAgo: 0, runtimeConfig: { heartbeatIntervalMs: HOUR } },
    { id: "silent", name: "Silent", state: "idle", beatMinutesAgo: 0, runtimeConfig: { enabled: false } },
    // 5h 30m without a beat on a 1h cadence: overdue by 4h 30m against the interval.
    { id: "overdue", name: "Overdue", state: "idle", beatMinutesAgo: 330, runtimeConfig: { heartbeatIntervalMs: HOUR } },
  ];

  function agentRecord(spec: OrgFactSpec, wire: "org-tree" | "agents") {
    const enriched = wire === "agents";
    const linkSurvives = !spec.terminalLink || !enriched;
    return {
      id: spec.id,
      name: spec.name,
      role: "executor",
      state: spec.state,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
      lastHeartbeatAt: minutesAgo(spec.beatMinutesAgo),
      runtimeConfig: spec.runtimeConfig,
      ...(spec.pauseReason ? { pauseReason: spec.pauseReason } : {}),
      ...(spec.taskId && linkSurvives ? { taskId: spec.taskId } : {}),
      ...(enriched && linkSurvives && spec.taskColumn ? { taskColumn: spec.taskColumn } : {}),
      ...(enriched && typeof spec.pendingApprovalCount === "number" ? { pendingApprovalCount: spec.pendingApprovalCount } : {}),
    };
  }

  /** `/api/agents/org-tree`: raw `getOrgTree()` rows — no `taskColumn`, no `pendingApprovalCount`, terminal link intact. */
  function rawTree() {
    return factSpecs.map((spec) => ({ agent: agentRecord(spec, "org-tree"), children: [] }));
  }

  /** `/api/agents`: the same rows after `sanitizeAgentTaskLinks` + `withPendingApprovalCounts`. */
  function enrichedRoster() {
    return factSpecs.map((spec) => agentRecord(spec, "agents"));
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockViewportMode.mockReturnValue("desktop");
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
    mockFetchAgents.mockResolvedValue(enrichedRoster());
    mockFetchOrgTree.mockResolvedValue(rawTree());
    catalog = await createRealCatalogInstance();
  });

  async function nodeFinder() {
    render(<I18nextProvider i18n={catalog}><AgentsView addToast={vi.fn()} /></I18nextProvider>);
    fireEvent.click(await screen.findByLabelText("Org Chart view"));
    const root = await screen.findByTestId("agent-org-chart-viewport");
    return (id: string) => root.querySelector(`[data-agent-id="${id}"]`) as HTMLElement | null;
  }

  it("shows which card a node is holding, with the column only the roster endpoint sends", async () => {
    const nodeOf = await nodeFinder();
    const chip = nodeOf("busy")?.querySelector(".org-chart-node__task");
    expect(chip?.textContent).toContain("FN-042");
    // Rendered from the roster's `taskColumn` via `useColumnLabel`; a raw tree record yields "Unresolved task".
    expect(chip?.textContent).toContain("In Progress");
    expect(chip?.textContent).not.toContain("Unresolved");
  });

  it("drops the chip for a link the roster endpoint already deleted", async () => {
    const nodeOf = await nodeFinder();
    // The raw row still points at FN-099; `/api/agents` deleted it because that card reached a terminal lane.
    expect(nodeOf("terminal")?.querySelector(".org-chart-node__task")).toBeNull();
  });

  /*
  FNXC:FleetVerdict 2026-09-02-15:47 (RUFU-176 code review P1):
  "Next heartbeat in …" must count down to the next BEAT, which is the configured interval — the same anchor
  `ActiveAgentsPanel` uses — not to the 4x staleness threshold `getAgentHealthStatus` compares against. The 50m-into-1h
  fixture separates the two by a full 3h, so a regression to the threshold anchor cannot hide inside a loose shape match.
  */
  it("counts down to the next beat (interval anchor) and flips to overdue", async () => {
    const nodeOf = await nodeFinder();
    const due = nodeOf("approvable")?.querySelector(".org-chart-node__heartbeat");
    expect(due?.textContent).toMatch(/^Next heartbeat in \d{1,2}m$/);
    expect(due?.classList.contains("org-chart-node__heartbeat--overdue")).toBe(false);

    const overdue = nodeOf("overdue")?.querySelector(".org-chart-node__heartbeat");
    expect(overdue?.textContent).toMatch(/Heartbeat overdue 4h/);
    expect(overdue?.classList.contains("org-chart-node__heartbeat--overdue")).toBe(true);
    expect(overdue?.getAttribute("title")).toContain("Time since last heartbeat");
  });

  it("names the reason a node is parked, colored by its verdict bucket", async () => {
    const nodeOf = await nodeFinder();

    const approval = nodeOf("approvable")?.querySelector(".org-chart-node__stall");
    expect(approval?.textContent).toBe("Waiting for approval");
    expect(approval?.classList.contains("org-chart-node__stall--waiting-human")).toBe(true);

    const held = nodeOf("waiting-card")?.querySelector(".org-chart-node__stall");
    expect(held?.textContent).toBe("Waiting on a person");
    expect(held?.getAttribute("title")).toContain("FN-044");

    const parked = nodeOf("parked")?.querySelector(".org-chart-node__stall");
    expect(parked?.textContent).toBe("Budget exhausted");
    expect(parked?.classList.contains("org-chart-node__stall--stalled")).toBe(true);

    const silent = nodeOf("silent")?.querySelector(".org-chart-node__stall");
    expect(silent?.textContent).toBe("Heartbeat switched off");
    expect(silent?.classList.contains("org-chart-node__stall--no-heartbeat")).toBe(true);

    expect(nodeOf("overdue")?.querySelector(".org-chart-node__stall")?.textContent).toBe("No heartbeat");
  });

  it("renders no stall line for a busy agent and no countdown for a stopped or disabled heartbeat", async () => {
    const nodeOf = await nodeFinder();
    expect(nodeOf("busy")?.querySelector(".org-chart-node__stall")).toBeNull();
    expect(nodeOf("parked")?.querySelector(".org-chart-node__heartbeat")).toBeNull();
    expect(nodeOf("silent")?.querySelector(".org-chart-node__heartbeat")).toBeNull();
  });

  it("colors the runtime-fact rows with status tokens instead of hardcoded colors", () => {
    const css = readFileSync(AGENTS_VIEW_CSS, "utf8");
    expect(extractRuleBlock(css, ".org-chart-node__stall--stalled")).toMatch(/color:\s*var\(--state-error-text\)\s*;/);
    expect(extractRuleBlock(css, ".org-chart-node__stall--waiting-human")).toMatch(/color:\s*var\(--state-paused-text\)\s*;/);
    expect(extractRuleBlock(css, ".org-chart-node__heartbeat--overdue")).toMatch(/color:\s*var\(--state-error-text\)\s*;/);
  });
});
