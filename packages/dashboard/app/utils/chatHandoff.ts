import { DEFAULT_PROJECT_SETTINGS } from "@fusion/core";

/*
FNXC:ChatHandoff 2026-09-09-20:04:
RUFU-199 client mirror of `ChatManager.getChatHandoffSettings` (packages/dashboard/src/chat.ts).
The affordance is visibility-gated client-side (the POST route enforces the real eligibility and
only the enabled kill switch, never the threshold), so the dashboard reader must resolve the same
pair the server would: `chatHandoffEnabled !== false` (default ON) and a threshold clamped to the
50–95 band with a fallback to the schema default. A bad stored number can therefore neither spam
the button on short chats nor hide it forever, exactly like the server-side reader. The default is
read from DEFAULT_PROJECT_SETTINGS so schema and UI cannot drift; the 50/95 band is the product
policy stated in `chatHandoffThresholdPercent`'s settings-scope doc comment.
*/
export const CHAT_HANDOFF_THRESHOLD_MIN_PCT = 50;
export const CHAT_HANDOFF_THRESHOLD_MAX_PCT = 95;
export const CHAT_HANDOFF_DEFAULT_THRESHOLD_PCT = DEFAULT_PROJECT_SETTINGS.chatHandoffThresholdPercent ?? 75;

export interface ChatHandoffUiSettings {
  enabled: boolean;
  thresholdPercent: number;
}

/** Resolve the raw project settings pair into the {enabled, thresholdPercent} gate the header uses. */
export function resolveChatHandoffUiSettings(
  raw: { chatHandoffEnabled?: boolean; chatHandoffThresholdPercent?: number } | null | undefined,
): ChatHandoffUiSettings {
  const value = raw?.chatHandoffThresholdPercent;
  const thresholdPercent = typeof value === "number" && Number.isFinite(value)
    ? Math.min(CHAT_HANDOFF_THRESHOLD_MAX_PCT, Math.max(CHAT_HANDOFF_THRESHOLD_MIN_PCT, Math.round(value)))
    : CHAT_HANDOFF_DEFAULT_THRESHOLD_PCT;
  return {
    enabled: raw?.chatHandoffEnabled !== false,
    thresholdPercent,
  };
}

/*
FNXC:ChatHandoff 2026-09-09-20:04:
The handoff child's `metadata.handoff` lineage (see ChatHandoffLineage in packages/dashboard/src/chat.ts)
composed by the server in ONE write and never patched. The client parses it defensively because
message metadata is an untyped `Record<string, unknown>` over the wire: a row whose lineage is
missing or malformed must render as an ordinary (raw) system message rather than crash the
transcript, so every field falls back instead of throwing.
*/
export interface ChatHandoffLineageView {
  fromSessionId: string;
  fromTitle: string;
  degraded: boolean;
}

/** Parse a message-metadata object into handoff lineage, or null when the row is not a handoff primer. */
export function parseChatHandoffLineage(metadata: unknown): ChatHandoffLineageView | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const handoff = (metadata as { handoff?: unknown }).handoff;
  if (typeof handoff !== "object" || handoff === null) return null;
  const { fromSessionId, fromTitle, degraded } = handoff as {
    fromSessionId?: unknown;
    fromTitle?: unknown;
    degraded?: unknown;
  };
  if (typeof fromSessionId !== "string" || !fromSessionId) return null;
  return {
    fromSessionId,
    fromTitle: typeof fromTitle === "string" ? fromTitle : "",
    degraded: degraded === true,
  };
}
