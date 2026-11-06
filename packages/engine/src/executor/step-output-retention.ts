import { registerHostRetentionSource } from "@fusion/core";

/*
FNXC:RetentionCensus 2026-11-06-11:45 (RUFU-871):
This is the second census slice, and the first one is what forced it. After 27 executor collections were
registered, the retained floor still climbed 1.09 GiB → 4.70 GiB in 18 min (+0.2 GiB/min, the historical rate)
while EVERY `executor_*` source stayed at 1–2 entries. The task-keyed maps are therefore not the holder. The
heap-content reading already named the mass: agent step text (individual strings of 100–220 KiB, ~6.7 large
strings per run). This module measures the producer of that text instead of its owners.

Why a producer and not another owner map: the step-output text is built by `output += delta` inside a 1 500-line
step function (`execute-workflow-step.ts`) and released at seven separate `session.dispose()` sites, none of
them a single teardown seam. Plumbing `end()` into all seven would be brittle, and a gauge that silently stops
being released is worse than no gauge. So the lifecycle-derived numbers are made self-healing (stale sweep) and
the volume numbers are monotone counters, which cannot leak and cannot under-report.

Counter sources are registered with `bytesPerEntry: 0` on purpose. The census sums `approxBytes()` into
`fusion_retention_tracked_bytes` and derives `residualBytes = heap - tracked`, so a cumulative counter given a
per-entry weight would inflate coverage and could drive the residual negative — a counter is a rate, not a
retained byte. `entries` still carries it onto `/metrics`, which is the only thing it needs to do.

Contract kept from the registry: every `read()` is O(1) and synchronous. `liveChars` is maintained on add and
end rather than summed across captures, and the stale sweep runs at most once per `SWEEP_INTERVAL_MS`.
*/

/** UTF-16 payload, matching the dashboard census' `STRING_BYTES_PER_CHAR`. */
const STRING_BYTES_PER_CHAR = 2;

/** A capture not touched for this long is treated as lost (an exception path that skipped `end()`). */
const STALE_MS = 15 * 60_000;

/** Minimum spacing between stale sweeps, so the probe stays O(1) per scrape. */
const SWEEP_INTERVAL_MS = 60_000;

interface Capture {
  chars: number;
  lastTouchedAt: number;
}

const openCaptures = new Map<string, Capture>();

let liveChars = 0;
let capturedCharsTotal = 0;
let capturesTotal = 0;
let largestCaptureChars = 0;
let lastSweepAt = 0;
let sourcesRegistered = false;

function sweepStale(now: number): void {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  for (const [key, capture] of openCaptures) {
    if (now - capture.lastTouchedAt > STALE_MS) {
      liveChars -= capture.chars;
      openCaptures.delete(key);
    }
  }
  if (liveChars < 0) liveChars = 0;
}

function ensureRegistered(): void {
  if (sourcesRegistered) return;
  sourcesRegistered = true;
  registerHostRetentionSource({
    id: "step_output_open_captures",
    kind: "output-buffer",
    read: () => {
      sweepStale(Date.now());
      return openCaptures.size;
    },
  });
  registerHostRetentionSource({
    id: "step_output_live_chars",
    kind: "output-buffer",
    read: () => {
      sweepStale(Date.now());
      return liveChars;
    },
    bytesPerEntry: STRING_BYTES_PER_CHAR,
  });
  registerHostRetentionSource({
    id: "step_output_captures_total",
    kind: "counter",
    read: () => capturesTotal,
    bytesPerEntry: 0,
  });
  registerHostRetentionSource({
    id: "step_output_captured_chars_total",
    kind: "counter",
    read: () => capturedCharsTotal,
    bytesPerEntry: 0,
  });
  registerHostRetentionSource({
    id: "step_output_largest_chars",
    kind: "output-buffer",
    read: () => largestCaptureChars,
    bytesPerEntry: 0,
  });
}

/*
FNXC:RetentionCensus 2026-11-06-12:36 (RUFU-871):
Sources are registered eagerly at engine start rather than on the first capture. Lazy registration made the
instrument unobservable on an idle board: 5 min after this deployed, `/metrics` had 27 `executor_*` lines and no
`step_output_*` lines at all, because no workflow step had run — and an absent series is indistinguishable from
"a producer that emits zero", which is the answer an operator needs when deciding whether a lane is starved.
Registering at construction costs one Map insert and makes the counters read 0 from t=0, so the first non-zero
sample is unambiguous evidence of production.
*/
export function registerStepOutputRetentionSources(): void {
  ensureRegistered();
}

/** A live handle on one step's accumulating output text. */
export interface StepOutputGauge {
  /** Called per streamed delta with the delta's character length. O(1). */
  add(chars: number): void;
  /** Stop tracking. Idempotent; safe to call from several terminal sites. */
  end(): void;
}

/**
 * Start tracking one step's accumulated assistant text.
 *
 * `key` must be unique per concurrently-live capture (task + step node is enough in practice); a repeat of the
 * same key re-opens the same slot rather than double counting it.
 */
export function beginStepOutputCapture(key: string): StepOutputGauge {
  ensureRegistered();
  const now = Date.now();
  if (openCaptures.has(key)) {
    const prior = openCaptures.get(key)!;
    liveChars -= prior.chars;
  }
  const capture: Capture = { chars: 0, lastTouchedAt: now };
  openCaptures.set(key, capture);
  capturesTotal += 1;
  if (capture.chars > largestCaptureChars) largestCaptureChars = capture.chars;
  let closed = false;
  return {
    add(chars: number): void {
      if (closed || !Number.isFinite(chars) || chars <= 0) return;
      capture.chars += chars;
      capture.lastTouchedAt = Date.now();
      liveChars += chars;
      capturedCharsTotal += chars;
      if (capture.chars > largestCaptureChars) largestCaptureChars = capture.chars;
    },
    end(): void {
      if (closed) return;
      closed = true;
      liveChars -= capture.chars;
      if (liveChars < 0) liveChars = 0;
      if (openCaptures.get(key) === capture) openCaptures.delete(key);
    },
  };
}

/** Test seam: current numbers without going through `/metrics`. */
export function readStepOutputRetention(): {
  openCaptures: number;
  liveChars: number;
  capturedCharsTotal: number;
  capturesTotal: number;
  largestCaptureChars: number;
} {
  sweepStale(Date.now());
  return {
    openCaptures: openCaptures.size,
    liveChars,
    capturedCharsTotal,
    capturesTotal,
    largestCaptureChars,
  };
}

/** Test seam: forget everything, including the one-time registration guard. */
export function resetStepOutputRetentionForTests(): void {
  openCaptures.clear();
  liveChars = 0;
  capturedCharsTotal = 0;
  capturesTotal = 0;
  largestCaptureChars = 0;
  lastSweepAt = 0;
  sourcesRegistered = false;
}
