// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import { execFileAsync } from "../../exec-file.js";
import { superviseSpawn } from "@fusion/core";
import {
  createRuntimeSampler,
  createRequestLatencyMiddleware,
  defaultPsProbe,
} from "../runtime-sampler.js";
import type { PsProbe, PsProbeResult } from "../runtime-sampler.js";
import { get } from "../../test-request.js";

/**
 * RUFU-081 runtime sampler tests.
 *
 * Covers the injectable surface of `createRuntimeSampler`:
 *   - the latency recorder measuring REAL request-pipeline durations on a live
 *     Express app, plus the idle freeze-indicator growing over time;
 *   - the bounded percentile + bucket math over the recent-duration ring;
 *   - the spawn hook counting spawn/fork/execFile/exec (via an injected fake
 *     module), being idempotent, and restoring the originals exactly;
 *   - the hook keeping `superviseSpawn` + `execFileAsync` working against the
 *     REAL `node:child_process` module after install;
 *   - process CPU/memory and the git-subprocess gauge via injected probes.
 */

const NODE = process.execPath;

function buildApp(sampler: ReturnType<typeof createRuntimeSampler>): Express {
  const app = express();
  app.use(createRequestLatencyMiddleware(sampler.latency));
  app.get("/api/health", (_req, res) => {
    res.json({ database: "ok" });
  });
  app.get("/{*splat}", (_req, res) => {
    res.status(404).end();
  });
  return app;
}

describe("request latency recorder", () => {
  let sampler: ReturnType<typeof createRuntimeSampler>;
  let app: Express;

  beforeEach(() => {
    sampler = createRuntimeSampler();
    app = buildApp(sampler);
  });

  it("records real request-pipeline durations on the live serving path", async () => {
    const healthRes = await get(app, "/api/health");
    expect(healthRes.status).toBe(200);
    expect((healthRes.body as { database: string }).database).toBe("ok");

    const fallbackRes = await get(app, "/some/nonexistent/path");
    expect(fallbackRes.status).toBe(404);

    const now = Date.now();
    const families = sampler.buildSnapshot(now);
    const count = families.find((f) => f.name === "fusion_system_request_count_total")!;
    const latency = families.find((f) => f.name === "fusion_system_request_latency_ms")!;
    const lastAge = families.find((f) => f.name === "fusion_system_last_request_age_ms")!;

    expect(count.samples[0].value).toBeGreaterThanOrEqual(2);
    // Every served duration is finite, non-negative.
    for (const s of latency.samples) expect(Number.isFinite(s.value)).toBe(true);
    // The last request completed "just now", so the freeze indicator is tiny.
    expect(lastAge.samples[0].value).toBeLessThanOrEqual(60_000);
  });

  it("grows the last-request-age freeze indicator over idle time", () => {
    sampler.recordRequest(5); // last served at Date.now()
    const now = Date.now();
    const families = sampler.buildSnapshot(now + 5000);
    const lastAge = families.find((f) => f.name === "fusion_system_last_request_age_ms")!;
    expect(lastAge.samples[0].value).toBe(5000);
  });

  it("never lets the freeze indicator go negative before any request", () => {
    const now = Date.now();
    const families = sampler.buildSnapshot(now + 5000);
    const lastAge = families.find((f) => f.name === "fusion_system_last_request_age_ms")!;
    expect(lastAge.samples[0].value).toBe(0);
  });

  it("computes bounded percentiles and bucket counts over the ring", () => {
    // Push a known distribution: [10, 100, 1000].
    for (const ms of [10, 100, 1000]) sampler.recordRequest(ms);
    const families = sampler.buildSnapshot(0);
    const latency = families.find((f) => f.name === "fusion_system_request_latency_ms")!;
    const byLabel = Object.fromEntries(latency.samples.map((s) => [s.labelValues![0], s.value]));
    expect(byLabel.p50).toBe(100); // 3 samples → ceil(1.5)-1 = index 1 → 100
    expect(byLabel.max).toBe(1000);

    const bucket = families.find((f) => f.name === "fusion_system_request_latency_bucket")!;
    const le10 = bucket.samples.find((s) => s.labelValues![0] === "10")!;
    expect(le10.value).toBe(1);
    const le5000 = bucket.samples.find((s) => s.labelValues![0] === "5000")!;
    expect(le5000.value).toBe(3);
  });
});

