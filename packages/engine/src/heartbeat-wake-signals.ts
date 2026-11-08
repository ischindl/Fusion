/*
FNXC:HeartbeatWakeDiscipline 2026-10-13 (STAS-300):

One place reads the signals a heartbeat wake is allowed to claim, and the same
place answers "is anything newer than what the last acknowledged run already
saw?". Both the prompt the agent reads and the timer gate that decides whether to
spend a session on it come through here, because the two had drifted: the prompt
rendered a `limit: 10` preview's `.length` as the unread total, while the agent's
own `fn_read_messages` — the same `messages` table, a different query — could
report up to 31. A second counter that can disagree is what made a phantom
"pending messages: 10" unfixable from inside the prompt.

Rules this module exists to enforce:
- The unread total is the message store's own count (`getMailbox().unreadCount`,
  the same `read = 0 AND NOT archived` predicate `fn_read_messages` reads), never
  a preview length. No store means no total: callers get `null` and must say so
  instead of printing a 0.
- A caller that cannot read a signal throws to its caller. Silence is what let an
  idle agent be re-dispatched for weeks.
- A compared population is written and read by the SAME function over the SAME query. A cursor
  that records one population while the next tick measures another can never be satisfied, and
  the agent pays a full session for every tick: the first build of this gate persisted a run's
  TRIGGERING comment ids and compared them to every steering comment on the assigned rows, so any
  card that had ever been steered re-dispatched forever.
*/
import type { Agent, ChatRoom, ChatRoomMessage, ChatStore, Message, MessageStore, Task, TaskStore } from "@fusion/core";
import { resolveFreshAutoClaimCandidates, type AutoClaimSnapshotManager } from "./scheduling/auto-claim-snapshot.js";
import { emitBoundedRunAudit } from "./util/emit-bounded-run-audit.js";
import { heartbeatLog } from "./logger.js";

/** How many unread rows the wake delta shows the agent as a preview. A preview, never a total. */
export const INBOX_PREVIEW_LIMIT = 10;
const ROOM_MESSAGES_PER_ROOM_LIMIT = 10;
const ROOM_MESSAGES_TOTAL_CAP = 30;

export interface WakeInboxSignal {
  /** The store's unread total, or `null` when no authoritative message store exists. */
  unreadTotal: number | null;
  preview: Message[];
}

export async function collectInboxSignal(
  messageStore: MessageStore | undefined,
  agentId: string,
): Promise<WakeInboxSignal> {
  if (!messageStore) {
    return { unreadTotal: null, preview: [] };
  }
  const [preview, mailbox] = await Promise.all([
    messageStore.getInbox(agentId, "agent", { read: false, limit: INBOX_PREVIEW_LIMIT }),
    messageStore.getMailbox(agentId, "agent"),
  ]);
  return { unreadTotal: mailbox.unreadCount, preview };
}

export interface WakeRoomSignal {
  entries: Array<{ room: ChatRoom; messages: ChatRoomMessage[] }>;
  total: number;
  truncatedCount: number;
}

export async function collectRoomSignal(
  chatStore: ChatStore | undefined,
  agentId: string,
  sinceIso: string,
): Promise<WakeRoomSignal> {
  if (!chatStore) {
    return { entries: [], total: 0, truncatedCount: 0 };
  }

  const rooms = await chatStore.listRoomsForAgent(agentId, { status: "active" });
  const entries: Array<{ room: ChatRoom; messages: ChatRoomMessage[] }> = [];
  let total = 0;
  let surfaced = 0;
  let truncatedCount = 0;

  for (const room of rooms) {
    const messages = await chatStore.listRoomMessagesSince(room.id, sinceIso, {
      excludeSenderAgentId: agentId,
      limit: ROOM_MESSAGES_PER_ROOM_LIMIT,
    });
    if (messages.length === 0) {
      continue;
    }

    total += messages.length;
    const remaining = ROOM_MESSAGES_TOTAL_CAP - surfaced;
    if (remaining <= 0) {
      truncatedCount += messages.length;
      continue;
    }

    const surfacedMessages = messages.slice(0, remaining);
    truncatedCount += messages.length - surfacedMessages.length;
    entries.push({ room, messages: surfacedMessages });
    surfaced += surfacedMessages.length;
  }

  return { entries, total, truncatedCount };
}

