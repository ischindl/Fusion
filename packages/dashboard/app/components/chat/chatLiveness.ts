import type { TFunction } from "i18next";
import { CHAT_IN_FLIGHT_GENERATION_STALE_MS, classifyChatInFlightLiveness } from "@fusion/core/chat-liveness";
import type { ChatInFlightLiveness } from "@fusion/core/chat-liveness";
import type { ChatSessionInfo } from "../../hooks/useChat";

/*
FNXC:ChatSidebarLiveness 2026-09-24-05:55 (RUFU-220):
The sidebar previously exposed no signal for an in-flight generation, so a row whose server-side
claim belonged to a dead process looked exactly like a live one — "still streaming" was inferred
from silence, and the only truth was in the engine's reclaim sweep. This module is the single
dashboard-side classifier: it projects core's `classifyChatInFlightLiveness` (the very function the
sweep delegates to) onto a sidebar row, so the label and the reclaim decision are one computation
over one shared floor rather than two rules that can drift.

Value-importing the classifier through the `@fusion/core/chat-liveness` subpath is deliberate: the
broad `@fusion/core` alias in vite/vitest points at a single file, so a value import from the
package root would not resolve in the browser build (RN220-C).
*/

/**
 * The session fields the classifier reads, narrowed to what every source actually provides: the
 * REST list (async-chat-store's `rowToSession`), the SSE enrichment path
 * (`enrichChatSessionEventPayload`) and the optimistic client row all carry these three.
 */
export type ChatSessionLivenessSource = Pick<
  ChatSessionInfo,
  "inFlightGeneration" | "isGenerating" | "updatedAt"
>;

export interface ChatSessionLiveness {
  /** Which of the two visible states to render. */
  kind: ChatInFlightLiveness;
  /** The claim's age in ms, or null when no timestamp parses — surfaced so the evidence travels with the label. */
  ageMs: number | null;
  /** Plain sentence naming the state plus the recovery window read from core's shared constant. */
  title: string;
}

/** Registered copy for the two visible states and the tooltip sentence (RUFU-220). */
export const CHAT_LIVENESS_I18N_KEYS = {
  generating: "chat.generating",
  stale: "chat.generationStale",
  title: "chat.generationLivenessTitle",
} as const;

/** English copy, kept next to the keys so a missing catalogue entry degrades to real text, never a raw key. */
const LIVENESS_COPY = {
  generating: "Generating",
  stale: "Stale — waiting for reclaim",
  title: "{{label}} — reclaimed after {{minutes}} minutes without progress",
} as const;

function interpolate(text: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (out, [name, value]) => out.split(`{{${name}}}`).join(String(value)),
    text,
  );
}

/**
 * The label for one liveness state.
 *
 * A two-case lookup rather than a dynamic key so an unexpected kind surfaces as an error instead
 * of rendering a raw `chat.*` string in the sidebar.
 */
export function chatLivenessLabel(kind: ChatInFlightLiveness, t?: TFunction<"app">): string {
  if (kind === "stale-pending-reclaim") return t ? t(CHAT_LIVENESS_I18N_KEYS.stale, LIVENESS_COPY.stale) : LIVENESS_COPY.stale;
  if (kind === "generating") return t ? t(CHAT_LIVENESS_I18N_KEYS.generating, LIVENESS_COPY.generating) : LIVENESS_COPY.generating;
  throw new Error(`Unknown chat liveness kind: ${String(kind)}`);
}

/**
 * Decide whether a sidebar row shows a liveness state at all, and which one.
 *
 * Returns `null` — render nothing, the pre-existing behaviour — when the row carries no in-flight
 * claim, or when the claim's age cannot be proven and the client does not report a live
 * generation. An unprovable age is never allowed to become an accusation, and a session that
 * simply has no claim is not "stale".
 */
export function chatSessionLiveness(
  session: ChatSessionLivenessSource,
  nowMs: number = Date.now(),
  t?: TFunction<"app">,
): ChatSessionLiveness | null {
  const result = classifyChatInFlightLiveness(
    {
      inFlightGeneration: session.inFlightGeneration,
      isGenerating: session.isGenerating,
      sessionUpdatedAt: session.updatedAt,
    },
    nowMs,
  );
  if (!result) return null;

  const label = chatLivenessLabel(result.kind, t);
  return {
    kind: result.kind,
    ageMs: result.ageMs,
    // The window comes from core's shared constant, never a literal, so the sentence can never
    // promise a different recovery window than the sweeper actually applies.
    title: t
      ? t(CHAT_LIVENESS_I18N_KEYS.title, LIVENESS_COPY.title, {
          label,
          minutes: Math.round(CHAT_IN_FLIGHT_GENERATION_STALE_MS / 60_000),
        })
      : interpolate(LIVENESS_COPY.title, {
          label,
          minutes: Math.round(CHAT_IN_FLIGHT_GENERATION_STALE_MS / 60_000),
        }),
  };
}