describe("spawn hook (injected fake module)", () => {
  let spawnMod: {
    spawn: (...args: unknown[]) => unknown;
    fork: (...args: unknown[]) => unknown;
    execFile: (...args: unknown[]) => unknown;
    exec: (...args: unknown[]) => unknown;
  };
  let sampler: ReturnType<typeof createRuntimeSampler>;

  beforeEach(() => {
    spawnMod = {
      spawn: vi.fn(() => "child"),
      fork: vi.fn(() => "child"),
      execFile: vi.fn(() => "child"),
      exec: vi.fn(() => "child"),
    };
    sampler = createRuntimeSampler({ spawnModule: spawnMod as never });
  });

  it("counts spawn/fork/execFile/exec then restores the originals", () => {
    expect(sampler.installSpawnHook()).toBe(true);
    // Call the PATCHED module functions (spawnMod.* is now wrapped). Each
    // wrapped fn delegates to the original fake via .apply and increments.
    spawnMod.spawn("a");
    spawnMod.fork("a");
    spawnMod.execFile("a");
    spawnMod.exec("a");

    expect(sampler.spawnCounts.total).toBe(4);
    expect(sampler.spawnCounts.byKind.spawn).toBe(1);
    expect(sampler.spawnCounts.byKind.fork).toBe(1);
    expect(sampler.spawnCounts.byKind.execFile).toBe(1);
    expect(sampler.spawnCounts.byKind.exec).toBe(1);

    // Remove restores the originals (spawnMod.* is no longer wrapped).
    sampler.removeSpawnHook();
    const totalAfter = sampler.spawnCounts.total;
    spawnMod.spawn("b");
    expect(sampler.spawnCounts.total).toBe(totalAfter);
  });

  it("is idempotent — a second install does not double-wrap", () => {
    expect(sampler.installSpawnHook()).toBe(true);
    expect(sampler.installSpawnHook()).toBe(false);
    spawnMod.spawn("a");
    // Only one wrap: a single spawn increments by exactly 1.
    expect(sampler.spawnCounts.byKind.spawn).toBe(1);
    expect(sampler.spawnCounts.total).toBe(1);
  });

  it("renders spawn totals as counters with per-kind labels", () => {
    sampler.installSpawnHook();
    spawnMod.execFile("a");
    const families = sampler.buildSnapshot(Date.now());
    const total = families.find((f) => f.name === "fusion_system_child_process_spawn_total")!;
    expect(total.type).toBe("counter");
    expect(total.samples[0].value).toBe(1);
    const byKind = families.find((f) => f.name === "fusion_system_child_process_spawn_total_by_kind")!;
    expect(byKind.labels).toEqual(["kind"]);
    expect(byKind.samples.find((s) => s.labelValues![0] === "execFile")!.value).toBe(1);
  });
});

describe("spawn hook on the real child_process module", () => {
  let sampler: ReturnType<typeof createRuntimeSampler>;

  afterEach(() => {
    sampler.removeSpawnHook();
  });

  it("keeps superviseSpawn and execFileAsync working after install", async () => {
    sampler = createRuntimeSampler(); // defaults to the live node:child_process module
    expect(sampler.installSpawnHook()).toBe(true);

    const supervised = superviseSpawn(NODE, ["-e", "0"], { stdio: "ignore" });
    const exit = await supervised.waitExit();
    expect([0, null]).toContain(exit.code);

    const { stdout } = await execFileAsync(NODE, ["-e", 'process.stdout.write("ok")']);
    expect(stdout).toContain("ok");
  });
});

describe("process + git gauges (injected probes)", () => {
  it("renders process cpu/memory gauges from the injected process surface", async () => {
    const sampler = createRuntimeSampler({
      processRef: {
        pid: 1234,
        cpuUsage: () => ({ user: 2_000_000, system: 1_000_000 }), // 2s + 1s
        memoryUsage: () => ({ rss: 1000, heapTotal: 500, heapUsed: 200 }),
      },
      psProbe: async () => ({ ok: false, childCommands: [], reason: "non-posix" }),
    });
    await sampler.sampleProcessAndGit();

    const families = sampler.buildSnapshot(Date.now());
    // Guard for label families that legitimately have zero samples (e.g. the
    // per-kind spawn family with no spawns yet).
    const byName = Object.fromEntries(families.map((f) => [f.name, f.samples[0]?.value ?? 0]));
    expect(byName.fusion_system_cpu_user_seconds_total).toBe(2);
    expect(byName.fusion_system_cpu_system_seconds_total).toBe(1);
    expect(byName.fusion_system_process_rss_bytes).toBe(1000);
    expect(byName.fusion_system_process_heap_used_bytes).toBe(200);
    expect(byName.fusion_system_process_heap_total_bytes).toBe(500);
  });

  it("counts git child processes from a successful single-level probe", async () => {
    const sampler = createRuntimeSampler({
      psProbe: async () => ({ ok: true, childCommands: ["git", "git", "node"] }),
    });
    await sampler.sampleProcessAndGit();
    const families = sampler.buildSnapshot(Date.now());
    const git = families.find((f) => f.name === "fusion_system_git_child_processes")!;
    expect(git.samples[0].value).toBe(2);
  });

  it("degrades to 0 on a failing or non-posix probe without throwing", async () => {
    const failing: PsProbe = async () => ({ ok: false, childCommands: [], reason: "probe-error" });
    const sampler = createRuntimeSampler({ psProbe: failing });
    await sampler.sampleProcessAndGit();
    const families = sampler.buildSnapshot(Date.now());
    const git = families.find((f) => f.name === "fusion_system_git_child_processes")!;
    expect(git.samples[0].value).toBe(0);
    expect(Number.isFinite(git.samples[0].value)).toBe(true);
  });

  it("defaultPsProbe returns a settling result on any platform", async () => {
    // Regardless of platform, the probe always settles with a finite outcome.
    const result = await defaultPsProbe(process.pid);
    expect(typeof result.ok).toBe("boolean");
    expect(Array.isArray(result.childCommands)).toBe(true);
  });
});

