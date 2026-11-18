import { describe, expect, it } from "vitest";
import {
  TASK_ID_TOKEN_PROSE_SOURCE,
  TASK_ID_TOKEN_SOURCE,
  createTaskIdProseRegExp,
  isTaskIdToken,
  taskIdPrefixOf,
} from "../tasks/task-id-token.js";
import { TASK_ID_TOKEN_PROSE_SOURCE as fromFullBarrel, TASK_ID_TOKEN_SOURCE as fromFullBarrelToken, createTaskIdProseRegExp as createFromFullBarrel, isTaskIdToken as isTaskIdTokenFullBarrel, taskIdPrefixOf as prefixFromFullBarrel } from "../index.js";
import { TASK_ID_TOKEN_PROSE_SOURCE as fromGateBarrel, TASK_ID_TOKEN_SOURCE as fromGateBarrelToken, createTaskIdProseRegExp as createFromGateBarrel, isTaskIdToken as isTaskIdTokenGateBarrel, taskIdPrefixOf as prefixFromGateBarrel } from "../index.gate.js";

/*
FNXC:TaskIdGrammar 2026-11-18-05:58 (RUFU-730):
This is the dictionary every task-id parser composes from, so these cases pin the GRAMMAR ITSELF rather
than any one consumer: which spellings name a card, and which must never name one. The rejected set is
the safety half of the generalization - a phantom id invented out of free text is not a harmless miss,
because room coordination turns a matched id into `defer-suggested` with "do NOT call fn_task_create",
silently blocking legitimate filing (the failure RUFU-352 recorded).
*/
describe("task-id-token: the canonical grammar accepts real ids", () => {
  it.each(["FN-1", "fn-1", "RUFU-517", "rufu-517", "SANE4-42", "A-1"])("accepts %s as a whole-id token", (value) => {
    expect(isTaskIdToken(value)).toBe(true);
  });

  it("rejects a token embedded in a longer compound", () => {
    // `XFN-123Y` must not name `FN-123`: the prefix is not a bare word.
    expect(isTaskIdToken("XFN-123Y")).toBe(false);
    // A trailing hyphen-digit run is a compound, not an id: `AB-12-3` names no card.
    expect(isTaskIdToken("AB-12-3")).toBe(false);
  });

  it("rejects shapes that are not ids at all", () => {
    for (const value of ["RUFU-", "-12", "123", "", "x", "RUFU_517", "RUFU 517"]) {
      expect(isTaskIdToken(value)).toBe(false);
    }
  });

  it("trims surrounding whitespace before deciding", () => {
    expect(isTaskIdToken("  RUFU-517 ")).toBe(true);
  });
});

describe("task-id-token: free-text prose scanning", () => {
  it("finds the id inside a sentence, case-insensitively", () => {
    expect("DUPLICATE: RUFU-318 already specifies the read-back contract".match(createTaskIdProseRegExp())?.[1])
      .toBe("RUFU-318");
    expect("covered by sane-452 after rebase".match(createTaskIdProseRegExp())?.[1]).toBe("sane-452");
  });

  it("invents nothing out of a hyphenated compound", () => {
    // The RUFU-352 phantom-card case: `\b` after `\d+` is satisfied by `-`, so a naive token reads `STEP-3`.
    expect("step-3-build".match(createTaskIdProseRegExp())).toBeNull();
    expect("no card here".match(createTaskIdProseRegExp())).toBeNull();
  });

  it("hands a fresh instance per call so a global scan cannot leak lastIndex", () => {
    const first = createTaskIdProseRegExp(true);
    const second = createTaskIdProseRegExp(true);
    expect(first).not.toBe(second);
    expect(first.global).toBe(true);
    expect(createTaskIdProseRegExp().global).toBe(false);
    expect(first.flags).toBe("gi");
  });

  it("scans every occurrence when asked for global", () => {
    const re = createTaskIdProseRegExp(true);
    expect([...("fix FN-1 plus RUFU-2 and fn-3".matchAll(re))].map((m) => m[1])).toEqual(["FN-1", "RUFU-2", "fn-3"]);
  });
});

describe("task-id-token: one dictionary, no second source of truth", () => {
  it("exports the canonical token and the prose variant that composes it", () => {
    expect(TASK_ID_TOKEN_SOURCE).toBe("[A-Z][A-Z0-9]*-\\d+");
    expect(TASK_ID_TOKEN_PROSE_SOURCE).toBe(`${TASK_ID_TOKEN_SOURCE}(?![\\w-])`);
  });

  it("agrees with task-id-integrity's canonical grammar on every probe id", () => {
    // `task-id-integrity.ts` keeps its own capture-group literal because `detectTaskIdIntegrityAnomalies`
    // indexes numbered groups, so this truth table (measured against that pattern's verdicts, NOT a copy
    // of its source: a second grammar literal in a test is what this card forbids) is the check that the
    // two have not drifted apart.
    const expected: Array<[string, boolean]> = [
      ["FN-1", true],
      ["RUFU-517", true],
      ["SANE4-42", true],
      ["x", false],
      ["A1-2-3", false],
    ];
    for (const [id, verdict] of expected) {
      expect([id, isTaskIdToken(id)]).toEqual([id, verdict]);
    }
  });

  it("is reachable from BOTH core barrels, identical to the module export", () => {
    // The gate bundle is what the published CLI loads; a grammar missing there means two grammars.
    expect(fromFullBarrelToken).toBe(TASK_ID_TOKEN_SOURCE);
    expect(fromFullBarrel).toBe(TASK_ID_TOKEN_PROSE_SOURCE);
    expect(fromGateBarrelToken).toBe(TASK_ID_TOKEN_SOURCE);
    expect(fromGateBarrel).toBe(TASK_ID_TOKEN_PROSE_SOURCE);
    expect(isTaskIdTokenFullBarrel).toBe(isTaskIdToken);
    expect(isTaskIdTokenGateBarrel).toBe(isTaskIdToken);
    expect(createFromFullBarrel).toBe(createTaskIdProseRegExp);
    expect(createFromGateBarrel).toBe(createTaskIdProseRegExp);
    expect(prefixFromFullBarrel).toBe(taskIdPrefixOf);
    expect(prefixFromGateBarrel).toBe(taskIdPrefixOf);
  });
});

/*
FNXC:TaskIdGrammar 2026-11-18-07:22 (RUFU-730, code-review P1):
Splitting an id is a grammar operation, so it is answered here and not at the call site: the title-drift
module has to decide whether an id-shaped token names a card THIS board could have minted, and a `split("-")`
at the call site would answer that for strings the grammar had already refused.
*/
describe("task-id-token: the prefix of a canonical id", () => {
  it.each([
    ["FN-1", "FN"],
    ["fn-1", "FN"],
    ["RUFU-517", "RUFU"],
    ["sane4-42", "SANE4"],
    ["  RUFU-517  ", "RUFU"],
  ])("reads %s as prefix %s", (value, expected) => {
    expect(taskIdPrefixOf(value)).toBe(expected);
  });

  it.each(["XFN-123Y", "AB-12-3", "RUFU-", "-12", "123", "", "x", "UTF-8 support"])(
    "answers null for %s, which is not a whole id",
    (value) => {
      // `UTF-8 support` is the shape that made the title normalizer rewrite prose it should not have touched.
      // Its prefix is deliberately unanswerable, because the value is not a card id and inventing a prefix
      // for it is exactly what would let a title be mutated.
      expect(taskIdPrefixOf(value)).toBeNull();
    },
  );
});
