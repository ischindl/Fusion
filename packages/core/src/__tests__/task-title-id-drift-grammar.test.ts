import { describe, expect, it } from "vitest";
import { extractTaskIdTokens, hasTitleIdDrift, normalizeTitleForTaskId, removedTaskIdTokens } from "../tasks/task-title-id-drift.js";

/*
FNXC:TaskIdGrammar 2026-11-18-06:10 (RUFU-730):
The Step-0 symptom on this site: at HEAD the scan and the strip were `FN-\d+`, so
`hasTitleIdDrift("RUFU-523: Report-only reconciliation", "RUFU-524")` returned false - the drift normalizer
declared a title that plainly names another card to name no card at all, and the card shipped with a title
pointing at a sibling. These are the same three surfaces the FN contract above already covers (detect,
strip, log-worthy change), re-asked with a non-FN prefix, so a future re-hardcoding of either half goes red
on the prefix the project actually runs.
*/
describe("task-title-id-drift: non-FN prefixes", () => {
  it("detects a stale non-FN id in the title", () => {
    expect(extractTaskIdTokens("RUFU-523: Report-only reconciliation")).toEqual(["RUFU-523"]);
    expect(hasTitleIdDrift("RUFU-523: Report-only reconciliation", "RUFU-524")).toBe(true);
  });

  it("strips a stale non-FN id and keeps the surviving subject", () => {
    expect(normalizeTitleForTaskId("RUFU-523: Report-only reconciliation", "RUFU-524")).toEqual({
      title: "Report-only reconciliation",
      changed: true,
    });
  });

  it("detects drift on a mixed board where the title names the other prefix", () => {
    expect(normalizeTitleForTaskId("Align with FN-4847 badge behaviour", "RUFU-730")).toEqual({
      title: "Align with badge behaviour",
      changed: true,
    });
  });

  it("keeps a non-FN title that names its own row id (case-insensitive)", () => {
    // The prefix is not the test: naming YOURSELF is never drift, whatever the case of either side.
    expect(hasTitleIdDrift("sane-452: keep me", "SANE-452")).toBe(false);
    expect(normalizeTitleForTaskId("sane-452: keep me", "SANE-452")).toEqual({
      title: "sane-452: keep me",
      changed: false,
    });
  });

  it("empties a non-FN title to null the way the FN contract does", () => {
    expect(normalizeTitleForTaskId("RUFU-123", "RUFU-999")).toEqual({ title: null, changed: true });
  });

  it("is idempotent for a non-FN prefix", () => {
    const first = normalizeTitleForTaskId("Refinement: RUFU-100: foo", "RUFU-200");
    expect(first.changed).toBe(true);
    expect(normalizeTitleForTaskId(first.title ?? "", "RUFU-200").changed).toBe(false);
  });
});

describe("task-title-id-drift: the generalization must not invent ids", () => {
  it.each([
    ["step-3-build", []],
    ["XFN-1Y", []],
    ["Cover FN-100-2 rollout", []],
  ])("ignores the hyphenated compound %s", (title, expected) => {
    // The prose boundary is the whole safety argument for widening a scan: `\b` after `\d+` is satisfied by
    // a hyphen, so without `(?![\w-])` "step-3-build" would report the phantom card STEP-3 and this
    // surface would silently rewrite a perfectly good title into "build".
    expect(extractTaskIdTokens(title)).toEqual(expected);
    expect(hasTitleIdDrift(title, "FN-9")).toBe(false);
    expect(normalizeTitleForTaskId(title, "FN-9")).toEqual({ title, changed: false });
  });

  /*
  FNXC:TitleNormalization 2026-11-18-07:22 (RUFU-730, code-review P1): the compound boundary above is only
  half of the argument, and the code review falsified the sentence that claimed the widening was safe by
  itself. These four titles carry a LETTERS-DIGITS identifier that the shared grammar genuinely matches -
  no hyphen continues after the digits, so `(?![\w-])` cannot save them - and the pre-fix strip deleted
  each one. The FN-\d+ regex that RUFU-730 replaced left all four untouched, so each row here is a REGRESSION
  this card introduced and then removed, asserted on the exact strings the finding named.
  */
  it.each([
    "Add UTF-8 support to the importer",
    "Prepare SOC-2 audit evidence",
    "Parse RFC-2616 header folding",
    "Fix TLS-1.2 handshake alert",
    "Align on SOC-2 evidence before the audit",
  ])("leaves the identifier-bearing title %s byte-identical", (title) => {
    // No rewrite, and no residue: "Fix TLS-1.2 handshake alert" must not degrade into the ".2" fragment the
    // shape-only strip produced, which is why the assertion is equality with the input and not "shorter".
    expect(normalizeTitleForTaskId(title, "RUFU-9")).toEqual({ title, changed: false });
    expect(normalizeTitleForTaskId(title, "FN-9")).toEqual({ title, changed: false });
    expect(hasTitleIdDrift(title, "RUFU-9")).toBe(false);
  });

  it("leaves a parenthetical own-id suffix alone under a non-FN prefix", () => {
    expect(normalizeTitleForTaskId("Add docs (RUFU-9)", "RUFU-9")).toEqual({
      title: "Add docs (RUFU-9)",
      changed: false,
    });
  });
});

