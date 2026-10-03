import { existsSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  isLegacyWorkspaceWorktreeLayout,
  isStrictDescendantPath,
  isUncommittedWorkHold,
  resolveWorkspaceTaskWorktreeDir,
  type Settings,
  type Task,
  type TaskStore,
} from "@fusion/core";
import type { RunAuditor } from "../util/run-audit.js";
import {
  ActiveSessionWorktreeRemovalError,
  RemovalReason,
  removeWorktree,
} from "../worktree/worktree-backend.js";
import type { MergeWriteFence } from "./merge-write-fence.js";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
import { canonicalizePath } from "../worktree/worktree-pool.js";
import {
  cleanupRegistrationsUnderRemovedWorktree,
  type ContainedRegistrationCleanup,
  type RegistrationLister,
} from "../worktree/worktree-nested-registrations.js";

export type LandedWorktreeCleanupOutcome =
  | "removed"
  | "nothing-to-remove"
  | "preserved-deliverable"
  | "preserved-unverifiable"
  | "preserved-active-session";

type LandedWorktreeCleanupStore = Pick<TaskStore, "updateTask" | "logEntry"> & Partial<Pick<TaskStore, "getSettings">>;

export interface CleanupLandedTaskWorktreeInput {
  store: LandedWorktreeCleanupStore;
  taskId: string;
  worktreePath: string | null | undefined;
  rootDir: string | null | undefined;
  landedSha?: string;
  source: string;
  audit?: RunAuditor;
  log?: (message: string) => void | Promise<void>;
  fence?: Pick<MergeWriteFence, "assertOwned">;
  /**
   * The live task row when the caller has one (every finalization lane does). Only
   * `mergeDetails.uncommittedWorkHold` is read — the durable anti-proof that makes a cleanup refuse.
   */
  task?: Pick<Task, "mergeDetails">;
  /**
   * RUFU-290 seams for the nested-registration leg: injection points so a mocked lane needs neither git
   * nor the filesystem. Production leaves them unset and the helper shells out to real git.
   */
  nestedRegistrationSeams?: LandedNestedRegistrationSeams;
}

/*
FNXC:ZeroCommitDeliveryProof 2026-09-27-01:01 (RUFU-274 Step 5):
Cleanup is the last door a refused card can still be destroyed through, so both entry points demand the
same proof the finalization doors demand — expressed here as the anti-proof that is cheapest to test. A row
carrying the durable `uncommittedWorkHold` marker has ALREADY been found to hold undelivered content, and no
`landedSha` a caller presents can outrank that finding: the sha an empty landing records is proof of a
no-op, never of delivered content. FN-251 already refuses to delete `deliverable` or unverifiable content;
this closes the residue where a lane could still reach cleanup with a hold stamped — a later lane that never
re-ran the guard, a manual cleanup, or a card whose hold a sibling door wrote — without re-probing git on a
path FN-251 deliberately keeps cheap.
The vocabulary reuses `preserved-unverifiable` with a `delivery-unproven` reason: the tree is not called
damaged, it is called NOT SHOWN DELIVERED, which is the class FN-251 already preserves for.
*/
function deliveryUnprovenPreservation(
  input: Pick<CleanupLandedTaskWorktreeInput, "store" | "taskId" | "log">,
  worktreePath: string,
): Pick<CleanupLandedTaskWorktreeResult, "outcome" | "preservedReason"> {
  void recordPreservedOutcome(input, worktreePath, {
    outcome: "preserved-unverifiable",
    preservedReason: "delivery-unproven: undelivered work is held for manual merge",
  });
  return { outcome: "preserved-unverifiable", preservedReason: "delivery-unproven" };
}

export interface CleanupLandedTaskWorktreeResult {
  outcome: LandedWorktreeCleanupOutcome;
  removed: boolean;
  preservedReason?: string;
  /** Present only when the pass actually saw a registration under the removed worktree (RUFU-290). */
  nestedRegistrations?: LandedNestedRegistrations;
}

