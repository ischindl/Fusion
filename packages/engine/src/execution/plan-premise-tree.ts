import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PlanPremise, Task, TaskStore } from "@fusion/core";
import { extractAttributedTaskId } from "./branch-conflicts.js";
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
STAS-301: what a probe produced, kept as two arms that can never carry the same meaning.
  ok: true  — git ran and ANSWERED. An empty answer is still an answer ("no such path", "no such
              ref"), and for the absence premise kinds it is the answer the plan is measured against.
  ok: false — git never answered: it could not be spawned, exited non-zero, timed out, or overflowed
              the output buffer. Nothing may be concluded from this arm; the caller reports
              `unavailable` and the card stays where it is.
The shape before this change was `string | null`, which put both cases in the null arm and inverted
the absence premises: a probe that failed read as git having proven the thing absent, so the plan was
satisfied and the card released on evidence that was never gathered.
*/
export type Probe<T> = { ok: true; value: T } | { ok: false; detail: string };

const firstMeaningfulLine = (text: string): string => text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";

/** Operator-facing, single-line, bounded: what the probe ran and what actually went wrong. */
function probeFailure(repo: string, args: string[], error: unknown): Probe<never> {
  const failure = error as { code?: number | string; signal?: string; killed?: boolean; stderr?: unknown } | undefined;
  const marker = [
    typeof failure?.code === "number" ? `exit ${failure.code}` : typeof failure?.code === "string" ? failure.code : "",
    failure?.killed === true ? "timed out" : "",
    typeof failure?.signal === "string" && failure.signal.length > 0 ? `signal ${failure.signal}` : "",
  ].filter(Boolean).join(", ");
  const stderr = typeof failure?.stderr === "string" ? failure.stderr : "";
  const why = firstMeaningfulLine(stderr) || firstMeaningfulLine(error instanceof Error ? error.message : String(error)) || "the probe printed no error";
  return { ok: false, detail: `git ${args.join(" ")} in ${repo} could not answer${marker.length > 0 ? ` (${marker})` : ""}: ${why}`.slice(0, 300) };
}

async function gitProbe(repo: string, args: string[]): Promise<Probe<string>> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, value: stdout };
  } catch (error) {
    return probeFailure(repo, args, error);
  }
}

/** The probe's first non-empty line. An answered probe that printed nothing yields "", which is a
 *  different fact from `ok: false` and stays in the `ok: true` arm. */
async function gitLine(repo: string, args: string[]): Promise<Probe<string>> {
  const stdout = await gitProbe(repo, args);
  if (!stdout.ok) return stdout;
  return { ok: true, value: firstMeaningfulLine(stdout.value) };
}

export type CardGitIdentitySource = "worktree-head" | "branch-tip" | "declared-base";

