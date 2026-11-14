/*
FNXC:ApprovalDestroyingRetry 2026-11-14-01:35 (RUFU-599 reproduction 4, RUFU-179's hydration-parity rule):

`reads.ts` hydrates a server-derived capability on FIVE different read paths — detail, the board list, the
paged/modified-since prelude map, its row-map attach, and search. That multiplicity is a known trap in this file:
`reads-age-staleness-lane-hydration.test.ts` documents the same signal fixed twice and missed a third time,
because the sites look identical and sit hundreds of lines apart. RUFU-179's bypass affordance carries the same
shape and the same rule — a card reached through a path nobody updated simply offers nothing, which is
indistinguishable from a card the store would refuse.

`retryRefusal` is derived from `reviewBypass` (no waiver offered means no refusal), so its hydration is only
correct where the waiver's already is. This asserts that pairing structurally: every read path that answers the
waiver also answers the refusal, within the same statement pair, and neither count drifts. A behavioral test
cannot cover five paths without five harnesses, and the failure it would catch — one lane quietly offering a
Retry the API refuses — is invisible on the other four.
*/
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const READS_PATH = resolve(__dirname, "../task-store/reads.ts");
const source = readFileSync(READS_PATH, "utf8");

function callLines(callee: string): number[] {
  const lines: number[] = [];
  /* `await` is the call-site marker: it excludes each helper's own `async function` declaration, whose line
     would otherwise be counted as a hydration site and pair with nothing. */
  const pattern = new RegExp(`await ${callee}\\(`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    lines.push(source.slice(0, match.index).split("\n").length);
  }
  return lines;
}

describe("reads.ts hydrates the Retry refusal on every read path that hydrates the waiver", () => {
  const waiverLines = callLines("resolveReviewBypassForTask");
  const refusalLines = callLines("resolveRetryRefusalForTask");

  it("still has the multiple waiver hydration sites this guard exists to keep in step", () => {
    /* Completeness before the invariant: a vacuous pass is the failure mode of every parity guard. Detail,
       the board list, the prelude map, and search each answer the waiver today. */
    expect(waiverLines.length).toBeGreaterThanOrEqual(4);
  });

  it("pairs each waiver hydration with a refusal hydration on the same read path", () => {
    expect(refusalLines.length, "every waiver site must also hydrate `retryRefusal`").toBe(waiverLines.length);
    for (const waiverLine of waiverLines) {
      // The pair is adjacent by construction: the refusal is gated on the waiver value just computed.
      const paired = refusalLines.some((refusalLine) => refusalLine >= waiverLine && refusalLine - waiverLine <= 6);
      expect(paired, `no retryRefusal hydration beside the waiver site on line ${waiverLine}`).toBe(true);
    }
  });

  it("gates the refusal on the waiver answer instead of re-deriving a waiver", () => {
    /* The cheap gate is the whole point of hydrating them together: a card with no waiver offered pays no extra
       IR read, because a refusal without a waiver is unrepresentable. */
    const helperBody = source.slice(
      source.indexOf("async function resolveRetryRefusalForTask"),
      source.indexOf("async function resolveRetryRefusalForTask") + 2000,
    );
    expect(helperBody).toMatch(/if \(!reviewBypass\) return undefined;/);
    expect(helperBody).toMatch(/classifyApprovalDestroyingRetry\(/);
  });
});
