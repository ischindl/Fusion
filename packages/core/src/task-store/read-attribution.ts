/*
FNXC:ReadAttribution 2026-10-21-00:36 (RUFU-756):
The engine's dashboard process dies of its own allocation pressure — measured garbage collection at
15.2% of CPU, rss climbing 5.50→6.42 GB in 90 s on a FRESH process, and the allocations attributed by
a sampling heap profiler to PostgreSQL row parsing (`DataRow` 582 MB, `fromJson` 356 MB, `rowToTask`
117 MB per 120 s). The counters say the driver is read FREQUENCY, not a heavy column: over a 75 s
window `task_workflow_selection` took 46 117 index scans (615 per second) and `tasks` 4 338 (58 per
second), while the only wired timer is the 2-second `workflowContinuationTimer`. So something reads
these tables hundreds of times a second and nobody could say what.

The reason nobody could say what is structural, not effort: neither profiler can name the caller. The
heap profile's chain above `listTasksImpl` is `(root) < processTicksAndRejections < (anon)` and a CPU
profile names only driver frames, because the async boundary erases the JavaScript stack. This module
puts the caller identity where the async boundary cannot reach it — synchronously, at the read seam.

Design rules this module is built to keep:
- **Cheap enough to leave on.** Every call increments a Map counter (no stack). The expensive part,
  `new Error().stack`, runs on 1 in `SAMPLE_EVERY` calls, so at the measured 615 reads/s that is ~19
  stack captures per second instead of 615.
- **Bounded, always.** Caller signatures are the unbounded input here (a stack can name anything), so
  the Map is capped at `MAX_KEYS` and new signatures past the cap are counted into `overflow` rather
  than stored. Telemetry that grows with the board is the same class of bug it is watching.
- **Run-audit carries ids and counts only.** Caller names are code identifiers, not prose an operator
  would have to redact, but they still do not go into the audit row: the row carries a stable hash and
  counts, the full signatures go to the `task-store` log, which is grep-able and already carries paths.
- **Cannot break the read.** Every entry point swallows its own failure. Attribution that can fail a
  board read is worse than no attribution.
*/
/*
FNXC:ReadAttribution 2026-10-21-00:36 (RUFU-756):
`TaskStore` is a type-only import and the logger comes from `process/logger.js` rather than `store.js`,
so this module adds no runtime edge back into the store it instruments — `store.ts` already sits above
the read path, and a value import here would close that into an initialization cycle for a logger.
*/
import { emitBoundedRunAudit } from "../run-audit/emit-bounded-run-audit.js";
import { createLogger } from "../process/logger.js";
import type { TaskStore } from "../store.js";

const attributionLog = createLogger("read-attribution");

/** The read seams that the measured scan storm names. */
export type ReadAttributionSeam = "listTasks" | "workflowSelection";

/** Stack captures per N calls of one seam. 32 keeps the measured worst seam at ~19 captures/s. */
export const READ_ATTRIBUTION_SAMPLE_EVERY = 32;

/*
FNXC:ReadAttribution 2026-10-21-09:22 (RUFU-756):
The first production window proved the volume and disproved the single-frame selector. It reported
`workflowSelection` 148 022 calls in 5 minutes (493 per second, which matches the independently measured
615 PostgreSQL index scans per second on `task_workflow_selection`) and `listTasks` 4 110 (13,7 per
second) — but `distinctCallers` was 1 in both, naming `getTaskWorkflowSelectionAsyncImpl@bin.js:92942`
and `listTasksImpl@bin.js:112287`: the seam's own frames, not their callers. A bundle collapses every
module into `dist/bin.js`, so a path test cannot separate the store's wrapper from the code above it,
and a name list would have to enumerate every wrapper the seam sits under, which differs per backend.
So the signature is a short CHAIN of the first few surviving frames: the caller is visible at a fixed
small depth, no name list is needed, and the chain still distinguishes two call sites that share a
wrapper. Depth is bounded because the signature is a Map key.
*/
export const READ_ATTRIBUTION_STACK_DEPTH = 6;

/*
FNXC:ReadAttribution 2026-10-21-14:45 (RUFU-756):
Depth 3 was not deep enough to name a caller, measured rather than guessed. Production windows report
`workflowSelection` at 426-432 reads/s with the chain ending at the coalescer's own inner async frame:
`getTaskWorkflowSelectionAsyncImpl < _TaskStore.getTaskWorkflowSelectionAsync < (anon)@bin.js:21089`.
Frame three IS the coalescer (its `inFlight` arrow inside `readSelectionWithCoalescing`), so the code
that actually asked for the read sits at frames four and five — `readSelectionWithCoalescing` itself and
whichever resolver variant called it. An earlier attempt to attribute this by reasoning named the wrong
code: the hold-release sweep looked like the driver because it scans 275-693 tasks per pass, but its own
instrumentation reports `batchSelections=0, selections=0`, so it does almost no selection reads at all.
That is why the instrument exists: reasoning about a fan-out this wide picks a plausible caller, not the
real one. Depth costs one bounded Map key per distinct chain and buys the caller two frames later.
*/

