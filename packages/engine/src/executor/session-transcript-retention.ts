/*
FNXC:SessionTranscriptMetering 2026-11-06-22:45 (RUFU-871):
The retention census reported ~3.4 kB of a 5.9 GiB dashboard heap (coverage 0.000) while GEDA cards were
executing, and the reason is a defect in this instrument rather than in the process: a source registered
without an explicit `bytesPerEntry` is priced at `HOST_RETENTION_ENTRY_OVERHEAD_BYTES` (96). Two live
executor sessions therefore reported 192 bytes even though each holds its full conversation array
(`session.state.messages`) — the exact class of object the operator asked about ("why do we keep the whole
LLM history in RAM when it is already persisted?"). Entry counts cannot answer that question; only measured
content bytes can.

So this module measures the transcript payload directly and publishes it as a counter source
(`bytesPerEntry: 0`, because the value IS the byte figure and must not be multiplied by entry overhead — the
same rule `step-output-retention.ts` established for cumulative counters).

Two properties the measurement must keep:
1. It is bounded. The sampler runs inside the diagnosed process, so an unbounded walk over a large
   transcript would itself become allocation churn and heap pressure. Session, message and block counts are
   capped, and a capped scan reports `truncated: true` rather than an exact figure it did not compute.
2. It never throws and never reads secrets into a log line. The census is numbers-only by contract; this
   returns a count, never content.
*/

/** Sessions scanned per sample; beyond this the byte figure is a floor, not a total. */
export const TRANSCRIPT_SCAN_MAX_SESSIONS = 32;
/** Messages scanned per session (a 24-day executor loop can carry far more). */
export const TRANSCRIPT_SCAN_MAX_MESSAGES = 2_000;
/** Text blocks scanned per message. */
export const TRANSCRIPT_SCAN_MAX_BLOCKS = 64;
/** Non-string payload (an object/array block) is priced at this floor rather than guessed deeply. */
export const MESSAGE_OBJECT_FLOOR_BYTES = 64;

/** True when a scan hit one of its caps, so the reported bytes are a floor. */
let transcriptScanTruncated = false;

function blockBytes(value: unknown, budget: { left: number }): number {
  if (budget.left <= 0) {
    transcriptScanTruncated = true;
    return 0;
  }
  if (typeof value === "string") {
    budget.left -= 1;
    return value.length;
  }
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value.slice(0, TRANSCRIPT_SCAN_MAX_BLOCKS)) {
      if (budget.left <= 0) {
        transcriptScanTruncated = true;
        break;
      }
      total += blockBytes(item, budget);
    }
    return total;
  }
  if (value && typeof value === "object") {
    budget.left -= 1;
    const record = value as Record<string, unknown>;
    // Text-carrying shapes: a content block's `text`, a tool result's `output`/`content`, an
    // image's `data` (base64 is bytes-equivalent for heap purposes).
    let total = MESSAGE_OBJECT_FLOOR_BYTES;
    for (const key of ["text", "content", "output", "data", "result", "delta"]) {
      const field = record[key];
      if (typeof field === "string") total += field.length;
      else if (Array.isArray(field) || (field && typeof field === "object")) total += blockBytes(field, budget);
    }
    return total;
  }
  return 0;
}

function messagesOf(session: unknown): unknown[] | undefined {
  const holder = session as { state?: { messages?: unknown }; messages?: unknown } | null | undefined;
  const candidate = holder?.state?.messages ?? holder?.messages;
  return Array.isArray(candidate) ? candidate : undefined;
}

/**
 * Character-equivalent bytes of a session's retained conversation. A capped scan sets
 * `transcriptScanTruncated`, so callers can tell a floor from a total.
 */
export function measureSessionTranscriptBytes(session: unknown): number {
  const messages = messagesOf(session);
  if (!messages) return 0;
  if (messages.length > TRANSCRIPT_SCAN_MAX_MESSAGES) transcriptScanTruncated = true;
  const budget = { left: TRANSCRIPT_SCAN_MAX_MESSAGES };
  let total = 0;
  for (const message of messages.slice(0, TRANSCRIPT_SCAN_MAX_MESSAGES)) total += blockBytes(message, budget);
  return total;
}