/**
 * What the last acknowledged run said it had seen. `consumedMessageIds` holds only ids the
 * store CONFIRMED read, so a listed id can never reappear in an unread query — the list is the
 * audit record of the acknowledgement, and the board cursors are the freshness compare.
 *
 * Every compared population lives in `boardState` and comes out of `boardStateFrom`, so the run
 * that writes a cursor and the tick that reads it cannot disagree about what a population holds.
 * A cursor whose population the writer took from a different query than the reader's is the bug
 * this shape exists to make impossible: the first build persisted a run's TRIGGERING comment ids
 * and compared them against every steering comment on the assigned rows, so any card that had
 * ever been steered re-dispatched forever.
 */
export interface HeartbeatWakeCursor {
  consumedMessageIds: string[];
  roomEntryIds: string[];
  boardState: HeartbeatBoardState;
}

export interface HeartbeatBoardState {
  assignedTaskId?: string | null;
  assignedTaskState?: string | null;
  assignedRows: string[];
  autoClaimCandidates: string[];
  /**
   * Steering comments carried by the assigned rows, read in the same query as `assignedRows`.
   * Steering comments are durable board state (the store trims at 200 and never clears them), so
   * the compare asks only whether a NEW id appeared — an id this set already covers is history.
   */
  steeringCommentIds: string[];
}

export interface WakeSignalSnapshot {
  inboxUnreadTotal: number;
  roomEntryIds: string[];
  boardState: HeartbeatBoardState;
}

export type WakeCursorParse =
  | { kind: "absent" }
  | { kind: "unsupported" }
  | { kind: "cursor"; cursor: HeartbeatWakeCursor };

/**
 * Reads the acknowledgement out of a persisted run row. Anything the module cannot prove —
 * no run, no cursor, a cursor whose shape it does not recognise — is reported as such so the
 * caller dispatches: suppression has to be earned, never assumed.
 */
export function parseHeartbeatWakeCursor(resultJson: unknown): WakeCursorParse {
  if (!isRecord(resultJson) || resultJson.heartbeatDoneAccepted !== true) {
    return { kind: "absent" };
  }
  const cursor = resultJson.wakeCursor;
  if (!isRecord(cursor) || !isRecord(cursor.boardState)) {
    return { kind: "unsupported" };
  }
  if (
    !isStringArray(cursor.consumedMessageIds)
    || !isStringArray(cursor.roomEntryIds)
    || !isStringArray(cursor.boardState.assignedRows)
    || !isStringArray(cursor.boardState.autoClaimCandidates)
    || !isStringArray(cursor.boardState.steeringCommentIds)
  ) {
    return { kind: "unsupported" };
  }

  return {
    kind: "cursor",
    cursor: {
      consumedMessageIds: cursor.consumedMessageIds,
      roomEntryIds: cursor.roomEntryIds,
      boardState: {
        assignedTaskId: readNullableString(cursor.boardState.assignedTaskId),
        assignedTaskState: readNullableString(cursor.boardState.assignedTaskState),
        assignedRows: cursor.boardState.assignedRows,
        autoClaimCandidates: cursor.boardState.autoClaimCandidates,
        steeringCommentIds: cursor.boardState.steeringCommentIds,
      },
    },
  };
}

/**
 * The board and comment half of the wake-signal compare, read the same way the prompt reads it:
 * the agent's assigned rows, the steering comments on them, and — only for an agent that can run
 * without an assignment — the auto-claim candidate set.
 */
export interface WakeSignalSources {
  taskStore: TaskStore;
  agent: Agent;
  chatStore?: ChatStore;
  messageStore?: MessageStore;
  /** The same snapshot cache the prompt renders candidates from, so both read one board view. */
  autoClaimSnapshotManager?: AutoClaimSnapshotManager;
  sinceIso: string;
}

