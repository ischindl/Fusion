import type { Task } from "@fusion/core";

/*
FNXC:CommentDelivery 2026-09-27-16:40 (RUFU-259):
A wake delta that says "triggering comments: 1" or "Steering comment: …" is a promise that the
woken agent can read the body. Before this module that promise was false from every agent lane:
`fn_task_show` printed ID/Column/Description/Steps/PROMPT.md and nothing else, `fn_task_logs_read`
has no comment row type, the dashboard HTTP API is (correctly) 401 to an agent, and a task worktree
holds no `.fusion/tasks/<ID>/task.json` to read — measured on RUFU-251, where four tool calls proved
the body unreachable while the wake counter kept advancing `comments: 1 -> 2`.

This module is that single read surface: given the ids a wake advertised, return the author,
clock, and text of each one from the card's own two comment lanes. It is read-only by construction
(no store writes, no lifecycle fields touched), so "reading a comment" grants no planning, review,
or release authority, and the comment-to-replan release gate is untouched.

The ids come from BOTH lanes because `addSteeringComment` writes the unified `comments` row first
and then mirrors it into `steeringComments` under the SAME id
(`packages/core/src/task-store/task-artifacts-ops.ts` `addSteeringCommentImpl`), so an id lookup must
search both arrays and must not double-report a steering comment as two entries.
*/

/** One comment body as an agent needs it to acknowledge what woke it. */
export interface TaskCommentEntry {
  /** The id the wake advertised and the agent passes back to `fn_task_show`. */
  id: string;
  /** Which lane the body lives in: a plain comment or an operator steering note. */
  kind: "comment" | "steering";
  author: string;
  createdAt: string;
  text: string;
}

/** Cap on ids resolved per call, so a wake cannot be turned into a bulk comment dump that
 *  displaces the rest of the card's context. */
export const MAX_COMMENT_LOOKUP_IDS = 20;

/** Cap on how many withheld ids the limit notice names, so the notice itself stays bounded. */
const MAX_WITHHELD_IDS_NAMED = 5;

/** Per-body render cap. Comment text is operator-authored, so a long paste is clipped rather
 *  than refused — and the clip is announced inside the rendered line, never silently. */
const MAX_RENDERED_COMMENT_CHARS = 4000;

type CommentCarrier = Pick<Task, "comments" | "steeringComments">;

/**
 * Build a comment-id → body lookup across both lanes of a card.
 *
 * `steeringComments` entries are labelled `steering`; because a steering comment also exists in the
 * unified `comments` array under the same id, the steering label wins and the duplicate unified row
 * is dropped. Entries without an id (legacy rows predating id assignment) are keyed only when an id
 * exists — an unkeyable row is not reachable by any advertised id.
 */
export function collectTaskCommentEntries(task: CommentCarrier | null | undefined): Map<string, TaskCommentEntry> {
  const entries = new Map<string, TaskCommentEntry>();
  for (const comment of task?.comments ?? []) {
    if (!comment?.id) continue;
    entries.set(comment.id, {
      id: comment.id,
      kind: "comment",
      author: comment.author ?? "unknown",
      createdAt: comment.createdAt ?? "unknown",
      text: comment.text ?? "",
    });
  }
  for (const steering of task?.steeringComments ?? []) {
    if (!steering?.id) continue;
    entries.set(steering.id, {
      id: steering.id,
      kind: "steering",
      author: steering.author ?? "user",
      createdAt: steering.createdAt ?? "unknown",
      text: steering.text ?? "",
    });
  }
  return entries;
}

/** Render one entry as an indented bullet block. */
function renderCommentEntry(entry: TaskCommentEntry): string {
  const body = entry.text ?? "";
  const clipped = body.length > MAX_RENDERED_COMMENT_CHARS
    ? `${body.slice(0, MAX_RENDERED_COMMENT_CHARS)}\n  … (body clipped at ${MAX_RENDERED_COMMENT_CHARS} of ${body.length} characters)`
    : body;
  const indented = clipped.split("\n").join("\n  ");
  return `- [${entry.id}] ${entry.kind} by ${entry.author} at ${entry.createdAt}:\n  ${indented}`;
}

/**
 * Render the `Comments:` section for the ids a caller asked for.
 *
 * Returns "" when no ids are requested, so every existing `fn_task_show` caller keeps its current
 * output byte-for-byte and only a wake that advertised ids pays the tokens.
 *
 * Every requested id gets a line: a matched id prints its body, an unmatched id says so and reports
 * how many rows were searched, and ids beyond {@link MAX_COMMENT_LOOKUP_IDS} are named as withheld.
 * The section therefore never lets a count stand without a body or a stated reason there is none —
 * which is the exact inconsistency this task removes.
 */
export function renderTaskCommentSection(
  task: CommentCarrier | null | undefined,
  commentIds: readonly string[] | undefined,
): string {
  const requested = (commentIds ?? []).filter((id) => typeof id === "string" && id.length > 0);
  if (requested.length === 0) return "";

  const entries = collectTaskCommentEntries(task);
  const resolved = requested.slice(0, MAX_COMMENT_LOOKUP_IDS);
  const withheld = requested.slice(MAX_COMMENT_LOOKUP_IDS);

  const lines: string[] = ["Comments:"];
  for (const id of resolved) {
    const entry = entries.get(id);
    if (entry) {
      lines.push(renderCommentEntry(entry));
      continue;
    }
    /*
    FNXC:CommentDelivery 2026-09-27-16:40 (RUFU-259):
    An id the card does not carry is stated as a miss with the searched row counts, rather than
    silently omitted. Omission is what made the RUFU-251 phantom unreadable: the agent could not
    tell "not delivered" from "my lookup was wrong", so it re-tried other surfaces for four calls.
    */
    lines.push(
      `- [${id}] not found on this card (searched ${task?.comments?.length ?? 0} comment(s), ` +
        `${task?.steeringComments?.length ?? 0} steering comment(s))`,
    );
  }
  if (withheld.length > 0) {
    // Name the withheld ids so a caller can ask for them, but cap the naming too — the notice must not
    // become the unbounded dump it exists to report.
    const named = withheld.slice(0, MAX_WITHHELD_IDS_NAMED);
    const unnamed = withheld.length - named.length;
    lines.push(
      `- ${withheld.length} requested id(s) withheld by the ${MAX_COMMENT_LOOKUP_IDS}-id limit: ` +
        `${named.map((id) => `[${id}]`).join(", ")}${unnamed > 0 ? `, +${unnamed} more` : ""} — request them in a separate call`,
    );
  }
  return lines.join("\n");
}

/**
 * Resolve the ids a heartbeat should advertise for a card.
 *
 * A wake delta may only name ids that this module can render bodies for, so the heartbeat derives
 * its advertised ids from the card's own comment lanes instead of from a counter. Returns the
 * requested ids that actually resolve, in request order.
 */
export function resolveAdvertisedCommentIds(
  task: CommentCarrier | null | undefined,
  commentIds: readonly string[] | undefined,
): string[] {
  const entries = collectTaskCommentEntries(task);
  return (commentIds ?? []).filter((id) => typeof id === "string" && entries.has(id));
}
