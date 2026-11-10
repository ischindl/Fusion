/*
FNXC:AgentTimestampFormat 2026-11-09-13:15 (RUFU-345):
MACHINE- AND AGENT-FACING TIMESTAMPS ARE UTC-ONLY AND RENDER THROUGH THIS ONE HELPER.

Measured on a host with TZ=Europe/Bratislava (UTC+2 in summer): a heartbeat read its own prompt header as
`So 26. september 2026, 00:04 AM UTC` while `date -u` said `2026-09-26T22:04:17Z`. The header value was the
host LOCAL wall clock (+02:00, next calendar day) printed under a literal " UTC" label, while the daemon's
own agent-log rows for the same instants carried truthful `toISOString()` UTC. An agent that trusted the
header inferred a ~4 h gap between two ticks that were ~8 minutes apart, and the same rendering flipped shape
between host locales (`22:04:17` vs `10:04:17 PM`), which is the fingerprint of `Date.toLocaleString()`-class
host-locale formatting rather than a fixed skew.

Requirements this module encodes:
- Never print a host-timezone wall-clock value with a UTC label. The rendered digits are read with
  `getUTC*` accessors, so the value and the " UTC" suffix cannot disagree, and the output is identical
  under every `process.env.TZ` and every `LC_TIME`.
- One shape for every agent-/machine-facing surface (heartbeat prompt, `fn_read_messages`, step-session
  steering comments, executor comment timestamps past the relative window, and the CLI commands agents
  quote in their reports): `YYYY-MM-DD HH:mm:ss UTC`. Lexicographic order equals chronological order, so
  an agent can sort stamps without parsing them.
- It never throws and never falls back to local formatting: an absent or unparseable input renders the
  literal `unknown time`, because a prompt line that silently disappears or prints `Invalid Date` is
  exactly the ambiguity that produced the original misreading.

The deliberate exception is `packages/dashboard`, whose formatter is human-facing and locale-aware by
design (an operator's own dashboard showing their own local time is truthful); it is out of scope here.
*/

/** Rendered shape for a missing or unparseable instant: agent-readable, never `Invalid Date`, never a local fallback. */
export const AGENT_TIMESTAMP_UNKNOWN = "unknown time";

/**
 * Format an instant as `YYYY-MM-DD HH:mm:ss UTC` from UTC components.
 *
 * Accepts a `Date` or anything `new Date()` accepts (ISO string, epoch milliseconds). `null`,
 * `undefined`, and unparseable values render {@link AGENT_TIMESTAMP_UNKNOWN} — a prompt or tool line
 * that contains this helper's output can therefore never carry a fabricated or locale-dependent clock.
 */
export function formatAgentTimestamp(value: Date | string | number | null | undefined): string {
  const date = toInstant(value);
  if (!date) return AGENT_TIMESTAMP_UNKNOWN;
  const year = date.getUTCFullYear();
  const month = pad2(date.getUTCMonth() + 1);
  const day = pad2(date.getUTCDate());
  const hours = pad2(date.getUTCHours());
  const minutes = pad2(date.getUTCMinutes());
  const seconds = pad2(date.getUTCSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} UTC`;
}

/** `null` means "no provable instant": absent, wrong type, or a Date whose time is NaN. */
function toInstant(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "boolean" || typeof value === "object") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