/*
FNXC:WakeDeltaPhantomIds 2026-11-05-23:10 (RUFU-455):
One withheld id is ONE report per engine process, not one per collection.

`filterResolvableAssignedTasks` runs on every population collection — the wake gate, the ack writer's
`collectBoardSignal`, the inventory read, and the idle pre-flight — so a sustained phantom would otherwise
write 2-3 identical rows per heartbeat tick with the same `runId`, `mutationType`, and metadata, which an
operator cannot tell apart from 2-3 withhold episodes. Volume is the smaller reason. The binding one is
retention: `pruneOperationalLogsAsync` deletes run-audit rows only through `task_id IN (SELECT id FROM
project.tasks ...)`, and a withheld id by definition has no `tasks` row, so every row of this type is
immortal — the same trap RUFU-344 documented and won a bounded exception for on `store:open`. A row that
can never be pruned must be a row that is written once.

The bound is process-local, so the worst-case rate is one row per (agentId, taskId, outcome) per engine
lifetime; a phantom that survives restarts stays countable without re-announcing on every tick. The
cap makes the marker itself bounded (FIFO eviction, insertion-ordered `Set`) so a long-lived engine
cannot grow it without limit. The lane `heartbeatLog.warn` inside the filter below deliberately stays
per-collection: agent logs are retention-bounded, and "still withheld, right now" is the live-tail signal
that an audit row written hours ago cannot carry.
*/
const WAKE_WITHHOLD_REPORTED_MAX = 512;
const wakeWithholdReported = new Set<string>();

/** Claims the report for one (agent, id, outcome) triple; false when that episode was already reported. */
function claimWakeWithholdReport(agentId: string, taskId: string, outcome: string): boolean {
  const key = `${agentId}\u0000${taskId}\u0000${outcome}`;
  if (wakeWithholdReported.has(key)) return false;
  if (wakeWithholdReported.size >= WAKE_WITHHOLD_REPORTED_MAX) {
    const oldest = wakeWithholdReported.values().next();
    if (!oldest.done) wakeWithholdReported.delete(oldest.value);
  }
  wakeWithholdReported.add(key);
  return true;
}

/** Test seam: the bound is deliberately process-local, so a suite that asserts emission needs a fresh episode register. */
export function resetWakeDeltaWithholdReportsForTests(): void {
  wakeWithholdReported.clear();
}

