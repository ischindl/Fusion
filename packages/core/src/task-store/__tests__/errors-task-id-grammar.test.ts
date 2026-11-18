import { describe, expect, it } from "vitest";
import { SelfDefeatingDependencyError, detectSelfDefeatingDependency } from "../errors.js";

/*
FNXC:DependencyIntegrity 2026-11-18-05:59 (RUFU-730):
`detectSelfDefeatingDependency` refuses a card whose own title says it will terminalize a card it also
depends on. Its id grammar was `FN-\d+`, so every other project prefix was invisible to the refusal, to the
create/update throw, and to the self-healing reconcile that repairs such an edge. These cases call the REAL
exported predicate with real `(title, dependencies)` pairs - never a stubbed helper result - and the negative
half is the safety argument: the closed verb vocabulary and the one-id-in-the-title rule are unchanged, so
this generalization can only ever over-refuse, never under-refuse.
*/
describe("detectSelfDefeatingDependency: non-FN prefixes", () => {
  it("refuses a non-FN card that terminalizes its own dependency", () => {
    // The non-FN mirror of the shipped FN fixture in
    // packages/core/src/__tests__/postgres/store-self-defeating-dep.pg.test.ts, so this isolates the
    // grammar and not the verb vocabulary.
    expect(detectSelfDefeatingDependency("Finalize RUFU-517: mark steps done", ["RUFU-517"])).toEqual({
      matchedVerb: "finalize",
      operandTaskId: "RUFU-517",
    });
  });

  it("matches the operand id case-insensitively against the dependency list", () => {
    expect(detectSelfDefeatingDependency("Finalize rufu-517: mark steps done", ["RUFU-517"])?.operandTaskId)
      .toBe("RUFU-517");
    expect(detectSelfDefeatingDependency("Finalize RUFU-517: mark steps done", ["rufu-517"])?.operandTaskId)
      .toBe("RUFU-517");
  });

  it("names the operand as the title spelled it, on a mixed board", () => {
    expect(detectSelfDefeatingDependency("Cleanup RUFU-2 artifacts", ["FN-1", "RUFU-2"])).toEqual({
      matchedVerb: "cleanup",
      operandTaskId: "RUFU-2",
    });
  });
});

describe("detectSelfDefeatingDependency: the FN contract is unchanged", () => {
  it("still refuses an FN-shaped self-defeating card", () => {
    expect(detectSelfDefeatingDependency("Finalize FN-125: mark steps done", ["FN-125"])).toEqual({
      matchedVerb: "finalize",
      operandTaskId: "FN-125",
    });
  });
});

describe("detectSelfDefeatingDependency: negatives that must stay null", () => {
  it("refuses to fire without a listed verb", () => {
    // No verb from SELF_DEFEATING_OPERATION_VERBS appears, so the grammar is not consulted at all.
    expect(detectSelfDefeatingDependency("Investigate flaky dashboard render", ["RUFU-517"])).toBeNull();
  });

  it("pins that the refusal vocabulary is CLOSED: 'delete' is not a listed verb before or after RUFU-730", () => {
    // Widening this vocabulary is a separate operator decision, never a side effect of grammar work.
    expect(detectSelfDefeatingDependency("Delete RUFU-517 tombstone sweep", ["RUFU-517"])).toBeNull();
  });

  it("ignores a dependency list with nothing id-shaped in it", () => {
    expect(detectSelfDefeatingDependency("Finalize not-an-id now", ["not-an-id", ""])).toBeNull();
    expect(detectSelfDefeatingDependency("Finalize RUFU-517: mark steps done", [])).toBeNull();
  });

  it("treats a title naming two cards as ambiguous input, not a self-defeating one", () => {
    // The unchanged `length !== 1` rule: naming two operands is not evidence about either.
    expect(detectSelfDefeatingDependency("Finalize RUFU-1 and RUFU-2", ["RUFU-1"])).toBeNull();
  });

  it("does not invent an operand out of a compound that is not an id", () => {
    // The prose boundary is what makes this safe: `RUFU-517-2` is not `RUFU-517`, so the guard must not
    // refuse a card that merely mentions a compound.
    expect(detectSelfDefeatingDependency("Finalize RUFU-517-2 rollout", ["RUFU-517"])).toBeNull();
  });

  it("returns null when the title names an id that is not among the dependencies", () => {
    expect(detectSelfDefeatingDependency("Finalize RUFU-517: mark steps done", ["RUFU-999"])).toBeNull();
  });
});

describe("SelfDefeatingDependencyError: the operator-facing sentence", () => {
  it("names the non-FN operand id it refused on", () => {
    const err = new SelfDefeatingDependencyError("Finalize RUFU-517: mark steps done", "finalize", "RUFU-517");
    expect(err.message).toContain("operates on RUFU-517");
    expect(err.message).toContain("cannot also depend on it");
    expect(err.code).toBe("SELF_DEFEATING_DEPENDENCY");
  });
});
