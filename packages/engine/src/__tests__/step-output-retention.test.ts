import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listHostRetentionSources, resetHostRetentionRegistryForTests } from "@fusion/core";
import {
  beginStepOutputCapture,
  readStepOutputRetention,
  resetStepOutputRetentionForTests,
} from "../executor/step-output-retention.js";

/*
FNXC:RetentionCensus 2026-11-06-11:45 (RUFU-871):
The first census slice falsified the map-holder hypothesis — 27 registered collections sat at 1–2 entries while
the retained floor grew 1.09 → 4.70 GiB in 18 min. This is the second slice: the producer of the step-output
text the heap content named. The properties that make it trustworthy are exactly the ones a gauge that reports
into a production metric needs — it must never over-report retention, never leak a slot when `end()` is skipped,
and must never let a cumulative counter masquerade as a retained byte.
*/
function source(id: string) {
  const hit = listHostRetentionSources().find((s) => s.id === id);
  if (!hit) throw new Error(`retention source "${id}" missing`);
  return hit;
}

describe("step output retention gauge", () => {
  beforeEach(() => {
    resetStepOutputRetentionForTests();
    resetHostRetentionRegistryForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers its sources on first use and reports live characters as bytes", () => {
    const gauge = beginStepOutputCapture("RUFU-1:parse");
    expect(source("step_output_open_captures").entries()).toBe(1);
    expect(source("step_output_live_chars").entries()).toBe(0);

    gauge.add(500);
    expect(source("step_output_live_chars").entries()).toBe(500);
    expect(source("step_output_live_chars").approxBytes()).toBe(1000);
  });

  // Over-reporting retention would manufacture a leak in the operator's own dashboard.
  it("drops live chars on end() and keeps the cumulative counters", () => {
    const gauge = beginStepOutputCapture("RUFU-2:parse");
    gauge.add(1000);
    gauge.end();
    const state = readStepOutputRetention();
    expect(state.liveChars).toBe(0);
    expect(state.openCaptures).toBe(0);
    expect(state.capturedCharsTotal).toBe(1000);
    expect(source("step_output_live_chars").approxBytes()).toBe(0);
  });

  it("keeps end() idempotent across the six terminal sites", () => {
    const gauge = beginStepOutputCapture("RUFU-3:review");
    gauge.add(250);
    gauge.end();
    gauge.end();
    gauge.add(999);
    const state = readStepOutputRetention();
    expect(state.liveChars).toBe(0);
    expect(state.capturedCharsTotal).toBe(250);
  });

  it("re-opens one key without double counting it", () => {
    const first = beginStepOutputCapture("RUFU-4:plan");
    first.add(700);
    const second = beginStepOutputCapture("RUFU-4:plan");
    second.add(300);
    const state = readStepOutputRetention();
    expect(state.openCaptures).toBe(1);
    expect(state.liveChars).toBe(300);
    second.end();
    expect(readStepOutputRetention().liveChars).toBe(0);
  });

  // Thrown paths reach neither the dispose site nor the flag site; the sweep is what keeps that from becoming
  // a permanently inflated live line.
  it("sweeps a capture whose end() never ran", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-06T11:45:00Z"));
    const gauge = beginStepOutputCapture("RUFU-5:execute");
    gauge.add(4096);
    expect(readStepOutputRetention().liveChars).toBe(4096);

    // A touched-but-idle capture is still live, so a short gap must not sweep it.
    vi.advanceTimersByTime(65_000);
    expect(readStepOutputRetention().liveChars).toBe(4096);

    vi.advanceTimersByTime(20 * 60_000);
    const state = readStepOutputRetention();
    expect(state.openCaptures).toBe(0);
    expect(state.liveChars).toBe(0);
    // Volume is history, not retention: the counter survives the sweep of the gauge.
    expect(state.capturedCharsTotal).toBe(4096);
  });

  it("tracks the largest single capture, which is the shape the snapshots showed", () => {
    const small = beginStepOutputCapture("RUFU-6:a");
    small.add(120);
    small.end();
    const big = beginStepOutputCapture("RUFU-6:b");
    big.add(220_000);
    expect(readStepOutputRetention().largestCaptureChars).toBe(220_000);
  });

  // The census sums approxBytes() into tracked_bytes and derives residual = heap - tracked. A weighted counter
  // would therefore inflate coverage without limit and could push the residual negative.
  it("contributes zero retained bytes for its counter sources", () => {
    const gauge = beginStepOutputCapture("RUFU-7:step");
    gauge.add(50_000);
    gauge.end();
    expect(source("step_output_captured_chars_total").entries()).toBe(50_000);
    expect(source("step_output_captured_chars_total").approxBytes()).toBe(0);
    expect(source("step_output_captures_total").approxBytes()).toBe(0);
    expect(source("step_output_largest_chars").approxBytes()).toBe(0);
  });

  it("ignores nonsense delta sizes instead of poisoning the metric", () => {
    const gauge = beginStepOutputCapture("RUFU-8:step");
    gauge.add(Number.NaN);
    gauge.add(-5);
    gauge.add(0);
    expect(readStepOutputRetention().liveChars).toBe(0);
    gauge.add(10);
    expect(readStepOutputRetention().liveChars).toBe(10);
  });
});
