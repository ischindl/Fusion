/*
FNXC:CommitOwnership 2026-11-19-15:48:
The single grammar for commit-trailer EVIDENCE: one key pair, one parser, one verdict shape,
shared by every emitting surface and every delivery proof. It exists because a task id alone
proves nothing about who authored a commit.

Measured on RUFU-394: three commits landed on `main` on 2026-09-28 carrying task ids that named
unrelated cards. `36a88363e2` and `65b0dec011` were stamped `RUFU-391` 2h46m BEFORE that card
existed (allocator high-water at emit time was 390, the row was created at 12:03:28Z), and
`8340f30453` was stamped `RUFU-380`, a live card whose scope was capacity-sentence observability
and which had no `Fusion-Task-Id` trailer at all (identity came only from the `fix(RUFU-380):`
subject). Both ids resolve today, so any reader that asks only "does this id name a card?" accepts
them forever, and delivery proofs built on that answer report a card as landed by work it never
did. One project-scoped commit identity plus one committer-time bound removes both classes at the
anchor every consumer already shares.

The two refusals are the ONLY ones this module adds, and both are refusal-shaped, never
silent-renaming:
 - `foreign-project`: the commit declares a `Fusion-Project-Id` and it differs from the namespace
   the ownership question is being asked in. The authoring lane of a different project can no
   longer hand its work to a card of this project.
 - `anachronistic`: the commit was committed before the card it claims was created. A counter read
   one past the allocator's high-water, or an id typed from memory, cannot be delivery.

An UNKNOWN never refuses. Missing project id (unresolvable store), a missing commit
`Fusion-Project-Id` (a legacy commit predates the trailer), an unreadable committer time, or an
absent task `createdAt` all mean "this check cannot run", not "the commit is foreign". Refusing on
absence would fail closed against the toolchain's own history: every commit before this change
carries no project trailer, and `git log` reads of a shallow or grafted clone yield no `%ct` at
all. Absence is skipped, presence is enforced.
*/
import type { Task } from "@fusion/core";

/**
 * Project-identity trailer key. Deliberately NOT added to `taskAttributionTrailerNames` /
 * `genericCommitTrailerPattern`, which are the bare-id parsers that must keep resolving with no
 * project context; those stay a candidate generator, this key is an evidence gate.
 */
export const FUSION_PROJECT_ID_TRAILER_KEY = "Fusion-Project-Id";

/** The two ownership refusals this module can raise. `null` means "not refused". */
export type CommitOwnershipRefusal = "foreign-project" | "anachronistic" | null;

export interface CommitTrailerFacts {
  subject: string;
  body: string;
  /** Committer time in epoch MILLISECONDS (`%ct` x 1000); `null` when unreadable. */
  committerEpochMs: number | null;
}

/**
 * The two facts a delivery proof must carry to ask the ownership question honestly. Both are
 * optional by design: an unknown project namespace or an unreadable card birth time SKIPS its
 * check instead of refusing, so a lane that cannot answer never converts its own blindness into a
 * verdict about someone else's commit.
 */
export interface CommitOwnershipProofContext {
  /** This board's namespace (`store.getProjectId()`), `null`/omitted when unresolvable. */
  projectNamespace?: string | null;
  /** The owning card's `createdAt` in epoch ms, `null`/omitted when unknown. */
  taskCreatedAtMs?: number | null;
}

export interface CommitOwnershipEvidence {
  /** The card the commit claims, already line-anchored or subject-anchored by the caller. */
  taskId: string;
  /** `task.createdAt` in epoch ms; `null` when the task or its birth time is unknown. */
  taskCreatedAtMs: number | null;
  /** Current project namespace (`store.getProjectId()`), `null` when unresolvable. */
  projectNamespace: string | null;
}

/**
 * Read the declared project identity from a commit body. Line-anchored like every other Fusion
 * trailer rule, so prose that merely mentions the key is not identity. An empty value is NOT
 * identity: a surface that does not know its project must omit the trailer rather than emit
 * `Fusion-Project-Id:`, because an empty value would later read as "declares no project" and be
 * skipped exactly like the trailer's absence, making the two states indistinguishable.
 */
export function parseCommitProjectId(body: string): string | null {
  const match = new RegExp(
    `(?:^|\\n)${FUSION_PROJECT_ID_TRAILER_KEY}: *([^\\r\\n]+)\\s*(?:\\n|$)`,
  ).exec(body);
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : null;
}

/** True when the commit explicitly declares a project other than the one asking. */
export function commitDeclaresForeignProject(body: string, projectNamespace: string | null): boolean {
  if (!projectNamespace) return false; // Nobody can answer the question: skip, never refuse.
  const declared = parseCommitProjectId(body);
  if (!declared) return false; // Legacy commit: the key did not exist when it was written.
  return declared !== projectNamespace;
}

