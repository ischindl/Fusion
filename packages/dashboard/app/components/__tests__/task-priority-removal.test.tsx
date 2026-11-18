import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readAppFile, listComponentFiles, loadComponentCss, loadStylesCss } from "../../test/cssFixture";

/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
FN-509's structural guard. These are CODE-CONSTRUCT assertions, not comment or prose assertions: a
priority select, badge, or column "…" menu that survives in any card host or form is a real live
control an operator can still reach, and the only way to prove it is gone everywhere is to look
everywhere. The interaction proof lives in `TaskCard.boost.test.tsx`; this file is the census that
stops a NEW host from quietly reintroducing the retired affordances.
*/

/* Production components only — test fixtures legitimately still name the retired contract while they
   assert it is gone. */
const COMPONENT_FILES = listComponentFiles().filter((file) => !file.includes("__tests__/"));

/*
FNXC:TaskQueueOrder 2026-11-18-08:21:
This list used to be five filenames hand-picked as "the stylesheets FN-509 touched", so a sixth
stylesheet adding `.card-priority-badge` back would have been invisible to the very guard written to
stop that. It is now enumerated from disk: every `.css` under `app/components` plus the global
`styles.css`, which is where the retired chrome originally lived.
*/
const APP_DIR = resolve(import.meta.dirname, "../..");
const COMPONENT_STYLESHEETS = readdirSync(join(APP_DIR, "components"), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
  .map((entry) => entry.name)
  .sort();

/** Every stylesheet the census reads, global sheet included. */
function censusStylesheets(): Array<{ name: string; source: string }> {
  return [
    { name: "styles.css", source: stripComments(loadStylesCss()) },
    ...COMPONENT_STYLESHEETS.map((name) => ({ name, source: stripComments(loadComponentCss(name)) })),
  ];
}

/** Selectors FN-509 retired. A rule matching any of these is a live affordance waiting to reappear. */
const RETIRED_PRIORITY_RULES = [
  ".card-priority-badge",
  ".priority-trigger-wrap",
  ".priority-picker-dropdown",
  ".inline-create-priority",
  // FN-515 deleted the last of these two: an edit-form focus ring and a media rule reading a custom
  // property that no longer exists. They are named so the deletion cannot quietly regrow.
  ".detail-priority-select",
  ".detail-priority-picker",
  ".detail-priority-trigger",
  ".detail-priority-menu",
];

/*
FNXC:TaskQueueOrder 2026-11-18-08:21:
Every scan below matches declarations, never prose. An FNXC note explaining that a selector was
deleted necessarily names that selector, so a raw substring scan over raw source turns the guard into
an assertion that the comment is absent, and the cheapest way to satisfy it would be to delete the
note that explains the removal. Same reasoning as the legacy-tombstone scan: the comment stays, the
code must not. Ranges are masked with spaces rather than deleted, so a reported offender's line still lines up with
the file. One honest limit: a `//` inside a string literal masks the rest of that line, which can
hide a marker but never invent one, and none of these markers appears inside a URL or path.
*/
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const nl = source.indexOf("\n", i);
      const end = nl === -1 ? source.length : nl;
      out += " ".repeat(end - i);
      i = end;
      continue;
    }
    if (two === "/*") {
      const close = source.indexOf("*/", i + 2);
      const end = close === -1 ? source.length : close + 2;
      out += source.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

/** Sources that legitimately mention "priority" for a non-task-priority domain. */
const UNRELATED_PRIORITY_DOMAINS = [
  "notification",
  "ntfy",
  "semaphore",
  "severity",
  "z-index",
  "takes priority",
];

describe("task priority controls are gone from every live surface", () => {
  it("renders no priority select, badge, or cycle button in any component", () => {
    const offenders: string[] = [];
    for (const file of COMPONENT_FILES) {
      const source = stripComments(readAppFile(`components/${file}`));
      for (const marker of [
        "task-priority-select",
        "quick-entry-priority-button",
        "quick-entry-priority-option",
        "inline-create-priority-select",
        "task-form-inline-priority",
        "card-priority-badge",
        "detail-priority-option",
        "detail-actions-priority-heading",
        // FN-515: the edit-form select and the Quick Add glyph survived in CSS and smoke fixtures
        // long after the control itself was gone, so the names that outlived it are policed too.
        "detail-priority-select",
        "quick-entry-priority",
        "priority-trigger",
      ]) {
        if (source.includes(marker)) offenders.push(`${file}: ${marker}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("imports no priority glyph/label helper, because the module is deleted", () => {
    const offenders = COMPONENT_FILES.filter((file) =>
      stripComments(readAppFile(`components/${file}`)).includes("priorityIndicator"),
    );
    expect(offenders).toEqual([]);
  });

  it("references no retired priority constant or type", () => {
    const offenders: string[] = [];
    for (const file of COMPONENT_FILES) {
      const source = stripComments(readAppFile(`components/${file}`));
      for (const symbol of ["TASK_PRIORITIES", "DEFAULT_TASK_PRIORITY", "TaskPriority"]) {
        if (source.includes(symbol)) offenders.push(`${file}: ${symbol}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("leaves no priority chrome in component stylesheets", () => {
    const offenders: string[] = [];
    for (const { name: file, source } of censusStylesheets()) {
      for (const rule of RETIRED_PRIORITY_RULES) {
        if (source.includes(rule)) offenders.push(`${file}: ${rule}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the column header menu is gone, its independent controls are not", () => {
  const columnSource = stripComments(readAppFile("components/Column.tsx"));

  it("renders no MoreVertical trigger, popover, or menu item", () => {
    for (const marker of ["MoreVertical", "column-menu", "column.actionsTitle", "column.actionsAriaLabel"]) {
      expect(columnSource).not.toContain(marker);
    }
  });

  it("offers no per-column sort control", () => {
    for (const marker of ["sortMode", "doneSortMode", "column.sortControlLabel", "task-id-desc"]) {
      expect(columnSource).not.toContain(marker);
    }
  });

  /*
  FNXC:HumanMergeApproval 2026-09-17-18:09:
  FN-514 removed the Auto-merge toggle that FN-509 had deliberately preserved here. History stays: it
  never belonged to the removed column menu and is still the header's only control.
  */
  it("keeps History, and no longer renders the Auto-merge toggle", () => {
    expect(columnSource).toContain("column-history-button");
    expect(columnSource).not.toContain("auto-merge-toggle");
  });

  it("leaves no column-menu rule in the global stylesheet", () => {
    const styles = readAppFile("styles.css");
    expect(styles).not.toContain(".column-menu");
  });
});

describe("Boost reaches every live TaskCard host", () => {
  /*
  A host that renders a live card but forgets to forward `onBoostTask` silently withholds the
  operator's only way to change the queue, with no error anywhere. Enumerate the hosts the FN-509
  census found rather than trusting one of them.
  */
  /*
  FNXC:TaskQueueOrder 2026-11-18-08:21:
  The host list used to be four hand-written filenames, which both over- and under-specified reality:
  `Board.tsx` is the propagation spine and renders no card at all, while two real card hosts
  (`TaskSearchResultsPopover.tsx`, the plugin card host in `dashboard/MainContent.tsx`) were never
  examined. Hosts are now enumerated from the source — every production component containing a
  `<TaskCard` element — and each one must land in exactly one of the two verdicts below, so a new
  host fails the census until someone decides which verdict it belongs to.
  */
  const TASK_CARD_HOSTS = COMPONENT_FILES
    .filter((file) => stripComments(readAppFile(`components/${file}`)).includes("<TaskCard"))
    .map((file) => file.replace(/^(components\/)+/, ""));

  /** Hosts standing in the operator's queue: Boost must be reachable on each of them. */
  const HOSTS_FORWARDING_BOOST = [
    "Column.tsx",
    "WorktreeGroup.tsx",
    "DockTaskList.tsx",
    "useRightDockController.tsx",
  ];

  /**
   * Hosts outside the queue lane. Neither is a card the operator reorders: the search popover is a
   * compact live row (TaskCard.tsx documents that it "simply passes no `onBoostTask` today" without
   * misattributing the gap to the card), and MainContent's card is the plugin-view seam that draws a
   * plugin's own card, not a column of the board. Recording them here is the point — an omission has
   * to be a decision somebody wrote down, not an absence nobody looked at.
   */
  const HOSTS_WITHOUT_BOOST = [
    "TaskSearchResultsPopover.tsx",
    "dashboard/MainContent.tsx",
  ];

  it("every TaskCard host is classified as forwarding Boost or deliberately not", () => {
    expect([...TASK_CARD_HOSTS].sort()).toEqual(
      [...HOSTS_FORWARDING_BOOST, ...HOSTS_WITHOUT_BOOST].sort(),
    );
  });

  it.each(HOSTS_FORWARDING_BOOST)("%s forwards onBoostTask", (host) => {
    expect(stripComments(readAppFile(`components/${host}`))).toContain("onBoostTask");
  });

  it.each(HOSTS_WITHOUT_BOOST)("%s omits onBoostTask as classified, not by accident", (host) => {
    expect(stripComments(readAppFile(`components/${host}`))).not.toContain("onBoostTask");
  });

  /*
  FNXC:TaskQueueOrder 2026-11-18-08:21:
  `Board.tsx` stays policed even though it renders no card: it is the layer that carries the callback
  from the board down to Column/ListView, and dropping it there would silently strip Boost from every
  column at once.
  */
  it("keeps Board.tsx forwarding Boost down to its columns", () => {
    expect(stripComments(readAppFile("components/Board.tsx"))).toContain("onBoostTask");
  });

  it("forwards Boost to BOTH WorktreeGroup branches, active and queued", () => {
    const source = readAppFile("components/WorktreeGroup.tsx");
    const forwards = source.split("onBoostTask={onBoostTask}").length - 1;
    expect(forwards).toBe(2);
  });
});

describe("unrelated priority domains are preserved", () => {
  /*
  FNXC:TaskQueueOrder 2026-11-18-08:21:
  This case used to assert `UNRELATED_PRIORITY_DOMAINS.length > 0`, which is a statement about a
  literal in this file and can never fail. The contract it means to hold is that a global
  search/replace did not strip vocabulary belonging to other domains, so it now reads the shipped
  sources and requires each phrase to still be reachable in one of them.
  */
  it("does not blanket-remove non-task priority vocabulary", () => {
    const corpus = [
      ...COMPONENT_FILES.map((file) => readAppFile(`components/${file}`)),
      ...censusStylesheets().map(({ source }) => source),
    ].join("\n");

    for (const phrase of UNRELATED_PRIORITY_DOMAINS) {
      expect(corpus, phrase).toContain(phrase);
    }
  });
});
