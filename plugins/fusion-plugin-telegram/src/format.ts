import { TELEGRAM_CALLBACK_DATA_BYTE_LIMIT, TELEGRAM_TEXT_CHAR_LIMIT, type GroupingMode } from "./settings.js";

/**
 * FNXC:TelegramBridge 2026-11-20-02:49 (RUFU-782):
 * Telegram-side rendering rules for one Fusion event. Three upstream limits decide the shape:
 * `sendMessage` text is capped at 4096 characters, `InlineKeyboardButton.callback_data` is capped at
 * 64 BYTES (so it carries a short opaque id and never JSON), and the send rate is ~1 msg/s/chat.
 * `parse_mode` is HTML, so every Fusion-supplied string is escaped on the way in - a card title with
 * `<` would otherwise corrupt the message or swallow the answer prompt.
 */

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

/** Escapes the three characters that are meaningful inside Telegram HTML. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Plain-text clip with an ellipsis, used before escaping so a cut can never split a tag. */
export function clipText(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (maxChars === 1) return "…";
  return `${value.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Hard ceiling on an already-assembled HTML message. Two artifacts of a naive cut would make Telegram
 * reject the whole message, so both are repaired: a tag left half-open is dropped, and a cut inside an
 * entity (`&amp;` -> `&am`) is dropped too. `capHtml` is the renderer's last guard, which is what makes
 * "a 5000-character question arrives as at most 4096 characters" a property of the renderer rather than
 * of the caller's discipline.
 */
export function capHtml(text: string, limit = TELEGRAM_TEXT_CHAR_LIMIT): string {
  if (text.length <= limit) return text;
  if (limit <= 1) return "…".slice(0, limit);
  let cut = text.slice(0, limit - 1);
  const openTag = cut.lastIndexOf("<");
  const closeTag = cut.lastIndexOf(">");
  if (openTag > closeTag) cut = cut.slice(0, openTag);
  const openEntity = cut.lastIndexOf("&");
  const closedEntity = cut.lastIndexOf(";");
  if (openEntity > closedEntity) cut = cut.slice(0, openEntity);
  return `${cut.trimEnd()}…`;
}

/** Flat-mode breadcrumb: `[project/CARD]`, used only when the chat has no per-project topic. */
export function flatPrefix(projectName: string | undefined, taskLabel: string | undefined): string {
  const project = projectName?.trim() || "project";
  const card = taskLabel?.trim();
  return card ? `[${project}/${card}]` : `[${project}]`;
}

const AWAIT_INPUT_MARKER = "workflow-input:";

/** True when `pausedReason` still carries this node family's marker. */
export function hasAwaitInputMarker(pausedReason: string | undefined): boolean {
  return typeof pausedReason === "string" && new RegExp(`^${AWAIT_INPUT_MARKER}[^:]+:`).test(pausedReason);
}

/**
 * The user-facing question inside a workflow await-input pause.
 *
 * FNXC:TelegramBridge 2026-11-20-02:49 (RUFU-782):
 * `runAwaitInputNode` writes `pausedReason = "workflow-input:<nodeId>@<pauseEpochMs>: <question>"`
 * (packages/engine/src/executor/await-input-node.ts) and the dashboard strips the same prefix with
 * /^workflow-input:[^:]+:/ in `WorkflowResultsTab.tsx`. The plugin mirrors that rule rather than
 * inventing a second one: the question is plain text, never a structured form, so a free-text reply
 * must always be enough and a keyboard is only an extra affordance.
 * Returns undefined when the pause is not a workflow await-input park.
 */
export function extractAwaitInputQuestion(pausedReason: string | undefined): string | undefined {
  if (!pausedReason) return undefined;
  const match = new RegExp(`^${AWAIT_INPUT_MARKER}[^:]+:\\s*(.*)$`, "s").exec(pausedReason);
  if (!match) return undefined;
  return match[1].trim();
}

/**
 * The pause watermark inside a workflow await-input marker, in epoch milliseconds.
 *
 * FNXC:TelegramBridge 2026-11-20-05:33 (RUFU-782 code review, P0):
 * The card's `pausedReason` is the ONLY place the identity of a pause is recorded: `runAwaitInputNode`
 * stamps `workflow-input:<nodeId>@<Date.now()>` fresh on every park, so two parks of the same card are
 * distinguishable by that number even when the question text is identical. The plugin needs it because
 * an operator who answers a question in the DASHBOARD never tells Telegram — the correlation row then
 * stays `open` forever, and a suppression rule that reads only "is there an open row" silences every
 * later question for that card. Comparing the row's own creation time against THIS watermark is what
 * proves a row belongs to the pause being announced right now.
 * Returns undefined for a marker without a watermark, which means the pause cannot be dated.
 */
export function extractAwaitInputPauseEpochMs(pausedReason: string | undefined): number | undefined {
  if (!pausedReason) return undefined;
  const match = new RegExp(`^${AWAIT_INPUT_MARKER}[^:@]+@(\\d+):`).exec(pausedReason);
  if (!match) return undefined;
  const epochMs = Number(match[1]);
  return Number.isFinite(epochMs) ? epochMs : undefined;
}

/** `callback_data` is measured in BYTES by Telegram, not UTF-16 units. */
export function callbackDataFits(data: string): boolean {
  return Buffer.byteLength(data, "utf8") <= TELEGRAM_CALLBACK_DATA_BYTE_LIMIT;
}

/**
 * The one prefix this plugin owns in `callback_data`.
 *
 * FNXC:TelegramBridge 2026-11-20-03:29 (RUFU-782):
 * A tap must say WHICH option was pressed, and Telegram delivers only this string — never the button
 * label — so the option position travels in the payload as `q:<opaqueId>:<index>`. The position is enough
 * because the question row already stores its options in order; encoding the label would put operator-
 * derived text into a 64-byte field and is exactly what the "opaque id, not JSON" rule forbids.
 */
export const CALLBACK_DATA_PREFIX = "q:";

export function callbackDataFor(questionId: string, optionIndex?: number): string {
  return optionIndex === undefined ? `${CALLBACK_DATA_PREFIX}${questionId}` : `${CALLBACK_DATA_PREFIX}${questionId}:${optionIndex}`;
}

export interface ParsedCallbackData {
  questionId: string;
  /** Index into the question row's stored options, or null when the button carried no choice. */
  optionIndex: number | null;
}

/**
 * Strict inverse of `callbackDataFor`. Anything else — a foreign bot's button, a hand-typed payload, a
 * card id someone tried to smuggle in — parses to null and changes nothing.
 */
export function parseCallbackData(data: string): ParsedCallbackData | null {
  const parts = data.split(":");
  if (parts.length < 2 || parts.length > 3 || parts[0] !== "q") return null;
  const [questionId, suffix] = [parts[1], parts[2]];
  // `newQuestionId()` emits exactly 11 base64url characters; a fixed shape is what makes a forged id cheap to reject.
  if (!/^[A-Za-z0-9_-]{11}$/.test(questionId)) return null;
  if (suffix === undefined) return { questionId, optionIndex: null };
  if (!/^[0-9]$/.test(suffix)) return null;
  return { questionId, optionIndex: Number(suffix) };
}

/**
 * One button per answer option, each on its own row. No options means no keyboard at all - a bare
 * "answer this" button would tell the operator nothing that replying does not.
 */
export function buildQuestionKeyboard(questionId: string, options: string[] | undefined): InlineKeyboardMarkup | undefined {
  const rows = (options ?? [])
    .map((option) => option.trim())
    .filter((option) => option.length > 0)
    .slice(0, 10)
    .map((option, index) => [{ text: clipText(option, 64), callback_data: callbackDataFor(questionId, index) }]);
  if (rows.length === 0) return undefined;
  if (!callbackDataFits(callbackDataFor(questionId))) return undefined;
  return { inline_keyboard: rows };
}

/** An answer option list parsed out of a question whose options the workflow inlined as `a | b | c`. */
export function parseInlineOptions(question: string | undefined): string[] {
  if (!question) return [];
  const match = /\(([^()]*)\)\s*$/.exec(question.trim());
  if (!match) return [];
  const parts = match[1]
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length >= 2 ? parts : [];
}

export function dashboardCardUrl(baseUrl: string | undefined, projectId: string, taskId: string | undefined): string | undefined {
  const trimmed = baseUrl?.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;
  const query = new URLSearchParams({ project: projectId });
  if (taskId) query.set("task", taskId);
  return `${trimmed}/?${query.toString()}`;
}

export interface RenderedEventInput {
  event: string;
  /** Displayed in the flat prefix only; absent when the instance never named its projects. */
  projectName?: string;
  groupingMode: GroupingMode;
  taskId?: string;
  taskTitle?: string;
  /** The question to answer, for an await-input pause. */
  question?: string;
  /** Message body for a non-question event. */
  detail?: string;
  options?: string[];
  projectId: string;
  dashboardBaseUrl?: string;
}

const QUESTION_TEXT_BUDGET = 3_000;

/**
 * Renders the whole message.
 *
 * FNXC:TelegramBridge 2026-11-20-02:49 (RUFU-782):
 * The order is deliberate. The question (or the event body) goes LAST so that when `capHtml` trims an
 * over-long message, the part that disappears is the tail of the text and not the instruction telling
 * the operator how to answer, nor the deep link back to the card. Every Fusion-supplied string is
 * escaped on the way in, and the assembled document passes through `capHtml` as the final guard.
 */
export function renderEventMessage(input: RenderedEventInput): string {
  const lines: string[] = [];
  const cardLabel = input.taskId ?? input.taskTitle;

  if (input.groupingMode === "flat") {
    lines.push(escapeHtml(flatPrefix(input.projectName, cardLabel)));
  }

  lines.push(
    input.taskTitle?.trim()
      ? `<b>${escapeHtml(input.taskTitle.trim())}</b> <i>(${escapeHtml(input.event)})</i>`
      : `<b>${escapeHtml(input.event)}</b>`,
  );

  const link = dashboardCardUrl(input.dashboardBaseUrl, input.projectId, input.taskId);
  if (link) lines.push(`<a href="${escapeHtml(link)}">Open in dashboard</a>`);

  const body = input.question ?? input.detail ?? "";
  if (input.question) {
    lines.push(input.options && input.options.length > 0
      ? "<i>Press an option, or reply to this message.</i>"
      : "<i>Answer by replying to this message.</i>");
  }

  if (body) {
    lines.push("");
    lines.push(escapeHtml(clipText(body, QUESTION_TEXT_BUDGET)));
  }

  return capHtml(lines.join("\n"));
}
