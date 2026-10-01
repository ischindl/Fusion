/**
 * Shared chat type definitions used by `useChat` and the
 * `createChatStreamHandlers` factory. Keeping the types here lets the
 * streaming-handler factory live in its own file without re-importing from the
 * hook (which would create an awkward parent→sibling dependency cycle).
 */

export interface ToolCallInfo {
  toolName: string;
  args?: Record<string, unknown>;
  isError: boolean;
  result?: unknown;
  status: "running" | "completed";
  /*
  FNXC:ChatFeedCompaction 2026-09-17-15:38:
  Persisted history rows arrive from GET /chat/sessions/:id/messages with tool-call bodies
  stripped server-side: `compacted` marks such an entry, `previewKind`/`previewText` carry the
  one-line summary the row shows, and `hasFullDetails` says the server still holds a body worth
  expanding. The disclosure lazy-loads the full entry through a surface-provided loader.
  */
  compacted?: boolean;
  previewKind?: "args" | "result";
  previewText?: string;
  hasFullDetails?: boolean;
}

export interface FallbackInfo {
  primaryModel: string;
  fallbackModel: string;
  triggerPoint: "session-creation" | "prompt-time";
}

/*
FNXC:ChatPhaseStatus 2026-09-05-10:23:
RUFU-188: a live engine phase reported on the stream while a reply waits on silent engine-internal
work, surfaced in the streaming placeholder. Exactly one value (`compacting`) exists today; it is a
value union (not `string`) so the placeholder's copy mapping stays exhaustive and an unknown phase
cannot silently render blank. Transient render state only — never a persisted message field. Lives
here so `useChat`, the streaming-handler factory, and the planner tab share one type without a
parent→sibling import cycle.
*/
export type ChatEnginePhase = "compacting";

export interface FailureReferenceInfo {
  kind: string;
  id: string;
  label?: string;
}

export interface FailureInfo {
  summary: string;
  errorClass?: string;
  code?: string;
  detail?: string;
  reference?: FailureReferenceInfo;
}

export interface ChatMessageInfo {
  id: string;
  sessionId: string;
  roomId?: string;
  role: "user" | "assistant" | "system";
  content: string;
  thinkingOutput?: string | null;
  toolCalls?: ToolCallInfo[];
  fallbackInfo?: FallbackInfo;
  failureInfo?: FailureInfo;
  /**
   * FNXC:ChatCancellation 2026-08-19-05:20:
   * Retain server metadata so interrupted-stop reconciliation can distinguish a durable row from an older identical reply.
   */
  metadata?: Record<string, unknown> | null;
  attachments?: Array<{
    id: string;
    filename: string;
    originalName: string;
    mimeType: string;
    size: number;
    createdAt: string;
  }>;
  createdAt: string;
}

/*
FNXC:ChatMessageEdit 2026-09-16-05:58:
FN-459. Single source of truth, shared by the direct Chat (`useChat`/`ChatView`) and the task planner
chat (`TaskPlannerChatTab`), for whether a transcript row identity exists on the SERVER.

Only the dashboard's own purely LOCAL ids are refused, and they are enumerated exhaustively rather
than inferred, because this check gates both the edit affordance and `editMessageAndResend`: an
over-broad rule would silently disable editing for real rows.
  - `temp-<ts>`           — `useChat.sendMessage` optimistic user bubble
  - `optimistic-<ts>`     — `TaskPlannerChatTab.makeOptimisticUserMessage`
  - `error-<ts>`          — `useChat` local failure bubble
  - `interrupted-<ts>`    — `useChat` local interrupted-prefix bubble
  - `streaming-assistant` — `useChat` in-flight assistant placeholder (exact literal, not a prefix)

`msg-` is DELIBERATELY NOT in the refusal list and must never be added: it is the PERSISTED id
format produced by `ChatStore.addMessage` (`msg-<uuid8>`; Rooms use `rmsg-<uuid8>`). Classifying it
as local would disable editing for the entire loaded transcript. The only local `msg-` in the
dashboard is `useChat`'s assistant fallback `msg-${Date.now()}` in `onDone`, which never carries
`role: "user"` and therefore never reaches the edit guard (that guard applies to user rows only).

Any id outside this list — including server ids from other backends and arbitrary fixture ids such
as `"m1"` — is treated as persisted.
*/
const LOCAL_ONLY_CHAT_MESSAGE_ID_PREFIXES = ["temp-", "optimistic-", "error-", "interrupted-"] as const;
const LOCAL_ONLY_CHAT_MESSAGE_IDS = ["streaming-assistant"] as const;

export function isPersistedChatMessageId(id: string): boolean {
  if (!id) return false;
  if ((LOCAL_ONLY_CHAT_MESSAGE_IDS as readonly string[]).includes(id)) return false;
  return !LOCAL_ONLY_CHAT_MESSAGE_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}
