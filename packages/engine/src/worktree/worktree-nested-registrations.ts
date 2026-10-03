/*
FNXC:TempWorktreeSweep 2026-10-02-16:05 (RUFU-290):
Registration-driven discovery and deepest-first removal for Git worktree registrations that live
INSIDE a Fusion scratch clean-room directory.

The stale-temp-merge sweep used to enumerate garbage with a non-recursive `readdirSync` of each
scratch root, so a worktree registered inside a scratch tree — an agent shell whose cwd was the
clean-room ran `git worktree add` with a RELATIVE path and landed under
`<scratch>/.fusion/worktrees/.ai-merge/probe-main` — was never enumerated and outlived its parent as
a phantom entry in `git worktree list`. Only the registration inventory can see that shape, so
discovery here reads `git worktree list --porcelain` (via `describeRegisteredWorktrees`) instead of
the filesystem.

Two properties make that inventory safe to act on:

1. CONTAINMENT, NOT NAME. The registration list is strictly wider than Fusion's scratch namespace
   (main checkout, task and pool worktrees, anything the repo ever registered). Authority is
   recursive under a dedicated clean-room root: a path strictly under `.fusion/worktrees/.ai-merge`
   is a clean-room artifact by construction whatever it is called — the leaked children were named
   `probe-main`, which is exactly why a prefix filter could not find them. `tmpdir()` is the
   opposite: a shared namespace other processes own parts of, so it keeps the legacy reach of a
   DIRECT child matching a known scratch prefix and nothing deeper. A scratch-shaped registration
   outside every authority is reported (`outside-authority`) rather than ignored, because this sweep
   is the only out-of-process reaper and an operator needs to see "found, not authorized" instead of
   silence that looks like cleanup.
2. DEEPEST-FIRST. A parent clean-room directory cannot be reaped while a child registration still
   points inside it (`git worktree remove` on the parent would leave the child orphaned, which is
   the leak this module exists to close), so candidates are ordered by path depth descending and the
   caller runs this pass BEFORE its own enumeration loop.

A registration whose directory is already gone is NOT removed by filesystem means — only
`git worktree prune` clears that record, so it is returned as `residue` for the caller's prune call.
 */
import { exec } from "node:child_process";
import { rmSync, statSync } from "node:fs";
import { dirname, sep } from "node:path";
import { promisify } from "node:util";

import { isStrictDescendantPath } from "@fusion/core";

import { emitBoundedRunAudit, type RunAuditSinkHost } from "../util/emit-bounded-run-audit.js";
import { AI_MERGE_DIRNAME } from "./worktree-paths.js";
import { removeDirectoryWithRetry } from "./worktree-removal-retry.js";
import { canonicalizePath, describeRegisteredWorktrees } from "./worktree-pool.js";

const execAsync = promisify(exec);
const GIT_WORKTREE_REMOVE_TIMEOUT_MS = 120_000;
const GIT_WORKTREE_REMOVE_MAX_BUFFER = 10 * 1024 * 1024;

/** Prefixes the temp-merge sweep reaps anywhere under a dedicated clean-room root. */
export const TEMP_MERGE_SWEEP_PREFIXES = ["fusion-ai-merge-"] as const;
/** Extra prefixes for the shared `tmpdir()` root, which older engine versions wrote checkouts into. */
export const TMPDIR_SWEEP_PREFIXES = ["fusion-ai-merge-", "fn-verify-"] as const;

/** Which authority admitted a candidate; drives audit attribution, never a path. */
export type TempSweepAuthority = "clean-room-root" | "tmpdir";

/**
 * Which authority admitted a nested candidate.
 *
 * `task-worktree` is NOT a scratch authority: it is the landing lane, whose containment is the single
 * task worktree path it just proved disposable and removed. Sharing the scratch enum would have
 * attributed a landed card's cleanup to `clean-room-root` in the audit store, which is a different
 * containment rule with different gates.
 */
export type NestedRegistrationAuthority = TempSweepAuthority | "task-worktree";

/** A registration path classified against Fusion's scratch authorities. */
export type TempSweepRegistration =
  | { kind: "candidate"; path: string; entry: string; authority: TempSweepAuthority; /** Directory already gone: registration-only residue. */ phantom: boolean }
  | { kind: "outside-authority"; path: string; entry: string }
  | { kind: "unrelated"; path: string };

/** Injectable registration inventory; the default reads `git worktree list --porcelain`. */
export type RegistrationLister = (rootDir: string) => Promise<string[]>;

const defaultListRegistrations: RegistrationLister = async (rootDir) =>
  (await describeRegisteredWorktrees(rootDir)).canonicalized;