/** Injection seams for the nested-registration leg, so a mocked landing needs neither git nor disk. */
export interface LandedNestedRegistrationSeams {
  listRegistrations?: RegistrationLister;
  pathExists?: (path: string) => boolean;
  mtimeMs?: (path: string) => number | null;
  removeRegistration?: (path: string) => Promise<void>;
  /**
   * Directory sweep for a child whose registration removal succeeded but whose tree is still on disk.
   * Injectable because this file's lane mocks `node:fs` down to the two calls it already used, and the
   * default goes through `rmSync`.
   */
  removeDirectory?: (path: string) => Promise<boolean>;
  pruneAdminEntries?: () => Promise<void>;
}

/** What the nested leg found and did, reported on the cleanup result (RUFU-290). */
export interface LandedNestedRegistrations {
  found: number;
  removed: number;
  residuePruned: number;
  remaining: number;
}

function nestedSummary(cleanup: ContainedRegistrationCleanup): LandedNestedRegistrations {
  return {
    found: cleanup.found,
    removed: cleanup.removed,
    residuePruned: cleanup.residuePruned,
    remaining: cleanup.remaining,
  };
}

function combineNestedRegistrations(passes: readonly LandedNestedRegistrations[]): LandedNestedRegistrations | undefined {
  if (passes.length === 0) return undefined;
  return passes.reduce(
    (totals, pass) => ({
      found: totals.found + pass.found,
      removed: totals.removed + pass.removed,
      residuePruned: totals.residuePruned + pass.residuePruned,
      remaining: totals.remaining + pass.remaining,
    }),
    { found: 0, removed: 0, residuePruned: 0, remaining: 0 },
  );
}

function preservedOutcomeFor(error: unknown): Pick<CleanupLandedTaskWorktreeResult, "outcome" | "preservedReason"> {
  if (error instanceof ActiveSessionWorktreeRemovalError) {
    return { outcome: "preserved-active-session", preservedReason: "active-session" };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(": status probe failed (")) {
    return { outcome: "preserved-unverifiable", preservedReason: "unverifiable" };
  }
  return { outcome: "preserved-deliverable", preservedReason: "deliverable" };
}

async function recordPreservedOutcome(
  input: Pick<CleanupLandedTaskWorktreeInput, "store" | "taskId" | "log">,
  worktreePath: string,
  result: Pick<CleanupLandedTaskWorktreeResult, "outcome" | "preservedReason">,
): Promise<void> {
  const message = `Post-landing worktree cleanup preserved ${worktreePath}: ${result.preservedReason ?? result.outcome}`;
  try {
    if (input.log) {
      await input.log(message);
      return;
    }
    await input.store.logEntry(
      input.taskId,
      "Post-landing worktree cleanup preserved",
      message,
    );
  } catch {
    // Cleanup observability must not turn a durable landing into a failed merge.
  }
}

async function recordPointerClearPending(
  input: CleanupLandedTaskWorktreeInput,
  worktreePath: string,
  error: unknown,
): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error);
  const message = `Post-landing worktree cleanup removed ${worktreePath}, but clearing the task worktree pointer is pending: ${detail}`;
  try {
    if (input.log) {
      await input.log(message);
      return;
    }
    await input.store.logEntry(
      input.taskId,
      "Post-landing worktree cleanup pointer clear pending",
      message,
    );
  } catch {
    // Cleanup observability must not turn a durable landing into a failed merge.
  }
}

/*
FNXC:WorktreeCleanup 2026-08-29-01:50:
FN-251's removed outcome requires both filesystem deletion and a cleared durable worktree pointer.
A transient pointer write failure stays non-fatal after a proven landing, but is recorded and retried
when convergence encounters the now-absent path instead of falsely reporting successful cleanup.
*/
async function clearWorktreePointer(
  input: CleanupLandedTaskWorktreeInput,
  worktreePath: string,
): Promise<boolean> {
  input.fence?.assertOwned("finalization");
  try {
    await input.store.updateTask(input.taskId, { worktree: null });
    return true;
  } catch (error) {
    await recordPointerClearPending(input, worktreePath, error);
    return false;
  }
}