/*
FNXC:WakeDeltaPhantomIds 2026-11-05-07:18 (RUFU-455):
THE INVARIANT: a wake/ranking row is never dispatchable unless the authoritative by-id predicate
resolves it. Measured 2026-09-30, heartbeat run `run-d5f354ac` of `agent-5683bf15`: the wake delta
named `RUFU-454` and `RUFU-455` as `ready_todo (tier 1)` assignments owned by that agent while
`fn_task_show` answered `Task RUFU-454 not found.` for both, and the operator routed work against a
third id this class of surface named. The agent's answer was an incident report, because the only
thing protecting the surface was a comment at the render site claiming the read "already reads the
live task set" — a claim that is unverifiable where it was written and false for an unbound layer.

Why the check sits HERE and not deeper: `getTasksByAssignedAgent` has five consumers and only two of
them publish to an agent. `deleteAgent`'s reassignment guard, `resumeAgent`'s `pausedOnly` cascade,
and the dashboard resume auto-unpause lane must each keep seeing their rows — dropping inside the core
read would blind all three, and an agent whose assigned rows are unresolvable is exactly the agent
whose deletion must still be refused. So the core read stays a pure read and validation is a
heartbeat-side concern applied ONCE, upstream of `boardStateFrom`, which is the only writer of the
compared population. That single position covers all three publishes for free: the wake gate
(`classifyFresherWakeSignal`), the durable `wakeCursor` (`buildWakeAcknowledgement`), and the
agent-facing inventory — the latter calls this function directly because it renders from its own read
and never passes through `collect*`.

WHICH STORE INSTANCE VALIDATES, AND WHAT IT CANNOT SEE: validation runs through the `TaskStore`
handed to `HeartbeatMonitor` (`runtimes/in-process-runtime.ts:2187`), which is the SAME instance whose
list read produced these rows. It therefore catches a read-shape, cache, or timing divergence and a
tombstone, and it CANNOT see a row that lives under a different `project_id` in the same shared cluster
or in a different database — on that instance both reads are scoped identically, so they agree by
construction. That is the honest boundary of this guard, and `storeBound` in the audit row is what makes
it readable: a project-agnostic layer makes `taskProjectScope` a no-op, so the list read spans projects,
the presence read spans them too, and the phantom is published with `storeBound: false` naming the
binding as the cause. Closing the binding itself is Step 2's store-scoping concern, not something this
function is allowed to pretend it covers.

Why NOT `store.getTask()` per row: `getTaskImpl` takes `withTaskLock` and hydrates the History side
table, settings, merge-queue state and stall reasons on every call (RUFU-201/615/627/756 history) — a
read storm on a heartbeat cadence. One `getTaskPresence` query per collection instead, never per row.

Fail-open when the probe is absent: a store without `getTaskPresence` (an injected or fake store)
publishes exactly as it did before this guard existed. Dropping an agent's real assignments because a
diagnostic probe is missing would turn a phantom-ID bug into a lost-work bug, and the withhold path
would then be untestable against the fakes every existing heartbeat suite already uses.
*/
export async function filterResolvableAssignedTasks(
  taskStore: TaskStore,
  agentId: string,
  assignedTasks: Task[],
): Promise<Task[]> {
  const probe = (taskStore as { getTaskPresence?: (ids: string[]) => Promise<Array<{ id: string; deletedAt: string | null }>> }).getTaskPresence;
  if (typeof probe !== "function" || assignedTasks.length === 0) return assignedTasks;

  let presence: Array<{ id: string; deletedAt: string | null }>;
  try {
    presence = await probe.call(taskStore, assignedTasks.map((task) => task.id));
  } catch (err: unknown) {
    // A failing probe must not cost the agent its real assignments — see the fail-open rule above.
    heartbeatLog.warn(
      `wake-delta presence probe failed for ${agentId}, publishing unvalidated: ${err instanceof Error ? err.message : String(err)}`,
    );
    return assignedTasks;
  }

  const present = new Map(presence.map((row) => [row.id, row.deletedAt]));
  const withheld: Array<{ id: string; outcome: "absent" | "tombstone" }> = [];
  const publishable = assignedTasks.filter((task) => {
    if (!present.has(task.id)) {
      withheld.push({ id: task.id, outcome: "absent" });
      return false;
    }
    if (present.get(task.id) !== null) {
      // A tombstone reaches the guard only via a forensic-shaped read; the live read path already
      // excludes it. Kept distinguishable because "deleted" and "never existed" need different remedies.
      withheld.push({ id: task.id, outcome: "tombstone" });
      return false;
    }
    return true;
  });

  if (withheld.length === 0) return publishable;

  /*
  Withholding writes NO task History line: `logEntry` needs a row to carry it, and the withheld id is
  precisely a row that does not exist. The operator-visible notices are therefore this audit row plus
  one line on the agent's own lane log — never a fabricated card entry and never a payload excerpt.
  */
  heartbeatLog.warn(
    `wake-delta withheld ${withheld.length} unresolvable assignment(s) for ${agentId}: ` +
      withheld.map((row) => `${row.id}(${row.outcome})`).join(", "),
  );
  const storeBound = Boolean((taskStore as { asyncLayer?: { projectId?: string } }).asyncLayer?.projectId?.trim());
  for (const row of withheld) {
    if (!claimWakeWithholdReport(agentId, row.id, row.outcome)) continue;
    void emitBoundedRunAudit(taskStore, {
      taskId: row.id,
      agentId,
      runId: `wake-delta-unresolvable:${agentId}:${row.id}`,
      domain: "database",
      mutationType: "task:wake-delta-unresolvable-assignment",
      target: row.id,
      metadata: {
        taskId: row.id,
        agentId,
        outcome: row.outcome,
        source: "wake-delta",
        withheldCount: withheld.length,
        storeBound,
      },
    }, { log: heartbeatLog });
  }
  return publishable;
}

/**
 * The whole board half of a wake cursor: the rows assigned to this agent with the column each sits
 * in, the steering comments those rows carry, and — for an agent that can run unassigned — the
 * auto-claim candidate set. This is the ONLY writer of the compared board population, so the run
 * that persists a cursor and the tick that compares against it ask the identical question.
 */
