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
