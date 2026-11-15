/**
 * Shared classification and settlement for a refused automatic worktree removal.
 *
 * FNXC:WorktreePreservation 2026-11-08-04:00 (RUFU-278):
 * A content-preservation refusal is a POLICY DECISION that protected the card's deliverable, but until this seam
 * existed every lane that caught one rendered it as a failure. RUFU-260 measured the cost of that rendering: the
 * executor's transient-retry teardown caught the refusal, logged one `worktree removal failed during
 * transient-error retry cleanup` line, and then nulled `worktree`/`branch` anyway — orphaning the very checkout the
 * refusal had just protected — while the same episode reached the card as `status: "failed"` whose error sentence was
 * the refusal text. Two properties were lost together (the deliverable and the reason) and the card looked like an
 * ordinary failure with an implementation-looking sentence and no Retry remedy.
 *
 * This module is the single source of truth for both halves:
 * - `isWorktreePreservationRefusal` answers "is this refusal the content-preservation policy?" so no lane
 *   re-derives it from prose. The predicate NEVER matches the broad `preserving ` prefix on its own: three refusal
 *   sentences share that prefix, and the project-root refusal plus the branch-rebind refusal are NOT content
 *   decisions and must keep their current dispositions.
 * - `settlePreservedWorktreeRemoval` records the settled decision where an operator reads it (card History plus
 *   run-audit) and hands control back so the caller continues instead of failing.
 *
 * FNXC:WorktreePreservation 2026-11-08-04:02 (RUFU-278) — mock-boundary note:
 * The predicate is imported from the SAME specifier the importing lane already uses for `removeWorktree`
 * (`worktree-pool.js` for pool-importing lanes, `worktree-backend.js` elsewhere), because a lane whose test doubles
 * `vi.mock("../worktree/worktree-pool.js")` does NOT intercept `../worktree/worktree-backend.js`: a classifier bound
 * across that boundary silently vanishes from the doubled test and the lane behaves as if no classifier existed.
 */
import { emitBoundedRunAudit, type RunAuditEvent, type RunAuditSinkHost } from "../util/emit-bounded-run-audit.js";
import type { WorktreePreservedRefusalClassification } from "./worktree-backend.js";

/** The content tails a preservation refusal carries, byte-identical to the raise sites. */
const PRESERVATION_DELIVERABLE_TAIL = ": uncommitted or ignored content present";
const PRESERVATION_PROBE_FAILED_TAIL = ": status probe failed (";
const PRESERVATION_PREFIX = "preserving ";

function isPreservationSentence(message: string): boolean {
  return message.includes(PRESERVATION_PREFIX)
    && (message.includes(PRESERVATION_DELIVERABLE_TAIL) || message.includes(PRESERVATION_PROBE_FAILED_TAIL));
}

function isContentClassification(value: unknown): value is WorktreePreservedRefusalClassification {
  return value === "deliverable" || value === "ignored-only" || value === "unverifiable";
}

/**
 * True when `error` is the content-preservation policy refusing to delete unproven content.
 *
 * The typed arm is the contract; the message arm exists because a refusal crosses boundaries that lose the class —
 * acquisition re-wraps it into its own cap sentence, and RUFU-260's stored error was exactly that shape
 * (`Worktree acquisition failed after 3 heartbeat attempts for branch "...": preserving ...: uncommitted or ignored
 * content present`). So the signature is the complete CONTENT sentence anywhere in the message, never the shared
 * `preserving ` prefix on its own: three refusal sentences share that prefix, and the project-root refusal plus the
 * `task-owned branch rebind could not be proven` refusal are genuine misconfigurations that must keep their current
 * dispositions. A lane routed by this predicate therefore cannot absorb a misconfiguration into the preserve path —
 * deleting a root checkout or trusting an unproven rebind would both be worse than the failure being fixed.
 */
export function isWorktreePreservationRefusal(error: unknown): boolean {
  return worktreePreservationRefusal(error) !== null;
}

