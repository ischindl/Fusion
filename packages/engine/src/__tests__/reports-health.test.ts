import { describe, expect, it } from "vitest";
import { classifyReportHealth, type ReportHealthInput } from "../reports-health.js";

const baseInput: ReportHealthInput = {
  state: "active",
  pauseReason: undefined,
  heartbeatAgeMs: 1_000,
  heartbeatTimeoutMs: 10_000,
  staleThresholdMs: 20_000,
  staleParkedAssignment: false,
};

describe("classifyReportHealth", () => {
  it.each(["paused", "active", "running", "idle"] as const)(
    "renders error-unrecoverable marker as operator-actionable for %s state",
    (state) => {
      const result = classifyReportHealth({ ...baseInput, state, pauseReason: "error-unrecoverable" });

      expect(result).toMatchObject({
        bucket: "operator-actionable",
        cellText: expect.stringContaining("needs operator repair"),
      });
      expect(result.cellText).not.toContain("healthy");
    },
  );

  it("tolerates a marker interleaved onto a resumed persisted row", () => {
    const persistedDesync = {
      state: "active",
      pauseReason: "error-unrecoverable",
    };

    expect(classifyReportHealth({ ...baseInput, ...persistedDesync }).bucket).toBe("operator-actionable");
  });

  it.each(["error-retry-exhausted", "heartbeat-model-unavailable"])(
    "renders %s marker as operator-actionable",
    (pauseReason) => {
      expect(classifyReportHealth({ ...baseInput, pauseReason }).bucket).toBe("operator-actionable");
    },
  );

  it.each(["user-requested", "awaiting-approval", "budget-exhausted"])(
    "renders non-operator marker %s as paused",
    (pauseReason) => {
      expect(classifyReportHealth({ ...baseInput, pauseReason })).toEqual({
        bucket: "paused",
        cellText: `paused (${pauseReason})`,
      });
    },
  );

  it("preserves existing state and freshness buckets when no marker exists", () => {
    expect(classifyReportHealth({ ...baseInput, state: "error" }).bucket).toBe("operator-actionable");
    expect(classifyReportHealth({ ...baseInput, staleParkedAssignment: true }).bucket).toBe("stale-assignment");
    expect(classifyReportHealth({ ...baseInput, state: "running", heartbeatAgeMs: 20_001 }).bucket).toBe("stuck");
    expect(classifyReportHealth({ ...baseInput, state: "active", heartbeatAgeMs: 20_001 }).bucket).toBe("stale");
    expect(classifyReportHealth({ ...baseInput, state: "idle", heartbeatAgeMs: 20_001 }).bucket).toBe("stale");
    expect(classifyReportHealth({ ...baseInput, state: "paused" })).toEqual({ bucket: "paused", cellText: "paused" });
    expect(classifyReportHealth({ ...baseInput, state: undefined })).toEqual({ bucket: "healthy", cellText: "healthy" });
  });

  it.each([undefined, "", "   "])("treats empty marker %j as unmarked", (pauseReason) => {
    expect(classifyReportHealth({ ...baseInput, pauseReason })).toEqual({ bucket: "healthy", cellText: "healthy" });
  });

  /*
  FNXC:ProviderThrottleIsTransient 2026-09-30-14:17 (RUFU-286):
  A throttled agent stays `state: "error"` while the heartbeat timer holds a bounded re-probe, so
  reporting that cell as `**needs operator repair**` sent operators to fix credentials that were
  never the problem. The cooldown deadline is the derived value from the shared core reader; the
  state column stays `error` because the agent genuinely is not running.
  */
  it("reports a live throttle cooldown as rate-limited, not operator repair", () => {
    const result = classifyReportHealth({
      ...baseInput,
      state: "error",
      throttleCooldownUntilAt: "2026-09-30T12:01:00.000Z",
    });

    expect(result.bucket).toBe("rate-limited");
    expect(result.cellText).toContain("rate limited — auto-retry scheduled");
    expect(result.cellText).toContain("2026-09-30T12:01:00.000Z");
    expect(result.cellText).not.toContain("needs operator repair");
  });

  it("keeps a pause marker ranking above a throttle cooldown", () => {
    // A paused card has no timer re-probe to promise, so the pause classification wins.
    expect(classifyReportHealth({
      ...baseInput,
      state: "paused",
      pauseReason: "error-retry-exhausted",
      throttleCooldownUntilAt: "2026-09-30T12:01:00.000Z",
    }).bucket).toBe("operator-actionable");
  });

  it("reports an unthrottled error state as operator repair and ignores non-error cooldowns", () => {
    expect(classifyReportHealth({ ...baseInput, state: "error" }).bucket).toBe("operator-actionable");
    expect(classifyReportHealth({ ...baseInput, state: "error", throttleCooldownUntilAt: null }).bucket)
      .toBe("operator-actionable");
    expect(classifyReportHealth({ ...baseInput, state: "active", throttleCooldownUntilAt: "2026-09-30T12:01:00.000Z" })
      .bucket).toBe("healthy");
  });

  it("does not accept lastError as a classification input", () => {
    const withResidualError = { ...baseInput, lastError: "long residual diagnostic text" };
    const withoutResidualError = { ...baseInput };

    expect(classifyReportHealth(withResidualError)).toEqual(classifyReportHealth(withoutResidualError));
  });
});
