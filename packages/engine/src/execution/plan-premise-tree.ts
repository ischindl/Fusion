import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { PlanPremise, Task, TaskStore } from "@fusion/core";
import { resolveIntegrationBranch } from "../merge/integration-branch.js";
import { isReclaimableWorktreeCandidate } from "../worktree/worktree-paths.js";

/*
FNXC:PlanPremises 2026-09-27-02:40:
A plan premise is a claim about a REPOSITORY, so it has to be verified against the card's own
committed content and never against a working tree. The previous evaluator read files out of
`TaskStore.getRootDir()` — the project root, a tree that belongs to no card (and for a linked or
workspace root is the common directory). A card whose fact was true at its own commit was therefore
refused as stale because the root checkout happened to sit on something else.

This module answers the only two questions that matter: WHICH commit a card's premises are measured
at, and WHAT that commit's tree says. Every answer comes from git plumbing (`rev-parse`, `ls-tree`,
`show`, `log`, `merge-base`), so an uncommitted, foreign, or detached root checkout cannot influence
a verdict.
*/

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 20_000;
/** `git ls-tree` modes that describe a regular file (symlinks, gitlinks, and trees do not). */
const REGULAR_FILE_MODES = new Set(["100644", "100640", "100755"]);

/*
FNXC:PlanPremises 2026-09-27-02:40:
A non-zero git exit IS an answer to these probes — an absent path, an absent blob, and an unknown ref
are all ordinary outcomes — so the failure arm yields null instead of throwing. Nothing downstream
substitutes a guess for null; the caller reports `unavailable`.
*/
async function gitProbe(repo: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/** The probe's first non-empty line, or null when it failed or printed nothing. */
async function gitLine(repo: string, args: string[]): Promise<string | null> {
  const stdout = await gitProbe(repo, args);
  const line = stdout?.split("\n")[0]?.trim() ?? "";
  return line.length > 0 ? line : null;
}

export type CardGitIdentitySource = "worktree-head" | "branch-tip" | "declared-base";

export interface CardGitIdentity {
  source: CardGitIdentitySource;
  /** A checkout of the card's repository that the git object reads run in. */
  repo: string;
  /** The commit whose committed tree premises are measured against. */
  commit: string;
  /** Ref (or worktree path) the commit came from, for operator-facing detail. */
  ref: string;
  /** Integration branch the card's unique commits are measured from. Filled by
   *  `attachCardCommitRange`, which only runs once a violation exists — a satisfied card never
   *  pays for the extra git calls. */
  baseRef: string;
  /** `merge-base(baseRef, commit)`; null while unattached or when the base is unresolvable, which
   *  makes the card's own commit set unprovable and so nothing delivery-attributable. */
  rangeBase: string | null;
}

export type CardGitIdentityResult = { ok: true; identity: CardGitIdentity } | { ok: false; detail: string };

async function resolveCommit(repo: string, ref: string): Promise<string | null> {
  return await gitLine(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

async function declaredBaseRef(store: TaskStore, task: Task, repo: string): Promise<string> {
  const declared = typeof task.baseBranch === "string" ? task.baseBranch.trim() : "";
  if (declared.length > 0) return declared;
  const settings = typeof store.getSettings === "function" ? await store.getSettings().catch(() => undefined) : undefined;
  return await resolveIntegrationBranch(repo, settings, { logger: { warn: () => undefined } });
}

/** Operator-facing description of what a verdict was measured against. */
export function describeCardGitIdentity(identity: CardGitIdentity): string {
  const commit = identity.commit.slice(0, 8);
  if (identity.source === "worktree-head") return `card worktree at ${commit}`;
  if (identity.source === "branch-tip") return `card branch ${identity.ref} at ${commit}`;
  return `declared base ${identity.ref} at ${commit}`;
}

/*
FNXC:PlanPremises 2026-09-27-02:40:
Identity ladder, most specific first, with NO fallback to the project working tree:
  1. the card's own registered worktree HEAD — accepted only when git PROVES the directory is a
     linked worktree of this project's repository (the same reclaim proof the worktree reaper uses),
     because `task.worktree` is a value an external-checkout flow can steer and an arbitrary
     checkout must not get to define the facts;
  2. the card's own branch tip;
  3. the card's declared base — per-task `baseBranch`, else the project integration branch — the
     honest answer for a card that has not produced a branch yet;
  4. nothing resolves → `unavailable`, fail closed. The project root is used as a git database here,
     never as a source of file content.
*/
export async function resolveCardGitIdentity(store: TaskStore, task: Task): Promise<CardGitIdentityResult> {
  let root: string;
  try {
    root = store.getRootDir();
  } catch (error) {
    return { ok: false, detail: `Cannot resolve the project repository: ${error instanceof Error ? error.message : String(error)}` };
  }

  const worktree = typeof task.worktree === "string" ? task.worktree.trim() : "";
  if (worktree.length > 0 && existsSync(worktree) && (await isReclaimableWorktreeCandidate(worktree, { rootDir: root }))) {
    const commit = await resolveCommit(worktree, "HEAD");
    if (commit) return { ok: true, identity: { source: "worktree-head", repo: worktree, commit, ref: worktree, baseRef: "", rangeBase: null } };
  }

  const branch = typeof task.branch === "string" ? task.branch.trim() : "";
  if (branch.length > 0) {
    const commit = await resolveCommit(root, branch);
    if (commit) return { ok: true, identity: { source: "branch-tip", repo: root, commit, ref: branch, baseRef: "", rangeBase: null } };
  }

  const base = await declaredBaseRef(store, task, root);
  const baseCommit = await resolveCommit(root, base);
  if (baseCommit) {
    return { ok: true, identity: { source: "declared-base", repo: root, commit: baseCommit, ref: base, baseRef: base, rangeBase: baseCommit } };
  }

  const tried = [
    worktree.length > 0 && "its registered checkout",
    branch.length > 0 && `branch ${branch}`,
    `base ${base}`,
  ].filter(Boolean).join(", ");
  return { ok: false, detail: `This card has no resolvable committed git identity (tried ${tried})` };
}

/*
FNXC:PlanPremises 2026-09-27-02:40:
The card's unique commit set needs a base, and the base only matters once a premise has actually
failed, so it is attached lazily. `merge-base` rather than the raw base ref keeps a rebased or
main-merged card from claiming upstream commits as its own delivery.
*/
export async function attachCardCommitRange(store: TaskStore, task: Task, identity: CardGitIdentity): Promise<CardGitIdentity> {
  if (identity.source === "declared-base") return identity;
  const baseRef = await declaredBaseRef(store, task, identity.repo);
  const rangeBase = await gitLine(identity.repo, ["merge-base", baseRef, identity.commit]);
  return { ...identity, baseRef, rangeBase };
}

export type PremiseVerdict = { satisfied: true } | { satisfied: false; reason: string };

/*
FNXC:PlanPremises 2026-09-27-02:40:
The committed tree answers a premise through `git ls-tree` (existence and object type) plus
`git show <commit>:<path>` (content). A non-regular entry — symlink, gitlink, directory — keeps the
historical "path exists but is not a regular file" verdict, because every premise kind describes a
regular file.
*/
async function evaluateLiteral(identity: CardGitIdentity, premise: Extract<PlanPremise, { literal: string }>, entry: string | null): Promise<PremiseVerdict> {
  // An absence claim is about the path, not about what kind of object sits there.
  if (premise.kind === "text-absent") {
    return entry ? { satisfied: false, reason: "path exists at the evaluated commit" } : { satisfied: true };
  }
  if (!entry) return { satisfied: false, reason: "path does not exist at the evaluated commit" };
  const [mode] = entry.split(" ");
  if (!mode || !REGULAR_FILE_MODES.has(mode)) return { satisfied: false, reason: "path exists but is not a regular file" };
  const content = await gitProbe(identity.repo, ["show", `${identity.commit}:${premise.path}`]);
  if (content === null) return { satisfied: false, reason: "file content is unreadable at the evaluated commit" };
  return content.includes(premise.literal)
    ? { satisfied: true }
    : { satisfied: false, reason: "literal not found in file" };
}

export async function evaluatePremiseAtCommit(identity: CardGitIdentity, premise: PlanPremise): Promise<PremiseVerdict> {
  const entry = await gitLine(identity.repo, ["ls-tree", "-l", identity.commit, "--", premise.path]);
  if (premise.kind === "text-present" || premise.kind === "text-absent") return evaluateLiteral(identity, premise, entry);
  if (premise.kind === "file-absent") {
    return entry ? { satisfied: false, reason: "path exists at the evaluated commit" } : { satisfied: true };
  }
  if (!entry) return { satisfied: false, reason: "path does not exist at the evaluated commit" };
  const [mode] = entry.split(" ");
  return mode && REGULAR_FILE_MODES.has(mode)
    ? { satisfied: true }
    : { satisfied: false, reason: "path exists but is not a regular file" };
}

/** Commit that last changed `path` inside the card's own `base..tip` set, formatted `%h %s`, or null
 *  when the card's delivery never touched that path. */
export async function invalidatedByCardDelivery(identity: CardGitIdentity, path: string): Promise<string | null> {
  if (!identity.rangeBase) return null;
  return await gitLine(identity.repo, ["log", "-1", "--format=%h %s", `${identity.rangeBase}..${identity.commit}`, "--", path]);
}

/** Commit that last changed `path` anywhere in the evaluated history — what an ordinary stale verdict
 *  names when the card's own delivery is not responsible. */
export async function lastCommitTouching(identity: CardGitIdentity, path: string): Promise<string | null> {
  return await gitLine(identity.repo, ["log", "-1", "--format=%h %s", identity.commit, "--", path]);
}
