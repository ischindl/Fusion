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
    /*
    FNXC:ReportsHealth 2026-11-20-02:18 (RUFU-783):
    This matrix row used to be reachable from `state` plus an age alone. `stuck` now requires proof that a
    run is actually open, so the row states that proof: the assertion still tests the same bucket it always
    did, and the no-proof shape is asserted as `desynced` in the RUFU-783 block below rather than deleted.
    */
    expect(classifyReportHealth({
      ...baseInput,
      state: "running",
      heartbeatAgeMs: 20_001,
      hasUnclosedRun: true,
      hasAcceptedDone: false,
    }).bucket).toBe("stuck");
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
      /*
      FNXC:ReportsHealth 2026-11-20-02:18 (RUFU-783):
      The proof is stated here because RUFU-783 made `stuck` evidence-driven. What this case is about is
      unchanged — withheld-delivery relief must not reach a running lane — and without an open run it would
      answer a different question ("is there a run?") than the one it was written for.
      */
      hasUnclosedRun: true,
      hasAcceptedDone: false,
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

  /*
  FNXC:HeartbeatTerminalBoundary 2026-11-20-01:25 (RUFU-783):

  `stuck` was DERIVED FROM ABSENCE. The classifier received no run or session evidence at all — only
  `state`, `heartbeatAgeMs`, `heartbeatTimeoutMs`, `staleParkedAssignment`, and the two derived RUFU
  inputs — so `running` plus age past `heartbeatTimeoutMs * 2` was the whole predicate, and the health
  column fed the manager prompt's “lane is stuck, create a follow-up task to investigate.”

  The measured consequence on `agent-3ac88b82` (Audit Executor, cadence 3 600 000 ms, timeout 60 000 ms):
  the run had finished its work and recorded its closing `fn_heartbeat_done` 2.5 minutes earlier, but the
  row was still `active` in the registry because the only closure available to that shape sits after a
  provider prompt that never settled. Age said 3 minutes, the bound said 120 000 ms, so a healthy idle
  lane rendered `**stuck**` and a manager agent was told to open an investigation task. The engine had
  since reaped that same run twice on the cadence (`elapsedMs=1502675`, then `elapsedMs=3600565` against
  `thresholdMs=120000`) — crash recovery being used as the routine closer.

  These cases pin the replacement rule: `stuck` requires POSITIVE evidence — an unclosed run that carries
  no accepted done, or a live session — and an aged `running` row with no such proof falls into a new
  non-actionable `desynced` bucket. `stale` / `stale-assignment` / `healthy` / `delivery-skipped` belong
  to RUFU-530 and RUFU-716 and are unchanged.
  */
  describe("run evidence, not age alone (RUFU-783)", () => {
    const classify = (input: Partial<Parameters<typeof classifyReportHealth>[0]>) =>
      classifyReportHealth({ ...baseInput, ...input });

    /** The reported lane: 3 minutes of age against a 60 000 ms timeout, i.e. past `timeout × 2`. */
    const AGED = { state: "running", heartbeatAgeMs: 180_000, heartbeatTimeoutMs: 60_000 };

    it("keeps a positive-evidence stuck verdict: an unclosed run with no accepted done", () => {
      const result = classify({ ...AGED, hasUnclosedRun: true, hasAcceptedDone: false, hasLiveSession: false });
      expect(result.bucket).toBe("stuck");
      expect(result.cellText).toBe("**stuck**");
    });

    it("keeps a positive-evidence stuck verdict: a live session behind the running row", () => {
      const result = classify({ ...AGED, hasUnclosedRun: false, hasAcceptedDone: false, hasLiveSession: true });
      expect(result.bucket).toBe("stuck");
      expect(result.cellText).toBe("**stuck**");
    });

    it("reports a healthy-but-unclosed done as desynced, never stuck — the false badge itself", () => {
      // The exact reported shape: an unclosed run whose done WAS accepted, so the verdict cannot be stuck.
      const result = classify({ ...AGED, hasUnclosedRun: true, hasAcceptedDone: true, hasLiveSession: false });
      expect(result.bucket).toBe("desynced");
      expect(result.cellText).not.toContain("stuck");
      expect(result.cellText).not.toContain("stale");
      // Bold marks an actionable verdict in this column; a desync is none.
      expect(result.cellText).not.toContain("**");
    });

    it("reports an aged running row with no run evidence at all as desynced, not stuck", () => {
      const result = classify({ ...AGED, hasUnclosedRun: false, hasAcceptedDone: false, hasLiveSession: false });
      expect(result.bucket).toBe("desynced");
      expect(result.cellText).not.toContain("**");
    });

    it("stays healthy below twice the timeout whatever the proof says", () => {
      expect(classify({ ...AGED, heartbeatAgeMs: 1_000, hasUnclosedRun: false, hasAcceptedDone: false }).bucket)
        .toBe("healthy");
      expect(classify({
        ...AGED,
        heartbeatAgeMs: 119_000,
        hasUnclosedRun: true,
        hasAcceptedDone: false,
        hasLiveSession: true,
      }).bucket).toBe("healthy");
    });

    it("does not outrank the verdicts that already won for a running lane", () => {
      // A parked assignment and an operator pause still describe the lane; the new bucket is last.
      expect(classify({ ...AGED, staleParkedAssignment: true }).bucket).toBe("stale-assignment");
      expect(classify({ ...AGED, pauseReason: "error-unrecoverable" }).bucket).toBe("operator-actionable");
      // RUFU-716's relief is gated to active/idle on purpose; a running lane keeps its run verdict.
      expect(classify({
        ...AGED,
        deliverySkip: { reason: "wake-suppressed", firedAt: "2026-11-18T11:00:00.000Z", fireAgeMs: 60_000 },
        hasUnclosedRun: true,
        hasAcceptedDone: false,
      }).bucket).toBe("stuck");
    });

    it("leaves the active/idle stale story untouched — desynced is a running-lane bucket only", () => {
      for (const state of ["active", "idle"] as const) {
        expect(classify({ state, heartbeatAgeMs: 20_001, hasUnclosedRun: false, hasAcceptedDone: false }).bucket)
          .toBe("stale");
      }
    });
  });
});