export async function collectBoardSignal(
  sources: Pick<WakeSignalSources, "taskStore" | "agent" | "autoClaimSnapshotManager">,
): Promise<HeartbeatBoardState> {
  const { taskStore, agent, autoClaimSnapshotManager } = sources;
  // The assigned read and the candidate read stay concurrent, exactly as before the guard: the
  // presence probe is sequenced AFTER the list read because it is derived from that read's ids.
  const [rawAssigned, autoClaimCandidates] = await Promise.all([
    taskStore.getTasksByAssignedAgent(agent.id),
    collectAutoClaimCandidateIds(taskStore, agent, autoClaimSnapshotManager),
  ]);
  const assignedTasks = await filterResolvableAssignedTasks(taskStore, agent.id, rawAssigned);

  return boardStateFrom(assignedTasks, agent, autoClaimCandidates);
}

export async function collectWakeSignals(sources: WakeSignalSources): Promise<WakeSignalSnapshot> {
  const { taskStore, agent, chatStore, messageStore, autoClaimSnapshotManager, sinceIso } = sources;
  const [rawAssigned, inbox, rooms, autoClaimCandidates] = await Promise.all([
    taskStore.getTasksByAssignedAgent(agent.id),
    collectInboxSignal(messageStore, agent.id),
    collectRoomSignal(chatStore, agent.id, sinceIso),
    collectAutoClaimCandidateIds(taskStore, agent, autoClaimSnapshotManager),
  ]);
  const assignedTasks = await filterResolvableAssignedTasks(taskStore, agent.id, rawAssigned);

  if (inbox.unreadTotal === null) {
    throw new Error(`wake-signal probe: no authoritative message store for ${agent.id}`);
  }

  return {
    inboxUnreadTotal: inbox.unreadTotal,
    roomEntryIds: rooms.entries.flatMap((entry) => entry.messages.map((message) => message.id)),
    boardState: boardStateFrom(assignedTasks, agent, autoClaimCandidates),
  };
}

function boardStateFrom(
  assignedTasks: Awaited<ReturnType<TaskStore["getTasksByAssignedAgent"]>>,
  agent: Agent,
  autoClaimCandidates: string[],
): HeartbeatBoardState {
  return {
    assignedTaskId: agent.taskId ?? null,
    assignedTaskState: assignedTasks.find((task) => task.id === agent.taskId)?.column ?? null,
    assignedRows: assignedTasks.map((task) => `${task.id}:${task.column}`),
    autoClaimCandidates,
    steeringCommentIds: assignedTasks.flatMap((task) => (task.steeringComments ?? []).map((comment) => comment.id)),
  };
}

/**
 * Which population makes a fresh snapshot fresher than an acknowledged cursor, or `"none"`.
 *
 * FNXC:HeartbeatIdlePreflight 2026-11-01-00:20 (RUFU-268):
 * `hasFresherWakeSignal` answered only "is there anything new?", which was enough while a yes meant
 * "open a full session". A second consumer now has to ask WHICH population changed: the compact idle
 * pre-flight may run only for a delta confined to the board-candidate table, because a new message,
 * room entry, or steering comment carries content the compact turn was never given and could not
 * honestly answer for. Introducing this classifier rather than a second hand-copied predicate keeps
 * ONE definition of freshness — a copy is how the two paths would start disagreeing about whether a
 * tick needs a session, and the cheap path silently swallowing a real signal is the one failure this
 * design cannot afford.
 *
 * Message and room precedence is deliberate: those are content that arrived, so they are reported
 * before anything the board merely rearranged. The remaining checks are the board's, in the same
 * order `hasFresherWakeSignal` used, so the classification cannot shift which tick is considered fresh.
 *
 * FNXC:HeartbeatIdlePreflight 2026-11-01-11:40 (RUFU-268):
 * The board half is split THREE ways, not two, because the first build called every board delta
 * `"board-candidates"` and that label then did double duty as "safe to postpone" and "safe to ask about
 * with a one-line question". A new steering comment carries text the agent has never read, and a change
 * in the agent's own assigned rows means work landed on it — postponing either for a ladder step, or
 * letting the compact turn answer for it, trades a real signal for a token saving. Only the ambient
 * candidate table moving is a delta an idling agent may be asked about later; it is also the only
 * population the compact turn is actually shown, which is what makes the two permissions the same set.
 * Splitting the label changed no tick's freshness verdict: `hasFresherWakeSignal` still answers
 * `kind !== "none"`, so the ladder and the pre-flight narrow what they may skip without moving the
 * boundary of when a session is owed.
 */
