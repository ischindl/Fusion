import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, realpathSync } from "node:fs";
import { isWorkspaceTask, type Task } from "@fusion/core";

const execAsync = promisify(exec);

/*
FNXC:WorktreePointerState 2026-11-18-03:05 (RUFU-1054):
`project.tasks.worktree` is a CACHE of where a checkout lives, and until this module nothing in the
engine asked git whether that claim was still true before acting on it. Three consumers touch the field
(`self-healing.ts`'s metadata reconcile, its new pointer sweep, and `worktree-acquisition.ts`), each with
its own idea of "stale", which is how a card could sit in a WIP lane pointing at a directory that no
longer exists while the executor paid a fresh acquisition attempt on every dispatch.

This module is the ONE definition of that disagreement. It is pure: the registry read is separate from the
verdict so a pass performs at most one `git worktree list --porcelain`, and the verdict itself reads
nothing and mutates nothing. It never runs `git worktree remove` or `prune` — a stale pointer is a wrong
string in a row, never a licence to delete a tree another card may be working in. Measured 2026-11-15:
73 dead pointers over 149 registrations, and `git worktree prune --expire=now` moved that count 149 to
149, i.e. prune is not this remedy.

Three states, and a fourth that refuses:
- `consistent` — the row names a directory that exists and that git registers for this row's branch.
- `stale-pointer` — the row names a directory that is gone and git registers nothing there or for this
  branch. The row is the wrong side: clear `worktree`, KEEP `branch`, let the next acquisition create.
  This is RUFU-243's shape, proven on production: clearing that one column let the run survive 50 minutes.
- `unclaimed-live-tree` — git has exactly one live tree for this branch and the row does not point at it,
  carrying `adoptPath` (the value to write). `reconcileTaskWorktreeMetadata`'s rebind arm is the writer of
  that field; the pointer sweep reports it as `owned-elsewhere` and writes nothing, because two writers of
  one column is how a repair becomes a race.
- `unknown` — repairs nothing, always. It is the honest answer whenever the facts cannot decide which side
  is wrong, including every case where the registry could not be read.
*/

/** One registered working tree, exactly as `git worktree list --porcelain` printed it. */
export interface WorktreeRegistration {
  /** The path git printed, verbatim and un-canonicalised — comparison canonicalises, reporting does not. */
  worktreePath: string;
  /** Short branch name (`refs/heads/` stripped); a detached entry carries none and is not reported. */
  branch: string;
}

/**
 * Three-valued registry read. `unreadable` is a RESULT, never an empty list.
 *
 * FNXC:WorktreePointerState 2026-11-18-03:05 (RUFU-1054):
 * `describeRegisteredWorktrees` swallows its own failure into `{ rawOutput: "", canonicalized: [] }` and
 * `getRegisteredWorktreeBranchMap` collapses that into an empty map, so a transient git failure read as
 * "nothing is registered anywhere" — which made a healthy pointer look stale and cleared a live card's
 * `worktree` AND `branch` in the lanes FN-5256's guard does not cover. RUFU-439 settled the same trap for
 * the worktree-inventory probe: an unconsultable git must never read as absence. This read therefore has
 * no empty-on-error arm at all, and every consumer must refuse on `unreadable` rather than repair against
 * it.
 */
export type WorktreeRegistryRead =
  /*
  FNXC:WorktreePointerState 2026-11-18-03:50 (RUFU-1054):
  `prunable` carries the entries git itself marked unbacked, kept SEPARATE from `entries` so no consumer
  can mistake one for the other. They are two different questions: "is a live tree registered here" (the
  `entries` answer, which drives a rebind target) and "does git still hold an administrative record for
  this branch" (the `prunable` answer, which is a witness that the branch is real while the path is not).
  `reconcileTaskWorktreeMetadata` needs both: without the second it would send a card whose branch still
  exists in git down its fall-through arm, which clears `branch` alongside `worktree`.
  */
  | { status: "ok"; entries: WorktreeRegistration[]; prunable?: WorktreeRegistration[] }
  | { status: "unreadable" };

const REGISTRY_READ_TIMEOUT_MS = 10_000;

