import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
FNXC:LaneRoleReadLogProjection 2026-11-05-16:55 (RUFU-756):
`pollPlannerOverseer` is the most frequent whole-board read in the process — 45 s cadence, once per
ProjectEngine, and this host runs one ProjectEngine per project inside a single Node process. Before
this guard existed, that sweep selected the `log` column for every card in every lane role it walked,
which is how the heap reached ~90 simultaneous full materialisations of the board's text (16.0 GiB of
`string` nodes out of 19.72 GiB live at the ceiling, against 139 MiB of `log` in the database).

This is a call-site ratchet, not a prose assertion: the invariant is structural (which reads opt out of
a column) and it is invisible to behavioural tests, because a consumer that never reads `log` cannot
notice its absence — the exact property that makes the narrowing safe also makes it untestable from the
behaviour side. The same reason requires the OTHER half: a consumer that pattern-matches log CONTENT
must never gain `excludeLog`, and silently would not fail anything either.

Allowed narrowings are therefore enumerated here, so widening them is a review-visible edit.
*/

const SOURCE = readFileSync(join(__dirname, "..", "project-engine.ts"), "utf8");

function methodBody(signature: string): string {
  const start = SOURCE.indexOf(signature);
  expect(start, `missing method: ${signature}`).toBeGreaterThan(-1);
  // The body opens after the signature's own parentheses close. Scanning for the first `{` is wrong:
  // a parameter type like `opts: { excludeLog?: boolean } = {}` opens a brace before the body does.
  let at = SOURCE.indexOf("(", start);
  expect(at, `signature has no parameter list: ${signature}`).toBeGreaterThan(-1);
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

/** Every `listTasksInLaneRoles(...)` call site in `body`, with its argument text. */
function laneRoleCalls(body: string): string[] {
  const calls: string[] = [];
  const needle = "listTasksInLaneRoles(";
  let at = 0;
  while ((at = body.indexOf(needle, at)) !== -1) {
    let depth = 0;
    for (let i = at + needle.length - 1; i < body.length; i += 1) {
      if (body[i] === "(") depth += 1;
      else if (body[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          calls.push(body.slice(at, i + 1));
          at = i;
          break;
        }
      }
    }
    at += needle.length;
  }
  return calls;
}

describe("lane-role read log projection (RUFU-756)", () => {
  const helperBody = methodBody("private async listTasksInLaneRoles(");
  const overseerBody = methodBody("private async pollPlannerOverseer(");

  it("forwards the caller's excludeLog choice into the underlying listTasks read", () => {
    const read = helperBody.match(/store\.listTasks\(\{[^}]*\}\)/g) ?? [];
    expect(read.length).toBeGreaterThan(0);
    for (const call of read) {
      expect(call).toContain("excludeLog");
      expect(call).toContain("derive: false");
    }
  });

  it("defaults to the cheap shape: the log column is only fetched when a caller names it", () => {
    expect(helperBody).toContain("opts: { includeLog?: boolean } = {}");
    expect(helperBody).toContain("const excludeLog = opts.includeLog !== true;");
    // The old default was the expensive one. Restoring it would be a silent performance regression that
    // no behavioural test can see, so it must fail HERE.
    expect(helperBody).not.toContain("const excludeLog = opts.excludeLog === true;");
  });

  it("narrows the overseer sweep's reads, which now rely on the default", () => {
    const calls = laneRoleCalls(overseerBody);
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call).not.toContain("includeLog");
      expect(call).not.toContain("excludeLog");
    }
  });

  it("has no consumer that opts back into the log column, with the reason stated explicitly", () => {
    const outsideHelper = SOURCE.replace(helperBody, "");
    const optIns = laneRoleCalls(outsideHelper).filter((call) => call.includes("includeLog: true"));
    // Today: none. Every consumer was read to its closing brace and pattern-matched for `.log` — see the
    // enumeration in the `listTasksInLaneRoles` comment. A new opt-in must arrive with that same proof
    // stated next to the call site, because a consumer that DOES read log content cannot fail a test by
    // losing the column either.
    expect(optIns).toEqual([]);
    expect(laneRoleCalls(outsideHelper).length).toBeGreaterThanOrEqual(5);
  });
});
