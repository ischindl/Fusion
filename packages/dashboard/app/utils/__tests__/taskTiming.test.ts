import { describe, it, expect } from "vitest";
import { getActiveRuntimeMs, getWallClockSinceFirstExecutionMs } from "../taskTiming";

describe("taskTiming helpers", () => {
  it("returns persisted plus live segment for in-progress tasks", () => {
    const nowMs = Date.parse("2026-05-15T13:16:00.000Z");
    const runtime = getActiveRuntimeMs(
      {
        column: "in-progress",
        cumulativeActiveMs: 240_000,
        executionStartedAt: "2026-05-15T13:15:00.000Z",
        columnMovedAt: "2026-05-15T13:15:00.000Z",
      },
      nowMs,
    );

    expect(runtime).toBe(300_000);
  });

  it("returns null when there is no active-runtime signal", () => {
    const runtime = getActiveRuntimeMs(
      {
        column: "todo",
        cumulativeActiveMs: undefined,
        executionStartedAt: undefined,
        columnMovedAt: undefined,
      },
      Date.now(),
    );

    expect(runtime).toBeNull();
  });

  it("returns wall-clock runtime since first execution", () => {
    const wallClock = getWallClockSinceFirstExecutionMs(
      "2026-05-15T08:42:00.000Z",
      "2026-05-15T13:17:00.000Z",
      Date.parse("2026-05-15T13:20:00.000Z"),
    );

    expect(wallClock).toBe(16_500_000);
  });
});