export interface CardGitIdentity {
  source: CardGitIdentitySource;
  /** The card being evaluated, so a landed commit that names this card is recognisable as its own
   *  delivery. Attribution never guesses: a commit naming no card, or another card, is not this one. */
  taskId: string;
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

async function resolveCommit(repo: string, ref: string): Promise<Probe<string>> {
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

  const taskId = typeof task.id === "string" ? task.id.trim() : "";
  /*
  STAS-301: a rung whose probe could not answer is not a rung that was answered "no such ref" — it is
  a rung that never got an answer. The ladder may still descend to a rung that does answer, but every
  unanswered probe is recorded so the `unavailable` at the bottom names the failure instead of
  reporting a card with a broken git as a card that has no branch and no base.

  Named fail direction of that descent: when it is an UPPER rung whose probe failed, the verdict is
  measured at the next rung that answers, so a worktree that cannot answer `rev-parse` is measured at
  its branch tip. In the usual case the two are the same commit — a branch checked out in a worktree
  moves with each of the card's commits — but they are not the same object when `task.branch` names a
  branch other than the one the worktree holds, and an absence measured at the wrong tip could then
  read as satisfied. Refusing to descend would be the louder change and it would hard-refuse cards
  that are legitimately measurable from their branch tip, so the descent stays; what this card
  required is narrower and absolute: a probe that never answered may not be reported as an answer.
  */
  const unanswered: string[] = [];
  const answeredCommit = async (repo: string, ref: string): Promise<string> => {
    const commit = await resolveCommit(repo, ref);
    if (!commit.ok) {
      unanswered.push(commit.detail);
      return "";
    }
    return commit.value;
  };

  const worktree = typeof task.worktree === "string" ? task.worktree.trim() : "";
  if (worktree.length > 0 && existsSync(worktree) && (await isReclaimableWorktreeCandidate(worktree, { rootDir: root }))) {
    const commit = await answeredCommit(worktree, "HEAD");
    if (commit.length > 0) return { ok: true, identity: { source: "worktree-head", taskId, repo: worktree, commit, ref: worktree, baseRef: "", rangeBase: null } };
  }

  const branch = typeof task.branch === "string" ? task.branch.trim() : "";
  if (branch.length > 0) {
    const commit = await answeredCommit(root, branch);
    if (commit.length > 0) return { ok: true, identity: { source: "branch-tip", taskId, repo: root, commit, ref: branch, baseRef: "", rangeBase: null } };
  }

  const base = await declaredBaseRef(store, task, root);
  const baseCommit = await answeredCommit(root, base);
  if (baseCommit.length > 0) {
    return { ok: true, identity: { source: "declared-base", taskId, repo: root, commit: baseCommit, ref: base, baseRef: base, rangeBase: baseCommit } };
  }

  /*
  FNXC:PlanPremiseWorkspaceIdentity 2026-10-05-18:57 (RUFU-570):
  A workspace project's root is a CONTAINER of sibling repositories, not a repository. Measured on
  project saneca, `/home/schindler/saneca-ws` answers `rev-parse` with "fatal: not a git repository"
  while holding saneca, lager-2026 and lager-manager, so this last rung raised for EVERY
  premise-bearing workspace card and the card was refused at admission before any worktree existed —
  reached from the scheduler sweep, automatic admission, operator promote, and event release alike.
  When the root is not a git database, the base is therefore retried against the member repositories
  that actually exist under it, ordered by the order the card names them in its own
  `workspaceWorktrees` (the card's stated scope outranks a directory listing) and then sorted by name.
  A single-repo checkout never enters this branch — `baseCommit` already resolved there — so the
  common case is untouched. Nothing is substituted when no member carries the base: the refusal names
  the base, says the root is not a git repository, and lists which members were tried, because
  "tried base main" was the same words for "no such repository", "no such ref", and "not a git
  repository" and told an operator nothing actionable. An absent member the card named is reported
  separately from the members that were searched, so a plan pointing at a sibling this workspace does
  not have reads differently from a base that is simply missing.
  */
  const rootIsRepository = await isGitDatabase(root);
  if (rootIsRepository.ok && !rootIsRepository.value) {
    const { members, absent, unresolved } = await workspaceMemberRepositories(root, task);
    for (const member of members) {
      const repo = join(root, member);
      const commit = await answeredCommit(repo, base);
      if (commit.length > 0) {
        return { ok: true, identity: { source: "declared-base", taskId, repo, commit, ref: base, baseRef: base, rangeBase: commit } };
      }
    }
    const searched = members.length > 0 ? members.join(", ") : "none — the root holds no git repository";
    const namedAbsent = absent.length > 0 ? `; named by this card but absent from the workspace: ${absent.join(", ")}` : "";
    const unclassified = unresolved.length > 0 ? `; not classified because their probe could not answer: ${unresolved.join(", ")}` : "";
    return {
      ok: false,
      detail: `This card has no resolvable committed git identity: base ${base} resolved in no repository and the project root ${root} is not a git repository, so it was tried in each workspace member (members tried: ${searched}${namedAbsent}${unclassified})${unansweredClause(unanswered)}`,
    };
  }

  const tried = [
    worktree.length > 0 && "its registered checkout",
    branch.length > 0 && `branch ${branch}`,
    `base ${base}`,
  ].filter(Boolean).join(", ");
  return { ok: false, detail: `This card has no resolvable committed git identity (tried ${tried})${unansweredClause(unanswered)}` };
}

/** The failures that stop being invisible once the ladder has nothing to resolve: an unanswered probe
 *  is reported as a probe failure, never dressed up as an absent ref or an absent repository. */
function unansweredClause(failures: string[]): string {
  return failures.length === 0 ? "" : `; probes that could not answer: ${[...new Set(failures)].join(" | ")}`;
}

/*
STAS-301: "there is no repository at this path" is something git answers with a NON-ZERO exit and a
specific message, so this classification probe alone reads the message to tell an answered "no" apart
from a probe that never answered. Every ref and content probe keeps treating a non-zero exit as no
answer, because for those a non-zero exit is never a fact about the repository.
*/
const ANSWERED_NO_REPOSITORY = /not a git repository/i;

/** Whether `dir` is usable as a git database — a repository or work tree at that exact path. A probe
 *  that could not answer is `ok: false`, which is NOT evidence that `dir` is not a repository. */
async function isGitDatabase(dir: string): Promise<Probe<boolean>> {
  const probe = await gitProbe(dir, ["rev-parse", "--git-dir"]);
  if (probe.ok) return { ok: true, value: probe.value.length > 0 };
  return ANSWERED_NO_REPOSITORY.test(probe.detail) ? { ok: true, value: false } : probe;
}

/*
FNXC:PlanPremiseWorkspaceIdentity 2026-10-05-18:57 (RUFU-570):
Immediate children only, and only those that are git repositories, so `.fusion` and any other
container artifact never masquerade as a member. A member the card names but that is not on disk is
reported rather than silently dropped from the search — an unregistered or since-removed sibling is
not something this card may read, and it must not look like a base that merely went missing.
*/
async function workspaceMemberRepositories(root: string, task: Task): Promise<{ members: string[]; absent: string[]; unresolved: string[] }> {
  let children: string[];
  try {
    children = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { members: [], absent: [], unresolved: [] };
  }
  const named = [...new Set(Object.keys(task.workspaceWorktrees ?? {}).map((member) => member.trim()).filter(Boolean))];
  const ordered = [...named.filter((member) => children.includes(member)), ...children];
  const members: string[] = [];
  const unresolved: string[] = [];
  for (const child of ordered) {
    if (members.includes(child) || unresolved.includes(child)) continue;
    const isRepository = await isGitDatabase(join(root, child));
    if (!isRepository.ok) unresolved.push(child);
    else if (isRepository.value) members.push(child);
  }
  return { members, absent: named.filter((member) => !members.includes(member) && !unresolved.includes(member)), unresolved };
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
  /*
  STAS-301 adjudicated, deliberately unchanged: a missing merge-base — git's answered "these two commits
  have no common ancestor to range" AND a probe that could not answer alike — leaves the card's unique
  commit set unprovable, so attribution falls through to the landed-card form and, failing that, to the
  louder `stale` route. Fail-closed toward replanning, never toward release.
  */
  return { ...identity, baseRef, rangeBase: rangeBase.ok && rangeBase.value.length > 0 ? rangeBase.value : null };
}

export type PremiseVerdict = { satisfied: true } | { satisfied: false; reason: string };

/** A premise is ANSWERED satisfied, ANSWERED violated, or never evaluated because git could not say
 *  what the tree held. The third arm is `unavailable` at the release door, never `satisfied`. */
export type PremiseEvaluation = Probe<PremiseVerdict>;

/*
FNXC:PlanPremises 2026-09-27-02:40:
The committed tree answers a premise through `git ls-tree` (existence and object type) plus
`git show <commit>:<path>` (content). A non-regular entry — symlink, gitlink, directory — keeps the
historical "path exists but is not a regular file" verdict, because every premise kind describes a
regular file.
*/
async function evaluateLiteral(identity: CardGitIdentity, premise: Extract<PlanPremise, { literal: string }>, entry: Probe<string>): Promise<PremiseEvaluation> {
  if (!entry.ok) return entry;
  /*
  STAS-301: an absence premise is satisfied when GIT ANSWERED that the path is not there. The arm
  below is reached only from an answered probe — a probe that failed returned two blocks up.
  */
  if (entry.value.length === 0) {
    return premise.kind === "text-absent" ? { ok: true, value: { satisfied: true } } : { ok: true, value: { satisfied: false, reason: "path does not exist at the evaluated commit" } };
  }
  const [mode] = entry.value.split(" ");
  if (!mode || !REGULAR_FILE_MODES.has(mode)) return { ok: true, value: { satisfied: false, reason: "path exists but is not a regular file" } };
  const content = await gitProbe(identity.repo, ["show", `${identity.commit}:${premise.path}`]);
  // An unreadable file says nothing about what it contains. It may not be read as "the literal is not
  // in there", which is what turned a broken read into a falsified plan and a card sent to replan.
  if (!content.ok) return content;
  if (premise.kind === "text-present") {
    return content.value.includes(premise.literal)
      ? { ok: true, value: { satisfied: true } }
      : { ok: true, value: { satisfied: false, reason: "literal not found in file" } };
  }
  return content.value.includes(premise.literal)
    ? { ok: true, value: { satisfied: false, reason: "literal found in file" } }
    : { ok: true, value: { satisfied: true } };
}

/*
FNXC:PlanPremises 2026-09-27-02:40:
One `ls-tree -l` call names the entry AT the path with its mode: a regular file, a symlink (120000), or
a directory (040000) all answer with exactly one line, and a path that a symlink or blob would have to
lead through answers with nothing — the tree is descended only by git, never by the filesystem.
STAS-301: "answers with nothing" and "the call never answered" are different outcomes and travel in
different arms of `Probe`.
*/
export async function evaluatePremiseAtCommit(identity: CardGitIdentity, premise: PlanPremise): Promise<PremiseEvaluation> {
  const entry = await gitLine(identity.repo, ["ls-tree", "-l", identity.commit, "--", premise.path]);
  if (premise.kind === "text-present" || premise.kind === "text-absent") return evaluateLiteral(identity, premise, entry);
  if (!entry.ok) return entry;
  const absent = entry.value.length === 0;
  if (premise.kind === "file-absent") {
    return absent ? { ok: true, value: { satisfied: true } } : { ok: true, value: { satisfied: false, reason: "path exists at the evaluated commit" } };
  }
  if (absent) return { ok: true, value: { satisfied: false, reason: "path does not exist at the evaluated commit" } };
  const [mode] = entry.value.split(" ");
  return mode && REGULAR_FILE_MODES.has(mode)
    ? { ok: true, value: { satisfied: true } }
    : { ok: true, value: { satisfied: false, reason: "path exists but is not a regular file" } };
}

/*
FNXC:PlanPremiseLandedLineage 2026-09-27-08:45:
A card whose work has already LANDED has no unique commit set left to search: its branch is merged
and usually deleted, so the identity ladder arrives at the declared base and `base..tip` is empty.
Range-only attribution therefore finds nothing of the card's own and files its own delivery commit
under "upstream" — which re-plans and re-implements finished work, consequence #2 of the original
defect, on the one shape where that damage is certain. The landed lineage is still provable: the
engine stamps `Fusion-Task-Id: <id>` on every commit it writes, so the falsifying commit names the
card. This reads the engine's own attribution convention (`extractAttributedTaskId`, the canonical
task-id grammar shared with task-id integrity), so a landed commit belonging to a DIFFERENT card, or
naming no card at all, stays unattributable and therefore loudly plan-stale.
*/
async function landedCardDelivery(identity: CardGitIdentity, path: string): Promise<string | null> {
  const cardTaskId = identity.taskId.toUpperCase();
  if (cardTaskId.length === 0) return null;
  const record = await gitProbe(identity.repo, ["log", "-1", "--format=%h %s%x1f%b", identity.commit, "--", path]);
  // STAS-301 adjudicated, deliberately unchanged: an unanswered attribution probe answers "this card's
  // delivery is not proven to have touched the path", which sends the verdict to the louder `stale`
  // route — a replan — and never toward a release. Attribution semantics are STAS-282's deliverable.
  if (!record.ok || record.value.trim().length === 0) return null;
  const [header = "", body = ""] = record.value.split("\u001f");
  const subject = header.trim().replace(/^[0-9a-f]+\s+/, "");
  if (extractAttributedTaskId(subject, body) !== cardTaskId) return null;
  return header.trim();
}

/** The commit of THIS card's delivery that last changed `path`, formatted `%h %s`, or null when the
 *  card's delivery never touched that path. Two git-proven forms: a commit in the card's unique
 *  `base..tip` set, or — once that set is empty because the delivery landed — a commit in the
 *  evaluated history that names this exact card through the engine's attribution convention. A probe
 *  that could not answer maps to null, which is the pre-existing fail-closed direction toward `stale`
 *  (see `landedCardDelivery`); it is never read as an absence premise.
 *
 *  FNXC:PlanPremiseFalsifier 2026-10-19-08:59 (RUFU-727): this recency probe answers "who last edited
 *  the file", which is NOT "who falsified the premise" — see `falsifyingCommitForPremise` for the
 *  measured hole and for why the caller consults the proven falsifier whenever this answers null. */
export async function invalidatedByCardDelivery(identity: CardGitIdentity, path: string): Promise<string | null> {
  if (identity.rangeBase) {
    const ownRange = await gitLine(identity.repo, ["log", "-1", "--format=%h %s", `${identity.rangeBase}..${identity.commit}`, "--", path]);
    if (ownRange.ok && ownRange.value.length > 0) return ownRange.value;
  }
  return await landedCardDelivery(identity, path);
}

/*
FNXC:PlanPremiseFalsifier 2026-10-19-08:59 (RUFU-727):
Recency is not authorship. Attribution asked `git log -1 -- <path>` — the most recent commit that
touched the FILE — and tested whether that one commit names the card. RUFU-698 measured the hole on
main 7342c6e705: its own commit b7bfb9243a deleted the `getFinalClaimSnapshot` block its plan assumed
present, deleted the assumed `enrichedTopLevelAgentTasksFromStore(store: WorkflowIrResolverStore,
tasks: Task[])` signature, and ADDED the `rotated-deferred` marker its own `text-absent` premise
forbade; a later, unrelated RUFU-718 commit then edited those same files for another reason. The
last-toucher named RUFU-718 on all three paths, so every violation fell to the upstream arm, the
verdict degraded from `premise-invalidated-by-delivery` (which releases, STAS-282) to `stale`, and the
ladder started burning a finished card toward a terminal park of work that is running in production.
Measured refusal: `fn task move RUFU-698 in-progress` on board 4040.

The falsifier of a premise is not the last commit that touched a file: it is the commit whose tree
turned the premise from true to false. That is directly provable, and cheaply, because git already
indexes presence transitions — `git log -S<literal> -- <path>` answers exactly the commits where the
literal's occurrence count CHANGED, and `--diff-filter=AD` answers them for a file-existence premise.
Walking those newest-first and evaluating the premise at the candidate and at its parent proves which
commit flipped the truth; the engine's own attribution convention (`extractAttributedTaskId`) then says
WHO wrote it — the card (release, with evidence) or a stranger (loud plan-stale, now naming the commit
that actually destroyed the fact instead of one that merely edited the file afterwards).

The fail-closed direction is unchanged and this helper can only ADD delivery evidence: an unanswered
probe, an unprovable flip, a falsifier older than the scan bound, or a falsifier that names no card all
answer `null`, which leaves the pre-existing path-level attribution and the `stale` route exactly as
they were. It introduces no new verdict arm and never removes an attribution the old probe found.
*/
export interface PremiseFalsifier {
  /** Operator-facing commit identity, `%h %s`, in the same shape every premise sentence already uses. */
  commit: string;
  /** Whether the falsifier names THIS card through the engine's attribution convention. */
  cardOwned: boolean;
}

/** Bounds on the WORST case of a hot file, not thresholds of correctness: a flip older than the scan,
 *  or older than the number of candidates worth two git reads each, simply stays unattributed — the
 *  existing `stale` route, which is the direction that re-plans rather than releases. */
const FALSIFIER_SCAN = 40;
const FALSIFIER_PROOF_LIMIT = 6;

/** Presence-changing commits for this premise alone, newest first. `%H` answers the reads, `%h %s`
 *  the operator-facing sentence, `%b` the attribution trailer. */
async function premisePresenceTransitions(
  identity: CardGitIdentity,
  premise: PlanPremise,
): Promise<Probe<{ sha: string; header: string; subject: string; body: string }[]>> {
  const transitionFilter =
    premise.kind === "file-exists" || premise.kind === "file-absent"
      ? ["--diff-filter=AD"]
      : [`-S${(premise as Extract<PlanPremise, { literal: string }>).literal}`];
  const records = await gitProbe(identity.repo, [
    "log",
    ...transitionFilter,
    `-n${FALSIFIER_SCAN}`,
    "--format=%H%x1f%h %s%x1f%b%x1e",
    identity.commit,
    "--",
    premise.path,
  ]);
  if (!records.ok) return records;
  const parsed = records.value
    .split("\u001e")
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = "", header = "", body = ""] = record.split("\u001f");
      return { sha: sha.trim(), header: header.trim(), subject: header.trim().replace(/^[0-9a-f]+\s+/, ""), body };
    })
    .filter((record) => record.sha.length > 0 && record.header.length > 0);
  return { ok: true, value: parsed };
}