/**
 * FNXC:WorktreeCleanup 2026-08-29-00:54:
 * FN-251 makes cleanup a proof-gated, non-fatal pre-completion action. A durable landing may discard
 * only ignored-only content; deliverable, unverifiable, and active-session worktrees stay intact and
 * are recorded so completion never retries or misreports an already-landed merge as a failure.
 */
export async function cleanupLandedTaskWorktree(
  input: CleanupLandedTaskWorktreeInput,
): Promise<CleanupLandedTaskWorktreeResult> {
  const worktreePath = input.worktreePath;
  if (!worktreePath || !input.rootDir) {
    return { outcome: "nothing-to-remove", removed: false };
  }
  if (isUncommittedWorkHold(input.task?.mergeDetails)) {
    const preserved = deliveryUnprovenPreservation(input, worktreePath);
    return { ...preserved, removed: false };
  }
  if (!existsSync(worktreePath)) {
    await clearWorktreePointer(input, worktreePath);
    return { outcome: "nothing-to-remove", removed: false };
  }

  let settings = {};
  try {
    if (typeof input.store.getSettings === "function") {
      settings = await input.store.getSettings();
    }
  } catch (error) {
    const result = preservedOutcomeFor(new Error(`preserving ${worktreePath}: status probe failed (${error instanceof Error ? error.message : String(error)})`));
    await recordPreservedOutcome(input, worktreePath, result);
    return { ...result, removed: false };
  }

  let removal: Awaited<ReturnType<typeof removeWorktree>>;
  try {
    removal = await removeWorktree({
      rootDir: input.rootDir,
      worktreePath,
      settings,
      taskId: input.taskId,
      audit: input.audit,
      reason: RemovalReason.CompletionLandedCleanup,
      postLandingProof: { landedSha: input.landedSha, source: input.source },
    });
  } catch (error) {
    const result = preservedOutcomeFor(error);
    await recordPreservedOutcome(input, worktreePath, result);
    return { ...result, removed: false };
  }

  if (!removal.removed) {
    return { outcome: "nothing-to-remove", removed: false };
  }

  if (!await clearWorktreePointer(input, worktreePath)) {
    return { outcome: "nothing-to-remove", removed: false };
  }
  const nested = await reapNestedRegistrationsAfterRemoval(input, worktreePath);
  return nested ? { outcome: "removed", removed: true, nestedRegistrations: nested } : { outcome: "removed", removed: true };
}

