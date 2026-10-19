/**
 * RUFU-334 agent working-directory policy.
 *
 * An agent session inherits its working directory for real: the model's shell tool starts there, so a
 * session rooted inside a production deployment checkout writes to that deployment. Before this policy,
 * any lane that omitted an explicit working directory silently inherited the server process directory
 * instead, which is exactly how a usage probe launched the real `claude` REPL at the serve root with
 * `--add-dir` on that same tree. That leak is FNXC-marked at its origin in
 * `packages/dashboard/src/usage.ts`.
 *
 * The policy is deliberately keyed on an explicit operator declaration rather than a built-in
 * auto-detection, because a filesystem heuristic cannot tell a running deployment apart from an
 * ordinary checkout: a deployment directory carries no marker that distinguishes it from a working
 * copy. Detection-based defences built on `.git`, `package.json`, lockfiles or a CI config were
 * rejected outright — every one of them fires on the agent worktrees and on the serve root, and a
 * rule that fires on the machine's own project root would break every legitimate lane while leaving
 * a differently-laid-out deployment unprotected. A git worktree link in particular is the opposite of
 * proof: on this host the production deployment *is* a linked worktree of the very repository the
 * agent fleet edits, so worktree-ness describes the layout, not the risk. The variable therefore
 * starts empty, which keeps the default deployment's behaviour byte-identical.
 *
 * Boundary of the policy: it governs the working directory of agent-capable sessions only. It does
 * not constrain interactive terminals the operator opens deliberately, the dev server, the installer,
 * git plumbing, or verification commands that run inside an acquired checkout.
 *
 * The rule set is fixed by this card's contract:
 *  1. An empty, blank, or `.` working directory, and a path that cannot be resolved, are `TypeError`s.
 *     No caller may capture a path that does not exist, so the function can only return a real
 *     resolved path or raise.
 *  2. Unset variable → no refusal. The resolved path is still returned, so the "explicit root" half of
 *     the fix holds with the switch off; only the protected-checkout refusal depends on the variable.
 *  3. An entry that does not exist never matches and never throws.
 *  4. Resolution is `realpath`, so a symlink pointing into a deployment is caught rather than waved
 *     through on its literal spelling. An unresolvable candidate fails closed at rule 1.
 *  5. A declaration reached through a symlink still covers a session whose real path lands inside it —
 *     that is what realpath comparison buys, and both directions are tested.
 *  6. Refusal is the only remedy. A silent redirect would relocate execution to a directory no caller
 *     asked for and still leave whatever was already written in the deployment in place.
 */

/*
FNXC:AgentWorkingDirectoryPolicy 2026-10-18-07:40:
RUFU-334 fixed this module's public contract in review: the earlier delivery of the same card exported
`PROTECTED_CHECKOUTS_ENV` / `ProtectedCheckoutAgentCwdError` / `assertAgentCwdOutsideProtectedCheckouts`,
returned the caller's own string rather than the resolved path, had no `TypeError` leg (a non-existent
candidate silently fell back to its lexical form and was returned), and let a declared-but-absent entry
match literally. It also carried two rules this contract does not contain, both removed here:

1. An attribution ALLOW-list that passed a protected cwd whenever `FUSION_TASK_ID` or `FUSION_AGENT_ID`
   was present in the environment. Neither name is set anywhere in Fusion — task attribution travels as
   the `Fusion-Task-Id` git commit trailer, and the incident processes carried neither variable — so the
   rule was keyed purely on caller-supplied environment and was a self-service bypass of an operator
   declaration, the exact class of hole this card exists to close. Attribution is what a session that got
   *in* would carry, never a reason to let it in.
2. An `ancestor` relation that refused a working directory *containing* a protected root. The operator
   declaration means "never run an agent inside this checkout"; refusing its parent would refuse an
   operator's own project root whenever a deployment is nested under it and break chat, planning and
   executor lanes. A parent worth protecting is declared as its own entry.

FNXC:AgentWorkingDirectoryPolicy 2026-10-18-07:40:
Rules 3 and 5 look like opposites — an absent entry must never match, yet a declaration absent from
disk must still refuse a session whose real path reaches it through a symlink. They are reconciled by
comparing the candidate's realpath against BOTH forms of every entry: the realpath of the entry when it
resolves, and the lexical declaration always. A truly absent entry can then only match if the candidate's
own realpath equals or sits inside it, which means the declared path exists — so rule 3 holds as
observed behaviour while rule 5 keeps its symlink guarantee.
*/