export type WakeSignalKind =
  | "messages"
  | "room"
  | "board-content"
  | "board-assignment"
  | "board-candidates"
  | "none";

/**
 * Every kind the classifier can return, in report order. A wiring site validates a forwarded kind
 * against this list rather than hand-copying a literal union, so a new kind cannot be silently dropped
 * at one of the two scheduler boundaries and quietly cost that tick its cheap turn.
 */
export const WAKE_SIGNAL_KINDS = [
  "messages",
  "room",
  "board-content",
  "board-assignment",
  "board-candidates",
  "none",
] as const satisfies readonly WakeSignalKind[];

export function classifyFresherWakeSignal(
  cursor: HeartbeatWakeCursor,
  snapshot: WakeSignalSnapshot,
): WakeSignalKind {
  if (snapshot.inboxUnreadTotal > 0) return "messages";
  if (snapshot.roomEntryIds.some((id) => !cursor.roomEntryIds.includes(id))) return "room";
  if (snapshot.boardState.steeringCommentIds.some((id) => !cursor.boardState.steeringCommentIds.includes(id))) {
    return "board-content";
  }
  if (!sameIdSet(cursor.boardState.assignedRows, snapshot.boardState.assignedRows)) return "board-assignment";
  if (cursor.boardState.assignedTaskState !== snapshot.boardState.assignedTaskState) return "board-assignment";
  if (!sameIdSet(cursor.boardState.autoClaimCandidates, snapshot.boardState.autoClaimCandidates)) return "board-candidates";
  return "none";
}

/**
 * The ONE kind an idling agent may be asked about late, or asked about with the compact pre-flight.
 * Both permissions are answered by the same predicate on purpose: the candidate table is the only
 * population the cheap turn is shown, so a delta the agent cannot be shown cheaply is also a delta it
 * cannot be asked to wait on. Two hand-copied `=== "board-candidates"` checks in two lanes is how one
 * of them would eventually drift onto a kind carrying unread content.
 */
export function isIdleLadderEligibleWakeSignal(kind: WakeSignalKind | undefined): boolean {
  return kind === "board-candidates";
}

/** Narrows a value carried across a wiring boundary to a known kind; anything else means unclassified. */
export function asWakeSignalKind(value: unknown): WakeSignalKind | undefined {
  return (WAKE_SIGNAL_KINDS as readonly string[]).includes(String(value))
    ? value as WakeSignalKind
    : undefined;
}

/** True when the fresh snapshot holds anything the acknowledged cursor did not already cover. */
export function hasFresherWakeSignal(cursor: HeartbeatWakeCursor, snapshot: WakeSignalSnapshot): boolean {
  return classifyFresherWakeSignal(cursor, snapshot) !== "none";
}

/**
 * The auto-claim candidate ids the run would have advertised. Returns [] for an agent that already
 * has an assignment, matching the prompt path that only shows candidates to a no-task agent.
 */
async function collectAutoClaimCandidateIds(
  taskStore: TaskStore,
  agent: Agent,
  snapshotManager: AutoClaimSnapshotManager | undefined,
): Promise<string[]> {
  if (agent.taskId || !snapshotManager) return [];
  const snapshot = await snapshotManager.getSnapshot();
  const freshCandidates = await resolveFreshAutoClaimCandidates(taskStore, snapshot.tasks);
  return freshCandidates.map((candidate) => candidate.id).sort();
}

function sameIdSet(cursorIds: string[], snapshotIds: string[]): boolean {
  if (cursorIds.length !== snapshotIds.length) return false;
  const known = new Set(cursorIds);
  return snapshotIds.every((id) => known.has(id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function readNullableString(value: unknown): string | null {
  if (typeof value === "string") return value;
  return null;
}
