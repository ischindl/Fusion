import type { Task } from "@fusion/core";
import { deriveTaskLabelDetails } from "./taskTitleDerivation";

export type TaskTitleDisplaySource = "title" | "description" | "id";

export interface TaskTitleDisplay {
  source: TaskTitleDisplaySource;
  text: string;
  fullText: string;
  isBoundedDescription: boolean;
}

/**
 * Budget for the description-derived card label when no title is stored.
 *
 * FNXC:TaskTitleDerivation 2026-09-26-02:28:
 * RUFU-295 keeps the 220-character BUDGET and changes its CONTENT: the label is now
 * `deriveTaskLabelDetails(description, 220)` instead of the first 220 raw characters. A heading-first
 * or multi-line description used to render `## Pôvodný popis` or a whole markdown body as the card
 * label; it now renders the first real sentence, single-line and marker-free. The FN-391 "no suffix,
 * bounded to exactly 220" contract survives because the derivation hard-truncates at EXACTLY the
 * budget when the content offers no whitespace boundary.
 *
 * FNXC:TaskTitleDisplay 2026-09-14-16:55:
 * FN-391 fixes this at 220 characters taken EXACTLY — no ellipsis, no suffix, no word-boundary
 * rounding. The operator contract is "les 220 premiers caractères de la description": a suffix
 * would make the rendered label a different string from the description prefix it claims to be,
 * and it consumed three of the characters it was supposed to show. Visual shortening stays where
 * it belongs — contextual CSS line clamps in the consuming components.
 */
export const MAX_DESCRIPTION_FALLBACK_LENGTH = 220;

/**
 * The minimal task shape this projection reads.
 *
 * FNXC:TaskTitleDisplay 2026-09-14-16:55:
 * Fields are optional so partial rows (search hits, dependency pickers, mention results, agent
 * assignment summaries) can reach the same precedence without being widened to a full `Task`.
 */
export type TaskTitleDisplayInput =
  | Pick<Task, "id" | "title" | "description">
  | { id: string; title?: string | null; description?: string | null };

/**
 * Selects a display-only card label without changing the authoritative task data.
 *
 * FNXC:TaskTitleDisplay 2026-08-19-15:22:
 * FN-044 renders an ordinary titleless FN-036 task from its description only after a nonblank
 * persisted title has been ruled out. This UI seam must not restore an AI length policy or persist
 * a fallback title.
 *
 * FNXC:TaskTitleDisplay 2026-09-14-16:55:
 * FN-391 makes this the ONE projection every task label goes through: card, list row (desktop and
 * mobile), search result, dependency picker, mention result, agent/mission/research/dev-server
 * selectors. Precedence is fixed:
 *   1. a non-blank stored title, rendered IN FULL (never truncated here — an explicit title is the
 *      operator's own words and clamping it belongs to the component's geometry);
 *   2. otherwise the label derived from the description — its first real sentence, markdown-free and
 *      single-line — bounded at {@link MAX_DESCRIPTION_FALLBACK_LENGTH};
 *   3. otherwise the task ID, so two tasks sharing one description are still distinguishable.
 * `fullText` always carries the untruncated description for tooltips; `isBoundedDescription` is true
 * when the rendered label is a derived SUBSET of the description — either the budget cut it, or the
 * derivation dropped markdown structure or later lines the raw description carried. Nothing here is
 * ever persisted.
 */
export function getTaskTitleDisplay(task: TaskTitleDisplayInput): TaskTitleDisplay {
  if (typeof task.title === "string" && task.title.trim().length > 0) {
    return {
      source: "title",
      text: task.title,
      fullText: task.title,
      isBoundedDescription: false,
    };
  }

  if (typeof task.description === "string" && task.description.trim().length > 0) {
    const derivation = deriveTaskLabelDetails(task.description, MAX_DESCRIPTION_FALLBACK_LENGTH);
    return {
      source: "description",
      text: derivation.label,
      fullText: task.description,
      isBoundedDescription: derivation.truncated || derivation.label !== task.description.trim(),
    };
  }

  return {
    source: "id",
    text: task.id,
    fullText: task.id,
    isBoundedDescription: false,
  };
}

/**
 * Convenience label accessor for surfaces that only need the rendered string.
 *
 * FNXC:TaskTitleDisplay 2026-09-14-16:55:
 * Exists so a picker/mention/search row can replace a `task.title || task.description || task.id`
 * expression with one call, instead of destructuring `.text` at a dozen call sites.
 */
export function getTaskTitleDisplayText(task: TaskTitleDisplayInput): string {
  return getTaskTitleDisplay(task).text;
}
