import type { ChatMessage } from "@fusion/core";
import { isQuestionToolName } from "./chat-toolcall-compact.js";

/*
FNXC:ChatQuestionAnswerLink 2026-09-23-13:59:
RUFU-258 durable question-answer linkage. `fn_ask_question` and its sibling question tools use an
await-input contract — the tool result tells the model "the answer arrives as the user's next chat
message" — so the operator message that follows an awaiting question row IS the answer. Until this
change that bond existed only at render time: each surface re-guessed the answer positionally
(`findSubmittedQuestionAnswer` / the planner `> Q:` containment heuristic), so a reload could label
an unrelated later request as a card's "Submitted answer", and a plain-text planner reply was never
recognised at all.

The contract this module encodes:
- The dashboard chat server is the SINGLE writer. When `ChatManager.sendMessage` persists an
  operator-originated user row whose transcript tail is an awaiting question row, it stamps
  `metadata.questionAnswer = { questionMessageId }` on that user row. The value is a row id read
  from the store, never client input, so a client cannot fabricate a link.
- Granularity is the assistant ROW, not the tool call: every question card rendered from that row
  resolves to the same answer id, which matches how both surfaces key their cards per row.
- System-originated sends (`userMessageMetadata.reason` such as `restart-recovery`, or
  `autoRetry: true`) are never stamped — they are not operator answers.
- Excluded by design: CLI-agent-backed chat (`cliExecutorAdapterId` + runner persists the row before
  the model loop), the room/messaging responder (no operator question cards), and task-execution
  await-input cards (engine agent-log persistence, read-only render).
- Message edit-and-resend needs no special case: `prepareReplacement` rewinds the transcript, then
  re-enters `sendMessage`, so the tail check re-evaluates the post-rewind transcript and re-stamps.
- Pre-feature rows carry no link and keep the legacy positional display; nothing is migrated.
*/

/** Metadata key holding the durable link on a persisted user row. */
export const QUESTION_ANSWER_METADATA_KEY = "questionAnswer";

/**
 * Durable link shape stamped on the answer row. Row-level granularity: one question assistant row
 * (which may hold several question tool calls) is the unit a reply answers.
 */
export interface QuestionAnswerLink {
  questionMessageId: string;
}

/*
FNXC:ChatQuestionAnswerLink 2026-09-23-13:59:
The stamp only ever needs the newest row, but the read stays bounded rather than `limit: 1` so a
future rule that has to look past an in-flight/system row (e.g. an assistant row persisted after
the answer) does not need a wider store seam. Descending order keeps the read O(limit) regardless
of session length — a whole-history read on the send path would be a latency regression on the
hottest chat call.
*/
export const QUESTION_ANSWER_TAIL_LIMIT = 5;

/** A persisted question tool call that is still waiting for operator input. */
function isAwaitingQuestionToolCall(raw: Record<string, unknown>): boolean {
  const toolName = typeof raw.toolName === "string" ? raw.toolName : "";
  if (!toolName || !isQuestionToolName(toolName)) return false;
  if (raw.isError === true) return false;
  const status = typeof raw.status === "string" ? raw.status.toLowerCase() : "";
  return status !== "failed" && status !== "error";
}

/** The `metadata.toolCalls` entries of a persisted assistant row (defensive: anything else yields []). */
function toolCallEntries(metadata: unknown): Record<string, unknown>[] {
  const container = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : null;
  const raw = container?.toolCalls;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is Record<string, unknown> =>
    Boolean(entry) && typeof entry === "object" && !Array.isArray(entry));
}

/**
 * The id of the assistant row whose question is awaiting an answer, or `null` when the transcript
 * tail is not an awaiting question.
 *
 * `tail` is chronological (oldest → newest), so the awaiting candidate is the LAST element: the
 * await-input contract means only the most recent turn can be waiting. A tail that ends on a user
 * row, on an assistant row without question tool calls, or on a row whose only question call errored
 * never receives a stamp.
 */
export function findAwaitingQuestionMessageId(tail: readonly ChatMessage[]): string | null {
  const last = tail[tail.length - 1];
  if (!last || last.role !== "assistant") return null;
  return toolCallEntries(last.metadata).some(isAwaitingQuestionToolCall) ? last.id : null;
}

/**
 * Read the durable link off any row's metadata. Malformed payloads (`questionAnswer` not an object,
 * `questionMessageId` not a non-empty string) are treated as no link rather than trusted, because
 * metadata is a JSONB blob that older or foreign writers may shape differently.
 */
export function readQuestionAnswerLink(metadata: unknown): string | null {
  const container = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : null;
  const link = container?.[QUESTION_ANSWER_METADATA_KEY];
  if (!link || typeof link !== "object" || Array.isArray(link)) return null;
  const questionMessageId = (link as Record<string, unknown>).questionMessageId;
  return typeof questionMessageId === "string" && questionMessageId.trim().length > 0 ? questionMessageId : null;
}

/**
 * Merge the link into a row's metadata without dropping coexisting keys (`mentions`,
 * `userMessageMetadata` passthroughs, etc.) — the callers spread several sources into one object, so
 * a replacing write would silently delete a sibling key.
 */
export function withQuestionAnswerLink(
  metadata: Record<string, unknown> | null | undefined,
  questionMessageId: string,
): Record<string, unknown> {
  const base = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
  return { ...base, [QUESTION_ANSWER_METADATA_KEY]: { questionMessageId } satisfies QuestionAnswerLink };
}