/**
 * One bounded read of the repository's registered working trees.
 *
 * Deliberately NOT `describeRegisteredWorktrees`: that helper is fine for its own callers but has no way
 * to say "the command failed", which is the exact defect this module exists to close. The parse mirrors
 * `getRegisteredWorktreeBranches` (a `worktree` line, then `branch refs/heads/…`) so both readers see the
 * same registry; a detached entry contributes nothing because a detached tree has no branch to match a
 * card against.
 *
 * FNXC:WorktreePointerState 2026-11-18-03:05 (RUFU-1054):
 * A `prunable <reason>` entry is DROPPED, and that is git's own verdict rather than an inference of ours.
 * Measured in this card's preflight: after `git worktree add <p> fusion/x` and `rm -rf <p>`, the listing
 * still prints that path plus `prunable gitdir file points to non-existent location`, because the
 * `.git/worktrees/<name>` admin record survives the directory. Counting such an entry as "a live tree is
 * registered here" would (a) block the `stale-pointer` repair for the exact shape this card exists for — a
 * pointer whose directory is gone — and (b) invent an `unclaimed-live-tree` at a path with nothing behind
 * it. A live checkout is never marked prunable, so dropping is the honest reading of "git reports no
 * registration for a row's path". This changes no removal: pruning the record remains out of scope.
 */
export async function readWorktreeRegistrations(rootDir: string): Promise<WorktreeRegistryRead> {
  let stdout: string;
  try {
    const result = await execAsync("git worktree list --porcelain", {
      cwd: rootDir,
      encoding: "utf-8",
      timeout: REGISTRY_READ_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    stdout = typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? "");
  } catch {
    // No error text is recorded anywhere: the caller's decision is a fixed refusal, and an error string is
    // prose this card's own rule keeps out of both audit rows and decisions.
    return { status: "unreadable" };
  }

  const entries: WorktreeRegistration[] = [];
  const prunableEntries: WorktreeRegistration[] = [];
  const prunable = new Set<string>();
  let currentPath: string | null = null;
  let answered = false;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      answered = true;
      currentPath = line.slice("worktree ".length).trim();
      continue;
    }
    if (!currentPath) continue;
    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      if (branch) entries.push({ worktreePath: currentPath, branch });
      continue;
    }
    if (line.startsWith("prunable ")) prunable.add(currentPath);
  }

  // A porcelain listing that never printed a `worktree` line did not answer the question, even though the
  // process exited 0; that is `unreadable`, not `ok` with zero entries.
  if (!answered) return { status: "unreadable" };
  const live = entries.filter((entry) => !prunable.has(entry.worktreePath));
  const livePaths = new Set(live.map((entry) => entry.worktreePath));
  for (const entry of entries) {
    if (prunable.has(entry.worktreePath) && !livePaths.has(entry.worktreePath)) prunableEntries.push(entry);
  }
  return { status: "ok", entries: live, prunable: prunableEntries };
}

export type WorktreePointerState = "consistent" | "stale-pointer" | "unclaimed-live-tree" | "unknown";

/**
 * Closed refusal vocabulary. Every member names a reason a side cannot be proven wrong, so `unknown` is
 * always diagnosable; none of them is ever a path, a sha, or an error sentence.
 *
 * FNXC:WorktreePointerState 2026-11-18-03:05 (RUFU-1054):
 * Seven members are the card's enumeration. Two more exist because the classifier is TOTAL — it must
 * answer an input the enumerated data states never reach, and an invented-on-the-fly code is what a
 * diagnostic field must not become:
 * - `pointer-absent`: neither side claims a checkout (no pointer, nothing registered for the branch), so
 *   there is no disagreement to repair. The pointer sweep's candidate gate requires a present pointer and
 *   acquisition only classifies a row that has one, so no repair lane sees this code.
 * - `workspace-task`: the card lists a workspace row among the candidate gates; it is enforced here too,
 *   because a permissive default is exactly what made a healthy multi-repo pointer look stale to the old
 *   predicate, and a pure classifier that trusts its callers to pre-filter is one caller away from a
 *   multi-repo row losing its entry checkout.
 */
export type WorktreePointerRefusalCode =
  | "registry-unreadable"
  | "registered-other-branch"
  | "adopt-path-not-canonical"
  | "registration-ambiguous"
  | "shape-incomplete"
  | "outside-work-tree"
  | "pointer-absent"
  | "workspace-task"
  | "no-branch";

