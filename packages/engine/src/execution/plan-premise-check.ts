import { parsePlanPremises, type PlanPremise, type Task, type TaskStore } from "@fusion/core";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { getPromptPath } from "./spec-staleness.js";

/*
FNXC:PlanPremises 2026-09-16-03:20:
Every verdict carries `promptFingerprint` (sha256 of the authoritative prompt the verdict was
computed from) so the RUFU-246 refusal-episode signature can bind a refusal to the exact plan
revision: once replanning rewrites PROMPT.md, the fingerprint changes and the escalation count
resets. An unreadable prompt fingerprints as the empty string.
*/
export type PlanPremiseCheckResult =
  | { outcome: "satisfied"; promptFingerprint: string; premiseViolations: [] }
  | { outcome: "stale"; detail: string; promptFingerprint: string; premiseViolations: PlanPremiseViolation[] }
  | { outcome: "invalid-contract"; detail: string; promptFingerprint: string; premiseViolations: [] }
  | { outcome: "unavailable"; detail: string; promptFingerprint: string; premiseViolations: [] };

/*
FNXC:PlanPremises 2026-09-16-02:49:
RUFU-246 lifts the violated premises out of the prose detail into a structured payload so the
rejection episode can hash exactly the fields that describe WHY the card was refused. Each entry
carries the violated premise JSON and a fixed human-readable reason naming what was found; the
premise's own `path` is its location. A verdict no longer stops reporting at the first violation:
the whole violated set is enumerated so a planner sees every fact that drifted, and the detail
closes with the root directory the facts were evaluated against.
*/
export interface PlanPremiseViolation {
  premise: PlanPremise;
  reason: string;
}

/*
FNXC:PlanPremises 2026-09-16-02:49:
RUFU-246 requires a stale verdict's detail to enumerate the ENTIRE violated set AND the root it was
evaluated against, so the bound must survive a few full premise JSONs plus a worker-scoped tmp
root; 320 truncated the root clause in tests. Still one line, still capped.
*/
const MAX_DETAIL = 640;
const bounded = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL);

async function authoritativePrompt(store: TaskStore, task: Task): Promise<string> {
  if (typeof store.getTasksDir === "function") {
    return readFile(getPromptPath(store.getTasksDir(), task.id), "utf8");
  }
  if (typeof task.prompt === "string") return task.prompt;
  throw new Error("authoritative PROMPT.md is unavailable");
}