describe("overlap guard (RUFU-081 Greptile P1 #2)", () => {
  /*
  FNXC:MetricsSampler 2026-08-18-11:53 (RUFU-081 CodeRabbit Major, RUFU-106 review fix):
  An async `sampleProcessAndGit` that outlasts its arm's interval must never overlap the next tick
  under the same guard key. These fake-timer tests hold the `psProbe` promise pending while a
  second interval fires and assert the probe is invoked once (the tick was skipped). The `process`
  and `git` arms SHARE one guard key (both call sampleProcessAndGit), so a coinciding tick on the
  other arm is skipped too instead of double-probing (CodeRabbit Major review fix 2026-08-18-11:53).
  */
  it("skips a process tick still in flight — the ps probe is invoked at most once per completed window", async () => {
    vi.useFakeTimers();
    let resolveProbe: (r: PsProbeResult) => void = () => {};
    const pending = new Promise<PsProbeResult>((res) => {
      resolveProbe = res;
    });
    const psProbe = vi.fn(() => pending);
    const sampler = createRuntimeSampler({ tick: { processMs: 5000, gitMs: 1_000_000 }, psProbe });
    sampler.start();

    // First window fires -> probe invoked, sample stays pending (in flight).
    await vi.advanceTimersByTimeAsync(5000);
    expect(psProbe).toHaveBeenCalledTimes(1);

    // Second window fires while tick 1 is still awaiting -> SKIPPED (probe NOT re-invoked).
    await vi.advanceTimersByTimeAsync(5000);
    expect(psProbe).toHaveBeenCalledTimes(1);

    // Resolve the in-flight sample; the `finally` clears the guard.
    resolveProbe({ ok: false, childCommands: [], reason: "probe-error" });
    await vi.advanceTimersByTimeAsync(0);

    // Guard clear -> process arm fires again, exactly once per window.
    await vi.advanceTimersByTimeAsync(5000);
    expect(psProbe).toHaveBeenCalledTimes(2);

    sampler.stopTimers();
  });

  it("skips a git tick still in flight — the git arm never overlaps its own in-flight sample", async () => {
    vi.useFakeTimers();
    let resolveProbe: (r: PsProbeResult) => void = () => {};
    const pending = new Promise<PsProbeResult>((res) => {
      resolveProbe = res;
    });
    const psProbe = vi.fn(() => pending);
    // processMs far out, so only the git (15s) arm fires in this window.
    const sampler = createRuntimeSampler({ tick: { processMs: 1_000_000, gitMs: 15_000 }, psProbe });
    sampler.start();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(psProbe).toHaveBeenCalledTimes(1);

    // Second git window fires while the first is still awaiting -> SKIPPED.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(psProbe).toHaveBeenCalledTimes(1);

    resolveProbe({ ok: false, childCommands: [], reason: "probe-error" });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(psProbe).toHaveBeenCalledTimes(2);

    sampler.stopTimers();
  });

  /*
   * FNXC:MetricsSampler 2026-08-18-11:53 (RUFU-081 CodeRabbit Major, RUFU-106 review fix):
   * With the DEFAULT 5000/15000 ms cadence the process and git arms coincide at t=15000; the
   * shared guard must skip the coinciding git tick instead of launching a second concurrent
   * `ps` probe. This test keeps both arms at their defaults (no pushed-out interval).
   */
  it("skips the coinciding git tick under the shared guard at default cadence — one probe per completed window", async () => {
    vi.useFakeTimers();
    let resolveProbe: (r: PsProbeResult) => void = () => {};
    const pending = new Promise<PsProbeResult>((res) => {
      resolveProbe = res;
    });
    const psProbe = vi.fn(() => pending);
    // Default cadence: process 5000 ms, git 15000 ms — the arms coincide at t=15000.
    const sampler = createRuntimeSampler({ psProbe });
    sampler.start();

    // t=5000: the process arm fires -> probe #1 (still pending).
    await vi.advanceTimersByTimeAsync(5000);
    expect(psProbe).toHaveBeenCalledTimes(1);

    // t=10000: the process tick is skipped (same guard key, in flight).
    await vi.advanceTimersByTimeAsync(5000);
    expect(psProbe).toHaveBeenCalledTimes(1);

    // t=15000: the git tick coincides while the process sample is still pending ->
    // the SHARED guard skips it; no second probe.
    await vi.advanceTimersByTimeAsync(5000);
    expect(psProbe).toHaveBeenCalledTimes(1);

    // Resolve the in-flight sample; the shared guard clears in `finally`.
    resolveProbe({ ok: false, childCommands: [], reason: "probe-error" });
    await vi.advanceTimersByTimeAsync(0);

    // t=20000: the process arm fires again -> probe #2.
    await vi.advanceTimersByTimeAsync(5000);
    expect(psProbe).toHaveBeenCalledTimes(2);

    sampler.stopTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
/*
FNXC:LoopDelayMetrics 2026-11-11-02:55:
`fusion_system_last_request_age_ms` was the loop-health signal, and it is only evidence while a request
is actually waiting. Measured 2026-11-11 on the engine host it read 305 000 ms with zero pending requests
— the engine host simply gets no HTTP traffic — while `ps` showed its main thread at 74.5 % CPU. These
cases hold the replacement: an absolute delay histogram that reports the same thing with or without
traffic.
*/
describe("event-loop delay histogram", () => {
  const fakeDelay = (overrides: Partial<{ reset: () => void }> = {}) => ({
    percentile: (p: number) => (({ 50: 1_500_000, 95: 9_000_000, 99: 42_000_000 }) as Record<number, number>)[p] ?? 0,
    mean: 3_000_000,
    max: 120_000_000,
    enable: vi.fn(),
    disable: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  });

  const familyOf = (sampler: ReturnType<typeof createRuntimeSampler>) =>
    sampler.buildSnapshot().find((f) => f.name === "fusion_eventloop_delay_ms");

  it("converts the nanosecond histogram into millisecond quantiles", () => {
    const sampler = createRuntimeSampler({ eventLoopDelay: fakeDelay() });
    const family = familyOf(sampler);

    expect(family?.type).toBe("gauge");
    expect(family?.labels).toEqual(["quantile"]);
    const byQuantile = Object.fromEntries((family?.samples ?? []).map((s) => [s.labelValues?.[0], s.value]));
    expect(byQuantile.p50).toBeCloseTo(1.5);
    expect(byQuantile.p95).toBeCloseTo(9);
    expect(byQuantile.p99).toBeCloseTo(42);
    expect(byQuantile.mean).toBeCloseTo(3);
    expect(byQuantile.max).toBeCloseTo(120);
  });

  it("exposes no family when the probe is opted out", () => {
    const sampler = createRuntimeSampler({ eventLoopDelay: null });
    expect(familyOf(sampler)).toBeUndefined();
  });

  it("resets the window when timers stop, so a shutdown-spanning window is never scraped", () => {
    const delay = fakeDelay();
    const sampler = createRuntimeSampler({ eventLoopDelay: delay });

    sampler.stopTimers();

    expect(delay.reset).toHaveBeenCalledOnce();
  });

  it("reports a real stall on the live probe, without a fake in the way", async () => {
    /*
    Measured 2026-11-11 under the probe's 10 ms resolution: an unblocked process floors at
    max≈10.9 ms, a 120 ms block yields max≈120.65 ms. 60 ms therefore separates a stalled loop from a
    loaded-but-healthy one by an order of magnitude on one side and 5x on the other, and the block
    itself stays short enough that this is not a slow test.
    */
    const sampler = createRuntimeSampler();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const deadline = Date.now() + 120;
    while (Date.now() < deadline) { /* block the loop */ }
    // One macrotask lets the probe's own timer observe the delay it just missed.
    await new Promise((resolve) => setTimeout(resolve, 40));

    const max = familyOf(sampler)?.samples.find((s) => s.labelValues?.[0] === "max")?.value;
    expect(max).toBeGreaterThanOrEqual(60);
  });
});
