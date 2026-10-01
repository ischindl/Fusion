import { describe, expect, it } from "vitest";
import { buildPatchnodeSnapshotLabel, deriveTaskLabelFromDescription } from "@fusion/core";
import {
  DEFAULT_TASK_LABEL_MAX_LENGTH,
  FALLBACK_TASK_LABEL,
  deriveTaskLabelFromDescription as deriveAppTaskLabel,
} from "../utils/taskTitleDerivation";

/*
FNXC:TaskTitleDerivation 2026-09-26-02:43:
RUFU-295 defines ONE description→label rule and ships it three times on purpose:
1. `deriveTaskLabelFromDescription` in `@fusion/core` — persisted-title fallbacks, tool/log echoes,
   CLI listings, and the GitHub tracking-issue title;
2. `app/utils/taskTitleDerivation.ts` — the dashboard projection, duplicated because the browser
   bundle aliases `@fusion/core` to its type-only `types.ts`, so a value import into `app/` has no
   runtime to bind to;
3. `buildPatchnodeSnapshotLabel` in `@fusion/core` — the durable Patchnode delivery ledger, which
   FN-444 originally froze as a RAW 220-character description prefix and which now calls the core
   derivation.

Duplication without a pin is how FN-391's raw-prefix rule and FN-444's ledger mirror drifted into
rendering `## Pôvodný popis` as a card label. This test is the pin: every case below is run through
ALL THREE implementations and must produce a byte-identical label. A one-sided edit to any copy turns
this red by construction rather than in production.
*/

/** The length budgets each surface actually uses. */
const SHORT_BUDGET = DEFAULT_TASK_LABEL_MAX_LENGTH; // 60 — board titles / log echoes
const LEDGER_BUDGET = 220; // PATCHNODE_DESCRIPTION_LABEL_LENGTH / MAX_DESCRIPTION_FALLBACK_LENGTH

const CARD_ID = "RUFU-295";

/** Long single-token blob with no whitespace boundary anywhere. */
const NO_BOUNDARY_400 = "x".repeat(400);

interface ParityCase {
  name: string;
  description: string;
}

/**
 * The shared case table. Every row must agree across the three implementations at both budgets; the
 * behavioral assertions below then prove the table is not vacuous (a heading marker never survives, a
 * derived label is never multi-line, the 220 bound is exact and suffix-free).
 */
const PARITY_CASES: ParityCase[] = [
  { name: "plain short sentence", description: "Fix the dashboard filter persistence for sprint board." },
  { name: "no sentence terminator", description: "Add rename support to the task CLI and tools" },
  {
    name: "221+ characters with no whitespace boundary",
    description: NO_BOUNDARY_400,
  },
  {
    name: "221+ characters of wrapped prose",
    description:
      "Implement a title-hygiene rule for task cards. The rule must skip fenced code blocks, strip markdown structure, cut at the first sentence terminator, and then bound the result to the caller's length budget without adding any suffix at all, which is what keeps the existing exactly-two-hundred-and-twenty-character ledger contract truthful.",
  },
  { name: "first line is a heading", description: "## Pôvodný popis\n\nUvítali by sme možnosť premenovať kartu." },
  {
    name: "heading-only description",
    description: "## Ship the title hygiene rule",
  },
  {
    name: "multi-line description",
    description: "PREMISA: title junk is visible on the board.\n\nKrok 1: odvodenie\nKrok 2: projekcie",
  },
  {
    name: "fenced code block first",
    description: "```ts\nconst label = 'ignore me';\n```\n\nReal requirement sentence goes here.",
  },
  {
    name: "blockquote and list markers",
    description: "> ## - Ship the derived label\n> more quoted detail\n- second bullet",
  },
  {
    name: "task-list marker",
    description: "- [ ] Move label projection into the shared helper",
  },
  {
    name: "sentence terminator mid-line",
    description: "Restore the label. Then keep the description intact for tooltips.",
  },
  {
    name: "exclamation and question terminators",
    description: "Ship it! Then celebrate later?",
  },
  {
    name: "abbreviation is not a terminator",
    description: "Support abbreviations (e.g. the word etc.) inside the first sentence",
  },
  {
    name: "dangling connector tail",
    description: "Implement the title rule with",
  },
  { name: "empty placeholders", description: "Move widget () from sidebar to {  } panel" },
  {
    name: "assistant confirmation prose",
    description: "Created task FN-295 — implement the label rule",
  },
  {
    name: "frontmatter and thematic break",
    description: "---\ntitle: junk\n---\n\n---\n\nThe real requirement sentence.",
  },
  {
    name: "table row first",
    description: "| col | col2 |\n| --- | --- |\n| a | b |\n\nSentence after the table.",
  },
  { name: "windows line endings", description: "Heading-ish first line\r\nSecond line of the body." },
  { name: "leading and trailing whitespace", description: "   \n\t Padded requirement sentence \n\n " },
  { name: "only whitespace", description: "   \n\n \t " },
  { name: "empty description", description: "" },
];