/**
 * Classifies every registered worktree against the sweep's scratch authorities.
 *
 * Authority is recursive for a dedicated clean-room root and one level deep for `tmpdir()`; the
 * roots themselves are never candidates (the caller's enumeration loop owns container directories).
 */
export function classifyTempSweepRegistrations(input: {
  /** Registered worktree paths, canonicalized by the caller (`describeRegisteredWorktrees`). */
  registered: readonly string[];
  /** Canonicalized clean-room roots (`resolveAiMergeSearchRoots`); recursive authority. */
  cleanRoomRoots: readonly string[];
  /** Canonicalized `tmpdir()`; authority reaches only its direct children. */
  tmpRoot: string;
  /** Injected so the classifier stays pure and a phantom registration needs no fs access. */
  pathExists: (path: string) => boolean;
}): TempSweepRegistration[] {
  const cleanRoomRoots = [...new Set(input.cleanRoomRoots.filter((root) => root.length > 0))];
  const tmpRoot = input.tmpRoot;

  return input.registered.map((path): TempSweepRegistration => {
    const segments = path.split(sep).filter(Boolean);
    const entry = segments.at(-1) ?? path;
    const isPhantom = !input.pathExists(path);

    const cleanRoomRoot = cleanRoomRoots.find((root) => isStrictDescendantPath(root, path));
    if (cleanRoomRoot) return { kind: "candidate", path, entry, authority: "clean-room-root", phantom: isPhantom };
    if (dirname(path) === tmpRoot && TMPDIR_SWEEP_PREFIXES.some((prefix) => entry.startsWith(prefix))) {
      return { kind: "candidate", path, entry, authority: "tmpdir", phantom: isPhantom };
    }
    if (isScratchShapedRegistration(path, entry)) return { kind: "outside-authority", path, entry };
    return { kind: "unrelated", path };
  });
}

/** Looks like Fusion scratch by name or by an `.ai-merge` path segment, but sits outside every authority. */
function isScratchShapedRegistration(path: string, entry: string): boolean {
  return TEMP_MERGE_SWEEP_PREFIXES.some((prefix) => entry.startsWith(prefix))
    || TMPDIR_SWEEP_PREFIXES.some((prefix) => entry.startsWith(prefix))
    || path.split(sep).includes(AI_MERGE_DIRNAME);
}

/** Path depth wins so a parent clean-room directory is always handled after everything inside it. */
export function sortRegistrationsDeepestFirst(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort((a, b) => {
    const depthDiff = pathDepth(b) - pathDepth(a);
    if (depthDiff !== 0) return depthDiff;
    return a < b ? 1 : a > b ? -1 : 0;
  });
}

function pathDepth(path: string): number {
  return path.split(sep).filter(Boolean).length;
}

/** True when the path sits deeper than a direct child of any authorized scratch root. */
export function isNestedBelowScratchRoot(path: string, scratchRoots: ReadonlySet<string>): boolean {
  return !scratchRoots.has(dirname(path));
}

/**
 * Nearest ancestor whose parent is one of the scratch roots — i.e. the direct scratch entry that a
 * deeper registration was created inside. Returns null when the path is not under an authorized root.
 */
export function owningScratchEntry(path: string, scratchRoots: ReadonlySet<string>): string | null {
  let current = dirname(path);
  while (current !== sep && current !== dirname(current)) {
    if (scratchRoots.has(current)) return null;
    const parent = dirname(current);
    if (scratchRoots.has(parent)) return current;
    current = parent;
  }
  return null;
}

/**
 * Every registered path strictly inside one of `containerPaths`, deepest-first.
 *
 * Fails closed: an unreadable registration inventory yields no candidates, so a git failure can
 * never turn into a guess about what may be deleted.
 */
export async function findRegistrationsWithin(
  rootDir: string,
  containerPaths: readonly string[],
  options: { listRegistrations?: RegistrationLister; pathExists?: (path: string) => boolean } = {},
): Promise<string[]> {
  const containers = [...new Set(containerPaths.map((container) => canonicalizePath(container)))];
  if (containers.length === 0) return [];
  const listRegistrations = options.listRegistrations ?? defaultListRegistrations;
  let registered: string[];
  try {
    registered = await listRegistrations(rootDir);
  } catch {
    return [];
  }
  const contained = registered.filter((path) => containers.some((container) => isStrictDescendantPath(container, path)));
  return sortRegistrationsDeepestFirst(contained);
}

/** What one nested registration was ultimately judged to be. */
export type NestedRegistrationDecision =
  | { path: string; outcome: "removed"; reason: string }
  | { path: string; outcome: "deferred"; deferredReason: NestedRegistrationDeferralReason }
  | { path: string; outcome: "residue" }
  | { path: string; outcome: "failed"; error: string };

