/*
FNXC:BoardLaneReadScope 2026-11-18-06:20 (RUFU-479) — one owner for "which lanes does this board read?".

WHY A BOARD READS BY LANE AT ALL. `GET /tasks/page` with no scope answers "every live card in this
project, creation-ascending, up to the limit". For a project whose current work exceeds one page that
truncation happens server-side BEFORE any client sort, so the card an operator needs — a boosted card, a
freshly captured idea, the one failed card among two hundred idle ones — is not in the payload and no
client-side sort can promote it (RUFU-509). The lane-head read (`?columns=<lane>&order=…`) is the answer
that is both ordered and bounded, and it is also the only read shape whose cost is proportional to the
work in view rather than to the size of the project.

WHY THE DECISION NEEDS ONE OWNER. Three surfaces ask the same question — the desktop board, the mobile
board, and any consumer that maps cards to workflows — and until now the vocabulary policy lived in a
`useMemo` inside `Board.tsx` while the order mapping lived in the hook. Two consumers asking that
question with two copies of the rule is how a board ends up reading a lane it does not render, or not
reading a lane it does. So the rule lives here, expressed over the column vocabulary the server already
published (the trait-resolved flags from `column-roles.ts`), and every board-facing caller calls into it.

WHAT THIS IS NOT. It is not a cache, not a queue, and not a second read scheduler: `api/client/read-scheduler.ts`
bounds concurrency and `api/client/dedupe.ts` coalesces identical in-flight reads; both stay the only
owners of those concerns. This module decides only WHICH reads a given board view asks for.
*/
import { isReviewColumnRole, type ColumnRoleFlags } from "../../utils/columnRoles.js";

/** The trait answers a lane-order decision needs, which is the board payload's flag object subset. */
export interface LaneQueueColumnFlags extends ColumnRoleFlags {
  readonly manualIntake?: boolean;
  /*
  FNXC:BoardLaneReadScope 2026-11-18-06:32 (RUFU-479):
  The published-column trait that removes a lane from the board SURFACE. It belongs in this subset because
  the same flag object answers both questions a lane read depends on, which order to ask for and whether to
  read the lane at all, and splitting them would let a lane nobody renders keep holding a lane read.
  */
  readonly hiddenFromBoard?: boolean;
}

export interface TaskQueueScope {
  /** Stable identity of this lane scope within the current board view. */
  key: string;
  /** Column ids sharing this order. */
  columns: readonly string[];
  /*
  FNXC:BoardOrdering 2026-11-13-10:37 (RUFU-526):
  `attention` is the third lane order and the one the operator's board asks for by default: the lane head
  comes back ranked by what needs a human, so the card that is broken is in the payload at all. `queue`
  and `intake` keep their existing meanings - `queue` is the order the ENGINE dispatches on and must not
  silently acquire a ranking opinion, which is why the board asks for `attention` rather than turning
  `queue` into something new.
  */
  order: "queue" | "intake" | "attention";
  /*
  Claims these columns are review-owned, so the required pre-merge gate tier applies. It is a claim in
  both directions: the server confirms it against the project's own lane vocabulary and the lane cursor is
  bound to the RESOLVED answer, so a scope that changes gate must be a different scope here too.
  */
  reviewScope?: boolean;
}

