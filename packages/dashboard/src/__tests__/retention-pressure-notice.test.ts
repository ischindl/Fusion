/**
 * RUFU-257 Step 5: the pressure signal must reach an operator through an EXISTING channel, be
 * rate-limited twice over (sampler cooldown + a deterministic mailbox idempotency key), and carry only
 * ids/enums/numbers — never heap contents, cache keys, or census prose.
 *
 * The sampler-side thresholds and cooldown are locked in `metrics/__tests__/retention-sampler.test.ts`;
 * these tests cover what that suite cannot see: the sink the server installs, and the guarantee that a
 * hostile or absent mailbox cannot make the census tick throw.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DASHBOARD_USER_ID, type MessageCreateInput } from "@fusion/core";
import {
  buildRetentionPressureLogContext,
  buildRetentionPressureLogMessage,
  buildRetentionPressureNoticeContent,
  buildRetentionPressureNoticeIdempotencyKey,
  createRetentionPressureNotifier,
  notifyRetentionPressure,
  RETENTION_PRESSURE_NOTICE_BUCKET_MS,
  type RetentionPressureMailbox,
} from "../retention-pressure-notice.js";
import { createMetricsSampler } from "../metrics/sampler.js";
import type { RetentionPressureSignal } from "../metrics/retention-sampler.js";
import type { RetentionCensusSnapshot, RetentionSourceSnapshot } from "../lib/retention-census.js";

const here = dirname(fileURLToPath(import.meta.url));

function signal(over: Partial<RetentionPressureSignal> = {}): RetentionPressureSignal {
  return {
    reason: "heap-ratio",
    topSourceId: "file_diffs",
    topSourceBytes: 512 * 1024 * 1024,
    atCeilingStreak: 0,
    trackedBytes: 900 * 1024 * 1024,
    heapUsedBytes: 3 * 1024 * 1024 * 1024,
    heapLimitBytes: 4 * 1024 * 1024 * 1024,
    coverageRatio: 0.29,
    observedAtMs: Date.UTC(2026, 8, 23, 12, 0, 0),
    ...over,
  };
}

function fakeLogger() {
  const warn = vi.fn();
  return { warn, scope: "test", info: vi.fn(), error: vi.fn(), child: () => ({ warn }) };
}

function fakeMailbox(inserted = true) {
  const sendMessageOnce = vi.fn(async () => ({ inserted }));
  return { sendMessageOnce, mailbox: { sendMessageOnce } as unknown as RetentionPressureMailbox };
}

describe("retention pressure notice — log lane", () => {
  it("warns once per signal, naming the top source and its bytes", () => {
    const logger = fakeLogger();
    const notify = createRetentionPressureNotifier({ logger, resolveMailbox: () => null });

    notify(signal());

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message, context] = logger.warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain("heap-ratio");
    expect(message).toContain("file_diffs");
    expect(message).toContain("512.0 MiB");
    expect(context.reason).toBe("heap-ratio");
    expect(context.topSourceId).toBe("file_diffs");
  });

  it("names the ceiling streak instead of the heap share for the at-ceiling reason", () => {
    const logger = fakeLogger();
    createRetentionPressureNotifier({ logger, resolveMailbox: () => null })(
      signal({ reason: "source-at-ceiling", atCeilingStreak: 4, topSourceId: "remote_auth_tokens" }),
    );

    const [message] = logger.warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain("source-at-ceiling");
    expect(message).toContain("4 consecutive samples");
    expect(message).toContain("remote_auth_tokens");
  });

  it("stays readable when the census has no top source and no heap limit", () => {
    const logger = fakeLogger();
    createRetentionPressureNotifier({ logger, resolveMailbox: () => null })(
      signal({ topSourceId: null, topSourceBytes: 0, heapLimitBytes: 0, coverageRatio: 0, trackedBytes: 0 }),
    );

    const [message] = logger.warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain("no census source has reported bytes yet");
    expect(message).toContain("unknown share");
    // The log line must always point at the follow-up surface, or the warning is a dead end.
    expect(message).toContain("/metrics");
    expect(message).toContain("dashboard-heap-growth-runbook.md");
  });
});

describe("retention pressure notice — payload honesty", () => {
  it("carries only the fixed reason enum, a source id, and numbers in the log context", () => {
    const context = buildRetentionPressureLogContext(signal());
    expect(Object.keys(context).sort()).toEqual(
      [
        "atCeilingStreak",
        "coverageRatio",
        "heapLimitBytes",
        "heapUsedBytes",
        "reason",
        "topSourceBytes",
        "topSourceId",
        "trackedBytes",
      ].sort(),
    );
    // Fixed enum + census source id are the only non-numeric fields; everything else is a byte/ratio
    // total. Census keys, values, and heap contents must never appear here.
    for (const [key, value] of Object.entries(context)) {
      if (key === "topSourceId" || key === "reason") continue;
      expect(typeof value, key).toBe("number");
    }
    expect(typeof context.topSourceId).toBe("string");
    expect(["heap-ratio", "source-at-ceiling"]).toContain(context.reason);
    // Census byte totals are attribution, not a run-audit subject (FN-7158/FN-9175).
    expect(JSON.stringify(context)).not.toMatch(/secret|token=value|heap\s*content/i);
  });

  it("keeps operator prose out of metadata: the notice metadata is ids/enums/numbers only", async () => {
    const { mailbox, sendMessageOnce } = fakeMailbox();
    await notifyRetentionPressure(signal(), { mailbox });

    const [input] = sendMessageOnce.mock.calls[0] as [MessageCreateInput, string];
    expect(input.metadata?.kind).toBe("retention-pressure-notice");
    expect(input.metadata?.reason).toBe("heap-ratio");
    const metadata = input.metadata as Record<string, unknown>;
    for (const [key, value] of Object.entries(metadata)) {
      if (key === "kind" || key === "reason" || key === "topSourceId") {
        expect(typeof value, key).toBe("string");
        expect(String(value).length).toBeLessThan(120);
      } else {
        expect(typeof value, key).toBe("number");
      }
    }
  });

  it("addresses the operator inbox as a system one-shot notice and keeps prose in content", async () => {
    const { mailbox, sendMessageOnce } = fakeMailbox();
    await notifyRetentionPressure(signal(), { mailbox });

    const [input] = sendMessageOnce.mock.calls[0] as [MessageCreateInput, string];
    expect(input.toId).toBe(DASHBOARD_USER_ID);
    expect(input.toType).toBe("user");
    expect(input.fromId).toBe("system");
    expect(input.type).toBe("system");
    const content = buildRetentionPressureNoticeContent(signal());
    expect(input.content).toBe(content);
    expect(content).toContain("fusion_retention_coverage_ratio");
    expect(content).toContain("file_diffs");
    expect(content).toContain("512.0 MiB");
    // Honesty clause: the notice must not imply the process acted on the pressure.
    expect(content).toContain("nothing was dropped");
  });
});

describe("retention pressure notice — rate limiting", () => {
  it("collapses repeat signals of the same reason inside one bucket to one mailbox key", async () => {
    const { mailbox, sendMessageOnce } = fakeMailbox();
    const notify = createRetentionPressureNotifier({ logger: fakeLogger(), resolveMailbox: () => mailbox });

    notify(signal());
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(1));
    notify(signal({ observedAtMs: signal().observedAtMs + 60_000 }));
    await vi.waitFor(() => expect(sendMessageOnce).toHaveBeenCalledTimes(2));
    const keys = sendMessageOnce.mock.calls.map((call) => (call as [MessageCreateInput, string])[1]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^retention-pressure:heap-ratio:\d+$/);
  });

  it("keeps the two reason classes as separate notices and moves on at the next bucket", () => {
    const atCeiling = signal({ reason: "source-at-ceiling", atCeilingStreak: 3 });
    expect(buildRetentionPressureNoticeIdempotencyKey(signal())).not.toBe(
      buildRetentionPressureNoticeIdempotencyKey(atCeiling),
    );
    const nextBucket = signal().observedAtMs + RETENTION_PRESSURE_NOTICE_BUCKET_MS;
    expect(buildRetentionPressureNoticeIdempotencyKey(signal({ observedAtMs: nextBucket }))).not.toBe(
      buildRetentionPressureNoticeIdempotencyKey(signal()),
    );
  });
});

describe("retention pressure notice — hostile mailbox", () => {
  it("resolves false instead of throwing when the mailbox rejects", async () => {
    const mailbox = {
      sendMessageOnce: vi.fn(async () => {
        throw new Error("mailbox down");
      }),
    } as unknown as RetentionPressureMailbox;

    await expect(notifyRetentionPressure(signal(), { mailbox })).resolves.toBe(false);
  });

  it("never throws from the sink when the mailbox or its resolver explodes", async () => {
    const throwingSend = vi.fn(() => {
      throw new Error("sync boom");
    });
    const throwingMailbox = { sendMessageOnce: throwingSend } as unknown as RetentionPressureMailbox;
    const notify = createRetentionPressureNotifier({
      logger: fakeLogger(),
      resolveMailbox: () => {
        throw new Error("engine not attached");
      },
    });
    expect(() => notify(signal())).not.toThrow();

    const notifyWithBadMailbox = createRetentionPressureNotifier({
      logger: fakeLogger(),
      resolveMailbox: () => throwingMailbox,
    });
    expect(() => notifyWithBadMailbox(signal())).not.toThrow();
    await vi.waitFor(() => expect(throwingSend).toHaveBeenCalledTimes(1));
  });

  it("degrades to the log line alone when no message store exists", async () => {
    const logger = fakeLogger();
    createRetentionPressureNotifier({ logger, resolveMailbox: () => undefined })(signal());

    expect(logger.warn).toHaveBeenCalledTimes(1);
    await expect(notifyRetentionPressure(signal(), { mailbox: null })).resolves.toBe(false);
  });
});

describe("retention pressure notice — production seam", () => {
  it("passes the sink through the metrics orchestrator's retention init on the tick path", async () => {
    const onPressure = vi.fn();
    const source: RetentionSourceSnapshot = {
      id: "file_diffs",
      kind: "cache",
      keys: "ttl",
      ceiling: 500,
      ceilingConstant: "FILE_DIFFS_CACHE_MAX",
      entries: 500,
      approxBytes: 700 * 1024 * 1024,
      expiredEntries: 0,
      atCeiling: true,
      probeFailed: false,
    };
    const snapshot: RetentionCensusSnapshot = {
      generatedAtMs: Date.UTC(2026, 8, 23, 12, 0, 0),
      sources: [source],
      trackedBytes: source.approxBytes,
      heapUsedBytes: 2 * 1024 * 1024 * 1024,
      heapLimitBytes: 4 * 1024 * 1024 * 1024,
      coverageRatio: 0.17,
      residualBytes: 1024 * 1024 * 1024,
      probeFailureCount: 0,
      sweptSources: 0,
      sweptEntries: 0,
    };
    const sampler = createMetricsSampler({
      retention: {
        census: () => snapshot,
        ops: () => ({ ops: [], recentLatencyMs: [] }),
        ceilingStreakThreshold: 1,
        onPressure,
        timers: { setInterval: () => ({ unref: () => {} }), clearInterval: () => {} },
      },
    });

    // The same two-phase order the tick runs in: sample() advances the at-ceiling streak, then the
    // pressure decision is evaluated against it. Driven directly instead of via start() so this seam
    // test never installs the process spawn hook or real tick timers.
    sampler.retention.sample();
    sampler.retention.evaluatePressure();

    expect(onPressure).toHaveBeenCalledTimes(1);
    expect((onPressure.mock.calls[0]![0] as RetentionPressureSignal).reason).toBe("source-at-ceiling");
  });

  it("server.ts installs the notifier as the sampler's retention pressure sink", () => {
    // Code-construct guard: without the sink wired at the construction site, the whole pressure lane is
    // dead code — the sampler would evaluate pressure and report it to nobody.
    const server = readFileSync(resolve(here, "../server.ts"), "utf8");
    expect(server).toContain('createRetentionPressureNotifier');
    expect(server).toMatch(
      /createMetricsSampler\(\s*\{\s*retention:\s*\{\s*onPressure:\s*retentionPressureNotifier/,
    );
  });
});