/*
FNXC:WorktreeCleanup 2026-10-02-19:20 (RUFU-290):
A task worktree could be removed by a proven landing while a registration nested inside it survived,
because the shared backend's forced parent removal (measured against real git) deletes the parent tree
recursively WITHOUT deregistering a child worktree below it, and the scratch sweep's containment is
clean-room roots plus `os.tmpdir()` prefixes — a task worktree path is neither, so nothing enumerated
the child. This leg closes the same leak on the landing door: containment is the removed path itself and
only registrations strictly below it are eligible. It runs AFTER the parent removal and the pointer clear,
so a worktree kept by any existing gate (deliverable, unverifiable, active session) is never touched, and
the nested live-session veto stays for a child a session is still driving.

A failure here must never reopen a landing that already succeeded: the commits are on the default branch,
so a child that cannot be reaped is recorded for the next pass rather than turned into a merge failure or
a backward card move.
*/
async function reapNestedRegistrationsAfterRemoval(
  input: Pick<CleanupLandedTaskWorktreeInput, "store" | "taskId" | "rootDir" | "audit" | "log" | "nestedRegistrationSeams">,
  worktreePath: string,
): Promise<LandedNestedRegistrations | undefined> {
  if (!input.rootDir) return undefined;
  const seams = input.nestedRegistrationSeams ?? {};
  try {
    const cleanup = await cleanupRegistrationsUnderRemovedWorktree({
      rootDir: input.rootDir,
      removedWorktreePath: worktreePath,
      isPathActive: (path) => activeSessionRegistry.isPathActive(path) || activeSessionRegistry.isPathActive(canonicalizePath(path)),
      listRegistrations: seams.listRegistrations,
      /*
      FNXC:WorktreeCleanup 2026-10-02-20:20 (RUFU-290):
      The lane states its own existence probe. This function decides a path is already gone with
      `existsSync` (see the `nothing-to-remove` branch above), so the nested leg must answer the same
      question with the same primitive: a second, `statSync`-based probe can disagree about a path the
      lane just acted on — and a child the lane believes present but the probe calls missing is
      reclassified as registration-only residue, which skips the age and live-session vetoes entirely.
      */
      pathExists: seams.pathExists ?? existsSync,
      mtimeMs: seams.mtimeMs,
      removeRegistration: seams.removeRegistration,
      removeDirectory: seams.removeDirectory,
      pruneAdminEntries: seams.pruneAdminEntries,
    });

    if (cleanup.found === 0) return undefined;

    const deferredDecision = cleanup.decisions.find(
      (decision): decision is Extract<ContainedRegistrationCleanup["decisions"][number], { outcome: "deferred" }> =>
        decision.outcome === "deferred",
    );
    /*
    FNXC:RunAudit 2026-10-02-19:35 (RUFU-290): the landing lane reports through the lane's own
    `RunAuditor` (which is already sink-failure-swallowing per FN-9175) rather than handing the helper a
    second `emitBoundedRunAudit` host. One row per landing pass carries the full tally, and the cleanup
    `store` type is deliberately narrower than a run-audit sink host — widening it to satisfy a
    redundant emit would claim a capability the cleanup entry points never required.
    */
    await input.audit?.git({
      type: "worktree:post-landing-nested-registration",
      target: `task:${input.taskId}`,
      metadata: {
        foundCount: cleanup.found,
        removedCount: cleanup.removed,
        residuePrunedCount: cleanup.residuePruned,
        residueRemainingCount: cleanup.remaining,
        failedCount: cleanup.failed,
        deferredCount: cleanup.deferred,
        ...(deferredDecision ? { deferredReason: deferredDecision.deferredReason } : {}),
        /*
        FNXC:RunAudit 2026-10-02-20:30 (RUFU-290):
        Precedence is failure > deferral > residue, and the deferral test has to come before the residue
        test: a child a live session is still driving is ALSO counted in `residueRemainingCount`, so a
        `remaining > 0` first would report every deliberate wait as `partial` and an operator querying
        `outcome="deferred"` would find nothing. `partial` then means exactly what an operator must act
        on — a removal this pass attempted and could not complete.
        */
        outcome: cleanup.failed > 0
          ? "partial"
          : cleanup.deferred > 0
            ? "deferred"
            : cleanup.remaining > 0
              ? "partial"
              : "cleared",
      },
    });
    await recordNestedCleanupNote(
      input,
      `nested registrations under ${worktreePath}: found ${cleanup.found}, removed ${cleanup.removed}, pruned ${cleanup.residuePruned}, remaining ${cleanup.remaining}`,
    );
    return nestedSummary(cleanup);
  } catch (error) {
    await recordNestedCleanupNote(input, `nested registration cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** Observability only: a log line that itself fails must not change the landing outcome. */
async function recordNestedCleanupNote(
  input: Pick<CleanupLandedTaskWorktreeInput, "store" | "taskId" | "log">,
  message: string,
): Promise<void> {
  try {
    if (input.log) {
      await input.log(message);
      return;
    }
    await input.store.logEntry(input.taskId, "Post-landing nested registration cleanup", message);
  } catch {
    // Cleanup observability must not turn a durable landing into a failed merge.
  }
}

export interface CleanupLandedWorkspaceTaskWorktreesInput {
  store: LandedWorktreeCleanupStore;
  task: Pick<Task, "id" | "workspaceWorktrees" | "mergeDetails">;
  workspaceRootDir: string;
  landedShas?: Record<string, string | undefined>;
  source: string;
  audit?: RunAuditor;
  log?: (message: string) => void | Promise<void>;
  fence?: Pick<MergeWriteFence, "assertOwned">;
  /** RUFU-290 seams for the nested-registration leg, applied per removed member repository. */
  nestedRegistrationSeams?: LandedNestedRegistrationSeams;
}

export interface WorkspaceLandedWorktreePreservation {
  repoRel: string;
  worktreePath: string;
  outcome: Extract<LandedWorktreeCleanupOutcome, "preserved-deliverable" | "preserved-unverifiable" | "preserved-active-session">;
  reason: string;
}

export interface CleanupLandedWorkspaceTaskWorktreesResult {
  removedRepoRels: string[];
  preserved: WorkspaceLandedWorktreePreservation[];
  taskDirectoryRemoved: boolean;
  removed: boolean;
  /** Totals across every removed member repository (RUFU-290); absent when nothing was found. */
  nestedRegistrations?: LandedNestedRegistrations;
}

type WorkspacePathOutcome =
  | { kind: "settled"; removed: boolean }
  | { kind: "preserved"; outcome: WorkspaceLandedWorktreePreservation["outcome"]; reason: string };

/*
FNXC:WorktreeCleanup 2026-08-30-15:06:
Workspace post-landing cleanup applies the same proof-gated removal as singular finalization.
Recorded child paths stay durable after removal because the terminal workspace sweep still needs
those paths to delete the matching task branches; only empty directory shells are retired here.
*/
export async function cleanupLandedWorkspaceTaskWorktrees(
  input: CleanupLandedWorkspaceTaskWorktreesInput,
): Promise<CleanupLandedWorkspaceTaskWorktreesResult> {
  const entries = Object.entries(input.task.workspaceWorktrees ?? {})
    .filter(([, entry]) => Boolean(entry.worktreePath));
  const result: CleanupLandedWorkspaceTaskWorktreesResult = {
    removedRepoRels: [],
    preserved: [],
    taskDirectoryRemoved: false,
    removed: false,
  };
  const logInput = { ...input, taskId: input.task.id };
  if (entries.length === 0) return result;

  /*
  FNXC:ZeroCommitDeliveryProof 2026-09-27-01:01 (RUFU-274 Step 5):
  Same anti-proof gate as the singular entry point, evaluated once for the whole workspace: a hold stamped
  on the row means at least one repository's content is already known to be undelivered, so no sub-repo
  checkout is disposable on a landing sha that may itself came from an empty land.
  */
  if (isUncommittedWorkHold(input.task.mergeDetails)) {
    for (const [repoRel, entry] of entries) {
      const preserved = deliveryUnprovenPreservation(logInput, entry.worktreePath);
      result.preserved.push({
        repoRel,
        worktreePath: entry.worktreePath,
        outcome: "preserved-unverifiable",
        reason: preserved.preservedReason ?? "delivery-unproven",
      });
    }
    return result;
  }

  let settings: Settings = {} as Settings;
  try {
    if (typeof input.store.getSettings === "function") settings = await input.store.getSettings();
  } catch (error) {
    for (const [repoRel, entry] of entries) {
      const worktreePath = entry.worktreePath;
      const preserved = preservedOutcomeFor(new Error(`preserving ${worktreePath}: status probe failed (${error instanceof Error ? error.message : String(error)})`));
      await recordPreservedOutcome(logInput, worktreePath, preserved);
      result.preserved.push({ repoRel, worktreePath, outcome: preserved.outcome as WorkspaceLandedWorktreePreservation["outcome"], reason: preserved.preservedReason ?? "unverifiable" });
    }
    return result;
  }

  const outcomes = new Map<string, WorkspacePathOutcome>();
  const nestedPasses: LandedNestedRegistrations[] = [];
  for (const [, entry] of entries) {
    const worktreePath = entry.worktreePath;
    const key = canonicalizePath(worktreePath);
    if (outcomes.has(key)) continue;
    // One member's canonical path can be shared by two entries; the first entry owns its repository root.
    const ownerRepoRel = entries.find(([, candidate]) => canonicalizePath(candidate.worktreePath) === key)?.[0] ?? "";

    if (!existsSync(worktreePath)) {
      outcomes.set(key, { kind: "settled", removed: false });
      continue;
    }
    if (activeSessionRegistry.isPathActive(worktreePath) || activeSessionRegistry.isPathActive(key)) {
      const preservation: WorkspacePathOutcome = { kind: "preserved", outcome: "preserved-active-session", reason: "active-session" };
      outcomes.set(key, preservation);
      await recordPreservedOutcome(logInput, worktreePath, { outcome: preservation.outcome, preservedReason: preservation.reason });
      continue;
    }

    try {
      input.fence?.assertOwned("finalization");
      const memberRootDir = join(input.workspaceRootDir, ownerRepoRel);
      const removal = await removeWorktree({
        rootDir: memberRootDir,
        worktreePath,
        settings,
        taskId: input.task.id,
        audit: input.audit,
        reason: RemovalReason.CompletionLandedCleanup,
        postLandingProof: {
          landedSha: input.landedShas?.[ownerRepoRel],
          source: input.source,
        },
      });
      outcomes.set(key, { kind: "settled", removed: removal.removed });
      if (removal.removed) {
        const nested = await reapNestedRegistrationsAfterRemoval(
          {
            store: input.store,
            taskId: input.task.id,
            rootDir: memberRootDir,
            audit: input.audit,
            log: input.log,
            nestedRegistrationSeams: input.nestedRegistrationSeams,
          },
          worktreePath,
        );
        if (nested) nestedPasses.push(nested);
      }
    } catch (error) {
      const preserved = preservedOutcomeFor(error);
      const preservation: WorkspacePathOutcome = {
        kind: "preserved",
        outcome: preserved.outcome as WorkspaceLandedWorktreePreservation["outcome"],
        reason: preserved.preservedReason ?? "deliverable",
      };
      outcomes.set(key, preservation);
      await recordPreservedOutcome(logInput, worktreePath, preserved);
    }
  }

  let everyEntrySettled = true;
  for (const [repoRel, entry] of entries) {
    const pathOutcome = outcomes.get(canonicalizePath(entry.worktreePath))!;
    if (pathOutcome.kind === "preserved") {
      everyEntrySettled = false;
      result.preserved.push({ repoRel, worktreePath: entry.worktreePath, outcome: pathOutcome.outcome, reason: pathOutcome.reason });
    } else if (pathOutcome.removed) {
      result.removedRepoRels.push(repoRel);
    }
  }
  result.removed = result.removedRepoRels.length > 0;

  /*
  FNXC:WorktreeCleanup 2026-10-02-20:40 (RUFU-290):
  The nested tally is reported BEFORE the task-directory retirement branches. A workspace delivers as one
  unit, so one preserved repository stops the whole retirement — but a sibling repository WAS removed
  above, and any registration its forced removal left behind is a leak the caller still has to see.
  Reporting only on the fully-settled path would hide exactly the partial landing an operator inspects.
  */
  const nestedTotals = combineNestedRegistrations(nestedPasses);
  if (nestedTotals) result.nestedRegistrations = nestedTotals;

  const taskDir = resolveWorkspaceTaskWorktreeDir(input.workspaceRootDir, settings, input.task.id);
  if (!everyEntrySettled || isLegacyWorkspaceWorktreeLayout(input.task, taskDir)) return result;

  result.taskDirectoryRemoved = removeEmptyWorkspaceTaskDirectory(taskDir, entries.map(([, entry]) => entry.worktreePath));
  result.removed = result.removed || result.taskDirectoryRemoved;
  return result;
}

/**
 * Removes only empty workspace task-directory shells. Any unexpected residue
 * fails closed because neither the parents nor the task directory are removed
 * recursively.
 */
export function removeEmptyWorkspaceTaskDirectory(taskDir: string, worktreePaths: string[]): boolean {
  for (const worktreePath of worktreePaths) {
    let parent = dirname(worktreePath);
    while (isStrictDescendantPath(taskDir, parent)) {
      try {
        rmdirSync(parent);
      } catch {
        break;
      }
      parent = dirname(parent);
    }
  }
  try {
    rmdirSync(taskDir);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  }
}
