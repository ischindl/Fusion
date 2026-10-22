import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadAllAppCss, loadAllAppCssBaseOnly, loadStylesCss, loadThemeDataCss } from "../test/cssFixture";
import { render, screen, act } from "@testing-library/react";
import { QuickEntryBox } from "../components/QuickEntryBox";
import type { Task } from "@fusion/core";
import type { BoardWorkflowDefinition } from "../api";
import { fetchAgents } from "../api";

/*
FNXC:QuickAddActionRow 2026-07-08-00:00:
FN-7680 regression coverage. Save (`btn btn-task-create btn-sm`) resolved a
different box height than its `.quick-entry-actions` siblings (workflow
trigger, Attach, Fast, Priority, Deps, GitHub toggle, Subtask) because of two
independent drift sources: text buttons get an 18px line box from the
inherited body line-height at 12px font-size while icon-only `.btn-icon`
buttons collapse to their bare icon height (`line-height: 0`), and
`.dep-trigger` buttons (Priority, Deps, and — pre-FN-7677 — the workflow
trigger) inherit the shared `.dep-trigger, .inline-create-model-trigger`
rule's shorter 3px/8px padding instead of `.btn-sm`'s 4px/10px. These tests
assert a single scoped `min-height` on `.quick-entry-actions .btn` (plus the
non-`.btn` optional-steps trigger) normalizes every variant to the same total
box height at desktop widths (the existing `@media (max-width: 768px)`
touch-target block already did this for mobile), and that the shared global
`.btn`, `.btn-sm`, `.btn-icon`, `.btn-task-create`, and `.dep-trigger` rules in
styles.css remain untouched for other surfaces (InlineCreateCard,
NewTaskModal, TaskDetailModal, TaskForm).
*/