/**
 * FNXC:CommitOwnership 2026-11-19-17:38 (RUFU-394):
 * How far a commit's committer stamp may precede the card's `createdAt` and still count as that
 * card's work. This is deliberately NOT `TRAILER_SCAN_CLOCK_SKEW_MS` (24 h): that figure bounds how
 * FAR BACK a trailer scan may look, which is a different question from "could this commit have been
 * written by this card at all", and reusing it here would leave the measured defect unrefused — the
 * two `RUFU-391` commits on `main` were committed 2h46m and 2h47m before that card's row existed.
 * The two stamps are taken on the same clock in the normal case (the engine writes the row, the
 * worktree's git writes the commit), so the slack only has to absorb a skewed or multi-host clock,
 * and 15 minutes does that while keeping every hours-scale invention inside the refusal. The bound is
 * calibrated from a measured legitimate case, not rounded: `583b25f504` (`fix(RUFU-390)`, this card's
 * OWN landing) carries a committer stamp 9 m 01 s before its card row (`createdAt`
 * 2026-09-28T08:54:34.245Z, commit 08:45:33Z), so a tighter bound would refuse a real delivery while
 * the 2h46m invention stays refused. One exported constant, so no delivery proof can pick its own
 * bound; pass it explicitly to `commitPredatesTaskBirth` rather than re-declaring it at a call site.
 */
export const COMMIT_BIRTH_CLOCK_SKEW_MS = 15 * 60 * 1_000;

/**
 * True when the commit's committer time predates the card's creation by more than `toleranceMs`.
 * Every delivery proof passes `COMMIT_BIRTH_CLOCK_SKEW_MS` (declared above) — the bound is one
 * number for the whole product, and a per-site tolerance is how a proof quietly stops meaning
 * anything. The value arrives as a parameter rather than being read here so this leaf keeps zero
 * runtime imports.
 *
 * Committer time, never author time: rebase and cherry-pick rewrite the committer stamp and leave
 * the author stamp alone, which is exactly why a rebased or re-attributed commit stays valid here
 * while a stamp written before the card existed cannot be.
 */
export function commitPredatesTaskBirth(
  committerEpochMs: number | null,
  taskCreatedAtMs: number | null,
  toleranceMs: number,
): boolean {
  if (committerEpochMs === null || taskCreatedAtMs === null) return false;
  if (!Number.isFinite(committerEpochMs) || !Number.isFinite(taskCreatedAtMs)) return false;
  return committerEpochMs < taskCreatedAtMs - toleranceMs;
}

/**
 * The shared ownership anchor's refusal decision. Order is project then birth: a commit authored
 * under another project's identity is foreign regardless of when it was written, and the project
 * check is the cheaper one.
 */
export function evaluateCommitOwnershipRefusal(
  evidence: CommitOwnershipEvidence,
  facts: Pick<CommitTrailerFacts, "body" | "committerEpochMs">,
  toleranceMs: number,
): CommitOwnershipRefusal {
  if (commitDeclaresForeignProject(facts.body, evidence.projectNamespace)) return "foreign-project";
  if (commitPredatesTaskBirth(facts.committerEpochMs, evidence.taskCreatedAtMs, toleranceMs)) {
    return "anachronistic";
  }
  return null;
}

/** `task.createdAt` is an ISO string on the Task row; anything unparseable is unknown, not zero. */
export function taskBirthMs(task: Pick<Task, "createdAt"> | null | undefined): number | null {
  const raw = task?.createdAt;
  if (!raw) return null;
  const ms = typeof raw === "number" ? raw : Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * One builder for the trailer block every emitting surface appends, so the key spelling cannot
 * drift between the `commit-msg` hook, a squash publish, and a revert commit. Unknown identity is
 * OMITTED (see the empty-value rule on `parseCommitProjectId`).
 */
export function buildFusionCommitTrailers(input: {
  taskId?: string | null;
  projectId?: string | null;
}): string[] {
  const lines: string[] = [];
  if (input.taskId && input.taskId.trim().length > 0) lines.push(`Fusion-Task-Id: ${input.taskId.trim()}`);
  if (input.projectId && input.projectId.trim().length > 0) {
    lines.push(`${FUSION_PROJECT_ID_TRAILER_KEY}: ${input.projectId.trim()}`);
  }
  return lines;
}

/**
 * The `%ct` field a delivery-proof `git log` must request to be able to answer the anachronism
 * question. Spelled once so a proof cannot silently lose the clock by asking for a different
 * format string.
 */
export const COMMIT_EPOCH_FORMAT_FIELD = "%ct";

/*
FNXC:CommitOwnership 2026-11-19-15:48:
One accessor for "which project am I?" across emitting surfaces. A lane may hold a store-shaped
object that is NOT a real store: `step-session-executor` falls back to a `NOOP_TASK_STORE` cast,
so `getProjectId` can be absent or throw. Every such shape resolves to `null`, which means
"identity unknown, omit the trailer / skip the project check". Written once because the failure
mode of getting it wrong per site is asymmetric: a site that throws while asking takes down the
commit it was only trying to label.
*/
export function resolveProjectNamespace(store: unknown): string | null {
  if (!store || typeof store !== "object") return null;
  const candidate = store as { getProjectId?: unknown };
  if (typeof candidate.getProjectId !== "function") return null;
  try {
    const projectId = (candidate.getProjectId as () => unknown)();
    const trimmed = typeof projectId === "string" ? projectId.trim() : "";
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
