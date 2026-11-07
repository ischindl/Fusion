import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
FNXC:LaneRoleReadCommentProjection 2026-11-07-09:13 (RUFU-871):
`listTasksInLaneRoles` is the process's most frequent whole-board read (71 % of `listTasks` samples in
`store:read-attribution-window`), and after RUFU-584 removed `log` from it the retained mass moved to the
comment pair: the retainer walk over a production snapshot counted 5,821 `comments` and 5,810
`steeringComments` properties on ~5.8k hydrated Task rows against 89 `log` edges, while `string` nodes were
84.6 % of the heap. Dropping the pair is therefore the remaining byte lever on this read.

Like the `log` narrowing beside it, the invariant is structural and invisible to behaviour: a consumer that
never reads a column cannot notice its absence, and a consumer that DOES read it would silently receive an
empty array instead of failing loudly. So the allowed shape is pinned here and widening it is a
review-visible edit. The enumeration that makes the narrowing safe lives in the FNXC block at the method.
*/

const SOURCE = readFileSync(join(__dirname, "..", "project-engine.ts"), "utf8");

function methodBody(signature: string): string {
  const start = SOURCE.indexOf(signature);
  expect(start, `missing method: ${signature}`).toBeGreaterThan(-1);
  let at = SOURCE.indexOf("(", start);
  let paren = 0;
  for (; at < SOURCE.length; at += 1) {
    if (SOURCE[at] === "(") paren += 1;
    else if (SOURCE[at] === ")") {
      paren -= 1;
      if (paren === 0) break;
    }
  }
  let depth = 0;
  let i = SOURCE.indexOf("{", at);
  for (; i < SOURCE.length; i += 1) {
    if (SOURCE[i] === "{") depth += 1;
    else if (SOURCE[i] === "}") {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

describe("RUFU-871: lane-role read does not hydrate the comment pair", () => {
  const body = methodBody("private async listTasksInLaneRoles");

  it("declares a read-set that omits `comments`, so comments and steeringComments stay out of the SELECT", () => {
    // The declared list is what the projection keeps. Naming `comments` here would put both comment
    // columns back into the hottest whole-board read in the process.
    const declared = body.match(/const fields:[\s\S]*?:\s*\[([^\]]*)\];/);
    expect(declared, "the read-set declaration disappeared").not.toBeNull();
    const members = declared[1];
    expect(members).not.toMatch(/"comments"/);
    // These must stay named: consumers do read step results, branch provenance and steps.
    for (const needed of ["workflowStepResults", "source", "steps"]) {
      expect(members, `declared read-set lost ${needed}`).toContain(`"${needed}"`);
    }
  });

  it("keeps the comment opt-in explicit and unused today", () => {
    // An opt-in is allowed to exist; a call site that uses it must be reviewed against the consumer
    // enumeration at the method, because it re-hydrates comment bodies for every card in the lane.
    const callers = [...SOURCE.matchAll(/listTasksInLaneRoles\([^;]*?\)/g)].map((m) => m[0]);
    expect(callers.length).toBeGreaterThanOrEqual(5);
    const optingIn = callers.filter((call) => call.includes("includeComments: true"));
    expect(optingIn).toEqual([]);
  });

  it("forwards both narrowing decisions into the underlying read", () => {
    // `fields: undefined` is the opt-out shape (identical row to today), so the forwarding must be visible.
    expect(body).toContain("opts.includeLog !== true");
    expect(body).toMatch(/store\.listTasks\(\{[^}]*excludeLog, fields \}\)/);
  });
});
