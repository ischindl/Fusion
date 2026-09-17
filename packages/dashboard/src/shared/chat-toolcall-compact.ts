import type { ChatMessage } from "@fusion/core";

/*
FNXC:ChatFeedCompaction 2026-09-17-15:38:
GET /chat/sessions/:id/messages is the ChatView thread feed. Persisted assistant rows carried the
complete `metadata.toolCalls` bodies — `args` and `result` held whole file writes and command
output — measuring 14-136 KB per message and up to 2.7 MB for one 50-row page (41 % of the worst
session's bytes). Neither surface renders those bodies in the list: `StandardChatSurface` shows a
one-line preview plus status and defers the full payloads behind a `<details>` disclosure, so the
feed now ships identity/status plus a preview and the disclosure lazy-loads the bodies from
GET /chat/sessions/:id/messages/:messageId. Question tool calls (see app/utils/parseQuestionToolCall.ts)
keep their full args because the answer card must stay answerable in-place; their args are schema
text, never file bodies. Compaction never mutates store rows — every touched object is rebuilt.
`compacted`/`preview*`/`hasFullDetails` markers are consumed by the client renderers.
*/

/** Server mirror of the app-side `QUESTION_TOOL_NAMES` list; parity is pinned by test. */
export const COMPACT_QUESTION_TOOL_NAMES = [
  "AskUserQuestion",
  "ask_user",
  "ask_followup_question",
  "request_user_input",
  "elicit",
  "ask_question",
  "fn_ask_question",
] as const;

const COMPACT_QUESTION_TOOL_NAME_SET = new Set(COMPACT_QUESTION_TOOL_NAMES.map((name) => name.toLowerCase()));

/** Case-insensitive check for the interactive question tools (mirrors the app-side QUESTION_TOOL_NAMES parity list). */
export function isQuestionToolName(toolName: string): boolean {
  return COMPACT_QUESTION_TOOL_NAME_SET.has(toolName.toLowerCase());
}

const RESULT_PREVIEW_MAX_CHARS = 120;
const ARG_PREVIEW_MAX_CHARS = 50;

/** Mirrors `formatToolValue` in ToolCallDetails.tsx (the app copy cannot be imported server-side). */
function formatValue(value: unknown): string | null {
  if (value === undefined || value === "") return null;
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function previewValue(value: unknown, maxLength: number): string | null {
  const formatted = formatValue(value);
  if (!formatted) return null;
  return formatted.length <= maxLength ? formatted : `${formatted.slice(0, maxLength)}…`;
}

/** Mirrors `formatToolArgsPreview` in ToolCallDetails.tsx so live and compacted rows preview alike. */
function buildArgsPreview(args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return null;
  return entries.map(([key, value]) => `${key}=${previewValue(value, ARG_PREVIEW_MAX_CHARS) ?? ""}`).join(", ");
}

function compactToolCallEntry(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.compacted === true) return raw;
  const toolName = typeof raw.toolName === "string" ? raw.toolName : "";
  if (toolName && COMPACT_QUESTION_TOOL_NAME_SET.has(toolName.toLowerCase())) return raw;

  const resultPreview = previewValue(raw.result, RESULT_PREVIEW_MAX_CHARS);
  const argsPreview = resultPreview === null ? buildArgsPreview(raw.args) : null;
  const previewText = resultPreview ?? argsPreview;
  const hasFullDetails = formatValue(raw.args) !== null || formatValue(raw.result) !== null;

  const compacted: Record<string, unknown> = {
    toolName,
    status: typeof raw.status === "string" ? raw.status : "completed",
    isError: Boolean(raw.isError),
    compacted: true,
  };
  if (previewText) {
    compacted.previewKind = resultPreview !== null ? "result" : "args";
    compacted.previewText = previewText;
  }
  if (hasFullDetails) compacted.hasFullDetails = true;
  return compacted;
}

/**
 * Rebuilds message rows so `metadata.toolCalls` entries keep identity/status/preview only.
 * Idempotent: already-compacted entries and question tool calls pass through untouched.
 */
export function compactChatMessagesForFeed(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    const metadata = message.metadata;
    if (!metadata || typeof metadata !== "object") return message;
    const toolCalls = (metadata as Record<string, unknown>).toolCalls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return message;
    const compactedToolCalls = toolCalls.map((entry) => (
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? compactToolCallEntry(entry as Record<string, unknown>)
        : entry
    ));
    return { ...message, metadata: { ...(metadata as Record<string, unknown>), toolCalls: compactedToolCalls } };
  });
}
