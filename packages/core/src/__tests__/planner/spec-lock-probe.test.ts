/*
FNXC:SpecLockGuard 2026-11-19-10:15 (RUFU-535):
`canonicalizePlan` declares `mission` as its ONLY required section, so a spec without `## Mission` can
never be plan-approved — and until this probe existed, nothing on the board said so. The park read
`PLANNING_FAILED_SPEC_LOCK_UNAVAILABLE: mission-missing (mission)` and the identical-sourceHash dedup
re-parked it silently, so recovery depended on someone guessing that a heading was missing.

The invariant asserted here is general, not one reproduction: every unavailable parse is classified by
its real cause, naming the section, the heading to write, the spec path, and the recovery owner; the
intentional `DUPLICATE:` parks are inert rather than failures; and a live `missionId`/`sliceId` binding
never rescues a missing heading. Asserted against the shipped parser (no mocks) so the probe can never
drift from what the approval gate actually enforces.
*/
import { describe, expect, it } from "vitest";

import { canonicalizePlan } from "../../planner/spec-lock.js";
import { classifyCanonicalPlan, probeSpecLockReadiness, type SpecLockProbeInput } from "../../planner/spec-lock-probe.js";
import * as fullBarrel from "../../index.js";
import * as gateBarrel from "../../index.gate.js";

/** The shape the probe refuses: a well-formed spec with its one required H2 removed. */
const SPEC_WITH_MISSION = `# Task: FN-1 - Widget

## Mission

Build a safe widget that locks.

## File Scope

- packages/core/src/widget.ts

## Steps

1. Build widget

## Completion Criteria

- [ ] Widget works

## Do NOT

- Change API
`;

const SPEC_WITHOUT_MISSION = SPEC_WITH_MISSION.replace("## Mission\n\nBuild a safe widget that locks.\n\n", "");
const SPEC_PATH = "/repo/.fusion/tasks/FN-1/PROMPT.md";
/** The stem RUFU-534 owns: it speaks about prompt SIZE and must never appear in this probe's voice. */
const EXCULPATION_STEM = "Operator description headings are not the cause";

function probe(overrides: Partial<SpecLockProbeInput> = {}) {
  return probeSpecLockReadiness({
    prompt: SPEC_WITHOUT_MISSION,
    taskId: "FN-1",
    promptPath: SPEC_PATH,
    ...overrides,
  });
}