/**
 * `young` is a wait state, not a veto: it counts toward `deferred` and is reported nowhere, exactly
 * like the enumeration sweep's silent sub-age `continue`. Only the two real vetoes get an audit row.
 * It can only ever be reported by a lane that actually required an age: under a zero gate mtime is never
 * consulted (see `removeDescendantRegistrations`), because a nested or landed registration has no later
 * authority to revisit it.
 *
 * FNXC:TempWorktreeSweep 2026-10-02-16:05 (RUFU-290): there is deliberately NO `parent-session-active`
 * reason. `ActiveSessionRegistry.isPathActive` is an exact-path map lookup, and the motivating leak is
 * a nested probe tree left inside a scratch directory that a live merge session is still holding;
 * refusing every child of an active parent would put this whole class back out of reach. The veto is
 * therefore the exact nested path plus the resume reservation, and containment does the rest.
 */
export type NestedRegistrationDeferralReason = "young" | "active-session" | "resume-reserved";

export type NestedRegistrationRemoval = {
  found: number;
  removed: number;
  failed: number;
  deferred: number;
  /** Registrations whose directory is already gone; only `git worktree prune` clears these. */
  residue: string[];
  decisions: NestedRegistrationDecision[];
};

export type RemoveDescendantRegistrationsInput = {
  rootDir: string;
  /** The authority this pass is acting under (audit attribution enum, never a path in metadata). */
  authority: NestedRegistrationAuthority;
  /** Deepest-first candidate paths; when omitted they are discovered from the inventory. */
  descendants?: readonly string[];
  /** Scratch root used for discovery when `descendants` is omitted. */
  containerPath?: string;
  /** Exact-path live-session veto (an in-flight merge owns this worktree). */
  isPathActive: (path: string) => boolean;
  /** Resume-eligibility veto: a worktree a CLI session can resume is not garbage. */
  isResumeReserved?: (path: string) => boolean;
  /** Reap age for one entry name; the caller resolves the task-aware gate (terminal-task grace). */
  ageGateMs: (entry: string) => number | Promise<number>;
  /** Injection seams so the unit seam needs neither git nor the filesystem. */
  listRegistrations?: RegistrationLister;
  pathExists?: (path: string) => boolean;
  mtimeMs?: (path: string) => number | null;
  now?: number;
  removeRegistration?: (path: string) => Promise<void>;
  removeDirectory?: (path: string) => Promise<boolean>;
  /** Bounded best-effort sink for the aggregate counters. */
  auditHost?: RunAuditSinkHost;
  auditRunId?: string;
  /** Lane the aggregate rows are attributed to; defaults to `self-healing` (the scratch sweep). */
  auditAgentId?: string;
  taskId?: string | null;
  /** Path-level reporting, owned by the caller so every scratch row keeps one shape. */
  onDecision?: (decision: NestedRegistrationDecision) => void | Promise<void>;
  log?: (message: string) => void;
};

/**
 * Reaps nested registrations under one scratch root, deepest-first, and reports every judgement.
 *
 * Order matters for the leak this fixes: children are removed before their parent directory, so a
 * parent removal can never succeed while a registration still points inside it, and a child that
 * cannot be reaped defers visibly instead of being silently swallowed by the parent's recursive
 * directory delete.
 */
