import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FNXC:DashboardCliProbeMemo 2026-11-08-00:55:
 * These tests assert SPAWN COUNT, never latency. `GET /api/auth/status` measured 9,39 s / 10,92 s on
 * production :4040 and a profile of a 155 s event-loop stall attributed ~24 % of samples to
 * `node:child_process` spawn machinery, so the contract under test is "N requests, one child process".
 * A timing assertion here would be exactly the kind of flake this repo quarantines on sight.
 */

const harness = vi.hoisted(() => ({
  /** One entry per `spawn()` call: `"<binary> <argv joined>"`. */
  spawns: [] as string[],
  mode: "ok" as "ok" | "missing" | "hang",
}));

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[]) => {
    harness.spawns.push(`${command} ${(args ?? []).join(" ")}`);
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    if (harness.mode === "hang") return child;
    setImmediate(() => {
      if (harness.mode === "missing") {
        child.stdout.end("");
        child.stderr.end("not found\n");
      } else if (command === "which" || command === "where") {
        child.stdout.end("/usr/local/bin/claude\n");
      } else {
        child.stdout.end("claude 1.2.3\n");
      }
      child.emit("close", harness.mode === "missing" ? 1 : 0);
    });
    return child;
  },
}));

const { probeClaudeCli, invalidateClaudeCliProbeCache } = await import("../claude-cli-probe.js");
const { createCliProbeCache } = await import("../cli-probe-cache.js");

/** One `probeClaudeCli()` run forks twice: `which claude`, then `<resolved path> --version`. */
const SPAWNS_PER_PROBE = 2;
/** In `hang` mode the `which` lookup never answers, so only its own fork is ever seen. */
const SPAWNS_WHEN_WHICH_HANGS = 1;

function spawnTally(): Map<string, number> {
  const tally = new Map<string, number>();
  for (const entry of harness.spawns) tally.set(entry, (tally.get(entry) ?? 0) + 1);
  return tally;
}

/** The `--version` fork is spawned with the RESOLVED path, so match on its argv, not its binary. */
function versionSpawnCount(): number {
  return harness.spawns.filter((entry) => entry.endsWith(" --version")).length;
}

describe("probeClaudeCli memoization", () => {
  beforeEach(() => {
    harness.spawns = [];
    harness.mode = "ok";
    invalidateClaudeCliProbeCache();
    vi.useRealTimers();
  });

  it("spawns once for N concurrent callers, not N times", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => probeClaudeCli()));

    const tally = spawnTally();
    expect(tally.get("which claude")).toBe(1);
    expect(versionSpawnCount()).toBe(1);
    expect(harness.spawns.length).toBe(SPAWNS_PER_PROBE);
    // Every caller still gets a real answer, not a shared half-initialized value.
    for (const result of results) {
      expect(result.available).toBe(true);
      expect(result.version).toBe("claude 1.2.3");
    }
  });

  it("spawns once across N sequential callers inside the TTL", async () => {
    for (let i = 0; i < 5; i += 1) {
      const result = await probeClaudeCli();
      expect(result.available).toBe(true);
    }
    expect(harness.spawns.length).toBe(SPAWNS_PER_PROBE);
  });

  it("spawns exactly one more probe after the success TTL expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = Date.now();

    await probeClaudeCli();
    expect(harness.spawns.length).toBe(SPAWNS_PER_PROBE);

    vi.setSystemTime(base + 59_000);
    await probeClaudeCli();
    expect(harness.spawns.length).toBe(SPAWNS_PER_PROBE);

    vi.setSystemTime(base + 61_000);
    await probeClaudeCli();
    expect(harness.spawns.length).toBe(SPAWNS_PER_PROBE * 2);
  });

  it("spawns exactly one more probe immediately on invalidation", async () => {
    await probeClaudeCli();
    expect(harness.spawns.length).toBe(SPAWNS_PER_PROBE);

    invalidateClaudeCliProbeCache();
    await probeClaudeCli();
    expect(harness.spawns.length).toBe(SPAWNS_PER_PROBE * 2);
  });

  it("caches a failed probe under the short TTL so an install is noticed without a restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = Date.now();
    harness.mode = "missing";

    const missing = await probeClaudeCli();
    expect(missing.available).toBe(false);
    expect(harness.spawns.length).toBe(SPAWNS_PER_PROBE);

    // A failure is not re-probed on every request either — it is just remembered for less long.
    await probeClaudeCli();
    expect(harness.spawns.length).toBe(SPAWNS_PER_PROBE);

    // Past the failure window the answer is asked again: an operator who installs claude mid-session
    // is seen without a restart, which is why failures must not inherit the 60 s success TTL.
    vi.setSystemTime(base + 5_001);
    await probeClaudeCli();
    expect(harness.spawns.length).toBe(SPAWNS_PER_PROBE * 2);

    // And a success TTL must not be what a failure is held under: one more failure window later
    // the repaired install is visible.
    vi.setSystemTime(base + 5_001 + 5_001);
    harness.mode = "ok";
    const installed = await probeClaudeCli();
    expect(installed.available).toBe(true);
  });

  it("reports a timed-out probe as a cached failure rather than hanging the endpoint", async () => {
    harness.mode = "hang";

    const first = await probeClaudeCli({ timeoutMs: 20 });
    expect(first.available).toBe(false);
    expect(first.reason).toContain("timed out");

    // The timeout is an answer: a caller arriving right after it reuses it instead of being
    // handed the still-pending child process.
    const second = await probeClaudeCli({ timeoutMs: 20 });
    expect(second).toBe(first);
    // A hung `which` means the probe never reached the `--version` fork at all.
    expect(harness.spawns.length).toBe(SPAWNS_WHEN_WHICH_HANGS);
    expect(versionSpawnCount()).toBe(0);
  });

  it("keeps distinct timeout budgets in distinct cache entries", async () => {
    harness.mode = "hang";
    const timedOut = await probeClaudeCli({ timeoutMs: 20 });
    expect(timedOut.available).toBe(false);

    // A caller asking for a different budget gets a probe that actually ran under that budget,
    // not an answer measured under someone else's.
    harness.mode = "ok";
    const ok = await probeClaudeCli({ timeoutMs: 2_000 });
    expect(ok.available).toBe(true);
    expect(versionSpawnCount()).toBe(1);
  });
});