/** Message count held by a session (0 when the shape is not a session at all). */
export function measureSessionTranscriptMessages(session: unknown): number {
  return messagesOf(session)?.length ?? 0;
}

function sumOver(sessions: () => Iterable<unknown>, measure: (session: unknown) => number): number {
  transcriptScanTruncated = false;
  let total = 0;
  let seen = 0;
  try {
    for (const entry of sessions()) {
      if (seen >= TRANSCRIPT_SCAN_MAX_SESSIONS) {
        transcriptScanTruncated = true;
        break;
      }
      seen += 1;
      // An executor entry wraps the session; a step-session map holds it directly.
      const session = (entry as { session?: unknown } | null)?.session ?? entry;
      total += measure(session);
    }
  } catch {
    // The census must never be the thing that breaks a running executor.
    return total;
  }
  return total;
}

/**
 * Byte figure of every conversation array held by the given live sessions. Numbers-only, never throws.
 */
export function measureTranscriptBytes(sessions: () => Iterable<unknown>): number {
  return sumOver(sessions, measureSessionTranscriptBytes);
}

/** Message count across the given live sessions. */
export function measureTranscriptMessages(sessions: () => Iterable<unknown>): number {
  return sumOver(sessions, measureSessionTranscriptMessages);
}

/** True when the most recent scan hit a cap, so the published byte figure is a floor. */
export function transcriptScanWasTruncated(): boolean {
  return transcriptScanTruncated;
}

/*
FNXC:SessionTranscriptMetering 2026-11-06-22:52 (RUFU-871):
Per-instance collectors, aggregated.

The executor's other 27 census sources are registered ONCE, from whichever `TaskExecutor` constructed first
(`retentionSourcesRegistered`), so on a dashboard hosting several projects they price one project's maps and
report another project's live sessions as absent. That is why `executor_active_sessions` read 1–2 entries
while GEDA was executing under a different project instance.

Transcripts therefore publish through a registry every instance joins, and the published figure is the
aggregate. An array (not a Map/Set) is deliberate: the retention-coverage ratchet audits module-scope
Map/Set declarations, and this is a bounded bookkeeping list of long-lived instances, one entry per project.
*/
export const MAX_TRANSCRIPT_COLLECTORS = 16;

const transcriptCollectors: Array<() => { bytes: number; messages: number }> = [];
let transcriptCollectorsRefused = 0;

/** Joins one executor instance's live sessions to the published transcript figures. Idempotent per caller. */
export function registerTranscriptCollector(
  collect: () => { bytes: number; messages: number },
): boolean {
  if (transcriptCollectors.length >= MAX_TRANSCRIPT_COLLECTORS) {
    transcriptCollectorsRefused += 1;
    return false;
  }
  transcriptCollectors.push(collect);
  return true;
}

/** Aggregate retained transcript bytes across every registered executor instance. */
export function registeredTranscriptBytes(): number {
  let total = 0;
  for (const collect of transcriptCollectors) {
    try {
      total += collect().bytes;
    } catch {
      /* never break the sampler */
    }
  }
  return total;
}

/** Aggregate retained message count across every registered executor instance. */
export function registeredTranscriptMessages(): number {
  let total = 0;
  for (const collect of transcriptCollectors) {
    try {
      total += collect().messages;
    } catch {
      /* never break the sampler */
    }
  }
  return total;
}

/** Instances the registry refused to take (it is bounded, and a refused instance is invisible on /metrics). */
export function transcriptCollectorsRefusedCount(): number {
  return transcriptCollectorsRefused;
}

/** Test seam: forget registered collectors so one test's instances do not leak into the next. */
export function resetTranscriptCollectorsForTests(): void {
  transcriptCollectors.length = 0;
  transcriptCollectorsRefused = 0;
}

