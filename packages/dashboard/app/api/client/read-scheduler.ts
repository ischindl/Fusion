/*
FNXC:BoardBootstrap 2026-10-02-01:49:
A cold dashboard mount fires ~20 DISTINCT GETs at once (measured in a real browser against the
deployed build: `maxConcurrent=19` at t≈0.9s, and every one of them then took 13–17s —
`GET /tasks/page?limit=100` 14.2s, `GET /tasks/done?limit=50` 14.2s, `GET /agents/stats` 17.2s,
`GET /stash-recovery/orphans` 14.1s, `GET /messages/unread-count` 13.7s). Cards appeared only around
14–19s. The existing `dedupe` helper collapses N callers of the SAME key into one request, so it
cannot help here: this herd is 20 different endpoints, and the dashboard process serves them with a
finite database pool while engine lanes hold connections. In-flight concurrency is therefore the
product, not an implementation detail — flooding it makes the operator's own board wait behind
unread-count badges and mission metadata.

Rule encoded here: GETs are dispatched through a bounded, two-class queue, and the two endpoints the
board cannot paint without are dispatched FIRST. Mutations bypass the queue entirely — a save must
never sit behind a slow read. Background reads may be late; a card that is already on screen must not
be.

The bound is deliberately small: the server is one Node process whose per-request cost is dominated
by JSON/row materialization (~30% of CPU samples: `parse`, `fromJson`, `pgRowToTaskRow`, GC), so
letting more reads overlap does not add throughput, it only lengthens every tail.
*/

/** Concurrent GETs allowed in flight from one dashboard tab. */
export const MAX_CONCURRENT_READS = 4;

/**
 * Endpoints whose response gates the board's first paint. Matching is on the
 * request path with the query string stripped, so a caller adding `projectId`
 * or a cursor cannot silently lose priority.
 */
const CRITICAL_READ_PATHS = [
  "/tasks/page",
  "/tasks/board-workflows",
  "/settings/global",
] as const;

export type ReadPriority = "critical" | "background";

/**
 * Classify one GET. Anything not listed is background: it renders chrome
 * (badges, stats, mission metadata) that the operator can afford to see
 * a moment after the cards.
 */
export function readPriorityClass(path: string): ReadPriority {
  const clean = path.split("?")[0];
  return CRITICAL_READ_PATHS.some((candidate) => clean.endsWith(candidate)) ? "critical" : "background";
}

interface QueueEntry {
  priority: ReadPriority;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const pending: QueueEntry[] = [];
let active = 0;

function takeNext(): QueueEntry | undefined {
  const index = pending.findIndex((entry) => entry.priority === "critical");
  return index >= 0 ? pending.splice(index, 1)[0] : pending.shift();
}

function drain(): void {
  while (active < MAX_CONCURRENT_READS) {
    const entry = takeNext();
    if (!entry) return;
    if (entry.signal) entry.signal.removeEventListener("abort", entry.onAbort!);
    active += 1;
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      active -= 1;
      settle();
      drain();
    };
    // Dispatch synchronously: a slot that is free must be occupied in the same
    // tick, otherwise a burst that mounts 20 reads can leave capacity idle while
    // queued work waits on an extra microtask hop.
    let started: Promise<unknown>;
    try {
      started = Promise.resolve(entry.run());
    } catch (error) {
      finish(() => entry.reject(error));
      continue;
    }
    started.then(
      (value) => finish(() => entry.resolve(value)),
      (error) => finish(() => entry.reject(error)),
    );
  }
}

/**
 * Run a read through the bounded queue. An already-aborted signal never enters
 * the queue, and a signal aborted while queued removes that entry so a
 * cancelled request cannot occupy a slot that was never used.
 */
export function scheduleRead<T>(
  priority: ReadPriority,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error("Aborted before dispatch"));
  }
  return new Promise<T>((resolve, reject) => {
    const entry: QueueEntry = {
      priority,
      run: run as () => Promise<unknown>,
      resolve: resolve as (value: unknown) => void,
      reject,
      signal,
    };
    if (signal) {
      entry.onAbort = () => {
        const index = pending.indexOf(entry);
        if (index >= 0) {
          pending.splice(index, 1);
          reject(signal.reason ?? new Error("Aborted while queued"));
        }
      };
      signal.addEventListener("abort", entry.onAbort, { once: true });
    }
    pending.push(entry);
    drain();
  });
}

/** Test seam: how many reads are dispatched right now. */
export function activeReadCount(): number {
  return active;
}

/** Test seam: how many reads are waiting for a slot. */
export function queuedReadCount(): number {
  return pending.length;
}
