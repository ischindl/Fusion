import type { GrokNdjsonEvent } from "./types.js";

/*
FNXC:GrokCli 2026-07-09-00:00:
FN-7722: `grok --prompt <text> --format json` emits newline-delimited JSON
(one JSON object per line) per the verified upstream contract captured in
docs/grok-cli-contract.md (source: src/headless/output.ts's
`createHeadlessJsonlEmitter` / `HeadlessJsonEvent`). This parser mirrors the
Droid plugin's `stream-parser.ts` shape and resilience contract: it never
throws. Debug noise, empty lines, and malformed/unrecognized JSON all return
null so the streaming pipeline can safely skip them and continue.
*/

/*
FNXC:GrokCli 2026-07-09-00:10:
FN-7724: confirmed at execution time — FN-7722 already typed `tool_use` /
`step_finish` / `error` into the `GrokNdjsonEvent` union (types.ts) and this
parser already accepts them via KNOWN_EVENT_TYPES below, so no parser change
was needed to "surface" them; only runtime-adapter.ts's bridge (previously
intentionally dropping tool_use/step_finish/error, see FN-7722 comment
above) needed extending. See docs/grok-cli-contract.md for the verified
schema this parser accepts unmodified.
*/
const KNOWN_EVENT_TYPES = new Set(["step_start", "text", "tool_use", "step_finish", "error"]);

/**
 * Parse a single NDJSON line from `grok --prompt --format json` stdout into a
 * typed event, or null when the line should be skipped (empty, non-JSON
 * debug noise, malformed JSON, or a JSON object whose `type` isn't one of
 * the five verified event types).
 */
export function parseLine(line: string): GrokNdjsonEvent | null {
  const trimmed = line.trim();

  // Skip empty lines
  if (!trimmed) {
    return null;
  }

  // Skip non-JSON lines (e.g. any stray debug/log output not part of the JSONL stream)
  if (!trimmed.startsWith("{")) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    console.error("Failed to parse Grok CLI NDJSON line:", trimmed);
    return null;
  }

  // Validate that the parsed result is a non-null object (not array, not primitive)
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as { type?: unknown };
  if (typeof candidate.type !== "string" || !KNOWN_EVENT_TYPES.has(candidate.type)) {
    return null;
  }

  return parsed as GrokNdjsonEvent;
}