export interface WorktreePointerVerdict {
  state: WorktreePointerState;
  /** Present only with `state: "unknown"`, and only ever from the closed code set above. */
  code?: WorktreePointerRefusalCode;
  /** Present only with `state: "unclaimed-live-tree"`: the registered path to record, verbatim from git. */
  adoptPath?: string;
}

/**
 * The row-shaped inputs the classifier may consult. It reads nothing else and writes nothing.
 *
 * FNXC:WorktreePointerState 2026-11-18-03:05 (RUFU-1054):
 * `workspaceWorktrees` is in the shape for a reason: a workspace card owns one pointer PER repository and
 * `task.worktree` is only its entry checkout, so a single-path classifier cannot say anything honest about
 * it and this card forbids touching them.
 */
export interface WorktreePointerRow {
  worktree?: string | null;
  branch?: string | null;
  workspaceId?: string | null;
  workspaceWorktrees?: Task["workspaceWorktrees"];
}

export interface WorktreePointerFacts {
  registry: WorktreeRegistryRead;
  /** Filesystem probe; injectable so a verdict can be tested without a disk. */
  exists?: (path: string) => boolean;
  /** Canonicalising probe (realpath with the input as its own fallback); the FN-5256 symlink guard. */
  canonical?: (path: string) => string;
}