describe("spec-lock readiness probe (RUFU-535)", () => {
  it("reports a well-formed spec as lockable and owes no recovery", () => {
    expect(probe({ prompt: SPEC_WITH_MISSION })).toEqual({ status: "lockable", disposition: "lockable", recoveryOwner: "none" });
  });

  it("names the missing required section, the heading to write, the path, and the owner", () => {
    const verdict = probe();
    expect(verdict.status).toBe("unavailable");
    if (verdict.status !== "unavailable") return;
    expect(verdict).toMatchObject({
      reason: "mission-missing",
      missingSection: "mission",
      expectedHeading: "## Mission",
      promptPath: SPEC_PATH,
      disposition: "unapprovable",
      recoveryOwner: "planner-respec",
    });
    // The sentence an operator reads must answer all four questions without a parser vocabulary lesson.
    expect(verdict.summary).toContain("## Mission");
    expect(verdict.summary).toContain(SPEC_PATH);
    expect(verdict.summary).toContain("planner-respec");
    expect(verdict.summary).toContain("never be plan-approved");
  });

  it("hands the recovery to the operator when the card is paused, keeping the disposition unchanged", () => {
    const verdict = probe({ paused: true });
    if (verdict.status !== "unavailable") throw new Error("expected an unavailable verdict");
    expect(verdict.disposition).toBe("unapprovable");
    expect(verdict.recoveryOwner).toBe("operator");
    expect(verdict.summary).toContain("unpause");
    expect(verdict.summary).toContain("operator");
  });

  it("classifies the DUPLICATE: redirect sentinel as intentionally inert rather than as a failure", () => {
    const verdict = probe({ prompt: "DUPLICATE: RUFU-000", taskId: "FN-9", promptPath: "/repo/.fusion/tasks/FN-9/PROMPT.md" });
    if (verdict.status !== "unavailable") throw new Error("a sentinel never locks");
    expect(verdict.disposition).toBe("intentionally-inert");
    expect(verdict.recoveryOwner).toBe("none");
    expect(verdict.summary).toContain("RUFU-000");
    // The census tripwire keys on these two classes only.
    expect(verdict.disposition).not.toBe("unapprovable");
    expect(verdict.disposition).not.toBe("prompt-file-missing");
  });

  it.each([
    ["an unreadable spec file", { prompt: "", promptFileMissing: true }],
    ["a zero-byte spec with no flag", { prompt: "   \n\n  " }],
  ])("classifies %s as prompt-file-missing owned by the operator, not as a heading defect", (_label, overrides) => {
    const verdict = probe(overrides);
    if (verdict.status !== "unavailable") throw new Error("an absent spec cannot lock");
    expect(verdict.disposition).toBe("prompt-file-missing");
    expect(verdict.recoveryOwner).toBe("operator");
    expect(verdict.summary).toContain(SPEC_PATH);
  });

  it("classifies a duplicated declared lock section as a re-authoring fix, not as damage", () => {
    /*
    Measured drift against the card text: `## Surface Enumeration` duplicated does NOT make a spec
    unlockable, because the parser only scans its declared section aliases. RUFU-492's live refusal
    comes from `## File Scope` appearing twice. The duplicate class is therefore exercised on a
    DECLARED section, which is the real invariant.
    */
    const duplicated = `${SPEC_WITH_MISSION}\n## Steps\n\n2. Add another step\n`;
    const verdict = probe({ prompt: duplicated });
    expect(canonicalizePlan(duplicated)).toMatchObject({ status: "unavailable", reason: "section-duplicate" });
    if (verdict.status !== "unavailable") throw new Error("a duplicated section cannot lock");
    expect(verdict).toMatchObject({
      reason: "section-duplicate",
      missingSection: "steps",
      expectedHeading: "## Steps",
      disposition: "unapprovable",
      recoveryOwner: "planner-respec",
    });
    expect(verdict.summary).toContain("more than once");
  });

  it("names the required heading for an empty-but-present Mission", () => {
    const verdict = probe({ prompt: SPEC_WITH_MISSION.replace("Build a safe widget that locks.", "   ") });
    if (verdict.status !== "unavailable") throw new Error("an empty required section cannot lock");
    expect(verdict).toMatchObject({ reason: "mission-empty", missingSection: "mission", expectedHeading: "## Mission", disposition: "unapprovable" });
    expect(verdict.summary).toContain("empty");
  });

  it("never lets live mission/slice/dependency bindings rescue the missing heading", () => {
    const bindings = { missionId: "M-001", sliceId: "S-002", dependencies: ["RUFU-001"] };
    const verdict = probe({ bindings });
    if (verdict.status !== "unavailable") throw new Error("bindings are structural inputs, not a substitute for the required section");
    expect(verdict).toMatchObject({ reason: "mission-missing", missingSection: "mission", disposition: "unapprovable" });
  });

  it("keeps every unavailable summary free of the prompt-size exculpation stem", () => {
    const prompts: Array<[string, string]> = [
      ["mission-missing", SPEC_WITHOUT_MISSION],
      ["mission-empty", SPEC_WITH_MISSION.replace("Build a safe widget that locks.", " ")],
      ["section-duplicate", `${SPEC_WITH_MISSION}\n## Steps\n\n2. Another step\n`],
      ["sentinel", "DUPLICATE: RUFU-000"],
    ];
    for (const [label, prompt] of prompts) {
      const verdict = probe({ prompt });
      if (verdict.status !== "unavailable") throw new Error(`${label} should not lock`);
      expect(verdict.summary, label).not.toContain(EXCULPATION_STEM);
      expect(verdict.summary, label).not.toMatch(/shr(unk|u?nk)/i);
    }
  });

  it("classifies the identical way whether the caller parsed or the probe parsed", () => {
    const context = { taskId: "FN-1", promptPath: SPEC_PATH, prompt: SPEC_WITHOUT_MISSION };
    expect(classifyCanonicalPlan(canonicalizePlan(SPEC_WITHOUT_MISSION), context)).toEqual(probe());
  });

  it("echoes no path rather than inventing one when the caller has none", () => {
    const verdict = probeSpecLockReadiness({ prompt: SPEC_WITHOUT_MISSION, taskId: "FN-1" });
    if (verdict.status !== "unavailable") throw new Error("expected an unavailable verdict");
    expect(verdict.promptPath).toBeNull();
    expect(verdict.summary).toContain("FN-1");
    expect(verdict.summary).not.toContain("PROMPT.md in");
  });

  /*
  The engine-core merge-gate project aliases `@fusion/core` to `index.gate.ts`, so an export added to
  only one barrel binds `undefined` on the gate side and fails where nothing points at the gap.
  */
  it("exposes the probe, the binding derivation, and the spec reader from BOTH core barrels", () => {
    expect(fullBarrel.probeSpecLockReadiness).toBe(gateBarrel.probeSpecLockReadiness);
    expect(fullBarrel.classifyCanonicalPlan).toBe(gateBarrel.classifyCanonicalPlan);
    expect(fullBarrel.SPEC_LOCK_EXPECTED_HEADINGS).toBe(gateBarrel.SPEC_LOCK_EXPECTED_HEADINGS);
    expect(fullBarrel.specLockBindings).toBe(gateBarrel.specLockBindings);
    expect(fullBarrel.readTaskPlanPrompt).toBe(gateBarrel.readTaskPlanPrompt);
  });
});
