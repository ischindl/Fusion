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

  /*
  FNXC:ReportsHealth 2026-11-18-14:44 (RUFU-716):
  Symptom pair, measured off production lane agent-3ac88b82: heartbeatAgeMs 29 530 259 ms against a
  5 400 000 ms threshold, with the daemon logging `timer-heartbeat-suppressed reason=no-fresher-signal`
  every interval and `[reports-health] stale report … heartbeatAgeMs=29530259` in the same breath.
  The classifier read only the delivery timestamp, so the lane was `**stale**` forever and the prompt
  under the table ordered an investigation of it on every manager heartbeat.
  */
  const agedHeartbeatMs = 29_530_259;
  const freshFire = { reason: "wake-suppressed" as const, firedAt: "2026-11-18T11:59:00.000Z", fireAgeMs: 60_000 };

  it("AC1: a lane whose timer fired inside its own window is no longer stale", () => {
    const result = classifyReportHealth({
      ...baseInput,
      state: "active",
      heartbeatAgeMs: agedHeartbeatMs,
      deliverySkip: freshFire,
    });

    expect(result.bucket).toBe("delivery-skipped");
    expect(result.cellText).not.toContain("**stale**");
    expect(result.cellText.toLowerCase()).not.toContain("stale");
    expect(result.cellText).toContain("delivery skipped");
    // The instruction that made the false alarm actionable must not be present in any form.
    expect(result.cellText.toLowerCase()).not.toMatch(/create|investigate|follow-up|retry|check|restart/);
  });

  it("AC2: the same row without any fire evidence keeps the stale verdict", () => {
    const result = classifyReportHealth({ ...baseInput, state: "active", heartbeatAgeMs: agedHeartbeatMs });

    expect(result.bucket).toBe("stale");
    expect(result.cellText).toBe("**stale**");
  });

  it("relief is bounded by the derived fire age, not by the delivery age", () => {
    // The caller only hands over a fire inside its own stale window; the classifier must not re-check
    // heartbeatAgeMs, which is the input that lied in the first place.
    for (const state of ["active", "idle"] as const) {
      expect(classifyReportHealth({
        ...baseInput,
        state,
        heartbeatAgeMs: agedHeartbeatMs,
        deliverySkip: freshFire,
      }).bucket).toBe("delivery-skipped");
    }
    // An absent or explicitly null relief (expired, unparseable, or never written) relieves nothing.
    for (const relief of [undefined, null]) {
      expect(classifyReportHealth({
        ...baseInput,
        state: "active",
        heartbeatAgeMs: agedHeartbeatMs,
        deliverySkip: relief,
      }).bucket).toBe("stale");
    }
  });

  it.each([
    ["pause marker", { state: "active", pauseReason: "error-unrecoverable" }],
    ["error state", { state: "error" }],
    ["stale parked assignment", { state: "active", staleParkedAssignment: true }],
  ] as const)("relief never outranks the %s verdict", (_label, override) => {
    const result = classifyReportHealth({
      ...baseInput,
      ...override,
      heartbeatAgeMs: agedHeartbeatMs,
      deliverySkip: freshFire,
    });

    expect(result.bucket).not.toBe("delivery-skipped");
  });

  it("relief does not reach a running lane, which is the stuck story", () => {
    const result = classifyReportHealth({
      ...baseInput,
      state: "running",
      heartbeatAgeMs: 20_001,
      deliverySkip: freshFire,
    });

    expect(result.bucket).toBe("stuck");
  });

  it.each(["wake-suppressed", "idle-skip", "parallel-execution"] as const)(
    "reason %s renders its own plain-language cause with the fire age",
    (reason) => {
      const result = classifyReportHealth({
        ...baseInput,
        state: "idle",
        heartbeatAgeMs: agedHeartbeatMs,
        deliverySkip: { reason, firedAt: "2026-11-18T11:00:00.000Z", fireAgeMs: 8 * 60 * 60_000 },
      });

      expect(result.bucket).toBe("delivery-skipped");
      expect(result.cellText).toContain("timer fired 8h00m ago");
      expect(result.cellText.toLowerCase()).not.toContain("stale");
    },
  );

  it("refuses relief for a reason outside the closed set, because unreadable evidence proves nothing", () => {
    /*
    FNXC:ReportsHealth 2026-11-18-15:23 (RUFU-716):
    The direction of this default is the whole safety property: a marker the classifier cannot interpret
    must NOT launder a dead trigger into an explained delivery. `describeHeartbeatDeliverySkip` refuses
    unknown reasons first, so this branch is the second net, not the primary one — and because the copy
    map's type is `Record<HeartbeatTimerSkipReason, string>`, a reason added in `@fusion/core` with no
    copy here stops compiling instead of reaching this default.
    */
    const result = classifyReportHealth({
      ...baseInput,
      state: "active",
      heartbeatAgeMs: agedHeartbeatMs,
      deliverySkip: { reason: "from-the-future" as never, firedAt: "2026-11-18T11:00:00.000Z", fireAgeMs: 90_000 },
    });

    expect(result.bucket).toBe("stale");
    expect(result.cellText).toBe("**stale**");
  });

  it("refuses relief when the fire age itself is not a number", () => {
    const result = classifyReportHealth({
      ...baseInput,
      state: "idle",
      heartbeatAgeMs: agedHeartbeatMs,
      deliverySkip: { reason: "wake-suppressed", firedAt: "2026-11-18T11:00:00.000Z", fireAgeMs: Number.NaN },
    });

    // Still an eligible reason, so relief applies; the age must render as `unknown`, never as `NaNm`.
    expect(result.bucket).toBe("delivery-skipped");
    expect(result.cellText).toContain("timer fired unknown ago");
    expect(result.cellText).not.toContain("NaN");
  });
});