import { realpathSync } from "node:fs";
import { delimiter, resolve, sep } from "node:path";

/**
 * Operator-declared list of checkout directories that may never host an agent session.
 *
 * The value is a delimited list of absolute paths — `:` on POSIX, `path.delimiter` (`;`) on Windows,
 * and newlines accepted as well because operators paste them from shell scripts and YAML blocks. Each
 * entry is trimmed, a leading `~` is expanded against the supplied environment, and blank entries are
 * dropped. Unset or blank means the refusal is off.
 */
export const FUSION_PROTECTED_CHECKOUTS_ENV = "FUSION_PROTECTED_CHECKOUTS";

/**
 * Raised when a proposed agent working directory collides with a protected checkout.
 *
 * The message names all three facts an operator needs to act on the refusal — the offending
 * directory, the protected entry it collides with, and the variable to change — because every
 * production repro of this defect was discovered only by inspecting a live process tree, and a
 * refusal that has to be decoded is a refusal that gets worked around.
 */
export class ProtectedCheckoutError extends Error {
  /** The working directory that was refused, exactly as the caller passed it. */
  readonly candidate: string;
  /** The declared protected checkout the candidate collided with. */
  readonly protectedRoot: string;
  /** The environment variable that declares the protected list. */
  readonly envVar: typeof FUSION_PROTECTED_CHECKOUTS_ENV;
  /** Which lane asked, when the caller identified itself. */
  readonly lane?: string;

  constructor(params: { candidate: string; protectedRoot: string; lane?: string }) {
    const lane = params.lane?.trim() || undefined;
    const subject = lane ? `${lane} agent working directory` : "agent working directory";
    super(
      `Refusing to run with ${subject} "${params.candidate}": it is the protected checkout ` +
        `"${params.protectedRoot}" or lives inside it. ${FUSION_PROTECTED_CHECKOUTS_ENV} declares ` +
        `directories that must never host an agent session; pass an explicit working directory ` +
        `outside them. This policy never redirects the path.`,
    );
    this.name = "ProtectedCheckoutError";
    this.candidate = params.candidate;
    this.protectedRoot = params.protectedRoot;
    this.envVar = FUSION_PROTECTED_CHECKOUTS_ENV;
    this.lane = lane;
  }
}

/**
 * Decide whether a directory may host an agent session.
 *
 * Returns the **resolved realpath** of `cwd` so callers can reuse the work instead of resolving the
 * same path a second time. On rejection it only ever throws:
 * - `TypeError` — the candidate is not a usable directory (not a string, empty, blank, `.`, or a path
 *   whose realpath fails). Naming the path is mandatory: a caller that passed `undefined` through an
 *   options bag needs to see which value was missing.
 * - {@link ProtectedCheckoutError} — the resolved directory is the protected checkout or lives inside it.
 *
 * @param cwd candidate working directory for the agent session
 * @param opts.env environment to read the declaration and `~` from; defaults to `process.env` so tests
 *   can inject a fixture declaration without mutating the process environment
 * @param opts.lane optional lane label used in the refusal message for diagnosis
 */
export function assertAgentCwdAllowed(
  cwd: string,
  opts?: { env?: NodeJS.ProcessEnv; lane?: string },
): string {
  const env = opts?.env ?? process.env;
  const lane = opts?.lane?.trim() || undefined;
  const candidate = requireUsableCandidate(cwd, lane);
  const resolved = resolveRealpathOrThrow(candidate, lane);

  for (const declared of parseProtectedCheckouts(env)) {
    if (protectedCheckoutCovers(declared, resolved)) {
      throw new ProtectedCheckoutError({ candidate: cwd, protectedRoot: declared, lane });
    }
  }

  return resolved;
}

