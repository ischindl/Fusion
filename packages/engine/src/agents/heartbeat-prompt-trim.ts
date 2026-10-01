import type { HeartbeatPromptTemplate } from "@fusion/core";

const TASK_DESC_CAP: Record<HeartbeatPromptTemplate, number> = {
  default: 800,
  compact: 400,
};
const PROMPT_MD_CAP: Record<HeartbeatPromptTemplate, number> = {
  default: 4000,
  compact: 1500,
};
const TASK_TRUNCATION_MARKER = "… (truncated, use fn_task_show for full)";
const COMMENTS_TRUNCATION_MARKER = "… (older comments hidden, fetch via fn_task_show)";

/*
FNXC:CommentDelivery 2026-09-27-17:20 (RUFU-259):
"fetch via fn_task_show" was not an instruction the agent could follow: `fn_task_show` takes comment
IDS, and a marker that hides the ids leaves the agent with an affordance and no argument for it. When
the trimmer drops comment bodies it must therefore name the ids it dropped, bounded to the ids that
were actually advertised by this wake — the honest form of "go fetch it".
*/
const MAX_TRIM_MARKER_IDS = 5;

export function buildCommentsTruncationMarker(commentIds?: readonly string[]): string {
  const ids = (commentIds ?? []).filter((id) => typeof id === "string" && id.length > 0).slice(0, MAX_TRIM_MARKER_IDS);
  if (ids.length === 0) {
    return COMMENTS_TRUNCATION_MARKER;
  }
  /*
  FNXC:CommentDelivery 2026-09-27-18:50 (RUFU-259):
  The overflow note goes OUTSIDE the brackets. `commentIds=["a", +3 more]` is not something the agent can
  paste into a call, and the whole point of naming ids here is that the hint stays executable.
  */
  const hiddenSuffix = commentIds && commentIds.length > ids.length ? ` (+${commentIds.length - ids.length} more hidden)` : "";
  return `… (older comments hidden; read them with fn_task_show commentIds=[${ids.map((id) => `"${id}"`).join(", ")}])${hiddenSuffix}`;
}

function truncate(value: string, cap: number, marker: string): string {
  if (value.length <= cap) {
    return value;
  }
  const sliceLength = Math.max(0, cap - marker.length);
  return `${value.slice(0, sliceLength)}${marker}`;
}

export function trimTaskDescription(description: string, template: HeartbeatPromptTemplate): string {
  return truncate(description, TASK_DESC_CAP[template], TASK_TRUNCATION_MARKER);
}

export function trimPromptMd(prompt: string | undefined, template: HeartbeatPromptTemplate): string | undefined {
  if (prompt === undefined) {
    return undefined;
  }
  return truncate(prompt, PROMPT_MD_CAP[template], TASK_TRUNCATION_MARKER);
}

const TRIGGERING_COMMENT_HEADING = "New comments since last run:";

export function trimTriggeringComments(
  lines: string[],
  _template: HeartbeatPromptTemplate,
  hiddenCommentIds?: readonly string[],
): string[] {
  const headingIndex = lines.indexOf(TRIGGERING_COMMENT_HEADING);
  const headings = headingIndex >= 0 ? lines.slice(0, headingIndex + 1) : [];
  const body = headingIndex >= 0 ? lines.slice(headingIndex + 1) : lines;

  if (body.length <= 3) {
    return lines;
  }

  const selected = body.slice(-3);
  const joined = selected.join("\n");
  if (joined.length <= 500) {
    return [...headings, ...selected];
  }
  const truncated = truncate(joined, 500, buildCommentsTruncationMarker(hiddenCommentIds));
  return [...headings, ...truncated.split("\n")];
}
