/*
FNXC:ChatSidebarLiveness 2026-09-24-05:55 (RUFU-220):
One liveness classifier for an in-flight chat generation, shared by the engine's reclaim sweep and
the dashboard sidebar tag. The durable claim (`chat_sessions.in_flight_generation`) carries a
status "generating" snapshot with an optional `startedAt`; the engine's
`reconcileStaleInFlightChatGenerations` sweep decides reclaim from exactly one thing — whether that
claim's age against `Date.now()` is provable and older than `CHAT_IN_FLIGHT_GENERATION_STALE_MS`.
Before this module the dashboard rendered none of it, so a row orphaned by a restart (the RUFU-144
zombie family: four rows aged 1-9 days was the motivating observation) looked identical to a live
generation for the whole 30-minute floor.

Why one module: a second age rule on the client would let the tag accuse a claim the sweep is
still holding, or keep a card looking alive after the sweep has decided to reclaim it. The tag is
the visible twin of the sweep, so both read the same floor and the same reference chain.

FNXC:ChatSidebarLiveness 2026-09-24-05:55 (RUFU-220, RN220-A):
Age outranks the client `isGenerating` flag whenever the age is provable. The flag is derived
(`sse.ts` `enrichChatSessionEventPayload`: `isGenerating: inFlight?.status === "generating"`) from
the same stale snapshot it is meant to question, and the REST list path never sets it at all, so
consulting it first would render a dead-owner row as live forever. It is consulted only in the
unprovable-age branch.

FNXC:ChatSidebarLiveness 2026-09-24-05:55 (RUFU-220, RN220-D):
`nowMs` is WALL-CLOCK epoch ms and defaults to `Date.now()` — the same clock family the sweep uses
(`const now = Date.now()`), so the tag and the sweep cannot disagree across a backward clock step,
and every boundary here is drivable by the repo's `vi.useFakeTimers({ toFake: ["Date"] })` idiom.
A monotonic reading (`performance.now()`) belongs to no epoch: it cannot be compared to
`Date.parse(startedAt)` at all, and it is not faked by that idiom.

FNXC:ChatSidebarLiveness 2026-09-24-05:55 (RUFU-220, RN220-C):
This file is a browser-safe leaf: its only import is a type-only import of `chat-types.js`
(erased at build), so it has no value-import dependency graph and no Node builtins — the same
standard `column-roles.ts` and `task-delete-attribution.ts` meet. The dashboard value-imports it
through the `@fusion/core/chat-liveness` subpath because the client's root `@fusion/core` alias
resolves to the types-only `types.ts` leaf and cannot carry a runtime symbol.
*/

import type { ChatInFlightGenerationState } from "./chat-types.js";

/*
FNXC:ChatRemoteGenerationMirror 2026-09-21-11:52:
A dashboard restart mid-generation orphans the durable `in_flight_generation` row: SSE clients
disconnected and the engine never re-broadcasts, so the claim survives with its `startedAt`
untouched and the sidebar would call it live forever. The sweep bounds the lifetime of that
misleading state; this floor IS that boundary — the sidebar tag flips on the same number. Doubling
it here would leave the tag accusing a claim the sweeper is still holding (or vouching for one the
sweeper already gave up on), so the value is declared once, in this file, and the engine imports
it. Do not restate the age rule in the UI or in the engine.

FNXC:ChatSidebarLiveness 2026-09-24-05:55 (RUFU-220):
DECLARATION MOVED here from `packages/engine/src/healing/self-healing-constants.ts`, which now
re-exports this symbol under its existing name. Core owns the number because core is the only
package both the engine sweep and the dashboard can import (core cannot import engine).
*/
export const CHAT_IN_FLIGHT_GENERATION_STALE_MS = 30 * 60_000;

/** The two visible liveness states. A row with no claim to label has no state at all (null). */
export type ChatInFlightLiveness = "generating" | "stale-pending-reclaim";

