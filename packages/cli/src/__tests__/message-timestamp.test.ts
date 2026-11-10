import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { formatAgentTimestamp } from "@fusion/core";
import { formatTime } from "../commands/message.js";

/*
FNXC:AgentTimestampFormat 2026-11-10-14:00 (RUFU-345):
RUFU-345's defect class is a timestamp an AGENT reads whose digits are the host timezone's wall clock. The
three CLI files touched by this card are agent-facing: `fn task logs` / `fn task show` (task.ts),
`fn task browse-messages` / `fn message show` (message.ts), and the pi-extension log tail (extension.ts);
agents quote those stamps in reports and reconcile them against the ISO rows in the agent log.

Two assertion shapes are used deliberately:
- BEHAVIOR for the exported formatter `formatTime` (a >7-day absolute fallback is the part that changed; its
  relative branches are RUFU-181's contract and are re-asserted so this change cannot silently eat them), and
  for the shared `formatAgentTimestamp` the three commands now call.
- a CODE-CONSTRUCT scan for the two module-private renderers, which are not exported and can only be pinned
  at their call sites. Asserting the construct (which formatter a file calls, and that no host-locale call
  remains) is the sanctioned substitute for asserting behavior through a seam that does not exist; asserting
  a comment instead would guard nothing.
*/

/** The measured instant: 20:04:17 UTC, which is 22:04:17 in Europe/Bratislava (CEST, +02:00). */
const INSTANT_ISO = "2026-09-26T20:04:17.000Z";
const UTC_STAMP = "2026-09-26 20:04:17 UTC";
const UTC_DAY = "2026-09-26";
/** Bratislava wall-clock shapes. Either appearing in CLI output is the defect this card removes. */
const LOCAL_STAMPS = ["22:04:17", "10:04:17 PM"];

/** Block/line comments stripped: this card's own FNXC notes name the removed calls in prose, and a scan that
 * reads them would flag documentation rather than code (the repo rule: never make a test assert a comment). */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

async function readStrippedSource(url: URL): Promise<string> {
  return stripComments(await readFile(url, "utf8"));
}

const CHANGED_CLI_SURFACES: Array<[string, URL]> = [
  ["commands/task.ts", new URL("../commands/task.ts", import.meta.url)],
  ["commands/message.ts", new URL("../commands/message.ts", import.meta.url)],
  ["extension.ts", new URL("../extension.ts", import.meta.url)],
];

describe("CLI agent-facing timestamps are UTC (RUFU-345)", () => {
  const priorTz = process.env.TZ;

  beforeEach(() => {
    // Node reads process.env.TZ for host-timezone formatting, so the defect only exists once TZ is set here.
    process.env.TZ = "Europe/Bratislava";
  });

  afterEach(() => {
    if (priorTz === undefined) delete process.env.TZ;
    else process.env.TZ = priorTz;
  });

  it("proves the fixture really disagrees with UTC under this timezone", () => {
    // Without this the assertions below could pass vacuously on a UTC CI box.
    const local = new Date(INSTANT_ISO);
    expect(local.getUTCHours()).toBe(20);
    expect(local.getHours()).toBe(22);
    expect(local.toLocaleTimeString()).toContain(LOCAL_STAMPS[1]);
  });

  it("renders the shared stamp identically to the ISO components the agent log stores", () => {
    const rendered = formatAgentTimestamp(INSTANT_ISO);
    expect(rendered).toBe(UTC_STAMP);
    // The invariant the symptom check uses: the rendered digits ARE the ISO UTC components, so the CLI line
    // and the `toISOString()` row it describes can never disagree by a host offset.
    const iso = new Date(INSTANT_ISO).toISOString();
    const isoDerived = `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
    expect(rendered).toBe(isoDerived);
    for (const local of LOCAL_STAMPS) expect(rendered).not.toContain(local);
  });

  it("labels the >7-day message-list fallback with the UTC calendar day, never the host-local day", () => {
    // 2026-09-26 is more than 7 days in the past for every later run date, so this hits the absolute branch.
    const past = "2026-09-26T22:40:00.000Z";
    const label = formatTime(past);
    expect(label).toBe(UTC_DAY);
    // Host-local day for a +02:00 host is also 26 at 22:40 UTC, so pin the shape instead: no locale month
    // name (`Sep 26` / `26. 9.`) may come back, and the label stays a bare ISO day.
    expect(label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("renders a near-midnight UTC instant by its UTC day, which the host-local day got wrong", () => {
    // 23:30 UTC on the 26th is already the 27th in Bratislava: the removed locale call labelled this the 27th.
    expect(formatTime("2026-09-26T23:30:00.000Z")).toBe("2026-09-26");
    expect(new Date("2026-09-26T23:30:00.000Z").getDate()).toBe(27);
  });

  it("keeps the relative branches of the message-list label intact (RUFU-181 contract)", () => {
    const now = Date.now();
    const minutesAgo = new Date(now - 5 * 60_000).toISOString();
    const hoursAgo = new Date(now - 5 * 3_600_000).toISOString();
    const daysAgo = new Date(now - 3 * 86_400_000).toISOString();

    expect(formatTime(minutesAgo)).toMatch(/^\d+m ago$/);
    expect(formatTime(hoursAgo)).toMatch(/^\d+h ago$/);
    expect(formatTime(daysAgo)).toMatch(/^\d+d ago$/);
  });

  it("routes each changed CLI renderer through the shared formatter and drops host-locale calls", async () => {
    for (const [label, url] of CHANGED_CLI_SURFACES) {
      const source = await readStrippedSource(url);
      expect(source, `${label} must call the shared UTC formatter`).toContain("formatAgentTimestamp(");
      // Code-construct guard: a re-introduced host-locale call here is the RUFU-345 defect returning.
      expect(source, `${label} must not format an instant with host-locale calls`).not.toMatch(
        /\.toLocale(String|TimeString|DateString)\(/,
      );
    }
  });
});
