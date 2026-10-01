import { describe, expect, it } from "vitest";
import { parsePlanPremises, PLAN_PREMISE_KINDS } from "../planner/plan-premises.js";
import { PLANNING_COMPLETENESS_POLICY, PLAN_REVIEW_COMPLETENESS_POLICY } from "../agents/planning-review-policy.js";
import { BUILTIN_AGENT_PROMPTS } from "../agents/agent-prompts.js";

describe("parsePlanPremises", () => {
  it("parses every closed premise kind and preserves unicode literals", () => {
    const result = parsePlanPremises(`# Task\n\n## Plan Premises\n\n- {"kind":"file-exists","path":"src/a.ts"}\n- {"kind":"file-absent","path":"src/old.ts"}\n- {"kind":"text-present","path":"src/a.ts","literal":"réglage réglage"}\n- {"kind":"text-absent","path":"src/a.ts","literal":"removed"}\n\n## Steps\n`);
    expect(result).toEqual({ ok: true, premises: [
      { kind: "file-exists", path: "src/a.ts" },
      { kind: "file-absent", path: "src/old.ts" },
      { kind: "text-present", path: "src/a.ts", literal: "réglage réglage" },
      { kind: "text-absent", path: "src/a.ts", literal: "removed" },
    ] });
  });

  /*
  FNXC:PlanPremises 2026-09-16-02:49:
  RUFU-246 extends the rejection table with a detail expectation: the release door surfaces the
  `invalid-contract` detail verbatim as the refusal reason, so each line-level failure must name
  the offending line — an unlocated detail is what let the STAS-208 loop re-emit the identical
  rejected line every replan pass. The HTML-comment rows pin the spec-authoring hazard that
  blocked RUFU-246 revision 4: a "tolerated annotation" line inside `## Plan Premises` is a
  release veto, not a nit — the grammar admits only `- {json}` bullets.
  */
  it.each([
    ["missing section", "# Task\n## Steps", "missing-section", "PROMPT.md is missing ## Plan Premises"],
    ["empty section", "## Plan Premises\n\n## Steps", "empty-section", "## Plan Premises must contain at least one premise"],
    ["free prose", "## Plan Premises\nRun grep now", "invalid-line", "Plan Premises line 2 must be one JSON object bullet"],
    ["command bullet", "## Plan Premises\n- grep -q token src/a.ts", "invalid-line", "Plan Premises line 2 must be one JSON object bullet"],
    ["invalid JSON", "## Plan Premises\n- {kind:file-exists}", "invalid-json", "Plan Premises line 2 is not valid JSON"],
    ["HTML comment before a valid bullet", "## Plan Premises\n<!-- verify: run grep -q token src/a.ts -->\n- {\"kind\":\"file-exists\",\"path\":\"src/a.ts\"}", "invalid-line", "Plan Premises line 2 must be one JSON object bullet"],
    ["HTML comment after a valid bullet", "## Plan Premises\n- {\"kind\":\"file-exists\",\"path\":\"src/a.ts\"}\n<!-- note -->", "invalid-line", "Plan Premises line 3 must be one JSON object bullet"],
    ["unknown kind", "## Plan Premises\n- {\"kind\":\"shell\",\"path\":\"src/a.ts\"}", "invalid-premise", "Plan Premises line 2 is not an allowed atomic premise"],
    ["extra key", "## Plan Premises\n- {\"kind\":\"file-exists\",\"path\":\"src/a.ts\",\"command\":\"rm -rf .\"}", "invalid-premise", undefined],
    ["empty literal", "## Plan Premises\n- {\"kind\":\"text-present\",\"path\":\"src/a.ts\",\"literal\":\"\"}", "invalid-premise", undefined],
    ["absolute path", "## Plan Premises\n- {\"kind\":\"file-exists\",\"path\":\"/etc/passwd\"}", "invalid-premise", undefined],
    ["traversal", "## Plan Premises\n- {\"kind\":\"file-exists\",\"path\":\"src/../secret\"}", "invalid-premise", undefined],
    ["glob", "## Plan Premises\n- {\"kind\":\"file-exists\",\"path\":\"src/*.ts\"}", "invalid-premise", undefined],
  ] as Array<[string, string, string, string | undefined]>)("rejects %s", (_name, prompt, reason, detail) => {
    const result = parsePlanPremises(prompt);
    expect(result).toMatchObject({ ok: false, reason });
    if (!result.ok && detail) expect(result.detail).toBe(detail);
  });
});

/*
FNXC:PlanPremises 2026-09-16-02:49:
RUFU-246 Step 1 requires the premise-kind lists to agree: the parser's PLAN_PREMISE_KINDS is the
grammar the release-door checker enforces, while the planning/plan-review policy prompts and the
default triage prompt are what authors actually see. A kind offered by a prompt but unenforced
(or enforced but unlisted) is a silent contract break, so the exported policy text must enumerate
every parser kind. The fast-triage lane is intentionally excluded: it skips specification planning,
and cards without premises release through the premise-free path.
*/
describe("plan-premise authoring surfaces", () => {
  it("enumerate exactly the premise kinds the parser and checker accept", () => {
    expect([...PLAN_PREMISE_KINDS].sort()).toEqual(["file-absent", "file-exists", "text-absent", "text-present"]);
    const defaultTriage = BUILTIN_AGENT_PROMPTS.find((template) => template.id === "default-triage");
    expect(defaultTriage).toBeDefined();
    const surfaces: Array<[string, string]> = [
      ["PLANNING_COMPLETENESS_POLICY", PLANNING_COMPLETENESS_POLICY],
      ["PLAN_REVIEW_COMPLETENESS_POLICY", PLAN_REVIEW_COMPLETENESS_POLICY],
      ["default-triage prompt", defaultTriage?.prompt ?? ""],
    ];
    for (const [name, text] of surfaces) {
      for (const kind of PLAN_PREMISE_KINDS) {
        expect(text, `${name} must enumerate the ${kind} premise kind`).toContain(kind);
      }
    }
  });
});