/*
FNXC:BoardOrdering 2026-11-13-10:37 (RUFU-526):
ONE place decides which order a board lane asks its server for, so the mapping is reachable from a test
without rendering the board, and so a lane cannot get a different answer in two callers.

WHY A LANE IS NOT JUST ASKED FOR `queue`. `queue` is the order the engine DISPATCHES on; teaching it to
prefer broken work would move real execution, so the attention rank rides on its own order mode and
`queue` keeps the byte-for-byte behaviour its own suite pins.

WHY MANUAL CAPTURE STAYS `intake`. A freshly captured idea has no failure, no gate, and no wait; its
ranking rule is "newest first" precisely so the operator can triage the pile, and an attention ladder has
nothing true to say about a card that has not started.

WHY THE REVIEW CLAIM IS A DERIVED CLAIM AND NOT A LANE NAME. It comes from the same trait test the rest of
the dashboard already uses to ask "is this review", including the legacy-id fallback for a column whose
traits did not resolve, which is the same vocabulary the server re-derives before it accepts the claim.
A lane that is not review asks for nothing, so a backlog can never be ranked by gates it has not reached.
*/
export function laneQueueScopeForColumn(
  key: string,
  flags: LaneQueueColumnFlags | undefined,
): TaskQueueScope {
  const manualIntake = flags?.manualIntake === true;
  const reviewScope = !manualIntake && isReviewColumnRole(flags, key);
  return {
    key,
    columns: [key],
    order: manualIntake ? "intake" : "attention",
    ...(reviewScope ? { reviewScope: true } : {}),
  };
}

/** One column of the published board vocabulary, as the board payload carries it. */
export interface BoardLaneColumn {
  readonly id: string;
  readonly flags?: LaneQueueColumnFlags;
}

export interface BoardLaneScopeOptions {
  /*
  The columns actually in view, when the caller knows them. A desktop board renders every column of the
  selected workflow, so it passes nothing and gets the whole vocabulary; a mobile board has exactly one
  column on screen, and a panel covering the board has none. Passing `visibleColumnIds` narrows the
  request set to the intersection with the readable vocabulary — it can never ADD a lane, because a
  caller cannot read a lane the vocabulary does not publish.
  */
  readonly visibleColumnIds?: readonly string[];
}

/*
The two traits that remove a lane from the board's read set, and why each one is a read the board cannot
profit from:

  * `hiddenFromBoard` — the operator removed the column from the board surface. Reading its head feeds a
    surface that does not exist.
  * `complete` — the terminal lane. The board renders it through its own bounded Done accumulator
    (`/tasks/done?limit=50`), so a lane-head read here would be a second, differently-ordered read of the
    same cards, and the Done range is the one that dominates a long-lived project's task table.

Everything else is a lane the board renders, including `intake`: a manual-capture lane is read in its own
`intake` order, which `laneQueueScopeForColumn` decides from the same flags. A workflow whose vocabulary
has no intake column therefore produces no intake read — there is nothing to exclude, because the read is
built from the vocabulary and never from a hard-coded lane list.
*/
function isReadableBoardLane(column: BoardLaneColumn): boolean {
  return column.flags?.hiddenFromBoard !== true && column.flags?.complete !== true;
}

/**
 * The lane reads one board view issues, in one deterministic list.
 *
 * Determinism matters beyond tidiness: `useTaskQueuePages` derives its refetch identity from a signature
 * over these scopes, so a stable ordering is what stops a re-render from re-reading every lane head.
 */
export function buildBoardLaneScopes(
  columns: readonly BoardLaneColumn[] | undefined,
  options?: BoardLaneScopeOptions,
): TaskQueueScope[] {
  if (!columns || columns.length === 0) return [];
  const visible = options?.visibleColumnIds ? new Set(options.visibleColumnIds) : undefined;
  const scopes: TaskQueueScope[] = [];
  for (const column of columns) {
    if (!isReadableBoardLane(column)) continue;
    if (visible && !visible.has(column.id)) continue;
    scopes.push(laneQueueScopeForColumn(column.id, column.flags));
  }
  return scopes;
}

/**
 * Whether a lane-head read exists for `columnId` in this view's scope list.
 *
 * The SSE reducer needs this question: a card moved into a lane that is not in view must not start a
 * lane read for a surface nobody can see, and it must not be mistaken for a lane the board dropped.
 */
export function hasBoardLaneScope(scopes: readonly TaskQueueScope[], columnId: string): boolean {
  return scopes.some((scope) => scope.columns.includes(columnId));
}