const mockTasks: Task[] = [
  {
    id: "FN-001",
    title: "Test task 1",
    description: "First test task",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

const WORKFLOW_A: BoardWorkflowDefinition = {
  id: "builtin:coding",
  name: "Coding",
  columns: [],
};

const WORKFLOW_B: BoardWorkflowDefinition = {
  id: "wf-custom-long-name",
  name: "A Rather Long Custom Workflow Name That Should Truncate",
  columns: [],
};

vi.mock("../api", () => ({
  fetchModels: vi.fn().mockResolvedValue({
    models: [],
    favoriteProviders: [],
    favoriteModels: [],
  }),
  fetchSettings: vi.fn().mockResolvedValue({
    modelPresets: [],
    autoSelectModelPreset: false,
    defaultPresetBySize: {},
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 30000,
    groupOverlappingFiles: true,
    autoMerge: true,
  }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchWorkflowOptionalSteps: vi.fn().mockResolvedValue([]),
  uploadAttachment: vi.fn().mockResolvedValue({}),
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
}));

/*
FNXC:DashboardTestFixtures 2026-10-21-22:43 (RUFU-385):
Hand-listed lucide export stubs are a standing trap: QuickEntryBox imports an icon and every suite that
stubs the module by hand goes red on "No \"<Icon>\" export is defined on the \"lucide-react\" mock" until
somebody notices the stub list is short. This suite was killed by `UserCheck`, the centering suite by the
same icon, and the Pull Request suite by `ChevronLeft` reached through `ViewHeader` — three outages from one
pattern. `createLucideMock` is the canonical helper (`app/test/mockLucide.ts`): it proxies the real module
and synthesises any icon on demand, so a newly imported icon can never break a suite again.
*/
vi.mock("lucide-react", async (importOriginal) => {
  const { createLucideMock } = await import("../test/mockLucide");
  return createLucideMock(() => importOriginal() as Promise<Record<string, unknown>>);
});

vi.mock("../components/ModelSelectionModal", () => ({
  ModelSelectionModal: () => null,
}));

vi.mock("../components/CustomModelDropdown", () => ({
  CustomModelDropdown: ({
    value,
    label,
  }: {
    value: string;
    onChange: (value: string) => void;
    label: string;
  }) => <div data-testid={`mock-dropdown-${label}`}>{value || "none"}</div>,
}));

function mockDesktopViewport() {
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  return vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function renderQuickEntryBox(props: Record<string, unknown> = {}) {
  const defaultProps = {
    onCreate: vi.fn().mockResolvedValue(undefined),
    addToast: vi.fn(),
    tasks: mockTasks,
    projectId: "test-proj",
    workflowId: WORKFLOW_A.id,
    defaultWorkflowId: WORKFLOW_A.id,
    workflowOptions: [WORKFLOW_A, WORKFLOW_B],
  };
  return render(<QuickEntryBox {...defaultProps} {...props} />);
}

/*
FNXC:DashboardTests 2026-10-21-22:54 (RUFU-385):
Returns every block whose at-rule matches `pattern`, as separate bodies rather than one joined string, so a
test can require that a declaration set appears in *some* tier without pretending the app has only one
`max-width: 768px` tier (QuickEntryBox.css has several, plus a 640px and a tablet tier). Mirrors the local
`extractMediaBlocks` helper used across the other CSS-contract suites.
*/
function extractMediaBlocks(content: string, pattern: RegExp): string[] {
  const blocks: string[] = [];

  for (const match of content.matchAll(pattern)) {
    let index = match.index! + match[0].length;
    let depth = 1;

    while (index < content.length && depth > 0) {
      if (content[index] === "{") depth += 1;
      if (content[index] === "}") depth -= 1;
      index += 1;
    }

    expect(depth).toBe(0);
    blocks.push(content.slice(match.index! + match[0].length, index - 1));
  }

  expect(blocks.length, `expected at least one block matching ${pattern}`).toBeGreaterThan(0);
  return blocks;
}

function cssDeclarationValue(ruleBody: string, property: string) {
  return ruleBody.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+);`))?.[1].trim() ?? null;
}

describe("quick-entry action row height parity (FN-7680)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.clear();
    vi.mocked(fetchAgents).mockResolvedValue([]);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(() => "blob:mock"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  });

  afterEach(async () => {
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
    localStorage.clear();
  });

  it("asserts a base (non-media) uniform min-height on .quick-entry-actions .btn covering desktop widths", () => {
    const baseOnlyCss = loadAllAppCssBaseOnly();

    const match = baseOnlyCss.match(
      /\.quick-entry-actions \.btn,\s*\n\s*\.quick-entry-actions \.wf-optional-steps-dropdown-trigger\s*\{[^}]*min-height:\s*([^;]+);/,
    );
    expect(match).not.toBeNull();
    // Not the mobile pinned token; this must be a distinct desktop-width value
    // declared outside any @media block.
    expect(match![1].trim()).toBe("var(--quick-entry-action-row-height-desktop)");
  });

  it("keeps the existing ≤768px touch-target min-height block applying to all .quick-entry-actions .btn (including Save)", () => {
    const cssContent = loadAllAppCss();

    // Isolate the known FN-1140/FN-6153/FN-6160 mobile touch-target section by
    // its marker comment so this assertion cannot accidentally cross into an
    // unrelated @media block or the desktop base rule further up the file.
    const markerStart = cssContent.indexOf("Quick Entry Mobile Touch + Overflow Fixes");
    expect(markerStart).toBeGreaterThan(-1);
    const sectionStart = cssContent.indexOf("@media (max-width: 768px)", markerStart);
    const sectionEnd = cssContent.indexOf("\n@media", sectionStart + 1);
    expect(sectionStart).toBeGreaterThan(markerStart);
    expect(sectionEnd).toBeGreaterThan(sectionStart);
    const section = cssContent.slice(sectionStart, sectionEnd);

    expect(section).toContain("max-width: 768px");
    const mobileBlockMatch = section.match(
      /\.quick-entry-actions \.btn,\s*\n\s*\.quick-entry-actions \.wf-optional-steps-dropdown-trigger\s*\{[^}]*min-height:\s*([^;]+);/,
    );
    expect(mobileBlockMatch).not.toBeNull();
    expect(mobileBlockMatch![1].trim()).toBe("var(--quick-entry-action-row-height-mobile)");
  });

  it("gives every mobile primary icon one token-sized square without sizing text options", () => {
    const cssContent = loadAllAppCss();
    /*
    FNXC:InterfaceStyleAxis 2026-10-21-22:54 (RUFU-385):
    This case used to reach the square rule through `[data-alpha-surface="true"] .quick-entry-primary-group
    .btn-icon` and to locate "the" mobile tier by slicing from `.quick-entry-box {` to the next `@media`. FN-399
    replaced the Alpha boundary with the themeable Interface style axis, dropping the `[data-alpha-surface="true"]`
    gate PREFIX while keeping this declaration block — and renaming `--alpha-touch-height` to `--ui-touch-height`,
    which is why the assertions below already read the shared token. The marker is gone for good
    (`ui-style-contract.test.ts` fails on its presence), and the block now sits in the NativeQuickEntry mobile tier
    rather than the tier the old slice landed on, so the lookup returned null while the invariant it guards was
    fully intact. Both anchors were incidental; the invariant is about the selector and its
    declarations, so the rule is now found by selector across every `max-width: 768px` tier. The app CSS carries
    more than one such tier (a compact one and the NativeQuickEntry one), hence selecting the declaration set
    that carries the token width rather than assuming a single match. Every property assertion below is
    unchanged, including the no-pixel rule.
    */
    const mobileSections = extractMediaBlocks(cssContent, /@media[^{]*max-width:\s*768px[^{]*\{/g);
    const primaryIconRules = mobileSections.flatMap((section) => [...section.matchAll(/(^|\n)\s*\.quick-entry-primary-group \.btn-icon\s*\{([^}]*)\}/g)].map((m) => m[2]!));
    const squareRule = primaryIconRules.find((body) => cssDeclarationValue(body, "width") === "var(--ui-touch-height)");
    expect(squareRule, "a mobile tier must size every primary icon to one shared touch-height square").toBeDefined();
    for (const property of ["width", "min-width", "max-width", "height", "min-height", "max-height"] as const) {
      expect(cssDeclarationValue(squareRule!, property), `${property} must use the shared touch token`).toBe("var(--ui-touch-height)");
    }
    expect(cssDeclarationValue(squareRule!, "flex")).toBe("0 0 var(--ui-touch-height)");
    expect(cssDeclarationValue(squareRule!, "padding")).toBe("0");
    expect(cssDeclarationValue(squareRule!, "align-items")).toBe("center");
    expect(cssDeclarationValue(squareRule!, "justify-content")).toBe("center");
    expect(squareRule!).not.toMatch(/\d+(?:\.\d+)?px/);

    const baseOnlyCss = loadAllAppCssBaseOnly();
    expect(baseOnlyCss).not.toContain(`.quick-entry-primary-group .btn-icon {`);
    for (const mobileSection of mobileSections) {
      expect(mobileSection).not.toMatch(
        /\.quick-entry-options-group[^{}]*\{[^}]*(?:width|min-width|max-width):\s*var\(--ui-touch-height\)/,
      );
    }
  });

  it("keeps options-group glyphs intrinsic while sizing only mobile primary controls", () => {
    const cssContent = loadAllAppCss();
    const markerStart = cssContent.indexOf("Quick Entry Mobile Touch + Overflow Fixes");
    expect(markerStart).toBeGreaterThan(-1);
    const sectionStart = cssContent.indexOf("@media (max-width: 768px)", markerStart);
    const sectionEnd = cssContent.indexOf("\n@media", sectionStart + 1);
    expect(sectionStart).toBeGreaterThan(markerStart);
    expect(sectionEnd).toBeGreaterThan(sectionStart);
    const mobileSection = cssContent.slice(sectionStart, sectionEnd);

    // FNXC:QuickAddActionRow 2026-07-17-00:00: FN-8211 locks the operator
    // requirement that mobile Deps, Models, and Agent glyphs retain their
    // intrinsic sizes. JSDOM cannot resolve CSS vars or render mocked lucide
    // glyphs, so this source contract proves the enlargement remains limited
    // to the primary controls and cannot regress into the options group.
    const iconRule = mobileSection.match(
      /\.quick-entry-primary-group \.btn-icon svg,\s*\n\s*\.quick-entry-primary-group \[data-testid="quick-entry-priority-button"\] svg,\s*\n\s*\.quick-entry-primary-group \[data-testid="quick-entry-fast-toggle"\] svg\s*\{([^}]*)\}/,
    );
    expect(iconRule).not.toBeNull();
    expect(iconRule![1]).toMatch(/width:\s*var\(--space-lg\);/);
    expect(iconRule![1]).toMatch(/height:\s*var\(--space-lg\);/);
    expect(iconRule![1]).not.toMatch(/\d+(?:\.\d+)?px/);
    expect(mobileSection).not.toMatch(/\.quick-entry-options-group svg/);

    const stylesCss = loadStylesCss();
    const largeToken = stylesCss.match(/--space-lg:\s*(\d+)px;/);
    expect(largeToken).not.toBeNull();
    expect(Number(largeToken![1])).toBeGreaterThan(14);

    const actionGapRule = mobileSection.match(/\.quick-entry-actions\s*\{([^}]*)\}/);
    const optionGapRule = mobileSection.match(/\.quick-entry-options-group\s*\{([^}]*)\}/);
    const compactControlRule = mobileSection.match(
      /\.quick-entry-options-group \.btn,\s*\n\s*\.quick-entry-options-group \.wf-optional-steps-dropdown-trigger,\s*\n\s*\.quick-entry-primary-group \.btn-icon\s*\{([^}]*)\}/,
    );
    expect(actionGapRule?.[1]).toMatch(/column-gap:\s*var\(--space-xs\);/);
    expect(optionGapRule?.[1]).toMatch(/column-gap:\s*var\(--space-xs\);/);
    expect(compactControlRule?.[1]).toMatch(/padding-inline:\s*var\(--space-sm\);/);
    for (const ruleBody of [actionGapRule?.[1], optionGapRule?.[1], compactControlRule?.[1], iconRule![1]]) {
      expect(ruleBody).not.toMatch(/\d+(?:\.\d+)?px/);
    }

    const baseOnlyCss = loadAllAppCssBaseOnly();
    const desktopRule = baseOnlyCss.match(
      /\.quick-entry-actions \.btn,\s*\n\s*\.quick-entry-actions \.wf-optional-steps-dropdown-trigger\s*\{([^}]*)\}/,
    );
    expect(desktopRule).not.toBeNull();
    expect(desktopRule![1]).toMatch(/min-height:\s*var\(--quick-entry-action-row-height-desktop\);/);
    expect(desktopRule![1]).toMatch(/max-height:\s*var\(--quick-entry-action-row-height-desktop\);/);
    expect(desktopRule![1]).not.toMatch(/(?:^|[;\n]\s*)(?:width|height):/);

    const mobileHeightRule = mobileSection.match(
      /\.quick-entry-actions \.btn,\s*\n\s*\.quick-entry-actions \.wf-optional-steps-dropdown-trigger\s*\{([^}]*)\}/,
    );
    expect(mobileHeightRule?.[1]).toMatch(/min-height:\s*var\(--quick-entry-action-row-height-mobile\);/);
    expect(mobileHeightRule?.[1]).toMatch(/max-height:\s*var\(--quick-entry-action-row-height-mobile\);/);
  });

  it("pins desktop and mobile action-row heights outside the shadcn spacing scale", () => {
    const baseOnlyCss = loadAllAppCssBaseOnly();
    const stylesCss = loadStylesCss();
    const themeDataCss = loadThemeDataCss();

    const desktopRule = baseOnlyCss.match(
      /\.quick-entry-actions \.btn,\s*\n\s*\.quick-entry-actions \.wf-optional-steps-dropdown-trigger\s*\{[^}]*min-height:\s*([^;]+);/,
    );
    expect(desktopRule?.[1].trim()).toBe("var(--quick-entry-action-row-height-desktop)");

    const allCss = loadAllAppCss();
    const mobileSectionStart = allCss.indexOf("Quick Entry Mobile Touch + Overflow Fixes");
    const mobileSection = allCss.slice(mobileSectionStart, mobileSectionStart + 1600);
    const mobileRule = mobileSection.match(
      /\.quick-entry-actions \.btn,\s*\n\s*\.quick-entry-actions \.wf-optional-steps-dropdown-trigger\s*\{[^}]*min-height:\s*([^;]+);/,
    );
    expect(mobileRule?.[1].trim()).toBe("var(--quick-entry-action-row-height-mobile)");

    const rootBlock = stylesCss.match(/:root\s*\{([\s\S]*?)\n\}/);
    expect(rootBlock).not.toBeNull();
    for (const [token, literal] of [
      ["--quick-entry-action-row-height-desktop", "28px"],
      ["--quick-entry-action-row-height-mobile", "36px"],
    ]) {
      const declaration = rootBlock![1].match(new RegExp(`${token}:\\s*([^;]+);`));
      expect(declaration?.[1].trim()).toBe(literal);
      expect(declaration?.[1]).not.toContain("calc(");
      expect(declaration?.[1]).not.toContain("var(--space");
      expect(themeDataCss).not.toContain(token);
    }

    // Whole-file token scan covers each base selector and its light companion
    // rules, preventing a variant-specific override from reintroducing drift.
    for (const theme of [
      "shadcn", "shadcn-ember", "shadcn-custom", "shadcn-blue", "shadcn-green",
      "shadcn-red", "shadcn-purple", "shadcn-pink", "shadcn-orange", "shadcn-yellow",
      "shadcn-mono-red", "shadcn-mono-blue", "shadcn-mono-green", "shadcn-mono-purple",
      "shadcn-mono-pink", "shadcn-mono-orange", "shadcn-mono-yellow", "shadcn-black",
      "shadcn-gray", "shadcn-gray-blue",
    ]) {
      expect(themeDataCss).toContain(`[data-color-theme="${theme}"]`);
    }
  });

  it("does not modify the shared global .btn, .btn-sm, .btn-icon, .btn-task-create, or .dep-trigger rules in styles.css", () => {
    const stylesCssContent = loadStylesCss();

    const btnMatch = stylesCssContent.match(/\.btn\s*\{[^}]*padding:\s*([^;]+);/);
    expect(btnMatch).not.toBeNull();
    expect(btnMatch![1].trim()).toBe("var(--btn-padding)");

    const btnSmMatch = stylesCssContent.match(/\.btn-sm\s*\{[^}]*padding:\s*([^;]+);/);
    expect(btnSmMatch).not.toBeNull();
    expect(btnSmMatch![1].trim()).toBe("4px 10px");

    const btnIconMatch = stylesCssContent.match(/\.btn-icon\s*\{[^}]*line-height:\s*([^;]+);/);
    expect(btnIconMatch).not.toBeNull();
    expect(btnIconMatch![1].trim()).toBe("0");

    const btnTaskCreateMatch = stylesCssContent.match(/\.btn-task-create\s*\{[^}]*background:\s*([^;]+);/);
    expect(btnTaskCreateMatch).not.toBeNull();
    expect(btnTaskCreateMatch![1].trim()).toBe("var(--cta-bg)");

    const depTriggerMatches = stylesCssContent.match(/\.dep-trigger,\s*\n\s*\.inline-create-model-trigger\s*\{/g);
    expect(depTriggerMatches).not.toBeNull();
    expect(depTriggerMatches!.length).toBe(1);
    const depTriggerMatch = stylesCssContent.match(
      /\.dep-trigger,\s*\n\s*\.inline-create-model-trigger\s*\{[^}]*padding:\s*([^;]+);/,
    );
    expect(depTriggerMatch).not.toBeNull();
    expect(depTriggerMatch![1].trim()).toBe("3px 8px");
  });

  it("renders Save, workflow trigger, Attach, GitHub, Fast, and Deps as sibling .btn elements in the same .quick-entry-actions row", () => {
    mockDesktopViewport();
    renderQuickEntryBox();

    const actionsRow = screen.getByTestId("quick-entry-actions");
    expect(actionsRow.classList.contains("quick-entry-actions")).toBe(true);

    const save = screen.getByTestId("quick-entry-save");
    const trigger = screen.getByTestId("quick-entry-workflow-trigger");
    const attach = screen.getByTestId("quick-entry-attach");
    const github = screen.getByTestId("quick-entry-github-toggle");
    const fast = screen.getByTestId("quick-entry-fast-toggle");
    const deps = screen.getByTestId("quick-entry-deps");

    for (const el of [save, trigger, attach, github, fast, deps]) {
      expect(el.classList.contains("btn")).toBe(true);
      expect(actionsRow.contains(el)).toBe(true);
    }

    /*
    FNXC:TaskQueueOrder 2026-10-21-22:54 (RUFU-385):
    FN-509 retired the task priority field and Quick Add's priority picker with it (`QuickEntryBox.tsx:241-247`
    deletes the trigger, its portal, its position state and its listeners, leaving no empty shell), so this
    row's sibling set no longer has a `quick-entry-priority-button`. The name was dropped from the enumeration
    above and the removal is asserted here instead — a deleted affordance should be pinned absent, not simply
    forgotten from a list, which is how a re-added control would otherwise slip back in unnoticed.
    */
    expect(screen.queryByTestId("quick-entry-priority-button")).toBeNull();
  });

  it("does not render an empty shell for the workflow trigger when fewer than 2 real workflow options exist", () => {
    mockDesktopViewport();
    renderQuickEntryBox({ workflowOptions: [WORKFLOW_A] });

    expect(screen.queryByTestId("quick-entry-workflow-trigger")).toBeNull();
    // Every other action-row control still renders and remains a .btn sibling.
    const actionsRow = screen.getByTestId("quick-entry-actions");
    const save = screen.getByTestId("quick-entry-save");
    const attach = screen.getByTestId("quick-entry-attach");
    expect(actionsRow.contains(save)).toBe(true);
    expect(actionsRow.contains(attach)).toBe(true);
  });
});