/**
 * The commit that git PROVES turned `premise` from satisfied to violated, or `null` when no commit in
 * the scan bound carries that proof. Answered `ok: false` never produces a verdict on its own: the
 * caller treats an unanswered probe as "nothing provable" and keeps the conservative `stale` route.
 */
export async function falsifyingCommitForPremise(identity: CardGitIdentity, premise: PlanPremise): Promise<Probe<PremiseFalsifier | null>> {
  const transitions = await premisePresenceTransitions(identity, premise);
  if (!transitions.ok) return transitions;
  const cardTaskId = identity.taskId.toUpperCase();
  for (const record of transitions.value.slice(0, FALSIFIER_PROOF_LIMIT)) {
    const atCandidate = await evaluatePremiseAtCommit({ ...identity, commit: record.sha }, premise);
    // An unreadable tree proves nothing; and a transition that leaves the premise TRUE is not the one
    // that produced the violated state the card is being refused for, so it is skipped, not concluded.
    if (!atCandidate.ok) return { ok: true, value: null };
    if (atCandidate.value.satisfied) continue;
    // `^{commit}` would PEEL the object, not step to the parent: the parent is `^1`, and a merge commit's
    // first parent is the tree the merge was applied to.
    const parent = await gitLine(identity.repo, ["rev-parse", "--verify", `${record.sha}^1`]);
    if (!parent.ok) return { ok: true, value: null };
    if (parent.value.length > 0) {
      const beforeFlip = await evaluatePremiseAtCommit({ ...identity, commit: parent.value }, premise);
      if (!beforeFlip.ok) return { ok: true, value: null };
      // Already false at the parent: this commit did not falsify it, so keep walking into the past.
      if (!beforeFlip.value.satisfied) continue;
    }
    // Reached only when this commit's tree is violated and its parent's tree was satisfied (or there is
    // no parent, so this tree is the first state the fact ever had). That is the flip, not a guess.
    return {
      ok: true,
      value: {
        commit: record.header,
        cardOwned: cardTaskId.length > 0 && extractAttributedTaskId(record.subject, record.body) === cardTaskId,
      },
    };
  }
  return { ok: true, value: null };
}



/** Commit that last changed `path` anywhere in the evaluated history — what an ordinary stale verdict
 *  names when the card's own delivery is not responsible. `null` is git's answered "no commit in this
 *  history touches this path"; `ok: false` is a probe that never answered and must be reported as such
 *  rather than as a history that does not contain the path. */
export async function lastCommitTouching(identity: CardGitIdentity, path: string): Promise<Probe<string | null>> {
  const commit = await gitLine(identity.repo, ["log", "-1", "--format=%h %s", identity.commit, "--", path]);
  if (!commit.ok) return commit;
  return { ok: true, value: commit.value.length > 0 ? commit.value : null };
}
