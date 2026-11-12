import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STUCK_REQUEUE_BACKOFF_BASE_MS,
  STUCK_REQUEUE_BACKOFF_CAP_MS,
  clearAllStuckRequeueCooldownsForTests,
  clearStuckRequeueCooldown,
  getActiveStuckRequeueCooldown,
  isStuckRequeueCoolingDown,
  recordStuckRequeueCooldown,
  setStuckRequeueClockForTests,
  stuckRequeueBackoffMs,
} from "../util/stuck-requeue-cooldown.js";

/*
FNXC:TriageStuckKill 2026-11-11-02:05 (RUFU-562):
The ladder is a primitive with one writer and one probe, so its test drives BOTH ends through the real
functions on a fake clock. The load-bearing assertion is the boundary one: a card must become admissible
exactly at its expiry instant, not a poll later - the whole point of the cooldown is to hand a released
planning slot to a sibling card, and a window that overshoots costs that sibling the overshoot.
*/
describe("stuck-requeue re-admission cooldown (RUFU-562)", () => {
  const T0 = 1_700_000_000_000;
  let fakeNow = T0;

  beforeEach(() => {
    fakeNow = T0;
    setStuckRequeueClockForTests(() => fakeNow);
  });

  afterEach(() => {
    clearAllStuckRequeueCooldownsForTests();
    setStuckRequeueClockForTests();
  });

  describe("backoff ladder", () => {
    it("starts at one minute and doubles per kill up to the ten-minute cap", () => {
      expect(stuckRequeueBackoffMs(1)).toBe(60_000);
      expect(stuckRequeueBackoffMs(2)).toBe(120_000);
      expect(stuckRequeueBackoffMs(3)).toBe(240_000);
      expect(stuckRequeueBackoffMs(4)).toBe(480_000);
      expect(stuckRequeueBackoffMs(5)).toBe(STUCK_REQUEUE_BACKOFF_CAP_MS);
    });

    it("never exceeds the cap, however large the kill count", () => {
      expect(stuckRequeueBackoffMs(6)).toBe(STUCK_REQUEUE_BACKOFF_CAP_MS);
      expect(stuckRequeueBackoffMs(60)).toBe(STUCK_REQUEUE_BACKOFF_CAP_MS);
      expect(stuckRequeueBackoffMs(1000)).toBe(STUCK_REQUEUE_BACKOFF_CAP_MS);
    });

    it("clamps a nonsensical kill count to the base window instead of throwing", () => {
      expect(stuckRequeueBackoffMs(0)).toBe(STUCK_REQUEUE_BACKOFF_BASE_MS);
      expect(stuckRequeueBackoffMs(-3)).toBe(STUCK_REQUEUE_BACKOFF_BASE_MS);
      expect(stuckRequeueBackoffMs(Number.NaN)).toBe(STUCK_REQUEUE_BACKOFF_BASE_MS);
    });
  });

  describe("admission probe", () => {
    it("hides a killed card and admits it again exactly at the expiry instant", () => {
      const record = recordStuckRequeueCooldown("AIWO-150", 1);
      expect(record.untilAtMs).toBe(T0 + 60_000);
      expect(isStuckRequeueCoolingDown("AIWO-150")).toBe(true);

      fakeNow = T0 + 59_999;
      expect(isStuckRequeueCoolingDown("AIWO-150")).toBe(true);

      fakeNow = T0 + 60_000;
      expect(isStuckRequeueCoolingDown("AIWO-150")).toBe(false);
      expect(getActiveStuckRequeueCooldown("AIWO-150")).toBeNull();
    });

    it("admits a card whose recorded window has already elapsed", () => {
      recordStuckRequeueCooldown("AIWO-148", 2);
      fakeNow = T0 + 120_001;

      expect(getActiveStuckRequeueCooldown("AIWO-148")).toBeNull();
      expect(isStuckRequeueCoolingDown("AIWO-148")).toBe(false);
    });

    /*
    FNXC:TriageStuckKill 2026-11-11-02:05 (RUFU-562):
    The cooldown must never spill onto a neighbour. Two cards were killed in the reported episode
    (AIWO-150 and the eligible card waiting behind it), and hiding the waiting one is exactly the
    throughput loss this module exists to remove.
    */
    it("leaves a different task id untouched", () => {
      recordStuckRequeueCooldown("AIWO-150", 3);

      expect(isStuckRequeueCoolingDown("AIWO-148")).toBe(false);
      expect(getActiveStuckRequeueCooldown("AIWO-148")).toBeNull();
    });

    it("re-arms from the newest kill count rather than compounding the old window", () => {
      recordStuckRequeueCooldown("AIWO-150", 1);
      fakeNow = T0 + 30_000;
      const second = recordStuckRequeueCooldown("AIWO-150", 2);

      expect(second.backoffMs).toBe(120_000);
      expect(second.untilAtMs).toBe(T0 + 30_000 + 120_000);
      fakeNow = T0 + 60_000;
      expect(isStuckRequeueCoolingDown("AIWO-150")).toBe(true);
    });

    it("releases a card when the cooldown is cleared explicitly", () => {
      recordStuckRequeueCooldown("AIWO-150", 4);
      expect(isStuckRequeueCoolingDown("AIWO-150")).toBe(true);

      clearStuckRequeueCooldown("AIWO-150");
      expect(isStuckRequeueCoolingDown("AIWO-150")).toBe(false);
    });

    it("creates no timer - the probe is pure arithmetic against the injected clock", () => {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      recordStuckRequeueCooldown("AIWO-150", 1);
      isStuckRequeueCoolingDown("AIWO-150");

      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      setIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    });
  });
});