export async function removeDescendantRegistrations(
  input: RemoveDescendantRegistrationsInput,
): Promise<NestedRegistrationRemoval> {
  const pathExists = input.pathExists ?? existsSyncSafe;
  const mtimeMs = input.mtimeMs ?? statMtimeMs;
  const now = input.now ?? Date.now();
  const listRegistrations = input.listRegistrations ?? defaultListRegistrations;
  const removeRegistration = input.removeRegistration ?? ((path: string) => defaultRemoveRegistration(input.rootDir, path));
  const removeDirectory = input.removeDirectory ?? ((path: string) => defaultRemoveDirectory(path, input.log));

  const descendants = input.descendants
    ? sortRegistrationsDeepestFirst(input.descendants)
    : input.containerPath
      ? await findRegistrationsWithin(input.rootDir, [input.containerPath], { listRegistrations, pathExists })
      : [];

  const decisions: NestedRegistrationDecision[] = [];
  const residue: string[] = [];
  let removed = 0;
  let failed = 0;
  let deferred = 0;

  for (const path of descendants) {
    const entry = path.split(sep).filter(Boolean).at(-1) ?? path;

    if (!pathExists(path)) {
      // Registration-only residue: git remove cannot succeed and no directory may be deleted.
      residue.push(path);
      decisions.push({ path, outcome: "residue" });
      continue;
    }
    if (input.isPathActive(path)) {
      deferred += 1;
      decisions.push({ path, outcome: "deferred", deferredReason: "active-session" });
      continue;
    }
    if (input.isResumeReserved?.(path)) {
      deferred += 1;
      decisions.push({ path, outcome: "deferred", deferredReason: "resume-reserved" });
      continue;
    }
    /*
    FNXC:TempWorktreeSweep 2026-10-02-19:05 (RUFU-290):
    A resolved gate of zero means "age is not this lane's criterion", so mtime must not be consulted at
    all. Probing it anyway smuggled a second gate into the landing lane: `now` is captured once before the
    loop, so a same-millisecond or clock-skew-future mtime made `now - modifiedMs` negative and deferred the
    entry as `young` forever — no other authority ever revisits a nested or landed registration, so that
    single deferral was the leak again. An unmeasurable mtime still defers whenever a positive age IS required.
    */
    const gateMs = await input.ageGateMs(entry);
    if (gateMs > 0) {
      const modifiedMs = mtimeMs(path);
      if (modifiedMs === null || now - modifiedMs < gateMs) {
        deferred += 1;
        decisions.push({ path, outcome: "deferred", deferredReason: "young" });
        continue;
      }
    }

    try {
      await removeRegistration(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed += 1;
      decisions.push({ path, outcome: "failed", error: message });
      input.log?.(`[worktree-nested] git worktree remove failed for a nested registration: ${message}`);
      continue;
    }
    if (pathExists(path)) {
      const cleared = await removeDirectory(path);
      if (!cleared) {
        failed += 1;
        decisions.push({ path, outcome: "failed", error: "directory remained after registration removal" });
        continue;
      }
    }
    removed += 1;
    decisions.push({ path, outcome: "removed", reason: "nested-registration" });
    input.log?.(`[worktree-nested] removed nested worktree registration ${path}`);
  }

  for (const decision of decisions) {
    await input.onDecision?.(decision);
  }
  await emitNestedAudit(input, { removed, failed, deferred, decisions });

  return { found: descendants.length, removed, failed, deferred, residue, decisions };
}

/** Aggregate counters only: ids, counts, and fixed enums. Paths stay in the caller's path-level rows. */
async function emitNestedAudit(
  input: RemoveDescendantRegistrationsInput,
  result: { removed: number; failed: number; deferred: number; decisions: NestedRegistrationDecision[] },
): Promise<void> {
  if (!input.auditHost) return;
  const base = {
    taskId: input.taskId ?? undefined,
    agentId: input.auditAgentId ?? "self-healing",
    runId: input.auditRunId ?? "worktree-nested-registrations",
    domain: "git" as const,
    target: `scratch:${input.authority}`,
  };
  if (result.removed > 0 || result.failed > 0) {
    await emitBoundedRunAudit(input.auditHost, {
      ...base,
      mutationType: "worktree:merge-temp-nested-removed",
      metadata: {
        authority: input.authority,
        foundCount: result.decisions.length,
        removedCount: result.removed,
        failedCount: result.failed,
      },
    }, { log: { warn: (message: string) => input.log?.(message) } });
  }
  const vetoReasons = new Set(
    result.decisions
      .filter((decision): decision is Extract<NestedRegistrationDecision, { outcome: "deferred" }> =>
        decision.outcome === "deferred" && decision.deferredReason !== "young")
      .map((decision) => decision.deferredReason),
  );
  for (const deferredReason of vetoReasons) {
    const deferredCount = result.decisions.filter(
      (decision) => decision.outcome === "deferred" && decision.deferredReason === deferredReason,
    ).length;
    await emitBoundedRunAudit(input.auditHost, {
      ...base,
      mutationType: "worktree:merge-temp-nested-deferred",
      metadata: { authority: input.authority, deferredCount, deferredReason },
    }, { log: { warn: (message: string) => input.log?.(message) } });
  }
}

/*
FNXC:WorktreeCleanup 2026-10-02-19:20 (RUFU-290):
The landing door removes a task worktree through the shared backend's forced removal, which — measured
against real git — deletes the parent tree recursively, nested worktree directory included, WITHOUT
deregistering the child. The scratch sweep cannot see that survivor either: its containment is dedicated
`.ai-merge` roots plus `os.tmpdir()` prefixes, and a task worktree path is neither. This pass is the
landing lane's half of RUFU-290: containment is the removed path itself, and only registrations strictly
below it are eligible.

The lane's disposability proof is the landing, not the filesystem clock, so its age gate is zero and the
helper is told to skip the age probe entirely (`ageGateMs: () => 0`).

Residue — a record whose directory vanished with the parent — is never deleted by filesystem means:
prune is the only authority that clears it and it is repo-wide, so it runs last, and the caller is told
how many registrations still remain in the inventory afterwards so a partial pass is visible.
*/
export type ContainedRegistrationCleanup = NestedRegistrationRemoval & {
  /** Residue records this pass cleared via prune. */
  residuePruned: number;
  /** Registrations still present under the container after the whole pass. */
  remaining: number;
};

/**
 * Deregisters everything still registered under a worktree path that has already been removed.
 *
 * Call it only AFTER the parent removal succeeded: a worktree kept by any landing gate (undelivered
 * content, unverifiable state, live session) still owns everything inside it.
 */
export async function cleanupRegistrationsUnderRemovedWorktree(input: {
  /** Repository whose registration inventory holds the survivors. */
  rootDir: string;
  /** The worktree path just removed: the only containment this lane is authorized under. */
  removedWorktreePath: string;
  /** Exact-path live-session veto — a child some session is still driving stays registered. */
  isPathActive: (path: string) => boolean;
  /** Injection seams so the mocked lane needs neither git nor the filesystem. */
  listRegistrations?: RegistrationLister;
  pathExists?: (path: string) => boolean;
  mtimeMs?: (path: string) => number | null;
  removeRegistration?: (path: string) => Promise<void>;
  removeDirectory?: (path: string) => Promise<boolean>;
  pruneAdminEntries?: () => Promise<void>;
  auditHost?: RunAuditSinkHost;
  auditRunId?: string;
  auditAgentId?: string;
  taskId?: string | null;
  log?: (message: string) => void;
}): Promise<ContainedRegistrationCleanup> {
  const seams = {
    listRegistrations: input.listRegistrations,
    pathExists: input.pathExists,
  };
  const found = await findRegistrationsWithin(input.rootDir, [input.removedWorktreePath], seams);
  if (found.length === 0) {
    return { found: 0, removed: 0, failed: 0, deferred: 0, residue: [], decisions: [], residuePruned: 0, remaining: 0 };
  }

  const removal = await removeDescendantRegistrations({
    rootDir: input.rootDir,
    authority: "task-worktree",
    descendants: found,
    isPathActive: input.isPathActive,
    // The landing itself is the disposability proof; age is not this lane's criterion.
    ageGateMs: () => 0,
    listRegistrations: seams.listRegistrations,
    pathExists: seams.pathExists,
    mtimeMs: input.mtimeMs,
    removeRegistration: input.removeRegistration,
    removeDirectory: input.removeDirectory,
    auditHost: input.auditHost,
    auditRunId: input.auditRunId,
    auditAgentId: input.auditAgentId,
    taskId: input.taskId,
    log: input.log,
  });

  let residuePruned = 0;
  if (removal.residue.length > 0) {
    const prune = input.pruneAdminEntries ?? (() => defaultPruneAdminEntries(input.rootDir));
    try {
      await prune();
    } catch (error) {
      input.log?.(`[worktree-nested] registration prune failed after landing cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // One re-read reports the truth of the whole pass, including a child removal that failed outright.
  const stillRegistered = await findRegistrationsWithin(input.rootDir, [input.removedWorktreePath], seams);
  for (const residuePath of removal.residue) {
    if (!stillRegistered.includes(residuePath)) residuePruned += 1;
  }
  return { ...removal, residuePruned, remaining: stillRegistered.length };
}

async function defaultPruneAdminEntries(rootDir: string): Promise<void> {
  await execAsync(`git worktree prune`, {
    cwd: rootDir,
    timeout: GIT_WORKTREE_REMOVE_TIMEOUT_MS,
    maxBuffer: GIT_WORKTREE_REMOVE_MAX_BUFFER,
    encoding: "utf-8",
  });
}

async function defaultRemoveRegistration(rootDir: string, path: string): Promise<void> {
  await execAsync(`git worktree remove --force ${quote(path)}`, {
    cwd: rootDir,
    timeout: GIT_WORKTREE_REMOVE_TIMEOUT_MS,
    maxBuffer: GIT_WORKTREE_REMOVE_MAX_BUFFER,
    encoding: "utf-8",
  });
}

async function defaultRemoveDirectory(path: string, log?: (message: string) => void): Promise<boolean> {
  const result = await removeDirectoryWithRetry({
    path,
    rm: (target, options) => removeSync(target, options),
    log,
  });
  return result.removed;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function existsSyncSafe(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function statMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function removeSync(path: string, options: { recursive: boolean; force: boolean }): void {
  rmSync(path, options);
}