/** Window length between emissions. Long enough that one row is not itself board noise. */
export const READ_ATTRIBUTION_WINDOW_MS = 5 * 60_000;

/** Hard cap on distinct caller signatures held in memory. */
export const READ_ATTRIBUTION_MAX_KEYS = 128;
let maxKeys = READ_ATTRIBUTION_MAX_KEYS;

/**
 * Test-only view of the cap, so the bound itself can be proven without manufacturing 128 call sites.
 * Production never calls this; the default is the value above.
 */
export function setReadAttributionCapForTests(cap: number): void {
  maxKeys = cap;
}

interface SeamTally {
  calls: number;
  stackSamples: number;
  overflowCalls: number;
}

const callerCounts = new Map<string, number>();
const seamTally = new Map<ReadAttributionSeam, SeamTally>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Frames that must never be reported as the caller.
 *
 * FNXC:ReadAttribution 2026-10-21-01:05 (RUFU-756): matched by TWO independent signals, because the
 * first version matched on the bare module basename and that silently ate the real caller — the file
 * `read-attribution.test.ts` shares the prefix, so the spec's own `hotSweepCallSite` frame was skipped
 * and the signature became a vitest runner chunk. In a bundled production build the same basename rule
 * would have skipped this module's own frame *and* every caller frame, because both live in
 * `dist/bin.js`, making every signature identical and the whole instrument useless. So: skip node
 * plumbing, skip this module by path in unbundled runs, skip this module's own functions BY NAME (the
 * only signal that survives bundling), and skip the test runner's frames, which are never a real caller.
 */
const INTERNAL_FRAME = /node:internal|node:events|node:async_hooks|[\\/]task-store[\\/]read-attribution\.(ts|js)$/;

/** This module's own frames, identified by function name because a bundle flattens every path. */
const OWN_FRAME = /\b(captureCallerSignature|recordReadCall|tallyFor|armFlushTimer|flushReadAttribution|snapshotReadAttribution)\b/;

/** Test-runner frames: they appear between a spec and its caller and describe vitest, not Fusion. */
const RUNNER_FRAME = /@vitest[\\/]runner|[\\/]chunk-[\w-]+\.js|tinypool/;

/**
 * Reduce one stack line to `functionName@file.ts:123`.
 *
 * The full absolute path is dropped on purpose: it is long, it is machine-specific, and function name
 * plus line is what a reader actually greps. An anonymous frame keeps its file:line, which still
 * separates two different call sites.
 */
function normalizeFrame(line: string): string | null {
  const match = /at\s+(?:(.+?)\s+\()?(.+?):(\d+):\d+\)?\s*$/.exec(line.trim());
  if (!match) return null;
  const rawFile = match[2] ?? "";
  const file = rawFile.split("/").pop() ?? rawFile;
  const fn = (match[1] ?? "").trim() || "(anon)";
  return `${fn}@${file}:${match[3]}`;
}

/**
 * The first `READ_ATTRIBUTION_STACK_DEPTH` frames outside this module's own seam, oldest-first.
 *
 * Frames are selected by identity (not node plumbing, not this module by path or by function name, not
 * the vitest runner) rather than by position, and kept as a chain because a bundle cannot be inspected
 * by path: the store's own wrapper is unavoidably frame one, so a single-frame selector would report
 * the seam to itself. `(unknown)` is a real answer, not a failure: an empty stack happens when V8 omits
 * it, and `(unknown)` counting up is the signal that a caller reached the seam through something that
 * erased the stack too.
 */
function captureCallerSignature(): string {
  const stack = new Error().stack?.split("\n") ?? [];
  const frames: string[] = [];
  for (const line of stack.slice(1)) {
    if (INTERNAL_FRAME.test(line) || OWN_FRAME.test(line) || RUNNER_FRAME.test(line)) continue;
    const frame = normalizeFrame(line);
    if (!frame) continue;
    frames.push(frame);
    if (frames.length >= READ_ATTRIBUTION_STACK_DEPTH) break;
  }
  return frames.length > 0 ? frames.join(" < ") : "(unknown)";
}

function tallyFor(seam: ReadAttributionSeam): SeamTally {
  let tally = seamTally.get(seam);
  if (!tally) {
    tally = { calls: 0, stackSamples: 0, overflowCalls: 0 };
    seamTally.set(seam, tally);
  }
  return tally;
}