/** realpath with the input as its own fallback: an absent path still needs a stable comparison key. */
function canonicalOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function trim(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Decide which side of `(row.worktree, git's registry)` is wrong, or refuse.
 *
 * FNXC:WorktreePointerState 2026-11-18-03:05 (RUFU-1054):
 * Two rules govern every branch of this table.
 *
 * 1. `unknown` repairs nothing, in BOTH passes. That is a narrowing next to the old
 *    `!existsSync() || !registered` predicate, which treated "directory exists but git registers nothing
 *    there" as stale and cleared `worktree` AND `branch` over it. Acquisition's own pinned reclaim
 *    (`worktree:incomplete-detected`, which proves path containment before removing anything) is the
 *    better owner of that shape, and a sweep that only reads must not orphan a directory still on disk.
 *    Narrowing a repair is always safe; widening one is not.
 * 2. `stale-pointer` is only ever the directory-absent shape, so the repair that keeps `branch` can never
 *    strand a checkout a process may still hold.
 */
export function classifyTaskWorktreeState(
  row: WorktreePointerRow,
  facts: WorktreePointerFacts,
): WorktreePointerVerdict {
  const { registry } = facts;
  const exists = facts.exists ?? existsSync;
  const canonical = facts.canonical ?? canonicalOrSelf;
  const refuse = (code: WorktreePointerRefusalCode): WorktreePointerVerdict => ({ state: "unknown", code });

  // A workspace card is refused ahead of everything else: its pointers are one-per-repo and the shared
  // FN-5256 guard exists because clearing one lane's metadata mid-operation stranded the operation. The
  // check covers both workspace shapes on purpose — `isWorkspaceTask` reads only `workspaceWorktrees`, so
  // a row that carries `workspaceId` with a not-yet-materialised or already-cleared context is caught
  // here too rather than being classified as a single-repo pointer.
  if (isWorkspaceTask(row) || trim(row.workspaceId)) return refuse("workspace-task");
  if (registry.status !== "ok") return refuse("registry-unreadable");

  const branch = trim(row.branch);
  if (!branch) return refuse("no-branch");

  const entries = registry.entries.map((entry) => ({
    raw: entry.worktreePath,
    canonical: canonical(entry.worktreePath),
    branch: entry.branch,
  }));
  const forBranch = entries.filter((entry) => entry.branch === branch);

  const pointerRaw = trim(row.worktree);
  if (pointerRaw) {
    const pointerCanonical = canonical(pointerRaw);
    const atPointer = entries.filter((entry) => entry.canonical === pointerCanonical);
    // FN-5256's lesson, kept: liveness is decided on the canonical path, not on the string the row holds.
    // A pointer recorded through a symlinked worktrees root (macOS `/var` to `/private/var`) is live even
    // though `existsSync(raw)` says otherwise, and deciding on the raw string is what produced the
    // false-stale that wiped a healthy card's `worktree` AND `branch`.
    const pointerLive = exists(pointerRaw) || (pointerCanonical !== pointerRaw && exists(pointerCanonical));

    if (pointerLive) {
      if (atPointer.some((entry) => entry.branch === branch)) return { state: "consistent" };
      // The recorded path is somebody else's checkout. Clearing this row's pointer would tell the engine to
      // create a second tree for its own branch while another card's live files sit there.
      if (atPointer.length > 0) return refuse("registered-other-branch");
      return refuse("outside-work-tree");
    }

    // The directory is gone. If git still lists it as live, the two reads disagree about the filesystem
    // itself — a mount, a permission, or a race with a removal — and neither side is proven wrong. Only
    // `git worktree prune` speaks to a dead record, and the card forbids using it as this remedy.
    if (atPointer.some((entry) => entry.branch === branch)) return refuse("shape-incomplete");
    // A dead path that is registered for SOME OTHER branch belongs to another card's recovery, and
    // deciding whose is not this classifier's call.
    if (atPointer.length > 0) return refuse("registered-other-branch");
    // Nothing is registered for this branch either, so the row is the wrong side and alone.
    if (forBranch.length === 0) return { state: "stale-pointer" };
    return adoptVerdict(forBranch, canonical, refuse);
  }

  // No pointer recorded: there is nothing to clear, so only a live unclaimed tree makes this interesting.
  if (forBranch.length === 0) return refuse("pointer-absent");
  return adoptVerdict(forBranch, canonical, refuse);
}

/**
 * The `unclaimed-live-tree` verdict, gated on there being exactly one live candidate whose path the row
 * can hold verbatim.
 *
 * FNXC:WorktreePointerState 2026-11-18-03:05 (RUFU-1054):
 * `adopt-path-not-canonical` refuses to name a path that is not its own canonical form, because the value
 * written into `worktree` is what every later reader compares against. It is a refusal THIS module makes
 * about its own output; it does not narrow the existing rebind, whose arm keeps writing
 * `getRegisteredWorktreeBranchMap`'s canonicalised value — the sweep treats this code as the same
 * `owned-elsewhere` claim, and the lane that owns the column keeps its own canonicalisation rule.
 */
function adoptVerdict(
  forBranch: Array<{ raw: string; canonical: string }>,
  canonical: (path: string) => string,
  refuse: (code: WorktreePointerRefusalCode) => WorktreePointerVerdict,
): WorktreePointerVerdict {
  if (forBranch.length !== 1) return refuse("registration-ambiguous");
  const [candidate] = forBranch as [{ raw: string; canonical: string }];
  if (candidate.raw !== (candidate.canonical || canonical(candidate.raw))) return refuse("adopt-path-not-canonical");
  return { state: "unclaimed-live-tree", adoptPath: candidate.raw };
}

/**
 * The shared facts collector. One instance per pass (or per acquisition) so the registry is read at most
 * once, and never at all on a warm path that has nothing to check.
 *
 * FNXC:GitWorktreeSubprocessBudget 2026-11-18-03:05 (RUFU-1054):
 * The read is a subprocess. The pass that owns the field must not pay one per card, and the warm state-A
 * acquisition — every single dispatch of a healthy card — must not pay one either, which is why `facts()`
 * is lazy and memoised rather than a parameter the caller already resolved. `reads()` exists so a test can
 * assert the budget instead of trusting this comment.
 */
export interface WorktreePointerFactsCollector {
  facts(): Promise<WorktreePointerFacts>;
  reads(): number;
}

export function createWorktreePointerFactsCollector(
  rootDir: string,
  read: (root: string) => Promise<WorktreeRegistryRead> = readWorktreeRegistrations,
): WorktreePointerFactsCollector {
  let pending: Promise<WorktreeRegistryRead> | null = null;
  let reads = 0;
  return {
    facts: async () => {
      pending ??= (async () => {
        reads += 1;
        try {
          return await read(rootDir);
        } catch {
          // A reader that throws is still an unreadable registry; it must never become an empty list.
          return { status: "unreadable" } satisfies WorktreeRegistryRead;
        }
      })();
      const registry = await pending;
      return { registry };
    },
    reads: () => reads,
  };
}