async function nearestExistingRealPath(path: string): Promise<string> {
  let cursor = path;
  for (;;) {
    try {
      return await realpath(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}

async function resolveContained(root: string, premise: PlanPremise): Promise<{ candidate: string; exists: boolean }> {
  const rootReal = await realpath(root);
  const candidate = resolve(rootReal, premise.path);
  const anchor = await nearestExistingRealPath(candidate);
  const rel = relative(rootReal, anchor);
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(rootReal, rel) !== anchor) {
    throw Object.assign(new Error(`premise path resolves outside project root: ${premise.path}`), { code: "OUTSIDE_ROOT" });
  }
  try {
    await access(candidate, constants.F_OK);
    const actual = await realpath(candidate);
    const actualRel = relative(rootReal, actual);
    if (actualRel === ".." || actualRel.startsWith(`..${sep}`)) {
      throw Object.assign(new Error(`premise path resolves outside project root: ${premise.path}`), { code: "OUTSIDE_ROOT" });
    }
    return { candidate: actual, exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { candidate, exists: false };
    throw error;
  }
}

function describe(premise: PlanPremise): string {
  return "literal" in premise
    ? `${premise.kind} ${premise.path} literal ${JSON.stringify(premise.literal).slice(0, 160)}`
    : `${premise.kind} ${premise.path}`;
}

/*
FNXC:PlanPremises 2026-09-13-04:01:
Release evaluates plan facts directly against the current main checkout returned by TaskStore.getRootDir(). The check is stateless and fail-closed; it neither creates a worktree nor persists a validation episode, and symlink resolution may never escape the project root.
*/
export async function checkPlanPremises(store: TaskStore, task: Task): Promise<PlanPremiseCheckResult> {
  let prompt: string;
  try {
    prompt = await authoritativePrompt(store, task);
  } catch (error) {
    return { outcome: "unavailable", detail: bounded(`Cannot read authoritative plan: ${error instanceof Error ? error.message : String(error)}`), promptFingerprint: "", premiseViolations: [] };
  }
  const promptFingerprint = createHash("sha256").update(prompt).digest("hex");
  const parsed = parsePlanPremises(prompt);
  /*
  FNXC:PlanPremises 2026-09-16-04:08:
  RUFU-246 — the release gate verifies the facts a plan STATES; a plan that states none has nothing
  to falsify, so a missing or empty `## Plan Premises` section releases as vacuously satisfied (the
  behavior every pre-gate spec and its tests encode). Only a section with content that cannot be
  trusted — invalid line, invalid JSON, disallowed premise — is a contract refusal. The parser keeps
  refusing absent/empty sections; this pass-through lives in the checker, which is the surface that
  decides release, so parser strictness and release behavior cannot drift into each other.
  */
  if (!parsed.ok && parsed.reason !== "missing-section" && parsed.reason !== "empty-section") {
    return { outcome: "invalid-contract", detail: bounded(parsed.detail), promptFingerprint, premiseViolations: [] };
  }

  const premises = parsed.ok ? parsed.premises : [];
  /*
  FNXC:PlanPremises 2026-09-16-05:35:
  RUFU-246 — the release root is resolved ONLY when the plan actually states a premise, and a store
  whose getRootDir is missing or throwing yields the fail-closed `unavailable` verdict rather than
  escaping checkPlanPremises as a TypeError. Without this, a Fast-mode card with a premise-free plan
  (FN-8304: fast cards are legitimately planless) crashed the whole release door once the fast-lane
  premise bypass was removed — "premise evaluation" must never throw at the caller, and a plan
  stating no facts needs no filesystem to prove them.
  */
  let root: string;
  if (premises.length > 0) {
    try {
      root = store.getRootDir();
    } catch (error) {
      return { outcome: "unavailable", detail: bounded(`Cannot resolve the release root: ${error instanceof Error ? error.message : String(error)}`), promptFingerprint, premiseViolations: [] };
    }
  } else {
    return { outcome: "satisfied", promptFingerprint, premiseViolations: [] };
  }
  const violations: PlanPremiseViolation[] = [];
  for (const premise of premises) {
    try {
      const resolved = await resolveContained(root, premise);
      let satisfied: boolean;
      let reason: string | null = null;
      if (!resolved.exists) {
        satisfied = premise.kind === "file-absent" || premise.kind === "text-absent";
        if (!satisfied) reason = "path does not exist";
      } else {
        const info = await stat(resolved.candidate);
        /*
        FNXC:PlanPremises 2026-09-13-05:28:
        File and text premises describe regular files, not merely occupied paths. Replacing a source
        file with a directory invalidates file-exists and both text checks; text-absent must not pass
        vacuously when no file content was readable.
        */
        if (!info.isFile()) {
          satisfied = false;
          reason = "path exists but is not a regular file";
        } else if (premise.kind === "file-exists") satisfied = true;
        else if (premise.kind === "file-absent") {
          satisfied = false;
          reason = "path exists";
        } else {
          const content = await readFile(resolved.candidate, "utf8");
          const present = content.includes((premise as Extract<PlanPremise, { literal: string }>).literal);
          satisfied = premise.kind === "text-present" ? present : !present;
          if (!satisfied) reason = premise.kind === "text-present" ? "literal not found in file" : "literal found in file";
        }
      }
      if (!satisfied && reason) violations.push({ premise, reason });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "OUTSIDE_ROOT") {
        return { outcome: "invalid-contract", detail: bounded(error instanceof Error ? error.message : String(error)), promptFingerprint, premiseViolations: [] };
      }
      return { outcome: "unavailable", detail: bounded(`Cannot verify ${describe(premise)}: ${error instanceof Error ? error.message : String(error)}`), promptFingerprint, premiseViolations: [] };
    }
  }
  if (violations.length > 0) {
    const enumerated = violations.map((violation) => `${JSON.stringify(violation.premise)} (${violation.reason})`).join("; ");
    return {
      outcome: "stale",
      detail: bounded(`Plan premise${violations.length === 1 ? "" : "s"} no longer true${violations.length === 1 ? ":" : " —"} ${enumerated}. Evaluated against ${root}`),
      promptFingerprint,
      premiseViolations: violations,
    };
  }
  return { outcome: "satisfied", promptFingerprint, premiseViolations: [] };
}