/** The typed refusal plus its classification, or null when the error is not a content-preservation refusal. */
export function worktreePreservationRefusal(
  error: unknown,
): { classification: WorktreePreservedRefusalClassification } | null {
  /*
  FNXC:WorktreePreservation 2026-11-08-08:20 (RUFU-278):
  Recognition is STRUCTURAL, not `instanceof`, and that is deliberate. A classifier whose identity check depends on
  one module instance silently dies when that module is doubled — `post-landing-worktree-cleanup.test.ts` mocks
  `worktree-backend.js` down to three exports, which leaves the class undefined and made `error instanceof
  WorktreeContentPreservationError` throw inside the very catch that was supposed to absorb the refusal. A predicate
  that can throw is worse than no predicate, because it converts a protective decision into a new failure. So a
  refusal is recognised as "carries one of the three fixed classifications AND speaks a preservation sentence":
  strictly weaker than a class identity in the language, strictly stronger than either half alone — the project-root
  refusal and the unproven-rebind refusal share the `preserving ` prefix but carry no content classification and no
  content tail, so both still decline.
  */
  const carried = (error as { classification?: unknown } | null | undefined)?.classification;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (isContentClassification(carried) && isPreservationSentence(message)) {
    return { classification: carried };
  }
  if (!message.includes(PRESERVATION_PREFIX)) return null;
  if (message.includes(PRESERVATION_DELIVERABLE_TAIL)) return { classification: "deliverable" };
  if (message.includes(PRESERVATION_PROBE_FAILED_TAIL)) return { classification: "unverifiable" };
  /*
  FNXC:WorktreePreservation 2026-11-08-08:20 (RUFU-278):
  There is deliberately no message arm for `ignored-only`: the raise site builds its sentence from the same ternary as
  `deliverable`, so an ignored-only refusal and a deliverable refusal are byte-identical on the wire and only the
  carried classification separates them. When the type is lost, the classifier reports `deliverable` — the more
  protective of the two, and both preserve — rather than inventing a distinction the sentence does not contain.
  */
  // `preserving <path>: refusing to remove the project root checkout`, the rebind refusal, and any other
  // shared-prefix sentence: a misconfiguration, not a content decision.
  return null;
}

/** Which removal lane settled a refusal. Fixed vocabulary so one query answers "where did this get absorbed?". */
/*
FNXC:WorktreePreservation 2026-11-08-08:05 (RUFU-278):
This vocabulary is written into run-audit metadata, so it lists only lanes that actually emit a settlement today.
Lanes that classify a refusal without settling it (the post-landing outcome map and the self-healing WIP cap keep
their own pre-existing outcome records) deliberately do not appear here — a fixed audit vocabulary that names a
writer nobody has is a vocabulary that lies about what is queryable.
*/
export type PreservedWorktreeRemovalLane =
  | "executor-transient-retry"
  | "executor-teardown"
  | "execution-terminal-sink"
  | "step-session-cleanup"
  | "pre-execution-release"
  | "session-start-recovery";

/** What the lane did after settling. `parked` is the escalation half: the card freezes with a resume pointer. */
export type PreservedWorktreeRemovalOutcome = "continued" | "parked";

/** Store surface the settlement needs. `Pick` keeps the seam testable without a mock-the-world store. */
/*
FNXC:WorktreePreservation 2026-11-15-22:58 (RUFU-278):
The History half is declared as the seam actually uses it — a fire-and-forget writer whose return value is discarded —
not as `Pick<TaskStore, "logEntry">`. That `Pick` demanded a `Task` back, which a lane whose deps are the minimal
`{ logEntry: (...) => Promise<unknown> }` surface (`RemoveOwnWorktreeDeps`) could not satisfy, and the seam threw that
type error at the one call site whose whole job is to record a refusal before rethrowing it. Requiring a return value
this module never reads is over-specification; a real `TaskStore` still satisfies the weaker shape, and
`recordRunAuditEvent` stays optional because every field of `RunAuditSinkHost` is optional and `emitBoundedRunAudit`
absorbs a host that has no sink at all — a lane with only a History writer still gets its card sentence, which is the
half an operator reads.
*/
export type PreservedWorktreeSettlementStore = {
  logEntry: (taskId: string, action: string, outcome?: string) => Promise<unknown>;
} & Pick<NonNullable<RunAuditSinkHost>, "recordRunAuditEvent">;
export type SettledPreservedWorktreeRemoval = {
  settled: true;
  classification: WorktreePreservedRefusalClassification;
  /** The exact operator-facing sentence written to the card's History. */
  message: string;
};