/**
 * Rule 1a: reject a candidate that was never a usable directory in the first place.
 *
 * `.` and `./` are rejected rather than resolved because they are precisely the silent inheritance this
 * card removes: a caller that writes `.` is asking for whatever directory the process happens to be in,
 * which is the bug and not a value to resolve away.
 */
function requireUsableCandidate(cwd: string, lane?: string): string {
  const subject = lane ? `${lane} agent working directory` : "agent working directory";
  if (typeof cwd !== "string") {
    throw new TypeError(
      `Refusing to run with a ${subject} that is not a string (${String(cwd)}); pass an explicit directory.`,
    );
  }
  const trimmed = cwd.trim();
  if (trimmed === "") {
    throw new TypeError(`Refusing to run with an empty ${subject}; pass an explicit directory.`);
  }
  if (trimmed === "." || trimmed === "./" || trimmed === ".\\") {
    throw new TypeError(
      `Refusing to run with the ${subject} "${cwd}", which inherits whatever directory the process ` +
        `happened to start in; pass an explicit directory.`,
    );
  }
  return trimmed;
}

/**
 * Rule 1b + rule 4: the candidate must resolve on disk, and `realpath` is the only accepted resolution.
 *
 * A lexical `resolve()` is not sufficient — a symlink that points at a deployment reads as an unrelated
 * path lexically. Failing closed here also satisfies the promise that the function never returns a path
 * that does not exist.
 */
function resolveRealpathOrThrow(candidate: string, lane?: string): string {
  const subject = lane ? `${lane} agent working directory` : "agent working directory";
  try {
    return realpathSync(candidate);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TypeError(
      `Refusing to run with ${subject} "${candidate}": the path cannot be resolved (${reason}).`,
    );
  }
}

/**
 * Parse the operator declaration into normalized absolute entries, preserving order.
 *
 * A relative entry is anchored with `resolve()`, and `~` expands only against the supplied environment's
 * `HOME` (or `USERPROFILE` on Windows) — never an implicit `os.homedir()` — so a test that injects `env`
 * cannot leak the real invoking user's home directory into the comparison. With no home available the
 * entry stays literal, where it will simply fail to match.
 */
function parseProtectedCheckouts(env: NodeJS.ProcessEnv): string[] {
  const raw = env[FUSION_PROTECTED_CHECKOUTS_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return [];

  const home = (env.HOME ?? env.USERPROFILE ?? "").trim();
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const part of raw.split(new RegExp(`[${escapeForCharacterClass(delimiter)}\\n\\r]`))) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const expanded = expandHome(trimmed, home);
    const absolute = resolve(expanded);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    entries.push(absolute);
  }
  return entries;
}

/** Expand a leading `~` or `~/` against the environment-provided home directory. */
function expandHome(entry: string, home: string): string {
  if (home === "") return entry;
  if (entry === "~") return home;
  if (entry.startsWith("~/") || entry.startsWith("~\\")) return resolve(home, entry.slice(2));
  return entry;
}

/**
 * Test one declaration against the already-resolved candidate.
 *
 * Both comparison forms are checked: the entry's realpath when it resolves, so a declaration spelled
 * through a symlink still covers the real tree behind it (rule 5), and the lexical declaration always,
 * so no resolution accident can hide an exact hit. The relation is equality-or-inside only; an
 * entry that resolves to nothing matches nothing, because a candidate that genuinely sat inside it
 * could not itself exist to be resolved.
 */
function protectedCheckoutCovers(declared: string, resolvedCwd: string): boolean {
  if (sameOrInside(declared, resolvedCwd)) return true;
  const declaredReal = tryRealpath(declared);
  return declaredReal !== undefined && sameOrInside(declaredReal, resolvedCwd);
}

/** `candidate` is the directory `root` names, or lives anywhere below it. */
function sameOrInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}

/** `realpath` that reports failure as `undefined`; rule 3 forbids throwing on an unreadable entry. */
function tryRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** `path.delimiter` is `:` on POSIX and `;` on Windows; only `:` needs escaping in a character class. */
function escapeForCharacterClass(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