describe("createCliProbeCache single-flight", () => {
  it("does not share an in-flight probe that is past its staleness bound", async () => {
    let produceCount = 0;
    const resolvers: Array<(value: { available: boolean }) => void> = [];
    let clock = 1_000;

    const probe = createCliProbeCache<{ available: boolean }>(
      async () => {
        produceCount += 1;
        return new Promise((resolve) => {
          resolvers.push(resolve);
        });
      },
      {
        isFailure: (result) => (result as { available: boolean }).available !== true,
        flightStaleMs: 5_000,
        now: () => clock,
      },
    );

    const first = probe("k");
    // Still inside the sharing window: a concurrent caller joins the same probe.
    const joined = probe("k");
    expect(produceCount).toBe(1);

    // Past the window, a caller must not inherit a promise that may never settle.
    clock += 5_001;
    const third = probe("k");
    expect(produceCount).toBe(2);
    expect(third).not.toBe(joined);

    for (const resolve of resolvers) resolve({ available: true });
    await Promise.all([first, joined, third]).catch(() => undefined);
  });

  it("records a throwing probe as a short-lived failure and still rejects the caller", async () => {
    let clock = 0;
    let produceCount = 0;
    const probe = createCliProbeCache<{ available: boolean }>(
      async () => {
        produceCount += 1;
        throw new Error("probe exploded");
      },
      {
        isFailure: () => true,
        failureTtlMs: 1_000,
        flightStaleMs: 1_000,
        now: () => clock,
      },
    );

    await expect(probe("k")).rejects.toThrow("probe exploded");
    expect(produceCount).toBe(1);

    // Concurrent-retried inside the failure window: no new probe.
    await expect(probe("k")).rejects.toThrow("probe exploded");
    expect(produceCount).toBe(1);

    clock += 1_001;
    await expect(probe("k")).rejects.toThrow("probe exploded");
    expect(produceCount).toBe(2);
  });

  it("scopes cached answers by key so a new binary path is never answered from the old one", async () => {
    let produceCount = 0;
    const probe = createCliProbeCache<{ available: boolean }>(
      async (key) => {
        produceCount += 1;
        return { available: key === "/good/claude" };
      },
      { isFailure: (result) => (result as { available: boolean }).available !== true },
    );

    expect(await probe("/bad/claude")).toEqual({ available: false });
    expect(await probe("/bad/claude")).toEqual({ available: false });
    expect(await probe("/good/claude")).toEqual({ available: true });
    expect(produceCount).toBe(2);
  });
});
