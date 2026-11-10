import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

/*
FNXC:AgentTimestampFormat 2026-11-10-14:10 (RUFU-345):
STRUCTURAL RATCHET — keeps RUFU-345's fixed invariant from rotting back into the agent-prompt files.

The defect: an instant rendered with host-locale `Date` formatting reached an agent's own prompt and tool
output, where its digits were the HOST TIMEZONE's wall clock (measured +02:00, Europe/Bratislava) while an
agent consumed it as "the time", and its shape flipped between host locales (`22:04:17` vs `10:04:17 PM`).
The fix routes every one of those renders through `formatAgentTimestamp` in `@fusion/core`. A behaviour test
covers the renders that exist today; this file is what stops a NEW render from re-introducing the old class
two files away from the tested seam, which is exactly how the class came back three times in other prompt
areas (see the repo's "a behavior change owns every test that asserts the old behavior" rule).

These are CODE-CONSTRUCT assertions, not comment assertions: they scan executable text for the call shapes
that produced the defect, so they stay true regardless of what any comment says. Comments are stripped
first because this card's own FNXC notes NAME the removed calls in prose, and a scan that read them would be
flagging documentation — the failure mode the no-comment-assertions gate exists to prevent.
*/

/** The files whose renders an agent reads inside its own prompt or tool result. */
const GUARDED_SURFACES: Array<[string, URL]> = [
  ["agent-heartbeat.ts", new URL("../agent-heartbeat.ts", import.meta.url)],
  ["agent-tools.ts", new URL("../agent-tools.ts", import.meta.url)],
  ["executor/execution-prompt.ts", new URL("../executor/execution-prompt.ts", import.meta.url)],
  ["execution/step-session-executor.ts", new URL("../execution/step-session-executor.ts", import.meta.url)],
];

/** Block and line comments removed, so the scan can only ever match executable text. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("agent-prompt timestamp format ratchet (RUFU-345)", () => {
  it("guards at least the four known agent-facing surfaces", () => {
    // A silently emptied list would make the ratchet vacuously green.
    expect(GUARDED_SURFACES.length).toBeGreaterThanOrEqual(4);
  });

  it("contains no host-locale date formatting in any agent-facing prompt surface", async () => {
    for (const [label, url] of GUARDED_SURFACES) {
      const source = stripComments(await readFile(url, "utf8"));
      // The three `toLocale*` overloads were the whole defect class: locale-dependent shape, host-timezone digits.
      expect(source, `${label} formats an instant with host-locale formatting`).not.toMatch(
        /\.toLocale(String|TimeString|DateString)\s*\(/,
      );
    }
  });

  it("contains no hand-rolled UTC-suffix clock render in any agent-facing prompt surface", async () => {
    for (const [label, url] of GUARDED_SURFACES) {
      const source = stripComments(await readFile(url, "utf8"));
      /*
      Guards against re-inventing the label by string assembly — `${someFormattedDate} UTC` or
      `format(date) + " UTC"` — which is how a host-timezone value ends up wearing a UTC suffix again. The
      sanctioned shape is `formatAgentTimestamp(...)`, whose own text carries the suffix after the value it
      produced from UTC components, so an interpolated value followed by a UTC literal is always the defect.
      */
      expect(source, `${label} concatenates a value with a UTC suffix`).not.toMatch(/\$\{[^}]*\}\s*UTC(?![A-Za-z])/);
      expect(source, `${label} concatenates a UTC string literal`).not.toMatch(/\+\s*["'`] UTC["'`]/);
    }
  });

  it("requires the guarded surfaces to use the shared formatter", async () => {
    /*
    Positive control for the two negatives above: at least one guarded surface must call the shared helper,
    otherwise a future refactor could delete every timestamp from these files and the ratchet would still pass.
    */
    const sources = await Promise.all(GUARDED_SURFACES.map(([, url]) => readFile(url, "utf8")));
    const callCount = sources
      .map((s) => stripComments(s))
      .reduce((total, s) => total + (s.match(/formatAgentTimestamp\s*\(/g) ?? []).length, 0);
    expect(callCount).toBeGreaterThan(0);
  });
});
