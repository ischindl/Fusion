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

  it("defaults to the log-bearing shape so untouched consumers cannot change behaviour", () => {
    expect(helperBody).toContain("opts: { excludeLog?: boolean } = {}");
    expect(helperBody).toContain("const excludeLog = opts.excludeLog === true;");
  });

  it("narrows exactly the overseer sweep's reads and nothing else in that pass", () => {
    const calls = laneRoleCalls(overseerBody);
    expect(calls.length).toBe(2);
    for (const call of calls) expect(call).toContain("excludeLog: true");
  });

  it("keeps every other lane-role consumer log-bearing, with the allowlist stated explicitly", () => {
    const outsideOverseer = laneRoleCalls(
      SOURCE.replace(overseerBody, "").replace(helperBody, ""),
    );
    const narrowing = outsideOverseer.filter((call) => call.includes("excludeLog: true"));
    // Today: none. A new narrowing must arrive with proof that the consumer never reads `task.log`,
    // and that proof belongs in the call-site comment next to it.
    expect(narrowing).toEqual([]);
    expect(outsideOverseer.length).toBeGreaterThanOrEqual(4);
  });
});