/** Everything the classifier reads; all three are optional because the two data paths differ. */
export interface ChatLivenessInput {
  /** The durable claim as stored (`chat_sessions.in_flight_generation`). The primary evidence. */
  inFlightGeneration?: ChatInFlightGenerationState | null;
  /**
   * Client-derived flag. NOT authoritative: consulted only when the claim's age cannot be proven,
   * so a stale claim can never be vouched for by its own stale snapshot (RN220-A).
   */
  isGenerating?: boolean;
  /** ISO session `updated_at`, the fallback reference for legacy rows whose claim has no `startedAt`. */
  sessionUpdatedAt?: string | null;
}

/** Classifier verdict — the chosen state plus the evidence that produced it (never re-derived by callers). */
export interface ChatLivenessResult {
  kind: ChatInFlightLiveness;
  /** The timestamp `ageMs` was measured against; null when the age was unprovable. */
  referenceMs: number | null;
  /** `nowMs - referenceMs`; null when the age was unprovable. */
  ageMs: number | null;
}

/** True for the one payload shape the sweep acts on: an object whose status says "generating". */
function isGeneratingClaim(value: unknown): value is ChatInFlightGenerationState {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { status?: unknown }).status === "generating"
  );
}

/**
 * Resolve the timestamp a claim's age is measured against: `startedAt`, else the session's
 * `updated_at` (legacy pre-RUFU-144 rows carry no `startedAt`), else null meaning "age unknown".
 *
 * Unparseable is deliberately null, never "stale": the sweep skips unknown-age claims because it
 * cannot prove staleness, and an unprovable age must never clear a live generation or label one
 * stale. The single owner of this chain — the engine sweep delegates here rather than keeping a
 * private copy, so the tag and the sweeper cannot diverge.
 */
export function chatInFlightReferenceMs(
  inFlight: ChatInFlightGenerationState | null | undefined,
  sessionUpdatedAt?: string | null,
): number | null {
  if (inFlight?.startedAt) {
    const started = Date.parse(inFlight.startedAt);
    if (Number.isFinite(started)) return started;
  }
  if (sessionUpdatedAt) {
    const updated = Date.parse(sessionUpdatedAt);
    if (Number.isFinite(updated)) return updated;
  }
  return null;
}

/**
 * Classify one session's in-flight generation. Returns null when there is nothing to label, so a
 * caller renders no affordance rather than an empty shell.
 *
 * Precedence is the sweep's precedence, in this order:
 * 1. Snapshot gate (identical to the sweep): no claim, non-object, or `status !== "generating"` →
 *    null. `isGenerating` is not consulted here — see RN220-A above.
 * 2. Age unprovable → fall back to the client flag: live if it says so, otherwise nothing.
 * 3. Future-dated claim (`ageMs < 0`, clock skew) → generating. Sweep parity: a negative age
 *    satisfies its floor skip, so the sweeper would not act and the tag must not accuse.
 * 4. `ageMs > CHAT_IN_FLIGHT_GENERATION_STALE_MS` → stale-pending-reclaim, else generating. Age
 *    alone decides this branch; a truthy `isGenerating` never overrides it (RN220-A).
 *
 * `nowMs` is wall-clock epoch ms (see the RN220-D block above); the default is `Date.now()`.
 */
export function classifyChatInFlightLiveness(
  input: ChatLivenessInput,
  nowMs: number = Date.now(),
): ChatLivenessResult | null {
  const claim = input.inFlightGeneration;
  if (!isGeneratingClaim(claim)) return null;

  const referenceMs = chatInFlightReferenceMs(claim, input.sessionUpdatedAt);
  if (referenceMs === null) {
    if (input.isGenerating !== true) return null;
    return { kind: "generating", referenceMs: null, ageMs: null };
  }

  const ageMs = nowMs - referenceMs;
  const kind: ChatInFlightLiveness =
    ageMs >= 0 && ageMs > CHAT_IN_FLIGHT_GENERATION_STALE_MS ? "stale-pending-reclaim" : "generating";
  return { kind, referenceMs, ageMs };
}
