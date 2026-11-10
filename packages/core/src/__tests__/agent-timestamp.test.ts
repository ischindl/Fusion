import { describe, expect, it } from "vitest";
import { AGENT_TIMESTAMP_UNKNOWN, formatAgentTimestamp } from "../agent-timestamp.js";

/*
FNXC:AgentTimestampFormat 2026-11-09-13:15 (RUFU-345):
RUFU-345's defect class is a value rendered in the host timezone while labelled "UTC", plus a shape that
changes with the host locale. Both are invisible to a test that runs on a UTC CI box, so every case here
either pins the exact UTC string or re-renders the SAME instant under a host timezone that provably
disagrees with UTC and asserts the string did not move.
*/

const INSTANT_ISO = "2026-09-26T20:04:17.000Z";
const INSTANT_MS = Date.UTC(2026, 8, 26, 20, 4, 17);
const EXPECTED = "2026-09-26 20:04:17 UTC";

/** Zones chosen because each one moves a local render off the UTC value in a different way. */
const NON_UTC_ZONES = [
  "Europe/Bratislava", // +02:00 in September (the measured host), +01:00 in winter
  "Asia/Kolkata", // +05:30 — a non-hour offset shifts minutes, not just hours
  "Pacific/Auckland", // southern hemisphere: opposite DST season to Europe/Bratislava
  "America/Sao_Paulo", // -03:00, behind UTC so a local render goes backwards
];

function withTz<T>(tz: string, body: () => T): T {
  const prior = process.env.TZ;
  process.env.TZ = tz;
  try {
    return body();
  } finally {
    if (prior === undefined) delete process.env.TZ;
    else process.env.TZ = prior;
  }
}

describe("formatAgentTimestamp", () => {
  it("renders the canonical UTC shape from a Date", () => {
    expect(formatAgentTimestamp(new Date(INSTANT_MS))).toBe(EXPECTED);
  });

  it("is timezone-independent for every non-UTC host zone", () => {
    for (const tz of NON_UTC_ZONES) {
      const rendered = withTz(tz, () => formatAgentTimestamp(new Date(INSTANT_MS)));
      expect(`${tz}: ${rendered}`).toBe(`${tz}: ${EXPECTED}`);
    }
  });

  it("agrees with the toISOString() clock the agent log writes", () => {
    const iso = new Date(INSTANT_ISO).toISOString(); // 2026-09-26T20:04:17.000Z
    expect(formatAgentTimestamp(INSTANT_ISO)).toBe(`${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`);
  });

  it("accepts Date, ISO string, and epoch milliseconds identically", () => {
    const fromDate = formatAgentTimestamp(new Date(INSTANT_MS));
    expect(formatAgentTimestamp(INSTANT_ISO)).toBe(fromDate);
    expect(formatAgentTimestamp(INSTANT_MS)).toBe(fromDate);
  });

  it("renders UTC components at a DST boundary and at a non-hour offset", () => {
    // 2026-10-25T01:00:00Z is the EU summer-time ending instant; Bratislava is mid-shift between +02:00 and +01:00.
    const dst = Date.UTC(2026, 9, 25, 1, 0, 0);
    expect(withTz("Europe/Bratislava", () => formatAgentTimestamp(new Date(dst)))).toBe("2026-10-25 01:00:00 UTC");
    // 05:30 offset would shift the minute field of any local render by 30.
    expect(withTz("Asia/Kolkata", () => formatAgentTimestamp(new Date(dst)))).toBe("2026-10-25 01:00:00 UTC");
  });

  it("pads single-digit months, days, and clock fields", () => {
    expect(formatAgentTimestamp(new Date(Date.UTC(2026, 0, 3, 4, 5, 6)))).toBe("2026-01-03 04:05:06 UTC");
  });

  it("renders the honest constant instead of throwing or printing Invalid Date", () => {
    for (const bad of [null, undefined, "not a date", Number.NaN, {}, true]) {
      const rendered = formatAgentTimestamp(bad as never);
      expect(rendered).toBe(AGENT_TIMESTAMP_UNKNOWN);
      expect(rendered).not.toContain("Invalid");
    }
  });

  it("never leaks a local wall-clock digit for the measured host zone", () => {
    // Bratislava local for this instant is 22:04:17 (+02:00); that digit pair is the failure condition.
    const rendered = withTz("Europe/Bratislava", () => formatAgentTimestamp(INSTANT_ISO));
    expect(rendered).toBe(EXPECTED);
    expect(rendered).not.toContain("22:04:17");
  });
});