/**
 * Record that a lane preserved a task worktree instead of deleting it, then hand control back.
 *
 * Returns null when `error` is not a content-preservation refusal, so a caller can `await` this first and fall
 * through to its existing failure handling untouched. The card-history sentence names the preserved path, because the
 * path is the fact the operator needs in order to collect the deliverable; run-audit deliberately carries ids,
 * counts and fixed outcomes only.
 */
export async function settlePreservedWorktreeRemoval(input: {
  store: PreservedWorktreeSettlementStore | null | undefined;
  taskId?: string | null;
  worktreePath: string;
  /** The `RemovalReason` value that requested the removal, for the audit row. */
  reason: string;
  lane: PreservedWorktreeRemovalLane;
  outcome?: PreservedWorktreeRemovalOutcome;
  error: unknown;
  runId?: string | null;
  agentId?: string;
}): Promise<SettledPreservedWorktreeRemoval | null> {
  const refusal = worktreePreservationRefusal(input.error);
  if (!refusal) return null;

  const outcome = input.outcome ?? "continued";
  const message =
    `Worktree preserved: automatic cleanup (${input.lane}) refused to delete ${input.worktreePath} ` +
    `because it holds ${refusal.classification} content. The checkout and branch pointers are kept so the ` +
    `work stays reachable — this is a protection, not a failure.`;

  if (input.taskId) {
    try {
      await input.store?.logEntry(input.taskId, message);
    } catch {
      // An operator-facing note is best-effort: a store that cannot write History must not turn a
      // successful protection back into a failure. The audit row below is the second surface.
    }
  }

  await emitBoundedRunAudit(input.store as RunAuditSinkHost, {
    taskId: input.taskId ?? undefined,
    agentId: input.agentId ?? "worktree-preservation",
    runId: input.runId ?? `worktree-preservation:${input.taskId ?? input.worktreePath}`,
    domain: "database",
    mutationType: "worktree:removal-preserved",
    target: input.taskId ?? input.worktreePath,
    metadata: {
      taskId: input.taskId ?? null,
      reason: input.reason,
      classification: refusal.classification,
      lane: input.lane,
      outcome,
    },
  } satisfies RunAuditEvent);

  return { settled: true, classification: refusal.classification, message };
}

/**
 * The discriminator every pointer-clear must gate on: nulling `worktree`/`branch` is justified only when the removal
 * call itself established that the path no longer holds a checkout.
 *
 * FNXC:WorktreePreservation 2026-11-08-05:05 (RUFU-278):
 * Both honest arms of `WorktreeRemoveOutcome` qualify: the call removed the worktree, or it proved the path was already
 * unregistered and gone (`harmless: true`, the post-prune case) — clearing a pointer to a directory that no longer
 * exists is correct and must stay correct. What must NEVER clear a pointer is the absence of a removal: a thrown
 * refusal (content preservation, live session, stale lock), a skip, or a branch that never attempted the call at all.
 * RUFU-260 was the last arm: its lane caught the refusal, logged one WARN, and nulled `worktree`/`branch` anyway,
 * orphaning the checkout the refusal had just protected — the deliverable survived only because the card happened to
 * carry an unmerged commit, and the retained checkout head-of-line blocked 14 other cards through the file-scope gate.
 */
export function worktreeCheckoutIsReleased(
  outcome: { removed?: boolean; harmless?: boolean } | null | undefined,
): boolean {
  if (!outcome || typeof outcome.removed !== "boolean") return false;
  return outcome.removed === true || outcome.harmless === true;
}