/**
 * Record one read through `seam`, attributing a sampled subset to its caller.
 *
 * @param store sink host for the window row; the same TaskStore the read is running on.
 */
export function recordReadCall(store: TaskStore, seam: ReadAttributionSeam): void {
  try {
    const tally = tallyFor(seam);
    tally.calls += 1;
    if (tally.calls % READ_ATTRIBUTION_SAMPLE_EVERY === 0) {
      tally.stackSamples += 1;
      const signature = captureCallerSignature();
      const key = `${seam}\u0000${signature}`;
      const held = callerCounts.get(key);
      if (held !== undefined) {
        callerCounts.set(key, held + 1);
      } else if (callerCounts.size < maxKeys) {
        callerCounts.set(key, 1);
      } else {
        tally.overflowCalls += 1;
      }
    }
    armFlushTimer(store);
  } catch {
    /* attribution must never fail the read it is watching */
  }
}

function armFlushTimer(store: TaskStore): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void flushReadAttribution(store);
  }, READ_ATTRIBUTION_WINDOW_MS);
  // A telemetry timer must not hold the process open on shutdown.
  (flushTimer as unknown as { unref?: () => void }).unref?.();
}

interface CallerWindow {
  signature: string;
  count: number;
}

/** Aggregate the open window per seam, without clearing it. Exported for tests. */
export function snapshotReadAttribution(): Record<ReadAttributionSeam, {
  calls: number;
  stackSamples: number;
  overflowCalls: number;
  distinctCallers: number;
  top: CallerWindow[];
}> {
  const out = {} as ReturnType<typeof snapshotReadAttribution>;
  for (const seam of ["listTasks", "workflowSelection"] as const) {
    const tally = seamTally.get(seam) ?? { calls: 0, stackSamples: 0, overflowCalls: 0 };
    const rows: CallerWindow[] = [];
    for (const [key, count] of callerCounts) {
      if (!key.startsWith(`${seam}\u0000`)) continue;
      rows.push({ signature: key.slice(seam.length + 1), count });
    }
    rows.sort((a, b) => b.count - a.count);
    out[seam] = {
      calls: tally.calls,
      stackSamples: tally.stackSamples,
      overflowCalls: tally.overflowCalls,
      distinctCallers: rows.length,
      top: rows.slice(0, 5),
    };
  }
  return out;
}

/**
 * FNV-1a over the top caller signature.
 *
 * The audit row carries this hash rather than an identifier string, so the row stays in the
 * ids/counts-only shape every other run-audit event keeps, and two windows naming the same caller are
 * still comparable across restarts. The readable form is the log line emitted beside it.
 */
function hashSignature(signature: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Emit one window per seam that saw traffic, then start the window fresh.
 *
 * A seam with zero calls emits nothing — silence means idle here, which is the same convention the
 * other bounded notification events use, so a quiet board does not fill the audit table with zeroes.
 */
export async function flushReadAttribution(store: TaskStore): Promise<void> {
  const snapshot = snapshotReadAttribution();
  callerCounts.clear();
  seamTally.clear();
  for (const seam of ["listTasks", "workflowSelection"] as const) {
    const window = snapshot[seam];
    if (window.calls === 0) continue;
    const top = window.top[0];
    const topSharePct = window.stackSamples > 0 && top
      ? Math.round((top.count / window.stackSamples) * 100)
      : 0;
    attributionLog.log("read attribution window", {
      seam,
      calls: window.calls,
      stackSamples: window.stackSamples,
      distinctCallers: window.distinctCallers,
      overflowCalls: window.overflowCalls,
      top: window.top.map((row) => `${row.count}/${window.stackSamples} ${row.signature}`),
    });
    try {
      await emitBoundedRunAudit(store as never, {
        agentId: "read-attribution",
        runId: `read-attribution:${seam}`,
        domain: "database",
        mutationType: "store:read-attribution-window",
        target: seam,
        metadata: {
          seam,
          windowCalls: window.calls,
          stackSamples: window.stackSamples,
          distinctCallers: window.distinctCallers,
          overflowCalls: window.overflowCalls,
          topCallerHash: top ? hashSignature(top.signature) : "none",
          topCallerCount: top?.count ?? 0,
          topSharePct,
        },
      });
    } catch {
      /* the window is already counted in the log; a hostile sink cannot lose that */
    }
  }
}

/** Test seam: drop all state so one spec cannot leak its counts into the next. */
export function resetReadAttributionForTests(): void {
  maxKeys = READ_ATTRIBUTION_MAX_KEYS;
  callerCounts.clear();
  seamTally.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
}