/*
FNXC:TitleNormalization 2026-11-18-07:22 (RUFU-730, code-review P1):
The rule these cases pin: a token counts as a card reference when its PREFIX is one this board provably
mints - the row's own prefix (the row exists, so something minted it) or `FN` (the fallback in
`tasks/distributed-task-id.ts`, `settings?.taskPrefix ?? "FN"`) - and otherwise only when the caller names
the prefix. Shape decides nothing on its own; a store-backed prefix census is what `knownPrefixes` accepts.
*/
describe("task-title-id-drift: naming a card is provenance, not shape", () => {
  it("reports the grammar view separately from the card-reference verdict", () => {
    // The scanner still answers "what looks like an id" - which is a wider set than what may be rewritten -
    // while the two deciders answer "does it name a card". Narrowing the scanner would silently delete the
    // `RUFU-523` the drift contract above requires it to see.
    expect(extractTaskIdTokens("Add UTF-8 support")).toEqual(["UTF-8"]);
    expect(extractTaskIdTokens("Add UTF-8 support", ["RUFU"])).toEqual([]);
    expect(extractTaskIdTokens("Align with FN-4847 behaviour", ["FN"])).toEqual(["FN-4847"]);
    expect(hasTitleIdDrift("Add UTF-8 support", "RUFU-9")).toBe(false);
  });

  it("treats a prefix the caller names as minted, which is the seam for a store-backed census", () => {
    expect(hasTitleIdDrift("Prepare SOC-2 audit evidence", "RUFU-9", ["SOC"])).toBe(true);
    expect(normalizeTitleForTaskId("Prepare SOC-2 audit evidence", "RUFU-9", ["soc"])).toEqual({
      title: "Prepare audit evidence",
      changed: true,
    });
  });

  it("adds named prefixes to the provable ones instead of replacing them", () => {
    // A caller passing its own list must not be able to switch detection off for the prefixes that stay
    // provably minted: FN remains the product's fallback minting prefix, so this still names a card.
    expect(normalizeTitleForTaskId("Align with FN-4847 badge behaviour", "RUFU-730", ["SANE"])).toEqual({
      title: "Align with badge behaviour",
      changed: true,
    });
  });

  it("still strips a same-prefix stale id and a cross-prefix FN id on a renamed board", () => {
    // The two shapes the card exists for, re-asserted next to the new guard so a fix for the mis-strip
    // cannot quietly turn the capability back off.
    expect(normalizeTitleForTaskId("RUFU-523: Report-only reconciliation", "RUFU-524")).toEqual({
      title: "Report-only reconciliation",
      changed: true,
    });
    expect(normalizeTitleForTaskId("Align with FN-4847 badge behaviour", "RUFU-730")).toEqual({
      title: "Align with badge behaviour",
      changed: true,
    });
  });

  it("keeps a card reference and strips it while the non-reference survives beside it", () => {
    // Mixed title: FN-4847 is a card reference, UTF-8 is not, so only the card reference may be removed.
    // The wording avoids a stopword tail on purpose - FN-5077's fragment rule collapses `... with FN-1`
    // to null regardless of this card, and that rule is asserted in task-title-id-drift.test.ts.
    expect(normalizeTitleForTaskId("UTF-8 handling for FN-4847 rollout", "RUFU-9")).toEqual({
      title: "UTF-8 handling for rollout",
      changed: true,
    });
    expect(hasTitleIdDrift("UTF-8 support", "RUFU-9")).toBe(false);
  });

  it("names in the removal diagnostic only the token the strip took", () => {
    // The four callers write `Title normalized: stripped legacy task-id reference (removed=[...])` into the
    // card's History. Built from the grammar view it would also list `UTF-8`, which the strip keeps, so the
    // line would report a cleanup that never happened - the same defect as the mis-strip, one line further out.
    expect(removedTaskIdTokens("UTF-8 handling for FN-4847 rollout", "RUFU-9")).toEqual(["FN-4847"]);
    expect(removedTaskIdTokens("Add UTF-8 support", "RUFU-9")).toEqual([]);
    expect(removedTaskIdTokens("RUFU-523: Report-only reconciliation", "RUFU-523")).toEqual([]);
    expect(removedTaskIdTokens(undefined, "RUFU-9")).toEqual([]);
  });
});