describe("task title derivation parity (core / dashboard app / Patchnode ledger)", () => {
  it.each(PARITY_CASES)("$name: the three implementations agree at both budgets", ({ description }) => {
    for (const maxLength of [SHORT_BUDGET, LEDGER_BUDGET]) {
      expect(deriveAppTaskLabel(description, maxLength)).toBe(deriveTaskLabelFromDescription(description, maxLength));
    }
  });

  it.each(PARITY_CASES.filter((testCase) => testCase.description.trim().length > 0))(
    "$name: the ledger label equals the core derivation at the 220 ledger budget",
    ({ description }) => {
      // A card with no stored title: this is the branch FN-444 froze as a raw prefix.
      const ledgerLabel = buildPatchnodeSnapshotLabel({ id: CARD_ID, title: null, description });
      expect(ledgerLabel).toBe(deriveTaskLabelFromDescription(description, LEDGER_BUDGET));
      // The id must not leak into a label derived from a real description.
      expect(ledgerLabel).not.toBe(CARD_ID);
    },
  );

  it("never yields a heading-shaped or multi-line label from any case", () => {
    for (const { description } of PARITY_CASES) {
      for (const maxLength of [SHORT_BUDGET, LEDGER_BUDGET]) {
        for (const label of [
          deriveTaskLabelFromDescription(description, maxLength),
          deriveAppTaskLabel(description, maxLength),
        ]) {
          expect(label).not.toMatch(/^ {0,3}#{1,6}(\s|$)/);
          expect(label).not.toMatch(/[\r\n]/);
        }
      }
      const ledgerLabel = buildPatchnodeSnapshotLabel({ id: CARD_ID, title: null, description });
      expect(ledgerLabel).not.toMatch(/^ {0,3}#{1,6}(\s|$)/);
      expect(ledgerLabel).not.toMatch(/[\r\n]/);
    }
  });

  it("derives past a heading-only first line instead of copying it", () => {
    const description = "## Pôvodný popis\n\nUvítali by sme možnosť premenovať kartu.";
    // `sanitizeTitle`'s documented "drop trailing punctuation" rule owns the terminal period, so the
    // sentence is asserted without it rather than re-defining that contract here.
    for (const derive of [deriveTaskLabelFromDescription, deriveAppTaskLabel]) {
      const label = derive(description, LEDGER_BUDGET);
      expect(label).toBe("Uvítali by sme možnosť premenovať kartu");
      expect(label).not.toContain("Pôvodný popis");
    }
    expect(buildPatchnodeSnapshotLabel({ id: CARD_ID, title: null, description })).toBe(
      "Uvítali by sme možnosť premenovať kartu",
    );
  });

  it("keeps the heading text only when the description contains nothing but headings", () => {
    const description = "## Ship the title hygiene rule";
    expect(deriveTaskLabelFromDescription(description, SHORT_BUDGET)).toBe("Ship the title hygiene rule");
    expect(deriveAppTaskLabel(description, SHORT_BUDGET)).toBe("Ship the title hygiene rule");
  });

  it("bounds the derived label to exactly the budget with no suffix when there is no boundary", () => {
    for (const derive of [deriveTaskLabelFromDescription, deriveAppTaskLabel]) {
      const label = derive(NO_BOUNDARY_400, LEDGER_BUDGET);
      expect(label).toHaveLength(LEDGER_BUDGET);
      expect(label.endsWith("…")).toBe(false);
      expect(label.endsWith("...")).toBe(false);
    }
    const ledgerLabel = buildPatchnodeSnapshotLabel({ id: CARD_ID, title: null, description: NO_BOUNDARY_400 });
    expect(ledgerLabel).toHaveLength(LEDGER_BUDGET);
  });

  it("falls back to the untitled label for an undescribable description, and to the id in the ledger", () => {
    for (const derive of [deriveTaskLabelFromDescription, deriveAppTaskLabel]) {
      expect(derive("   \n\n ", SHORT_BUDGET)).toBe(FALLBACK_TASK_LABEL);
    }
    expect(buildPatchnodeSnapshotLabel({ id: CARD_ID, title: "  ", description: "   " })).toBe(CARD_ID);
  });

  it("keeps the app-local fallback label identical to core's", () => {
    // The app module cannot import the constant, so the literal is the contract.
    expect(FALLBACK_TASK_LABEL).toBe("Untitled task");
    for (const derive of [deriveTaskLabelFromDescription, deriveAppTaskLabel]) {
      // `sanitizeTitle`'s assistant-confirmation rejection: tool/agent prose never becomes a label.
      expect(derive("Created task FN-295 — implement the label rule", SHORT_BUDGET)).toBe(FALLBACK_TASK_LABEL);
    }
    expect(buildPatchnodeSnapshotLabel({ id: CARD_ID, title: null, description: "Created task FN-295 — x" })).toBe(
      FALLBACK_TASK_LABEL,
    );
  });
});
